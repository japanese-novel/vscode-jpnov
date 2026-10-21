/**
 * Walker tests: the per-line model (units, pieces, carriers, views, flags) — the views are the
 * line as shown, the Aozora trap, astral and composed per-unit offsets, the 字下げ/見出し line
 * state (the AST's: what it is for each form is test/shared/ast/resolve.test.ts's subject), what
 * an annotation shows as read-only units, and the carrier extents an insert is placed by.
 * Pure + import-light, so they run on Node's native test loader.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { walkLines } from '../../../src/server/lint/walker.ts';
import type { Carrier, LintLine, ProseView } from '../../../src/server/lint/types.ts';
import { VALUE_NAMES, valueAnnotation } from '../../../src/shared/ast/notation.ts';
import { parse } from '../../../src/shared/ast/parse.ts';
import { gaijiOf } from '../../shared/ast/_shape.ts';
import { BEL, D } from '../../shared/_kana.ts';

function lines(src: string): LintLine[] {
  return [...walkLines(parse(src))];
}

/** The source text a view span `[a, b)` covers: from where its first unit was written to where its last one ends. */
function covered(src: string, view: ProseView, a: number, b: number): string {
  const start = view.units[a]?.src ?? 0;
  const end = view.units[b - 1]?.end ?? start;
  return src.slice(start, end);
}

const TITLE = valueAnnotation(VALUE_NAMES.title);

test('plain narration: one line, one piece, prose is identity', () => {
  const [l] = lines('あいうえお。');
  assert.ok(l);
  assert.equal(l.prose().text, 'あいうえお。');
  assert.deepEqual(l.pieces.map((p) => [p.text, p.srcStart, p.depth]), [['あいうえお。', 0, 0]]);
  assert.equal(l.narration().text, 'あいうえお。');
  assert.equal(l.dialogue().text, '');
  assert.equal(l.blank, false);
  assert.equal(l.openDepthAtEnd, 0);
  // every unit names its piece and a carrier of typed text
  assert.ok(l.prose().units.every((u) => u.piece === l.pieces[0] && u.carrier?.kind === 'run'));
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
  // the 〇 sentinel is synthetic: no piece, no carrier, mapped at the interior's first unit
  const s = n.units[n.text.indexOf('〇')];
  assert.equal(s?.piece, null);
  assert.equal(s.carrier, null);
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

test('ruby: the base flows into prose (merging with adjacent text); the reading shows nothing', () => {
  const src = 'この太郎《たろう》は言った。';
  const [l] = lines(src);
  assert.ok(l);
  assert.equal(l.narration().text, 'この太郎は言った。');
  // この + 太郎 are source-contiguous at the same depth -> ONE piece; は… starts after 《たろう》
  assert.deepEqual(l.pieces.map((p) => p.text), ['この太郎', 'は言った。']);
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
});

test('ruby inside dialogue: base -> dialogue view, narration 〇', () => {
  const [l] = lines('「漢字《かんじ》」');
  assert.ok(l);
  assert.equal(l.narration().text, '「〇」');
  assert.equal(l.dialogue().text, '漢字');
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

test('a broken ［＃ is shown as typed: read-only units, no piece', () => {
  const [l0, l1] = lines('地の文［＃こわれ\n次の行');
  assert.equal(l0?.prose().text, '地の文［＃こわれ');
  assert.deepEqual(l0.pieces.map((p) => p.text), ['地の文']);
  const broken = l0.prose().units[4];
  assert.equal(broken?.piece, null);
  assert.equal(broken.carrier?.kind, 'run');
  assert.equal(l1?.prose().text, '次の行');
});

test('a 「 swallowed by a broken ［＃ never enters the dialogue stack', () => {
  const ls = lines('［＃「未\nあと');
  assert.equal(ls[0]?.prose().text, '［＃「未');
  assert.equal(ls[0].dialogue().text, '');
  assert.equal(ls[0].directiveOnly, true); // nothing typed as body text
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
  assert.equal(d.units[1].carrier, null);
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

test('a composed kana is one unit whose source is two; a dropped character leaves the view and widens the unit before it', () => {
  const src = `か${D}き${BEL}く`;
  const [l] = lines(src);
  assert.ok(l);
  const v = l.prose();
  assert.equal(v.text, 'がきく');
  assert.deepEqual(v.units.map((u) => [u.src, u.end]), [[0, 2], [2, 4], [4, 5]]);
  assert.deepEqual(l.pieces.map((p) => [p.text, p.srcStart]), [[src, 0]]); // the piece is the source, verbatim
  assert.equal(covered(src, v, 0, 1), `か${D}`);
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

test('blank vs directive-only: a node-less line is blank; a line with nodes but nothing typed is directive-only', () => {
  const ls = lines('あ。\n\n［＃ここから２字下げ］\n［＃改ページ］\nい。\n［＃３字下げ］\n※［＃感嘆符疑問符、1-8-78］');
  assert.deepEqual(ls.map((l) => [l.blank, l.directiveOnly]), [
    [false, false],
    [true, false],
    [false, true],
    [false, true],
    [false, false],
    [false, true], // shows three spaces, typed none
    [false, true], // shows ⁉, typed none
  ]);
});

// --- the line state is the AST's ---

test('heading and indent are the AST line\'s: the block 字下げ; a ［＃N字下げ］ is spaces in the view', () => {
  const src = [
    '＊冒頭は字下げなし。',
    '　字面の空白で始まる行。',
    '本文のあとの［＃３字下げ］は数えない行。',
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
  const ast = parse(src);
  assert.deepEqual(
    [...walkLines(ast)].map((l) => [l.srcLine, l.indent, l.heading]),
    ast.lines.map((l) => [l.index, l.indent, l.heading]),
  );
  const ls = lines('本文［＃３字下げ］\n　［＃３字下げ］本文\n［＃ここから１字下げ］\n［＃２字下げ］本文');
  assert.deepEqual(ls.map((l) => l.indent), [0, 0, 0, 1]);
  assert.deepEqual(ls.map((l) => l.prose().text), ['本文　　　', '　　　　本文', '', '　　本文']);
});

test('a heading postfix whose target is missing leaves its line plain prose', () => {
  const ls = lines('序章［＃「別文」は大見出し］\n本文。');
  assert.deepEqual(ls.map((l) => l.heading), [undefined, undefined]);
  assert.equal(ls[0]?.directiveOnly, false); // the format rules read it
});

// --- what an annotation shows: in the view, read-only ---

test('a value, a 外字注記 and the spaces of a ［＃N字下げ］ are units with no piece, written at their annotation', () => {
  const mark = '※［＃感嘆符疑問符、1-8-78］';
  const src = `なに${mark}次${TITLE}と［＃２字下げ］末`;
  const [l] = lines(src);
  assert.ok(l);
  const v = l.prose();
  assert.equal(v.text, `なに⁉次${VALUE_NAMES.title}と　　末`);
  assert.deepEqual(l.pieces.map((p) => p.text), ['なに', '次', 'と', '末']);
  const gaiji = v.units[2];
  assert.equal(gaiji?.piece, null);
  assert.equal(gaiji.carrier?.kind, 'run');
  assert.equal(src.slice(gaiji.src, gaiji.end), mark);
  const value = v.units[4];
  assert.equal(value?.piece, null);
  assert.equal(src.slice(value.src, value.end), TITLE);
  const space = v.units[v.text.indexOf('　')];
  assert.equal(space?.piece, null);
  assert.equal(space.carrier?.kind, 'indent');
  assert.equal(src.slice(space.src, space.end), '［＃２字下げ］');
  assert.equal(v.units[v.text.indexOf('　') + 1]?.carrier, space.carrier); // one carrier for the annotation's spaces
});

test('what an annotation shows never opens an utterance, and takes the depth where it sits', () => {
  const mark = gaijiOf('《');
  const [l] = lines(`「${mark}あ」${TITLE}`);
  assert.ok(l);
  assert.equal(l.prose().text, `「《あ」${VALUE_NAMES.title}`);
  assert.equal(l.narration().text, `「〇」${VALUE_NAMES.title}`); // the 〇 sits on the 外字注記, the utterance's first unit
  assert.equal(l.dialogue().text, '《あ');
  assert.equal(l.prose().units[1]?.depth, 1);
  assert.equal(l.narration().units[1]?.src, 1);
});

// --- carrier extents: where an insert before/after a unit lands ---

/** Each carrier of line `n` in order, as [the text its units show, the source its outer extents cover]. */
function outer(src: string, n = 0): [string, string][] {
  const l = lines(src)[n];
  assert.ok(l);
  const v = l.prose();
  const out: [string, string][] = [];
  let last: Carrier | null = null;
  for (const [k, unit] of v.units.entries()) {
    if (unit.carrier === null) {
      continue;
    }
    if (unit.carrier === last) {
      const item = out[out.length - 1];
      if (item !== undefined) {
        item[0] += v.text.charAt(k);
      }
    } else {
      out.push([v.text.charAt(k), src.slice(unit.carrier.outerStart, unit.carrier.outerEnd)]);
      last = unit.carrier;
    }
  }
  return out;
}

test('a ruby is one carrier from its ｜ or base through the reading; the text around it is its own', () => {
  assert.deepEqual(outer('　彼は山田《やまだ》'), [['　彼は', '　彼は'], ['山田', '山田《やまだ》']]);
  assert.deepEqual(outer('｜大人《おとな》は笑った。'), [['大人', '｜大人《おとな》'], ['は笑った。', 'は笑った。']]);
  assert.deepEqual(outer('「山田《やまだ》」'), [['「', '「'], ['山田', '山田《やまだ》'], ['」', '」']]);
  const [l] = lines('｜大人《おとな》');
  assert.equal(l?.prose().units[0]?.carrier?.kind, 'cell');
});

test('a span wraps the carrier inside it; stacked and postfix closers all extend it', () => {
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

test('an insert gets out of the decorations on its carrier and no further', () => {
  assert.deepEqual(outer('　驚いた！｜山田《やまだ》'), [['　驚いた！', '　驚いた！'], ['山田', '｜山田《やまだ》']]);
  assert.deepEqual(outer('　すごい！［＃ここから太字］そして［＃ここで太字終わり］'), [
    ['　すごい！', '　すごい！'],
    ['そして', '［＃ここから太字］そして［＃ここで太字終わり］'],
  ]);
  const inner = '［＃傍点］12［＃太字］［＃太字終わり］［＃傍点終わり］';
  assert.deepEqual(outer(inner), [['12', inner]]);
  // an empty span before or after decorates nothing
  assert.deepEqual(outer('［＃傍点］［＃傍点終わり］山田'), [['山田', '山田']]);
  assert.deepEqual(outer('山田［＃傍点］［＃傍点終わり］'), [['山田', '山田']]);
  // a postfix is passed; a start of another channel after the carrier is not
  assert.deepEqual(outer('山田［＃太字］［＃「山田」に傍点］太郎'), [['山田', '山田'], ['太郎', '［＃太字］［＃「山田」に傍点］太郎']]);
});

test('an end of another channel is passed only on the way out of a decoration that is still open', () => {
  assert.deepEqual(outer('［＃傍点］すごい！［＃太字］［＃傍点終わり］そして［＃太字終わり］'), [
    ['すごい！', '［＃傍点］すごい！［＃太字］［＃傍点終わり］'],
    ['そして', 'そして［＃太字終わり］'], // before そして the 傍点 is still open: the insert stays after its end
  ]);
  assert.deepEqual(outer('［＃傍点］［＃太字終わり］本文'), [['本文', '［＃傍点］［＃太字終わり］本文']]); // a dangling end is transparent
  assert.deepEqual(outer('［＃傍点］［＃丸傍点終わり］本文'), [['本文', '本文']]); // the 傍点 variants share one channel
  assert.deepEqual(outer('［＃大見出し］［＃中見出し終わり］題'), [['題', '題']]); // the heading levels share one slot
  const counted = '全［＃縦中横］［＃ここに「総ページ数」の値を表示］［＃縦中横終わり］頁';
  assert.deepEqual(outer(counted), [['全', '全'], ['0', '［＃縦中横］［＃ここに「総ページ数」の値を表示］［＃縦中横終わり］'], ['頁', '頁']]);
});

test('a start on a channel already open wraps nothing new: the end after it closes what decorates the carrier', () => {
  const variant = '彼は［＃傍点］行く［＃丸傍点］［＃傍点終わり］';
  assert.deepEqual(outer(variant), [['彼は', '彼は'], ['行く', '［＃傍点］行く［＃丸傍点］［＃傍点終わり］']]);
  const same = '彼は［＃太字］行く［＃太字］［＃太字終わり］';
  assert.deepEqual(outer(same), [['彼は', '彼は'], ['行く', '［＃太字］行く［＃太字］［＃太字終わり］']]);
  assert.deepEqual(outer('［＃縦中横］12［＃縦中横］［＃縦中横終わり］'), [['12', '［＃縦中横］12［＃縦中横］［＃縦中横終わり］']]);
  assert.deepEqual(outer('［＃大見出し］題［＃中見出し］［＃大見出し終わり］'), [['題', '［＃大見出し］題［＃中見出し］［＃大見出し終わり］']]);
  // The channel may have opened on an earlier line, in either form.
  assert.deepEqual(outer('［＃傍点］\n彼は行く［＃丸傍点］［＃傍点終わり］', 1), [['彼は行く', '彼は行く［＃丸傍点］［＃傍点終わり］']]);
  assert.deepEqual(outer('［＃ここから太字］\n行く［＃太字］［＃太字終わり］', 1), [['行く', '行く［＃太字］［＃太字終わり］']]);
  // …but not a 縦中横: it closed with its line.
  assert.deepEqual(outer('［＃縦中横］12\n34［＃縦中横］［＃縦中横終わり］', 1), [['34', '34']]);
  // An end closes its channel: the next start on it opens afresh.
  assert.deepEqual(outer('［＃傍点］あ［＃傍点終わり］行く［＃傍点］［＃傍点終わり］'), [
    ['あ', '［＃傍点］あ［＃傍点終わり］'],
    ['行く', '行く'],
  ]);
  // A start that opened after the carrier decorates it not at all, whatever follows it.
  assert.deepEqual(outer('山田［＃傍点］［＃太字］［＃傍点終わり］'), [['山田', '山田']]);
});

test('neutral markup binds nothing: a ０字下げ shows nothing, a comment is transparent, a dangling end is passed', () => {
  assert.deepEqual(outer('［＃０字下げ］本文'), [['本文', '本文']]);
  assert.deepEqual(outer('［＃０字下げ］［＃傍点］内容だ［＃傍点終わり］'), [['内容だ', '［＃傍点］内容だ［＃傍点終わり］']]);
  assert.deepEqual(outer('山田［＃メモ］［＃傍点終わり］'), [['山田', '山田［＃メモ］［＃傍点終わり］']]);
  assert.deepEqual(outer('山田［＃メモ］'), [['山田', '山田']]);
  assert.deepEqual(outer('［＃傍点終わり］山田'), [['山田', '山田']]);
  assert.deepEqual(outer('［＃縦中横］12'), [['12', '［＃縦中横］12']]); // unterminated: nothing to skip
});

test('what an annotation shows is a carrier of its own: an insert at its edge lands outside the annotation', () => {
  assert.deepEqual(outer(`本文${TITLE}次`), [['本文', '本文'], [VALUE_NAMES.title, TITLE], ['次', '次']]);
  assert.deepEqual(outer(`［＃傍点］${TITLE}本文［＃傍点終わり］`), [
    [VALUE_NAMES.title, `［＃傍点］${TITLE}`],
    ['本文', '本文［＃傍点終わり］'],
  ]);
  assert.deepEqual(outer(`［＃メモ］${TITLE}本文`), [[VALUE_NAMES.title, TITLE], ['本文', '本文']]);
  const mark = '※［＃感嘆符疑問符、1-8-78］';
  assert.deepEqual(outer(`なに${mark}次`), [['なに', 'なに'], ['⁉', mark], ['次', '次']]);
  assert.deepEqual(outer(`${mark}［＃「⁉」に傍点］次`), [['⁉', `${mark}［＃「⁉」に傍点］`], ['次', '次']]);
  assert.deepEqual(outer('文［＃２字下げ］次'), [['文', '文'], ['　　', '［＃２字下げ］'], ['次', '次']]);
});

test('a depth change inside a span does not cut the carrier: the pieces are cut, the extents are the run\'s', () => {
  const src = '［＃傍点］「山田」［＃傍点終わり］';
  assert.deepEqual(outer(src), [['「山田」', src]]);
  const [l] = lines(src);
  assert.deepEqual(l?.pieces.map((p) => p.text), ['「', '山田', '」']);
});

test('extents are per line: an opener never reaches the next line; CRLF and astral chars are plain', () => {
  const src = '［＃傍点］\n山田［＃傍点終わり］';
  assert.deepEqual(outer(src, 0), []);
  assert.deepEqual(outer(src, 1), [['山田', '山田［＃傍点終わり］']]);
  const astral = '　彼は𠮷《よし》\r\n次';
  assert.deepEqual(outer(astral, 0), [['　彼は', '　彼は'], ['𠮷', '𠮷《よし》']]);
  assert.deepEqual(outer(astral, 1), [['次', '次']]);
});

test('a ｜ base holding annotations: one cell carrier, its pieces cut at the markup inside', () => {
  const postfix = '｜山田［＃「山田」に傍点］《やまだ》';
  assert.deepEqual(outer(postfix), [['山田', postfix]]);
  const split = 'あ｜山田［＃x］太郎《やまだたろう》は';
  assert.deepEqual(outer(split), [['あ', 'あ'], ['山田太郎', '｜山田［＃x］太郎《やまだたろう》'], ['は', 'は']]);
  const [l] = lines(split);
  assert.ok(l);
  assert.deepEqual(l.pieces.map((p) => p.text), ['あ', '山田', '太郎', 'は']);
});

test('a ｜ base of a value field alone: the value is the cell, read-only', () => {
  const ruby = `｜${TITLE}《た》`;
  assert.deepEqual(outer(`あ${ruby}は`), [['あ', 'あ'], [VALUE_NAMES.title, ruby], ['は', 'は']]);
  const [l] = lines(`あ${ruby}は`);
  assert.ok(l);
  assert.deepEqual(l.pieces.map((p) => p.text), ['あ', 'は']);
  assert.equal(l.prose().units[1]?.piece, null);
  assert.equal(l.prose().units[1]?.carrier?.kind, 'cell');
  // A base of a comment alone is no ruby to the Scanner (rubyBaseMissing): the ｜ and 《た》 are prose.
  assert.deepEqual(outer('あ｜［＃メモ］《た》は'), [['あ｜', 'あ｜'], ['《た》は', '《た》は']]);
});

test('an opener inside a ｜ base belongs to the ruby, never to the carrier after it', () => {
  assert.deepEqual(outer('｜山田［＃傍点］《やまだ》太郎［＃傍点終わり］'), [
    ['山田', '｜山田［＃傍点］《やまだ》'],
    ['太郎', '太郎［＃傍点終わり］'],
  ]);
});

test('source covers the line without its terminator, for every terminator and the final line', () => {
  const src = 'あ\r\nい\rう\nえ';
  const all = lines(src);
  assert.deepEqual(all.map((l) => l.source.map((s) => s.text).join('')), ['あ', 'い', 'う', 'え']);
  for (const l of all) {
    assert.equal(src.slice(l.srcStart, l.srcEnd), l.source.map((s) => s.text).join(''));
  }
});

test('source cuts the line at its markup: each markup node alone, the text between joined', () => {
  const src = '前置き山田《やまだ》は｜王都《おうと》［＃「王都」に傍点］へ［＃こわれ';
  const [l] = lines(src);
  assert.ok(l);
  assert.deepEqual(l.source.map((s) => s.text), [
    '前置き山田', // the implicit base stays with the text before it
    '《やまだ》',
    'は',
    '｜',
    '王都',
    '《おうと》',
    '［＃「王都」に傍点］',
    'へ',
    '［＃こわれ',
  ]);
  for (const s of l.source) {
    assert.equal(src.slice(s.srcStart, s.srcStart + s.text.length), s.text);
  }
});

test('NFD: the view shows the kana composed; the piece keeps the source and its offsets', () => {
  const src = `カ${D}ラス《か${D}らす》`;
  const [l] = lines(src);
  assert.ok(l);
  assert.equal(l.prose().text, 'ガラス');
  assert.deepEqual(l.pieces.map((p) => [p.text, p.srcStart]), [[`カ${D}ラス`, 0]]);
  assert.deepEqual(outer(src), [['ガラス', src]]);
});
