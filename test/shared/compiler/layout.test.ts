import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BuildChrome } from '../../../src/shared/compiler/chrome.ts';
import type { DashMode, KinsokuMode } from '../../../src/shared/config/types.ts';
import {
  buildRows,
  findPostfixTargetIssues,
  flowToHtml,
  paginate,
  pagesToHtml,
  type DisplayLine,
  type RenderPage,
} from '../../../src/shared/compiler/layout.ts';
import {
  tokenize,
  VALUE_FIELD_PLACEHOLDERS,
  type ValueField,
} from '../../../src/shared/compiler/tokenizer.ts';
import { DASH_GLYPH } from '../../../src/shared/chars.ts';

/** Paginated lines as BODY pages (the cover-less shape every plain-book test wants). */
const sheets = (ps: readonly DisplayLine[][]): RenderPage[] => ps.map((lines) => ({ lines }));

/** All-off chrome: pagesToHtml emits the bare page/line skeleton with no furniture. */
const OFF: BuildChrome = {
  lineNumbers: false,
  edgeLine: 'none',
  pageNumber: 'none',
  pageNumberFormat: '{page} / {totalPage}',
  header: '',
};

// The continuous preview flow (no pagination); mirrors what renderPreview emits as <body>.
const flow = (src: string, charsPerLine = 40, kinsoku: KinsokuMode = 'none'): string =>
  flowToHtml(buildRows(tokenize(src)), charsPerLine, kinsoku);

const pages = (src: string, charsPerLine = 40, linesPerPage = 34) =>
  paginate(buildRows(tokenize(src)), charsPerLine, linesPerPage, 'none');
// With 禁則処理 on (strict, the shipped tier, unless passed), return each display line as its
// concatenated unit text (one page only); a hung 句読点 shows as ⟪x⟫ after the column's cells.
const klines = (src: string, charsPerLine: number, kinsoku: KinsokuMode = 'strict'): string[] =>
  paginate(buildRows(tokenize(src)), charsPerLine, 34, kinsoku)
    .flat()
    .map(
      (line) =>
        line.units.map((u) => u.text).join('') +
        (line.hang === undefined ? '' : `⟪${line.hang.text}⟫`),
    );
const html = (src: string, charsPerLine = 40, linesPerPage = 34) =>
  pagesToHtml(sheets(pages(src, charsPerLine, linesPerPage)), undefined, OFF);

test('one display line per source line; trailing newline dropped, middle blank kept', () => {
  assert.equal(
    html('一\n二'),
    '<div class="book"><div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">一</div><div class="line" data-line="1">二</div></div></div></div>',
  );
  assert.equal(
    html('一\n'),
    '<div class="book"><div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">一</div></div></div></div>',
  );
  assert.equal(
    html('一\n\n二'),
    '<div class="book"><div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">一</div><div class="line" data-line="1"></div><div class="line" data-line="2">二</div></div></div></div>',
  );
});

test('a long source line hard-wraps at charsPerLine', () => {
  assert.equal(
    html('一二三', 2),
    '<div class="book"><div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">一二</div><div class="line" data-line="0">三</div></div></div></div>',
  );
});

test('a ruby unit is atomic — it wraps whole, never split', () => {
  // あ (hiragana) is a different class from 漢字 (kanji), so the implicit base is just
  // 漢字 (2 cells). あ(1)+漢字(2) = 3 > cpl 2, so the ruby unit wraps whole to line 2.
  // EVERY ruby renders through the custom lanes (rr = right-only), base + reading as
  // justification-unit spans.
  assert.equal(
    html('あ漢字《かんじ》', 2),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">あ</div>' +
      '<div class="line" data-line="0"><ruby class="rr"><span>漢</span><span>字</span>' +
      '<rt><span><span>か</span><span>ん</span><span>じ</span></span></rt></ruby></div></div></div></div>',
  );
});

test('paginate fills linesPerPage lines, then a new page', () => {
  const p = pages('一\n二\n三', 40, 2);
  assert.equal(p.length, 2);
  assert.equal(p[0]?.length, 2);
  assert.equal(p[1]?.length, 1);
});

test('［＃改ページ］ forces a new page', () => {
  assert.equal(
    html('前\n［＃改ページ］\n後'),
    '<div class="book">' +
      '<div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">前</div></div></div>' +
      '<div class="page" data-page="1"><div class="grid"><div class="line" data-line="2">後</div></div></div></div>',
  );
});

test('emphasis span groups consecutive units and re-opens across a wrap', () => {
  assert.match(
    html('［＃傍点］強調［＃傍点終わり］'),
    /<span class="emph-fs">強調<\/span>/,
  );
  assert.equal(
    html('［＃傍点］一二三［＃傍点終わり］', 2),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line emr" data-line="0"><span class="emph-fs">一二</span></div>' +
      '<div class="line emr" data-line="0"><span class="emph-fs">三</span></div></div></div></div>',
  );
});

test('postfix emphasis marks the last occurrence on the source line', () => {
  assert.match(
    html('語と語［＃「語」に傍点］'),
    /語と<span class="emph-fs">語<\/span>/,
  );
});

test('a comment is zero-width: it does not consume a cell or force a wrap', () => {
  assert.equal(
    html('［＃注記］本', 1),
    '<div class="book"><div class="page" data-page="0"><div class="grid"><div class="line" data-line="0"><!--注記-->本</div></div></div></div>',
  );
});

test('a broken ［＃ renders as visible literal text, bounded to its own line', () => {
  assert.equal(
    html('本［＃こわれ\n次'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">本［＃こわれ</div>' +
      '<div class="line" data-line="1">次</div></div></div></div>',
  );
});

test('broken-annotation text consumes cells and wraps like ordinary prose', () => {
  // cpl 3: 本＋［＃こ… — the swallowed chars are real 1-cell units, so the line hard-wraps.
  assert.equal(
    html('本［＃こわれ', 3),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">本［＃</div>' +
      '<div class="line" data-line="0">こわれ</div></div></div></div>',
  );
});

test('禁則 rule 1: a line must not END with an opening bracket — push it down', () => {
  // cpl 3: naive ああ「 | い」 traps 「 at end of line 1. 追い出し pushes 「 down to join
  // its content: ああ | 「い」. (Contrast: kinsoku off would keep ああ「 | い」.)
  assert.deepEqual(klines('ああ「い」', 3), ['ああ', '「い」']);
  assert.deepEqual(pages('ああ「い」', 3).flat().map((l) => l.units.map((u) => u.text).join('')), [
    'ああ「',
    'い」',
  ]);
});

test('禁則 rule 2: a line must not START with a closing/punctuation char — pull preceding down', () => {
  // cpl 2: naive ああ | 」 leaves 」 at line start. Pull あ down: あ | あ」.
  assert.deepEqual(klines('ああ」', 2), ['あ', 'あ」']);
});

test('禁則 cascade: forbidden chars reflow and no line overflows cpl', () => {
  // cpl 3: naive 「あ「 | い」」. The trailing 」」 cascade pulls leftward without ever
  // emptying a line or exceeding cpl. Where 追い出し-only + the no-empty guard cannot
  // satisfy every rule at once (forbidden chars cluster tighter than cpl), the guard
  // wins — a defensible degrade, same as the lone-char exception.
  const out = klines('「あ「い」」', 3);
  for (const line of out) {
    assert.ok(Array.from(line).length <= 3, `line "${line}" exceeds cpl`);
  }
  assert.equal(out.join(''), '「あ「い」」'); // no units lost or reordered
});

test('禁則 exception: a lone forbidden char as the whole row is left as-is', () => {
  // The source row is a single 。 — the > start guard refuses to empty the line.
  assert.deepEqual(klines('。', 1), ['。']);
  assert.deepEqual(klines('「', 1), ['「']);
});

test('禁則 tiers: small kana / ー are 行頭禁則 in strict (the default), free in relaxed', () => {
  // cpl 2, naive いあ | っ: strict pulls あ down; relaxed (Word 標準 / CSS normal) leaves っ at the head.
  assert.deepEqual(klines('いあっ', 2), ['い', 'あっ']);
  assert.deepEqual(klines('いあっ', 2, 'relaxed'), ['いあ', 'っ']);
  assert.deepEqual(klines('いあー', 2), ['い', 'あー']);
  assert.deepEqual(klines('いあー', 2, 'relaxed'), ['いあ', 'ー']);
});

test('禁則 tiers: ・：；, 々 and ゝゞヽヾ〻 are 行頭禁則 already in relaxed', () => {
  assert.deepEqual(klines('いあ・', 2, 'relaxed'), ['い', 'あ・']);
  assert.deepEqual(klines('いあ々', 2, 'relaxed'), ['い', 'あ々']);
  assert.deepEqual(klines('いあゝ', 2, 'relaxed'), ['い', 'あゝ']);
});

test('禁則 predicate: half-width !? and single-codepoint ‼⁇⁈⁉ are 行頭禁則', () => {
  assert.deepEqual(klines('ああ!', 2), ['あ', 'あ!']);
  assert.deepEqual(klines('ああ‼', 2), ['あ', 'あ‼']);
});

test('禁則 predicate: a 縦中横 約物 cell participates in 行頭禁則 whole', () => {
  // The tcy unit's text is "!?" (two chars): the every-char predicate still catches it at
  // a line head; a digit tcy stays free.
  assert.deepEqual(klines('ああ!?［＃「!?」は縦中横］', 2), ['あ', 'あ!?']);
  assert.deepEqual(klines('ああ12［＃「12」は縦中横］', 2), ['ああ', '12']);
});

test('禁則: 〝 must not end a line, 〟 must not start one', () => {
  assert.deepEqual(klines('ああ〝い〟', 3), ['ああ', '〝い〟']);
  assert.deepEqual(klines('ああ〟', 2), ['あ', 'あ〟']);
});

test('分離禁止: a dash pair crosses the wrap whole (mixed codepoints bind too)', () => {
  // cpl 6: naive あいうえお― | ―か splits ――; the bound 2-cell unit moves whole.
  assert.deepEqual(klines('あいうえお――か', 6), ['あいうえお', '――か']);
  assert.deepEqual(klines('あいう—―え', 4), ['あいう', '—―え']); // U+2014 + U+2015
  assert.deepEqual(klines('あいうえお──か', 6), ['あいうえお', '──か']); // U+2500 binds too
});

test('分離禁止: leader pairs (…… / ‥‥) cross the wrap whole', () => {
  assert.deepEqual(klines('あいうえお……か', 6), ['あいうえお', '……か']);
  assert.deepEqual(klines('あいう‥‥え', 4), ['あいう', '‥‥え']);
});

test('約物対: half-width !! / full-width ！！ / tcy stay whole and off the line head', () => {
  // Three shapes, one outcome: the pair never splits, and (being 行頭禁則) never heads a
  // line either — the cascade pulls the preceding char down with it.
  assert.deepEqual(klines('ああ!!', 3), ['あ', 'あ!!']); // bound 2-cell pair (autoTcy off)
  assert.deepEqual(klines('ああ！！', 3), ['あ', 'あ！！']); // full-width: two 1-cell units
  assert.deepEqual(klines('ああ!!［＃「!!」は縦中横］', 3), ['ああ!!']); // tcy: 1 cell, fits
});

test('分離禁止 relaxed vs strict: a long run pairs from the left / binds whole', () => {
  // 4 leaders = two pairs: relaxed may break BETWEEN pairs; an odd tail stays a free single.
  assert.deepEqual(klines('あい…………うえ', 4, 'relaxed'), ['あい……', '……うえ']);
  assert.deepEqual(klines('あい………', 4, 'relaxed'), ['あい……', '…']);
  // strict binds the whole run — it moves down atomically, and an over-budget run
  // overflows on its own line (same degrade as an over-wide ruby).
  assert.deepEqual(klines('あい…………うえ', 4, 'strict'), ['あい', '…………', 'うえ']);
  assert.deepEqual(klines('あ――――――', 4, 'strict'), ['あ', '――――――']);
});

test('分離禁止: a zero-width unit interrupts a run (no binding across a comment)', () => {
  // The degraded postfix becomes a zero-width comment between the dashes → two length-1
  // runs, nothing binds, and the wrap may split them (a defensible degrade).
  assert.deepEqual(klines('あ―［＃「z」に傍点］―', 2), ['あ―', '―']);
});

test('ぶら下げ: a trailing 句読点 hangs as a zero cell instead of 追い出し', () => {
  // cpl 2: 。 would head the next line; it hangs off the full 文だ column instead — the
  // column keeps its budget and no char moves. 、。，． all hang.
  assert.deepEqual(klines('文だ。', 2), ['文だ⟪。⟫']);
  assert.deepEqual(klines('文だ、あ', 2), ['文だ⟪、⟫', 'あ']);
  assert.deepEqual(klines('文だ，', 2), ['文だ⟪，⟫']);
  assert.deepEqual(klines('文だ．', 2), ['文だ⟪．⟫']);
  // none never hangs (bare wrap), and non-句読点 行頭禁則 chars still 追い出し.
  assert.deepEqual(klines('文だ。', 2, 'none'), ['文だ', '。']);
  assert.deepEqual(klines('いあー', 2), ['い', 'あー']);
});

test('ぶら下げ: the hung unit is zero cells and the column stays at budget', () => {
  const line = paginate(buildRows(tokenize('文だ。')), 2, 34, 'strict')[0]?.[0];
  assert.ok(line);
  assert.ok(line.hang);
  assert.equal(line.hang.text, '。');
  assert.equal(line.hang.cells, 0);
  assert.equal(
    line.units.reduce((n, u) => n + u.cells, 0),
    2,
  );
});

test('ぶら下げ: a following 行頭禁則 char cancels the hang — 追い出し instead', () => {
  // 。」: hanging 。 would leave 」 heading the next line → give up, 追い出し (the head
  // violation left at the > start+1 guard is the same degrade as today's cascade).
  assert.deepEqual(klines('文。」', 2), ['文', '。」']);
  // 。。: the first 。 cannot hang (the second would head a line); the second one hangs.
  assert.deepEqual(klines('ああ。。', 2), ['あ', 'あ。⟪。⟫']);
});

test('ぶら下げ: 行末禁則 wins — no hang off a line ending on an opening bracket', () => {
  // 「、 at the boundary: hanging 、 would trap 「 at the line end → 追い出し first.
  assert.deepEqual(klines('あ「、い', 2), ['あ', '「、', 'い']);
});

test('ぶら下げ: a stretched-ruby line hangs its trailing 句読点 with no special-casing', () => {
  // The hang touches no spacing, so a ruby column (rh-N stretched — 志 is 2 cells here —
  // or not) hangs as-is: cpl 4 holds 志(2)+あ+い and the 。 hangs off the full column.
  assert.deepEqual(klines('志《こころざし》あい。', 4), ['志あい⟪。⟫']);
});

test('ぶら下げ: row-local only — an author line-head 。 is never borrowed up', () => {
  assert.deepEqual(klines('あ\n。', 3), ['あ', '。']);
});

test('ぶら下げ: 字下げ narrows the budget but the hang rides the column foot as usual', () => {
  assert.deepEqual(klines('［＃２字下げ］文だ。', 4), ['文だ⟪。⟫']);
});

test('ぶら下げ: the cell ledger resets after a hang — later wraps stay on budget', () => {
  // If the hung cell leaked into the next column's count, あい would split a cell early.
  assert.deepEqual(klines('文だ。あい', 2), ['文だ⟪。⟫', 'あい']);
});

test('ぶら下げ: trailing zero-width units ride the hung column (no orphan empty column)', () => {
  assert.deepEqual(klines('文だ。［＃「z」に傍点］', 2), ['文だ⟪。⟫']);
});

test('ぶら下げ: a decorated hung 句読点 keeps its channel span around the .hang span', () => {
  const out = pagesToHtml(
    sheets(paginate(buildRows(tokenize('文だ。［＃「文だ。」に傍点］')), 2, 34, 'strict')),
    undefined,
    OFF,
  );
  assert.match(out, /<span class="emph-fs"><span class="hang">。<\/span><\/span>/);
});

// --- flowToHtml: the continuous preview flow over the shared engine -------------------

test('flowToHtml: continuous .line columns in one .segment, first-only data-line, no .page', () => {
  assert.equal(
    flow('一二三', 2),
    '<div class="book"><div class="segment">' +
      '<div class="line" data-line="0">一二</div><div class="line">三</div></div></div>',
  );
});

test('flowToHtml: each distinct source line keeps its own data-line anchor', () => {
  assert.equal(
    flow('一\n二\n三'),
    '<div class="book"><div class="segment"><div class="line" data-line="0">一</div>' +
      '<div class="line" data-line="1">二</div><div class="line" data-line="2">三</div></div></div>',
  );
});

test('flowToHtml: a blank source line becomes a blank column (kept, not collapsed)', () => {
  assert.equal(
    flow('一\n\n二'),
    '<div class="book"><div class="segment"><div class="line" data-line="0">一</div>' +
      '<div class="line" data-line="1"></div><div class="line" data-line="2">二</div></div></div>',
  );
});

test('flowToHtml: ［＃改ページ］ becomes a labelled .pagebreak marker BETWEEN segments', () => {
  // The marker is a direct .book child, outside both segments — the frames on either side
  // close independently and neither encloses the break.
  assert.equal(
    flow('前\n［＃改ページ］\n後'),
    '<div class="book"><div class="segment"><div class="line" data-line="0">前</div></div>' +
      '<div class="pagebreak"><span class="pb-label">改ページ</span></div>' +
      '<div class="segment"><div class="line" data-line="2">後</div></div></div>',
  );
});

test('flowToHtml: leading / trailing / doubled page breaks collapse (no stray marker)', () => {
  assert.equal(
    flow('［＃改ページ］\n後'),
    '<div class="book"><div class="segment"><div class="line" data-line="1">後</div></div></div>',
  );
  assert.equal(
    flow('前\n［＃改ページ］'),
    '<div class="book"><div class="segment"><div class="line" data-line="0">前</div></div></div>',
  );
  assert.equal(
    flow('前\n［＃改ページ］\n［＃改ページ］\n後'),
    '<div class="book"><div class="segment"><div class="line" data-line="0">前</div></div>' +
      '<div class="pagebreak"><span class="pb-label">改ページ</span></div>' +
      '<div class="segment"><div class="line" data-line="3">後</div></div></div>',
  );
});

test('flowToHtml: an empty book and a break-only book emit no segment', () => {
  // Segments open lazily on their first line, so a book with no lines has none.
  assert.equal(flow(''), '<div class="book"></div>');
  assert.equal(flow('［＃改ページ］'), '<div class="book"></div>');
  assert.equal(flow('［＃改ページ］\n［＃改ページ］'), '<div class="book"></div>');
});

test('flowToHtml: a break followed by a blank line opens the next segment on the blank column', () => {
  // The blank line is a real row, so it materializes the break and leads the new segment.
  assert.equal(
    flow('前\n［＃改ページ］\n\n後'),
    '<div class="book"><div class="segment"><div class="line" data-line="0">前</div></div>' +
      '<div class="pagebreak"><span class="pb-label">改ページ</span></div>' +
      '<div class="segment"><div class="line" data-line="2"></div>' +
      '<div class="line" data-line="3">後</div></div></div>',
  );
});

// ダッシュ tests drive the translation explicitly — the plain helpers above stay glyph-agnostic.
const dashFlow = (src: string, dash: DashMode = 'horizontalBar'): string =>
  flowToHtml(buildRows(tokenize(src), { dash }), 40, 'none');
const dashHtml = (src: string): string =>
  pagesToHtml(sheets(paginate(buildRows(tokenize(src), { dash: 'horizontalBar' }), 40, 34, 'none')), undefined, OFF);

test('ダッシュ: the configured spelling is emitted as the em dash — bare glyph, no markup', () => {
  assert.equal(
    dashHtml('あ――い'),
    '<div class="book"><div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">あ——い</div></div></div></div>',
  );
  assert.doesNotMatch(dashFlow('あ――い'), /class="dash/);
  // Translation is per glyph and selected-only; `text` keeps the source for every spelling.
  const row = buildRows(tokenize('—―─'), { dash: 'horizontalBar' })[0];
  const units = row?.kind === 'line' ? row.units : [];
  assert.deepEqual(units.map((u) => [u.html, u.text, u.cssClass]), [
    ['—', '—', undefined], // already an em dash: nothing to translate
    ['—', '―', undefined], // the configured glyph, translated; text keeps the source
    ['─', '─', undefined], // a foreign glyph stays put — the dash lint flags it
  ]);
});

test('ダッシュ: each mode translates its own glyph only', () => {
  assert.match(dashFlow('あ――い'), /あ——い/);
  assert.match(dashFlow('あ──い', 'boxDrawing'), /あ——い/);
  assert.match(dashFlow('あ――い', 'emDash'), /あ――い/); // ― is foreign under emDash
});

test('ダッシュ: postfix targets match the SOURCE spelling; the emitted run is translated', () => {
  // ［＃「―い」…］ names U+2015. Matching runs on Unit.text — translating it would turn every
  // such postfix into a syntax.postfixTargetMissing false positive.
  assert.match(dashFlow('あ――い［＃「―い」に傍点］'), /あ—<span class="emph-fs">—い<\/span>/);
  // A postfix 縦中横 rebuilds its combined cell from the source text — the cell keeps ―.
  assert.match(dashFlow('あ――い［＃「―い」は縦中横］'), /あ—<span class="tcy">―い<\/span>/);
  // A ルビ lane rebuilds its base the same way (a dash may still be a 左ルビ base).
  assert.match(dashFlow('――［＃「――」の左に「and」のルビ］'), /<ruby class="lr">/);
});

test('ダッシュ: 分離禁止 still binds the run; the merged unit carries the translation', () => {
  const bound = paginate(buildRows(tokenize('あ――'), { dash: 'horizontalBar' }), 40, 34, 'strict').flat();
  assert.deepEqual(bound[0]?.units.map((u) => [u.html, u.text, u.cssClass]), [
    ['あ', 'あ', undefined],
    ['——', '――', undefined],
  ]);
  // inside 縦中横 the dash is part of the combined cell — one tcy span, source glyph
  assert.match(dashFlow('［＃縦中横］―［＃縦中横終わり］'), /<span class="tcy">―<\/span>/);
});

test('flowToHtml: honors the kinsoku mode (禁則) — the SAME engine as the build', () => {
  // cpl 2: naive ああ | 」 leaves 」 at line start; 追い出し pulls あ down → あ | あ」.
  assert.equal(
    flow('ああ」', 2, 'relaxed'),
    '<div class="book"><div class="segment">' +
      '<div class="line" data-line="0">あ</div><div class="line">あ」</div></div></div>',
  );
});

test('flowToHtml: lineNumbers emits JS-numbered .ln heads that restart at a break marker', () => {
  // Numbering is computed here (not CSS counters — a sibling counter-reset does not reset
  // following siblings in Chromium); a wrapped continuation column counts as its own line,
  // and a collapsed (doubled) break still restarts only once — with the segment it opens.
  assert.equal(
    flowToHtml(buildRows(tokenize('一二三\n［＃改ページ］\n［＃改ページ］\n四')), 2, 'none', undefined, true),
    '<div class="book"><div class="segment">' +
      '<div class="line" data-line="0"><span class="ln">1</span>一二</div>' +
      '<div class="line"><span class="ln">2</span>三</div></div>' +
      '<div class="pagebreak"><span class="pb-label">改ページ</span></div>' +
      '<div class="segment"><div class="line" data-line="3"><span class="ln">1</span>四</div></div></div>',
  );
});

test('emit: postfix target missing on the source line degrades to a comment', () => {
  assert.equal(
    html('別の文［＃「無」に傍点］'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">別の文<!--「無」に傍点--></div></div></div></div>',
  );
});

test('emit: an emphasis span re-opens on the next source line', () => {
  assert.equal(
    html('これは［＃傍点］強調\nされる文［＃傍点終わり］です'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line emr" data-line="0">これは<span class="emph-fs">強調</span></div>' +
      '<div class="line emr" data-line="1"><span class="emph-fs">される文</span>です</div></div></div></div>',
  );
});

test('emit: right-side 傍点 stamps .emr on its line; left-side and 傍線 do not', () => {
  assert.match(html('言葉［＃「言葉」に傍点］'), /<div class="line emr"/);
  assert.doesNotMatch(html('言葉［＃「言葉」の左に傍点］'), /emr/);
  assert.doesNotMatch(html('言葉［＃「言葉」に傍線］'), /emr/); // decorations are paint-only
});

test('emit: escapes & < > " in text', () => {
  assert.equal(
    html('a<b>&"c'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">a&lt;b&gt;&amp;&quot;c</div></div></div></div>',
  );
});

test('emit: leading 全角 spaces are preserved verbatim (no auto-indent)', () => {
  assert.equal(
    html('　　本文'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">　　本文</div></div></div></div>',
  );
});

test('emit: empty input yields an empty book', () => {
  assert.equal(html(''), '<div class="book"></div>');
});

// --------------------------------------------------------------- multi-channel decorations

test('multi-channel: 太字 span over 傍点 span → one span with fixed-order classes', () => {
  assert.match(
    html('［＃太字］［＃傍点］字［＃傍点終わり］［＃太字終わり］'),
    /<span class="emph-fs b">字<\/span>/,
  );
});

test('same-channel: a 傍点 postfix overwrites the active 傍点 span class', () => {
  const out = html('［＃傍点］語［＃傍点終わり］［＃「語」に丸傍点］');
  assert.match(out, /<span class="emph-fc">語<\/span>/);
  assert.doesNotMatch(out, /emph-fs/);
});

test('終わり clears only its own channel: 傍点終わり leaves 太字 active', () => {
  assert.match(
    html('［＃太字］［＃傍点］字［＃傍点終わり］体［＃太字終わり］'),
    /<span class="emph-fs b">字<\/span><span class="b">体<\/span>/,
  );
});

test('傍線 postfix marks the last occurrence with the line channel', () => {
  assert.match(html('語と語［＃「語」に傍線］'), /語と<span class="dec-solid">語<\/span>/);
});

// --------------------------------------------------------------- 左ルビ (left ruby)

test('左ルビ on plain text merges into ONE lr ruby unit (custom layout classes)', () => {
  // Base AND readings are split into justification-unit spans (one per kana glyph) so the
  // flex space-around boxes distribute them like native ruby-align.
  assert.equal(
    html('青空文庫［＃「青空文庫」の左に「あおぞらぶんこ」のルビ］'),
    '<div class="book"><div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">' +
      '<ruby class="lr"><span>青</span><span>空</span><span>文</span><span>庫</span><rt class="rt-l"><span>' +
      '<span>あ</span><span>お</span><span>ぞ</span><span>ら</span><span>ぶ</span><span>ん</span><span>こ</span>' +
      '</span></rt></ruby></div></div></div></div>',
  );
});

test('両側ルビ: the left reading joins the existing right-ruby unit (br, both <rt>s)', () => {
  // Kana per glyph; the Latin reading stays ONE rotated run with its U+0020 inside. Neither
  // reading outruns the base (7 kana = 3.5em, "aozora bunko" ≈ 3em, base 4em) so there is
  // no rh-N stretch class.
  assert.equal(
    html('青空文庫《あおぞらぶんこ》［＃「青空文庫」の左に「aozora bunko」のルビ］'),
    '<div class="book"><div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">' +
      '<ruby class="br"><span>青</span><span>空</span><span>文</span><span>庫</span><rt><span>' +
      '<span>あ</span><span>お</span><span>ぞ</span><span>ら</span><span>ぶ</span><span>ん</span><span>こ</span>' +
      '</span></rt><rt class="rt-l"><span><span>aozora bunko</span></span></rt></ruby>' +
      '</div></div></div></div>',
  );
});

test('a half-width space in a reading survives into the lane (right, left AND base runs)', () => {
  assert.match(html('英雄《Super Hero》'), /<rt><span><span>Super Hero<\/span><\/span><\/rt>/);
  assert.match(
    html('英雄《えいゆう》［＃「英雄」の左に「Super Hero」のルビ］'),
    /<rt class="rt-l"><span><span>Super Hero<\/span><\/span><\/rt>/,
  );
  assert.match(html('｜Au revoir《さらば》'), /<ruby class="rr"><span>Au revoir<\/span><rt><span>/);
});

test('a full-width space in a reading is its own blank unit', () => {
  // U+3000 is not a run separator: it paints as a full-width blank of its own (advance
  // already counts it at 2 quarters).
  assert.match(
    html('漢字《かん　じ》'),
    /<rt><span><span>か<\/span><span>ん<\/span><span>　<\/span><span>じ<\/span><\/span><\/rt>/,
  );
});

test('phantom spaces: a U+0020 run measures at its PAINTED width — no base stretch', () => {
  // CSS collapses a U+0020 run to one space and trims unit edges; measurement follows the
  // paint, so geometry equals the single-space form and only the DOM keeps the author's run.
  const spaced = `英雄《えいゆう》［＃「英雄」の左に「Super${' '.repeat(38)}Hero」のルビ］`;
  const single = '英雄《えいゆう》［＃「英雄」の左に「Super Hero」のルビ］';
  const cells = (src: string): number | undefined =>
    pages(src, 40)
      .flat()[0]
      ?.units.reduce((n, u) => n + u.cells, 0);
  assert.equal(cells(spaced), cells(single));
  assert.equal(html(spaced).replace(' '.repeat(38), ' '), html(single));
  // Edge spaces trim to zero width, so they add no cells either.
  assert.equal(cells('字《 かん 》'), cells('字《かん》'));
});

test('右-only ruby uses the rr lane; JIS ルビ掛け keeps odd readings on-grid', () => {
  assert.match(html('漢字《かんじ》'), /<ruby class="rr">/);
  // 1:3 — the 1.5em reading hangs ≤0.25em over the plain あ/い neighbours (ルビ掛け): the
  // unit stays ONE on-grid cell, no stretch.
  const hang = 'あ字《かんじ》い';
  assert.match(html(hang), /<ruby class="rr">/);
  assert.doesNotMatch(html(hang), /rh-/);
  assert.equal(pages(hang, 3).flat()[0]?.units.reduce((n, u) => n + u.cells, 0), 3);
  // 1:5 exceeds the half-glyph-per-side allowance: stretch to 2 whole cells, grid follows.
  const long = 'あ志《こころざし》い';
  assert.match(html(long), /<ruby class="rr rh-2">/);
  const p = pages(long, 4);
  assert.equal(p.flat().length, 1);
  assert.equal(p.flat()[0]?.units.reduce((n, u) => n + u.cells, 0), 4); // あ + [2] + い
});

test('ルビ掛け falls back to whole cells over unsafe neighbours (ruby / 傍点)', () => {
  // Adjacent rubies would collide in the shared lane — both keep their safe 2-cell width.
  const twin = html('字《かんじ》字《かんじ》');
  assert.equal((twin.match(/rh-2/g) ?? []).length, 2);
  // A dotted neighbour occupies the lane too.
  assert.match(html('［＃傍点］あ［＃傍点終わり］字《かんじ》'), /<ruby class="rr rh-2">/);
});

test('左ルビ stretches its base like native ruby when the reading is longer', () => {
  // base 字 (1 cell) with an 8-kana reading (8 × 0.5em = 4em): the unit advances 4 cells —
  // the grid follows the paint — and carries the on-demand rh-4 min-height class.
  const src = '字［＃「字」の左に「ながいひだりよみ」のルビ］い';
  const p = pages(src, 5);
  assert.equal(p.flat().length, 1);
  assert.equal(p.flat()[0]?.units.reduce((n, u) => n + u.cells, 0), 5); // 4 (stretched) + い
  assert.match(html(src), /<ruby class="lr rh-4">/);
  const used = new Set<string>();
  pagesToHtml(sheets(pages(src, 5)), used, OFF);
  assert.ok(used.has('lr') && used.has('rh-4')); // both on-demand classes reach the sink
});

test('a long HALF-width reading counts at ≈quarter-em: no premature stretch', () => {
  // "aozora bunko" (12 half-width cps ≈ 3em at the 0.5em lane) never outruns the 4-char base.
  const out = html('青空文庫《あ》［＃「青空文庫」の左に「aozora bunko」のルビ］');
  assert.match(out, /<ruby class="br">/);
  assert.doesNotMatch(out, /rh-/);
});

test('左ルビ cutting into a ruby unit is unaligned → degrade + warn', () => {
  assert.equal(
    html('漢字《かんじ》［＃「字」の左に「よみ」のルビ］'),
    '<div class="book"><div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">' +
      '<ruby class="rr"><span>漢</span><span>字</span>' +
      '<rt><span><span>か</span><span>ん</span><span>じ</span></span></rt></ruby>' +
      '<!--「字」の左に「よみ」のルビ--></div></div></div></div>',
  );
  assert.equal(findPostfixTargetIssues('漢字《かんじ》［＃「字」の左に「よみ」のルビ］').length, 1);
});

test('左ルビ over MIXED coverage (a ruby unit plus text) degrades + warns', () => {
  // 青空 is a ruby unit, 文庫 plain text: aligned, but re-basing would drop the inner right
  // reading — the author must split the annotation.
  const src = '青空《あお》文庫［＃「青空文庫」の左に「x」のルビ］';
  assert.match(html(src), /<ruby class="rr"><span>青<\/span><span>空<\/span><rt><span><span>あ<\/span><span>お<\/span><\/span><\/rt><\/ruby>文庫<!--/);
  assert.equal(findPostfixTargetIssues(src).length, 1);
});

test('左ルビ inherits the replaced units’ channels and stays postfix-matchable', () => {
  // The merge inherits the ORIGINAL units' weight channel (set while the 太字 span was open),
  // and the merged unit's text keeps the base, so the later 傍点 postfix covers it whole-unit.
  const out = html('［＃太字］青空［＃太字終わり］［＃「青空」の左に「あお」のルビ］［＃「青空」に傍点］');
  assert.match(
    out,
    /<span class="emph-fs b"><ruby class="lr"><span>青<\/span><span>空<\/span><rt class="rt-l"><span><span>あ<\/span><span>お<\/span><\/span><\/rt><\/ruby><\/span>/,
  );
});

test('the used sink collects lr / br', () => {
  const used = new Set<string>();
  pagesToHtml(sheets(pages('青空文庫《あ》［＃「青空文庫」の左に「b」のルビ］')), used, OFF);
  assert.ok(used.has('br'));
  assert.ok(!used.has('lr'));
});

// --------------------------------------------------------------- 縦中横 (tate-chu-yoko)

test('縦中横 span combines its content into ONE upright cell', () => {
  assert.equal(
    html('令和［＃縦中横］12［＃縦中横終わり］年'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">令和<span class="tcy">12</span>年</div></div></div></div>',
  );
  // The pair takes ONE cell: 令+和+[12]+年 = 4 cells, so cpl 4 still fits on one display line.
  const p = pages('令和［＃縦中横］12［＃縦中横終わり］年', 4);
  assert.equal(p.flat().length, 1);
});

test('縦中横 postfix merges the aligned match into one 1-cell unit', () => {
  assert.equal(
    html('米機Ｂ29［＃「29」は縦中横］'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">米機Ｂ<span class="tcy">29</span></div></div></div></div>',
  );
});

test('a merged 縦中横 cell keeps its text: a later postfix can cover it whole-unit', () => {
  assert.match(
    html('米機Ｂ29［＃「29」は縦中横］［＃「29」に傍点］'),
    /<span class="emph-fs"><span class="tcy">29<\/span><\/span>/,
  );
});

test('an unclosed ［＃縦中横］ auto-closes at its line end (line-local)', () => {
  assert.equal(
    html('序［＃縦中横］12\n次'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">序<span class="tcy">12</span></div>' +
      '<div class="line" data-line="1">次</div></div></div></div>',
  );
});

test('a dangling ［＃縦中横終わり］ is a render no-op', () => {
  assert.equal(
    html('AB［＃縦中横終わり］'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">AB</div></div></div></div>',
  );
});

test('縦中横 content is plain text: an inner ruby stays literal (no nesting)', () => {
  assert.match(
    html('［＃縦中横］漢《かん》［＃縦中横終わり］'),
    /<span class="tcy">漢《かん》<\/span>/,
  );
});

test('縦中横 inside a 太字 span inherits the weight channel', () => {
  assert.match(
    html('［＃太字］［＃縦中横］12［＃縦中横終わり］［＃太字終わり］'),
    /<span class="b"><span class="tcy">12<\/span><\/span>/,
  );
});

test('the used sink collects the tcy class (on-demand stylesheet)', () => {
  const used = new Set<string>();
  pagesToHtml(sheets(pages('令和［＃縦中横］12［＃縦中横終わり］年')), used, OFF);
  assert.ok(used.has('tcy'));
  const clean = new Set<string>();
  pagesToHtml(sheets(pages('ただの本文')), clean, OFF);
  assert.ok(!clean.has('tcy'));
});

test('findPostfixTargetIssues covers 縦中横 postfix misses too', () => {
  assert.deepEqual(findPostfixTargetIssues('あ［＃「99」は縦中横］'), [
    { start: 1, end: 1 + '［＃「99」は縦中横］'.length, target: '99' },
  ]);
});

// --------------------------------------------------------------- postfix boundary alignment

test('a postfix cutting into an atomic ruby unit does not apply (boundary alignment)', () => {
  // 字 sits INSIDE the atomic ruby unit 漢字 — a match cutting into an atomic unit must
  // refuse and degrade to a comment (plus the editor Warning, below), never dot the unit.
  assert.equal(
    html('漢字《かんじ》［＃「字」に傍点］'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0"><ruby class="rr"><span>漢</span><span>字</span>' +
      '<rt><span><span>か</span><span>ん</span><span>じ</span></span></rt></ruby><!--「字」に傍点--></div></div></div></div>',
  );
});

test('whole-unit coverage of a ruby unit still applies (aligned)', () => {
  assert.match(
    html('漢字《かんじ》［＃「漢字」に傍点］'),
    /<span class="emph-fs"><ruby class="rr"><span>漢<\/span><span>字<\/span><rt><span><span>か<\/span><span>ん<\/span><span>じ<\/span><\/span><\/rt><\/ruby><\/span>/,
  );
});

test('findPostfixTargetIssues: absent and unaligned targets warn; aligned matches stay silent', () => {
  // absent — the annotation starts after 別の文 (3 chars)
  assert.deepEqual(findPostfixTargetIssues('別の文［＃「無」に傍点］'), [
    { start: 3, end: 3 + '［＃「無」に傍点］'.length, target: '無' },
  ]);
  // unaligned — 字 cuts into the ruby unit 漢字 (annotation starts after the 7-char ruby raw)
  assert.deepEqual(findPostfixTargetIssues('漢字《かんじ》［＃「字」に傍点］'), [
    { start: 7, end: 7 + '［＃「字」に傍点］'.length, target: '字' },
  ]);
  // aligned whole-ruby-unit coverage applies — no issue
  assert.deepEqual(findPostfixTargetIssues('漢字《かんじ》［＃「漢字」に傍点］'), []);
  // plain-text partial coverage stays legal (1-char text units always align)
  assert.deepEqual(findPostfixTargetIssues('文字［＃「字」に傍点］'), []);
  // postfix binding is line-local: a target on the PREVIOUS line does not resolve
  assert.deepEqual(findPostfixTargetIssues('対象\n［＃「対象」に傍点］'), [
    { start: 3, end: 3 + '［＃「対象」に傍点］'.length, target: '対象' },
  ]);
});

// --------------------------------------------------------------- 字下げ (indent)

test('block 字下げ: every wrapped continuation column keeps indent-N', () => {
  assert.equal(
    html('［＃ここから１字下げ］\n一二三\n［＃ここで字下げ終わり］', 2),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line indent-1" data-line="1">一</div>' +
      '<div class="line indent-1" data-line="1">二</div>' +
      '<div class="line indent-1" data-line="1">三</div></div></div></div>',
  );
});

test('N_eff clamp: an indent ≥ charsPerLine clamps to cpl−1 for BOTH class and budget', () => {
  assert.equal(
    html('［＃９字下げ］一二', 3),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line indent-2" data-line="0">一</div>' +
      '<div class="line indent-2" data-line="0">二</div></div></div></div>',
  );
});

test('０字下げ / a dangling ［＃ここで字下げ終わり］ are render no-ops', () => {
  assert.equal(
    html('［＃０字下げ］頭'),
    '<div class="book"><div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">頭</div></div></div></div>',
  );
  assert.equal(
    html('あ［＃ここで字下げ終わり］\nい'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">あ</div><div class="line" data-line="1">い</div></div></div></div>',
  );
});

test('unclosed block 字下げ leniently continues to EOF', () => {
  assert.equal(
    html('［＃ここから２字下げ］\n一\n二'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line indent-2" data-line="1">一</div>' +
      '<div class="line indent-2" data-line="2">二</div></div></div></div>',
  );
});

// --------------------------------------------------------------- 見出し (heading)

test('見出し line: the whole column carries .midashi; the annotation is consumed', () => {
  assert.equal(
    html('第一章　出会い［＃「第一章　出会い」は大見出し］\n本文'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line midashi" data-line="0">第一章　出会い</div>' +
      '<div class="line" data-line="1">本文</div></div></div></div>',
  );
});

test('見出し: every wrapped continuation keeps .midashi (like indent)', () => {
  assert.equal(
    html('一二三［＃「一二三」は中見出し］', 2),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line midashi" data-line="0">一二</div>' +
      '<div class="line midashi" data-line="0">三</div></div></div></div>',
  );
});

test('見出し composes with 字下げ; a ruby-bearing heading matches its BASE text', () => {
  assert.equal(
    html('［＃２字下げ］序［＃「序」は小見出し］'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line indent-2 midashi" data-line="0">序</div></div></div></div>',
  );
  // Aozora: the heading target EXCLUDES ruby readings — base-text matching resolves it.
  assert.match(
    html('独《ひと》り寝《ね》の別《わか》れ［＃「独り寝の別れ」は大見出し］'),
    /<div class="line midashi" data-line="0">/,
  );
});

test('見出し with an unresolved target degrades to a comment and reports the miss', () => {
  assert.equal(
    html('本文［＃「別文」は大見出し］'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">本文<!--「別文」は大見出し--></div></div></div></div>',
  );
  assert.deepEqual(
    findPostfixTargetIssues('本文［＃「別文」は大見出し］').map((i) => i.target),
    ['別文'],
  );
});

test('見出し postfix is line-local: the next source line renders plain', () => {
  assert.equal(
    flow('章［＃「章」は大見出し］\n本文'),
    '<div class="book"><div class="segment">' +
      '<div class="line midashi" data-line="0">章</div>' +
      '<div class="line" data-line="1">本文</div></div></div>',
  );
});

test('見出し inline span: same-line pair marks its line; the annotations are consumed', () => {
  assert.equal(
    html('［＃大見出し］第一章　出会い［＃大見出し終わり］\n本文'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line midashi" data-line="0">第一章　出会い</div>' +
      '<div class="line" data-line="1">本文</div></div></div></div>',
  );
});

test('見出し inline span carries ACROSS lines until the end annotation (like 太字)', () => {
  assert.equal(
    html('［＃大見出し］美味しいです。\n焼き肉は。［＃大見出し終わり］\n本文'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line midashi" data-line="0">美味しいです。</div>' +
      '<div class="line midashi" data-line="1">焼き肉は。</div>' +
      '<div class="line" data-line="2">本文</div></div></div></div>',
  );
});

test('見出し block: the directive lines vanish and the body lines carry .midashi', () => {
  assert.equal(
    html('［＃ここから大見出し］\n第一章\n出会い\n［＃ここで大見出し終わり］\n本文'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line midashi" data-line="1">第一章</div>' +
      '<div class="line midashi" data-line="2">出会い</div>' +
      '<div class="line" data-line="4">本文</div></div></div></div>',
  );
});

test('ここから見出し on a text line: that line keeps its pre-block state (like indent)', () => {
  assert.equal(
    html('前文［＃ここから中見出し］\n題'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">前文</div>' +
      '<div class="line midashi" data-line="1">題</div></div></div></div>',
  );
});

test('見出し levels share one slot: any 終わり closes; dangling is a no-op; EOF auto-closes', () => {
  // A mismatched-level end still closes the open heading (one parameterized channel).
  assert.equal(
    html('［＃ここから大見出し］\n題\n［＃ここで中見出し終わり］\n後'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line midashi" data-line="1">題</div>' +
      '<div class="line" data-line="3">後</div></div></div></div>',
  );
  assert.equal(
    html('あ［＃大見出し終わり］\nい'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">あ</div><div class="line" data-line="1">い</div></div></div></div>',
  );
  assert.equal(
    html('［＃中見出し］題\n続'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line midashi" data-line="0">題</div>' +
      '<div class="line midashi" data-line="1">続</div></div></div></div>',
  );
});

test('見出し block composes with a 字下げ block: both classes on the body line', () => {
  assert.equal(
    html('［＃ここから２字下げ］\n［＃ここから小見出し］\n章\n［＃ここで小見出し終わり］\n［＃ここで字下げ終わり］'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line indent-2 midashi" data-line="2">章</div></div></div></div>',
  );
});

// --------------------------------------------------------------- empty-column suppression

test('a block-directive-only line paints no column; the next line is indented', () => {
  const out = html('あ\n［＃ここから２字下げ］\nい');
  assert.equal(
    out,
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">あ</div>' +
      '<div class="line indent-2" data-line="2">い</div></div></div></div>',
  );
  // data-line numbering gaps over the suppressed directive line but stays true after it.
  assert.doesNotMatch(out, /data-line="1"/);
});

test('a plain comment-only line KEEPS its blank column (unchanged behaviour)', () => {
  assert.match(
    html('あ\n［＃謎の注記］\nい'),
    /<div class="line" data-line="1"><!--謎の注記--><\/div>/,
  );
});

test('ここから on a text line: that line keeps the pre-block indent, block starts next line', () => {
  assert.equal(
    html('［＃ここから２字下げ］あ\nい'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">あ</div>' +
      '<div class="line indent-2" data-line="1">い</div></div></div></div>',
  );
});

test('block 太字: the directive lines vanish and the body lines carry the b class', () => {
  assert.equal(
    html('［＃ここから太字］\n強い\n［＃ここで太字終わり］\n後'),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="1"><span class="b">強い</span></div>' +
      '<div class="line" data-line="3">後</div></div></div></div>',
  );
});

// --------------------------------------------------------------- 値の表示 (value substitution)

/** Every unit's text across the rows, concatenated — what the layout measured. */
const unitText = (src: string, values?: Readonly<Record<ValueField, string>>): string =>
  buildRows(tokenize(src), values === undefined ? undefined : { values })
    .flatMap((row) => (row.kind === 'line' ? row.units : []))
    .map((u) => u.text)
    .join('');

const REAL: Readonly<Record<ValueField, string>> = {
  title: '作品名',
  author: 'ペンネーム',
  totalPages: '215',
  sheets: '58',
};

test('値の表示: a bookless compile substitutes the fixed placeholders', () => {
  assert.equal(unitText('［＃ここに「タイトル」の値を表示］'), VALUE_FIELD_PLACEHOLDERS.title);
  assert.equal(unitText('［＃ここに「ペンネーム」の値を表示］'), VALUE_FIELD_PLACEHOLDERS.author);
  assert.equal(unitText('［＃ここに「総ページ数」の値を表示］'), VALUE_FIELD_PLACEHOLDERS.totalPages);
  assert.equal(unitText('［＃ここに「原稿用紙換算枚数」の値を表示］'), VALUE_FIELD_PLACEHOLDERS.sheets);
});

test('値の表示: opts.values substitutes the real values, an empty one emitting nothing', () => {
  assert.equal(unitText('［＃ここに「タイトル」の値を表示］', REAL), REAL.title);
  assert.equal(unitText('全［＃ここに「総ページ数」の値を表示］ページ', REAL), `全${REAL.totalPages}ページ`);
  assert.equal(unitText('［＃ここに「ペンネーム」の値を表示］', { ...REAL, author: '' }), '');
});

test('値の表示: substituted text is per-char units — it measures and wraps like prose', () => {
  const rows = buildRows(tokenize('［＃ここに「タイトル」の値を表示］'), { values: REAL });
  const units = rows.flatMap((row) => (row.kind === 'line' ? row.units : []));
  assert.equal(units.length, Array.from(REAL.title).length);
  assert.ok(units.every((u) => u.cells === 1));
  // cpl 2 splits the 3-character title across two display lines, like any typed run.
  assert.equal(
    paginate(rows, 2, 34, 'none').flat().map((l) => l.units.map((u) => u.text).join('')).join('|'),
    '作品|名',
  );
});

test('値の表示: the configured dash inside a value translates like typed prose', () => {
  const rows = buildRows(tokenize('［＃ここに「タイトル」の値を表示］'), {
    values: { ...REAL, title: '光―闇' },
    dash: 'horizontalBar',
  });
  const units = rows.flatMap((row) => (row.kind === 'line' ? row.units : []));
  assert.equal(units.map((u) => u.text).join(''), '光―闇'); // text keeps the SOURCE glyph
  assert.equal(units[1]?.html, DASH_GLYPH); // …the html carries the em dash
});

test('値の表示: a value inside ［＃縦中横］ joins the combined cell', () => {
  const rows = buildRows(tokenize('全［＃縦中横］［＃ここに「総ページ数」の値を表示］［＃縦中横終わり］ページ'), {
    values: REAL,
  });
  const units = rows.flatMap((row) => (row.kind === 'line' ? row.units : []));
  const tcy = units.filter((u) => u.cssClass === 'tcy');
  assert.equal(tcy.length, 1);
  assert.equal(tcy[0]?.text, REAL.totalPages);
  assert.equal(tcy[0].cells, 1); // combined cells are always one cell wide
  assert.equal(tcy[0].html, `<span class="tcy">${REAL.totalPages}</span>`);
});

// --------------------------------------------------------------- cover pages

/** Chrome with both furniture pieces on — covers must still show neither. */
const FURNISHED: BuildChrome = {
  lineNumbers: false,
  edgeLine: 'none',
  pageNumber: 'rightLeft',
  pageNumberFormat: '{page} / {totalPage}',
  header: '柱',
};

/** One page's worth of display lines. */
const page1 = (src: string): DisplayLine[] => pages(src)[0] ?? [];
/** The emitted body split into per-page markup. */
const sheetsOf = (out: string): string[] => out.split(/(?=<div class="page)/).slice(1);

test('cover pages: the cover class, no furniture, and a folio that counts BODY pages only', () => {
  const out = pagesToHtml(
    [
      { lines: page1('表紙'), cover: true },
      { lines: page1('扉'), cover: true },
      { lines: page1('本文一') },
      { lines: page1('本文二') },
    ],
    undefined,
    FURNISHED,
  );
  const parts = sheetsOf(out);
  assert.equal(parts.length, 4);
  // data-page is the DOM ordinal over ALL sheets…
  assert.ok(parts[0]?.startsWith('<div class="page cover" data-page="0">'));
  assert.ok(parts[1]?.startsWith('<div class="page cover" data-page="1">'));
  assert.ok(parts[2]?.startsWith('<div class="page" data-page="2">'));
  assert.ok(parts[3]?.startsWith('<div class="page" data-page="3">'));
  // …while the folio numbers the body alone, page 1 first and odd (so 'rightLeft' starts right).
  for (const cover of [parts[0], parts[1]]) {
    assert.ok(cover !== undefined && !cover.includes('class="pn') && !cover.includes('class="hd'));
  }
  assert.match(parts[2] ?? '', /<div class="hd">柱<\/div><div class="pn r">1 \/ 2<\/div>/);
  assert.match(parts[3] ?? '', /<div class="hd">柱<\/div><div class="pn l">2 \/ 2<\/div>/);
});

test('cover pages: a cover-less document emits exactly what it always did', () => {
  // Pinned literally: comparing two liftings of the same pages would hold for any impl.
  const plain = paginate(buildRows(tokenize('前\n［＃改ページ］\n後')), 40, 34, 'none');
  assert.equal(
    pagesToHtml(sheets(plain), undefined, FURNISHED),
    '<div class="book">' +
      '<div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">前</div>' +
      '</div><div class="hd">柱</div><div class="pn r">1 / 2</div></div>' +
      '<div class="page" data-page="1"><div class="grid"><div class="line" data-line="2">後</div>' +
      '</div><div class="hd">柱</div><div class="pn l">2 / 2</div></div>' +
      '</div>',
  );
});

test('値の表示: a postfix after a value field is left unjudged (the scan is bookless)', () => {
  const targets = (src: string): string[] => findPostfixTargetIssues(src).map((i) => i.target);
  // Targeting the REAL value builds correctly, so a warning here would flag working markup.
  assert.deepEqual(targets('［＃ここに「タイトル」の値を表示］［＃「作品名」は大見出し］'), []);
  // …scoped: a value field excuses neither an earlier postfix nor a later line.
  assert.deepEqual(targets('です［＃「ですす」に傍点］［＃ここに「タイトル」の値を表示］'), ['ですす']);
  assert.deepEqual(targets('［＃ここに「タイトル」の値を表示］\nです［＃「ですす」に傍点］'), ['ですす']);
  assert.deepEqual(targets('です［＃「ですす」に傍点］'), ['ですす']);
});
