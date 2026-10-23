/**
 * The build-time contract between scripts/render.ts and the Astro components: one JSON document,
 * src/generated/renders.json, produced from the product's own compiler, highlighter and lint
 * engine and baked into the page at build time. Nothing in the browser reads it.
 */
import type { CountsVM } from '../../src/client/protocol.ts';
import type { TokenType } from '../../src/server/semanticTokens.ts';
import type { BookScoped } from './scope.ts';

export type SampleName =
  | 'hero'
  | 'genkoyoshi'
  | 'notation'
  | 'kinsokuOff'
  | 'kinsokuOn'
  | 'cover'
  | 'stageTyping'
  | 'stageEmphasised'
  | 'stageFixed'
  | 'stageBook';

/** The product's highlight kinds (src/server/semanticTokens.ts HIGHLIGHTS) and plain text; `direction`
 *  folds into `marker` because both map to the `comment` token type and paint alike. */
export type TokenKind = 'text' | Exclude<TokenType, 'direction'>;

export interface EditorToken {
  readonly text: string;
  readonly kind: TokenKind;
}

/** One source line as coloured runs; {@link lineText} gives the line back. */
export type EditorLine = readonly EditorToken[];

export function lineText(line: EditorLine): string {
  return line.map((run) => run.text).join('');
}

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

/** A diagnostic as VS Code lists it: `message`, then `source(code)`. */
export interface DiagnosticOut {
  readonly source: string;
  readonly code: string;
  /** LSP coordinates: 0-based line, UTF-16 character. */
  readonly range: Range;
  /** The Japanese message; the quick-fix entry VS Code shows is the same text. */
  readonly message: string;
}

/**
 * A compiler render scoped for embedding: `css` is a complete stylesheet whose every selector
 * starts with `scope` (a class selector), `body` the inner HTML of the element carrying that class.
 */
export interface Fragment {
  readonly scope: string;
  readonly css: string;
  readonly body: string;
}

/** A character range on one editor line, in code points (the editor slices lines with `Array.from`). */
export interface LineSpan {
  readonly from: number;
  readonly to: number;
}

/** The product's hover over the stage annotation and the ranges that light up with the caret on it. */
export interface AnnotationHover {
  /** 0-based line of the annotation. */
  readonly line: number;
  /** Code-point column where the annotation starts. */
  readonly column: number;
  /** The hover's lines in Japanese, as the client renders them (the first in bold). */
  readonly lines: readonly string[];
  readonly highlights: readonly LineSpan[];
}

export interface PreviewRender {
  readonly kind: 'preview';
  readonly src: string;
  /** charsPerLine plus the two frame insets: an embed's pane height is `bandCells × em + 32px`. */
  readonly bandCells: number;
  readonly editorLines: readonly EditorLine[];
  readonly diagnostics: readonly DiagnosticOut[];
  readonly preview: Fragment;
  /** Present on the stage's emphasised state: the hover beat 2 shows over the annotation it types. */
  readonly annotation?: AnnotationHover;
}

export interface BookRender extends BookScoped {
  readonly kind: 'book';
  /** The body's figures as the Books view's status row prints them, in the product's Japanese. */
  readonly counts: CountsVM;
  /** The figures before the sample's `pending` chapter joins the book (the same as `counts` without one). */
  readonly countsBefore: CountsVM;
}

export type SampleRender = PreviewRender | BookRender;

export interface Renders {
  readonly samples: Readonly<Record<SampleName, SampleRender>>;
  /** The product's build output for the stage book, verbatim: what its 印刷／PDF 保存 link opens. */
  readonly artifacts: { readonly book: string };
}
