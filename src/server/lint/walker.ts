/**
 * The lint walker: one pass over the AST that yields one {@link LintLine} per source line. The
 * views are the line as its reader sees it, the AST's content (shown.ts): what is judged is what
 * is shown, and each unit remembers where it was written. The pieces, the carriers and the
 * dialogue depth are the walker's; the line's 字下げ and 見出し are the AST's.
 *
 * Semantics (each guarded by walker.test.ts):
 *   - The dialogue stack is dialogue.ts's, shared with the highlighter, and is fed the PROSE runs
 *     only — the 「対象」 of ［＃「対象」に傍点］, a 「 inside an unclosed ［＃ and whatever a value
 *     shows never open an utterance (the Aozora trap). What an annotation shows takes the depth
 *     where it sits.
 *   - A unit typed as body text names its piece (verbatim, contiguous, one depth); a unit an
 *     annotation shows names none. Every unit names its carrier: its run, the atomic cell it is
 *     inside (a ruby, a 縦中横), or the ［＃○字下げ］ that shows it.
 *   - A carrier's outer extents say where an insert at its edge lands: outside the decorations
 *     wrapping it. Backward, an insert passes the span starts whose channel decorates the carrier
 *     (its marks, the 縦中横 it is, the line's 見出し). Forward, it passes every postfix, reading
 *     and dangling end, and the paired ends of those channels; it passes other span starts and
 *     ends only while such an end is still to come on the line. A comment is transparent both
 *     ways. The walk starts only where the carrier's edge is a node edge.
 *   - Offsets are per UTF-16 unit (astral chars = two consecutive units), matching
 *     `TextDocument.positionAt`; a composed kana is one unit whose source is two.
 *
 * Lines are NEVER merged: a multi-line utterance yields one line per source line with
 * `openDepthAtEnd` > 0, and the 〇 sentinel lands on the line holding the utterance's first
 * interior unit. No LSP types: offsets only.
 */
import type { Ast, Line, Marks, Ruby, Span, SpanCloserNode, SyntaxNode, Tcy, TcySpanEndNode } from '../../shared/ast/nodes.ts';
import type { Channel } from '../../shared/ast/notation.ts';
import { isFixedOrigin } from '../../shared/ast/span.ts';
import { partitionPoint } from '../../shared/utils/lists.ts';
import { DialogueStack } from '../dialogue.ts';
import { clusterSpans, shownRuns } from '../shown.ts';

import type { Carrier, LintLine, Piece, ProseUnit, ProseView, SourceSlice } from './types.ts';

/** The narration placeholder for a collapsed utterance interior: never in the prose view, so it
 *  joins no run; one square to a sentence rule. */
const SENTINEL = '〇';

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

/** A carrier while its line is built: the extents are set once the line's units are known. */
interface OpenCarrier extends Carrier {
  outerStart: number;
  outerEnd: number;
  /** The decorations on it, any of which an insert must get out of: a run's own, a cell's and its runs'. */
  readonly marks: readonly Marks[];
  readonly tcy: boolean;
}

/** Cross-line state: the top-level utterance count (dialogue separator bookkeeping) and whether the current one has emitted its 〇 yet. */
interface Flow {
  serial: number;
  placeheld: boolean;
}

/** One entry of a view plan: a unit of the prose view by index, the 〇 sentinel, or the dialogue '\n' separator. */
type PlanItem = number | { readonly kind: 'sentinel'; readonly src: number } | { readonly kind: 'sep' };

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

/** Materializes a plan over `prose` into an index-aligned {@link ProseView}. A separator sits just
 *  past the previous unit (it separates two utterances, so a previous unit always exists). */
function materialize(prose: ProseView, plan: readonly PlanItem[]): ProseView {
  let text = '';
  const units: ProseUnit[] = [];
  for (let i = 0; i < plan.length;) {
    const item = plan[i];
    if (typeof item === 'number') {
      let j = i + 1; // the run of consecutive units from `item`
      while (plan[j] === item + (j - i)) {
        j += 1;
      }
      text += prose.text.slice(item, item + (j - i));
      for (let k = item; k < item + (j - i); k += 1) {
        const unit = prose.units[k];
        if (unit !== undefined) {
          units.push(unit);
        }
      }
      i = j;
      continue;
    }
    if (item?.kind === 'sentinel') {
      text += SENTINEL;
      units.push({ src: item.src, end: item.src, depth: 0, piece: null, carrier: null });
    } else {
      const at = units[units.length - 1]?.end ?? 0;
      text += '\n';
      units.push({ src: at, end: at, depth: 0, piece: null, carrier: null });
    }
    i += 1;
  }
  return { text, units };
}

/** Builds one line: its units with their pieces and carriers, and the three view plans. */
class LineBuilder {
  private readonly line: Line;
  private readonly ast: Ast;
  private text = '';
  private readonly units: ProseUnit[] = [];
  private readonly pieces: Piece[] = [];
  private readonly carriers: OpenCarrier[] = [];
  private readonly narrPlan: PlanItem[] = [];
  private readonly diaPlan: PlanItem[] = [];
  /** Whether any unit sits inside an utterance: without one, the narration is the prose view itself. */
  private spoken = false;
  /** Utterance serial of the last dialogue unit on THIS line (separator bookkeeping). */
  private lastDiaSerial: number | undefined = undefined;

  /** The piece under construction: the object its units name, its text growing until it closes. */
  private open: { text: string; readonly srcStart: number; readonly depth: number } | null = null;
  /** The cursor over the line's nodes: `nodes[cursor]` is the first node not ending before the last unit placed. */
  private cursor = 0;

  constructor(line: Line, ast: Ast) {
    this.line = line;
    this.ast = ast;
  }

  /** The text node holding `[src, end)` whole, or null. Units come in source order, so the cursor only advances. */
  private textNodeAt(src: number, end: number): SyntaxNode | null {
    const nodes = this.line.syntax;
    while ((nodes[this.cursor]?.span.end ?? Infinity) <= src) {
      this.cursor += 1;
    }
    const node = nodes[this.cursor];
    return node?.kind === 'text' && node.span.start <= src && end <= node.span.end ? node : null;
  }

  private closePiece(): void {
    if (this.open !== null) {
      this.pieces.push(this.open);
      this.open = null;
    }
  }

  /** The piece a typed unit at `[src, end)` names: the open one when it continues it, else a new one; null when no text node holds it whole. */
  private pieceFor(src: number, end: number, depth: number): Piece | null {
    const node = this.textNodeAt(src, end);
    if (node === null) {
      this.closePiece();
      return null;
    }
    const slice = node.text.slice(src - node.span.start, end - node.span.start);
    if (this.open === null || this.open.srcStart + this.open.text.length !== src || this.open.depth !== depth) {
      this.closePiece();
      this.open = { text: slice, srcStart: src, depth };
    } else {
      this.open.text += slice;
    }
    return this.open;
  }

  private carrier(kind: Carrier['kind'], span: Span, marks: readonly Marks[], tcy: boolean): OpenCarrier {
    const carrier: OpenCarrier = { kind, src: span.start, end: span.end, outerStart: span.start, outerEnd: span.end, marks, tcy };
    this.carriers.push(carrier);
    return carrier;
  }

  /** Places one unit of the prose view, and on the narration or the dialogue plan by its depth. */
  private place(ch: string, src: number, end: number, depth: number, piece: Piece | null, carrier: OpenCarrier, flow: Flow): void {
    const index = this.units.length;
    this.text += ch;
    this.units.push({ src, end, depth, piece, carrier });
    if (depth === 0) {
      this.narrPlan.push(index);
      return;
    }
    this.spoken = true;
    if (!flow.placeheld) {
      this.narrPlan.push({ kind: 'sentinel', src }); // the utterance's first interior unit
      flow.placeheld = true;
    }
    if (this.lastDiaSerial !== undefined && this.lastDiaSerial !== flow.serial) {
      this.diaPlan.push({ kind: 'sep' });
    }
    this.diaPlan.push(index);
    this.lastDiaSerial = flow.serial;
  }

  run(dialogue: DialogueStack, flow: Flow): void {
    let inCell = null as { readonly cell: Ruby | Tcy; readonly carrier: OpenCarrier } | null;
    for (const { run, cell } of shownRuns(this.line)) {
      let carrier: OpenCarrier;
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
      const clusters = fixed ? null : clusterSpans(run);
      const segments = prose ? dialogue.feed(run.text) : [{ kind: 'prose', from: 0, to: run.text.length, depth: dialogue.depth } as const];
      let cluster = 0;
      let offset = 0; // display units into the current cluster
      for (const seg of segments) {
        for (let k = seg.from; k < seg.to; k += 1) {
          let src = run.span.start;
          let end = run.span.end;
          if (clusters !== null) {
            let c = clusters[cluster];
            while (c !== undefined && offset >= c.text.length) {
              cluster += 1;
              offset = 0;
              c = clusters[cluster];
            }
            src = (c?.start ?? run.span.end) + offset;
            end = c?.text.length === offset + 1 ? c.end : src + 1;
            offset += 1;
          } else if (!fixed) {
            src = run.span.start + k;
            end = src + 1;
          }
          const piece = prose ? this.pieceFor(src, end, seg.depth) : null;
          this.place(run.text.charAt(k), src, end, seg.depth, piece, carrier, flow);
        }
        if (seg.kind === 'open' && seg.depth === 0) {
          flow.serial += 1; // a new top-level utterance; its 〇 is emitted lazily
          flow.placeheld = false;
        }
      }
    }
    this.closePiece();
    this.extend();
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

  freeze(openDepthAtEnd: number): LintLine {
    const { line, pieces, narrPlan, diaPlan, spoken } = this;
    const prose: ProseView = { text: this.text, units: this.units };
    let narrView: ProseView | undefined;
    let diaView: ProseView | undefined;
    const blank = line.syntax.length === 0;
    return {
      srcLine: line.index,
      srcStart: line.span.start,
      srcEnd: line.span.end,
      source: slicesOf(line.syntax),
      indent: line.indent,
      heading: line.heading,
      directiveOnly: !blank && pieces.length === 0,
      blank,
      openDepthAtEnd,
      pieces,
      prose: () => prose,
      narration: () => (spoken ? (narrView ??= materialize(prose, narrPlan)) : prose),
      dialogue: () => (diaView ??= materialize(prose, diaPlan)),
    };
  }
}

/**
 * Walks `ast` and yields one {@link LintLine} per source line, INCLUDING the final line (even
 * when empty — the line after the final terminator; what it means is each rule's call). Line
 * numbers are the AST's, which are LSP's.
 */
export function* walkLines(ast: Ast): Generator<LintLine, void, undefined> {
  const dialogue = new DialogueStack();
  const flow: Flow = { serial: 0, placeheld: false };
  for (const line of ast.lines) {
    const builder = new LineBuilder(line, ast);
    builder.run(dialogue, flow);
    yield builder.freeze(dialogue.depth);
  }
}
