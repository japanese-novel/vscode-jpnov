/**
 * Assembles the document stylesheet from the static fragments in `styles/*.css` (compiled to
 * strings in `styles.generated.ts` by `scripts/gen-styles.ts`) plus the dynamic residue: the
 * `:root{}` variable block (`--cpl`/`--pitch`/`--lpp`/`--htop`, `--edge`), the BUILD paper
 * rules, the 罫線 layers ({@link edgeRules}) and the on-demand `indent-N` / emphasis class rules.
 * Constraints:
 * - everything is a RULE inside the document's one `<style>`, never a `style=` attribute (the
 *   webview CSP strips those);
 * - the paper rules (`@page` box in mm, root font size, sheet→paper border) are computed in TS
 *   from geometry.ts's fitPaper because `@page` cannot read `var()` portably (the build
 *   artifact must stay portable);
 * - mode and chrome conditionality is FRAGMENT INCLUSION — a disabled feature's selectors are
 *   absent from the output;
 * - in BOTH modes the EDGE_INSET gap is reserved and the pitch is the one `--pitch` value
 *   whether edgeLine is on or off, so toggling it never moves a glyph;
 * - chrome sub-elements (`.ft` / `.hd` / `.ln` / `.line::before`) are horizontal-tb INSIDE a
 *   vertical-rl container and use PHYSICAL positioning properties only.
 * Pure + vscode-free.
 */

import type { KinsokuMode, LinePitch } from '../config/types.ts';
import type { BuildChrome, EdgeLineStyle, PreviewChrome } from './chrome.ts';
import { styleRule } from './emphasis.ts';
import type { PaperFit, PaperOrientation, PaperSize } from './geometry.ts';
import {
  EDGE_RED,
  HEADER_BAND,
  LINENUM_BAND,
  fitPaper,
} from './geometry.ts';
import { EMR_PROBE_JS } from './emrProbe.generated.ts';
import * as S from './styles/styles.generated.ts';

/**
 * The CSS rule for one used class name, or '' for an unknown one (keeps the "no stray rules"
 * invariant). These are layout geometry / line furniture, not style-table entries: `indent-N`
 * (字下げ) and `rh-N` (stretched ruby) are generated here (unbounded N); `tcy` (縦中横), `midashi`
 * (見出し), `hang` (ぶら下げ), `insep` (分離禁止), `emr` (傍点 line compensation) and the ruby
 * classes come from the static `styles/class.*.css` fragments. The indent suffix check is
 * defence in depth (emitLine only ever emits positive N_eff). Every other class
 * (emph-* / dec-* / b / i) is forwarded to emphasis.ts's {@link styleRule}, the single home of
 * the style CSS values.
 */
function classRule(name: string): string {
  if (name.startsWith('indent-')) {
    const n = name.slice('indent-'.length);
    return /^[1-9][0-9]*$/.test(n) ? `.indent-${n}{padding-inline-start:${n}em}` : '';
  }
  if (name.startsWith('rh-')) {
    // Stretched ruby: the box grows to the unit's true advance — the SAME N layout.ts accounts
    // as cells — and the lane flex below spreads the base across it, like native ruby.
    const n = name.slice('rh-'.length);
    return /^[1-9][0-9]*$/.test(n) ? `.rh-${n}{min-height:${n}em}` : '';
  }
  // Static, media-independent class rules, authored as `styles/class.*.css` fragments (each
  // carries its own rationale). Unlike the unbounded `indent-N` / `rh-N` above, these are fixed
  // constants.
  switch (name) {
    case 'tcy':
      return S.classTcy;
    case 'midashi':
      return S.classMidashi;
    case 'hang':
      return S.classHang;
    case 'insep':
      return S.classInsep;
    case 'rr':
      return S.classRubyRr;
    case 'lr':
      return S.classRubyLr;
    case 'br':
      return S.classRubyBr;
    case 'ru':
      return S.classRubyU;
    case 'emr':
      return S.classEmr;
  }
  return styleRule(name);
}

/**
 * Edge BASE colour for `--edge`, or null for 'none' (include no edge fragment, inject no
 * variable). One policy for both media: `red` is the semantic 赤 (EDGE_RED), `text` bases on
 * currentColor — the rules always match the surrounding text (theme foreground in the
 * preview, ink on the build's white sheet). The 80%-alpha `color-mix` recipe lives ONCE in
 * the edge fragments; this picks only the base colour it mixes.
 */
function edgeBase(edge: EdgeLineStyle): string | null {
  switch (edge) {
    case 'none':
      return null;
    case 'red':
      return EDGE_RED;
    case 'text':
      return 'currentColor';
  }
}

/**
 * The built-in 明朝-first stack `--font-family` falls back to when `jpnov.layout.fontFamily`
 * is blank. Named JP families must come FIRST: shared codepoints (… ‥ quotes) exist in Latin
 * serif fonts too, so a bare `serif` stops per-codepoint fallback before any JP font — and a
 * rotated (UAX#50 VO=R) Latin ellipsis then hugs the column edge. macOS → Windows (EN + JA
 * localized names) → Linux Noto, generic serif last.
 */
export const DEFAULT_FONT_STACK =
  '"Hiragino Mincho ProN","Yu Mincho","YuMincho","游明朝","Noto Serif CJK JP","Noto Serif JP",serif';

/**
 * `jpnov.layout.fontFamily` → the `--font-family` value. The raw setting lands inside the
 * document's one `<style>` block, so strip anything that could leave the declaration (`;` `}`),
 * open a tag (`<`), escape (`\`), or comment out the rest of the sheet (`/*`); quotes and
 * commas are legal font-list tokens and pass. Blank → {@link DEFAULT_FONT_STACK}.
 */
function fontFamilyValue(raw: string): string {
  const clean = raw.replace(/\/\*|[;{}<>\\\p{Cc}]/gu, '').trim().slice(0, 256);
  return clean === '' ? DEFAULT_FONT_STACK : clean;
}

/** The `:root{}` dynamic-values rule (insertion order — deterministic output). */
function rootVars(vars: Record<string, string | number>): string {
  const decls = Object.entries(vars)
    .map(([name, value]) => `${name}:${String(value)}`)
    .join(';');
  return `:root{${decls}}`;
}

/**
 * The 罫線 (inter-column rules): one 1px background layer per interior column boundary on the
 * frame pseudo-element, each anchored an independent `k × var(--pitch)` from the frame's right
 * edge. NEVER a repeating gradient — Chromium's print rasterizer tiles those on a
 * device-pixel-snapped period, drifting off the vector-placed glyph columns (~half a column
 * across an A4 page) and dropping some repetitions. `em` on the build sheet, `rem` in the
 * preview (see preview.edge.css on the rem pinning).
 */
function edgeRules(selector: string, linesPerPage: number, unit: 'em' | 'rem'): string {
  const mix = 'color-mix(in srgb,var(--edge) 80%,transparent)';
  const boundaries = Array.from({ length: linesPerPage - 1 }, (_, i) => i + 1);
  const images = boundaries.map(() => `linear-gradient(${mix},${mix})`);
  const positions = boundaries.map((k) => `right calc(${String(k)}*var(--pitch)*1${unit} - 1px) top`);
  return `${selector}{background-image:${images.join(',')};` +
    `background-position:${positions.join(',')};` +
    'background-size:1px 100%;background-repeat:no-repeat;}';
}

/**
 * The 傍点 probe (source: src/client/webview/probe/emr.ts), inlined by both paginated
 * emitters iff a right-side 傍点 line put `emr` in the used sink. Mechanism and geometry:
 * class.emr.css.
 */
export function emrProbe(used: ReadonlySet<string>): string {
  return used.has('emr') ? `<script>${EMR_PROBE_JS}</script>` : '';
}

/**
 * The dynamic paper rules (BUILD), from geometry.ts's {@link fitPaper}. `@page` margins stay
 * 0 — browsers render their own print header/footer into `@page` margin boxes. The font size
 * goes on `html` ONLY, so the one build rem (build.ln.css) keeps equalling the page em. The
 * sheet→paper inset is a white BORDER: it paints outside the padding box, so the `.page`
 * border box IS the paper in both media while `overflow:hidden` clipping and the furniture
 * offsets stay on the padding box. border-width is PHYSICAL four-value (.page is
 * vertical-rl): top/bottom carry the asymmetric inline-axis insets, left/right the centered
 * block-axis inset.
 */
function paperRules(fit: PaperFit): string {
  return `@page{size:${String(fit.widthMm)}mm ${String(fit.heightMm)}mm;margin:0;}` +
    `html{font-size:${fit.fontMm.toFixed(3)}mm;}` +
    `.page{border:solid #fff;border-width:${fit.insetTopEm.toFixed(2)}em ${fit.insetBlockEm.toFixed(2)}em ` +
    `${fit.insetBottomEm.toFixed(2)}em ${fit.insetBlockEm.toFixed(2)}em;}` +
    webkitPrintShave(fit);
}

/**
 * WebKit (Safari) floors the page height it derives from its print layout width, so a sheet
 * that is exactly the paper overruns its page by a pixel or two — a blank page after every
 * sheet. Shave the bottom border under WebKit only (`-apple-system-body` parses nowhere else);
 * Chromium and Gecko place the sheet on the paper exactly. Source: LocalFrameView::
 * forceLayoutForPagination → resizePageRectsKeepingRatio.
 */
function webkitPrintShave(fit: PaperFit): string {
  return `@media print{@supports (font:-apple-system-body){.page{border-bottom-width:calc(${fit.insetBottomEm.toFixed(2)}em - 4px);}}}`;
}

type StylesheetOptions =
  | {
    readonly paginate: true;
    readonly charsPerLine: number;
    readonly linesPerPage: number;
    /** 行送り in em — injected as `--pitch` and fed to {@link fitPaper}. */
    readonly linePitch: LinePitch;
    /** Physical output paper (`jpnov.layout.paper.size` / `.orientation`). */
    readonly paperSize: PaperSize;
    readonly paperOrientation: PaperOrientation;
    /** Resolved `jpnov.layout.fontFamily`; '' = the built-in {@link DEFAULT_FONT_STACK}. */
    readonly fontFamily: string;
    readonly chrome: BuildChrome;
    readonly usedClasses?: readonly string[];
  }
  | {
    readonly paginate: false;
    readonly charsPerLine: number;
    /** 行送り in em — injected as `--pitch`. */
    readonly linePitch: LinePitch;
    /** Page extent (columns) for the edge frame; injected as --lpp only while edge is on. */
    readonly linesPerPage: number;
    /** Resolved `jpnov.layout.fontFamily`; '' = the built-in {@link DEFAULT_FONT_STACK}. */
    readonly fontFamily: string;
    readonly chrome: PreviewChrome;
    readonly usedClasses?: readonly string[];
  };

/**
 * Renders the stylesheet for one document. `usedClasses` is the on-demand class sink
 * (callers pass it pre-sorted, lexicographic by class name, for deterministic output);
 * chrome features select their fragment in a fixed order (anchor → line numbers → edge →
 * header → footer), followed by the `:root` variables and (BUILD) the paper rules, so the
 * output stays deterministic.
 */
export function stylesheet(opts: StylesheetOptions): string {
  const edge = edgeBase(opts.chrome.edgeLine); // null ⟺ no edge fragment, no --edge
  const anchor = opts.chrome.lineNumbers || edge !== null; // .line{position:relative} — rationale in *.anchor.css
  const font = fontFamilyValue(opts.fontFamily);
  const tail = (opts.usedClasses ?? []).map(classRule);

  if (opts.paginate) {
    const { chrome } = opts;
    const hTop = HEADER_BAND + (chrome.lineNumbers ? LINENUM_BAND : 0);
    const vars: Record<string, string | number> = {
      '--cpl': opts.charsPerLine,
      '--pitch': opts.linePitch,
      '--lpp': opts.linesPerPage,
      '--htop': hTop,
      '--font-family': font,
    };
    if (edge !== null) {
      vars['--edge'] = edge;
    }
    const fit = fitPaper({
      charsPerLine: opts.charsPerLine,
      linesPerPage: opts.linesPerPage,
      linePitch: opts.linePitch,
      hTop,
      size: opts.paperSize,
      orientation: opts.paperOrientation,
    });
    return [
      S.buildBase,
      S.buildPrint,
      anchor ? S.buildAnchor : '',
      chrome.lineNumbers ? S.buildLn : '',
      edge !== null ? S.buildEdge : '',
      chrome.header !== '' ? S.buildHeader : '',
      chrome.footerAlign !== 'none' ? S.buildFooter : '',
      rootVars(vars),
      paperRules(fit),
      edge !== null ? edgeRules('.page::before', opts.linesPerPage, 'em') : '',
      ...tail,
    ].join('');
  }

  const vars: Record<string, string | number> = {
    '--cpl': opts.charsPerLine,
    '--pitch': opts.linePitch,
    '--font-family': font,
  };
  if (edge !== null) {
    vars['--lpp'] = opts.linesPerPage; // read only by the edge fragment's .segment min-block-size
    vars['--edge'] = edge;
  }
  return [
    S.previewBase,
    anchor ? S.previewAnchor : '',
    opts.chrome.lineNumbers ? S.previewLn : '',
    edge !== null ? S.previewEdge : '',
    rootVars(vars),
    edge !== null ? edgeRules('.segment::before', opts.linesPerPage, 'rem') : '',
    ...tail,
  ].join('');
}

/**
 * `line-break` per 禁則 tier (https://drafts.csswg.org/css-text/#line-break-property):
 * relaxed/strict = the CSS normal/strict sets (layout.ts); none→`loose`, the least restrictive
 * JAPANESE-aware value (`anywhere` would also break Latin words).
 */
const LINE_BREAK: Readonly<Record<KinsokuMode, string>> = {
  none: 'loose',
  relaxed: 'normal',
  strict: 'strict',
};

/**
 * Renders the stylesheet for the REFLOW (EPUB) output: no geometry variables, no chrome
 * fragments, no `@page` — the reading system owns line breaking, pagination and page
 * furniture. 禁則 maps onto the reader's own JIS line breaking via {@link LINE_BREAK};
 * ぶら下げ rides along as hanging-punctuation while kinsoku is active (WebKit-only; other
 * engines ignore it).
 */
export function reflowStylesheet(kinsoku: KinsokuMode, usedClasses: readonly string[]): string {
  const hang = kinsoku === 'none' ? '' : ';hanging-punctuation:allow-end';
  return [S.reflowBase, `body{line-break:${LINE_BREAK[kinsoku]}${hang}}`, ...usedClasses.map(classRule)].join('');
}
