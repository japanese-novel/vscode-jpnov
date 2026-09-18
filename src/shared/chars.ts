/**
 * Cross-layer character tables: the single home for the dash-glyph facts, the CJK
 * ideograph blocks and the kana composition shared by the layout engine, the EPUB reflow
 * emitter, the `.txt` codec and the prose lint.
 * Lint shares the tokenizer (token stream + character predicates) and THIS table; it never
 * imports the rendering modules (layout / reflow / css / document).
 */
import type { DashMode } from './config/types.ts';

/** The dash glyph each `jpnov.lint.common.dash` choice stands for. */
export const DASH_BY_MODE: Readonly<Record<DashMode, string>> = {
  emDash: '—', // U+2014
  horizontalBar: '―', // U+2015
  boxDrawing: '─', // U+2500
};

/** Every dash glyph, whatever the setting selects: all of them bind as one 分離禁止 class.
 *  Shared with the lint scanner (server/lint/prescan.ts). */
export const DASH_CHARS = new Set<string>(Object.values(DASH_BY_MODE));

/** The configured dash mode's glyph is EMITTED as this one (U+2014): its ink runs edge to edge
 *  in the default font stack, so a doubled dash joins seamlessly. */
export const DASH_GLYPH = DASH_BY_MODE.emDash;

/** A CJK ideograph: Ext A + Unified (U+3400–9FFF), Compatibility (U+F900–FAFF), SIP (U+20000–2FFFF). */
export function isCjkIdeograph(cp: number): boolean {
  return (cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x20000 && cp <= 0x2ffff);
}

/** Combining 濁点 (U+3099) and 半濁点 (U+309A): what a decomposed (NFD) kana carries after its base. */
const COMBINING_KANA_MARK = /[\u3099\u309A]/;

/**
 * `text` with every adjacent kana + combining 濁点/半濁点 pair composed (か + U+3099 -> が). NFC is
 * asked about the PAIR alone: whole-text NFC would also fold the CJK compatibility ideographs
 * personal names rely on (神 U+FA19 -> U+795E), which Shift JIS holds as distinct cells. A pair
 * Unicode does not compose (あ + U+3099) and a mark after anything but a kana stay as they came.
 */
export function composeKana(text: string): string {
  if (!COMBINING_KANA_MARK.test(text)) {
    return text;
  }
  const out: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x3099 || cp === 0x309a) {
      const prev = out[out.length - 1];
      const base = prev?.codePointAt(0) ?? 0;
      if (prev !== undefined && base >= 0x3041 && base <= 0x30ff) {
        const composed = (prev + ch).normalize('NFC');
        if (composed.length === 1) {
          out[out.length - 1] = composed;
          continue;
        }
      }
    }
    out.push(ch);
  }
  return out.join('');
}
