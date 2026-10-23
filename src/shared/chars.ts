/**
 * The character tables every layer shares: the CJK ideograph and kana blocks, the kana
 * composition, the grapheme clusters, and the characters no output can carry. A leaf: it imports
 * nothing, the AST layer stands on it.
 */

/** A CJK ideograph: Ext A + Unified (U+3400–9FFF), Compatibility (U+F900–FAFF), SIP (U+20000–2FFFF). */
export function isCjkIdeograph(cp: number): boolean {
  return (cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x20000 && cp <= 0x2ffff);
}

/**
 * Kanji as the notation counts them for a ruby base: the CJK ideographs plus 々〆〇ヶ — the spec
 * treats 「仝々〆〇ヶ」 as kanji for the ｜ rule (仝 U+4EDD already sits in the unified block).
 * https://www.aozora.gr.jp/annotation/etc.html#ruby
 */
export function isKanji(cp: number): boolean {
  return isCjkIdeograph(cp) || cp === 0x3005 || cp === 0x3006 || cp === 0x3007 || cp === 0x30f6;
}

/** Hiragana block (U+3041..U+3096); the small ヶ is intentionally NOT hiragana. */
export function isHiragana(cp: number): boolean {
  return cp >= 0x3041 && cp <= 0x3096;
}

/** Katakana (U+30A1..U+30FA) plus the prolonged-sound mark ー (U+30FC); ヶ (U+30F6) counts as kanji. */
export function isKatakana(cp: number): boolean {
  if (cp === 0x30f6) {
    return false;
  }
  return (cp >= 0x30a1 && cp <= 0x30fa) || cp === 0x30fc;
}

/** The dialogue corners 「『」』, as the body of a character class: the characters of prose that
 *  open and close an utterance. One rule for the dialogue stack, the grammar and the name lists (a
 *  name holds none: a corner is the structure of dialogue, never part of a name). */
export const CORNERS = '「『」』';

/** Combining 濁点 (U+3099) and 半濁点 (U+309A): what a decomposed (NFD) kana carries after its base. */
export const COMBINING_KANA_MARK = /[\u3099\u309A]/;

/** Whether `cp` is a combining 濁点/半濁点 (the second code point of an NFD kana). */
export function isCombiningKanaMark(cp: number): boolean {
  return cp === 0x3099 || cp === 0x309a;
}

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
  return composedChars(text).map((ch) => ch.text).join('');
}

/** One display character and the UTF-16 range of `text` it came from. */
export interface ComposedChar {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The characters of `text` as {@link composeKana} joins them, each with its range in `text`: a
 * composed kana covers its kana and the mark, any other character itself.
 */
export function composedChars(text: string): ComposedChar[] {
  const out: ComposedChar[] = [];
  let at = 0;
  for (const ch of text) {
    const start = at;
    at += ch.length;
    const prev = out[out.length - 1];
    if (prev !== undefined && isCombiningKanaMark(ch.codePointAt(0) ?? 0)) {
      const base = prev.text.codePointAt(0) ?? 0;
      if (base >= 0x3041 && base <= 0x30ff) {
        const composed = (prev.text + ch).normalize('NFC');
        if (composed.length === 1) {
          out[out.length - 1] = { text: composed, start: prev.start, end: at };
          continue;
        }
      }
    }
    out.push({ text: ch, start, end: at });
  }
  return out;
}

const GRAPHEMES = new Intl.Segmenter('ja', { granularity: 'grapheme' });

/** The clusters of `text` by position: `containing(at)` is the one holding UTF-16 unit `at`, found
 *  without walking the rest. Building the object is what costs, so keep it across lookups. */
export function clustersOf(text: string): Intl.Segments {
  return GRAPHEMES.segment(text);
}

/**
 * The blocks a manuscript is made of, less every code point that joins a cluster
 * (Grapheme_Cluster_Break=Other, https://www.unicode.org/reports/tr29/), as inclusive ranges of
 * UTF-16 units in ascending order: a text of these alone is one cluster per code point. The holes
 * (U+302A-302F, U+3099-309A, U+FF9E-FF9F, U+200C-200D, the astral planes) are what the segmenter
 * must still see. The one table behind {@link SINGLETONS} and {@link isSingletonUnit}.
 */
const SINGLETON_RANGES: readonly (readonly [number, number])[] = [
  [0x0020, 0x007e],
  [0x00a1, 0x00ac],
  [0x00ae, 0x00ff],
  [0x2010, 0x2027],
  [0x2030, 0x205e],
  [0x2460, 0x2bff],
  [0x3000, 0x3029],
  [0x3030, 0x3098],
  [0x309b, 0x30ff],
  [0x3200, 0x33ff],
  [0x3400, 0x9fff],
  [0xf900, 0xfaff],
  [0xff01, 0xff5e],
  [0xff61, 0xff9d],
];

/** Matches a text made of {@link SINGLETON_RANGES} alone: one cluster per code point, no segmenter needed. */
export const SINGLETONS = new RegExp(
  `^[${SINGLETON_RANGES.map(([lo, hi]) => `\\u${lo.toString(16).padStart(4, '0')}-\\u${hi.toString(16).padStart(4, '0')}`).join('')}]*$`,
);

/** {@link SINGLETON_RANGES} as one byte per UTF-16 unit: a lookup, for a walk over code units. */
const SINGLETON_UNITS = new Uint8Array(0x10000);
for (const [lo, hi] of SINGLETON_RANGES) {
  SINGLETON_UNITS.fill(1, lo, hi + 1);
}

/** Whether the UTF-16 unit `unit` is in {@link SINGLETON_RANGES}: a character that joins no cluster, so the unit before it ends its cluster there. */
export function isSingletonUnit(unit: number): boolean {
  return SINGLETON_UNITS[unit] === 1;
}

/** The code points of `chars` as a Set: the table a walk over code units reads by number, allocating no string per unit. */
export function codePoints(chars: Iterable<string>): Set<number> {
  return new Set(Array.from(chars, (c) => c.codePointAt(0) ?? 0));
}

/**
 * The grapheme clusters of `text` (UAX #29): what one square of the page grid holds. A kanji and
 * its variation selector, an emoji sequence, a kana and a mark that composes nothing are one each.
 */
export function graphemes(text: string): string[] {
  return Array.from(clusterStrings(text));
}

/** The clusters of `text` as an iterable: the string itself when it is singletons alone (each code point one cluster), else the segmenter's. */
export function clusterStrings(text: string): Iterable<string> {
  return SINGLETONS.test(text) ? text : Iterator.from(GRAPHEMES.segment(text)).map((s) => s.segment);
}

/** How many clusters `text` holds: the squares it takes on the grid, without listing them. */
export function graphemeCount(text: string): number {
  if (SINGLETONS.test(text)) {
    return text.length;
  }
  return Iterator.from(GRAPHEMES.segment(text)).reduce((n) => n + 1, 0);
}

/**
 * True iff `at` falls between two clusters of `text`: never at its ends. Two singletons always
 * part (a cluster joins across a non-singleton on one of its sides); anything else asks the
 * segmenter for the one cluster around `at`, whatever the length of `text`.
 */
export function isClusterBoundary(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) {
    return false;
  }
  return (isSingletonUnit(text.charCodeAt(at - 1)) && isSingletonUnit(text.charCodeAt(at))) || clustersOf(text).containing(at)?.index === at;
}

/**
 * The characters no output can carry: what XML 1.0 leaves out of Char below U+10000, surrogates
 * aside (https://www.w3.org/TR/xml/#charsets). Tab, LF and CR are Char.
 */
export const UNSHOWN = /[\0-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;

/** Whether `cp` is a character no output can carry: the class {@link dropUnshown} removes. */
export function isUnshown(cp: number): boolean {
  return cp <= 0x08 || cp === 0x0b || cp === 0x0c || (cp >= 0x0e && cp <= 0x1f) || cp === 0xfffe || cp === 0xffff;
}

/** `text` without the characters no output can carry; everything else stays as it came. */
export function dropUnshown(text: string): string {
  return text.replace(UNSHOWN, '');
}

/**
 * {@link dropUnshown} with the way back: `origin` holds, for each UTF-16 unit kept, its offset in
 * the input, and is null when nothing was dropped.
 */
export function dropWithOrigin(text: string): { text: string; origin: number[] | null } {
  let origin: number[] | null = null;
  for (let i = 0; i < text.length; i += 1) {
    if (isUnshown(text.charCodeAt(i))) {
      origin ??= Array.from({ length: i }, (_, k) => k);
    } else {
      origin?.push(i);
    }
  }
  return origin === null ? { text, origin } : { text: dropUnshown(text), origin };
}

/**
 * `text` as an output shows it: the characters no output can carry dropped, then its kana
 * composed ({@link composeKana}), so a kana and its mark compose across a dropped character.
 */
export function displayText(text: string): string {
  return composeKana(dropUnshown(text));
}

/**
 * The characters of {@link displayText}, one per grapheme cluster with its kana composed, each with
 * its range in `text`: a dropped character belongs to no range, unless it sits inside a cluster.
 */
export function displayChars(text: string): ComposedChar[] {
  const { text: shown, origin } = dropWithOrigin(text);
  const chars: ComposedChar[] = [];
  let at = 0;
  for (const cluster of graphemes(shown)) {
    const start = at;
    at += cluster.length;
    chars.push({ text: composeKana(cluster), start: origin?.[start] ?? start, end: (origin?.[at - 1] ?? at - 1) + 1 });
  }
  return chars;
}
