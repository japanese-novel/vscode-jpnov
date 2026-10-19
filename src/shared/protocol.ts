/**
 * LSP message names + payload interfaces for the Japanese Novel client (host) <-> server
 * (forked Node) split. This module is PURE and vscode-free; both sides import it.
 *
 * SINGLE-REPO CONTRACT: the wire shapes live here. Client and server ship together
 * from this one repo, so changing a name/shape is fine as long as BOTH sides move in
 * the same commit — there is no external consumer.
 *
 * Every custom payload below is defined with plain strings so it survives IPC
 * (structured-clone over the forked-process channel) without vscode value types.
 *
 * Every request flows client -> server except `jpnov/readText`, the server's way to obtain
 * manuscript text (it never decodes bytes itself).
 */
import type { EdgeLineStyle, PreviewChrome } from './compiler/chrome.ts';
import type { BookCounts } from './compiler/document.ts';
import type { EpubMember } from './compiler/epub.ts';
import type { PaperOrientation, PaperSize } from './compiler/geometry.ts';
import type { LayoutSettings } from './config/types.ts';
import type { LintCode } from './lint/catalog.ts';
import type { Position } from './utils/position.ts';

// initialize (C->S)

/**
 * A flat snapshot of the user's `jpnov.lint.*` settings, keyed by full setting key
 * (`jpnov.lint.<scope>.<id>`) -> primitive. Plain primitives only, so it survives IPC; the server
 * resolves it to enabled rules via `selectRules()` (`src/shared/lint/select.ts`). Absent keys (and
 * `null`) mean "off", so the client may ship a sparse object.
 */
export type RawLintConfigWire = Readonly<Record<string, boolean | number | string | null>>;

/**
 * Carried on the standard LSP `initialize` request as `initializationOptions`.
 * `lintConfig` seeds the prose-lint selection at startup (omitted = no rules enabled). The
 * client builds the value once and sends each field again by its own notification whenever the
 * server comes up: a field added here needs that push too. The narration vocabulary is not a
 * field: the server reads it from the books it lists (`jpnov/listBooks`).
 */
export interface InitializationOptions {
  readonly lintConfig?: RawLintConfigWire;
}

// Localizable server messages (S->C)

/**
 * The forked server is vscode-free (no `vscode.l10n`), so it never produces final UI text.
 * It emits a CODE plus positional ARGS; the CLIENT renders the localized string via
 * `renderMessage()` (`src/client/messages.ts`) -> `vscode.l10n.t()`. The server fills the
 * English `Diagnostic.message` FALLBACK via the vscode-free `renderEnglish()`
 * (`src/shared/messages.ts`). `args` are IPC-safe primitives, indexed by the `{0}`/`{1}`
 * in each message's English template.
 */
export type MsgCode =
  | 'book.entryFileNotFound' // args: [value]  (ENOENT)
  | 'book.entryReadFailed' // args: [value, why]  (why = raw OS error, untranslatable)
  | 'book.entryNotText' // args: [value]  (the client's decoder refused the bytes: binary content)
  | 'book.entryNoReply' // args: [value]  (the reply to jpnov/readText had no usable shape)
  | 'build.outPathCollision' // args: [path, list] — two book files resolve to the same output file; neither is written
  | 'build.failed' // args: [detail]  (detail = raw build error, untranslatable)
  | 'jpbook.backslashSeparator' // args: [value]
  | 'jpbook.notJpnov' // args: [value]
  | 'jpbook.duplicateEntry' // args: [value]
  | 'jpbook.entryIsDirectory' // args: [value]
  | 'jpbook.fileNotFound' // args: [value]
  | 'jpbook.metaNotKeyValue' // args: [value] — a metadata line (above the `---`) with no key before its colon (or no colon)
  | 'jpbook.metaUnknownKey' // args: [key, knownList]
  | 'jpbook.metaDuplicateKey' // args: [key]  (first value wins)
  | 'jpbook.metaBadEnum' // args: [key, value, allowedList]
  | 'jpbook.dividerNotEncodable' // args: [char]
  | 'jpbook.metaUnterminated' // args: [] — no `---` closes the metadata; range = the first non-blank line below the header, else the header
  | 'jpbook.headerMissing' // args: [header] — the first line is not `jpbook/…`; range = that line (nothing below it is read)
  | 'jpbook.versionUnsupported' // args: [version, supported] — a `jpbook/<version>` header this extension has no parser for; range = that line
  | 'jpbook.metaEmptyValue' // args: [key] — a key that needs a value (title, headerAlign, footerAlign) written without one (range = its line) or not written (range = the closing `---`)
  | 'jpbook.itemWithoutKey' // args: [value] — a "- " list item with no list key (cover:, characters:, keywords:) open above it
  | 'jpbook.nameEmpty' // args: [] — an item of characters:/keywords: with nothing after its marker (or colon); ignored
  | 'jpbook.nameNotPlain' // args: [value] — an item of characters:/keywords: holding an annotation other than ruby, a marker left as text, or a dialogue corner 「」『』; ignored
  | 'jpbook.nameConflict' // args: [base, file] — another .jpbook of the root lists the same base written differently (a reading, a split); range = the item
  | 'syntax.unclosedAnnotation' // args: [] — unterminated ［＃ (no ］ before the line end); the diagnostic range IS the span
  | 'syntax.unterminatedBlock' // args: [] — ［＃ここから…］ with no matching ［＃ここで…終わり］ before EOF; range = the ここから annotation
  | 'syntax.danglingBlockEnd' // args: [] — ［＃ここで…終わり］ with no open block; range = the 終わり annotation
  | 'syntax.unterminatedSpan' // args: [] — inline ［＃…］ opener with no ［＃…終わり］ before EOF (the render runs it to the end); range = the opener
  | 'syntax.danglingSpanEnd' // args: [] — inline ［＃…終わり］ with nothing open in its channel (render no-op); range = the annotation
  | 'syntax.spanAlreadyOpen' // args: [mark] — a start annotation while `mark` (太字, 丸傍点, 大見出し, ２字下げ) is in effect: one setting the same does nothing, one setting another replaces the earlier start; nothing nests. Not reported for a ［＃ここから○字下げ］ of another count, the notation's own way to run blocks of different counts together (https://www.aozora.gr.jp/annotation/layout_2.html); range = the start annotation
  | 'syntax.spanFormMismatch' // args: [expected] — an end of the other form than the start it pairs with (the render closes it all the same); `expected` is the end spelled in the start's form; range = the end annotation
  | 'syntax.postfixTargetMissing' // args: [target] — a corner-target postfix (傍点系/縦中横/左ルビ/見出し) whose target is absent from its line or not aligned to unit boundaries; range = the target inside 「」
  | 'syntax.unterminatedTcy' // args: [] — ［＃縦中横］ with no 終わり before its line end (the render auto-closes); range = the opening annotation
  | 'syntax.danglingTcyEnd' // args: [] — ［＃縦中横終わり］ with no open span (render no-op); range = the annotation
  | 'syntax.tcyTooLong' // args: [] — combined 縦中横 content over 3 grapheme clusters (renders but squishes); range = the content (span form) / the target inside 「」 (postfix form)
  | 'syntax.rubyBaseMissing' // args: [reading] — a closed 《…》 with no base text before it (line start; after punctuation, a space or an annotation; a ｜ with nothing visible before the 《), printed as typed; range = the 《…》 run, from the ｜ when one opened it; fix (no ｜ only): the 《…》 respelled as the 二重山括弧 外字注記
  | 'syntax.rubyReadingEmpty' // args: [] — an empty 《》 (no reading to set), printed as typed; range = the 《》
  | 'syntax.rubyInTcy' // args: [reading] — a ruby inside a ［＃縦中横］ span or under a 縦中横 postfix: the reading is dropped, the base text alone fills the cell; range = the 《…》 inside a span, the whole ruby under a postfix (one per side of a 両側ルビ)
  | 'syntax.indentTooLarge' // args: [limit] — a ［＃○字下げ］ or a ［＃ここから○字下げ］ above the notation's maximum, left a comment; `limit` is the largest count that is read, in full-width digits; range = the annotation
  // hover.* — the lines of a jpnov/hover reply (see HoverResult): first what the annotation is, then what it relates to
  | 'hover.postfix' // args: [mark] — a corner-target postfix: the mark it sets (傍点, 左に傍線, 太字, 縦中横, 大見出し)
  | 'hover.rubyLeft' // args: [reading] — ［＃「…」の左に「reading」のルビ］
  | 'hover.spanStart' // args: [mark] — an inline ［＃mark］ start
  | 'hover.spanEnd' // args: [mark] — an inline ［＃mark終わり］ end
  | 'hover.blockStart' // args: [mark] — a ［＃ここからmark］ start
  | 'hover.blockEnd' // args: [mark] — a ［＃ここでmark終わり］ end
  | 'hover.indent' // args: [count] — a ［＃○字下げ］, N full-width spaces where it stands; `count` in full-width digits
  | 'hover.pageBreak' // args: []
  | 'hover.value' // args: [name] — ［＃ここに「name」の値を表示］; the editor never knows the value
  | 'hover.gaiji' // args: [char] — a 外字注記 and the character it stands for
  | 'hover.comment' // args: [] — a closed ［＃…］ nothing recognizes
  | 'hover.broken' // args: [] — an unclosed ［＃
  | 'hover.ruby' // args: [reading] — a 《reading》
  | 'hover.rubyBase' // args: [text] — the text a ruby reads
  | 'hover.target' // args: [text] — the body text a postfix bound to, as written
  | 'hover.targetMissing' // args: [] — the postfix bound to nothing
  | 'hover.pairEnd' // args: [annotation, line] — a start's end, with its 1-based line
  | 'hover.pairStart' // args: [annotation, line] — an end's start, with its 1-based line
  | 'hover.endMissing' // args: [] — a start with no end
  | 'hover.replaced' // args: [line] — an unpaired ［＃ここから○字下げ］ whose slot a later one of another count took, with its 1-based line
  | 'hover.startMissing' // args: [] — an end with no start
  | 'hover.holds' // args: [text] — what a ［＃縦中横］ span holds
  | LintCode // one prose-lint code per (scope, rule); see lint/catalog.ts
  | 'lint.common.dash.parity' // args: [] — the `dash` rule's second fault: right glyph, odd count
  | 'lint.common.ellipsis.parity' // args: [] — the `ellipsis` rule's second fault: real …, odd count
  | 'lint.common.exclamationRun.long' // args: [] — the `exclamationRun` rule's second fault: 3+ marks
  | 'lint.common.exclamationRun.single' // args: [] — its third fault: a lone half-width ! or ?
  | 'lint.common.questionExclamationMarks.tcy' // args: [pair] — the `questionExclamationMarks` rule in its `tcy` mode: `pair` has no 縦中横 annotation (the bare code, args: [pair, char], is the `fullWidth` mode)
  | 'lint.common.questionExclamationMarks.cut' // args: [target, pair] — the `tcy` mode's second fault: the annotation naming `target` takes one mark of `pair`
  | 'server.unexpected'; // args: [detail]  (detail = raw unexpected server error, untranslatable)

/** A server-produced message: a code plus the positional args its template substitutes. */
export interface LocalizableMessage {
  readonly code: MsgCode;
  readonly args?: readonly (string | number)[];
}

// jpnov/serverError (S->C notification)

export const ServerErrorNotification = 'jpnov/serverError';

/**
 * An unexpected server-side failure surfaced to the user as a popup. The server is vscode-free,
 * so it cannot show UI itself; its lifecycle paths funnel thrown errors through `reportError()`
 * (`src/server/report.ts`), which sends this notification carrying a localizable cause. The client
 * renders `.message` via `renderMessage()` and shows it with `vscode.window.showErrorMessage`.
 */
export interface ServerErrorParams {
  readonly message: LocalizableMessage;
}

// jpnov/hover (C->S request)

export const HoverRequest = 'jpnov/hover';

/** An LSP position: 0-based line, UTF-16 column. */
export type { Position };

/** An LSP range, half-open. */
export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface HoverParams {
  readonly uri: string;
  readonly position: Position;
}

/**
 * What the editor shows over an annotation: `lines` in reading order — what the annotation is,
 * then what it relates to (the 対象文字列 it bound to, the start or end it pairs with) — each a
 * code the client renders; `link` the page of the 青空文庫 guide for its kind. Null off an
 * annotation. A custom request because LSP's Hover carries text, which the server never writes.
 */
export interface HoverResult {
  readonly range: Range;
  readonly lines: readonly LocalizableMessage[];
  readonly link?: string;
}

// jpnov/lintConfigChanged (C->S notification)

export const LintConfigChangedNotification = 'jpnov/lintConfigChanged';

/**
 * Pushed when the user edits any `jpnov.lint.*` setting, and each time the server comes up. The
 * server keeps a vscode-free `RuleSelection`; this carries a fresh full snapshot, which the server
 * re-resolves and then re-lints all open `.jpnov` documents against.
 */
export interface LintConfigChangedParams {
  readonly lintConfig: RawLintConfigWire;
}

// Render settings (C->S, carried on jpnov/renderFile and jpnov/build)

/**
 * The layout-core / `jpnov.layout.preview.*` snapshot the client ships on every
 * `jpnov/renderFile` request. Read at default (resource-less) scope — one window-global
 * set of values, like the lint snapshot. The server re-resolves it (clamp + enum
 * coercion) before rendering; the wire payload is untrusted at runtime.
 */
export interface PreviewSettings extends LayoutSettings, PreviewChrome {}

/**
 * The layout-core / `jpnov.layout.paper.*` snapshot the client ships on every `jpnov/build`
 * request. Every artifact reads its slice (`.txt`: charsPerLine; `.epub`: kinsoku, dash); the
 * paper and chrome fields are `.html`-only. The `.txt` encoding is a client-side setting, never
 * part of this snapshot. Page furniture (ヘッダー/ページ番号) is ABSENT: it is book identity,
 * carried by each `.jpbook`'s own metadata (`composeBookChrome`).
 */
export interface HtmlSettings extends LayoutSettings {
  /** Line-head numbers on built pages (proofing chrome — workspace preference, not book identity). */
  readonly lineNumbers: boolean;
  /** Inter-column rules + page frame (proofing chrome — workspace preference, not book identity). */
  readonly edgeLine: EdgeLineStyle;
  /** Physical output paper (device concern — workspace preference, not book identity). */
  readonly paperSize: PaperSize;
  /** Physical paper orientation; `auto` follows the page grid. Unrelated to 縦書き. */
  readonly paperOrientation: PaperOrientation;
}

// jpnov/build (C->S request)

export const BuildRequest = 'jpnov/build';

/** The artifact kind one build request emits. */
export type BuildFormat = 'html' | 'txt' | 'epub';

/**
 * The `jpnov.layout.outDir` snapshot for ONE workspace folder: a RAW relative string exactly as
 * configured (`scope: resource`, read per folder — unlike the window-global render snapshot).
 * The client never resolves it; the server validates it (`outDirSubpath`), falls back to the
 * default on any invalid value, and joins it onto the directory of each `.jpbook` (onto the
 * book's workspace folder for a `${workspaceFolder}/…` value).
 */
export interface ProjectDirs {
  readonly outDir: string;
}

/**
 * The per-root `jpnov.layout.outDir` snapshot carried on `jpnov/listBooks` and `jpnov/build`:
 * one entry per workspace folder, keyed by folder URI. The map DEFINES which roots the
 * request targets — a root absent from it contributes no books and builds nothing. A root only
 * scopes discovery (a walk stops at a nested root), groups the list and supplies the `outDir`
 * value of the books found under it.
 */
export type ProjectDirsMap = Readonly<Record<string, ProjectDirs>>;

/**
 * A `.jpbook` open in the editor that no workspace folder contains (or with none open), with
 * the `outDir` the client read for its uri. The server lists and builds it like a discovered
 * book: entries from its directory, output in `<dir>/<outDir>`.
 */
export interface OpenBook extends ProjectDirs {
  readonly uri: string;
}

/**
 * Build selectors:
 * - `books`       — restrict to these `.jpbook` URIs. ABSENT = every discovered book;
 *                   PRESENT-BUT-EMPTY (`[]`) = build NOTHING. The two are deliberately distinct.
 * - `format`      — the artifact kind to emit (always stated; there is no both-kinds request).
 * - `settings`    — the client's render-settings snapshot (required; client and server ship
 *                   together, so there is no legacy sender to tolerate).
 * - `projectDirs` — the per-root output dir (see {@link ProjectDirsMap}).
 * - `openBooks`   — the books under no root (see {@link OpenBook}); ABSENT = none.
 */
export interface BuildParams {
  readonly books?: readonly string[];
  readonly format: BuildFormat;
  readonly settings: HtmlSettings;
  readonly projectDirs: ProjectDirsMap;
  readonly openBooks?: readonly OpenBook[];
}

/** The output-location field every {@link BuildArtifact} member carries. */
interface BuildArtifactBase {
  /** Absolute URI of the output file (percent-encoded like the client's `Uri` strings); the CLIENT writes it. */
  readonly path: string;
}

export interface TxtArtifact extends BuildArtifactBase {
  readonly kind: 'txt';
  /** Rendered output text; the client encodes it per `jpnov.layout.txt.encoding` on the way to disk. */
  readonly content: string;
}

export interface HtmlArtifact extends BuildArtifactBase {
  readonly kind: 'html';
  /** Rendered output text; the client writes it UTF-8. */
  readonly content: string;
}

/**
 * One book's EPUB as its member FILES — the server ships the container's parts and the
 * CLIENT zips them and writes `path`. The constant `mimetype` member is added at zip
 * time, never carried here.
 */
export interface EpubArtifact extends BuildArtifactBase {
  readonly kind: 'epub';
  readonly members: readonly EpubMember[];
}

/**
 * One build output, discriminated by `kind` (the request's {@link BuildFormat}). The wire
 * stays text-only, which is why an EPUB travels as member files rather than the zipped bytes.
 */
export type BuildArtifact = TxtArtifact | HtmlArtifact | EpubArtifact;

export interface BuildError extends LocalizableMessage {
  /** The book's {@link BookEntry.fileRel}. */
  readonly book: string;
  /** The `.jpbook` URI (the Books panel's key). */
  readonly uri: string;
}

export interface BuildResult {
  readonly ok: boolean;
  /** Each resolved output dir the artifacts landed under, once (deduplicated server-side);
   *  the client's post-build reveal targets. An errored book contributes no entry. */
  readonly outDirs: readonly string[];
  readonly artifacts: readonly BuildArtifact[];
  readonly errors: readonly BuildError[];
}

// jpnov/listBooks (C->S request)

export const ListBooksRequest = 'jpnov/listBooks';

/** Enumerates the books of every root in `projectDirs`, then the `openBooks` (ABSENT = none). */
export interface ListBooksParams {
  readonly projectDirs: ProjectDirsMap;
  readonly openBooks?: readonly OpenBook[];
}

/**
 * One buildable book = one `*.jpbook`, discovered under a root or sent open. Its `uri` is the
 * STABLE identity the Books panel keys checkbox state on and echoes back in
 * {@link BuildParams.books}; everything about the book (its entries, its output) comes from
 * that uri's directory.
 */
export interface BookEntry {
  /** Absolute URI of the `.jpbook` file (stable id + build selector). */
  readonly uri: string;
  /** The targeted root the book was found under (normalized, no trailing slash); null for an {@link OpenBook}. */
  readonly rootUri: string | null;
  /** Display name: the path under `rootUri` (POSIX separators), e.g. `"part1/vol2.jpbook"`, else the file name. */
  readonly fileRel: string;
  /** The `title`, when written and non-empty — display metadata for the Books panel. */
  readonly title?: string;
}

export interface ListBooksResult {
  readonly books: readonly BookEntry[];
}

// jpnov/bookCounts (C->S request)

export const BookCountsRequest = 'jpnov/bookCounts';

/**
 * One `.jpbook` to count for the Books view's detail: its chapters read through `jpnov/readText`
 * and laid out as a build would, on the same `settings` snapshot a build carries.
 */
export interface BookCountsParams {
  readonly uri: string;
  readonly settings: HtmlSettings;
}

/** The body's figures; null when the book or one of its chapters could not be read. */
export interface BookCountsResult {
  readonly counts: BookCounts | null;
}

// jpnov/renderFile (C->S request)

export const RenderFileRequest = 'jpnov/renderFile';

/**
 * `uri` is an open document the client synced over textDocument/didOpen: the server renders its
 * own copy (the live dirty buffer) from the editor's parse. `settings` is the client's snapshot.
 */
export interface RenderFileParams {
  readonly uri: string;
  readonly settings: PreviewSettings;
}

export interface RenderFileResult {
  readonly html: string;
}

// jpnov/fixAll (C->S request)

export const FixAllRequest = 'jpnov/fixAll';

/** One manuscript as the editor holds it: the client sends the text itself, so the request owes nothing to a `didOpen`. */
export interface FixAllParams {
  readonly uri: string;
  readonly text: string;
}

/** The edits of the editor's "fix all" over `text`, and the number of fixes they carry (a 「…」 rewrite rides a fix, it is not counted). */
export interface FixAllResult {
  readonly edits: readonly { readonly range: Range; readonly newText: string }[];
  readonly fixed: number;
}

// jpnov/readText (S->C request)

export const ReadTextRequest = 'jpnov/readText';

/** The `file:` URI of a `.jpnov` / `.jpbook`, percent-encoded like every URI the server composes. */
export interface ReadTextParams {
  readonly uri: string;
}

/** Why there is no text: a missing file, non-text bytes, any other I/O failure; `noReply` is the server's own verdict on a reply of no usable shape (the client never sends it). */
export type ReadTextFailure = 'notFound' | 'notText' | 'noReply' | 'other';

/**
 * The text as the editor shows it: an open document's live buffer (unsaved edits included), else
 * the disk decoded with the encoding VS Code picks for the uri. `why` is the raw client-side
 * message (untranslatable); only `other` surfaces it.
 */
export type ReadTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: ReadTextFailure; readonly why: string };
