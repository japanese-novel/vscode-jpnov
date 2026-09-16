/**
 * Walker tests: the per-line model (pieces, views, flags) and every semantic inherited from the
 * retired stream extractor — the Aozora trap, astral per-unit offsets, the 字下げ/見出し state
 * machines (twin-lockstep against layout.ts `buildRows`), zero-prose broken markup.
 * Pure + import-light, so they run on Node's native test loader.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { walkLines } from '../../../src/server/lint/walker.ts';
import type { LintLine, ProseView } from '../../../src/server/lint/types.ts';
import { buildRows } from '../../../src/shared/compiler/layout.ts';
import { tokenize } from '../../../src/shared/compiler/tokenizer.ts';

function lines(src: string): LintLine[] {
  return [...walkLines(src)];
}

/** The source text a view span `[a, b)` covers (start unit to last-included unit, inclusive). */
function covered(src: string, view: ProseView, a: number, b: number): string {
  const start = view.units[a]?.src ?? 0;
  const end = (view.units[b - 1]?.src ?? 0) + 1;
  return src.slice(start, end);
}

test('plain narration: one line, one piece, prose is identity', () => {
  const [l] = lines('あいうえお。');
  assert.ok(l);
  assert.equal(l.prose().text, 'あいうえお。');
  assert.deepEqual(l.pieces.map((p) => [p.text, p.srcStart, p.depth]), [['あいうえお。', 0, 0]]);
  assert.equal(l.narration().text, 'あいうえお。');
  assert.equal(l.dialogue().text, '');
  assert.equal(l.blank, false);
  assert.equal(l.openDepthAtEnd, 0);
});

test('dialogue interior collapses to 〇 in the narration view and fills the dialogue view', () => {
  const src = '「ヤッホー」と、太郎は言った。';
  const [l] = lines(src);
  assert.ok(l);
  assert.equal(l.narration().text, '「〇」と、太郎は言った。');
  assert.equal(l.dialogue().text, 'ヤッホー');
  assert.equal(l.prose().text, src); // the full view keeps everything in place
  assert.equal(covered(src, l.dialogue(), 0, 4), 'ヤッホー');
  const n = l.narration();
  const i = n.text.indexOf('太郎');
  assert.equal(covered(src, n, i, i + 2), '太郎');
  // the 〇 sentinel is synthetic: no piece, mapped at the interior's first unit
  const s = n.units[n.text.indexOf('〇')];
  assert.equal(s?.piece, null);
  assert.equal(s.src, src.indexOf('ヤ'));
});

test('depth: top-level corners are 地の文 (0), interiors ≥ 1, nested corners inside', () => {
  const [l] = lines('地「外『内』外」文');
  assert.ok(l);
  const v = l.prose();
  const depthAt = (ch: string): number => v.units[v.text.indexOf(ch)]?.depth ?? -1;
  assert.equal(depthAt('「'), 0);
  assert.equal(depthAt('」'), 0);
  assert.equal(depthAt('外'), 1);
  assert.equal(depthAt('『'), 1);
  assert.equal(depthAt('内'), 2);
  assert.equal(depthAt('』'), 1);
  assert.equal(depthAt('文'), 0);
});

test('ruby: the base flows into prose (merging with adjacent text), the reading into rubies', () => {
  const src = 'この太郎《たろう》は言った。';
  const [l] = lines(src);
  assert.ok(l);
  assert.equal(l.narration().text, 'この太郎は言った。');
  // この + 太郎 are source-contiguous at the same depth -> ONE piece; は… starts after 《たろう》
  assert.deepEqual(l.pieces.map((p) => p.text), ['この太郎', 'は言った。']);
  assert.deepEqual(l.rubies, [{ text: 'たろう', srcStart: src.indexOf('たろう') }]);
});

test('explicit ｜ ruby: base starts after the marker; the marker splits the piece', () => {
  const src = 'あ｜太郎《たろう》は';
  const [l] = lines(src);
  assert.ok(l);
  assert.deepEqual(l.pieces.map((p) => [p.text, p.srcStart]), [
    ['あ', 0],
    ['太郎', src.indexOf('太郎')],
    ['は', src.lastIndexOf('は')], // the prose は after 》 — not the one inside the reading
  ]);
  assert.deepEqual(l.rubies, [{ text: 'たろう', srcStart: src.indexOf('たろう') }]);
});

test('ruby inside dialogue: base -> dialogue view, reading -> rubies, narration 〇', () => {
  const [l] = lines('「漢字《かんじ》」');
  assert.ok(l);
  assert.equal(l.narration().text, '「〇」');
  assert.equal(l.dialogue().text, '漢字');
  assert.deepEqual(l.rubies.map((r) => r.text), ['かんじ']);
});

test('［＃「対象」に傍点］ is an annotation, not dialogue (the Aozora trap)', () => {
  const [l] = lines('本当に［＃「当」に傍点］走った。');
  assert.ok(l);
  assert.equal(l.dialogue().text, ''); // 「当」 inside ［＃…］ never enters the dialogue stack
  assert.equal(l.prose().text, '本当に走った。'); // ...and prose stays ADJACENT across the elision
  assert.deepEqual(l.pieces.map((p) => p.text), ['本当に', '走った。']); // two pieces, one view
});

test('an unclosed opener: the line ends inside the utterance', () => {
  const [l] = lines('「あ');
  assert.ok(l);
  assert.equal(l.narration().text, '「〇');
  assert.equal(l.dialogue().text, 'あ');
  assert.equal(l.openDepthAtEnd, 1);
});

test('a broken ［＃ contributes no prose (malformed markup is not linted)', () => {
  const [l0, l1] = lines('地の文［＃こわれ\n次の行');
  assert.equal(l0?.prose().text, '地の文');
  assert.equal(l1?.prose().text, '次の行');
});

test('a 「 swallowed by a broken ［＃ never enters the dialogue stack', () => {
  const ls = lines('［＃「未\nあと');
  assert.equal(ls[0]?.dialogue().text, '');
  assert.equal(ls[0].directiveOnly, true); // the broken annotation is a token with no prose
  assert.equal(ls[1]?.prose().text, 'あと');
  assert.equal(ls[1].openDepthAtEnd, 0);
});

test('consecutive utterances are separator-joined in the dialogue view', () => {
  const src = '「A」「BC」';
  const [l] = lines(src);
  assert.ok(l);
  const d = l.dialogue();
  assert.equal(d.text, 'A\nBC');
  assert.equal(d.units[1]?.piece, null); // the separator is synthetic
  assert.equal(covered(src, d, 2, 4), 'BC');
});

test('markup inside ONE utterance does not split it with a separator', () => {
  const [l] = lines('「あ［＃太字］い［＃太字終わり］」');
  assert.ok(l);
  assert.equal(l.dialogue().text, 'あい'); // two pieces, same utterance — no '\n'
});

test('empty dialogue emits no 〇', () => {
  const [l] = lines('「」だ');
  assert.ok(l);
  assert.equal(l.narration().text, '「」だ');
  assert.equal(l.dialogue().text, '');
});

test('astral chars occupy two units with consecutive offsets (positionAt-compatible)', () => {
  const src = '𠮷《よし》さん';
  const [l] = lines(src);
  assert.ok(l);
  const n = l.narration();
  assert.equal(n.text, '𠮷さん');
  assert.equal(covered(src, n, 0, 2), '𠮷'); // the two units cover exactly the astral char
  assert.equal(covered(src, n, 0, 3), '𠮷《よし》さ'); // spanning the elided ruby covers the gap
});

test('one LintLine per source line; a multi-line utterance stays split', () => {
  const ls = lines('「あ\nい」続き。');
  assert.equal(ls.length, 2);
  assert.equal(ls[0]?.narration().text, '「〇');
  assert.equal(ls[0].openDepthAtEnd, 1);
  assert.equal(ls[0].dialogue().text, 'あ');
  assert.equal(ls[1]?.narration().text, '」続き。'); // the 〇 was already emitted on line 0
  assert.equal(ls[1].dialogue().text, 'い');
  assert.equal(ls[1].openDepthAtEnd, 0);
});

test('line numbering and bounds: srcStart/srcEnd exclude the terminator; CRLF is one break', () => {
  const src = '一行。\r\n二行。\nさん';
  const ls = lines(src);
  assert.deepEqual(ls.map((l) => [l.srcLine, src.slice(l.srcStart, l.srcEnd)]), [
    [0, '一行。'],
    [1, '二行。'],
    [2, 'さん'],
  ]);
});

test('the final line is always yielded — trailing blanks are real lines', () => {
  const ls = lines('あ。\n\n');
  assert.equal(ls.length, 3);
  assert.equal(ls[1]?.blank, true);
  assert.equal(ls[2]?.blank, true);
});

test('blank vs directive-only: a token-less line is blank, a ここから/改ページ line is not', () => {
  const ls = lines('あ。\n\n［＃ここから２字下げ］\n［＃改ページ］\nい。');
  assert.deepEqual(ls.map((l) => [l.blank, l.directiveOnly]), [
    [false, false],
    [true, false],
    [false, true],
    [false, true],
    [false, false],
  ]);
});

// --- 字下げ state (lockstep semantics inherited from streams.ts/buildRows) ---

test('a line-head ［＃N字下げ］ sets line.indent for its own line only', () => {
  const ls = lines('［＃３字下げ］本文の行。\n次の行。');
  assert.equal(ls[0]?.indent, 3);
  assert.equal(ls[1]?.indent, 0);
});

test('［＃０字下げ］ is an explicit zero', () => {
  assert.equal(lines('［＃０字下げ］本文。')[0]?.indent, 0);
});

test('a ここから block covers FOLLOWING lines; the directive line keeps its head snapshot', () => {
  const ls = lines('［＃ここから２字下げ］同じ行。\n中の行。\n［＃ここで字下げ終わり］終端行。\n外の行。');
  assert.deepEqual(ls.map((l) => l.indent), [0, 2, 2, 0]);
});

test('an inline ［＃０字下げ］ cancels the block for its line; last-wins reopen switches depth', () => {
  const ls = lines('［＃ここから２字下げ］\nあ。\n［＃０字下げ］ゼロ行。\n［＃ここから４字下げ］\n四の行。');
  assert.deepEqual(ls.map((l) => l.indent), [0, 2, 0, 2, 4]);
});

// --- 見出し state ---

test('a heading postfix marks its own line', () => {
  const ls = lines('序章［＃「序章」は大見出し］\n本文。');
  assert.equal(ls[0]?.heading, 1);
  assert.equal(ls[1]?.heading, undefined);
});

test('an inline heading span marks its line and following lines until the end token', () => {
  const ls = lines('［＃中見出し］題\nまだ題\n［＃中見出し終わり］終端行\nあと');
  assert.deepEqual(ls.map((l) => l.heading), [2, 2, 2, undefined]); // the end line stays a heading
});

test('the block heading form marks FOLLOWING lines only', () => {
  const ls = lines('［＃ここから小見出し］\n題の行\n［＃ここで小見出し終わり］\nあと');
  assert.deepEqual(ls.map((l) => l.heading), [undefined, 3, 3, undefined]);
});

// --- twin lockstep: walker line state vs rendered rows ---

test('indent and heading stay in lockstep with buildRows per source line', () => {
  const src = [
    '＊冒頭は字下げなし。',
    '　字面の空白で始まる行。',
    '［＃３字下げ］行頭指定の行。',
    '［＃０字下げ］ゼロ指定の行。',
    '',
    '［＃ここから２字下げ］同じ行の本文。',
    'ブロック内の行。',
    '「ブロック内のセリフ。」',
    '［＃０字下げ］ブロック内のゼロ行。',
    '｜太郎《たろう》のルビ行。',
    '［＃ここから４字下げ］',
    '四字に切り替わった行。',
    '［＃ここで字下げ終わり］終端と同じ行。',
    '序章［＃「序章」は大見出し］',
    '［＃大見出し］開始行。',
    'まだ見出し。',
    '［＃大見出し終わり］終端行。',
    '見出しの外。',
    '最後の行。',
  ].join('\n');

  const rendered = new Map<number, { indent: number; heading: number | undefined }>();
  for (const row of buildRows(tokenize(src))) {
    if (row.kind === 'line' && !rendered.has(row.srcLine)) {
      rendered.set(row.srcLine, { indent: row.indent ?? 0, heading: row.heading });
    }
  }
  for (const line of walkLines(src)) {
    const row = rendered.get(line.srcLine);
    if (row === undefined) {
      continue; // a directive-only line paints no row — nothing to compare
    }
    assert.equal(line.indent, row.indent, `indent of line ${String(line.srcLine)}`);
    assert.equal(line.heading, row.heading, `heading of line ${String(line.srcLine)}`);
  }
});

// --- outer extents: where an insert before/after a piece lands (#72) ---

/** Each piece of line `n` as [its text, the source its outer extents cover]. */
function outer(src: string, n = 0): [string, string][] {
  const l = lines(src)[n];
  assert.ok(l);
  return l.pieces.map((p) => [p.text, src.slice(p.outerStart, p.outerEnd)]);
}

test('a ruby reading extends the base piece; an explicit ｜ pulls its start before the marker', () => {
  assert.deepEqual(outer('　彼は山田《やまだ》'), [['　彼は山田', '　彼は山田《やまだ》']]);
  assert.deepEqual(outer('｜大人《おとな》は笑った。'), [['大人', '｜大人《おとな》'], ['は笑った。', 'は笑った。']]);
  assert.deepEqual(outer('「山田《やまだ》」'), [['「', '「'], ['山田', '山田《やまだ》'], ['」', '」']]);
});

test('a span wraps the piece inside it; stacked and postfix closers all extend it', () => {
  assert.deepEqual(outer('［＃縦中横］12［＃縦中横終わり］年'), [['12', '［＃縦中横］12［＃縦中横終わり］'], ['年', '年']]);
  assert.deepEqual(outer('［＃傍点］青空文庫［＃傍点終わり］で読書しよう'), [
    ['青空文庫', '［＃傍点］青空文庫［＃傍点終わり］'],
    ['で読書しよう', 'で読書しよう'],
  ]);
  assert.deepEqual(outer('［＃丸傍点］青空文庫で読書しよう［＃丸傍点終わり］。'), [
    ['青空文庫で読書しよう', '［＃丸傍点］青空文庫で読書しよう［＃丸傍点終わり］'],
    ['。', '。'],
  ]);
  const stacked = '［＃縦中横］［＃傍点］12［＃傍点終わり］［＃縦中横終わり］';
  assert.deepEqual(outer(stacked), [['12', stacked]]);
  assert.deepEqual(outer('好き［＃「好き」に傍点］'), [['好き', '好き［＃「好き」に傍点］']]);
  assert.deepEqual(outer('!?［＃「!?」は縦中横］'), [['!?', '!?［＃「!?」は縦中横］']]);
  assert.deepEqual(outer('序章［＃「序章」は大見出し］'), [['序章', '序章［＃「序章」は大見出し］']]);
  const both = '｜山田《やまだ》［＃「山田」の左に「たろう」のルビ］';
  assert.deepEqual(outer(both), [['山田', both]]);
});

test('an opener seals the piece before it; an empty span in between is transparent', () => {
  assert.deepEqual(outer('　驚いた！｜山田《やまだ》'), [['　驚いた！', '　驚いた！'], ['山田', '｜山田《やまだ》']]);
  assert.deepEqual(outer('　すごい！［＃ここから太字］そして［＃ここで太字終わり］'), [
    ['　すごい！', '　すごい！'],
    ['そして', '［＃ここから太字］そして［＃ここで太字終わり］'],
  ]);
  const inner = '［＃傍点］12［＃太字］［＃太字終わり］［＃傍点終わり］';
  assert.deepEqual(outer(inner), [['12', inner]]);
  assert.deepEqual(outer('［＃傍点］［＃傍点終わり］山田'), [['山田', '山田']]);
  // a postfix is not a span end: it neither ends the pending opener nor reaches the sealed piece
  assert.deepEqual(outer('山田［＃太字］［＃「山田」に傍点］太郎'), [['山田', '山田'], ['太郎', '［＃太字］［＃「山田」に傍点］太郎']]);
});

test('spans pair per channel: another channel in between neither seals a piece nor ends an opener', () => {
  assert.deepEqual(outer('［＃傍点］すごい！［＃太字］［＃傍点終わり］そして［＃太字終わり］'), [
    ['すごい！', '［＃傍点］すごい！［＃太字］［＃傍点終わり］'],
    ['そして', '［＃太字］［＃傍点終わり］そして［＃太字終わり］'],
  ]);
  assert.deepEqual(outer('［＃傍点］［＃太字終わり］本文'), [['本文', '［＃傍点］［＃太字終わり］本文']]);
  assert.deepEqual(outer('［＃傍点］［＃丸傍点終わり］本文'), [['本文', '［＃傍点］［＃丸傍点終わり］本文']]); // a variant is its own channel
  assert.deepEqual(outer('［＃大見出し］［＃中見出し終わり］題'), [['題', '題']]); // the heading levels share one slot
  assert.deepEqual(outer('全［＃縦中横］［＃ここに「総ページ数」の値を表示］［＃縦中横終わり］頁'), [['全', '全'], ['頁', '頁']]);
});

test('neutral markup binds nothing: a line-head 字下げ stays at the head, a comment is transparent', () => {
  assert.deepEqual(outer('［＃０字下げ］本文'), [['本文', '本文']]);
  assert.deepEqual(outer('［＃０字下げ］［＃傍点］内容だ［＃傍点終わり］'), [['内容だ', '［＃傍点］内容だ［＃傍点終わり］']]);
  assert.deepEqual(outer('山田［＃メモ］［＃傍点終わり］'), [['山田', '山田［＃メモ］［＃傍点終わり］']]);
  assert.deepEqual(outer('［＃傍点終わり］山田'), [['山田', '山田']]);
  assert.deepEqual(outer('［＃縦中横］12'), [['12', '［＃縦中横］12']]); // unterminated: nothing to skip
});

test('a value field is rendered text: it extends the piece before it, like a postfix', () => {
  const field = '［＃ここに「タイトル」の値を表示］';
  assert.deepEqual(outer(`本文${field}次`), [['本文', `本文${field}`], ['次', '次']]);
  assert.deepEqual(outer(`［＃傍点］${field}本文［＃傍点終わり］`), [['本文', `［＃傍点］${field}本文［＃傍点終わり］`]]);
});

test('a depth change inside a span splits the extents across the corner pieces', () => {
  assert.deepEqual(outer('［＃傍点］「山田」［＃傍点終わり］'), [
    ['「', '［＃傍点］「'],
    ['山田', '山田'],
    ['」', '」［＃傍点終わり］'],
  ]);
});

test('extents are per line: an opener never reaches the next line; CRLF and astral chars are plain', () => {
  const src = '［＃傍点］\n山田［＃傍点終わり］';
  assert.deepEqual(outer(src, 0), []);
  assert.deepEqual(outer(src, 1), [['山田', '山田［＃傍点終わり］']]);
  const astral = '　彼は𠮷《よし》\r\n次';
  assert.deepEqual(outer(astral, 0), [['　彼は𠮷', '　彼は𠮷《よし》']]);
  assert.deepEqual(outer(astral, 1), [['次', '次']]);
});
