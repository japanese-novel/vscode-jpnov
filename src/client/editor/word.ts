/**
 * Pure half of the word commands (#155): where ⌥←/⌥→ and ⌥⌫/⌥⌦ stop on a line of a `.jpnov`.
 * `Intl.Segmenter('ja')` cuts the line and neighboring segments join by character class. Only the
 * pair decides, so ← and → stop at the same places. vscode-free — the unit suite imports this
 * file directly; `wordCommands.ts` owns the editor wiring.
 */
import { isCjkIdeograph, isHiragana, isKatakana } from '#/shared/chars.ts';

export interface WordCommand {
  /** `jpnov.` + {@link builtin}. */
  readonly id: string;
  /** The VS Code command whose keys this one takes over in a `.jpnov` editor. */
  readonly builtin: string;
  readonly action: 'move' | 'select' | 'delete';
  readonly toward: 'left' | 'right';
}

export const WORD_COMMANDS: readonly WordCommand[] = ([
  { builtin: 'cursorWordLeft', action: 'move', toward: 'left' },
  { builtin: 'cursorWordEndRight', action: 'move', toward: 'right' },
  { builtin: 'cursorWordLeftSelect', action: 'select', toward: 'left' },
  { builtin: 'cursorWordEndRightSelect', action: 'select', toward: 'right' },
  { builtin: 'deleteWordLeft', action: 'delete', toward: 'left' },
  { builtin: 'deleteWordRight', action: 'delete', toward: 'right' },
] satisfies readonly Omit<WordCommand, 'id'>[]).map((c) => ({ ...c, id: `jpnov.${c.builtin}` }));

type CharClass = 'kanji' | 'prolonged' | 'hiragana' | 'katakana' | 'other';

/**
 * Where this feature departs from the shared tables, checked first: 々 〆 〇 and the small ヵ ヶ
 * are kanji (三ヶ月), ー ｰ the prolonged mark, and the iteration marks ゝ ゞ ヽ ヾ go with their script.
 */
const OVERRIDES = new Map<number, CharClass>([
  [0x3005, 'kanji'], [0x3006, 'kanji'], [0x3007, 'kanji'], [0x30f5, 'kanji'], [0x30f6, 'kanji'],
  [0x30fc, 'prolonged'], [0xff70, 'prolonged'],
  [0x309d, 'hiragana'], [0x309e, 'hiragana'],
  [0x30fd, 'katakana'], [0x30fe, 'katakana'],
]);

function classOf(cp: number | undefined): CharClass {
  if (cp === undefined) {
    return 'other';
  }
  const override = OVERRIDES.get(cp);
  if (override !== undefined) {
    return override;
  }
  if (isCjkIdeograph(cp)) {
    return 'kanji';
  }
  if (isHiragana(cp)) {
    return 'hiragana';
  }
  // Half-width katakana counts too.
  if (isKatakana(cp) || (cp >= 0xff66 && cp <= 0xff9f)) {
    return 'katakana';
  }
  return 'other';
}

/** A segment as `Intl.Segmenter` yields it; a missing `isWordLike` counts as false. */
export interface WordSegment {
  readonly segment: string;
  readonly index: number;
  readonly isWordLike?: boolean;
}

/** A segment's last character that is not a combining mark (an NFD 濁点, a variation selector). */
const LAST_BASE = /\P{M}\p{M}*$/u;

/** A standalone を or は joins what precedes it and closes the group. */
const CLOSING_PARTICLES = new Set(['を', 'は']);

/** Opening and closing brackets (「『［（ and 」』］）…), each a segment of its own. */
const OPENING_BRACKET = /^\p{Ps}/u;
const CLOSING_BRACKET = /\p{Pe}$/u;

/** Whether `right` continues the group that `left` ends. */
function joins(left: WordSegment, right: WordSegment): boolean {
  const leftWord = left.isWordLike === true;
  const rightWord = right.isWordLike === true;
  if (!leftWord && !rightWord) {
    // Punctuation and spaces run together, cut before an opening bracket and after a closing one.
    return !OPENING_BRACKET.test(right.segment) && !CLOSING_BRACKET.test(left.segment);
  }
  if (!leftWord || !rightWord) {
    return false;
  }
  if (CLOSING_PARTICLES.has(left.segment)) {
    return false;
  }
  // A ー ending the left segment counts as katakana, so すごー / い still joins.
  const last = classOf(LAST_BASE.exec(left.segment)?.[0].codePointAt(0));
  switch (classOf(right.segment.codePointAt(0))) {
    case 'hiragana':
    case 'prolonged':
      return last !== 'other';
    case 'kanji':
      return last === 'kanji';
    case 'katakana':
      return last === 'katakana' || last === 'prolonged';
    case 'other':
      return false;
  }
}

/** Where the commands stop on `line`: the start of every group, then the line's end. */
export function groupStops(line: string, segments: Iterable<WordSegment>): number[] {
  const stops = [0];
  let prev: WordSegment | undefined;
  for (const seg of segments) {
    if (prev !== undefined && !joins(prev, seg)) {
      stops.push(seg.index);
    }
    prev = seg;
  }
  if (line.length > 0) {
    stops.push(line.length);
  }
  return stops;
}

let segmenter: Intl.Segmenter | undefined;

function segmentsOf(line: string): Intl.Segments {
  segmenter ??= new Intl.Segmenter('ja', { granularity: 'word' });
  return segmenter.segment(line);
}

/** The last stop before `offset`: the start of the group holding the character before it. Only
 *  the segments walked are read (`containing` cuts one at a time, and ICU bounds its dictionary
 *  work at punctuation), so a held ⌥⌫ on a long line costs the group, not the line. */
export function stopBefore(text: string, offset: number): number {
  const segments = segmentsOf(text);
  for (let seg = segments.containing(offset - 1); seg !== undefined;) {
    const prev = segments.containing(seg.index - 1);
    if (prev === undefined || !joins(prev, seg)) {
      return seg.index;
    }
    seg = prev;
  }
  return 0;
}

/** The first stop after `offset`: the end of the group holding the character at it. */
export function stopAfter(text: string, offset: number): number {
  const segments = segmentsOf(text);
  for (let seg = segments.containing(offset); seg !== undefined;) {
    const end = seg.index + seg.segment.length;
    const next = segments.containing(end);
    if (next === undefined || !joins(seg, next)) {
      return end;
    }
    seg = next;
  }
  return text.length;
}

/** A position in the shape of `vscode.Position`. */
export interface Pos {
  readonly line: number;
  readonly character: number;
}

export interface Span {
  readonly start: Pos;
  readonly end: Pos;
}

/** The part of `vscode.TextDocument` the commands read. */
export interface Lines {
  readonly lineCount: number;
  lineAt(line: number): { readonly text: string };
}

/**
 * Where ⌥← goes: the start of the group before `at`. From a line's start it goes to the start
 * of the last group on the line above, as VS Code's own command does.
 */
export function wordLeft(doc: Lines, at: Pos): Pos {
  if (at.character > 0) {
    return { line: at.line, character: stopBefore(doc.lineAt(at.line).text, at.character) };
  }
  if (at.line === 0) {
    return at;
  }
  const above = doc.lineAt(at.line - 1).text;
  return { line: at.line - 1, character: stopBefore(above, above.length) };
}

/**
 * Where ⌥→ goes: the end of the group after `at`. From a line's end it goes to the end of the
 * first group on the line below, as VS Code's own command does.
 */
export function wordRight(doc: Lines, at: Pos): Pos {
  const text = doc.lineAt(at.line).text;
  if (at.character < text.length) {
    return { line: at.line, character: stopAfter(text, at.character) };
  }
  if (at.line === doc.lineCount - 1) {
    return at;
  }
  return { line: at.line + 1, character: stopAfter(doc.lineAt(at.line + 1).text, 0) };
}

/** What ⌥⌫ deletes from a caret: back to where ⌥← goes, but only the line break at a line's start. */
export function deleteLeft(doc: Lines, at: Pos): Span | null {
  if (at.character > 0) {
    return { start: wordLeft(doc, at), end: at };
  }
  if (at.line === 0) {
    return null;
  }
  return { start: { line: at.line - 1, character: doc.lineAt(at.line - 1).text.length }, end: at };
}

/** What ⌥⌦ deletes from a caret: up to where ⌥→ goes, but only the line break at a line's end. */
export function deleteRight(doc: Lines, at: Pos): Span | null {
  if (at.character < doc.lineAt(at.line).text.length) {
    return { start: at, end: wordRight(doc, at) };
  }
  if (at.line === doc.lineCount - 1) {
    return null;
  }
  return { start: at, end: { line: at.line + 1, character: 0 } };
}

function compare(a: Pos, b: Pos): number {
  return a.line - b.line || a.character - b.character;
}

/** `spans` in order, with overlapping or touching ones merged: an edit rejects overlapping ranges. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans.toSorted((a, b) => compare(a.start, b.start))) {
    const prev = out.at(-1);
    if (prev !== undefined && compare(span.start, prev.end) <= 0) {
      out[out.length - 1] = { start: prev.start, end: compare(span.end, prev.end) > 0 ? span.end : prev.end };
    } else {
      out.push(span);
    }
  }
  return out;
}
