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
import type { EpubMember } from './compiler/epub.ts';
import type { PaperOrientation, PaperSize } from './compiler/geometry.ts';
import type { LayoutSettings } from './config/types.ts';
import type { LintCode } from './lint/catalog.ts';

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
 * `lintConfig` seeds the prose-lint selection at startup (omitted = no rules enabled);
 * `highlight` seeds the per-root narration vocabulary the same way (omitted = no
 * vocabulary anywhere).
 */
export interface InitializationOptions {
  readonly lintConfig?: RawLintConfigWire;
  readonly highlight?: HighlightVocabularyMap;
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
  | 'book.entryNeedsFileScheme' // args: [value]
  | 'book.entryFileNotFound' // args: [value]  (ENOENT)
  | 'book.entryReadFailed' // args: [value, why]  (why = raw OS error, untranslatable)
  | 'book.entryNotText' // args: [value]  (the client's decoder refused the bytes: binary content)
  | 'build.outPathCollision' // args: [outRel, list]
  | 'build.failed' // args: [detail]  (detail = raw build error, untranslatable)
  | 'jpbook.backslashSeparator' // args: [value]
  | 'jpbook.notJpnov' // args: [value]
  | 'jpbook.duplicateEntry' // args: [value]
  | 'jpbook.entryIsDirectory' // args: [value]
  | 'jpbook.fileNotFound' // args: [value]
  | 'jpbook.metaNotKeyValue' // args: [value] — a front-matter line with no key before its colon (or no colon)
  | 'jpbook.metaUnknownKey' // args: [key, knownList]
  | 'jpbook.metaDuplicateKey' // args: [key]  (first value wins)
  | 'jpbook.metaBadEnum' // args: [key, value, allowedList]
  | 'jpbook.dividerNotEncodable' // args: [char]
  | 'jpbook.metaUnterminated' // args: [] — front matter opened but no closing ---; range = the opening fence
  | 'jpbook.coverItemWithoutKey' // args: [value] — a "- path" list item with no bare "cover:" line open above it
  | 'jpbook.coverNeedsList' // args: [value] — `cover:` written with a value; it takes "- path" item lines
  | 'path.empty' // args: [] — the path.* codes are resolveContained's verdicts on a book entry
  | 'path.rootDot' // args: []  (the root "." or a path collapsing to it)
  | 'path.homeRelative' // args: []
  | 'path.absolute' // args: []
  | 'path.invalid' // args: []
  | 'path.escapesRoot' // args: []
  | 'syntax.unclosedAnnotation' // args: [] — unterminated ［＃ (no ］ before the line end); the diagnostic range IS the span
  | 'syntax.unterminatedBlock' // args: [] — ［＃ここから…］ with no matching ［＃ここで…終わり］ before EOF; range = the ここから annotation
  | 'syntax.danglingBlockEnd' // args: [] — ［＃ここで…終わり］ with no open block; range = the 終わり annotation
  | 'syntax.unterminatedSpan' // args: [] — inline ［＃…］ opener with no ［＃…終わり］ before EOF (the render runs it to the end); range = the opener
  | 'syntax.danglingSpanEnd' // args: [] — inline ［＃…終わり］ with nothing open in its channel (render no-op); range = the annotation
  | 'syntax.postfixTargetMissing' // args: [target] — a corner-target postfix (傍点系/縦中横/左ルビ/見出し) whose target is absent from its line or not aligned to unit boundaries; range = the annotation
  | 'syntax.unterminatedTcy' // args: [] — ［＃縦中横］ with no 終わり before its line end (the render auto-closes); range = the opening annotation
  | 'syntax.danglingTcyEnd' // args: [] — ［＃縦中横終わり］ with no open span (render no-op); range = the annotation
  | 'syntax.tcyTooLong' // args: [] — combined 縦中横 content over 3 code points (renders but squishes); range = the content (span form) / the annotation (postfix form)
  | 'syntax.rubyBaseMissing' // args: [reading] — a closed 《…》 with no base text before it (line start; after punctuation, a space or an annotation; a ｜ with nothing visible before the 《), printed as typed; range = the 《…》 run, from the ｜ when one opened it
  | 'syntax.rubyReadingEmpty' // args: [] — an empty 《》 (no reading to set), printed as typed; range = the 《》
  | LintCode // one prose-lint code per (scope, rule); see lint/catalog.ts
  | 'lint.common.dash.parity' // args: [] — the `dash` rule's second fault: right glyph, odd count
  | 'lint.common.ellipsis.parity' // args: [] — the `ellipsis` rule's second fault: real …, odd count
  | 'lint.common.exclamationRun.long' // args: [] — the `exclamationRun` rule's second fault: 3+ marks
  | 'lint.common.exclamationRun.single' // args: [] — its third fault: a lone half-width ! or ?
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

// jpnov/lintConfigChanged (C->S notification)

export const LintConfigChangedNotification = 'jpnov/lintConfigChanged';

/**
 * Pushed when the user edits any `jpnov.lint.*` setting (mirrors the workspace-trust push). The
 * server keeps a vscode-free `RuleSelection`; this carries a fresh full snapshot, which the server
 * re-resolves and then re-lints all open `.jpnov` documents against.
 */
export interface LintConfigChangedParams {
  readonly lintConfig: RawLintConfigWire;
}

// jpnov/highlightChanged (C->S notification)

export const HighlightChangedNotification = 'jpnov/highlightChanged';

/**
 * One workspace folder's narration vocabulary, read from the `jpnov.editor.highlight.*` settings.
 * Both fields are always present — the client sends the folder's effective values verbatim
 * (empty arrays included); the server normalizes (drops non-strings/empties, dedups) on apply.
 */
export interface HighlightVocabulary {
  readonly characters: readonly string[];
  readonly keywords: readonly string[];
}

/**
 * The full per-root vocabulary snapshot, keyed by folder URI (as sent by the client, verbatim).
 * REPLACEMENT semantics: each push carries every workspace folder — a root absent from the map
 * has no vocabulary (mirrors ProjectDirsMap, where the map itself defines the target roots).
 * Empty-listed roots still get an entry so a nested folder's (empty) vocabulary shadows its
 * parent's under longest-prefix routing.
 */
export type HighlightVocabularyMap = Readonly<Record<string, HighlightVocabulary>>;

/**
 * Pushed when the user edits any `jpnov.editor.highlight.*` setting, and re-pushed in full when
 * workspace folders change while the client is running (mirrors the lint push).
 */
export interface HighlightChangedParams {
  readonly highlight: HighlightVocabularyMap;
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
 * request. Every artifact reads its slice (`.txt`: autoTcy + charsPerLine; `.epub`: kinsoku,
 * autoTcy, dash); the paper and chrome fields are `.html`-only. The `.txt` encoding is a
 * client-side setting, never part of this snapshot. Page furniture (ヘッダー/ページ番号) is
 * ABSENT: it is book identity, carried by each `.jpbook`'s own front matter (`composeBookChrome`).
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
 * The client never resolves it; the server resolves it against its root and silently
 * falls back to the default on any invalid value (empty / absolute / escaping / `.`).
 */
export interface ProjectDirs {
  readonly outDir: string;
}

/**
 * The per-root `jpnov.layout.outDir` snapshot carried on `jpnov/listBooks` and `jpnov/build`:
 * one entry per workspace folder, keyed by folder URI. The map DEFINES which roots the
 * request targets — a root absent from it contributes no books and builds nothing.
 */
export type ProjectDirsMap = Readonly<Record<string, ProjectDirs>>;

/**
 * Build selectors:
 * - `books`       — restrict to these `.jpbook` URIs. ABSENT = every discovered book;
 *                   PRESENT-BUT-EMPTY (`[]`) = build NOTHING. The two are deliberately distinct.
 * - `format`      — the artifact kind to emit (always stated; there is no both-kinds request).
 * - `settings`    — the client's render-settings snapshot (required; client and server ship
 *                   together, so there is no legacy sender to tolerate).
 * - `projectDirs` — the per-root output dir (see {@link ProjectDirsMap}).
 */
export interface BuildParams {
  readonly books?: readonly string[];
  readonly format: BuildFormat;
  readonly settings: HtmlSettings;
  readonly projectDirs: ProjectDirsMap;
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
  /** Book identity (e.g. the book dir relative to the workspace folder root). */
  readonly book: string;
  /** The `.jpbook` URI when the error is one book's (the Books panel's key); absent for a root-level fault. */
  readonly uri?: string;
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

/** Enumerates the books of every root in `projectDirs`. */
export interface ListBooksParams {
  readonly projectDirs: ProjectDirsMap;
}

/**
 * One buildable book = one `*.jpbook` discovered under the workspace folder root. Its
 * `uri` is the STABLE identity the Books panel keys checkbox state on and echoes back in
 * {@link BuildParams.books}; `outRel` rides along so the panel can show the real output
 * path without re-deriving it (the derivation stays single-sourced in the server).
 */
export interface BookEntry {
  /** Absolute URI of the `.jpbook` file (stable id + build selector). */
  readonly uri: string;
  /** Owning root URI (normalized, no trailing slash). */
  readonly rootUri: string;
  /** Path relative to the workspace folder root (POSIX separators), e.g. `"part1/vol2.jpbook"`. */
  readonly fileRel: string;
  /** Derived output relative path (`jpbookOutRel`, POSIX `/`); the build appends the format extension. */
  readonly outRel: string;
  /** The front-matter `title`, when present and non-empty — display metadata for the Books panel. */
  readonly title?: string;
}

export interface ListBooksResult {
  readonly books: readonly BookEntry[];
}

// jpnov/renderFile (C->S request)

export const RenderFileRequest = 'jpnov/renderFile';

/** `text` is the live dirty buffer of the previewed file; `settings` the client's snapshot. */
export interface RenderFileParams {
  readonly uri: string;
  readonly text: string;
  readonly settings: PreviewSettings;
}

export interface RenderFileResult {
  readonly html: string;
}

// jpnov/readText (S->C request)

export const ReadTextRequest = 'jpnov/readText';

/** The `file:` URI of a `.jpnov` / `.jpbook`, percent-encoded like every URI the server composes (#76). */
export interface ReadTextParams {
  readonly uri: string;
}

/** Why the client produced no text: the file is missing, its bytes are not text, or any other I/O failure. */
export type ReadTextFailure = 'notFound' | 'notText' | 'other';

/**
 * The text as the editor shows it: an open document's live buffer (unsaved edits included), else
 * the disk decoded with the encoding VS Code picks for the uri. `why` is the raw client-side
 * message (untranslatable); only `other` surfaces it.
 */
export type ReadTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: ReadTextFailure; readonly why: string };
