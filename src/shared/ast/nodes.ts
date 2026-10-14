/**
 * The types of the manuscript AST: two layers over one source text.
 *
 *   - The SYNTAX layer is what was written: per line, the nodes in source order, each a verbatim
 *     slice with its span; an annotation also carries the span of every part inside it. The
 *     nodes tile their line, so printing them gives the source back.
 *   - The CONTENT layer is what it means: per line, the inlines in paint order, as display
 *     strings (kana composed, values substituted, a 外字注記 as its character) with their
 *     decoration marks.
 *
 * What a node relates to (the end a start pairs with, what a postfix bound to) is the
 * resolver's finding: it sits beside the lines, keyed by the node.
 *
 * Positions are absolute UTF-16 offsets into the source, half-open. A line ends at '\n', '\r\n'
 * or a lone '\r' — the line model of LSP and of the editor.
 *
 * Type-only; imports nothing but the notation's own types.
 */
import type { Channel, EmphasisVariant } from './notation.ts';

/** Half-open UTF-16 range `[start, end)` into the source. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A verbatim source slice and where it sits. */
export interface Part {
  readonly span: Span;
  readonly text: string;
}

/**
 * What a part of an annotation is: `bracket` ［＃ ］ ｜ 《 》 and the ※ of a 外字注記; `scaffold`
 * ここから ここで 終わり ここに の値を表示; `connector` に は; `corner` 「 」; `direction` の左に 左に;
 * `keyword` the command word (a variant, 改ページ, ３字下げ, 縦中横, a heading literal, のルビ, what
 * a 外字注記 holds); `name` a value name; `target` a 対象文字列; `reading` a reading; `inner` the
 * text of an unrecognized annotation.
 */
export type PartRole =
  | 'bracket'
  | 'scaffold'
  | 'connector'
  | 'corner'
  | 'direction'
  | 'keyword'
  | 'name'
  | 'target'
  | 'reading'
  | 'inner';

export interface RolePart extends Part {
  readonly role: PartRole;
}

/** A line terminator as typed; '' on the last line. */
export type Eol = '' | '\n' | '\r\n' | '\r';

/** 見出し level: 大 = 1, 中 = 2, 小 = 3. */
export type HeadingLevel = 1 | 2 | 3;

/** The slots a span start/end drives: the four decoration channels, the heading, the block indent. */
export type SpanChannel = Channel | 'heading' | 'indent';

/** One decoration: the variant and its side. */
export interface Mark {
  readonly variant: EmphasisVariant;
  readonly left: boolean;
}

// Syntax layer

interface NodeBase {
  readonly span: Span;
  /** The source slice, verbatim — never normalized. */
  readonly text: string;
}

interface AnnotationBase extends NodeBase {
  /** The parts in source order; they tile the node. */
  readonly parts: readonly RolePart[];
}

/** A corner-target postfix: the 対象文字列 it names. */
interface Targeted {
  readonly target: Part;
}

/** A decoration as written: its mark and the channel it drives. */
interface Styled extends Mark {
  readonly channel: Channel;
}

/** A run of prose; `rubyBase` marks the base carved out for the implicit ruby that follows it. */
export interface TextNode extends NodeBase {
  readonly kind: 'text';
  readonly rubyBase?: true;
}

/** The ｜ of an explicit ruby — only a ｜ that got its reading; any other stays in a text node. */
export interface RubyMarkNode extends NodeBase {
  readonly kind: 'rubyMark';
}

/** A 《reading》 that made a ruby; its base is the node(s) over `base`. */
export interface RubyReadingNode extends AnnotationBase {
  readonly kind: 'rubyReading';
  readonly reading: Part;
  readonly implicit: boolean;
  /** Implicit: the base text node. Explicit: from the ｜ up to the 《. */
  readonly base: Span;
}

/** A closed ［＃…］ nothing recognizes: it takes no effect. */
export interface CommentNode extends AnnotationBase {
  readonly kind: 'comment';
  readonly inner: Part;
}

/** An unclosed ［＃ up to its line end: its characters are content, as typed. */
export interface BrokenAnnotationNode extends NodeBase {
  readonly kind: 'brokenAnnotation';
}

export interface PageBreakNode extends AnnotationBase {
  readonly kind: 'pageBreak';
}

/** ［＃○字下げ］ at a line head, ○ up to the notation's maximum; anything else is a comment. */
export interface IndentNode extends AnnotationBase {
  readonly kind: 'indent';
  readonly amount: number;
}

export interface IndentBlockStartNode extends AnnotationBase {
  readonly kind: 'indentBlockStart';
  readonly amount: number;
}

export interface IndentBlockEndNode extends AnnotationBase {
  readonly kind: 'indentBlockEnd';
}

export interface EmphasisSpanStartNode extends AnnotationBase, Styled {
  readonly kind: 'emphasisSpanStart';
  /** The ここから form (太字/斜体 only). */
  readonly block?: true;
}

export interface EmphasisSpanEndNode extends AnnotationBase, Styled {
  readonly kind: 'emphasisSpanEnd';
  /** The ここで form. */
  readonly block?: true;
}

export interface HeadingSpanStartNode extends AnnotationBase {
  readonly kind: 'headingSpanStart';
  readonly level: HeadingLevel;
  readonly block?: true;
}

export interface HeadingSpanEndNode extends AnnotationBase {
  readonly kind: 'headingSpanEnd';
  readonly level: HeadingLevel;
  readonly block?: true;
}

export interface TcySpanStartNode extends AnnotationBase {
  readonly kind: 'tcySpanStart';
}

export interface TcySpanEndNode extends AnnotationBase {
  readonly kind: 'tcySpanEnd';
}

export interface EmphasisPostfixNode extends AnnotationBase, Targeted, Styled {
  readonly kind: 'emphasisPostfix';
}

export interface TcyPostfixNode extends AnnotationBase, Targeted {
  readonly kind: 'tcyPostfix';
}

export interface HeadingPostfixNode extends AnnotationBase, Targeted {
  readonly kind: 'headingPostfix';
  readonly level: HeadingLevel;
}

export interface RubyLeftPostfixNode extends AnnotationBase, Targeted {
  readonly kind: 'rubyLeftPostfix';
  readonly reading: Part;
}

export interface ValueFieldNode extends AnnotationBase {
  readonly kind: 'valueField';
  readonly name: Part;
}

/** A 外字注記 that is read, its ※ included: one character (https://www.aozora.gr.jp/annotation/external_character.html). */
export interface GaijiNode extends AnnotationBase {
  readonly kind: 'gaiji';
  /** The character it stands for. */
  readonly char: string;
}

export type SpanOpenerNode = IndentBlockStartNode | EmphasisSpanStartNode | HeadingSpanStartNode;
export type SpanCloserNode = IndentBlockEndNode | EmphasisSpanEndNode | HeadingSpanEndNode;
/** Every node that starts or ends a span, the 縦中横 ones included. */
export type PairedNode = SpanOpenerNode | SpanCloserNode | TcySpanStartNode | TcySpanEndNode;
export type PostfixNode =
  | EmphasisPostfixNode
  | TcyPostfixNode
  | HeadingPostfixNode
  | RubyLeftPostfixNode;

/** Every annotation the classifier can produce from a closed ［＃…］. */
export type AnnotationNode =
  | CommentNode
  | PageBreakNode
  | IndentNode
  | SpanOpenerNode
  | SpanCloserNode
  | TcySpanStartNode
  | TcySpanEndNode
  | PostfixNode
  | ValueFieldNode;

export type SyntaxNode =
  | TextNode
  | RubyMarkNode
  | RubyReadingNode
  | BrokenAnnotationNode
  | GaijiNode
  | AnnotationNode;

// Content layer

/** The decorations in effect, one slot per channel; an absent key is that channel off. */
export type Marks = Readonly<Partial<Record<Channel, Mark>>>;

/**
 * Where a run's characters come from: `prose` typed text; `value` a substituted value; `gaiji` a
 * 外字注記; `markup` ruby markup printed as typed (its base came out empty); `broken` an unclosed ［＃.
 */
export type CharsOrigin = 'prose' | 'value' | 'gaiji' | 'markup' | 'broken';

/** A run of characters laid out one per cell; a slice of ONE syntax node with uniform marks. */
export interface Chars {
  readonly kind: 'chars';
  readonly text: string;
  readonly span: Span;
  /**
   * Where each character of `text` was written, when its source had a kana composed or a character
   * dropped; without it, each sits at `span.start` plus its offset in `text`. A character is a
   * grapheme cluster: a composed kana covers its kana and mark, a kanji its variation selector.
   * The characters of a value and of a 外字注記 have no place of their own: they all come from
   * `span`, the annotation.
   */
  readonly starts?: readonly number[];
  readonly origin: CharsOrigin;
  readonly marks: Marks;
}

/** A base with its readings; atomic. */
export interface Ruby {
  readonly kind: 'ruby';
  readonly base: string;
  readonly right?: string;
  readonly left?: string;
  readonly span: Span;
  readonly marks: Marks;
}

/** A 縦中横 cell; atomic, one cell whatever it holds. `span` is where that was written, its annotations aside. */
export interface Tcy {
  readonly kind: 'tcy';
  readonly text: string;
  readonly span: Span;
  readonly marks: Marks;
}

/** An annotation that takes no effect: zero-width, undecorated. `inner` is a display string. */
export interface CommentInline {
  readonly kind: 'comment';
  readonly inner: string;
  readonly span: Span;
}

export type Inline = Chars | Ruby | Tcy | CommentInline;

// Findings

/** What the scan alone can tell. */
export type ScanIssue =
  | { readonly kind: 'unclosedAnnotation'; readonly span: Span }
  // `span`: the whole annotation, which is left a comment.
  | { readonly kind: 'indentTooLarge'; readonly span: Span }
  // `span`: the 《…》 left as text, from its ｜ when one opened it.
  | { readonly kind: 'rubyBaseMissing'; readonly span: Span; readonly reading: string }
  | { readonly kind: 'rubyReadingEmpty'; readonly span: Span };

/** Every structural finding; the kind names the defect, never a message. */
export type Issue =
  | ScanIssue
  | { readonly kind: 'unterminatedSpan' | 'danglingSpanEnd'; readonly span: Span; readonly block: boolean }
  // `span`: the end, paired with a start of the other form; `expected` is the end respelled in that form.
  | { readonly kind: 'spanFormMismatch'; readonly span: Span; readonly expected: string }
  // `span`: a start written while its channel is in effect; `mark` what was in effect, `redundant`
  // whether the start sets that very mark again (then it does nothing; otherwise it replaces the
  // earlier start).
  | { readonly kind: 'spanAlreadyOpen'; readonly span: Span; readonly mark: string; readonly redundant: boolean }
  | { readonly kind: 'unterminatedTcy' | 'danglingTcyEnd'; readonly span: Span }
  | { readonly kind: 'postfixTargetMissing'; readonly span: Span; readonly target: string }
  /** A ruby a 縦中横 swallowed: its reading is dropped, the base text alone makes the cell. */
  | { readonly kind: 'rubyInTcy'; readonly span: Span; readonly reading: string };

// Documents

export interface SyntaxLine {
  /** 0-based line number, as LSP counts lines. */
  readonly index: number;
  /** The line's content; the terminator sits at `[span.end, span.end + eol.length)`. */
  readonly span: Span;
  readonly eol: Eol;
  readonly syntax: readonly SyntaxNode[];
}

export interface Line extends SyntaxLine {
  readonly content: readonly Inline[];
  /** 字下げ in effect on this line: its own ［＃○字下げ］, else the open block's. */
  readonly indent: number;
  /** 見出し level, when a bound postfix, a span or a block covers the line. */
  readonly heading?: HeadingLevel;
  readonly pageBreak: boolean;
  /** A ここから／ここで directive sits on this line. */
  readonly blockDirective: boolean;
}

/** The scan's result: the syntax layer alone. */
export interface Syntax {
  readonly lines: readonly SyntaxLine[];
  /** In source order. */
  readonly issues: readonly ScanIssue[];
}

/** What a ［＃縦中横］ span holds: the text its cell shows and where that was written. */
export interface Held {
  readonly text: string;
  readonly span: Span;
}

/**
 * The resolved manuscript: both layers, the findings, the spans still open at the end, and the
 * relations — Maps keyed by the nodes of `lines`, so a JSON copy leaves them out. A node without
 * an entry found nothing.
 */
export interface Ast {
  readonly lines: readonly Line[];
  /** In source order. */
  readonly issues: readonly Issue[];
  /** The span starts still open at the end of input, in source order; at most one per channel. */
  readonly openAtEnd: readonly SpanOpenerNode[];
  /** A span start or end → the span of the node it pairs with. */
  readonly pairs: ReadonlyMap<PairedNode, Span>;
  /** A corner-target postfix → the span it bound to. */
  readonly bound: ReadonlyMap<PostfixNode, Span>;
  /** A ［＃縦中横］ start that opened a span → what the span holds. */
  readonly held: ReadonlyMap<TcySpanStartNode, Held>;
}

/** Supplies the values of ［＃ここに「…」の値を表示］ by name; a Map is one. */
export interface ValueLookup {
  get(name: string): string | undefined;
}
