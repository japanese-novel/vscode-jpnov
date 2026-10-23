/**
 * Shared types of the native lint engine — the LEAF of the lint module graph (walker, rules,
 * modules and the engine all import from here; this file imports nothing but types), so rules and
 * the walker can never form a cycle.
 *
 * The shape of a document, as rules see it: one {@link LintLine} per SOURCE line (never merged —
 * a multi-line utterance stays one line per line). A line carries pieces + context flags + three
 * lazy VIEWS of the line as its reader sees it (the AST's content: kana composed, values
 * substituted, a 外字注記 as its character, the characters no output can carry gone), and remembers
 * what two rules would otherwise read off a view twice (its sentences, its line form):
 *   - `prose()`     every character shown, in order — markup elided but ADJACENCY kept, so a rule
 *                   reading neighbours sees `聴覚視覚［＃太字］区分装置` as one 8-kanji run.
 *   - `narration()` depth-0 units with each top-level utterance interior collapsed to one 〇
 *                   sentinel unit (`piece: null`, `carrier: null` — reported on, never fixed).
 *   - `dialogue()`  utterance interiors only, one '\n' separator unit between utterances.
 *
 * Rules judge what is shown; a fix edits what was typed. A unit typed as body text names the
 * {@link Piece} a replacement may rewrite; a unit an annotation shows (a value, a 外字注記, the
 * spaces of a ［＃○字下げ］, an unclosed ［＃) names none. Every unit but a synthetic one names
 * its {@link Carrier}, which says where an insert at its edge lands: outside the markup wrapping
 * it; a ruby or a 縦中横 is atomic, so an insert anywhere in it lands outside the cell. The spaces
 * of a ［＃○字下げ］ are the one thing shown that a deletion may take with it, the annotation whole.
 *
 * FIX SAFETY: a replacement {@link FixSpec} names ONE {@link SourceSlice}, a contiguous source
 * slice by construction, so it cannot span elided markup; an insert names a prose UNIT and a
 * side, and the engine resolves the offset through the unit's carrier; an erase names a source
 * span the engine checks holds nothing but typed characters, whole ［＃○字下げ］ annotations and
 * the terminators of blank lines. The view-scan adapter (rules/adapt.ts) builds each of them from
 * a view hit and refuses the rest.
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
 * A maximal run of typed body text that is CONTIGUOUS in the source and constant in dialogue
 * depth, verbatim: a character the view dropped or composed is still in `text`. Piece boundaries
 * fall at markup, at what an annotation shows, at line breaks, and at every depth change (an
 * utterance corner).
 */
export interface Piece extends SourceSlice {
  /** Utterance nesting depth: 0 = 地の文 (top-level 「」『』 corners included), ≥1 = inside. */
  readonly depth: number;
}

/**
 * What a stretch of units is carried by, and where an insert at its edge lands: `run` one run of
 * the content (typed text, or what an annotation shows), `cell` an atomic ruby or 縦中横 (every
 * unit inside it, whatever shows it), `indent` the spaces of one ［＃○字下げ］ (the one carrier a
 * deletion may take whole).
 */
export interface Carrier {
  readonly kind: 'run' | 'cell' | 'indent';
  /** Where it was written: the run, the annotation, the cell from its ｜ or base through its reading. */
  readonly src: number;
  readonly end: number;
  /** Where an insert BEFORE its first unit goes: before the annotations wrapping it (a ｜, a
   *  ［＃傍点］, a ［＃縦中横］ …); `src` when nothing does. */
  readonly outerStart: number;
  /** Where an insert AFTER its last unit goes: past a reading, a postfix, a closing annotation
   *  wrapping it; `end` when nothing does. */
  readonly outerEnd: number;
}

/**
 * One view character. `src`/`end` is where it was written: one unit, or more for a kana composed
 * from its mark and for a dropped character inside; the whole annotation for a character one
 * shows. `piece` is the typed slice a replacement may edit (null for a character an annotation
 * shows and for a synthetic unit); `carrier` is null for a synthetic unit only (the narration 〇
 * sentinel, the dialogue '\n' separator), which is never a fix anchor.
 */
export interface ProseUnit {
  readonly src: number;
  readonly end: number;
  readonly depth: number;
  readonly piece: Piece | null;
  readonly carrier: Carrier | null;
}

/** An index-aligned prose view: `text.charAt(k)` ↔ `unit(k)`, undefined past the text. A unit is
 *  made when asked for (the walker keeps columns, not objects); its piece and carrier are the
 *  line's own objects, so two units of one piece or one carrier compare equal by identity. */
export interface ProseView {
  readonly text: string;
  unit(k: number): ProseUnit | undefined;
}

/** Half-open `[start, end)` index range into a view one sentence covers (sentences.ts). */
export interface SentenceSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * One source line, fully contextualized. `indent` and `heading` are the AST's; `directiveOnly`
 * marks a line that holds nodes but no typed body text (a ここから/ここで own-line directive,
 * 改ページ, a bare comment, a lone ［＃○字下げ］); `blank` marks a line with no nodes at all.
 * `openDepthAtEnd` > 0 means the line ends inside an utterance (a multi-line 台詞).
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
  /** The block 字下げ in effect on the line (［＃ここから○字下げ］); a ［＃○字下げ］ is spaces in the views. */
  readonly indent: number;
  /** The line's 見出し level, when a heading postfix/span/block covers it. */
  readonly heading: HeadingLevel | undefined;
  readonly directiveOnly: boolean;
  readonly blank: boolean;
  readonly openDepthAtEnd: number;
  readonly pieces: readonly Piece[];
  prose(): ProseView;
  narration(): ProseView;
  dialogue(): ProseView;
  /** The sentences of the narration or the dialogue view, split once (sentences.ts). */
  sentences(view: 'narration' | 'dialogue'): readonly SentenceSpan[];
  /** An ornament line (a scene break like ＊ or ◇＊◇) or a bullet line (・ポーション×３): inset
   *  material, not a paragraph of 地の文, so it takes neither the 字下げ nor the 句点. A pause
   *  line (…… / ―― only) is prose: a silence paragraph reads as a sentence. */
  inset(): boolean;
}

/**
 * An auto-fix, in the only three safe shapes: replace a range INSIDE one slice (cannot span
 * elided markup by construction), insert before or after one prose UNIT (zero-width; the engine
 * resolves the offset through the unit's carrier, so it can never land inside a ruby or a span),
 * or erase a span (which the engine checks holds nothing but typed characters, whole ［＃○字下げ］
 * annotations and the terminators of blank lines). A synthetic unit can never anchor an insert.
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
