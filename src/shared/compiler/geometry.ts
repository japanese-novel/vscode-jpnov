/**
 * The page-geometry constants. All but the guard-only {@link EDGE_INSET} are CONSUMED at
 * runtime — the paper-fit generator (css.ts's `paperRules` via {@link fitPaper}) and the
 * `--htop` band variable are computed from them, so they cannot live only in the static
 * stylesheets.
 *
 * Some of them (FOOTER_BAND, SIDE_PAD, EDGE_INSET) are ALSO written as plain literals in
 * `styles/*.css`: that double home is deliberate — `@page` cannot read `var()` portably
 * (ruling: build output stays portable) — and is guarded by
 * `test/shared/compiler/styles-codegen.test.ts`, which asserts the `.css` literals equal
 * these constants. Change a value here WITHOUT updating the fragments (or vice versa) and
 * that test fails loudly. The line pitch is NOT a constant: the `jpnov.layout.linePitch`
 * setting (LINE_PITCHES in config/types.ts) reaches the fragments as `--pitch` and this
 * fit math as `opts.linePitch`.
 *
 * Pure + vscode-free.
 */

// Build-only chrome bands, in em (the same unit system as the charsPerLine-em grid).
// The header and footer bands are ALWAYS allocated — the sheet keeps stable geometry no
// matter which furniture is enabled — while the line-number band is on demand. The bands
// are CONTENT: the MARGIN_MM paper margin stays furniture-free, and the furniture sits
// flush against it (.hd top:0 / .ft bottom:0).
/** Header band at the physical top of a sheet (reserved even with no header text). */
export const HEADER_BAND = 2;
/** Line-number band between the header band and the column heads. */
export const LINENUM_BAND = 1;
/** Footer band at the physical bottom of a sheet (reserved even without a footer). */
export const FOOTER_BAND = 2;
/**
 * Sheet padding on the physical left/right (the vertical-rl block axis): the text grid and
 * the outset frame never touch the paper's side cut. Doubly homed as fragment literals
 * (padding-block, frame sides, footer corners at SIDE_PAD + EDGE_INSET) —
 * styles-codegen.test.ts guards the set.
 */
export const SIDE_PAD = 1.5;
/**
 * Frame ↔ text breathing gap in em, reserved UNCONDITIONALLY by both media (toggling
 * edgeLine never moves a glyph). Guard-only: the fit math never consumes it — the value
 * lives as fragment literals (preview reserve/lifts, frame top/bottom, footer corners),
 * every site derived-asserted from this constant by styles-codegen.test.ts.
 */
export const EDGE_INSET = 0.35;
/**
 * MINIMUM paper inset per side on the BLOCK axis (physical left/right), in em: {@link fitPaper}
 * caps the font size so the sheet keeps at least this surround inside the paper. The physical
 * top/bottom minimum is {@link MARGIN_MM} instead. The screen sheet's 2.5em inter-paper gap
 * (build.base.css) is a cosmetic look-alike, not coupled to this.
 */
export const PRINT_MARGIN = 2.5;

/** The 赤 edge-rule base colour (原稿用紙の赤枠) — semantic red, identical in both media. */
export const EDGE_RED = '#cc0000';

/** `jpnov.layout.paper.size` members (ISO 216 A series). */
export const PAPER_SIZES = ['a4', 'a6'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

/** `jpnov.layout.paper.orientation` members: how the physical sheet turns — unrelated to 縦書き. */
export const PAPER_ORIENTATIONS = ['auto', 'landscape', 'portrait'] as const;
export type PaperOrientation = (typeof PAPER_ORIENTATIONS)[number];

/** Portrait width × height in mm (ISO 216). */
const PAPER_MM: Record<PaperSize, { readonly w: number; readonly h: number }> = {
  a4: { w: 210, h: 297 },
  a6: { w: 105, h: 148 },
};

/**
 * MINIMUM physical top/bottom paper margin in mm — pure white, the header/footer bands
 * EXCLUDED (the furniture is content and starts right below/above these): {@link fitPaper}
 * caps the font size so the sheet clears them even at tight pitches. A tuning knob — the
 * tests derive from it, so retuning needs no test edits.
 */
export const MARGIN_MM: Record<PaperSize, { readonly top: number; readonly bottom: number }> = {
  a4: { top: 10, bottom: 12.5 },
  a6: { top: 5, bottom: 6.5 },
};

/**
 * One build sheet fitted onto physical paper: the paper box (mm), the root font size that
 * scales the whole em-based sheet onto it, and the per-side sheet→paper insets css.ts emits
 * as a white border (border-box == paper; block axis centered, inline axis biased by
 * {@link MARGIN_MM}). Every value is pre-floored to its emission quantum so the printed
 * border-box lands strictly INSIDE the `@page` box — Chromium would push an overflowing
 * sheet onto a second PDF page.
 */
export interface PaperFit {
  /** Paper width in mm — the horizontal axis, which is the vertical-rl BLOCK axis. */
  readonly widthMm: number;
  /** Paper height in mm — the vertical axis, which is the vertical-rl INLINE axis. */
  readonly heightMm: number;
  /** Root font size in mm, floored to 0.001. */
  readonly fontMm: number;
  /** Per-side inset on the block axis (physical left/right), em floored to 0.01. */
  readonly insetBlockEm: number;
  /** Inset above the header band (physical top), em floored to 0.01. */
  readonly insetTopEm: number;
  /** Inset below the footer band (physical bottom), em floored to 0.01. */
  readonly insetBottomEm: number;
}

/**
 * Floors a per-side inset to the 0.01em emission quantum MINUS one extra quantum: each
 * axis keeps up to ~0.04em slack over the exact fit, which outweighs Chromium's 1/64px
 * layout rounding (the fragmentation guard).
 */
function insetQuantum(insetEm: number): number {
  return (Math.floor(insetEm * 100) - 1) / 100;
}

/**
 * Fits one sheet onto the selected paper: the grid plus chrome bands, keeping a
 * {@link PRINT_MARGIN} em surround on the block axis and the {@link MARGIN_MM} mm floors on
 * the inline axis (the whole sheet — bands included — sits between the margins). Leftover
 * inline space is split evenly, so the bottom margin keeps its mm lead over the top at any
 * size. `auto` orientation is the product rule: `linesPerPage > charsPerLine / 2` →
 * landscape, else portrait. `hTop` is the same header/line-number band value css.ts injects
 * as `--htop`.
 */
export function fitPaper(opts: {
  readonly charsPerLine: number;
  readonly linesPerPage: number;
  /** 行送り in em — the same value css.ts injects as `--pitch`. */
  readonly linePitch: number;
  readonly hTop: number;
  readonly size: PaperSize;
  readonly orientation: PaperOrientation;
}): PaperFit {
  const landscape = opts.orientation === 'auto'
    ? opts.linesPerPage > opts.charsPerLine / 2
    : opts.orientation === 'landscape';
  const paper = PAPER_MM[opts.size];
  const margin = MARGIN_MM[opts.size];
  const widthMm = landscape ? paper.h : paper.w;
  const heightMm = landscape ? paper.w : paper.h;
  const sheetBlockEm = opts.linesPerPage * opts.linePitch + 2 * SIDE_PAD;
  const sheetInlineEm = opts.charsPerLine + opts.hTop + FOOTER_BAND;
  const fontMm = Math.floor(Math.min(
    widthMm / (sheetBlockEm + 2 * PRINT_MARGIN),
    (heightMm - margin.top - margin.bottom) / sheetInlineEm,
  ) * 1000) / 1000;
  const needTopEm = margin.top / fontMm;
  const needBottomEm = margin.bottom / fontMm;
  const surplusEm = (heightMm / fontMm - sheetInlineEm - needTopEm - needBottomEm) / 2;
  return {
    widthMm,
    heightMm,
    fontMm,
    insetBlockEm: insetQuantum((widthMm / fontMm - sheetBlockEm) / 2),
    insetTopEm: insetQuantum(needTopEm + surplusEm),
    insetBottomEm: insetQuantum(needBottomEm + surplusEm),
  };
}
