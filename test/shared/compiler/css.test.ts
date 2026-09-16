import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BuildChrome, PreviewChrome } from '../../../src/shared/compiler/chrome.ts';
import { DEFAULT_FONT_STACK, reflowStylesheet, stylesheet } from '../../../src/shared/compiler/css.ts';
import type { PaperOrientation, PaperSize } from '../../../src/shared/compiler/geometry.ts';
import { EDGE_INSET, FOOTER_BAND, HEADER_BAND, LINENUM_BAND, SIDE_PAD, fitPaper } from '../../../src/shared/compiler/geometry.ts';
import type { LinePitch } from '../../../src/shared/config/types.ts';
import { LINE_PITCHES } from '../../../src/shared/config/types.ts';

/**
 * The single 80%-alpha edge recipe (base-INDEPENDENT — the base colour rides the `--edge`
 * variable, asserted separately on the `:root` block).
 */
const EDGE_MIX = 'color-mix(in srgb,var(--edge) 80%,transparent)';
/** A match pattern: raw regex source with the escaped recipe appended. */
const edgeMixRe = (raw: string): RegExp => new RegExp(raw + EDGE_MIX.replace(/[()]/g, '\\$&'));
/** The inter-column rules: css.ts edgeRules() — one 1px background layer per interior column
 *  boundary, each an independent `right calc(k*pitch)` offset (em in build, rem in preview;
 *  the no-repeating-gradient ruling lives on edgeRules). */
const EDGE_RULES = (selector: string, u: 'em' | 'rem', linesPerPage = 34): string => {
  const images: string[] = [];
  const positions: string[] = [];
  for (let k = 1; k < linesPerPage; k++) {
    images.push(`linear-gradient(${EDGE_MIX},${EDGE_MIX})`);
    positions.push(`right calc(${String(k)}*var(--pitch)*1${u} - 1px) top`);
  }
  return `${selector}{background-image:${images.join(',')};` +
    `background-position:${positions.join(',')};` +
    'background-size:1px 100%;background-repeat:no-repeat;}';
};

const PREVIEW_OFF: PreviewChrome = { lineNumbers: false, edgeLine: 'none' };
const BUILD_OFF: BuildChrome = {
  lineNumbers: false,
  edgeLine: 'none',
  footerAlign: 'none',
  footer: '［＃ここに「ページ番号」の値を表示］',
  header: '',
};

/** Preview stylesheet with explicit resolved options (the compiler has no defaults). */
function preview(
  o: {
    charsPerLine?: number;
    linesPerPage?: number;
    linePitch?: LinePitch;
    fontFamily?: string;
    chrome?: PreviewChrome;
    usedClasses?: readonly string[];
  } = {},
): string {
  return stylesheet({
    paginate: false,
    charsPerLine: o.charsPerLine ?? 40,
    linesPerPage: o.linesPerPage ?? 34,
    linePitch: o.linePitch ?? 2,
    fontFamily: o.fontFamily ?? '',
    chrome: o.chrome ?? PREVIEW_OFF,
    usedClasses: o.usedClasses ?? [],
  });
}

/** Build stylesheet with explicit resolved options (the compiler has no defaults). */
function build(
  o: {
    charsPerLine?: number;
    linesPerPage?: number;
    linePitch?: LinePitch;
    paperSize?: PaperSize;
    paperOrientation?: PaperOrientation;
    fontFamily?: string;
    chrome?: BuildChrome;
    usedClasses?: readonly string[];
  } = {},
): string {
  return stylesheet({
    paginate: true,
    charsPerLine: o.charsPerLine ?? 40,
    linesPerPage: o.linesPerPage ?? 34,
    linePitch: o.linePitch ?? 2,
    paperSize: o.paperSize ?? 'a4',
    paperOrientation: o.paperOrientation ?? 'auto',
    fontFamily: o.fontFamily ?? '',
    chrome: o.chrome ?? BUILD_OFF,
    usedClasses: o.usedClasses ?? [],
  });
}

/**
 * The paper-rule strings css.ts must emit for these build inputs, computed from the same
 * fitPaper the stylesheet consults (the geometry constants are tuning knobs — no values
 * written out here). These lock the input routing (the hTop band composition, the paper
 * pick) and the emission format, down to the border-width slot order (top, block, bottom,
 * block).
 */
function paperStrings(o: {
  charsPerLine?: number;
  linesPerPage?: number;
  linePitch?: LinePitch;
  paperSize?: PaperSize;
  paperOrientation?: PaperOrientation;
  lineNumbers?: boolean;
} = {}): { page: string; font: string; border: string; shave: string } {
  const fit = fitPaper({
    charsPerLine: o.charsPerLine ?? 40,
    linesPerPage: o.linesPerPage ?? 34,
    linePitch: o.linePitch ?? 2,
    hTop: HEADER_BAND + (o.lineNumbers ? LINENUM_BAND : 0),
    size: o.paperSize ?? 'a4',
    orientation: o.paperOrientation ?? 'auto',
  });
  const block = fit.insetBlockEm.toFixed(2);
  return {
    page: `@page{size:${String(fit.widthMm)}mm ${String(fit.heightMm)}mm;margin:0;}`,
    font: `html{font-size:${fit.fontMm.toFixed(3)}mm;}`,
    border: `.page{border:solid #fff;border-width:${fit.insetTopEm.toFixed(2)}em ${block}em ` +
      `${fit.insetBottomEm.toFixed(2)}em ${block}em;}`,
    // WebKit-only bottom-border shave (WebKit floors its page height) — see css.ts.
    shave: `@media print{@supports (font:-apple-system-body){.page{border-bottom-width:calc(${fit.insetBottomEm.toFixed(2)}em - 4px);}}}`,
  };
}

const numRe = (n: number): string => String(n).replace('.', String.raw`\.`);
/** `:root{…--htop:N…}` — the band total comes from the tunable constants, never a literal. */
const htopRe = (bands: number): RegExp => new RegExp(String.raw`:root\{[^}]*--htop:` + numRe(bands) + '[;}]');
/** `.page{…padding:calc(var(--htop)*1em) Sem Fem Sem…}` — the band double-homes (footer band bottom, side pads), values from the TS side. */
const footerPadRe = new RegExp(
  String.raw`\.page\{[^}]*padding:calc\(var\(--htop\)\*1em\) ` + numRe(SIDE_PAD) + 'em ' + numRe(FOOTER_BAND) + 'em ' + numRe(SIDE_PAD) + 'em',
);
/** The outset frame's inset run: EDGE_INSET off the band tops, SIDE_PAD on the sides. */
const FRAME_INSETS = `top:calc(var(--htop)*1em - ${String(EDGE_INSET)}em);right:${String(SIDE_PAD)}em;` +
  `bottom:${String(FOOTER_BAND - EDGE_INSET)}em;left:${String(SIDE_PAD)}em`;
/** The fit-to-viewport font-size formula — its constant term is 2 × EDGE_INSET. */
const fitFormulaRe = new RegExp(
  String.raw`html\{[^}]*font-size:calc\(\(100vh - 32px\) \/ \(var\(--cpl\) \+ ` + numRe(2 * EDGE_INSET) + String.raw`\)\)`,
);

test('stylesheet renders vertical-rl writing mode', () => {
  assert.match(preview(), /writing-mode:vertical-rl/);
});

test('paginated stylesheet sizes the page grid + fits the paper', () => {
  // vertical-rl: the static calc() geometry reads the :root variables (page block = lpp ×
  // pitch columns; page inline = cpl × 1em chars); the paper rules stay TS-computed
  // (var() is not portable inside @page). 25 > 30/2 → auto picks landscape A4.
  const css = build({ charsPerLine: 30, linesPerPage: 25 });
  assert.match(css, /\.page\{[^}]*height:calc\(var\(--cpl\)\*1em\)/);
  assert.match(css, /\.page\{[^}]*width:calc\(var\(--lpp\)\*var\(--pitch\)\*1em\)/);
  assert.match(css, /:root\{[^}]*--cpl:30/);
  assert.match(css, /:root\{[^}]*--pitch:2[;}]/);
  assert.match(css, /:root\{[^}]*--lpp:25/);
  // The smaller grid scales UP onto the same paper — expected strings from the same fit.
  const paper = paperStrings({ charsPerLine: 30, linesPerPage: 25 });
  assert.ok(css.includes(paper.page));
  assert.ok(css.includes(paper.font));
  assert.ok(css.includes(paper.border));
  // WebKit alone gets the bottom-border shave; no size container anywhere — it breaks WebKit's
  // forced page breaks and shifts Chromium's pagination.
  assert.ok(css.includes(paper.shave));
  assert.doesNotMatch(css, /container-type/);
});

test('paginated stylesheet breaks each .page onto its own sheet', () => {
  const css = build();
  assert.match(css, /\.page\{[^}]*break-after:page/);
  assert.match(css, /\.page\{[^}]*page-break-after:always/);
  assert.match(css, /\.page\{[^}]*break-inside:avoid/);
});

test('paginated stylesheet keeps the root and the sheets horizontal; only the inner grid is vertical', () => {
  // A vertical-rl root prints blank in WebKit (sheets laid out into negative x) and a
  // vertical-rl sheet splits onto two papers in Chromium, so only the .grid is vertical (#65).
  const css = build();
  assert.doesNotMatch(css, /\.page\{[^}]*writing-mode/);
  assert.doesNotMatch(css, /@media print\{html\{[^}]*writing-mode/);
  assert.match(css, /\.grid\{writing-mode:vertical-rl;width:100%;height:100%;\}/);
});

test('non-paginated (preview) stylesheet makes .pagebreak a labelled rule, no @page', () => {
  const css = preview();
  assert.doesNotMatch(css, /@page/);
  assert.doesNotMatch(css, /break-before:page/);
  assert.match(css, /\.pagebreak\{[^}]*border-block-start/);
  // The 「改ページ」 label styling is always present (the marker DOM always carries it).
  assert.match(css, /\.pb-label\{[^}]*writing-mode:vertical-rl/);
});

test('non-paginated (preview) stylesheet emits no width cap (JS hard-wraps)', () => {
  // Line wrapping lives in the layout engine, so the preview CSS must NOT emit an inline-size
  // cap — it would double-constrain the already-wrapped .line columns.
  const css = preview({ charsPerLine: 24 });
  assert.doesNotMatch(css, /inline-size/);
});

test('non-paginated (preview) stylesheet fits the root font-size to the viewport', () => {
  // In vertical-rl a full-width char advances exactly 1em along the column, so root
  // font-size = (100vh − 2·16px padding) / (charsPerLine + 2·EDGE_INSET) makes a full
  // line plus the always-reserved frame gaps fill the pane height. `.line` re-pins to
  // that root (1rem) so a webview-injected body{font-size} can't desync the glyph
  // advance from the em-based pitch.
  const css = preview({ charsPerLine: 25 });
  assert.match(css, fitFormulaRe);
  assert.ok(css.includes(`:root{--cpl:25;--pitch:2;--font-family:${DEFAULT_FONT_STACK}}`));
  assert.match(css, /\.line\{[^}]*font-size:1rem/);
});

test('preview fit formula at the standard 40 chars per line pads the columns', () => {
  const css = preview();
  assert.match(css, fitFormulaRe);
  assert.ok(css.includes(`:root{--cpl:40;--pitch:2;--font-family:${DEFAULT_FONT_STACK}}`));
  // The padding the formula subtracts (top/bottom = inline axis in vertical-rl).
  assert.match(css, /body\{[^}]*padding-inline:16px/);
  // The matching text inset the denominator pays for — reserved with or without a frame.
  assert.match(css, /\.segment\{position:relative;padding-inline:0\.35rem;\}/);
});

test('--font-family: blank setting falls back to the built-in 明朝 stack in both media', () => {
  // The named-JP-first stack is what keeps shared codepoints (… ‥ quotes) off Latin serif
  // fonts — a bare generic `serif` stops per-codepoint fallback before any JP font.
  const expected = `--font-family:${DEFAULT_FONT_STACK}}`;
  assert.ok(preview().includes(expected));
  assert.ok(build().includes(expected));
  assert.match(preview(), /html\{[^}]*font-family:var\(--font-family\)/);
  assert.match(build(), /html\{font-family:var\(--font-family\);\}/);
  // EPUB is reader-controlled: the reflow sheet never carries the variable.
  assert.doesNotMatch(reflowStylesheet('relaxed', []), /--font-family/);
});

test('--font-family: a custom stack passes through; breakout tokens are stripped', () => {
  const css = preview({ fontFamily: '"游明朝", YuMincho, serif' });
  assert.ok(css.includes('--font-family:"游明朝", YuMincho, serif}'));
  // `;` `{` `}` `<` `>` `\` and `/*` cannot leave the declaration or the one <style> block.
  const dirty = preview({ fontFamily: 'serif;}</style><script>/*' });
  assert.ok(dirty.includes('--font-family:serif/stylescript}'));
  // Whitespace-only means blank: the built-in stack, never an empty declaration.
  assert.ok(preview({ fontFamily: '  ' }).includes(`--font-family:${DEFAULT_FONT_STACK}}`));
});

test('stylesheet emits ONLY the requested class rules (on-demand)', () => {
  const cases: [string, string][] = [
    ['preview', preview({ usedClasses: ['emph-fs', 'emph-x-l'] })],
    ['build', build({ usedClasses: ['emph-fs', 'emph-x-l'] })],
  ];
  for (const [label, css] of cases) {
    assert.match(css, /\.emph-fs\{text-emphasis-style:filled sesame\}/, label);
    assert.match(
      css,
      /\.emph-x-l\{text-emphasis-style:'×';text-emphasis-position:under left\}/,
      label,
    );
    // A variant that was not requested gets no rule.
    assert.doesNotMatch(css, /\.emph-ot\b/, label);
  }
});

test('stylesheet emits NO .emph- rule when no classes are requested', () => {
  assert.doesNotMatch(preview(), /\.emph-/);
  assert.doesNotMatch(build(), /\.emph-/);
});

test('stylesheet preserves the caller-provided (lexicographic) rule order', () => {
  // The renderers pass classes pre-sorted by class name (not spec order); stylesheet emits
  // them in that order verbatim.
  const css = preview({ usedClasses: ['emph-fs', 'emph-ot'] });
  assert.ok(css.indexOf('.emph-fs{') < css.indexOf('.emph-ot{'));
});

test('字下げ padding is inline-start, never block-start (axis lock)', () => {
  // vertical-rl: the inline axis runs down the column, so the indent pushes the first glyph
  // DOWN via padding-inline-start. padding-block-start would shove the whole column sideways.
  const css = preview({ usedClasses: ['indent-3'] });
  assert.match(css, /\.indent-3\{padding-inline-start:3em\}/);
  assert.doesNotMatch(css, /padding-block-start/);
});

test('base fill rules stay untouched by decoration/indent classes', () => {
  const p = build({ usedClasses: ['dec-wavy', 'b', 'i', 'indent-5'] });
  assert.match(p, /\.line\{block-size:calc\(var\(--pitch\)\*1em\);margin:0;white-space:pre;\}/);
  assert.match(p, /@page\{size:297mm 210mm;margin:0;\}/); // 34 > 40/2 → auto lands on landscape A4
  const v = preview({ usedClasses: ['indent-5'] });
  assert.match(v, /html\{[^}]*font-size:calc\(\(100vh - 32px\) \/ \(var\(--cpl\) \+ 0\.7\)\)/);
  assert.ok(v.includes(`:root{--cpl:40;--pitch:2;--font-family:${DEFAULT_FONT_STACK}}`));
  assert.match(v, /\.line\{[^}]*block-size:calc\(var\(--pitch\)\*1em\)[^}]*font-size:1rem/);
});

test('傍線 rules carry an explicit text-underline-position (right default / left variant)', () => {
  const css = preview({ usedClasses: ['dec-solid', 'dec-wavy-l'] });
  assert.match(
    css,
    /\.dec-solid\{text-decoration-line:underline;text-decoration-style:solid;text-underline-position:right\}/,
  );
  assert.match(
    css,
    /\.dec-wavy-l\{text-decoration-line:underline;text-decoration-style:wavy;text-underline-position:left\}/,
  );
});

test('太字/斜体 rules come through classRule → styleRule forwarding', () => {
  const css = preview({ usedClasses: ['b', 'i'] });
  assert.match(css, /\.b\{font-weight:bold\}/);
  assert.match(css, /\.i\{font-style:italic\}/);
});

test('縦中横 .tcy rule is on-demand and identical in both media', () => {
  // Legacy spellings first, standard last (wins where both are known) — the EPUB reading
  // systems that need -epub-/-webkit- share this one fragment.
  const rule = '.tcy{-webkit-text-combine:horizontal;-epub-text-combine:horizontal;text-combine-upright:all}';
  assert.ok(preview({ usedClasses: ['tcy'] }).includes(rule));
  assert.ok(build({ usedClasses: ['tcy'] }).includes(rule));
  assert.doesNotMatch(preview(), /\.tcy\b/); // zero dead rules
  assert.doesNotMatch(build(), /\.tcy\b/);
});

test('見出し .midashi rule is on-demand and identical in both media', () => {
  const rule = '.midashi{font-family:sans-serif;font-weight:bold}';
  assert.ok(preview({ usedClasses: ['midashi'] }).includes(rule));
  assert.ok(build({ usedClasses: ['midashi'] }).includes(rule));
  assert.doesNotMatch(preview(), /\.midashi\b/); // zero dead rules
  assert.doesNotMatch(build(), /\.midashi\b/);
});

test('ruby rr/lr/br rule sets are on-demand, self-contained and media-identical', () => {
  for (const make of [preview, build]) {
    // rr: the right-only lane every plain ruby uses.
    const rr = make({ usedClasses: ['rr'] });
    assert.match(
      rr,
      /ruby\.rr\{display:inline-flex;flex-direction:row;justify-content:space-around;position:relative\}/,
    );
    assert.match(rr, /ruby\.rr>rt\{display:contents;font-size:inherit\}/);
    assert.match(rr, /ruby\.rr>rt>span\{transform:translate\(-50%,-50%\) translateX\(1\.5em\)\}/);
    assert.doesNotMatch(rr, /ruby\.(lr|br)/);
    const lr = make({ usedClasses: ['lr'] });
    // The ruby box itself distributes its base spans (stretches with rh-N like native ruby).
    assert.match(
      lr,
      /ruby\.lr\{display:inline-flex;flex-direction:row;justify-content:space-around;position:relative\}/,
    );
    // The <rt> is a box-less shell at the ruby's own size (undoing the UA's rt{font-size:50%})…
    assert.match(lr, /ruby\.lr>rt\{display:contents;font-size:inherit\}/);
    // …whose span is the centre-anchored, box-extent lane distributing its reading spans
    // (native ruby-align).
    assert.match(
      lr,
      /ruby\.lr>rt>span\{position:absolute;top:50%;left:50%;min-height:100%;display:flex;flex-direction:row;justify-content:space-around;writing-mode:vertical-rl;font-size:0\.5em;line-height:1;white-space:nowrap\}/,
    );
    assert.match(lr, /ruby\.lr>rt>span\{transform:translate\(-50%,-50%\) translateX\(-1\.5em\)\}/);
    assert.doesNotMatch(lr, /ruby\.br/); // only the requested set
    const br = make({ usedClasses: ['br'] });
    assert.match(br, /ruby\.br>rt\{display:contents;font-size:inherit\}/);
    assert.match(br, /ruby\.br>rt>span\{transform:translate\(-50%,-50%\) translateX\(1\.5em\)\}/); // right lane
    assert.match(br, /ruby\.br>rt\.rt-l>span\{transform:translate\(-50%,-50%\) translateX\(-1\.5em\)\}/); // left lane
    assert.doesNotMatch(br, /ruby\.lr/);
    assert.doesNotMatch(make(), /ruby\.(rr|lr|br)/); // zero dead rules
    // The stretched-ruby min-height family is on-demand too, like indent-N.
    assert.match(make({ usedClasses: ['rh-23'] }), /\.rh-23\{min-height:23em\}/);
    assert.doesNotMatch(make(), /\.rh-/);
  }
});

test('no rule positions, floats or transforms an <rt> itself (WebKit forces rt to static)', () => {
  // WebKit's StyleAdjuster sets position:static / float:none on every <rt> by tag name, so a
  // positioned <rt> silently joins the flow in Safari (#65): the lane box must be rt>span.
  for (const make of [preview, build]) {
    const css = make({ usedClasses: ['rr', 'lr', 'br', 'rh-2'] });
    assert.doesNotMatch(css, /[\s,}>]rt(\.[\w-]+)?\{[^}]*(position|float|transform):/);
    assert.match(css, /ruby\.rr>rt\{display:contents;font-size:inherit\}/);
  }
});

test('傍点 .emr counter-shift is on-demand, probe-driven with a closed-form fallback', () => {
  for (const make of [preview, build]) {
    assert.match(
      make({ usedClasses: ['emr'] }),
      /\.emr\{translate:var\(--emr-shift,max\(0em,\(2 - var\(--pitch\)\)\*0\.5em\)\) 0\}/,
    );
    assert.doesNotMatch(make(), /\.emr\{/);
  }
});

test('reflow ruby.ru rule is native ruby-position (under + nested-over reset), on demand', () => {
  const css = reflowStylesheet('relaxed', ['ru']);
  assert.match(
    css,
    /ruby\.ru\{-epub-ruby-position:under;-webkit-ruby-position:after;ruby-position:under\}/,
  );
  assert.match(
    css,
    /ruby\.ru>ruby\{-epub-ruby-position:over;-webkit-ruby-position:before;ruby-position:over\}/,
  );
  assert.doesNotMatch(reflowStylesheet('relaxed', []), /ruby\.ru/);
});

test('.indent-N rules generate on demand; malformed suffixes are ignored', () => {
  const css = preview({ usedClasses: ['indent-2', 'indent-10'] });
  assert.match(css, /\.indent-2\{padding-inline-start:2em\}/);
  assert.match(css, /\.indent-10\{padding-inline-start:10em\}/);
  assert.doesNotMatch(
    preview({ usedClasses: ['indent-', 'indent-0', 'indent-x'] }),
    /padding-inline-start/,
  );
});

// --- edge-rule colour policy -------------------------------------------------

test('edgeLine → --edge base: red/text inject the base colour, none injects nothing at all', () => {
  // The 80%-alpha recipe lives once in the edge fragments; the :root variable carries ONLY
  // the base. 'none' must leave no trace — no variable, no edge fragment (zero dead rules).
  assert.match(preview({ chrome: { lineNumbers: false, edgeLine: 'red' } }), /:root\{[^}]*--edge:#cc0000\}/);
  assert.match(
    preview({ chrome: { lineNumbers: false, edgeLine: 'text' } }),
    /:root\{[^}]*--edge:currentColor\}/,
  );
  assert.match(build({ chrome: { ...BUILD_OFF, edgeLine: 'red' } }), /:root\{[^}]*--edge:#cc0000\}/);
  assert.doesNotMatch(preview(), /--edge/);
  assert.doesNotMatch(build(), /--edge/);
});

// --- preview chrome ----------------------------------------------------------

test('preview line numbers: fixed-px out-of-flow .ln rule (numbers are JS-emitted spans)', () => {
  const css = preview({ chrome: { lineNumbers: true, edgeLine: 'none' } });
  assert.match(css, /\.line\{position:relative;\}/);
  assert.match(css, /\.ln\{position:absolute/);
  assert.match(css, /\.ln\{[^}]*font-size:10px/); // fixed px — fill invariant
  // Lifted into the pad band, past the text inset (the rem term cancels the em inset at
  // any fit size) and 2px clear of where the frame line would sit — the SAME spot
  // whether edgeLine is on or off.
  assert.match(css, /\.ln\{[^}]*translateY\(calc\(-100% - 0\.35rem - 2px\)\)/);
  // No CSS counters: a sibling counter-reset does not reset following siblings in Chromium.
  assert.doesNotMatch(css, /counter/);
  assert.doesNotMatch(css, /::after/); // no edge rules leak into the lineNumbers-only sheet
});

test('preview edge: frame + full-page background rules on the shared pitch', () => {
  const red = preview({ chrome: { lineNumbers: false, edgeLine: 'red' } });
  assert.match(red, /\.line\{position:relative;\}/); // paint order: text above the frame pseudo
  // The rules ride the frame's own background — independent of the .line count.
  assert.ok(red.includes(EDGE_RULES('.segment::before', 'rem')));
  assert.match(red, edgeMixRe(String.raw`\.segment::before\{[^}]*border:1px solid `));
  assert.match(red, /:root\{[^}]*--edge:#cc0000\}/); // the recipe's base colour rides --edge
  assert.doesNotMatch(red, /::after/);
  assert.doesNotMatch(red, /border-left|border-right/);
  // While the frame is drawn, a segment reserves the full linesPerPage page width; the
  // --lpp it reads is gated in WITH the edge variables (none ⇒ neither appears).
  assert.match(red, /\.segment\{min-block-size:calc\(var\(--lpp\)\*var\(--pitch\)\*1rem\);\}/);
  assert.match(red, /:root\{[^}]*--lpp:34;--edge:#cc0000\}/);
  // The frame is full-band-high and starts at top:0 (containing block = the segment band).
  assert.match(red, /\.segment::before\{[^}]*top:0;[^}]*height:calc\(100vh - 32px\)/);
  assert.match(red, /\.segment\{position:relative;padding-inline:0\.35rem;\}/);
  assert.doesNotMatch(red, /\.book/); // the frame is per-segment, never one around .book
  // The pitch is the SAME --pitch value with rules on or off (uniform-layout contract):
  // the .line sizing and the 罫線 period read the one variable.
  assert.match(red, /html\{[^}]*line-height:var\(--pitch\)/);
  assert.match(red, /\.line\{[^}]*block-size:calc\(var\(--pitch\)\*1em\)/);
  const text = preview({ chrome: { lineNumbers: false, edgeLine: 'text' } });
  assert.ok(text.includes(EDGE_RULES('.segment::before', 'rem')));
  assert.match(text, edgeMixRe(String.raw`\.segment::before\{[^}]*border:1px solid `));
  assert.match(text, /:root\{[^}]*--edge:currentColor\}/);
  // Rules off ⇒ the SAME pitch — toggling edgeLine never moves a glyph within its segment
  // (the frame look also reserves the full page extent for short segments).
  assert.match(preview(), /html\{[^}]*line-height:var\(--pitch\)/);
});

test('preview all-off chrome emits no .ln rule, no edge rules, no frame', () => {
  const css = preview();
  assert.doesNotMatch(css, /\.ln\{/);
  assert.doesNotMatch(css, /::after/);
  assert.doesNotMatch(css, /\.segment::before/); // no frame is drawn…
  // …but the text inset stays reserved, so turning a frame on moves nothing.
  assert.match(css, /\.segment\{position:relative;padding-inline:0\.35rem;\}/);
  // Zero dead payload: the frame's page extent (and its --lpp) rides ONLY the edge fragment.
  assert.doesNotMatch(css, /--lpp|min-block-size|linear-gradient/);
  assert.doesNotMatch(css, /counter/);
  assert.match(css, /\.pb-label\{/); // the page-break label is unconditional
});

test('preview: the 改ページ dashed rule overshoots the writing band into the pads', () => {
  // Negative inline margins stretch the auto-sized marker 8px (half the pad) past the
  // band on each side, independent of edgeLine — the break outranks frame and text alike.
  const css = preview();
  assert.match(css, /\.pagebreak\{[^}]*border-block-start:2px dashed currentColor/);
  assert.match(css, /\.pagebreak\{[^}]*margin-block:1em/);
  assert.match(css, /\.pagebreak\{[^}]*margin-inline:-8px/);
});

// --- build chrome ------------------------------------------------------------

const BUILD_ON: BuildChrome = {
  lineNumbers: true,
  edgeLine: 'text',
  footerAlign: 'rightLeft',
  footer: '［＃ここに「ページ番号」の値を表示］',
  header: '章',
};

test('build all-on chrome: bands, outset frame, counters, rules, furniture styles', () => {
  const css = build({ chrome: BUILD_ON });
  // Bands: header 2.5 + line numbers 1 on top (--htop), footer 2.5 at the bottom (static).
  assert.match(css, /\.page\{[^}]*padding:calc\(var\(--htop\)\*1em\) /);
  assert.match(css, htopRe(HEADER_BAND + LINENUM_BAND)); // header band + line-number band
  assert.match(css, footerPadRe);
  assert.match(css, /\.page\{[^}]*position:relative/);
  assert.match(css, /\.page\{[^}]*counter-reset:ln/); // per-page numbering
  // The frame floats EDGE_INSET off the text grid, into the bands (chrome renders
  // OUTSIDE it), and matches the rule colour.
  assert.ok(css.includes(FRAME_INSETS), 'frame insets must track the band constants');
  assert.match(css, edgeMixRe(String.raw`\.page::before\{[^}]*border:1px solid `));
  assert.match(css, /:root\{[^}]*--edge:currentColor\}/);
  // The sheet box draws no VISIBLE border — the frame lives on ::before; the only .page
  // border is the invisible white paper inset from the paper rules.
  assert.doesNotMatch(css, /\.page\{[^}]*border:1px/);
  assert.match(css, /\.page\{border:solid #fff;/);
  // The pitch is the same --pitch value with rules on or off (uniform-layout contract).
  assert.match(css, /\.page\{[^}]*line-height:var\(--pitch\)/);
  assert.match(css, /\.page\{[^}]*width:calc\(var\(--lpp\)\*var\(--pitch\)\*1em\)/);
  assert.match(css, /:root\{[^}]*--pitch:2[;}]/);
  assert.match(css, /:root\{[^}]*--lpp:34/);
  assert.match(css, /\.line\{[^}]*block-size:calc\(var\(--pitch\)\*1em\)/);
  // 罫線 ride the frame's own background (full page extent, independent of the .line count);
  // print-color-adjust keeps them in print/PDF (borders print, backgrounds are omitted).
  assert.ok(css.includes(EDGE_RULES('.page::before', 'em')));
  assert.match(css, /\.page::before\{[^}]*-webkit-print-color-adjust:exact;print-color-adjust:exact/);
  assert.doesNotMatch(css, /::after/);
  assert.doesNotMatch(css, /\.line[^{]*\{[^}]*box-shadow/);
  assert.match(css, /\.line\{counter-increment:ln;\}/);
  assert.match(css, /\.line\{position:relative;\}/);
  assert.match(css, /\.line::before\{content:counter\(ln\)/);
  // The number lifts an extra EDGE_INSET in rem (its own em is halved by font-size:0.5em)
  // so it clears the outset frame; line-height:1 keeps it inside the line-number band.
  assert.match(css, new RegExp(String.raw`\.line::before\{[^}]*translateY\(calc\(-100% - ` + numRe(EDGE_INSET) + String.raw`rem\)\)`));
  assert.match(css, /\.line::before\{[^}]*line-height:1;/);
  // The furniture sits flush against the paper margin (the MARGIN_MM white stays
  // furniture-free) in smaller-than-body type — .hd top:0 mirrors .ft bottom:0.
  assert.match(css, /\.hd\{position:absolute;top:0;left:0;right:0/);
  assert.match(css, /\.hd\{[^}]*font-size:0\.\d+em;/);
  assert.match(css, /\.hd\{[^}]*line-height:1;/);
  assert.match(css, /\.ft\{position:absolute;bottom:0/);
  assert.match(css, /\.ft\{[^}]*font-size:0\.\d+em;/);
  assert.match(css, /\.ft\{[^}]*line-height:1;/);
  assert.ok(css.includes(`.ft.r{right:${String(SIDE_PAD + EDGE_INSET)}em;}`));
  assert.ok(css.includes(`.ft.l{left:${String(SIDE_PAD + EDGE_INSET)}em;}`));
  // The line-number band widens the sheet, which the fit absorbs in the paper insets —
  // expected strings computed with the band on.
  const paper = paperStrings({ lineNumbers: true });
  assert.ok(css.includes(paper.page));
  assert.ok(css.includes(paper.border));
});

test('build all-off chrome keeps a plain sheet with the reserved bands, no chrome rules', () => {
  const css = build();
  // Header and footer bands are reserved even with no furniture; edgeLine 'none' draws NO
  // frame at all (same semantics as the preview) — and the sheet lays out identically.
  assert.doesNotMatch(css, /\.page::before/);
  assert.doesNotMatch(css, /#444/); // no hard-coded grey — rule colours derive from the edge base (.ft is off here)
  assert.match(css, /\.page\{[^}]*padding:calc\(var\(--htop\)\*1em\) /);
  assert.match(css, htopRe(HEADER_BAND)); // header band only — no line-number band
  assert.match(css, footerPadRe);
  assert.match(css, /\.page\{[^}]*line-height:var\(--pitch\)/); // the SAME pitch without edge rules
  // The paper rules: 投稿書式 40×34 on auto-landscape A4 — exact mm @page, the root font
  // that scales the em sheet onto it, and the sheet→paper insets as a white border
  // (physical T R B L; the bottom leads the top by the MARGIN_MM floor bias). Strings
  // computed from the same fit, so tuning the geometry constants never stales them.
  const paper = paperStrings();
  assert.ok(css.includes(paper.page));
  assert.ok(css.includes(paper.font));
  assert.ok(css.includes(paper.border));
  // The screen-only paper look (grey backdrop + paper shadow + the cosmetic 2.5em gap)
  // is chrome-independent — present even with every feature off — and print resets it.
  assert.match(css, /@media screen\{html\{background:#e8e8e8;\}\.page\{box-shadow:0 1px 4px rgba\(0,0,0,0\.25\);\}\}/);
  assert.match(css, /\.page\{[^}]*margin:2\.5em auto/);
  // Print keeps sheets one-per-page: vertical margins ZERO (the border box already IS the
  // paper), horizontal auto centring the rounding slack. @page margins stay 0 so the
  // browser's own header/footer (its page numbers, URL, date) has nowhere to render.
  assert.match(css, /@media print\{html\{background:none;\}\.page\{margin:0 auto;box-shadow:none;\}\}/);
  assert.doesNotMatch(css, /\.line[^{]*\{[^}]*box-shadow/);
  assert.doesNotMatch(css, /::after/); // no inter-column rules without edge lines
  assert.doesNotMatch(css, /counter/);
  assert.doesNotMatch(css, /\.hd\{|\.ft\{/);
});

test('build red edge lines colour both the frame and the inter-column rules', () => {
  const css = build({ chrome: { ...BUILD_OFF, edgeLine: 'red' } });
  assert.match(css, edgeMixRe(String.raw`\.page::before\{[^}]*border:1px solid `));
  assert.match(css, /:root\{[^}]*--edge:#cc0000\}/);
  // No line-number band here, so the frame floats EDGE_INSET off the header band.
  assert.ok(css.includes(FRAME_INSETS), 'frame insets must track the band constants');
  assert.match(css, htopRe(HEADER_BAND));
  assert.ok(css.includes(EDGE_RULES('.page::before', 'em')));
  assert.match(css, /\.line\{[^}]*position:relative/); // paint order: text above the frame pseudo
  assert.match(css, /\.line\{[^}]*block-size:calc\(var\(--pitch\)\*1em\)/); // the one --pitch value
});

test('build bands: header/footer bands are constant; only line numbers add geometry', () => {
  // Footer and header furniture change nothing geometric — those bands are always there.
  const paper = paperStrings();
  for (const chrome of [
    BUILD_OFF,
    { ...BUILD_OFF, footerAlign: 'right' as const },
    { ...BUILD_OFF, header: 'X' },
  ]) {
    const css = build({ chrome });
    assert.match(css, htopRe(HEADER_BAND)); // the top band is furniture-independent
    assert.match(css, /\.page\{[^}]*padding:calc\(var\(--htop\)\*1em\) /);
    assert.match(css, footerPadRe);
    assert.ok(css.includes(paper.page)); // same paper whatever the furniture
    assert.ok(css.includes(paper.font)); // …and the same fit
  }
  const lnOnly = build({ chrome: { ...BUILD_OFF, lineNumbers: true } });
  assert.match(lnOnly, htopRe(HEADER_BAND + LINENUM_BAND)); // header band + line-number band
  assert.match(lnOnly, /\.page\{[^}]*padding:calc\(var\(--htop\)\*1em\) /);
  assert.match(lnOnly, footerPadRe);
});

test('paper settings pick the box: A6, forced orientation, auto portrait', () => {
  // Expected strings from the same fit per case; @page locks the pick (148mm/210mm…).
  const cases = [
    // The default grid on A6 (文庫判) — auto still lands landscape.
    { paperSize: 'a6' as const },
    // Forced portrait turns the paper, not the grid — the surplus goes top/bottom.
    { paperOrientation: 'portrait' as const },
    // A tall grid picks portrait on its own (18 > 40/2 is false).
    { linesPerPage: 18 },
  ];
  for (const c of cases) {
    const css = build(c);
    const paper = paperStrings(c);
    assert.ok(css.includes(paper.page), `${JSON.stringify(c)}: @page`);
    assert.ok(css.includes(paper.font), `${JSON.stringify(c)}: root font`);
    assert.ok(css.includes(paper.border), `${JSON.stringify(c)}: paper border`);
  }
});

test('every linePitch tier rides :root{--pitch}, identical with edge rules on or off', () => {
  // The acceptance contract: one --pitch value per document, injected unconditionally in both
  // media, unchanged by edgeLine (the uniform-layout contract) — the .line sizing, the html/.page
  // line-height and the 罫線 layer offsets all read this one variable.
  for (const linePitch of LINE_PITCHES) {
    const probe = new RegExp(`:root\\{[^}]*--pitch:${String(linePitch).replace('.', '\\.')}[;}]`);
    for (const edgeLine of ['none', 'red'] as const) {
      assert.match(
        preview({ linePitch, chrome: { lineNumbers: false, edgeLine } }),
        probe,
        `preview @${String(linePitch)} edge=${edgeLine}`,
      );
      assert.match(
        build({ linePitch, chrome: { ...BUILD_OFF, edgeLine } }),
        probe,
        `build @${String(linePitch)} edge=${edgeLine}`,
      );
    }
  }
});

test('preview carries no paper rules (screen fit stays viewport-based)', () => {
  // The physical-paper trio (mm font, sheet→paper border) is build-only; the preview keeps
  // its fit-to-viewport root font and borderless segments. @page absence is asserted above.
  const css = preview();
  assert.doesNotMatch(css, /font-size:[\d.]+mm/);
  assert.doesNotMatch(css, /border-width/);
});

test('edgeLine none draws no frame in either medium (preview/build cohesion)', () => {
  assert.doesNotMatch(preview(), /\.segment::before/);
  assert.doesNotMatch(build(), /\.page::before/);
  // …while both keep the text where a frame-bearing sheet puts it: the reserve is
  // unconditional (preview text inset / build grid position), so toggling edgeLine
  // never moves a glyph within its segment/page.
  assert.match(preview(), /\.segment\{position:relative;padding-inline:0\.35rem;\}/);
  assert.match(build(), /\.page\{[^}]*padding:calc\(var\(--htop\)\*1em\) /);
});

test('reflow stylesheet has no geometry, no chrome, no @page — the reading system owns those', () => {
  const css = reflowStylesheet('relaxed', []);
  assert.match(css, /html\{[^}]*writing-mode:vertical-rl\}/);
  assert.ok(css.includes('-epub-writing-mode:vertical-rl'), 'legacy spelling for older readers');
  assert.doesNotMatch(css, /--cpl|--lpp|--pitch|--htop|--edge/);
  assert.doesNotMatch(css, /@page|\.page\b|\.segment\b|\.line\b|\.ln\b|\.hd\b|\.ft\b/);
  assert.doesNotMatch(css, /white-space:pre/); // the reader wraps; pre would defeat it
});

test('reflow kinsoku maps onto the reader line breaker: none→loose, relaxed→normal, strict→strict', () => {
  assert.ok(reflowStylesheet('none', []).includes('body{line-break:loose}'));
  assert.ok(reflowStylesheet('relaxed', []).includes('body{line-break:normal;hanging-punctuation:allow-end}'));
  assert.ok(reflowStylesheet('strict', []).includes('body{line-break:strict;hanging-punctuation:allow-end}'));
  // ぶら下げ mirrors the engine: canHang is active for relaxed+strict, never for none.
  assert.ok(!reflowStylesheet('none', []).includes('hanging-punctuation'));
  // relaxed is no CSS keyword: the map, not the enum value, reaches the sheet.
  assert.doesNotMatch(reflowStylesheet('relaxed', []), /line-break:relaxed/);
});

test('reflow used-class tail rides the same on-demand pipe (insep/tcy/indent/emphasis)', () => {
  const css = reflowStylesheet('strict', ['emph-fs', 'indent-3', 'insep', 'tcy']);
  assert.ok(css.includes('.insep{white-space:nowrap}'));
  assert.ok(css.includes('.indent-3{padding-inline-start:3em}'));
  assert.match(css, /\.tcy\{[^}]*text-combine-upright:all\}/);
  assert.match(css, /\.emph-fs\{/);
  assert.doesNotMatch(reflowStylesheet('strict', []), /\.insep|\.tcy|\.indent-/); // zero dead rules
});
