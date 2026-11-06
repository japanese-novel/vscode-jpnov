/**
 * The width of a 縦中横, shared by the layout engine (the size class of the cell) and the syntax
 * diagnostics (the Warning): one measure, so what is set small and what is warned about agree.
 */
import { clusterStrings, isHalfWidth } from './chars.ts';

/**
 * The widest 縦中横 the typesetting answers for, in half-width units ({@link tcyWidth}): a run this
 * wide is set at 0.75em so it still hangs no further than three half-width glyphs; a wider one
 * renders the same way with no guarantee, and is warned about.
 */
export const TCY_MAX = 4;

/** The width of a 縦中横's text in half-width units: a half-width cluster counts 1, any other 2 (a full-width glyph is two half-widths). */
export function tcyWidth(text: string): number {
  let width = 0;
  for (const c of clusterStrings(text)) {
    width += isHalfWidth(c) ? 1 : 2;
  }
  return width;
}
