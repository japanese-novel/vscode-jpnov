/** The dash glyphs, shared by the layout engine, the EPUB reflow emitter and the prose lint. */
import { codePoints } from './chars.ts';
import type { DashMode } from './config/types.ts';

/** The dash glyph each `jpnov.lint.common.dash` choice stands for. */
export const DASH_BY_MODE: Readonly<Record<DashMode, string>> = {
  emDash: '—', // U+2014
  horizontalBar: '―', // U+2015
  boxDrawing: '─', // U+2500
};

/** Every dash glyph, whatever the setting selects: all of them bind as one 分離禁止 class. */
export const DASH_CHARS = new Set<string>(Object.values(DASH_BY_MODE));

/** {@link DASH_CHARS} as code points, for the walks that compare numbers. */
export const DASH_CODES = codePoints(DASH_CHARS);

/** The configured dash mode's glyph is EMITTED as this one (U+2014): its ink runs edge to edge
 *  in the default font stack, so a doubled dash joins seamlessly. */
export const DASH_GLYPH = DASH_BY_MODE.emDash;
