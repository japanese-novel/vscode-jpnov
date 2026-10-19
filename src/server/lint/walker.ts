/**
 * The lint walker: one pass over the AST that yields one {@link LintLine} per source line. It
 * drives the shared dialogue stack and owns the piece/sentinel bookkeeping; the line's 字下げ and
 * 見出し are the AST's.
 *
 * Semantics (each guarded by walker.test.ts):
 *   - The dialogue stack is dialogue.ts's, shared with the highlighter, and is driven from PROSE
 *     characters only — Aozora's ［＃「対象」に傍点］ carries its 「対象」 inside an annotation
 *     node, so it can never be mistaken for a quote (the Aozora trap).
 *   - A broken ［＃ (unclosed) contributes no prose; only a scan of the source slices (noNfd) sees
 *     inside it.
 *   - Outer extents: an opener (［＃傍点］, ［＃縦中横］, a ruby's ｜) pulls the next piece's
 *     `outerStart` before it; a postfix, a value field, a 外字注記, a ruby's 《reading》 or a span
 *     end pushes the open piece's `outerEnd` past it. What renders as text with no piece before it
 *     on the line (a value field, a 外字注記, a ruby whose base is a value field alone) leads the
 *     next piece instead. Openers and span ends pair per channel (one slot each for 傍点, 傍線,
 *     太字, 斜体, 見出し and 縦中横), as the AST pairs them; a span end whose own opener is still
 *     pending is an empty span, unless the channel was open before that opener. Extents are per
 *     line.
 *   - Offsets are per UTF-16 unit (astral chars = two consecutive units), matching
 *     `TextDocument.positionAt`.
 *
 * Lines are NEVER merged: a multi-line utterance yields one line per source line with
 * `openDepthAtEnd` > 0, and the 〇 sentinel lands on the line holding the utterance's first
 * interior character. The 字下げ a line opens with reaches rules only as `LintLine.indent`. No LSP types:
 * offsets only.
 */
import type { Ast, Line, SyntaxNode } from '../../shared/ast/nodes.ts';
import { spanChannel } from '../../shared/ast/notation.ts';
import { DialogueStack } from '../dialogue.ts';

import type { LintLine, Piece, ProseUnit, ProseView, SourceSlice } from './types.ts';

/** The narration placeholder for a collapsed utterance interior. The lint scans class U+3007 〇
 *  as neither kanji nor kana, so it cannot trip a run/width rule. */
const SENTINEL = '〇';

/** What a node does to the outer extents: `open` wraps the piece after it (a span start, a
 *  ruby's ｜); `attach` (a postfix, a value field, a 外字注記) extends the piece before it; `close` (a span end)
 *  does too unless its own opener is still pending; `reading` (a ruby's 《…》) extends it and marks
 *  a ruby base; `neutral` binds nothing (a ［＃N字下げ］ is no prose).
 *  Exhaustive: a new node kind is a compile error. */
type ExtentRole = 'open' | 'close' | 'attach' | 'reading' | 'neutral';
const EXTENT_ROLE: Record<SyntaxNode['kind'], ExtentRole> = {
  text: 'neutral',
  rubyMark: 'open',
  rubyReading: 'reading',
  rubyLeftPostfix: 'attach',
  emphasisPostfix: 'attach',
  emphasisSpanStart: 'open',
  emphasisSpanEnd: 'close',
  tcyPostfix: 'attach',
  tcySpanStart: 'open',
  tcySpanEnd: 'close',
  headingPostfix: 'attach',
  headingSpanStart: 'open',
  headingSpanEnd: 'close',
  comment: 'neutral',
  brokenAnnotation: 'neutral',
  pageBreak: 'neutral',
  indent: 'neutral',
  indentBlockStart: 'neutral',
  indentBlockEnd: 'neutral',
  valueField: 'attach',
  gaiji: 'attach',
};

/** The pending key of a ruby's ｜, dropped by its 《reading》 (see LineBuilder.reading). */
const RUBY_KEY = 'ruby';

/** The key of the 縦中横 slot, which closes with its line. */
const TCY_KEY = 'tcy';

/** The pairing key of an opener or span end: its channel — one slot per decoration channel, one
 *  for the heading levels, one for 縦中横, {@link RUBY_KEY} for a ruby's ｜. */
function spanKey(node: SyntaxNode): string {
  switch (node.kind) {
    case 'rubyMark':
      return RUBY_KEY;
    case 'emphasisSpanStart':
    case 'emphasisSpanEnd':
    case 'headingSpanStart':
    case 'headingSpanEnd':
      return spanChannel(node);
    case 'tcySpanStart':
    case 'tcySpanEnd':
      return TCY_KEY;
    default:
      return node.kind;
  }
}

/** One entry of a view plan: a whole piece, the 〇 sentinel, or the dialogue '\n' separator. */
type PlanItem =
  | { readonly kind: 'piece'; readonly piece: Piece }
  | { readonly kind: 'sentinel'; readonly src: number }
  | { readonly kind: 'sep' };

/** Materializes a plan into an index-aligned {@link ProseView}. A separator's offset is just past
 *  the previous unit (it separates two utterances, so a previous unit always exists). */
function materialize(plan: readonly PlanItem[]): ProseView {
  let text = '';
  const units: ProseUnit[] = [];
  for (const item of plan) {
    if (item.kind === 'piece') {
      const piece = item.piece;
      text += piece.text;
      for (let k = 0; k < piece.text.length; k += 1) {
        units.push({ src: piece.srcStart + k, piece, indexInPiece: k, depth: piece.depth });
      }
    } else if (item.kind === 'sentinel') {
      text += SENTINEL;
      units.push({ src: item.src, piece: null, indexInPiece: 0, depth: 0 });
    } else {
      const prev = units[units.length - 1];
      text += '\n';
      units.push({ src: (prev?.src ?? -1) + 1, piece: null, indexInPiece: 0, depth: 0 });
    }
  }
  return { text, units };
}

/** Accumulates one line, then freezes into a {@link LintLine} with lazily memoized views. */
class LineBuilder {
  readonly pieces: Piece[] = [];
  readonly prosePlan: PlanItem[] = [];
  readonly narrPlan: PlanItem[] = [];
  readonly diaPlan: PlanItem[] = [];
  readonly rubies: SourceSlice[] = [];
  sawAnnotation = false;
  /** Utterance serial of the last dialogue piece on THIS line (separator bookkeeping). */
  lastDiaSerial: number | undefined = undefined;

  // The piece under construction, with its outer extents (unset = the piece's own edges).
  private curText = '';
  private curStart = 0;
  private curDepth = 0;
  /** Set before the piece opens too: a rendered node with no piece to extend leads the next one. */
  private curBefore: number | undefined = undefined;
  private curAfter: number | undefined = undefined;
  private curRubyBase = false;
  /** Openers since the last piece, by pairing key; the earliest becomes the next `outerStart`. */
  private readonly pending = new Map<string, { readonly at: number; readonly reopens: boolean }>();

  /** An opening node at `at`; `reopens` says its channel was open already. */
  open(key: string, at: number, reopens: boolean): void {
    if (!this.pending.has(key)) {
      this.pending.set(key, { at, reopens });
    }
  }

  /** A postfix, value field or 外字注記 at [start, end) renders as text: it extends the open piece,
   *  unless a pending opener sealed it (inside a ｜ base, the reading attaches the whole ruby).
   *  With no piece open it leads the next one. */
  attach(start: number, end: number): void {
    if (this.pending.size !== 0) {
      return;
    }
    if (this.curText !== '') {
      this.curAfter = end;
    } else {
      this.curBefore ??= start;
    }
  }

  /** A ruby's 《reading》 ending at `end`: the base's last piece takes it. A ｜ still pending means
   *  no piece opened inside the base, so the base is a value field or 外字注記 alone and the whole
   *  ruby attaches like one. Whatever else is pending was opened inside the base and belongs to
   *  the ruby, never to the piece after it. */
  reading(end: number): void {
    const mark = this.pending.get(RUBY_KEY);
    this.pending.clear();
    if (mark !== undefined) {
      this.attach(mark.at, end);
    } else if (this.curText !== '') {
      this.curAfter = end;
      this.curRubyBase = true;
    }
  }

  /** A span end at `end` extends the open piece, unless it ends an empty span (its own opener
   *  pending, its channel not open before); another channel's pending opener does not seal it. */
  close(key: string, end: number): void {
    const own = this.pending.get(key);
    this.pending.delete(key);
    if (own?.reopens === false) {
      return;
    }
    if (this.curText !== '') {
      this.curAfter = end;
    }
  }

  /** Appends a stretch of prose, closing the open piece at a source gap or a depth change. */
  push(stretch: string, at: number, depth: number, serial: number): void {
    if (this.curText !== '' && (at !== this.curStart + this.curText.length || depth !== this.curDepth)) {
      this.closePiece(serial);
    }
    if (this.curText === '') {
      this.curStart = at;
      this.curDepth = depth;
      let before = this.curBefore;
      for (const { at: openerAt } of this.pending.values()) {
        if (before === undefined || openerAt < before) {
          before = openerAt;
        }
      }
      this.curBefore = before;
      this.pending.clear();
    }
    this.curText += stretch;
  }

  /** Closes the open piece into `pieces` and registers it on its view plans. */
  closePiece(serial: number): void {
    if (this.curText === '') {
      return;
    }
    const piece: Piece = {
      text: this.curText,
      srcStart: this.curStart,
      depth: this.curDepth,
      outerStart: this.curBefore ?? this.curStart,
      outerEnd: this.curAfter ?? this.curStart + this.curText.length,
      rubyBase: this.curRubyBase,
    };
    this.pieces.push(piece);
    const item: PlanItem = { kind: 'piece', piece };
    this.prosePlan.push(item);
    if (piece.depth === 0) {
      this.narrPlan.push(item);
    } else {
      if (this.lastDiaSerial !== undefined && this.lastDiaSerial !== serial) {
        this.diaPlan.push({ kind: 'sep' });
      }
      this.diaPlan.push(item);
      this.lastDiaSerial = serial;
    }
    this.curText = '';
    this.curBefore = undefined;
    this.curAfter = undefined;
    this.curRubyBase = false;
  }

  freeze(
    meta: Pick<
      LintLine,
      'srcLine' | 'srcStart' | 'srcEnd' | 'source' | 'indent' | 'heading' | 'openDepthAtEnd'
    >,
  ): LintLine {
    const { pieces, prosePlan, narrPlan, diaPlan } = this;
    let proseView: ProseView | undefined;
    let narrView: ProseView | undefined;
    let diaView: ProseView | undefined;
    return {
      ...meta,
      directiveOnly: pieces.length === 0 && this.sawAnnotation,
      blank: pieces.length === 0 && !this.sawAnnotation,
      pieces,
      rubies: this.rubies,
      prose: () => (proseView ??= materialize(prosePlan)),
      narration: () => (narrView ??= materialize(narrPlan)),
      dialogue: () => (diaView ??= materialize(diaPlan)),
    };
  }
}

/** The 字下げ a line opens with: the block's N plus every ［＃N字下げ］ before its first text. */
function indentAtHead(line: Line): number {
  let n = line.indent;
  for (const node of line.syntax) {
    if (node.kind === 'text') {
      return n;
    }
    if (node.kind === 'indent') {
      n += node.amount;
    }
  }
  return n;
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

/**
 * Walks `ast` and yields one {@link LintLine} per source line, INCLUDING the final line (even
 * when empty — the line after the final terminator; what it means is each rule's call). Line
 * numbers are the AST's, which are LSP's.
 */
export function* walkLines(ast: Ast): Generator<LintLine, void, undefined> {
  // Cross-line state (the "big state machine").
  const dialogue = new DialogueStack();
  let placeheld = false; // has the current top-level utterance emitted its 〇 yet?
  let serial = 0; // increments per top-level utterance (dialogue separator bookkeeping)
  const live = new Set<string>(); // the channels a span start opened and no end has closed
  let builder = new LineBuilder();

  for (const line of ast.lines) {
    for (const node of line.syntax) {
      const role = EXTENT_ROLE[node.kind];
      if (role === 'open') {
        const key = spanKey(node);
        builder.open(key, node.span.start, live.has(key)); // before the piece it wraps is pushed
        if (key !== RUBY_KEY) {
          live.add(key);
        }
      }
      switch (node.kind) {
        case 'text': // a ruby base too: it is prose
          for (const seg of dialogue.feed(node.text)) {
            const at = node.span.start + seg.from;
            if (seg.depth > 0 && !placeheld) {
              builder.closePiece(serial); // the 〇 sits between the depth-0 piece and the interior
              builder.narrPlan.push({ kind: 'sentinel', src: at });
              placeheld = true;
            }
            builder.push(node.text.slice(seg.from, seg.to), at, seg.depth, serial);
            if (seg.kind === 'open' && seg.depth === 0) {
              serial += 1; // a new top-level utterance; its 〇 is emitted lazily
              placeheld = false;
            }
          }
          break;
        case 'rubyMark': // opened above; the base nodes follow as themselves
          break;
        case 'rubyReading': // the base pieces are already pushed
          builder.rubies.push({ text: node.reading.text, srcStart: node.reading.span.start });
          break;
        default:
          // An annotation contributes no prose (a 左ルビ reading lives only inside its annotation;
          // a value field's substituted text is never author prose; a 外字注記 is not the
          // character it shows); the gap it leaves alone breaks piece contiguity.
          builder.sawAnnotation = true;
          break;
      }
      // after the switch: a ruby's reading attaches to the base just pushed
      if (role === 'close') {
        builder.close(spanKey(node), node.span.end);
        live.delete(spanKey(node));
      } else if (role === 'attach') {
        builder.attach(node.span.start, node.span.end);
      } else if (role === 'reading') {
        builder.reading(node.span.end);
      }
    }
    builder.closePiece(serial);
    live.delete(TCY_KEY);
    yield builder.freeze({
      srcLine: line.index,
      srcStart: line.span.start,
      srcEnd: line.span.end,
      source: slicesOf(line.syntax),
      indent: indentAtHead(line),
      heading: line.heading,
      openDepthAtEnd: dialogue.depth,
    });
    builder = new LineBuilder();
  }
}
