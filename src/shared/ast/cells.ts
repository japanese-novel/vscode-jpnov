/**
 * The cells of a line while it is being resolved: what a corner-target postfix is matched
 * against and rewrites, and what becomes the line's content.
 */
import { composeKana, displayChars, displayText, isClusterBoundary } from '../chars.ts';
import type { ComposedChar } from '../chars.ts';

import { partitionPoint } from '../utils/lists.ts';
import type { Chars, CharsOrigin, CommentInline, Inline, Mark, Marks, Ruby, Span, SyntaxNode, Tcy } from './nodes.ts';
import { CHANNELS } from './notation.ts';
import type { Channel } from './notation.ts';
import { clusterStarts, runsIn } from './span.ts';

/** Where a run of display characters came from, shared by the pieces it is cut into. */
interface Source {
  /** Source offset of the text the characters were taken from. */
  readonly start: number;
  /** A substituted value or a 外字注記: every piece maps to this one span. */
  readonly fixed: Span | null;
  /** The display characters with their source ranges, when showing changed the text. */
  readonly chars: readonly ComposedChar[] | null;
}

/** A run of per-cell characters. */
export interface CharsCell {
  readonly kind: 'chars';
  readonly source: Source;
  readonly origin: CharsOrigin;
  readonly text: string;
  /** Display offset of `text` within its source's display text. */
  readonly from: number;
  readonly marks: Marks;
}

export type Cell = CharsCell | Ruby | Tcy | CommentInline;

/**
 * The cell of `raw` as `node` shows it ({@link displayText}: characters no output can carry
 * dropped, kana composed); null when it shows nothing.
 */
export function charsCell(node: SyntaxNode, raw: string, origin: CharsOrigin, marks: Marks): CharsCell | null {
  const text = displayText(raw);
  if (text === '') {
    return null;
  }
  const fixed = origin === 'value' || origin === 'gaiji' ? node.span : null;
  const chars = fixed !== null || text === raw ? null : displayChars(raw);
  return { kind: 'chars', source: { start: node.span.start, fixed, chars }, origin, text, from: 0, marks };
}

/** The source offset of display offset `at` of `source`. */
function sourceAt(source: Source, at: number): number {
  if (source.chars === null) {
    return source.start + at;
  }
  let shown = 0;
  for (const ch of source.chars) {
    if (shown >= at) {
      return source.start + ch.start;
    }
    shown += ch.text.length;
  }
  return source.start + (source.chars[source.chars.length - 1]?.end ?? 0);
}

export function spanOf(cell: Cell): Span {
  if (cell.kind !== 'chars') {
    return cell.span;
  }
  return cell.source.fixed ?? {
    start: sourceAt(cell.source, cell.from),
    end: sourceAt(cell.source, cell.from + cell.text.length),
  };
}

/** The text a postfix target is matched against; '' for a zero-width cell. */
export function textOf(cell: Cell): string {
  switch (cell.kind) {
    case 'chars':
    case 'tcy':
      return cell.text;
    case 'ruby':
      return cell.base;
    case 'comment':
      return '';
  }
}

function cut(cell: CharsCell, at: number): [CharsCell, CharsCell] {
  return [
    { ...cell, text: cell.text.slice(0, at) },
    { ...cell, text: cell.text.slice(at), from: cell.from + at },
  ];
}

/**
 * The cells of one line as it is resolved, with where each ends in their concatenated text and
 * what each target has been searched for so far: a line may carry thousands of postfixes, and
 * each search reads only the text written since the last one for the same target. The text
 * only grows: a cut or a replacement moves cell boundaries, never a text offset, and a ｜ base
 * is truncated before anything binds to it — so what a search found stays where it was.
 */
export class LineCells {
  private readonly cells: Cell[] = [];
  /** `ends[i]`: the text length of `cells[0..i]`; a zero-width cell repeats the one before. */
  private readonly ends: number[] = [];
  /** Per target: the text length searched, and the last occurrence found below it (-1: none). */
  private readonly searched = new Map<string, { upTo: number; pos: number }>();

  get items(): readonly Cell[] {
    return this.cells;
  }

  get length(): number {
    return this.cells.length;
  }

  private get textLength(): number {
    return this.ends[this.ends.length - 1] ?? 0;
  }

  push(cell: Cell): void {
    this.cells.push(cell);
    this.ends.push(this.textLength + textOf(cell).length);
  }

  /** Removes and returns `cells[from..]`. */
  truncate(from: number): Cell[] {
    const removed = this.cells.splice(from);
    this.ends.length = this.cells.length;
    return removed;
  }

  /** `cells.splice(first, count, ...items)` for any number of items; the text they show is the text they replace. */
  replace(first: number, count: number, items: readonly Cell[]): void {
    const after = this.truncate(first).slice(count);
    for (const cell of items) {
      this.push(cell);
    }
    for (const cell of after) {
      this.push(cell);
    }
  }

  /** `cells[index] = cell`, for a cell showing the same text with other marks. */
  set(index: number, cell: Cell): void {
    this.cells[index] = cell;
  }

  /** The start of the last occurrence of `target` in the concatenated text, or -1. */
  private find(target: string): number {
    const entry = this.searched.get(target);
    // Read back from the end, each stretch as long as all read before it: the last occurrence is
    // met first, long before the head of a long line. Text searched for this target before is
    // read again only as far as an occurrence could straddle its edge.
    const floor = entry === undefined ? 0 : Math.max(0, entry.upTo - target.length + 1);
    const { cells, ends } = this;
    let text = '';
    let from = cells.length; // cells[from..] are read
    const unread = (): boolean => (ends[from - 1] ?? 0) > floor;
    let pos = -1;
    while (pos === -1 && unread()) {
      const want = Math.max(target.length, text.length, 64);
      let stretch = '';
      while (stretch.length < want && unread()) {
        from -= 1;
        const cell = cells[from];
        stretch = (cell === undefined ? '' : textOf(cell)) + stretch;
      }
      text = stretch + text;
      pos = text.lastIndexOf(target);
      if (pos !== -1) {
        pos += ends[from - 1] ?? 0;
      }
    }
    if (pos === -1 && entry !== undefined) {
      pos = entry.pos;
    }
    this.searched.set(target, { upTo: this.textLength, pos });
    return pos;
  }

  /**
   * The LAST occurrence of `target` in the cells' concatenated text, as an inclusive index range
   * of WHOLE cells — a character run is cut where the match starts and ends; a match cutting into
   * a ruby or a 縦中横 cell is none. Only that last occurrence is tested (the spec's forward
   * references sit next to their target).
   */
  match(target: string): { first: number; last: number } | null {
    if (target === '') {
      return null;
    }
    const pos = this.find(target);
    if (pos === -1) {
      return null;
    }
    const { cells, ends } = this;
    const end = pos + target.length;
    let first = partitionPoint(ends, (cellEnd) => cellEnd > pos); // the cell whose text runs past `pos`
    let last = partitionPoint(ends, (cellEnd) => cellEnd >= end);
    const headCell = cells[first];
    const tailCell = cells[last];
    if (headCell === undefined || tailCell === undefined) {
      return null;
    }
    const headAt = pos - (ends[first - 1] ?? 0);
    const tailAt = end - (ends[last - 1] ?? 0);
    const tailEnd = ends[last] ?? 0;
    if (headAt !== 0 && (headCell.kind !== 'chars' || !isClusterBoundary(headCell.text, headAt))) {
      return null;
    }
    if (end !== tailEnd && (tailCell.kind !== 'chars' || !isClusterBoundary(tailCell.text, tailAt))) {
      return null;
    }
    if (end !== tailEnd && tailCell.kind === 'chars') {
      cells.splice(last, 1, ...cut(tailCell, tailAt));
      ends.splice(last, 0, end);
    }
    const cutHead = cells[first];
    if (headAt !== 0 && cutHead?.kind === 'chars') {
      cells.splice(first, 1, ...cut(cutHead, headAt));
      ends.splice(first, 0, pos);
      first += 1;
      last += 1;
    }
    return { first, last };
  }
}

/** `marks` with `channel` set to `mark`, or cleared when `mark` is undefined. */
export function withMark(marks: Marks, channel: Channel, mark: Mark | undefined): Marks {
  const out: Partial<Record<Channel, Mark>> = {};
  for (const ch of CHANNELS) {
    const m = ch === channel ? mark : marks[ch];
    if (m !== undefined) {
      out[ch] = m;
    }
  }
  return out;
}

/** `marks`, each channel it leaves off taken from the first of `cells` that sets it. */
export function withMarksOf(marks: Marks, cells: readonly Cell[]): Marks {
  let out = marks;
  for (const cell of cells) {
    if (cell.kind !== 'comment') {
      for (const ch of CHANNELS) {
        if (out[ch] === undefined && cell.marks[ch] !== undefined) {
          out = withMark(out, ch, cell.marks[ch]);
        }
      }
    }
  }
  return out;
}

function sameMarks(a: Marks, b: Marks): boolean {
  return a === b || CHANNELS.every((ch) => a[ch]?.variant === b[ch]?.variant && a[ch]?.left === b[ch]?.left);
}

/**
 * Where each character of `cell` was written, when its source shows differently; null when
 * each sits at its span start plus its offset. `from` counts the display text, so the walk adds
 * up display lengths.
 */
function startsOf(cell: CharsCell): number[] | null {
  const { source } = cell;
  if (source.chars === null) {
    return null;
  }
  const starts: number[] = [];
  const end = cell.from + cell.text.length;
  let shown = 0;
  for (const ch of source.chars) {
    if (shown >= end) {
      break;
    }
    if (shown >= cell.from) {
      starts.push(source.start + ch.start);
    }
    shown += ch.text.length;
  }
  return starts;
}

/** The cells as content: adjacent pieces of one source with equal marks rejoin into one run. */
export function contentOf(cells: readonly Cell[]): Inline[] {
  const runs: Cell[] = [];
  for (const cell of cells) {
    const run = runs[runs.length - 1];
    if (
      cell.kind === 'chars' &&
      run?.kind === 'chars' &&
      run.source === cell.source &&
      run.from + run.text.length === cell.from &&
      sameMarks(run.marks, cell.marks)
    ) {
      runs[runs.length - 1] = { ...run, text: run.text + cell.text };
    } else {
      runs.push(cell);
    }
  }
  return runs.map((run): Inline => {
    if (run.kind !== 'chars') {
      return run;
    }
    // `starts` goes last: spread mid-literal, V8 builds every run on its slow path once one has it.
    const starts = startsOf(run);
    return { kind: 'chars', text: run.text, span: spanOf(run), origin: run.origin, marks: run.marks, ...(starts === null ? {} : { starts }) };
  });
}

/**
 * `a` then `b` as one run when a kana ending `a` composes with a mark opening `b`: the cell shows
 * them as one character, whatever markup sat between. Null when they stay two runs.
 */
function composed(a: Chars, b: Chars): Chars | null {
  const text = composeKana(a.text + b.text);
  if (text.length === a.text.length + b.text.length) {
    return null;
  }
  const starts = [...clusterStarts(a), ...clusterStarts(b).slice(1)];
  return { kind: 'chars', text, span: { start: a.span.start, end: b.span.end }, origin: a.origin, marks: a.marks, starts };
}

/**
 * The runs of `cells` as an atomic cell joins them: its own runs, those of a ruby or a 縦中横 among
 * them, and a kana and its mark composed across a boundary.
 */
export function runsOf(cells: readonly Cell[]): Chars[] {
  const runs: Chars[] = [];
  for (const run of runsIn(contentOf(cells))) {
    const last = runs[runs.length - 1];
    const joined = last === undefined ? null : composed(last, run);
    if (joined === null) {
      runs.push(run);
    } else {
      runs[runs.length - 1] = joined;
    }
  }
  return runs;
}

/** The text of `runs` joined: what an atomic cell shows. */
export function textOfRuns(runs: readonly Chars[]): string {
  return runs.map((run) => run.text).join('');
}
