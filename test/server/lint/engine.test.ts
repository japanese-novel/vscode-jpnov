/**
 * End-to-end driver tests: the native engine runs over real documents, and every hit is checked
 * for (a) the right diagnostic code and (b) a source range that slices back to the offending text.
 * Exercises line rules, the raw rule, per-rule views, and fix mapping together.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { computeLintFindings } from '../../../src/server/lint/engine.ts';
import { RULES, settingKey } from '../../../src/shared/lint/catalog.ts';
import { selectRules } from '../../../src/shared/lint/select.ts';
import type { RawLintConfigWire } from '../../../src/shared/protocol.ts';
import { applyLintFixes } from '../helpers.ts';

interface Hit {
  readonly code: string;
  readonly text: string;
  readonly fix?: { readonly text: string; readonly newText: string };
}

/** Run the engine and project each finding to { code, flagged source text, optional fix }. */
function lintAll(src: string, raw: RawLintConfigWire): Hit[] {
  const doc = TextDocument.create('mem://x.jpnov', 'jpnov', 1, src);
  const findings = computeLintFindings(src, selectRules(raw), doc);
  const slice = (r: { start: { line: number; character: number }; end: { line: number; character: number } }): string =>
    src.slice(doc.offsetAt(r.start), doc.offsetAt(r.end));
  return findings.map((f) => ({
    code: (f.diagnostic.data as { code: string }).code,
    text: slice(f.diagnostic.range),
    ...(f.fix ? { fix: { text: slice(f.fix.range), newText: f.fix.newText } } : {}),
  }));
}

/** Just the { code, text } of each finding (fix-agnostic tests). */
function lint(src: string, raw: RawLintConfigWire): { code: string; text: string }[] {
  return lintAll(src, raw).map(({ code, text }) => ({ code, text }));
}

/** The source after every fix is applied — the real "does the fix corrupt the text?" check (no
 *  deleted chars, no eaten newlines). */
function applied(src: string, raw: RawLintConfigWire): string {
  return applyLintFixes(src, raw).out;
}

/** The ダッシュ rule on its shipped default (HORIZONTAL BAR ―). */
const DASH_BAR: RawLintConfigWire = { 'jpnov.lint.common.dash': 'horizontalBar' };

test('no rules enabled -> empty result', () => {
  const doc = TextDocument.create('mem://x.jpnov', 'jpnov', 1, '　半 角 が あ る。');
  assert.deepEqual(computeLintFindings(doc.getText(), selectRules({}), doc), []);
});

// --- common rules see 地の文 AND 台詞 through the prose view ---

test('a common rule sees content INSIDE 「」', () => {
  assert.deepEqual(lint('「彼は—と」', DASH_BAR), [{ code: 'lint.common.dash', text: '—' }]);
});

test('a rule message reaches Diagnostic.data whole, args included', () => {
  // renderEnglish substitutes a missing arg with '', so a dropped arg would surface only here
  const doc = TextDocument.create('mem://x.jpnov', 'jpnov', 1, '彼は——と');
  const findings = computeLintFindings(doc.getText(), selectRules(DASH_BAR), doc);
  assert.deepEqual(
    findings.map((f) => f.diagnostic.data as unknown),
    [{ code: 'lint.common.dash', args: ['―'] }],
  );
  assert.equal(findings[0]?.diagnostic.message, 'use the configured dash character (―)');
  assert.equal(findings[0].diagnostic.code, 'lint.common.dash'); // mirrored onto Diagnostic.code
});

test('a common rule fires in narration AND dialogue under one code', () => {
  const hits = lint('—と「—」', DASH_BAR);
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.code === 'lint.common.dash' && h.text === '—'));
});

test('common maxTen flags the (max+1)-th 読点 of a sentence', () => {
  assert.deepEqual(lint('あ、い、う、え、お。', { 'jpnov.lint.common.maxTen': 3 }), [
    { code: 'lint.common.maxTen', text: '、' },
  ]);
});

test('common maxTen also counts within a dialogue utterance', () => {
  assert.deepEqual(lint('「あ、い、う、え、お」', { 'jpnov.lint.common.maxTen': 3 }), [
    { code: 'lint.common.maxTen', text: '、' },
  ]);
});

test('common sentenceLength fires on an over-long sentence', () => {
  assert.deepEqual(lint('あいうえおかきくけこ。', { 'jpnov.lint.common.sentenceLength': 5 }), [
    { code: 'lint.common.sentenceLength', text: 'あいうえおかきくけこ。' },
  ]);
});

test('maxKanjiRun counts ACROSS elided markup — the run reads as one in print', () => {
  const hits = lint('聴覚視覚［＃太字］区分装置［＃太字終わり］', { 'jpnov.lint.common.maxKanjiRun': 6 });
  assert.deepEqual(hits, [
    { code: 'lint.common.maxKanjiRun', text: '聴覚視覚［＃太字］区分装置' },
  ]);
  assert.deepEqual(lint('聴覚視覚区分', { 'jpnov.lint.common.maxKanjiRun': 6 }), []);
});

test('common noHankakuKana carries a fix mapping the source kana to full-width', () => {
  assert.deepEqual(lintAll('はｱだ', { 'jpnov.lint.common.noHankakuKana': true }), [
    { code: 'lint.common.noHankakuKana', text: 'ｱ', fix: { text: 'ｱ', newText: 'ア' } },
  ]);
  assert.equal(applied('はｶﾞだ', { 'jpnov.lint.common.noHankakuKana': true }), 'はガだ');
});

test('common jaNoSpaceBetweenFullWidth fixes the space to a full-width space (not deletion)', () => {
  assert.deepEqual(lintAll('あ いう', { 'jpnov.lint.common.jaNoSpaceBetweenFullWidth': true }), [
    { code: 'lint.common.jaNoSpaceBetweenFullWidth', text: ' ', fix: { text: ' ', newText: '　' } },
  ]);
  assert.equal(applied('あ いう', { 'jpnov.lint.common.jaNoSpaceBetweenFullWidth': true }), 'あ　いう');
});

// --- fix correctness: inserts must not delete chars; line-end fixes must keep the newline ---

test('indent fix INSERTS the 字下げ (does not overwrite the first character)', () => {
  assert.equal(applied('、句点。', { 'jpnov.lint.narration.indent': true }), '　、句点。');
  assert.equal(applied('普通の段落。', { 'jpnov.lint.narration.indent': true }), '　普通の段落。');
});

test('dash fix pairs an odd run and rewrites a foreign glyph in place', () => {
  assert.equal(applied('彼は—と', DASH_BAR), '彼は――と');
  assert.equal(applied('彼は——と', DASH_BAR), '彼は――と'); // same length, chosen glyph
  assert.equal(applied('彼は―――と', DASH_BAR), '彼は――――と'); // odd rounds up
  assert.equal(applied('彼は――と', { 'jpnov.lint.common.dash': 'boxDrawing' }), '彼は──と');
  assert.equal(applied('彼は―と', { 'jpnov.lint.common.dash': 'off' }), '彼は―と'); // retired spelling still reads as disabled
});

test('dash parity stays the dash rule; ellipsis parity is the ellipsis rule', () => {
  const both = { ...DASH_BAR, 'jpnov.lint.common.ellipsis': true };
  assert.deepEqual(lint('　彼は―――と言った。', both), [
    { code: 'lint.common.dash.parity', text: '―――' },
  ]);
  assert.deepEqual(lint('　彼は…と言った。', both), [
    { code: 'lint.common.ellipsis.parity', text: '…' },
  ]);
});

test('only the dash rule is scanned per piece — the rest keep their neighbours', () => {
  // A scanner that reads the character next to its hit misjudges the one at a piece edge, so
  // only a rule whose notion of a run must match the renderer's opts in.
  const MINUS = { 'jpnov.lint.common.minusPosition': true };
  const SPACE = { 'jpnov.lint.common.jaNoSpaceBetweenFullWidth': true };
  assert.deepEqual(lint('気温は−［＃縦中横］１０［＃縦中横終わり］度。', MINUS), []);
  assert.deepEqual(lint('あ ｜漢《かん》い', SPACE), [
    { code: 'lint.common.jaNoSpaceBetweenFullWidth', text: ' ' },
  ]);
  // …and the markup between two hits still costs only the FIX, never the warning
  assert.equal(applied('あ ［＃「z」に傍点］ い', SPACE), 'あ ［＃「z」に傍点］ い');
  assert.equal(lint('あ ［＃「z」に傍点］ い', SPACE).length, 1);
});

test('a dash run split by markup is two runs — matching how it renders', () => {
  // A fix may not reach across the markup, so the run ends at the gap and each piece pairs alone.
  assert.equal(applied('あ―［＃改丁］―い', DASH_BAR), 'あ――［＃改丁］――い');
  assert.deepEqual(lint('あ―［＃改丁］―い', DASH_BAR), [
    { code: 'lint.common.dash.parity', text: '―' },
    { code: 'lint.common.dash.parity', text: '―' },
  ]);
});

test('common minusPosition flags a stray minus but not a signed number', () => {
  assert.deepEqual(lint('－あ', { 'jpnov.lint.common.minusPosition': true }), [
    { code: 'lint.common.minusPosition', text: '－' },
  ]);
  assert.deepEqual(lint('－5', { 'jpnov.lint.common.minusPosition': true }), []);
});

test('minusPosition leaves a Western hyphen between ASCII alphanumerics alone', () => {
  const MINUS = { 'jpnov.lint.common.minusPosition': true };
  assert.deepEqual(lint('Wi-Fiが切れた。', MINUS), []);
  assert.deepEqual(lint('J-POPを流す。', MINUS), []);
  assert.deepEqual(lint('ラ-メン', MINUS), [{ code: 'lint.common.minusPosition', text: '-' }]);
});

// --- the format rules (the exploded general-novel-style bundle) ---

const INDENT: RawLintConfigWire = { 'jpnov.lint.narration.indent': true };

test('indent flags a paragraph not starting with 字下げ / an opening bracket', () => {
  assert.deepEqual(lint('、いきなり始まる。', INDENT), [{ code: 'lint.narration.indent', text: '、' }]);
  assert.deepEqual(lint('　字下げ済み。', INDENT), []);
  assert.deepEqual(lint('「台詞行だ」', INDENT), []); // opening bracket counts
});

test('a line opened by ［＃N字下げ］ (N ≥ 1) is not flagged as un-indented', () => {
  assert.deepEqual(lint('［＃２字下げ］引用の行だ。\n', INDENT), []);
});

test('［＃０字下げ］ renders un-indented, so the flag (and its insert fix) stays', () => {
  assert.equal(applied('［＃０字下げ］内容だ。\n', INDENT), '［＃０字下げ］　内容だ。\n');
});

test('every line inside a ここから…ここで block is covered; lines after the end are not', () => {
  const src = '［＃ここから２字下げ］\n引用一だ。\n引用二だ。\n［＃ここで字下げ終わり］\n戻りの行だ。\n';
  assert.deepEqual(lint(src, INDENT), [{ code: 'lint.narration.indent', text: '戻' }]);
});

test('a 見出し line hangs free of indent and endPeriod', () => {
  const raw = { ...INDENT, 'jpnov.lint.narration.endPeriod': true };
  assert.deepEqual(lint('序章　空へ［＃「序章　空へ」は大見出し］', raw), []);
  assert.deepEqual(lint('［＃ここから大見出し］\n題名の行\n［＃ここで大見出し終わり］', raw), []);
});

test('a continuation line of a multi-line utterance is not a paragraph head', () => {
  assert.deepEqual(lint('「あの\nね」と言った。', INDENT), []);
});

const PERIOD: RawLintConfigWire = { 'jpnov.lint.narration.endPeriod': true };

test('endPeriod fix appends 。 at the end WITHOUT eating the trailing newline', () => {
  assert.equal(applied('好き', PERIOD), '好き。');
  assert.equal(applied('好き\nおわり。', PERIOD), '好き。\nおわり。');
});

test('endPeriod allows 「」-final lines, ！？ endings, and blank lines', () => {
  for (const src of ['「そうだ」', '（そうか）', '好き！', 'なぜ?', '文。\n\n文。']) {
    assert.deepEqual(lint(src, PERIOD), [], src);
  }
});

test('endPeriod flags … and dashes — 和文 keeps its 。 after a trailing run', () => {
  for (const src of ['好き…', '好き……', '好き—', '好き―', '好き─']) {
    const hits = lint(src, PERIOD);
    assert.deepEqual(hits.map((h) => h.code), ['lint.narration.endPeriod'], src);
  }
  assert.equal(applied('彼は黙った……', PERIOD), '彼は黙った……。');
  assert.equal(applied('彼は――', PERIOD), '彼は――。');
});

test('an ornament line (a hand-written scene break) skips indent and endPeriod', () => {
  const both = { ...PERIOD, ...INDENT };
  for (const src of ['＊', '　＊　＊　＊', '◇', '※※※']) {
    assert.deepEqual(lint(src, both), [], src);
  }
  // …but a prose line among ornaments is still checked
  assert.deepEqual(lint('＊\n終わり', both).map((h) => h.code).sort(), [
    'lint.narration.endPeriod',
    'lint.narration.indent',
  ]);
});

test('a pause line (…… / ―― alone) is prose: it earns its 字下げ and its 。', () => {
  const both = { ...PERIOD, ...INDENT };
  for (const src of ['……', '――']) {
    assert.deepEqual(lint(src, both).map((h) => h.code).sort(), [
      'lint.narration.endPeriod',
      'lint.narration.indent',
    ], src);
  }
  assert.equal(applied('……', both), '　……。'); // the strict form of a silence paragraph
  assert.equal(applied('　……', PERIOD), '　……。');
});

test('a status/inset line ending on 】 or 〉 is closed — no 。 demanded after the bracket', () => {
  for (const src of ['　称号【竜殺し】', '【スキル：剣術】', '〈風の剣〉']) {
    assert.deepEqual(lint(src, PERIOD), [], src);
  }
});

test('a ・ bullet line is inset material: neither 字下げ nor 。 is demanded', () => {
  const both = { ...PERIOD, ...INDENT };
  assert.deepEqual(lint('・ポーション×３', both), []);
  assert.deepEqual(lint('　・回復薬', both), []);
});

test('endPeriod skips a line that ends inside a multi-line utterance', () => {
  assert.deepEqual(lint('「あの\nね」', PERIOD), []);
});

test('endPeriod flags a trailing-annotation line at its last prose character; the 。 follows the annotation', () => {
  assert.deepEqual(lintAll('好き［＃「好き」に傍点］', PERIOD), [
    { code: 'lint.narration.endPeriod', text: 'き', fix: { text: '', newText: '。' } },
  ]);
  assert.equal(applied('好き［＃「好き」に傍点］', PERIOD), '好き［＃「好き」に傍点］。');
});

const CLOSING: RawLintConfigWire = { 'jpnov.lint.dialogue.closingPunct': true };

test('closingPunct flags 。/、 right before the closing bracket and deletes it', () => {
  assert.deepEqual(lintAll('「そうだ。」', CLOSING), [
    { code: 'lint.dialogue.closingPunct', text: '。', fix: { text: '。', newText: '' } },
  ]);
  assert.equal(applied('「そうだ。」と言った。', CLOSING), '「そうだ」と言った。');
  assert.equal(applied('「まさか、」', CLOSING), '「まさか」');
});

test('closingPunct leaves ！？ and mid-utterance punctuation alone', () => {
  assert.deepEqual(lint('「なに！？」', CLOSING), []);
  assert.deepEqual(lint('「そうだ。まだある」', CLOSING), []);
  assert.deepEqual(lint('地の文。「台詞」', CLOSING), []); // narration 。 is not inside an utterance
});

test('closingPunct flags a nested 『』 close too', () => {
  assert.deepEqual(lint('「『題名。』を読んだ」', CLOSING), [
    { code: 'lint.dialogue.closingPunct', text: '。' },
  ]);
});

const EXCL_SPACE: RawLintConfigWire = { 'jpnov.lint.common.exclamationSpace': true };

test('exclamationSpace requires a full-width space when prose continues', () => {
  assert.deepEqual(lintAll('　驚いた！そのまま。', EXCL_SPACE), [
    { code: 'lint.common.exclamationSpace', text: '！', fix: { text: '', newText: '　' } },
  ]);
  assert.equal(applied('　驚いた！そのまま。', EXCL_SPACE), '　驚いた！　そのまま。');
});

test('exclamationSpace allows line end, a closer, 　, and reports once per run', () => {
  for (const src of ['　驚いた！', '「なんだ！？」', '　え！　と続く。', '「まさか？」と']) {
    assert.deepEqual(lint(src, EXCL_SPACE), [], src);
  }
  assert.deepEqual(lint('　え！！続く。', EXCL_SPACE), [
    { code: 'lint.common.exclamationSpace', text: '！' }, // the run's last mark only
  ]);
});

test('exclamationSpace treats the half-width !? pair as the sentence-ender form', () => {
  assert.deepEqual(lint('　え!?続く。', EXCL_SPACE), [
    { code: 'lint.common.exclamationSpace', text: '?' },
  ]);
  assert.deepEqual(lint('　km/h だ。', EXCL_SPACE), []); // a lone half-width mark is not
});

test('exclamationSpace lets a trailing …/dash run follow ！ solid, as set in practice', () => {
  for (const src of ['　助けて！……誰か。', '　行け！――と、そのとき。']) {
    assert.deepEqual(lint(src, EXCL_SPACE), [], src);
  }
});

const EXCL_RUN: RawLintConfigWire = { 'jpnov.lint.common.exclamationRun': true };

test('exclamationRun: a full-width double becomes the half-width pair (縦中横 via autoTcy)', () => {
  assert.deepEqual(lintAll('「なに！？」', EXCL_RUN), [
    { code: 'lint.common.exclamationRun', text: '！？', fix: { text: '！？', newText: '!?' } },
  ]);
  assert.equal(applied('「なに！！」', EXCL_RUN), '「なに!!」');
  assert.deepEqual(lint('「なに!?」', EXCL_RUN), []); // already the pair form
  assert.deepEqual(lint('「なに！」', EXCL_RUN), []); // a single mark is fine
});

test('exclamationRun: three or more marks are their own finding, with no fix', () => {
  assert.deepEqual(lintAll('「うそ！！！」', EXCL_RUN), [
    { code: 'lint.common.exclamationRun.long', text: '！！！' },
  ]);
});

test('exclamationRun: a lone half-width mark lies on its side — the fix widens it', () => {
  assert.deepEqual(lintAll('　もうだめだ!', EXCL_RUN), [
    { code: 'lint.common.exclamationRun.single', text: '!', fix: { text: '!', newText: '！' } },
  ]);
  assert.equal(applied('　なぜ?と思う。', EXCL_RUN), '　なぜ？と思う。');
  assert.deepEqual(lint('　もうだめだ！', EXCL_RUN), []); // full-width single is the right form
});

const ELLIPSIS: RawLintConfigWire = { 'jpnov.lint.common.ellipsis': true };

test('ellipsis: an odd … run gains one; surrogates become ……', () => {
  assert.equal(applied('　沈黙…だ。', ELLIPSIS), '　沈黙……だ。');
  assert.deepEqual(lint('　沈黙……だ。', ELLIPSIS), []);
  assert.deepEqual(lintAll('　沈黙。。。だ。', ELLIPSIS), [
    { code: 'lint.common.ellipsis', text: '。。。', fix: { text: '。。。', newText: '……' } },
  ]);
  assert.equal(applied('　えっ、、', ELLIPSIS), '　えっ……');
  assert.equal(applied('　中黒・・・だ。', ELLIPSIS), '　中黒……だ。');
  assert.deepEqual(lint('　中黒・並び。', ELLIPSIS), []); // a single 中黒 is prose
  assert.equal(applied('　二点‥だ。', ELLIPSIS), '　二点‥‥だ。'); // ‥ pairs like …
  assert.deepEqual(lint('　二点‥‥だ。', ELLIPSIS), []);
});

// --- fix placement (#72): an insert lands outside the markup wrapping its anchor ---

test('endPeriod appends 。 after a ruby reading, a closing annotation, and a postfix', () => {
  assert.equal(applied('　彼は山田《やまだ》', PERIOD), '　彼は山田《やまだ》。');
  assert.equal(applied('　彼は｜山田《やまだ》', PERIOD), '　彼は｜山田《やまだ》。');
  assert.equal(applied('　今年は［＃縦中横］12［＃縦中横終わり］', PERIOD), '　今年は［＃縦中横］12［＃縦中横終わり］。');
  assert.equal(applied('　彼は山田［＃「山田」に傍点］', PERIOD), '　彼は山田［＃「山田」に傍点］。');
  assert.equal(
    applied('［＃丸傍点］青空文庫で読書しよう［＃丸傍点終わり］', PERIOD),
    '［＃丸傍点］青空文庫で読書しよう［＃丸傍点終わり］。',
  );
  // a value field renders as text, so the 。 follows the rendered value
  assert.equal(
    applied('　本文［＃ここに「タイトル」の値を表示］', PERIOD),
    '　本文［＃ここに「タイトル」の値を表示］。',
  );
  assert.equal(applied('　彼は山田《やまだ》\r\n次。', PERIOD), '　彼は山田《やまだ》。\r\n次。');
});

test('endPeriod only adds: a trailing 、 stays and gains the 。', () => {
  assert.deepEqual(lintAll('　彼は言った、', PERIOD), [
    { code: 'lint.narration.endPeriod', text: '、', fix: { text: '', newText: '。' } },
  ]);
  assert.equal(applied('　彼は言った、', PERIOD), '　彼は言った、。');
});

test('indent inserts the 字下げ before a ｜ or an opening annotation, never inside', () => {
  assert.equal(applied('｜大人《おとな》は笑った。', INDENT), '　｜大人《おとな》は笑った。');
  assert.equal(applied('大人《おとな》は笑った。', INDENT), '　大人《おとな》は笑った。');
  assert.equal(applied('［＃縦中横］12［＃縦中横終わり］年が過ぎた。', INDENT), '　［＃縦中横］12［＃縦中横終わり］年が過ぎた。');
  assert.equal(applied('［＃傍点］本文だ。［＃傍点終わり］', INDENT), '　［＃傍点］本文だ。［＃傍点終わり］');
  assert.equal(applied('［＃傍点］青空文庫［＃傍点終わり］で読書しよう。', INDENT), '　［＃傍点］青空文庫［＃傍点終わり］で読書しよう。');
  // a postfix between the opener and its prose does not end the span; a value field is not an opener
  assert.equal(
    applied('［＃太字］［＃「z」に傍点］本文だ。［＃太字終わり］', INDENT),
    '　［＃太字］［＃「z」に傍点］本文だ。［＃太字終わり］',
  );
  assert.equal(
    applied('［＃ここに「タイトル」の値を表示］本文だ。', INDENT),
    '［＃ここに「タイトル」の値を表示］　本文だ。',
  );
  // a dangling span end of another channel does not end the pending opener either
  assert.equal(applied('［＃傍点］［＃太字終わり］本文だ。', INDENT), '　［＃傍点］［＃太字終わり］本文だ。');
});

test('exclamationSpace inserts the 　 after the closing annotation of its mark, before an opener', () => {
  assert.equal(
    applied('「［＃傍点］すごい！［＃傍点終わり］そして」', EXCL_SPACE),
    '「［＃傍点］すごい！［＃傍点終わり］　そして」',
  );
  assert.equal(
    applied('　すごい！［＃「すごい！」に傍点］そして。', EXCL_SPACE),
    '　すごい！［＃「すごい！」に傍点］　そして。',
  );
  assert.equal(
    applied('　すごい！［＃ここから太字］そして。［＃ここで太字終わり］', EXCL_SPACE),
    '　すごい！　［＃ここから太字］そして。［＃ここで太字終わり］',
  );
  // overlapping channels: the 　 leaves the 傍点 span and stays inside the 太字 one
  assert.equal(
    applied('［＃傍点］すごい！［＃太字］［＃傍点終わり］そして［＃太字終わり］', EXCL_SPACE),
    '［＃傍点］すごい！［＃太字］［＃傍点終わり］　そして［＃太字終わり］',
  );
});

test('exclamationSpace warns on a half-width space after the mark but offers no fix', () => {
  assert.deepEqual(lintAll('「すごい！ そして」', EXCL_SPACE), [
    { code: 'lint.common.exclamationSpace', text: '！' }, // no fix: a 　 next to it would double the gap
  ]);
  assert.equal(applied('「すごい！ そして」', EXCL_SPACE), '「すごい！ そして」');
  assert.deepEqual(lint('「すごい！　そして」', EXCL_SPACE), []);
});

test('ellipsis parity doubles the last leader in place, so it stays inside its span', () => {
  assert.deepEqual(lintAll('　沈黙…だ。', ELLIPSIS), [
    { code: 'lint.common.ellipsis.parity', text: '…', fix: { text: '…', newText: '……' } },
  ]);
  assert.equal(applied('［＃傍点］あ…［＃傍点終わり］だ。', ELLIPSIS), '［＃傍点］あ……［＃傍点終わり］だ。');
  assert.equal(applied('　沈黙……［＃太字］…［＃太字終わり］だ。', ELLIPSIS), '　沈黙……［＃太字］……［＃太字終わり］だ。');
});

test('two fixes on one line end never share an offset: ellipsis replaces, endPeriod inserts after it', () => {
  const both = { ...ELLIPSIS, ...PERIOD };
  assert.equal(lintAll('　沈黙…', both).filter((h) => h.fix?.text === '').length, 1);
  assert.equal(applied('　沈黙…', both), '　沈黙……。');
  assert.equal(applied('　驚いた！山田《やまだ》', { ...EXCL_SPACE, ...PERIOD }), '　驚いた！　山田《やまだ》。');
});

test('a fix never deletes a whole ruby base; a span may be emptied', () => {
  assert.deepEqual(lintAll('「そうだ｜。《まる》」', CLOSING), [
    { code: 'lint.dialogue.closingPunct', text: '。' }, // the warning stays, the fix is dropped
  ]);
  assert.equal(applied('「そうだ｜だ。《まる》」', CLOSING), '「そうだ｜だ《まる》」'); // shrinking is fine
  assert.equal(applied('「そうだ［＃傍点］。［＃傍点終わり］」', CLOSING), '「そうだ［＃傍点］［＃傍点終わり］」');
  const ZW = { 'jpnov.lint.common.noZeroWidth': true };
  assert.equal(applied('　あ［＃傍点］\u200b［＃傍点終わり］い。', ZW), '　あ［＃傍点］［＃傍点終わり］い。');
  assert.equal(applied('「。［＃「z」に傍点］」', CLOSING), '「［＃「z」に傍点］」');
});

test('two fixes at one offset apply like LSP: the insert survives the neighbouring delete/replace', () => {
  const both = { ...PERIOD, 'jpnov.lint.common.noTrailingSpace': true };
  assert.equal(applied('　彼は山田《やまだ》　', both), '　彼は山田《やまだ》。');
  const excl = { ...EXCL_SPACE, 'jpnov.lint.common.noHankakuKana': true };
  assert.equal(applied('　すごい！ｶﾞだ。', excl), '　すごい！　ガだ。');
});

const DIGITS: RawLintConfigWire = { 'jpnov.lint.common.arabicDigits': 2 };

test('arabicDigits flags a digit run over the limit (either width), without a fix', () => {
  assert.deepEqual(lintAll('　１２３年だ。', DIGITS), [
    { code: 'lint.common.arabicDigits', text: '１２３' },
  ]);
  assert.deepEqual(lint('　12年だ。', DIGITS), []);
  assert.deepEqual(lint('［＃１２字下げ］３４五。', { ...DIGITS, 'jpnov.lint.common.arabicDigits': 1 }), [
    { code: 'lint.common.arabicDigits', text: '３４' }, // the annotation's digits are NOT prose
  ]);
});

/** `blankRun` at N: more than N blank lines in a row are flagged. */
function blanks(max: number): RawLintConfigWire {
  return { 'jpnov.lint.common.blankRun': max };
}

test('blankRun reports a run over the limit as one finding and erases the extra lines', () => {
  // Span = fix = the first `count − max` blank lines with their terminators (line 1 start to
  // line 3 start); the kept lines are untouched.
  assert.deepEqual(lintAll('あ。\n\n\n\nい。', blanks(1)), [
    { code: 'lint.common.blankRun', text: '\n\n', fix: { text: '\n\n', newText: '' } },
  ]);
  assert.equal(applied('あ。\n\n\n\nい。', blanks(1)), 'あ。\n\nい。');
  assert.equal(applied('あ。\n\n\n\nい。', blanks(2)), 'あ。\n\n\nい。');
  assert.deepEqual(lint('あ。\n\n\n\nい。', blanks(3)), []);
  assert.deepEqual(lint('あ。\n\nい。', blanks(1)), []); // one blank line is the paragraph gap
  assert.equal(applied('あ。\r\n\r\n\r\nい。', blanks(1)), 'あ。\r\n\r\nい。'); // a CRLF goes whole
  assert.deepEqual(lint('あ。\n\n［＃改ページ］\n\nい。', blanks(1)), []); // a directive line breaks the run
});

test('blankRun at 0 forbids blank lines: a run of any length is erased whole', () => {
  assert.deepEqual(lintAll('あ。\n\nい。', blanks(0)), [
    { code: 'lint.common.blankRun', text: '\n', fix: { text: '\n', newText: '' } },
  ]);
  assert.equal(applied('あ。\n\n\n\nい。', blanks(0)), 'あ。\nい。');
  assert.equal(applied('\n\nあ。', blanks(0)), 'あ。');
});

test('blankRun: the empty line after the final line break is the file end, not a blank line', () => {
  // The line after the final line break is never counted or erased, at 0 included.
  assert.deepEqual(lint('あ。\n', blanks(0)), []);
  assert.deepEqual(lint('', blanks(0)), []);
  assert.equal(applied('あ。\n\n', blanks(0)), 'あ。\n');
  assert.deepEqual(lint('あ。\n\n', blanks(1)), []);
  assert.equal(applied('あ。\n\n\n', blanks(1)), 'あ。\n\n');
  assert.equal(applied('\n\n', blanks(0)), '');
});

test('blankRun: one fix round leaves exactly the allowed run, at every length and limit', () => {
  for (let max = 0; max <= 3; max += 1) {
    for (let count = 0; count <= 6; count += 1) {
      const src = `あ。\n${'\n'.repeat(count)}い。\n`;
      const fixed = applied(src, blanks(max));
      const label = `${String(count)} blank lines at ${String(max)}`;
      assert.equal(fixed, `あ。\n${'\n'.repeat(Math.min(count, max))}い。\n`, label);
      assert.deepEqual(lint(fixed, blanks(max)), [], label);
    }
  }
});

test('blankRun counts token-less lines only — a space-only line is noTrailingSpace\'s finding', () => {
  // The two rules stay orthogonal, so their fixes never overlap inside one fix-all.
  const both = { ...blanks(1), 'jpnov.lint.common.noTrailingSpace': true };
  assert.deepEqual(lint('あ。\n\n　\n\nい。', both), [
    { code: 'lint.common.noTrailingSpace', text: '　' },
  ]);
});

const TRAILING: RawLintConfigWire = { 'jpnov.lint.common.noTrailingSpace': true };

test('noTrailingSpace flags the spaces before a line break and deletes exactly those', () => {
  assert.deepEqual(lintAll('好き　', TRAILING), [
    { code: 'lint.common.noTrailingSpace', text: '　', fix: { text: '　', newText: '' } },
  ]);
  assert.equal(applied('好き 　\t\nおわり。 \n', TRAILING), '好き\nおわり。\n');
  assert.deepEqual(lint('好き　だ。', TRAILING), []); // an inner space is prose
});

test('noTrailingSpace: a line of nothing but spaces is the whole-line case', () => {
  assert.deepEqual(lintAll('　　', TRAILING), [
    { code: 'lint.common.noTrailingSpace', text: '　　', fix: { text: '　　', newText: '' } },
  ]);
  assert.equal(applied('あ。\n　　\nい。', TRAILING), 'あ。\n\nい。');
  assert.deepEqual(lint('「あの\n　\nね」', TRAILING), [
    { code: 'lint.common.noTrailingSpace', text: '　' },
  ]);
});

test('noTrailingSpace leaves blank lines, prose, and lines ending in markup alone', () => {
  // The line end is literal: an annotation there ends the line, so the space before it is not
  // trailing.
  const clean = [
    'あ。\n\nい。',
    '　地の文。',
    '「台詞」',
    '［＃３字下げ］',
    '　［＃３字下げ］',
    '好き　［＃「好き」に傍点］',
    '漢字《かんじ》',
  ];
  for (const src of clean) {
    assert.deepEqual(lint(src, TRAILING), [], JSON.stringify(src));
  }
});

test('noTrailingSpace: spaces after a bare ［＃字下げ］ are flagged; the fix leaves the annotation', () => {
  assert.deepEqual(lintAll('［＃３字下げ］　', TRAILING), [
    { code: 'lint.common.noTrailingSpace', text: '　', fix: { text: '　', newText: '' } },
  ]);
  assert.equal(applied('［＃３字下げ］　\n', TRAILING), '［＃３字下げ］\n');
});

test('noTrailingSpace: only the spaces after the last markup are trailing', () => {
  assert.equal(applied('　［＃「z」に傍点］　', TRAILING), '　［＃「z」に傍点］');
});

const NO_INDENT: RawLintConfigWire = { 'jpnov.lint.dialogue.noIndent': true };

test('noIndent flags leading whitespace before a 「 and deletes it', () => {
  assert.deepEqual(lintAll('　「台詞だ」', NO_INDENT), [
    { code: 'lint.dialogue.noIndent', text: '　', fix: { text: '　', newText: '' } },
  ]);
  assert.deepEqual(lint('　地の文だ。', NO_INDENT), []);
  assert.deepEqual(lint('「台詞だ」', NO_INDENT), []);
});

// --- noUnmatchedPair: the deterministic document-level stack ---

const PAIRS: RawLintConfigWire = { 'jpnov.lint.common.noUnmatchedPair': true };

test('noUnmatchedPair reports an unclosed opener at the opener, at EOF', () => {
  assert.deepEqual(lint('「あ', PAIRS), [{ code: 'lint.common.noUnmatchedPair', text: '「' }]);
  assert.deepEqual(lint('（メモ', PAIRS), [{ code: 'lint.common.noUnmatchedPair', text: '（' }]);
});

test('noUnmatchedPair reports a dangling closer at the closer', () => {
  assert.deepEqual(lint('あ」', PAIRS), [{ code: 'lint.common.noUnmatchedPair', text: '」' }]);
});

test('noUnmatchedPair: a closer skipping an inner opener reports the skipped opener', () => {
  assert.deepEqual(lint('「『あ」', PAIRS), [{ code: 'lint.common.noUnmatchedPair', text: '『' }]);
});

test('noUnmatchedPair spans lines (a multi-line utterance is balanced)', () => {
  assert.deepEqual(lint('「あの\nね」', PAIRS), []);
});

test('noUnmatchedPair flags a lone prose 《 — a broken ruby, in practice', () => {
  assert.deepEqual(lint('あ《き', PAIRS), [{ code: 'lint.common.noUnmatchedPair', text: '《' }]);
  assert.deepEqual(lint('漢字《かんじ》', PAIRS), []); // a real ruby never reaches prose
});

// --- ranges over lines with 字下げ annotations map without drift ---

test('ranges and fixes on an annotated line map back without positional drift', () => {
  assert.deepEqual(
    lint('［＃３字下げ］あいうえおかきくけこ。\n', { 'jpnov.lint.common.sentenceLength': 5 }),
    [{ code: 'lint.common.sentenceLength', text: 'あいうえおかきくけこ。' }],
  );
  assert.deepEqual(lint('［＃３字下げ］あ、い、う、え、お。\n', { 'jpnov.lint.common.maxTen': 2 }), [
    { code: 'lint.common.maxTen', text: '、' },
  ]);
  assert.deepEqual(lintAll('［＃３字下げ］はｱだ。\n', { 'jpnov.lint.common.noHankakuKana': true }), [
    { code: 'lint.common.noHankakuKana', text: 'ｱ', fix: { text: 'ｱ', newText: 'ア' } },
  ]);
});

// --- ruby drop-down ---

test('ruby kana=hiragana flags a reading that is not all hiragana', () => {
  assert.deepEqual(lint('太郎《たロう》と一郎《いちろう》', { 'jpnov.lint.ruby.kana': 'hiragana' }), [
    { code: 'lint.ruby.kana', text: 'たロう' },
  ]);
});

test('ruby kana=katakana flags a hiragana reading', () => {
  assert.deepEqual(lint('名《メイ》前《まえ》', { 'jpnov.lint.ruby.kana': 'katakana' }), [
    { code: 'lint.ruby.kana', text: 'まえ' },
  ]);
});

test('ruby kana=off leaves all readings alone', () => {
  assert.deepEqual(lint('名《メイ》前《まえ》', { 'jpnov.lint.ruby.kana': 'off' }), []);
});

// --- shiftJisSafe: the one `raw` rule (reads the source, not the views) ---

/** The rule on its shipped default. */
const SJIS: RawLintConfigWire = { 'jpnov.lint.common.shiftJisSafe': true };

test('shiftJisSafe flags a character Shift JIS lacks, once, over its whole code point', () => {
  assert.deepEqual(lint('吉野家と𠮷野家', SJIS), [
    { code: 'lint.common.shiftJisSafe', text: '𠮷' },
  ]);
});

test('shiftJisSafe leaves encodable prose alone, aliases included', () => {
  // — 〜 − 髙 ① all reach Shift JIS through the table's alias overlay or the CP932 blocks.
  assert.deepEqual(lint('――〜−髙①ｱ。', SJIS), []);
});

test('shiftJisSafe sees inside annotations, which the views drop', () => {
  // A 左ルビ reading lives ONLY in its annotation: no view carries it, yet the .txt does.
  assert.deepEqual(lint('峠《とうげ》［＃「峠」の左に「😀」のルビ］', SJIS), [
    { code: 'lint.common.shiftJisSafe', text: '😀' },
  ]);
});

test('shiftJisSafe runs once per document — one finding per occurrence', () => {
  assert.deepEqual(lint('地の文😀\n「セリフ😀」', SJIS), [
    { code: 'lint.common.shiftJisSafe', text: '😀' },
    { code: 'lint.common.shiftJisSafe', text: '😀' },
  ]);
});

test('shiftJisSafe offers no fix — the substitutes would be semantic', () => {
  const hits = lintAll('𠮷', SJIS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.fix, undefined);
});

test('shiftJisSafe off reports nothing', () => {
  assert.deepEqual(lint('𠮷😀', { 'jpnov.lint.common.shiftJisSafe': false }), []);
});

test('shiftJisSafe stays quiet where an always-on hygiene rule already reports', () => {
  // All three ship ON, and what they flag has no Shift JIS cell of its own, so without the
  // engine's range de-dup every default-configuration user would see two warnings on one character.
  const shipped: RawLintConfigWire = {
    ...SJIS,
    'jpnov.lint.common.noZeroWidth': true,
    'jpnov.lint.common.noNfd': true,
    'jpnov.lint.common.noControlChar': true,
  };
  assert.deepEqual(lint('あ\u200bい', shipped), [
    { code: 'lint.common.noZeroWidth', text: '\u200b' },
  ]);
  // う + U+3099 composes to ゔ, which Shift JIS lacks, so the raw scan still reports the mark here.
  assert.deepEqual(lint('う\u3099', shipped), [
    { code: 'lint.common.noNfd', text: '\u3099' },
  ]);
  assert.deepEqual(lint('あ\u0085い', shipped), [
    { code: 'lint.common.noControlChar', text: '\u0085' },
  ]);
});

test('noNfd fixes by composing the base+mark pair', () => {
  assert.equal(applied('か\u3099き', { 'jpnov.lint.common.noNfd': true }), 'がき');
});

test('shiftJisSafe stays quiet on a decomposed kana the .txt composes', () => {
  // か + U+3099 is written as が (issue #83), so with noNfd off there is nothing to report; a
  // composite Shift JIS lacks (ゔ) still is. Inside a ruby reading likewise; noNfd owns that report.
  assert.deepEqual(lint('か\u3099', SJIS), []);
  assert.deepEqual(lint('う\u3099', SJIS), [
    { code: 'lint.common.shiftJisSafe', text: '\u3099' },
  ]);
  assert.deepEqual(lint('山田《やまた\u3099》', SJIS), []);
});

test('noNfd scans the raw line: readings, annotation targets and keywords included', () => {
  const NFD: RawLintConfigWire = { 'jpnov.lint.common.noNfd': true };
  // The views elide a reading and every annotation interior, so the rule reads the raw line; the
  // fix names the mark's offset and the engine composes it with the unit before — safe anywhere.
  assert.deepEqual(lint('山田《やまた\u3099》', NFD), [{ code: 'lint.common.noNfd', text: '\u3099' }]);
  assert.equal(applied('山田《やまた\u3099》', NFD), '山田《やまだ》');
  assert.equal(applied('「山田《やまた\u3099》」', NFD), '「山田《やまだ》」');
  assert.equal(
    applied('｜カ\u3099ラス戸《か\u3099らすと\u3099》か\u3099開いた。', NFD),
    '｜ガラス戸《がらすど》が開いた。',
  );
  // Prose and the postfix target quoting it compose together, so the annotation still binds.
  assert.equal(
    applied('　た\u3099めた\u3099［＃「た\u3099めた\u3099」に傍点］、と言った。', NFD),
    '　だめだ［＃「だめだ」に傍点］、と言った。',
  );
  assert.equal(
    applied('聖剣《せいけん》［＃「聖剣」の左に「つるき\u3099」のルビ］', NFD),
    '聖剣《せいけん》［＃「聖剣」の左に「つるぎ」のルビ］',
  );
  // An annotation whose KEYWORD is decomposed is unrecognized; composing it brings it back.
  assert.equal(applied('［＃５字下け\u3099］あ', NFD), '［＃５字下げ］あ');
  // A mark nothing composes with, or with nothing before it, is reported without a fix.
  for (const src of ['山田《あ\u3099》', '山田《\u3099か》', '\u3099か', 'か［＃「か」に傍点］\u3099']) {
    const hits = lintAll(src, NFD);
    assert.equal(hits.length, 1, src);
    assert.equal(hits[0]?.fix, undefined, src);
  }
  // Shipped defaults: the raw shiftJisSafe finding on ゔ's mark de-duplicates against this one.
  assert.deepEqual(lint('山田《う\u3099》', { ...SJIS, ...NFD }), [
    { code: 'lint.common.noNfd', text: '\u3099' },
  ]);
  // With ruby.kana on, a decomposed reading is still noNfd's alone: rubyKana judges it composed.
  assert.deepEqual(lint('山田《やまた\u3099》', { ...NFD, 'jpnov.lint.ruby.kana': 'hiragana' }), [
    { code: 'lint.common.noNfd', text: '\u3099' },
  ]);
});

test('shiftJisSafe still reports a variation selector — no sibling rule owns 異体字 loss', () => {
  // U+E0100 is a mark, but it composes with nothing, so noNfd never sees it.
  assert.deepEqual(lint('辻\u{E0100}', SJIS), [
    { code: 'lint.common.shiftJisSafe', text: '\u{E0100}' },
  ]);

  // One diagnostic per WRITTEN character: ❤️ is two code points but one thing the author typed.
  assert.deepEqual(lint('「好き❤️」', SJIS), [
    { code: 'lint.common.shiftJisSafe', text: '❤' },
  ]);
});

test('the de-dup holds when markup separates in SOURCE what is adjacent in prose', () => {
  // noNfd reports the mark (nothing composes with the ］ before it, so no fix) and shiftJisSafe
  // lands on the same range. Deciding this in the engine (not in a scanner) is what makes it work.
  const shipped: RawLintConfigWire = { ...SJIS, 'jpnov.lint.common.noNfd': true };
  assert.deepEqual(lint('か［＃「か」に傍点］\u3099', shipped), [
    { code: 'lint.common.noNfd', text: '\u3099' },
  ]);
  // A character no sibling claims keeps its own finding alongside the sibling's.
  assert.deepEqual(lint('\u{20BB7}\u3099', shipped), [
    { code: 'lint.common.shiftJisSafe', text: '\u{20BB7}' },
    { code: 'lint.common.noNfd', text: '\u3099' },
  ]);
});

test('shiftJisSafe reports invisible characters no sibling rule covers', () => {
  // The hygiene rules match narrow literal sets, so these reach the .txt as 〓 unless this rule
  // speaks up. Reported by code point, since the character itself shows nothing.
  for (const ch of ['\u00ad', '\u200c', '\u200d', '\u200e', '\u2060', '\ufeff', '\u2066']) {
    assert.deepEqual(lint(`あ${ch}い`, SJIS), [
      { code: 'lint.common.shiftJisSafe', text: ch },
    ], `U+${ch.codePointAt(0)?.toString(16) ?? ''}`);
  }
});

// --- fixture smoke: real corpora under EVERY rule at once ---

test('fixtures produce well-formed findings under the full rule set', () => {
  const everything: Record<string, boolean | number | string> = {};
  for (const rule of RULES) {
    everything[settingKey(rule)] =
      rule.kind === 'boolean'
        ? true
        : rule.kind === 'threshold'
          ? rule.suggested
          : (rule.values.find((v) => v !== 'off') ?? 'off');
  }
  for (const name of ['seams.jpnov', 'showcase.jpnov']) {
    const url = new URL(`../../../test-fixtures/novel/${name}`, import.meta.url);
    const src = readFileSync(fileURLToPath(url), 'utf8');
    const doc = TextDocument.create('mem://x.jpnov', 'jpnov', 1, src);
    const findings = computeLintFindings(src, selectRules(everything), doc);
    assert.ok(findings.length > 0, `${name}: the corpus should trip something`);
    for (const f of findings) {
      const a = doc.offsetAt(f.diagnostic.range.start);
      const b = doc.offsetAt(f.diagnostic.range.end);
      assert.ok(a >= 0 && a <= b && b <= src.length, `${name}: range out of bounds`);
      if (f.fix !== undefined) {
        const fa = doc.offsetAt(f.fix.range.start);
        const fb = doc.offsetAt(f.fix.range.end);
        assert.ok(fa >= 0 && fa <= fb && fb <= src.length, `${name}: fix out of bounds`);
      }
    }
  }
});
