/**
 * The `jpnov/build`, `jpnov/listBooks` and `jpnov/bookCounts` request handlers. Constraints:
 * - the request's `projectDirs` map DEFINES the targeted roots; every `*.jpbook` under a root
 *   is a book (dot-folders, `node_modules` and every other targeted root are never scanned); the
 *   `openBooks` it names are books too;
 * - two book files that resolve to the same output file are a build error and neither is written;
 * - everything about a book comes from its own directory: its entries resolve against it, as the
 *   live editor features resolve them, and its output lands in `<dir>/<outDir>/<stem>.<ext>`,
 *   the stem being the book's path from the folder `outDir` counts from, `/` written `-` (a
 *   `${workspaceFolder}/…` outDir, the default included, counts from the book's root instead,
 *   when it has one);
 * - a `.jpbook` with an Error line, an unterminated metadata block, or a required key empty or
 *   unwritten fails as a whole: `checkJpbook` reports the first of these in document order;
 * - page furniture comes from each book's OWN metadata (`composeBookChrome`), so one batch build
 *   carries a different header per volume;
 * - the server never touches `vscode.fs` nor decodes bytes: manuscript text arrives through
 *   `jpnov/readText` (the client answers with the text the editor shows) and artifacts leave
 *   here as text the CLIENT writes (owning the `.txt` encoding);
 * - vscode-free — the runtime `Connection` is reached only through {@link ServerContext}.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CancellationToken } from 'vscode-languageserver/node';

import { checkJpbook, composeBookChrome, entryPathOf, jpbookStem, NO_NAMES, parseJpbook } from '#/shared/book/jpbook.ts';
import type { JpbookMeta, ParsedJpbook, ParsedLine } from '#/shared/book/jpbook.ts';
import { bookCounts, concatBookText, renderBook } from '#/shared/compiler/document.ts';
import type { TitledBook } from '#/shared/compiler/document.ts';
import { epubMembers } from '#/shared/compiler/epub.ts';
import { errorText } from '#/shared/utils/errors.ts';
import { LocalizedError } from '#/shared/messages.ts';
import { resolveHtmlSettings } from '#/shared/config/settings.ts';
import { OUT_DIR_DEFAULT, outDirSubpath, type OutDir } from '#/shared/config/validate.ts';
import type {
  BookCountsParams,
  BookCountsResult,
  BookEntry,
  BuildArtifact,
  BuildError,
  BuildFormat,
  BuildParams,
  BuildResult,
  HtmlSettings,
  ListBooksParams,
  ListBooksResult,
  LocalizableMessage,
  ProjectDirsMap,
  ReadTextResult,
} from '#/shared/protocol.ts';
import { fileLevelError } from './diagnostics.ts';
import { diagnoseJpbook } from './jpbook.ts';
import { baseName, childUri, isFileScheme, normalizeRootUri, parentUri, resolveUri } from './fsUri.ts';
import type { ServerContext } from './context.ts';
import type { BookNames, RootNames } from './highlight/vocabulary.ts';

/** One targeted root, always `file:`: its normalized URI and the validated `outDir`. */
interface ProjectRoot {
  readonly rootUri: string;
  /** `jpnov.layout.outDir` as the server joins it ({@link outDirSubpath}, else the default). */
  readonly outDir: OutDir;
  /** The {@link dirKey} of every targeted root; a nested root ends the walk. */
  readonly rootDirs: ReadonlySet<string>;
}

/** One book to list or build: a {@link BookEntry} discovered under a root or sent open, with its resolved output directory and stem. */
interface BookTarget extends Omit<BookEntry, 'title'> {
  readonly outDirUri: string;
  /** The output file name without extension ({@link targetOf}). */
  readonly stem: string;
}

/**
 * How one build is narrowed. `books` is required-but-`| undefined` (not optional) on purpose:
 * under `exactOptionalPropertyTypes` that keeps the always-constructed literal in
 * `handleBuild` free of an omit-when-undefined dance.
 */
interface BuildSelection {
  readonly format: BuildFormat;
  /** The re-resolved render settings; every format reads its slice, the paper/chrome fields are html-only. */
  readonly settings: HtmlSettings;
}

/**
 * A directory's fs path as a {@link ProjectRoot.rootDirs} key. NFC: the disk may hold a name
 * decomposed where the folder's URI holds it composed.
 */
function dirKey(fsPath: string): string {
  return fsPath.normalize('NFC');
}

/** The validated `outDir` of a request field, NFC; the default when the value names no folder. */
function outDirOf(value: string): OutDir {
  return outDirSubpath(value.normalize('NFC')) ?? OUT_DIR_DEFAULT;
}

/**
 * A listed book with its output directory and stem. The directory is `outDir` from the book's
 * workspace folder when the value says so and it has one, else from its own directory; the stem
 * is the book's path from that same base without `.jpbook`, `/` written `-`, so two same-named
 * books of one root land apart while a book-relative `outDir` keeps the bare file name. A
 * validated `rel` always encodes, so the null arm is never taken; an empty `rel` (`.`) resolves
 * to the base with a trailing slash, which dirs never carry.
 */
function targetOf(entry: Omit<BookTarget, 'outDirUri' | 'stem'>, outDir: OutDir): BookTarget {
  const fromRoot = outDir.fromRoot && entry.rootUri !== null;
  const base = fromRoot ? entry.rootUri : parentUri(entry.uri);
  const stem = jpbookStem(fromRoot ? entry.fileRel : entry.fileRel.slice(entry.fileRel.lastIndexOf('/') + 1)).replaceAll('/', '-');
  return { ...entry, outDirUri: normalizeRootUri(resolveUri(base, outDir.rel) ?? base), stem };
}

/**
 * Recursively walks one targeted root collecting every `*.jpbook` file. Three fixed exclusions,
 * deliberately NOT configurable: dot-DIRECTORIES (dot-files still match), any `node_modules` at
 * any depth, and every other targeted root — a root nested in this one keeps its books to
 * itself. The root comparison happens in DECODED fs-path space (the walk needs the fs path for
 * `readdir` anyway), so it never depends on percent-encoding. Symlinked dirents report neither
 * file nor directory under `withFileTypes`, so links are never followed (no cycle risk).
 * Results are sorted by `fileRel` for deterministic output.
 */
async function discoverJpbooks(root: ProjectRoot): Promise<BookTarget[]> {
  const found = await Array.fromAsync(walkJpbooks(root.rootUri, fileURLToPath(root.rootUri), '', root.rootDirs));
  found.sort((a, b) => (a.fileRel < b.fileRel ? -1 : a.fileRel > b.fileRel ? 1 : 0));
  return found.map((entry) => targetOf({ ...entry, rootUri: root.rootUri }, root.outDir));
}

/** The recursive walk behind {@link discoverJpbooks}; yields matches depth-first in `readdir` order. */
async function* walkJpbooks(
  dirUri: string,
  dirPath: string,
  dirRel: string,
  rootDirs: ReadonlySet<string>,
): AsyncGenerator<{ uri: string; fileRel: string }> {
  let dirents;
  try {
    dirents = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    const rel = dirRel === '' ? dirent.name : `${dirRel}/${dirent.name}`;
    if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.jpbook')) {
      yield { uri: childUri(dirUri, dirent.name), fileRel: rel };
    } else if (dirent.isDirectory()) {
      if (dirent.name.startsWith('.') || dirent.name === 'node_modules') {
        continue;
      }
      const childPath = join(dirPath, dirent.name);
      if (rootDirs.has(dirKey(childPath))) {
        continue;
      }
      yield* walkJpbooks(childUri(dirUri, dirent.name), childPath, rel, rootDirs);
    }
  }
}

/**
 * The roots a request targets: every `file:` entry of `projectDirs` with its `outDir` validated —
 * the map is the SOLE source of discoverable roots. A virtual-fs tree cannot be enumerated, so
 * such a root yields no books.
 */
function targetRoots(projectDirs: ProjectDirsMap): ProjectRoot[] {
  const resolved = Object.entries(projectDirs)
    .map(([rawUri, dirs]) => ({ rootUri: normalizeRootUri(rawUri), outDir: outDirOf(dirs.outDir) }))
    .filter(({ rootUri }) => isFileScheme(rootUri));
  const rootDirs = new Set(resolved.map((r) => dirKey(fileURLToPath(r.rootUri))));
  return resolved.map((r) => ({ ...r, rootDirs }));
}

/** Every book a request names: those discovered under its roots (root by root), then its open books; with the roots themselves. */
async function bookTargets(params: ListBooksParams): Promise<{ roots: ProjectRoot[]; books: BookTarget[] }> {
  const roots = targetRoots(params.projectDirs);
  const discovered = await Promise.all(roots.map(discoverJpbooks));
  const open = (params.openBooks ?? []).map((book) => targetOf({ uri: book.uri, rootUri: null, fileRel: baseName(book.uri) }, outDirOf(book.outDir)));
  return { roots, books: [...discovered.flat(), ...open] };
}

/** The output file (no extension) a book's artifacts share: what two books must not resolve alike. */
function outPathOf(book: BookTarget): string {
  return childUri(book.outDirUri, book.stem);
}

/**
 * The books whose output path another book of the same build also claims, mapped to the
 * collision message. Judged over the books being built: a book nobody asked for cannot clobber.
 */
function collisionsOf(books: readonly BookTarget[]): Map<string, LocalizableMessage> {
  const byPath = Map.groupBy(books, outPathOf);
  const collisions = new Map<string, LocalizableMessage>();
  for (const [path, claimants] of byPath) {
    if (claimants.length > 1) {
      const list = claimants.map((b) => b.fileRel).sort().join(', ');
      for (const book of claimants) {
        collisions.set(book.uri, { code: 'build.outPathCollision', args: [path, list] });
      }
    }
  }
  return collisions;
}

/** The reply's text, or the {@link LocalizedError} its failure maps to; `rel` names the file in the message. */
function textOf(reply: ReadTextResult, rel: string): string {
  if (reply.ok) {
    return reply.text;
  }
  switch (reply.reason) {
    case 'notFound':
      throw new LocalizedError({ code: 'book.entryFileNotFound', args: [rel] });
    case 'notText':
      throw new LocalizedError({ code: 'book.entryNotText', args: [rel] });
    case 'noReply':
      throw new LocalizedError({ code: 'book.entryNoReply', args: [rel] });
    case 'other':
      throw new LocalizedError({ code: 'book.entryReadFailed', args: [rel, reply.why] });
    default: {
      const exhaustive: never = reply.reason;
      throw new Error(`textOf: unhandled reason ${String(exhaustive)}`);
    }
  }
}

/** Reads one entry, resolved from the book's directory, through the client; throws a {@link LocalizedError} per failure mode. */
async function readEntry(ctx: ServerContext, dirUri: string, rel: string, token?: CancellationToken): Promise<string> {
  const uri = resolveUri(dirUri, rel);
  if (uri === null) {
    throw new LocalizedError({ code: 'book.entryFileNotFound', args: [rel] });
  }
  return textOf(await ctx.readText(uri, token), rel);
}

/**
 * Reads the built entries of one `kind` (`'ok'` chapters or `'coverEntry'` covers; duplicates
 * and muted lines are skipped, an Error line has already failed the book) in manifest order,
 * each resolved from the book's directory. Throws on the first unreadable/missing entry so the
 * caller can convert it into a per-book build error (the diagnostic is published separately).
 */
async function readEntries(
  ctx: ServerContext,
  dirUri: string,
  lines: readonly ParsedLine[],
  kind: 'ok' | 'coverEntry',
  token?: CancellationToken,
): Promise<{ name: string; src: string }[]> {
  const files: { name: string; src: string }[] = [];
  for (const pl of lines) {
    const entry = pl.kind === kind ? entryPathOf(pl) : null;
    if (entry !== null) {
      files.push({ name: entry.value, src: await readEntry(ctx, dirUri, entry.value, token) });
    }
  }
  return files;
}

/** A thrown cause as a {@link LocalizableMessage}: a carried code, else raw text under `build.failed`. */
function toBuildMessage(cause: unknown): LocalizableMessage {
  if (cause instanceof LocalizedError) {
    return cause.localized;
  }
  return { code: 'build.failed', args: [errorText(cause)] };
}

/** One `buildBook` product: an artifact to return + the output dir it lands under
 *  (rolled up into `BuildResult.outDirs`), or an error attributed to the book. */
type BuildOutput =
  | { readonly kind: 'artifact'; readonly outDir: string; readonly artifact: BuildArtifact }
  | { readonly kind: 'error'; readonly error: BuildError };

/**
 * The requested artifact for one successfully read book. renderBook (the paginator) is the
 * expensive step, so a `txt` build never runs it.
 */
function emitArtifact(
  outDirUri: string,
  selection: BuildSelection,
  stem: string,
  input: TitledBook,
  meta: JpbookMeta,
): BuildArtifact {
  switch (selection.format) {
    case 'txt':
      return {
        kind: 'txt',
        path: childUri(outDirUri, `${stem}.txt`),
        content: concatBookText(input, selection.settings.charsPerLine),
      };
    case 'html':
      // Grid geometry and 禁則 come from the request's settings snapshot; the page furniture
      // is composed per book from its own metadata (this is what lets one batch build
      // carry a different header per volume).
      return {
        kind: 'html',
        path: childUri(outDirUri, `${stem}.html`),
        content: renderBook({
          books: [input],
          charsPerLine: selection.settings.charsPerLine,
          linesPerPage: selection.settings.linesPerPage,
          linePitch: selection.settings.linePitch,
          kinsoku: selection.settings.kinsoku,
          dash: selection.settings.dash,
          paperSize: selection.settings.paperSize,
          paperOrientation: selection.settings.paperOrientation,
          fontFamily: selection.settings.fontFamily,
          chrome: composeBookChrome(selection.settings, meta),
        }),
      };
    case 'epub':
      return {
        kind: 'epub',
        path: childUri(outDirUri, `${stem}.epub`),
        members: epubMembers({
          book: input,
          outRel: stem,
          kinsoku: selection.settings.kinsoku,
          dash: selection.settings.dash,
          charsPerLine: selection.settings.charsPerLine,
          // dcterms:modified wants CCYY-MM-DDThh:mm:ssZ — second precision, no milliseconds.
          modified: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        }),
      };
    default: {
      const exhaustive: never = selection.format;
      throw new Error(`emitArtifact: unhandled format ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Builds one book: its artifact, or its error. An output path another book claims fails it
 * first (published on the file), then a manifest with an Error line, before any chapter is read;
 * a throw while compiling is the book's own failure. Null when the file has disappeared since it
 * was listed (nothing to report).
 */
async function buildBook(
  ctx: ServerContext,
  book: BookTarget,
  selection: BuildSelection,
  collision: LocalizableMessage | undefined,
  token?: CancellationToken,
): Promise<BuildOutput | null> {
  const manifest = await ctx.readText(book.uri, token);
  if (!manifest.ok && manifest.reason === 'notFound') {
    return null;
  }
  try {
    const parsed = parseJpbook(textOf(manifest, book.fileRel));
    const dirUri = parentUri(book.uri);
    // Per-line diagnostics (same path the live editor uses); published on the .jpbook URI.
    // LSP send: rejects only on a dead connection (nothing to recover) -> drop the promise.
    const lineDiags = await diagnoseJpbook(dirUri, parsed, ctx.highlight.othersOf(book.uri));
    void ctx.connection.sendDiagnostics({ uri: book.uri, diagnostics: collision ? [...lineDiags, fileLevelError(collision)] : lineDiags });
    if (collision) {
      return { kind: 'error', error: { book: book.fileRel, uri: book.uri, ...collision } };
    }
    // An Error line or a missing key fails the book whatever the format; the first Error line
    // is the root cause.
    const verdict = checkJpbook(parsed);
    if (!verdict.ok) {
      return { kind: 'error', error: { book: book.fileRel, uri: book.uri, ...verdict.error } };
    }
    // The divider and the タイトル／ペンネーム values are BODY-side inputs and ride the
    // BookInput; composeBookChrome carries only the page furniture. Covers are html-only, so a
    // missing cover file cannot fail a txt/epub build; chapters read first, so a book missing
    // both reports the same error whichever format is built.
    const { meta } = verdict;
    const files = await readEntries(ctx, dirUri, parsed.lines, 'ok', token);
    const coverFiles = selection.format === 'html' ? await readEntries(ctx, dirUri, parsed.lines, 'coverEntry', token) : [];
    const input: TitledBook = {
      files,
      divider: meta.divider,
      title: meta.title,
      author: meta.author,
      ...(coverFiles.length > 0 ? { cover: { files: coverFiles } } : {}),
    };
    return { kind: 'artifact', outDir: book.outDirUri, artifact: emitArtifact(book.outDirUri, selection, book.stem, input, meta) };
  } catch (cause) {
    return { kind: 'error', error: { book: book.fileRel, uri: book.uri, ...toBuildMessage(cause) } };
  }
}

/**
 * Handles `jpnov/build` for every book the request names. The result is `ok` when no error was
 * collected; per-book errors are surfaced in `errors[]` and as diagnostics on each offending
 * `.jpbook`. A cancelled `token` makes it stop between books and return what's done — the
 * client has stopped listening, so no RequestCancelled is raised.
 */
export async function handleBuild(ctx: ServerContext, params: BuildParams, token?: CancellationToken): Promise<BuildResult> {
  const { books } = await bookTargets(params);
  const artifacts: BuildArtifact[] = [];
  const outDirs = new Set<string>();
  const errors: BuildError[] = [];

  // `books` ABSENT => build every discovered book; PRESENT (even empty `[]`, which is truthy)
  // => restrict to exactly that set, so an empty selection legitimately builds nothing.
  // Settings are re-resolved once here (clamp + enum coercion of the untrusted payload)
  // and shared by every book in this build.
  const requested = params.books ? new Set(params.books) : undefined;
  const built = requested === undefined ? books : books.filter((b) => requested.has(b.uri));
  const selection: BuildSelection = { format: params.format, settings: resolveHtmlSettings(params.settings) };
  const collisions = collisionsOf(built);

  for (const book of built) {
    if (token?.isCancellationRequested) {
      break;
    }
    const output = await buildBook(ctx, book, selection, collisions.get(book.uri), token);
    if (output?.kind === 'artifact') {
      artifacts.push(output.artifact);
      outDirs.add(output.outDir);
    } else if (output !== null) {
      errors.push(output.error);
    }
  }

  // Spread: a Set doesn't survive JSON-RPC serialization; the wire carries a plain array.
  return { ok: errors.length === 0, outDirs: [...outDirs], artifacts, errors };
}

/**
 * Handles `jpnov/bookCounts`: one book's body figures for the Books view, read like a build
 * (the manifest and its chapters through the client) and laid out on the request's settings.
 * No diagnostics and no `checkJpbook`: the figures are information, not an output, so a book
 * still missing its title counts, and an Error line only drops that entry. A manifest or a
 * chapter that cannot be read leaves the figures null.
 */
export async function handleBookCounts(ctx: ServerContext, params: BookCountsParams, token?: CancellationToken): Promise<BookCountsResult> {
  const manifest = await ctx.readText(params.uri, token);
  if (!manifest.ok) {
    return { counts: null };
  }
  try {
    const parsed = parseJpbook(manifest.text);
    const files = await readEntries(ctx, parentUri(params.uri), parsed.lines, 'ok', token);
    return { counts: bookCounts({ files, divider: parsed.meta.divider }, resolveHtmlSettings(params.settings)) };
  } catch {
    return { counts: null };
  }
}

/**
 * Handles `jpnov/listBooks`: every book the request names as a {@link BookEntry} for the
 * client's Books panel. Each file is read ONCE, through the client like a build, for its
 * `title` (display metadata; an unreadable file simply lists untitled) — but no diagnostics
 * (those belong to an actual build). Listing is also when the server learns the books'
 * `characters:` and `keywords:`: the lists of every book under a root, root by root, become the
 * narration vocabulary ({@link ServerContext.highlight}); an unreadable book contributes none,
 * and a book under no root (sent open) contributes to no root. The client lists on every
 * `.jpbook` change and each time the server comes up, so the store follows the files.
 */
export async function handleListBooks(ctx: ServerContext, params: ListBooksParams): Promise<ListBooksResult> {
  const ticket = ctx.highlight.ticket();
  const targets = await bookTargets(params);
  const read = await Promise.all(targets.books.map(async (book): Promise<{ book: BookTarget; parsed: ParsedJpbook | null }> => {
    const reply = await ctx.readText(book.uri);
    return { book, parsed: reply.ok ? parseJpbook(reply.text) : null };
  }));

  // Every targeted root gets an entry, books or none: a nested root's empty vocabulary shadows its parent's.
  const roots = new Map<string, BookNames[]>(targets.roots.map((root) => [root.rootUri, []]));
  for (const { book, parsed } of read) {
    if (book.rootUri !== null) {
      roots.get(book.rootUri)?.push({ uri: book.uri, fileRel: book.fileRel, names: parsed?.names ?? NO_NAMES });
    }
  }
  ctx.highlight.apply(ticket, [...roots].map(([rootUri, books]): RootNames => ({ rootUri, books })));

  return {
    books: read.map(({ book, parsed }): BookEntry => {
      const title = parsed?.meta.title;
      return {
        uri: book.uri,
        rootUri: book.rootUri,
        fileRel: book.fileRel,
        ...(title !== undefined ? { title } : {}),
      };
    }),
  };
}
