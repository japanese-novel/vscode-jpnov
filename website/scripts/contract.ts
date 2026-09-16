/**
 * The build-time contract between scripts/render.ts and the Astro components: one JSON document,
 * src/generated/renders.json, produced from the product's own compiler, highlighter and lint
 * engine and baked into the page at build time. Nothing in the browser reads it.
 */

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

/** The product's semantic-token kinds (src/server/semanticTokens.ts); `direction` folds into
 *  `marker` because both map to the `comment` token type and paint alike. */
export type TokenKind = 'text' | 'marker' | 'directive' | 'character' | 'keyword';

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

export interface DiagnosticOut {
  readonly code: string;
  /** LSP coordinates: 0-based line, UTF-16 character. */
  readonly range: Range;
  readonly message: { readonly en: string; readonly ja: string };
  /** Present iff the rule is auto-fixable; the quick-fix entry VS Code shows is `message.ja`. */
  readonly fix?: { readonly range: Range; readonly newText: string };
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

/** What an embed needs to size a preview pane. */
export interface PreviewOptions {
  readonly charsPerLine: number;
  /** charsPerLine plus the two frame insets: the pane height is `bandCells × em + 32px`. */
  readonly bandCells: number;
}

export interface PreviewRender {
  readonly kind: 'preview';
  readonly src: string;
  readonly options: PreviewOptions;
  readonly editorLines: readonly EditorLine[];
  readonly diagnostics: readonly DiagnosticOut[];
  readonly preview: Fragment;
  /** Present on a sample produced by applying the product's `source.fixAll` action to another. */
  readonly fixAll?: { readonly title: { readonly en: string; readonly ja: string } };
}

export interface BookRender {
  readonly kind: 'book';
  readonly fragment: Fragment;
  /** From the build's `@page` size and root font size; lets an embed size the sheet to any width. */
  readonly paper: { readonly widthMm: number; readonly heightMm: number; readonly fontMm: number };
  /** Pages kept in `fragment`. */
  readonly pageCount: number;
  /** Body pages of the whole book — the footer's 総ページ数. */
  readonly totalPages: number;
}

export type SampleRender = PreviewRender | BookRender;

export interface Renders {
  readonly generatedBy: string;
  readonly samples: Readonly<Record<SampleName, SampleRender>>;
  /** The product's build output for the stage book, verbatim: what its 印刷／PDF 保存 link opens. */
  readonly artifacts: { readonly book: string };
}
