/**
 * The lint walker — ONE pass over `tokenize(src)` (the same token stream the highlighter and the
 * layout use) that yields one contextualized {@link LintLine} per SOURCE line. This is the "big
 * state machine": it owns the dialogue stack, the 字下げ and 見出し line state, and the
 * piece/sentinel bookkeeping; rules are small per-document state machines fed its lines.
 *
 * Semantics (each guarded by walker.test.ts):
 *   - The dialogue stack is driven from PROSE characters only, exactly as in semanticTokens.ts —
 *     Aozora's ［＃「対象」に傍点］ carries its 「対象」 inside an annotation token, so it can never
 *     be mistaken for a quote (the Aozora trap).
 *   - 字下げ state mirrors layout.ts `buildRows` (`curIndent`/`activeIndent`): a line-head
 *     ［＃N字下げ］ overrides the line (N = 0 cancels an open block for that line); a ここから block
 *     covers FOLLOWING lines; the line carrying a block directive keeps its head snapshot.
 *   - 見出し state mirrors `curHeading`/`activeHeading`: an inline span marks its own line, the
 *     block form marks following lines only, the three levels share one slot, the end token's line
 *     stays a heading. A heading POSTFIX marks its line without re-checking the target text —
 *     a missed target already surfaces as `syntax.postfixTargetMissing` (accepted simplification).
 *   - A broken ［＃ (unclosed) contributes no prose: malformed markup is deliberately not linted.
 *   - Outer extents: an opener (［＃傍点］, ［＃縦中横］, a ruby's ｜) pulls the next piece's
 *     `outerStart` before it; a postfix, a value field, a ruby's 《reading》 or a span end pushes
 *     the open piece's `outerEnd` past it. Openers and span ends pair per channel (emphasis by
 *     variant, 縦中横, one heading slot) as `buildRows` does; a span end whose own opener is still
 *     pending is an empty span. Extents are per line.
 *   - Offsets are per UTF-16 unit (astral chars = two consecutive units), matching
 *     `TextDocument.positionAt`. Terminators: '\n', '\r\n' and a lone '\r' all end a line.
 *
 * Lines are NEVER merged: a multi-line utterance yields one line per source line with
 * `openDepthAtEnd` > 0, and the 〇 sentinel lands on the line holding the utterance's first
 * interior character. A rendered 字下げ reaches rules only as `LintLine.indent`.
 *
 * Relative imports only (native test loader); vscode-free; no LSP types (offsets only).
 */
import { tokenize } from '../../shared/compiler/tokenizer.ts';
import type { HeadingLevel, Token } from '../../shared/compiler/tokenizer.ts';

import type { LintLine, Piece, ProseUnit, ProseView, RubyReading } from './types.ts';

/** The narration placeholder for a collapsed utterance interior. U+3007 〇 is classified as
 *  neither kanji nor kana by the tokenizer, so it cannot trip a run/width rule. */
const SENTINEL = '〇';

/** What a token does to the outer extents: `open` wraps the piece after it; `attach` (a postfix,
 *  a value field) extends the piece before it; `close` (a span end) does too unless its own opener
 *  is still pending; `reading` (an implicit ruby's 《…》) extends it and marks a ruby base; `ruby`
 *  (an explicit ｜…《…》) opens at the ｜ as well; `neutral` binds nothing (a line-head ［＃N字下げ］
 *  must stay at the head). Exhaustive: a new token kind is a compile error. */
type ExtentRole = 'open' | 'close' | 'attach' | 'reading' | 'ruby' | 'neutral';
const EXTENT_ROLE: Record<Token['kind'], ExtentRole> = {
  text: 'neutral',
  rubyExplicit: 'ruby',
  rubyImplicit: 'reading',
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
};

/** The pairing key of an opener or span end: emphasis by variant, one slot for the heading levels,
 *  one for 縦中横; a ruby's ｜ opens a key nothing closes. */
function spanKey(token: Token): string {
  switch (token.kind) {
    case 'emphasisSpanStart':
    case 'emphasisSpanEnd':
      return `emphasis:${token.variant}`;
    case 'headingSpanStart':
    case 'headingSpanEnd':
      return 'heading';
    case 'tcySpanStart':
    case 'tcySpanEnd':
      return 'tcy';
    default:
      return token.kind;
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
      for (let k = 0; k < piece.text.length; k += 1) {
        text += piece.text.charAt(k);
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
  readonly rubies: RubyReading[] = [];
  sawAnnotation = false;
  /** Utterance serial of the last dialogue piece on THIS line (separator bookkeeping). */
  lastDiaSerial: number | undefined = undefined;

  // The piece under construction, with its outer extents (unset = the piece's own edges).
  private curText = '';
  private curStart = 0;
  private curDepth = 0;
  private curBefore: number | undefined = undefined;
  private curAfter: number | undefined = undefined;
  private curRubyBase = false;
  /** Openers since the last piece, by pairing key; the earliest becomes the next `outerStart`. */
  private readonly pending = new Map<string, number>();

  /** An opening token at `at`. */
  open(key: string, at: number): void {
    if (!this.pending.has(key)) {
      this.pending.set(key, at);
    }
  }

  /** A postfix or value field ending at `end` extends the open piece, unless a pending opener
   *  sealed it. */
  attach(end: number): void {
    if (this.curText !== '' && this.pending.size === 0) {
      this.curAfter = end;
    }
  }

  /** A ruby reading ending at `end`: its base was just pushed, so it always attaches. */
  reading(end: number): void {
    this.attach(end);
    this.curRubyBase = true;
  }

  /** A span end at `end` ends its own pending opener (an empty span), else extends the open piece;
   *  another channel's pending opener does not seal it. */
  close(key: string, end: number): void {
    if (this.pending.delete(key)) {
      return;
    }
    if (this.curText !== '') {
      this.curAfter = end;
    }
  }

  /** Appends one prose unit, closing the open piece at a source gap or a depth change. */
  push(ch: string, at: number, depth: number, serial: number): void {
    if (this.curText !== '' && (at !== this.curStart + this.curText.length || depth !== this.curDepth)) {
      this.closePiece(serial);
    }
    if (this.curText === '') {
      this.curStart = at;
      this.curDepth = depth;
      this.curBefore = this.pending.size === 0 ? undefined : Math.min(...this.pending.values());
      this.pending.clear();
    }
    this.curText += ch;
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
      'srcLine' | 'srcStart' | 'srcEnd' | 'indent' | 'heading' | 'openDepthAtEnd'
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

/**
 * Walks `src` and yields one {@link LintLine} per source line, INCLUDING the final line (even when
 * empty — the line after the final terminator; what it means is each rule's call). Line numbers match LSP positions for '\n' / '\r\n'
 * sources; a lone '\r' also ends a line here (layout.ts keeps it literal — pathological input).
 */
export function* walkLines(src: string): Generator<LintLine, void, undefined> {
  // Cross-line state (the "big state machine").
  const stack: ('」' | '』')[] = []; // dialogue nesting, by expected closer
  let placeheld = false; // has the current top-level utterance emitted its 〇 yet?
  let serial = 0; // increments per top-level utterance (dialogue separator bookkeeping)
  let blockIndent = 0; // ここから字下げ in effect, carried across lines
  let lineIndent = 0; // 字下げ of the line under construction (line start = blockIndent)
  let activeHeading: HeadingLevel | undefined; // 見出し span/block in effect, carried across lines
  let lineHeading: HeadingLevel | undefined; // 見出し of the line under construction
  let srcLine = 0;
  let lineStart = 0;
  let builder = new LineBuilder();

  /** Routes one prose character through the dialogue stack (same discipline as semanticTokens.ts:
   *  only a stack-matched closer leaves the utterance; a mismatched one is ordinary prose). */
  const prose = (ch: string, at: number): void => {
    if (ch === '「' || ch === '『') {
      const closer = ch === '「' ? '」' : '』';
      if (stack.length === 0) {
        builder.push(ch, at, 0, serial); // top-level opening corner stays 地の文
        serial += 1;
        placeheld = false; // a fresh interior begins; its 〇 is emitted lazily
      } else {
        interior(ch, at);
      }
      stack.push(closer);
      return;
    }
    if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) {
        builder.push(ch, at, 0, serial); // top-level closing corner stays 地の文
      } else {
        interior(ch, at);
      }
      return;
    }
    if (stack.length === 0) {
      builder.push(ch, at, 0, serial);
    } else {
      interior(ch, at);
    }
  };

  /** Pushes one utterance-interior unit, emitting the utterance's single 〇 on the first one. */
  const interior = (ch: string, at: number): void => {
    if (!placeheld) {
      builder.closePiece(serial); // the 〇 sits between the depth-0 piece and the interior
      builder.narrPlan.push({ kind: 'sentinel', src: at });
      placeheld = true;
    }
    builder.push(ch, at, stack.length, serial);
  };

  /** Appends a ruby base (contiguous prose starting at `srcStart`) through the dialogue router. */
  const appendBase = (base: string, srcStart: number): void => {
    for (let i = 0; i < base.length; i += 1) {
      prose(base.charAt(i), srcStart + i);
    }
  };

  /** Freezes the line ending at `terminatorAt` (or EOF) and resets the per-line state. */
  const flush = (terminatorAt: number): LintLine => {
    builder.closePiece(serial);
    const line = builder.freeze({
      srcLine,
      srcStart: lineStart,
      srcEnd: terminatorAt,
      indent: lineIndent,
      heading: lineHeading,
      openDepthAtEnd: stack.length,
    });
    builder = new LineBuilder();
    srcLine += 1;
    lineIndent = blockIndent; // the next line starts at the block's indent
    lineHeading = activeHeading; // …and inherits an open 見出し span/block
    return line;
  };

  let offset = 0; // source UTF-16 offset of the current token's `raw`
  for (const token of tokenize(src)) {
    const role = EXTENT_ROLE[token.kind];
    const end = offset + token.raw.length;
    if (role === 'open' || role === 'ruby') {
      builder.open(spanKey(token), offset); // before the switch pushes a ruby's base
    }
    switch (token.kind) {
      case 'text': {
        const text = token.text;
        for (let i = 0; i < text.length; i += 1) {
          const ch = text.charAt(i);
          const at = offset + i;
          if (ch === '\n' || ch === '\r') {
            yield flush(at);
            if (ch === '\r' && text.charAt(i + 1) === '\n') {
              i += 1; // one CRLF terminator, not two lines
            }
            lineStart = offset + i + 1;
          } else {
            prose(ch, at);
          }
        }
        break;
      }
      case 'rubyExplicit': // raw = ｜ base 《 reading 》
        appendBase(token.base, offset + 1);
        builder.rubies.push({ text: token.reading, srcStart: offset + 1 + token.base.length + 1 });
        break;
      case 'rubyImplicit': // raw = base 《 reading 》
        appendBase(token.base, offset);
        builder.rubies.push({ text: token.reading, srcStart: offset + token.base.length + 1 });
        break;
      case 'indent': // line-head only (tokenizer-gated); overrides this line, 0 included
        lineIndent = token.amount;
        builder.sawAnnotation = true;
        break;
      case 'indentBlockStart': // affects FOLLOWING lines; this line keeps its head snapshot
        blockIndent = token.amount;
        builder.sawAnnotation = true;
        break;
      case 'indentBlockEnd':
        blockIndent = 0;
        builder.sawAnnotation = true;
        break;
      case 'headingPostfix': // marks its own line (target re-check left to syntax diagnostics)
        lineHeading = token.level;
        builder.sawAnnotation = true;
        break;
      case 'headingSpanStart':
        // One slot for the three levels (a re-open is a level change). The inline form marks
        // THIS line too; the block form affects following lines only.
        activeHeading = token.level;
        if (token.block !== true) {
          lineHeading = token.level;
        }
        builder.sawAnnotation = true;
        break;
      case 'headingSpanEnd':
        activeHeading = undefined; // the line carrying the end stays a heading
        builder.sawAnnotation = true;
        break;
      default:
        // rubyLeftPostfix / emphasis* / tcy* / comment / brokenAnnotation / pageBreak /
        // valueField contribute no prose (a 左ルビ reading lives only inside its annotation
        // and is not linted; a valueField's substituted text is never author prose); they
        // only advance `offset`, which alone breaks piece contiguity.
        builder.sawAnnotation = true;
        break;
    }
    // after the switch: a ruby's reading attaches to the base just pushed
    if (role === 'close') {
      builder.close(spanKey(token), end);
    } else if (role === 'attach') {
      builder.attach(end);
    } else if (role === 'ruby' || role === 'reading') {
      builder.reading(end);
    }
    offset = end;
  }
  yield flush(offset); // the final line, blank or not
}
