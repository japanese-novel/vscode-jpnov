/**
 * The lint walker: one pass over the lines as shown (shown.ts) that yields one {@link LintLine}
 * per source line. The views are the line as its reader sees it, the AST's content: what is
 * judged is what is shown, and each unit remembers where it was written. The pieces and the
 * carriers are the walker's; the dialogue depth is shown.ts's; the line's 字下げ and 見出し are the AST's.
 *
 * Semantics (each guarded by walker.test.ts):
 *   - The dialogue is shown.ts's, shared with the highlighter: fed the PROSE runs only — the
 *     「対象」 of ［＃「対象」に傍点］, a 「 inside an unclosed ［＃ and whatever a value shows never
 *     open an utterance (the Aozora trap). What an annotation shows takes the depth where it sits.
 *   - A unit typed as body text names its piece (verbatim, contiguous, one depth);
 *     a unit an annotation shows names none. Every unit names its carrier: its run, the atomic
 *     cell it is inside (a ruby, a 縦中横), or the ［＃○字下げ］ that shows it.
 *   - A carrier's outer extents say where an insert at its edge lands: outside the decorations
 *     wrapping it. Backward, an insert passes the span starts whose channel decorates the carrier
 *     (its marks, the 縦中横 it is, the line's 見出し). Forward, it passes every postfix, reading
 *     and dangling end, and the paired ends of those channels; it passes other span starts and
 *     ends only while such an end is still to come on the line. A comment is transparent both
 *     ways. The walk starts only where the carrier's edge is a node edge.
 *   - Offsets are per UTF-16 unit (astral chars = two consecutive units), matching
 *     `TextDocument.positionAt`; a composed kana is one unit whose source is two.
 *
 * A view keeps its units in one flat array of numbers (where each was written, its depth, its
 * piece and its carrier, the last two indexing the line's lists), and makes a {@link ProseUnit}
 * only when a rule asks for one: the walk allocates per line, not per character.
 *
 * Lines are NEVER merged: a multi-line utterance yields one line per source line with
 * `openDepthAtEnd` > 0, and the 〇 sentinel lands on the line holding the utterance's first
 * interior unit. No LSP types: offsets only.
 */
import type { Ast, Line, Marks, Ruby, Span, SpanCloserNode, SyntaxNode, Tcy, TcySpanEndNode, TextNode } from '../../shared/ast/nodes.ts';
import type { Channel } from '../../shared/ast/notation.ts';
import { isFixedOrigin } from '../../shared/ast/span.ts';
import { DASH_CHARS } from '../../shared/dash.ts';
import { partitionPoint } from '../../shared/utils/lists.ts';
import { charClass } from '../../shared/utils/regex.ts';
import { shownLines } from '../shown.ts';
import type { ShownLine } from '../shown.ts';

import { isSpace } from './prescan.ts';
import { splitSentences } from './sentences.ts';
import type { Carrier, LintLine, Piece, ProseUnit, ProseView, SentenceSpan, SourceSlice } from './types.ts';

/** The narration placeholder for a collapsed utterance interior: never in the prose view, so it
 *  joins no run; one square to a sentence rule. */
const SENTINEL = '〇';

/** The dialogue view's separator between two utterances. */
const SEPARATOR = '\n';

/** What a node is to an insert walking over it. Exhaustive: a new node kind is a compile error. */
type Role = 'start' | 'end' | 'postfix' | 'reading' | 'comment' | 'other';
const ROLE: Record<SyntaxNode['kind'], Role> = {
  text: 'other',
  rubyMark: 'start',
  rubyReading: 'reading',
  rubyLeftPostfix: 'postfix',
  emphasisPostfix: 'postfix',
  emphasisSpanStart: 'start',
  emphasisSpanEnd: 'end',
  tcyPostfix: 'postfix',
  tcySpanStart: 'start',
  tcySpanEnd: 'end',
  headingPostfix: 'postfix',
  headingSpanStart: 'start',
  headingSpanEnd: 'end',
  comment: 'comment',
  brokenAnnotation: 'other',
  pageBreak: 'other',
  indent: 'other',
  indentBlockStart: 'other',
  indentBlockEnd: 'other',
  valueField: 'other',
  gaiji: 'other',
};

/** What a span start or end wraps: a decoration channel, the 見出し, the 縦中横. */
type Wrap = Channel | 'heading' | 'tcy';

function wrapOf(node: SyntaxNode): Wrap | null {
  switch (node.kind) {
    case 'emphasisSpanStart':
    case 'emphasisSpanEnd':
      return node.channel;
    case 'headingSpanStart':
    case 'headingSpanEnd':
      return 'heading';
    case 'tcySpanStart':
    case 'tcySpanEnd':
      return 'tcy';
    default:
      return null;
  }
}

function isSpanEnd(node: SyntaxNode): node is SpanCloserNode | TcySpanEndNode {
  return ROLE[node.kind] === 'end';
}

/** Any character that makes a line PROSE: kana, kanji, or alphanumerics of either width. */
const WORD_CHAR = /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}A-Za-z0-9Ａ-Ｚａ-ｚ０-９]/u;

/** A line of nothing but leaders/dashes (whitespace allowed) is a PAUSE — prose, not ornament:
 *  a silence paragraph reads as a sentence, so the strict convention gives it its 字下げ and 。
 *  (…… is not a sentence ender), exactly like any other narration line. */
const PAUSE_ONLY = new RegExp(`^[ \\t　…‥${charClass(DASH_CHARS)}]+$`);

/** {@link LintLine.inset}: a hand-written ornament line (＊, ◇＊◇), or a bullet line (・…). */
function isInset(text: string): boolean {
  if (text !== '' && !WORD_CHAR.test(text) && !PAUSE_ONLY.test(text)) {
    return true;
  }
  let k = 0;
  while (k < text.length && isSpace(text.charAt(k))) {
    k += 1;
  }
  return text.charAt(k) === '・';
}

/** A carrier while its line is built: the extents are set once the line's units are known. */
interface OpenCarrier extends Carrier {
  outerStart: number;
  outerEnd: number;
  /** The decorations on it, any of which an insert must get out of: a run's own, a cell's and its runs'. */
  readonly marks: readonly Marks[];
  readonly tcy: boolean;
}

/**
 * The units of a view, {@link STRIDE} numbers each in one flat array: where it was written, its
 * depth, its piece and its carrier (indices into the line's lists, -1 for none). A plain array of
 * small integers, filled in order: a manuscript has many more lines than a line has characters,
 * and a typed array costs more to make than a short line's worth of numbers (measured on #261).
 */
const SRC = 0;
const END = 1;
const DEPTH = 2;
const PIECE = 3;
const CARRIER = 4;
const STRIDE = 5;

/** Appends a synthetic unit: written nowhere (`[src, src)`), 地の文, no piece, no carrier. */
function synthetic(cols: number[], src: number): void {
  cols.push(src, src, 0, -1, -1);
}

/** Appends the units `[a, b)` of `from` to `to`. */
function copy(from: readonly number[], a: number, b: number, to: number[]): void {
  for (let i = a * STRIDE; i < b * STRIDE; i += 1) {
    to.push(from[i] ?? 0);
  }
}

/** A view over its units; the narration and the dialogue views are derived from the prose one. */
class View implements ProseView {
  readonly text: string;
  private readonly cols: readonly number[];
  private readonly pieces: readonly Piece[];
  private readonly carriers: readonly Carrier[];

  constructor(text: string, cols: readonly number[], pieces: readonly Piece[], carriers: readonly Carrier[]) {
    this.text = text;
    this.cols = cols;
    this.pieces = pieces;
    this.carriers = carriers;
  }

  unit(k: number): ProseUnit | undefined {
    const { cols } = this;
    const i = k * STRIDE;
    const src = cols[i + SRC];
    if (src === undefined) {
      return undefined;
    }
    return {
      src,
      end: cols[i + END] ?? src,
      depth: cols[i + DEPTH] ?? 0,
      piece: this.pieces[cols[i + PIECE] ?? -1] ?? null,
      carrier: this.carriers[cols[i + CARRIER] ?? -1] ?? null,
    };
  }

  private depthAt(k: number): number {
    return this.cols[k * STRIDE + DEPTH] ?? 0;
  }

  /**
   * The units of one side of depth 0, by maximal runs. The narration (`narration` true) keeps
   * the depth-0 units and puts the 〇 sentinel where the run at `sentinelAt` (the interior of
   * the top-level utterance opened on this line) was; the dialogue keeps the interiors, a '\n'
   * separator between two of them, just past the previous unit (it separates two utterances,
   * so a previous unit always exists).
   */
  side(narration: boolean, sentinelAt = -1): View {
    const n = this.text.length;
    const out: number[] = [];
    let text = '';
    for (let k = 0; k < n;) {
      const kept = (this.depthAt(k) === 0) === narration;
      let j = k + 1;
      while (j < n && (this.depthAt(j) === 0) === narration === kept) {
        j += 1;
      }
      if (!kept) {
        if (k === sentinelAt) {
          synthetic(out, this.cols[k * STRIDE + SRC] ?? 0);
          text += SENTINEL;
        }
      } else {
        if (!narration && out.length > 0) {
          synthetic(out, out[out.length - STRIDE + END] ?? 0);
          text += SEPARATOR;
        }
        copy(this.cols, k, j, out);
        text += this.text.slice(k, j);
      }
      k = j;
    }
    return new View(text, out, this.pieces, this.carriers);
  }
}

/** The dialogue view of a line with no utterance on it. */
const NO_DIALOGUE = new View('', [], [], []);

/** One {@link LintLine}: what the builder found, and the views, the slices and the memos made when asked. */
class Built implements LintLine {
  readonly srcLine: number;
  readonly srcStart: number;
  readonly srcEnd: number;
  readonly indent: number;
  readonly heading: LintLine['heading'];
  readonly directiveOnly: boolean;
  readonly blank: boolean;
  readonly openDepthAtEnd: number;
  readonly pieces: readonly Piece[];
  private readonly syntax: readonly SyntaxNode[];
  private readonly proseView: View;
  private readonly spoken: boolean;
  private readonly sentinelAt: number;
  private slices: readonly SourceSlice[] | undefined = undefined;
  private narrView: View | undefined = undefined;
  private diaView: View | undefined = undefined;
  private readonly sentenceMemo: { narration?: readonly SentenceSpan[]; dialogue?: readonly SentenceSpan[] } = {};
  private insetFlag: boolean | undefined = undefined;

  constructor(line: Line, openDepthAtEnd: number, prose: View, pieces: readonly Piece[], spoken: boolean, sentinelAt: number) {
    const blank = line.syntax.length === 0;
    this.srcLine = line.index;
    this.srcStart = line.span.start;
    this.srcEnd = line.span.end;
    this.indent = line.indent;
    this.heading = line.heading;
    this.directiveOnly = !blank && pieces.length === 0;
    this.blank = blank;
    this.openDepthAtEnd = openDepthAtEnd;
    this.pieces = pieces;
    this.syntax = line.syntax;
    this.proseView = prose;
    this.spoken = spoken;
    this.sentinelAt = sentinelAt;
  }

  get source(): readonly SourceSlice[] {
    return (this.slices ??= slicesOf(this.syntax));
  }

  prose(): ProseView {
    return this.proseView;
  }

  narration(): ProseView {
    return this.spoken ? (this.narrView ??= this.proseView.side(true, this.sentinelAt)) : this.proseView;
  }

  dialogue(): ProseView {
    return this.spoken ? (this.diaView ??= this.proseView.side(false)) : NO_DIALOGUE;
  }

  sentences(view: 'narration' | 'dialogue'): readonly SentenceSpan[] {
    return (this.sentenceMemo[view] ??= splitSentences(this[view]()));
  }

  inset(): boolean {
    return (this.insetFlag ??= isInset(this.proseView.text));
  }
}

/** The line as source slices: every markup node on its own, the text between them joined. */
function slicesOf(nodes: readonly SyntaxNode[]): SourceSlice[] {
  const out: SourceSlice[] = [];
  let joinable = false; // the last slice is text, and nothing but text may extend it
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (node.kind === 'text' && joinable && last !== undefined && last.srcStart + last.text.length === node.span.start) {
      out[out.length - 1] = { text: last.text + node.text, srcStart: last.srcStart };
    } else {
      out.push({ text: node.text, srcStart: node.span.start });
    }
    joinable = node.kind === 'text';
  }
  return out;
}

/** Builds one line: its units with their pieces and carriers, and the views over them. */
class LineBuilder {
  private readonly line: Line;
  private readonly ast: Ast;
  private readonly shown: ShownLine;
  /** The prose view's units, appended in display order. */
  private readonly cols: number[] = [];
  private readonly pieces: Piece[] = [];
  private readonly carriers: OpenCarrier[] = [];
  /** Whether any unit sits inside an utterance: without one, the narration is the prose view itself. */
  private spoken = false;
  /** The prose index of the unit the 〇 sentinel precedes, -1 when the line gets none. */
  private sentinelAt = -1;

  /** The piece under construction: the source it covers so far, from the node at `first` on (an
   *  implicit ruby base is its own text node, flush with the text before it) to `nodeEnd`, the end
   *  of the node holding its last unit; its text is cut once it closes. */
  private open: { readonly first: number; readonly srcStart: number; srcEnd: number; nodeEnd: number; readonly depth: number } | null = null;
  /** The cursor over the line's nodes: `nodes[cursor]` is the first node not ending before the last unit placed. */
  private cursor = 0;

  constructor(line: Line, ast: Ast, shown: ShownLine) {
    this.line = line;
    this.ast = ast;
    this.shown = shown;
  }

  /** The text node holding `[src, end)` whole, or null. Units come in source order, so the cursor only advances. */
  private textNodeAt(src: number, end: number): TextNode | null {
    const nodes = this.line.syntax;
    while ((nodes[this.cursor]?.span.end ?? Infinity) <= src) {
      this.cursor += 1;
    }
    const node = nodes[this.cursor];
    return node?.kind === 'text' && node.span.start <= src && end <= node.span.end ? node : null;
  }

  private closePiece(): void {
    const open = this.open;
    if (open === null) {
      return;
    }
    const { srcStart, srcEnd, depth } = open;
    let text = '';
    // Contiguous in the source, so every node from the first to the one holding the end is text.
    for (let i = open.first; (this.line.syntax[i]?.span.start ?? Infinity) < srcEnd; i += 1) {
      const node = this.line.syntax[i];
      if (node !== undefined) {
        text += node.text.slice(Math.max(srcStart, node.span.start) - node.span.start, Math.min(srcEnd, node.span.end) - node.span.start);
      }
    }
    this.pieces.push({ text, srcStart, depth });
    this.open = null;
  }

  /** The index of the piece a typed unit at `[src, end)` names: the open one when it continues it
   *  (contiguous, same depth), else a new one; -1 when no text node holds it whole. */
  private pieceFor(src: number, end: number, depth: number): number {
    const open = this.open;
    if (open !== null && open.srcEnd === src && open.depth === depth && end <= open.nodeEnd) {
      open.srcEnd = end; // the common case: the next unit of the same node
      return this.pieces.length;
    }
    const node = this.textNodeAt(src, end);
    if (node === null) {
      this.closePiece();
      return -1;
    }
    if (open?.srcEnd !== src || open.depth !== depth) {
      this.closePiece();
      this.open = { first: this.cursor, srcStart: src, srcEnd: end, nodeEnd: node.span.end, depth };
    } else {
      open.srcEnd = end;
      open.nodeEnd = node.span.end;
    }
    return this.pieces.length;
  }

  private carrier(kind: Carrier['kind'], span: Span, marks: readonly Marks[], tcy: boolean): number {
    this.carriers.push({ kind, src: span.start, end: span.end, outerStart: span.start, outerEnd: span.end, marks, tcy });
    return this.carriers.length - 1;
  }

  /** Places the units; `placeheld` says whether the open top-level utterance has emitted its 〇 yet, in and out. */
  run(placeheld: boolean): boolean {
    const { cols } = this;
    const { runs, segments } = this.shown;
    let inCell = null as { readonly cell: Ruby | Tcy; readonly carrier: number } | null;
    let s = 0; // the segment cursor: segments tile the text in display order, as the runs do
    for (const { run, cell, from, clusters } of runs) {
      const to = from + run.text.length;
      let carrier: number;
      if (cell === null) {
        inCell = null;
        carrier = this.carrier(run.origin === 'indent' ? 'indent' : 'run', run.span, [run.marks], false);
      } else {
        if (inCell?.cell !== cell) {
          inCell = { cell, carrier: this.carrier('cell', cell.span, [cell.marks, ...cell.runs.map((r) => r.marks)], cell.kind === 'tcy') };
        }
        carrier = inCell.carrier;
      }
      const prose = run.origin === 'prose';
      const fixed = isFixedOrigin(run.origin); // every character sits at its annotation
      let c = 0; // the cluster cursor, and the display units into the current cluster
      let o = 0;
      for (let seg = segments[s]; seg !== undefined && seg.from < to; seg = segments[s]) {
        s += 1;
        if (seg.depth > 0) {
          this.spoken = true;
          if (!placeheld) {
            this.sentinelAt = seg.from; // the utterance's first interior unit
            placeheld = true;
          }
        } else if (seg.kind === 'open') {
          placeheld = false; // a new top-level utterance; its 〇 is emitted lazily
        }
        for (let k = seg.from; k < seg.to; k += 1) {
          let src = run.span.start;
          let end = run.span.end;
          if (clusters !== null) {
            let cluster = clusters[c];
            while (cluster !== undefined && o >= cluster.text.length) {
              c += 1;
              o = 0;
              cluster = clusters[c];
            }
            src = (cluster?.start ?? run.span.end) + o;
            end = cluster?.text.length === o + 1 ? cluster.end : src + 1;
            o += 1;
          } else if (!fixed) {
            src = run.span.start + (k - from);
            end = src + 1;
          }
          cols.push(src, end, seg.depth, prose ? this.pieceFor(src, end, seg.depth) : -1, carrier);
        }
      }
    }
    this.closePiece();
    this.extend();
    return placeheld;
  }

  /** Whether `wrap` decorates `carrier`: an insert at its edge must get out of it. */
  private decorates(carrier: OpenCarrier, wrap: Wrap): boolean {
    switch (wrap) {
      case 'tcy':
        return carrier.tcy;
      case 'heading':
        return this.line.heading !== undefined;
      default:
        return carrier.marks.some((marks) => marks[wrap] !== undefined);
    }
  }

  /** Sets the outer extents of every carrier (see the file header). */
  private extend(): void {
    const nodes = this.line.syntax;
    const { pairs } = this.ast;
    /** Per wrap, the index of the last paired end on the line: whether an end is still to come. */
    const lastEnd = new Map<Wrap, number>();
    for (const [i, node] of nodes.entries()) {
      const wrap = wrapOf(node);
      if (wrap !== null && isSpanEnd(node) && pairs.has(node)) {
        lastEnd.set(wrap, i);
      }
    }
    for (const carrier of this.carriers) {
      // Backward, over the span starts that decorate the carrier.
      const before = partitionPoint(nodes, (node) => node.span.start >= carrier.src);
      if (nodes[before]?.span.start === carrier.src) {
        let at = carrier.src;
        for (let i = before - 1; i >= 0; i -= 1) {
          const node = nodes[i];
          if (node === undefined) {
            break;
          }
          const role = ROLE[node.kind];
          if (role === 'comment' || role === 'postfix' || (isSpanEnd(node) && !pairs.has(node))) {
            continue; // transparent
          }
          const wrap = wrapOf(node);
          if (role === 'start' && (wrap === null || this.decorates(carrier, wrap))) {
            at = node.span.start; // a ｜ (no wrap) sits inside its cell's span, so it is never met here
            continue;
          }
          break;
        }
        carrier.outerStart = at;
      }

      // Forward, over the postfixes, the readings and the ends of the channels still to close.
      const after = partitionPoint(nodes, (node) => node.span.start >= carrier.end);
      if (nodes[after - 1]?.span.end === carrier.end) {
        let want: Set<Wrap> | null = null; // the wraps to get out of, built at the first span node met
        let at = carrier.end;
        for (let i = after; i < nodes.length; i += 1) {
          const node = nodes[i];
          if (node === undefined) {
            break;
          }
          const role = ROLE[node.kind];
          if (role === 'comment') {
            continue;
          }
          if (role === 'postfix' || role === 'reading' || (isSpanEnd(node) && !pairs.has(node))) {
            at = node.span.end;
            continue;
          }
          if (role !== 'start' && role !== 'end') {
            break;
          }
          want ??= new Set([...lastEnd].filter(([wrap, last]) => last >= after && this.decorates(carrier, wrap)).map(([wrap]) => wrap));
          const wrap = wrapOf(node);
          if (role === 'end' && wrap !== null && want.has(wrap)) {
            want.delete(wrap);
            at = node.span.end;
            continue;
          }
          if (want.size === 0) {
            break;
          }
        }
        carrier.outerEnd = at;
      }
    }
  }

  freeze(): LintLine {
    const prose = new View(this.shown.text, this.cols, this.pieces, this.carriers);
    return new Built(this.line, this.shown.depthAtEnd, prose, this.pieces, this.spoken, this.sentinelAt);
  }
}

/**
 * Walks `ast` and yields one {@link LintLine} per source line, INCLUDING the final line (even
 * when empty — the line after the final terminator; what it means is each rule's call). Line
 * numbers are the AST's, which are LSP's. `shown` is the manuscript's lines as shown (the parse
 * cache keeps them per version); made here when the caller has none.
 */
export function* walkLines(ast: Ast, shown: readonly ShownLine[] = shownLines(ast)): Generator<LintLine, void, undefined> {
  let placeheld = false;
  for (const shownLine of shown) {
    const builder = new LineBuilder(shownLine.line, ast, shownLine);
    placeheld = builder.run(placeheld);
    yield builder.freeze();
  }
}
