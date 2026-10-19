/**
 * Shared types of the native lint engine — the LEAF of the lint module graph (walker, rules,
 * modules and the engine all import from here; this file imports nothing but types), so rules and
 * the walker can never form a cycle.
 *
 * The shape of a document, as rules see it: one {@link LintLine} per SOURCE line (never merged —
 * a multi-line utterance stays one line per line). A line carries pieces + context flags + three
 * lazy prose VIEWS:
 *   - `prose()`     every prose character, in order — markup elided but ADJACENCY kept, so a rule
 *                   reading neighbours sees `聴覚視覚［＃太字］区分装置` as one 8-kanji run.
 *   - `narration()` depth-0 prose with each top-level utterance interior collapsed to one 〇
 *                   sentinel unit (`piece: null` — reported on, never fixed).
 *   - `dialogue()`  utterance interiors only, one '\n' separator unit between utterances.
 *
 * FIX SAFETY: a replacement {@link FixSpec} names ONE
 * {@link SourceSlice}, a contiguous source slice by construction, so it cannot span elided
 * markup; an insert names a prose UNIT and a side, and the engine resolves the offset through
 * the piece's outer extents, past the markup wrapping that unit; an erase names whole blank
 * lines, which the engine verifies hold nothing but line terminators. The view-scan adapter adds
 * the same-piece test and refuses to delete a whole ruby base (rules/adapt.ts).
 */
import type { Ast, HeadingLevel, Span } from '../../shared/ast/nodes.ts';
import type { ActiveRule } from '../../shared/lint/select.ts';
import type { LocalizableMessage } from '../../shared/protocol.ts';

/**
 * A slice of the source, verbatim and contiguous: `text.charAt(k)` came from source offset
 * `srcStart + k` (UTF-16 units, matching `TextDocument.positionAt`; astral characters occupy two
 * consecutive units).
 */
export interface SourceSlice {
  readonly text: string;
  /** Absolute source UTF-16 offset of `text.charAt(0)`. */
  readonly srcStart: number;
}

/**
 * A maximal run of prose that is CONTIGUOUS in the source and constant in dialogue depth. Piece
 * boundaries fall at elided markup (annotations, ruby readings, the ｜ base marker), at line
 * breaks, and at every depth change (an utterance corner).
 */
export interface Piece extends SourceSlice {
  /** Utterance nesting depth: 0 = 地の文 (top-level 「」『』 corners included), ≥1 = inside. */
  readonly depth: number;
  /** Where an insert BEFORE `text.charAt(0)` goes: before the ｜ of an explicit ruby and any
   *  opening markup (［＃傍点］, ［＃縦中横］, ［＃ここから太字］…) wrapping the piece; `srcStart`
   *  when nothing does. */
  readonly outerStart: number;
  /** Where an insert AFTER the last character goes: past a ruby's 《reading》 and any closing or
   *  postfix markup (［＃傍点終わり］, ［＃「…」に傍点］…) wrapping the piece; `srcStart +
   *  text.length` when nothing does. */
  readonly outerEnd: number;
  /** True when a ruby reading follows the piece (its tail is the base), so deleting the whole
   *  piece would strand the 《reading》 as literal text. */
  readonly rubyBase: boolean;
}

/** One view character: its source offset and owning piece. `piece` is null for a synthetic unit
 *  (the narration 〇 sentinel, the dialogue '\n' separator) — synthetic units are never a fix
 *  carrier. */
export interface ProseUnit {
  readonly src: number;
  readonly piece: Piece | null;
  readonly indexInPiece: number;
  readonly depth: number;
}

/** An index-aligned prose view: `text.charAt(k)` ↔ `units[k]`. */
export interface ProseView {
  readonly text: string;
  readonly units: readonly ProseUnit[];
}

/**
 * One source line, fully contextualized. `indent` and `heading` are the AST's; `directiveOnly`
 * marks a line whose nodes produce no prose (a ここから/ここで own-line directive, 改ページ, a
 * bare comment); `blank` marks a line with no nodes at all. `openDepthAtEnd` > 0 means the line
 * ends inside an utterance (a multi-line 台詞).
 */
export interface LintLine {
  /** 0-based source line, as LSP counts lines. */
  readonly srcLine: number;
  /** Source offset of the line's first unit. */
  readonly srcStart: number;
  /** Source offset just past the line's last content unit (the terminator, or EOF). */
  readonly srcEnd: number;
  /** The whole line as slices, in source order: one per markup node (a ruby's ｜, a 《reading》,
   *  an annotation), one per run of text between them — what a rule scans when it must see the
   *  markup interiors every view elides. */
  readonly source: readonly SourceSlice[];
  /** Rendered 字下げ of this line (line-head ［＃N字下げ］ override, else the open block's N). */
  readonly indent: number;
  /** The line's 見出し level, when a heading postfix/span/block covers it. */
  readonly heading: HeadingLevel | undefined;
  readonly directiveOnly: boolean;
  readonly blank: boolean;
  readonly openDepthAtEnd: number;
  readonly pieces: readonly Piece[];
  /** The readings of the line's rubies (the 《…》 interiors). */
  readonly rubies: readonly SourceSlice[];
  prose(): ProseView;
  narration(): ProseView;
  dialogue(): ProseView;
}

/**
 * An auto-fix, in the only three safe shapes: replace a range INSIDE one slice (cannot span
 * elided markup by construction), insert before or after one prose UNIT (zero-width; the engine
 * resolves the offset past the markup wrapping the unit, so it can never land inside a ruby or a
 * span), or erase whole blank lines (a span the engine checks holds nothing but line
 * terminators). A synthetic unit (`piece: null`) can never anchor an insert.
 */
export type FixSpec =
  | {
    readonly replace: {
      readonly slice: SourceSlice;
      /** Half-open `[start, end)` UTF-16 range into `slice.text`. */
      readonly start: number;
      readonly end: number;
    };
    readonly text: string;
  }
  | { readonly insert: ProseUnit; readonly side: 'before' | 'after'; readonly text: string }
  | { readonly erase: Span };

/** What a rule instance is handed: its resolved options, the document's parse and the report sink.
 *  `message` overrides the default `{ code: rule.code }` (sub-codes like `lint.common.dash.parity`). */
export interface RuleContext {
  readonly options: ActiveRule['options'];
  /** What the resolver decided — a binding, a cell, a finding. A fix still names a piece of the line. */
  readonly ast: Ast;
  report(
    span: Span,
    extra?: { readonly message?: LocalizableMessage; readonly fix?: FixSpec },
  ): void;
}

/** A per-document rule instance: fed every {@link LintLine} in order, then `end()` at EOF (the
 *  flush point for cross-line state — an unclosed bracket, a run counter). */
export interface LineRule {
  line(line: LintLine): void;
  end?(): void;
}
