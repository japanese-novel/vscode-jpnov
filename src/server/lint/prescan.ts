/**
 * Pure character scanners. Each takes some text (plus the rule's resolved options)
 * and returns half-open `[start, end)` UTF-16 spans into THAT text; no scanner computes a source
 * position itself. Which text it gets is the binding's call (`modules.ts` / `rules/adapt.ts`): a
 * view-scanned rule sees one line view's prose and its spans are mapped through the view's units,
 * a per-piece rule sees one contiguous piece, and a `raw` rule sees the document source, so its
 * spans already ARE source offsets.
 */
import { isHiragana, isKatakana } from '../../shared/chars.ts';
import { isDashMode } from '../../shared/config/types.ts';
import { DASH_BY_MODE, DASH_CHARS } from '../../shared/dash.ts';
import { unencodableChars } from '../../shared/encoding.ts';
import { modeOf } from '../../shared/lint/select.ts';
import type { ActiveRule } from '../../shared/lint/select.ts';
import type { LocalizableMessage } from '../../shared/protocol.ts';

/** A pre-scan: clean text + the rule's resolved options -> the spans to flag (UTF-16 offsets).
 *  `message` overrides the code the driver supplies by default (`rule.code`, no args). */
export type PreScan = (
  text: string,
  options: ActiveRule['options'],
) => readonly {
  readonly start: number;
  readonly end: number;
  readonly fix?: string;
  readonly message?: LocalizableMessage;
}[];

/** The three minus glyphs (ASCII, full-width, true minus) the prose may use as a sign. */
const MINUS = new Set(['-', '－', '−']);

/** True for an ASCII or full-width digit. */
function isDigit(ch: string | undefined): boolean {
  if (ch === undefined) {
    return false;
  }
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0xff10 && cp <= 0xff19);
}

/** True for an ASCII letter or digit — the neighbours of a legitimate Western hyphen. */
function isAsciiAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

/** Flags a minus sign that is not immediately followed by a digit (so it reads as a stray dash).
 *  An ASCII `-` between ASCII alphanumerics is a Western hyphen (Wi-Fi, J-POP) and is left alone;
 *  ラ-メン (a kana neighbour) is still the mistake this rule exists for. */
export const minusPositionScan: PreScan = (text) => {
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (!MINUS.has(ch) || isDigit(text[i + 1])) {
      continue;
    }
    if (ch === '-' && isAsciiAlnum(text[i - 1]) && isAsciiAlnum(text[i + 1])) {
      continue;
    }
    out.push({ start: i, end: i + 1 });
  }
  return out;
};

/** What an author types for a dash when the real one is out of reach: the full-width hyphen-minus
 *  (U+FF0D) and the en dash (U+2013, JLREQ cl-03 ハイフン類). A lone one is a sign or a hyphen
 *  (－５度, １–２), so it counts only inside a run of two or more. The prolonged sound mark ー
 *  (U+30FC, JLREQ cl-10 長音記号) is never a dash: 「あーーーー！」 is dialogue. */
const DASH_LOOKALIKES = new Set(['－', '–']);

/** What a dash run is made of, as UTF-16 units: every dash glyph and look-alike is one unit, and a
 *  numeric lookup spares the per-character string a `charAt` on kana or kanji would allocate. */
const DASH_RUN = new Set([...DASH_CHARS, ...DASH_LOOKALIKES].map((ch) => ch.charCodeAt(0)));

/** Flags a maximal run of dash characters (mixed spellings and look-alikes included) unless it is
 *  an even-length run of the chosen glyph; the fix rewrites the run in that glyph, rounding an odd
 *  length up. A single look-alike on its own is not a run. */
export const dashScan: PreScan = (text, options) => {
  const mode = modeOf(options);
  const want = mode !== undefined && isDashMode(mode) ? DASH_BY_MODE[mode] : undefined;
  if (want === undefined) {
    return [];
  }
  const out: { start: number; end: number; fix: string; message: LocalizableMessage }[] = [];
  let i = 0;
  while (i < text.length) {
    if (!DASH_RUN.has(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const start = i;
    let pure = true;
    while (i < text.length && DASH_RUN.has(text.charCodeAt(i))) {
      pure &&= text.charAt(i) === want;
      i += 1;
    }
    const len = i - start;
    if (len === 1 && DASH_LOOKALIKES.has(text.charAt(start))) {
      continue;
    }
    if (pure && len % 2 === 0) {
      continue;
    }
    out.push({
      start,
      end: i,
      fix: want.repeat(len + (len % 2)),
      message: pure
        ? { code: 'lint.common.dash.parity' }
        : { code: 'lint.common.dash', args: [want] },
    });
  }
  return out;
};

const FULL_WIDTH_SPACE = '　';

/** True for any non-ASCII code unit (kana, kanji, full-width punctuation). */
function isNonAscii(ch: string | undefined): boolean {
  return ch !== undefined && (ch.codePointAt(0) ?? 0) > 0x7f;
}

/** True for a half-width ! or ?. */
function isHalfMark(ch: string | undefined): boolean {
  return ch === '!' || ch === '?';
}

/** True when Japanese prose ends right before `pos`: a non-ASCII character, or a half-width ！？
 *  run of two or more (`!?`, `!!`, `?!?`) — the sentence-ender form, at the same threshold as
 *  exclamationSpace; a lone half-width mark is Western. */
function endsJapanese(text: string, pos: number): boolean {
  return isNonAscii(text[pos - 1]) || (isHalfMark(text[pos - 1]) && isHalfMark(text[pos - 2]));
}

/**
 * Flags a run of half-width spaces that Japanese prose ends before and a full-width (non-ASCII)
 * character begins after; the fix REPLACES the run with a single full-width space (　) — never
 * deletes it. A run touching other ASCII or a line edge is left alone (Western text; paragraph
 * indentation is the indent rule's job).
 */
export const halfWidthSpaceScan: PreScan = (text) => {
  const out: { start: number; end: number; fix: string }[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) !== ' ') {
      i += 1;
      continue;
    }
    const start = i;
    while (i < text.length && text.charAt(i) === ' ') {
      i += 1;
    }
    if (isNonAscii(text[i]) && endsJapanese(text, start)) {
      out.push({ start, end: i, fix: FULL_WIDTH_SPACE });
    }
  }
  return out;
};

/** `U+` suffix identifying a code point in the message. */
function hexCodePoint(cp: number): string {
  return cp.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Flags each character Shift JIS cannot hold; a built `.txt` writes 〓 in its place. Runs on the RAW
 * source (`kind: 'raw'`) because annotations reach the `.txt` — a 左ルビ reading lives only
 * inside its annotation and appears in no stream. No fix: the substitutes are semantic (𠮟 -> 叱),
 * and `source.fixAll` would scatter them through a manuscript on save.
 */
export const shiftJisSafeScan: PreScan = (text) =>
  unencodableChars(text).map(({ cluster, cp, offset, length }) => ({
    start: offset,
    end: offset + length,
    message: { code: 'lint.common.shiftJisSafe', args: [cluster, hexCodePoint(cp)] },
  }));

const PROLONGED_SOUND = 0x30fc; // ー — neutral; allowed inside a hiragana OR katakana reading

/** True when every code point of `reading` is the chosen kana type (＋ the prolonged-sound mark ー). */
function isAllKana(reading: string, mode: string): boolean {
  const cps = Array.from(reading, (c) => c.codePointAt(0) ?? 0);
  if (mode === 'hiragana') {
    return cps.every((cp) => isHiragana(cp) || cp === PROLONGED_SOUND);
  }
  if (mode === 'katakana') {
    return cps.every((cp) => isKatakana(cp)); // isKatakana already includes ー
  }
  return true; // unknown mode -> nothing to enforce
}

/**
 * Flags ONE ruby reading (the whole input text, as shown: its kana composed) unless it is entirely
 * the kana type chosen in the setting (`{ mode: 'hiragana' | 'katakana' }`). Requiring
 * all-hiragana or all-katakana also rejects half-width kana, so one drop-down covers both.
 */
export const rubyKanaScan: PreScan = (text, options) => {
  const mode = modeOf(options);
  if (mode === undefined || text === '' || isAllKana(text, mode)) {
    return [];
  }
  return [{ start: 0, end: text.length }];
};
