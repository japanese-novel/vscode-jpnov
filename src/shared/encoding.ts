/**
 * The `.txt` output codec. Shift JIS is built by INVERTING the runtime's own
 * `TextDecoder('shift_jis')` rather than shipping a table
 * (https://encoding.spec.whatwg.org/#shift_jis). The index is CP932-flavoured, so 髙 and ① encode
 * where JIS X 0208 alone would refuse; the runtime's SINGLE-byte range deviates from the spec, so
 * that half is written out by hand below and the test digest guards the rest.
 *
 * Pure + vscode-free: the client encodes artifacts with it; the `shiftJisSafe` lint and the
 * `.jpbook` divider check ask it what is representable. All must agree, so none may keep a
 * private table.
 *
 * Decomposed kana (か + U+3099) are composed per grapheme cluster, on both sides, through the
 * shared {@link composeKana} — pair-wise composition only, never whole-text NFC.
 *
 * The characters of {@link GAIJI} that have no cell are written as their 外字注記
 * (https://www.aozora.gr.jp/annotation/external_character.html), so both sides count them as held;
 * one with a cell, such as 《, is written as itself.
 */
import { GAIJI, gaijiAnnotation } from './ast/notation.ts';
import { clustersOf, composeKana, dropWithOrigin, isSingletonUnit } from './chars.ts';
import { charClass } from './utils/regex.ts';

/** `jpnov.layout.txt.encoding` members — the encodings a built `.txt` can be written in. */
export const TXT_ENCODINGS = ['shiftJis', 'utf8', 'utf8Bom'] as const;
export type TxtEncoding = (typeof TXT_ENCODINGS)[number];

/** Aozora Bunko texts are Shift JIS, so that is what a built book defaults to. */
export const TXT_ENCODING_DEFAULT: TxtEncoding = 'shiftJis';

/** 〓 GETA MARK, the typesetter's stand-in for a character that could not be set. A literal, so
 *  substituting never depends on a lookup that could miss. */
const GETA_CELL = 0x81ac;

/** Two-byte lead ranges; the gap between them holds the single-byte katakana block (0xA1-0xDF). */
const LEAD_RANGES = [[0x81, 0x9f], [0xe0, 0xfc]] as const;

/**
 * Code points the WHATWG index leaves out because the decoder reports the Microsoft spelling of a
 * shared JIS X 0208 cell. Each maps to the byte pair its partner already owns, so a manuscript
 * carrying either spelling survives the round trip. U+2212 is the encoder spec's own step 6; the
 * rest are the CP932 duplicate set.
 */
const ALIASES: readonly (readonly [number, number])[] = [
  [0x00a2, 0xffe0], // ¢ -> ￠
  [0x00a3, 0xffe1], // £ -> ￡
  [0x00ac, 0xffe2], // ¬ -> ￢
  [0x2014, 0x2015], // — -> ―  (both are JIS X 0208 row 1 cell 29)
  [0x2016, 0x2225], // ‖ -> ∥
  [0x2212, 0xff0d], // − -> －
  [0x301c, 0xff5e], // 〜 -> ～
];

/**
 * cp -> byte, packed: a value above 0xFF is a two-byte cell (`lead << 8 | trail`). Built once, on
 * first use.
 */
let table: Map<number, number> | undefined;

/**
 * The JIS X 0208 index pointer a cell decodes through. The encoder half of the spec drops
 * pointers 8272..8835 — the NEC-selected duplicates of the IBM extensions — so those characters
 * encode to the IBM 0xFA..0xFC forms every Japanese editor writes.
 */
function pointerOf(lead: number, trail: number): number {
  return (lead - (lead < 0xa0 ? 0x81 : 0xc1)) * 188 + (trail - (trail < 0x7f ? 0x40 : 0x41));
}

function buildTable(): Map<number, number> {
  const map = new Map<number, number>();

  // ASCII (and U+0080) is identity by spec, NOT by inversion: the runtime's decoder rotates the
  // 0x1A/0x1C/0x7F controls and refuses 0x80, which inverting would bake in.
  for (let byte = 0; byte <= 0x80; byte++) {
    map.set(byte, byte);
  }
  map.set(0x00a5, 0x5c); // ¥ — spec, where ASCII would put a backslash
  map.set(0x203e, 0x7e); // ‾ — spec, where ASCII would put a tilde
  for (let cp = 0xff61; cp <= 0xff9f; cp++) {
    map.set(cp, cp - 0xff61 + 0xa1); // half-width katakana, one byte each
  }

  const decoder = new TextDecoder('shift_jis');
  const cell = new Uint8Array(2);
  for (const [first, last] of LEAD_RANGES) {
    for (let lead = first; lead <= last; lead++) {
      for (let trail = 0x40; trail <= 0xfc; trail++) {
        const pointer = pointerOf(lead, trail);
        if (trail === 0x7f || (pointer >= 8272 && pointer <= 8835)) {
          continue;
        }
        cell[0] = lead;
        cell[1] = trail;
        const decoded = decoder.decode(cell);
        const cp = decoded.codePointAt(0) ?? 0xfffd;
        // Unassigned cells decode to U+FFFD; a private-use answer means the decoder parked an
        // unmapped cell in the PUA, and inverting that would invent a mapping.
        if (decoded.length !== 1 || cp === 0xfffd || (cp >= 0xe000 && cp <= 0xf8ff)) {
          continue;
        }
        if (!map.has(cp)) {
          map.set(cp, (lead << 8) | trail);
        }
      }
    }
  }

  for (const [from, to] of ALIASES) {
    const packed = map.get(to);
    if (packed !== undefined) {
      map.set(from, packed);
    }
  }
  return map;
}

function shiftJisTable(): Map<number, number> {
  return (table ??= buildTable());
}

/** True when Shift JIS has a byte sequence for `cp`. A probe into the table; scanning text is
 *  {@link unencodableChars}. */
export function isShiftJisEncodable(cp: number): boolean {
  return shiftJisTable().has(cp);
}

/**
 * One written character Shift JIS cannot hold whole. `❤️` and `👨‍👩‍👦` are single characters built
 * from several code points, so the CLUSTER is what an author sees and what a message must quote,
 * while the offset/length stay on the offending code point — a range no wider than the defect keeps
 * this distinguishable from what a sibling lint rule reports on the same cluster. A decomposed kana
 * whose composition has a cell (か + U+3099 -> が) is not one of these: the codec writes it whole.
 */
export interface UnencodableChar {
  /** The whole grapheme cluster — quote this. */
  readonly cluster: string;
  /** The first code point of the RAW cluster with no Shift JIS cell. */
  readonly cp: number;
  /** UTF-16 offset of that code point. */
  readonly offset: number;
  /** Its UTF-16 length, 1 or 2. */
  readonly length: number;
}

/** The characters Shift JIS writes as their 外字注記: those of {@link GAIJI} without a cell. Built with the table. */
let notedGaiji: RegExp | undefined;
function notedGaijiChars(): RegExp {
  return (notedGaiji ??= new RegExp(`[${charClass(Object.values(GAIJI).filter((ch) => !isShiftJisEncodable(ch.codePointAt(0) ?? 0)))}]`, 'g'));
}

/** True when Shift JIS can write `ch`: in its cell, or as its 外字注記. */
function holds(ch: string, map: Map<number, number>): boolean {
  return map.has(ch.codePointAt(0) ?? 0) || gaijiAnnotation(ch) !== undefined;
}

/** True when Shift JIS can write every code point of `cluster`. */
function holdsWhole(cluster: string, map: Map<number, number>): boolean {
  for (const ch of cluster) {
    if (!holds(ch, map)) {
      return false;
    }
  }
  return true;
}

/**
 * Every written character of `text` Shift JIS cannot hold whole once its kana are composed, in
 * order — at most one per cluster. The characters the text build drops ({@link dropWithOrigin}) are
 * left out first; the offsets stay those of `text`.
 *
 * Code units with a cell are skipped, and only the cluster around one without is examined: the
 * cluster pass adds no code point (it drops some and composes kana over a mark that has no cell
 * itself), so a cluster of held units reports nothing. A surrogate has no cell either, so an
 * astral character lands here unpaired.
 */
export function unencodableChars(text: string): UnencodableChar[] {
  const map = shiftJisTable();
  const out: UnencodableChar[] = [];
  const { text: shown, origin } = dropWithOrigin(text);
  let clusters: Intl.Segments | undefined;
  let i = 0;
  while (i < shown.length) {
    if (map.has(shown.charCodeAt(i))) {
      i += 1;
      continue;
    }
    clusters ??= clustersOf(shown);
    const { segment, index } = clusterAt(shown, clusters, i);
    if (!holdsWhole(composeKana(segment), map)) {
      // Reported on the RAW code point: the mark itself has no cell, so a cluster whose composition
      // lacks one always lands here — the offset noNfd reports too, which lets the engine de-duplicate.
      let offset = index;
      for (const ch of segment) {
        const cp = ch.codePointAt(0) ?? 0;
        if (cp > 0x7f && !holds(ch, map)) {
          out.push({ cluster: segment, cp, offset: origin?.[offset] ?? offset, length: ch.length });
          break; // one report per written character, however many code points it took
        }
        offset += ch.length;
      }
    }
    i = index + segment.length;
  }
  return out;
}

/** Bytes to write, plus how many characters were replaced by 〓 getting there. */
export interface EncodedTxt {
  readonly bytes: Uint8Array;
  readonly substitutions: number;
}

const UTF8 = new TextEncoder();

/**
 * Encodes one `.txt` artifact. Shift JIS writes the characters of {@link GAIJI} it lacks as their
 * 外字注記, and 〓 for anything else it cannot hold, which it counts — the build always produces a file, and
 * the caller reports the count. UTF-8 holds everything.
 */
export function encodeTxt(text: string, encoding: TxtEncoding): EncodedTxt {
  if (encoding !== 'shiftJis') {
    return {
      bytes: UTF8.encode(encoding === 'utf8Bom' ? `\uFEFF${text}` : text),
      substitutions: 0,
    };
  }

  const map = shiftJisTable();
  const written = text.replace(notedGaijiChars(), (ch) => gaijiAnnotation(ch) ?? ch);
  // A unit writes at most two bytes, and a cluster written as 〓 holds at least one unit: the bound.
  const bytes = new Uint8Array(written.length * 2);
  let n = 0;
  let substitutions = 0;
  // Per grapheme cluster, because one written character must occupy one square on the page grid:
  // ❤️ and 👨‍👩‍👦 are 2 and 5 code points but one square each. The cluster's kana are composed first
  // (か + U+3099 writes が); whatever else can be written is written (辻 survives when only its
  // variation selector is unrepresentable), and a cluster that yields nothing becomes one 〓.
  // A unit with a cell that the next unit cannot join (a singleton, or the end) is a cluster of its
  // own: nearly every character, written without the segmenter. That rests on no cell joining the
  // character after it (no Prepend, ZWJ or Hangul jamo has one); the encoding test pins it.
  let clusters: Intl.Segments | undefined;
  let i = 0;
  while (i < written.length) {
    const cell = map.get(written.charCodeAt(i));
    if (cell !== undefined && (i + 1 === written.length || isSingletonUnit(written.charCodeAt(i + 1)))) {
      n = writeCell(bytes, n, cell);
      i += 1;
      continue;
    }
    clusters ??= clustersOf(written);
    const { segment, index } = clusterAt(written, clusters, i);
    const before = n;
    for (const ch of composeKana(segment)) {
      const packed = map.get(ch.codePointAt(0) ?? 0);
      if (packed !== undefined) {
        n = writeCell(bytes, n, packed);
      }
    }
    if (n === before) {
      n = writeCell(bytes, n, GETA_CELL);
      substitutions += 1;
    }
    i = index + segment.length;
  }
  return { bytes: bytes.slice(0, n), substitutions }; // a copy of the final size: the view's buffer would carry the slack
}

/** Writes the packed cell `packed` (one or two bytes) at `n`; returns the next free index. */
function writeCell(bytes: Uint8Array, n: number, packed: number): number {
  if (packed > 0xff) {
    bytes[n] = packed >> 8;
    n += 1;
  }
  bytes[n] = packed & 0xff;
  return n + 1;
}

/** The cluster of `text` holding unit `i`; always one, `i` being inside `text`. */
function clusterAt(text: string, clusters: Intl.Segments, i: number): { segment: string; index: number } {
  return clusters.containing(i) ?? { segment: text.charAt(i), index: i };
}
