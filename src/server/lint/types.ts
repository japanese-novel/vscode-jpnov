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
 * FIX SAFETY (a silent-data-loss class of bug — a fix once deleted the markup between two clean
 * characters, and an insert once landed inside a ruby): a replacement {@link FixSpec} names ONE
 * {@link Piece}, a contiguous source slice by construction, so it cannot span elided markup; an
 * insert names a prose UNIT and a side, and the engine resolves the offset through the piece's
 * outer extents, past the markup wrapping that unit; an erase names whole blank lines, which the
 * engine verifies hold nothing but line terminators; a compose names the offset of one combining
 * mark, and the engine itself composes it with the unit before it, so markup anywhere is safe.
 * The view-scan adapter adds the same-piece test and refuses to delete a whole ruby base
 * (rules/adapt.ts).
 *
 * Relative imports only (native test loader); vscode-free.
 */
import type { HeadingLevel } from '../../shared/compiler/tokenizer.ts';
import type { ActiveRule } from '../../shared/lint/select.ts';
import type { LocalizableMessage } from '../../shared/protocol.ts';

/**
 * A maximal run of prose that is CONTIGUOUS in the source and constant in dialogue depth.
 * `text.charAt(k)` came from source offset `srcStart + k` (UTF-16 units, matching
 * `TextDocument.positionAt`; astral characters occupy two consecutive units). Piece boundaries
 * fall at elided markup (annotations, ruby readings, the ｜ base marker), at line breaks, and at
 * every depth change (an utterance corner).
 */
export interface Piece {
  readonly text: string;
  /** Absolute source UTF-16 offset of `text.charAt(0)`. */
  readonly srcStart: number;
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

/** One ruby reading (the 《…》 interior) on its line; `srcStart` is the reading's first unit. */
export interface RubyReading {
  readonly text: string;
  readonly srcStart: number;
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
 * One source line, fully contextualized. `indent` and `heading` are in lockstep with the rendered
 * `Row` of layout.ts `buildRows` (twin-machine guard in walker.test.ts); `directiveOnly` marks a
 * line whose tokens produce no prose (a ここから/ここで own-line directive, 改ページ, a bare
 * comment); `blank` marks a line with no tokens at all. `openDepthAtEnd` > 0 means the line ends
 * inside an utterance (a multi-line 台詞).
 */
export interface LintLine {
  /** 0-based source line ('\n'-counted, CRLF-aware — matches LSP line numbering). */
  readonly srcLine: number;
  /** Source offset of the line's first unit. */
  readonly srcStart: number;
  /** Source offset just past the line's last content unit (the terminator, or EOF). */
  readonly srcEnd: number;
  /** The line's source text, terminator excluded: what a rule scans when it must see the markup
   *  interiors (a ruby reading, an annotation's target) that every view elides. */
  readonly raw: string;
  /** Rendered 字下げ of this line (line-head ［＃N字下げ］ override, else the open block's N). */
  readonly indent: number;
  /** The line's 見出し level, when a heading postfix/span/block covers it. */
  readonly heading: HeadingLevel | undefined;
  readonly directiveOnly: boolean;
  readonly blank: boolean;
  readonly openDepthAtEnd: number;
  readonly pieces: readonly Piece[];
  readonly rubies: readonly RubyReading[];
  prose(): ProseView;
  narration(): ProseView;
  dialogue(): ProseView;
}

/** A half-open absolute source span `[start, end)` — the shape every report names. */
export interface SrcSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * An auto-fix, in the only four safe shapes: replace a range INSIDE one piece (cannot span elided
 * markup by construction), compose one kana + combining-mark pair anywhere (the engine composes it
 * from the document), insert before or after one prose UNIT (zero-width; the engine resolves the
 * offset past the markup wrapping the unit, so it can never land inside a ruby or a span), or
 * erase whole blank lines (a span the engine checks holds nothing but line terminators). A
 * synthetic unit (`piece: null`) can never anchor an insert.
 */
export type FixSpec =
  | {
    readonly replace: {
      readonly piece: Piece;
      /** Half-open `[start, end)` UTF-16 range into `piece.text`. */
      readonly start: number;
      readonly end: number;
    };
    readonly text: string;
  }
  | {
    /** Source offset of a combining 濁点/半濁点: the two units `[compose - 1, compose + 1)` become
     *  their NFC composition, computed by the engine from the document itself. */
    readonly compose: number;
  }
  | { readonly insert: ProseUnit; readonly side: 'before' | 'after'; readonly text: string }
  | { readonly erase: SrcSpan };

/** What a rule instance is handed: its resolved options and the report sink. `message` overrides
 *  the default `{ code: rule.code }` (sub-codes like `lint.common.dash.parity`). */
export interface RuleContext {
  readonly options: ActiveRule['options'];
  report(
    span: SrcSpan,
    extra?: { readonly message?: LocalizableMessage; readonly fix?: FixSpec },
  ): void;
}

/** A per-document rule instance: fed every {@link LintLine} in order, then `end()` at EOF (the
 *  flush point for cross-line state — an unclosed bracket, a run counter). */
export interface LineRule {
  line(line: LintLine): void;
  end?(): void;
}
