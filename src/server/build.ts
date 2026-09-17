/**
 * The `jpnov/build` and `jpnov/listBooks` request handlers. Constraints:
 * - the request's `projectDirs` map DEFINES the targeted roots; every `*.jpbook` under a root
 *   is a book (dot-folders, `node_modules` and the resolved output dir are never scanned);
 * - two book files that derive the same output path (`jpbookOutRel`) are a build error and
 *   neither is emitted;
 * - a `.jpbook` with an Error line is that book's build error (the first such line's message);
 *   the book is never built partially;
 * - `.jpbook` entries resolve against the WORKSPACE FOLDER ROOT (the same base the live editor
 *   features use), and page furniture comes from each book's OWN front matter
 *   (`composeBookChrome`), so one batch build carries a different header per volume;
 * - the server never touches `vscode.fs` nor decodes bytes: manuscript text arrives through
 *   `jpnov/readText` (the client answers with the text the editor shows) and artifacts leave
 *   here as text the CLIENT writes (owning the `.txt` encoding);
 * - vscode-free — the runtime `Connection` is reached only through {@link ServerContext}.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CancellationToken, WorkDoneProgressReporter } from 'vscode-languageserver/node';

import { composeBookChrome, coverPathOf, firstErrorOf, jpbookOutRel, parseJpbook } from '#/shared/book/jpbook.ts';
import type { JpbookMeta, ParsedLine } from '#/shared/book/jpbook.ts';
import { concatBookText, renderBook } from '#/shared/compiler/document.ts';
import type { BookInput } from '#/shared/compiler/document.ts';
import { chapterStem, epubMembers } from '#/shared/compiler/epub.ts';
import { errorText } from '#/shared/errors.ts';
import { LocalizedError } from '#/shared/messages.ts';
import { resolveHtmlSettings } from '#/shared/config/settings.ts';
import { resolveContained } from '#/shared/config/validate.ts';
import { PROJECT_DEFAULT } from '#/shared/config/types.ts';
import type {
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
import { childUri, isFileScheme, normalizeRootUri } from './fsUri.ts';
import type { ServerContext } from './context.ts';

/** A `*.jpbook` discovered under a workspace folder root. */
interface DiscoveredJpbook {
  /** Path relative to the workspace folder root (POSIX separators), e.g. `"part1/vol2.jpbook"`. */
  readonly fileRel: string;
  /** Absolute URI of the `.jpbook` file (diagnostics target). */
  readonly uri: string;
}

/** One targeted root: its normalized URI plus the RESOLVED output dir URI. */
interface ProjectRoot {
  readonly rootUri: string;
  readonly outDirUri: string;
}

/**
 * How one build is narrowed. `books` is required-but-`| undefined` (not optional) on purpose:
 * under `exactOptionalPropertyTypes` that keeps the always-constructed literal in
 * `handleBuild` free of an omit-when-undefined dance.
 */
interface BuildSelection {
  /** When set, only book files whose URI is in the set are built; `undefined` = every book. */
  readonly books: ReadonlySet<string> | undefined;
  readonly format: BuildFormat;
  /** The re-resolved render settings; every format reads its slice, the paper/chrome fields are html-only. */
  readonly settings: HtmlSettings;
}

function joinRel(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

/**
 * Recursively walks the workspace folder root collecting every `*.jpbook` file. `file:`
 * scheme only — virtual-fs trees cannot be enumerated, so such roots simply yield no books.
 * Three fixed exclusions, deliberately NOT configurable ("your output folder, dot-folders,
 * and node_modules are never scanned"): dot-DIRECTORIES (dot-files still match), any
 * `node_modules` at any depth, and the resolved output dir. The outDir comparison happens in
 * DECODED fs-path space (the walk needs the fs path for `readdir` anyway), so it never
 * depends on percent-encoding. Symlinked dirents report neither file nor
 * directory under `withFileTypes`, so links are never followed (no cycle risk). Results are
 * sorted by `fileRel` for deterministic output and stable collision reporting.
 */
async function discoverJpbooks(rootUri: string, outDirUri: string): Promise<DiscoveredJpbook[]> {
  if (!isFileScheme(rootUri)) {
    return [];
  }
  const found = await Array.fromAsync(walkJpbooks(rootUri, fileURLToPath(rootUri), '', fileURLToPath(outDirUri)));
  found.sort((a, b) => (a.fileRel < b.fileRel ? -1 : a.fileRel > b.fileRel ? 1 : 0));
  return found;
}

/** The recursive walk behind {@link discoverJpbooks}; yields matches depth-first in `readdir` order. */
async function* walkJpbooks(dirUri: string, dirPath: string, dirRel: string, outDirPath: string): AsyncGenerator<DiscoveredJpbook> {
  let dirents;
  try {
    dirents = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.jpbook')) {
      yield {
        fileRel: joinRel(dirRel, dirent.name),
        uri: childUri(dirUri, dirent.name),
      };
    } else if (dirent.isDirectory()) {
      if (dirent.name.startsWith('.') || dirent.name === 'node_modules') {
        continue;
      }
      const childPath = join(dirPath, dirent.name);
      if (childPath === outDirPath) {
        continue;
      }
      yield* walkJpbooks(childUri(dirUri, dirent.name), childPath, joinRel(dirRel, dirent.name), outDirPath);
    }
  }
}

/**
 * Reads the `ok` entries of one parsed `.jpbook` in order (skipping blank/front-matter/
 * duplicate lines; an Error line has already failed the book in {@link buildRoot}), each
 * resolved relative to the WORKSPACE FOLDER ROOT and read through the client, into the shape
 * {@link renderBook} consumes. Throws on the first escaping/unreadable/missing entry so the
 * caller can convert it into a per-book build error (the diagnostic is published separately).
 */
async function readBookFiles(
  ctx: ServerContext,
  rootUri: string,
  lines: readonly ParsedLine[],
  token?: CancellationToken,
): Promise<BookInput> {
  const files: { name: string; src: string }[] = [];
  for (const pl of lines) {
    if (pl.kind !== 'ok') {
      continue;
    }
    files.push({ name: pl.value, src: await readEntry(ctx, rootUri, pl.value, token) });
  }
  return { files };
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
    case 'other':
      throw new LocalizedError({ code: 'book.entryReadFailed', args: [rel, reply.why] });
    default: {
      const exhaustive: never = reply.reason;
      throw new Error(`textOf: unhandled reason ${String(exhaustive)}`);
    }
  }
}

/** Reads one root-relative entry through the client; throws a {@link LocalizedError} per failure mode. */
async function readEntry(ctx: ServerContext, rootUri: string, rel: string, token?: CancellationToken): Promise<string> {
  const resolved = resolveContained(rootUri, rel);
  if (!resolved.ok) {
    throw new LocalizedError({ code: resolved.code });
  }
  if (!isFileScheme(resolved.abs)) {
    throw new LocalizedError({ code: 'book.entryNeedsFileScheme', args: [rel] });
  }
  return textOf(await ctx.readText(resolved.abs, token), rel);
}

/**
 * Reads the built cover entries (`'coverEntry'` only — duplicates and muted lines are
 * skipped, like chapter duplicates) in manifest order, same failure modes as the chapters.
 */
async function readCoverFiles(
  ctx: ServerContext,
  rootUri: string,
  lines: readonly ParsedLine[],
  token?: CancellationToken,
): Promise<{ name: string; src: string }[]> {
  const files: { name: string; src: string }[] = [];
  for (const pl of lines) {
    if (pl.kind !== 'coverEntry') {
      continue;
    }
    const entry = coverPathOf(pl);
    if (entry === null) {
      continue;
    }
    files.push({ name: entry.value, src: await readEntry(ctx, rootUri, entry.value, token) });
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

/** One `buildRoot` product: an artifact to return + the root's output dir it lands under
 *  (rolled up into `BuildResult.outDirs`), or an error attributed to one book. */
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
  outRel: string,
  input: BookInput,
  meta: JpbookMeta,
): BuildArtifact {
  switch (selection.format) {
    case 'txt':
      return {
        kind: 'txt',
        path: childUri(outDirUri, `${outRel}.txt`),
        content: concatBookText(input, selection.settings.autoTcy, selection.settings.charsPerLine),
      };
    case 'html':
      // Grid geometry, 禁則, and 自動縦中横 come from the request's settings snapshot; the
      // page furniture is composed per book from its own front matter (this is what lets
      // one batch build carry a different header per volume).
      return {
        kind: 'html',
        path: childUri(outDirUri, `${outRel}.html`),
        content: renderBook({
          books: [input],
          charsPerLine: selection.settings.charsPerLine,
          linesPerPage: selection.settings.linesPerPage,
          linePitch: selection.settings.linePitch,
          kinsoku: selection.settings.kinsoku,
          autoTcy: selection.settings.autoTcy,
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
        path: childUri(outDirUri, `${outRel}.epub`),
        members: epubMembers({
          book: input,
          meta,
          outRel,
          kinsoku: selection.settings.kinsoku,
          autoTcy: selection.settings.autoTcy,
          dash: selection.settings.dash,
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
 * Builds the book files under one targeted root, yielding artifacts + per-book errors in
 * book order. `selection.books` (when set) restricts WHICH books are built, but the
 * output-path collision map is still computed over ALL of them — a selected book that
 * collides with an UNSELECTED one still errors, so a later full build can never silently
 * clobber it. A manifest with an Error line fails before any chapter is read. A throw while
 * compiling one book is that book's own failure: it becomes the book's error and the
 * remaining books still build.
 */
async function* buildRoot(
  ctx: ServerContext,
  target: ProjectRoot,
  selection: BuildSelection,
  token?: CancellationToken,
): AsyncGenerator<BuildOutput> {
  const jpbooks = await discoverJpbooks(target.rootUri, target.outDirUri);
  // Group by derived output path to detect collisions across the whole root up front.
  const byOutRel = Map.groupBy(jpbooks, (fl) => jpbookOutRel(fl.fileRel));

  for (const fl of jpbooks) {
    // Subset build: skip books outside the requested set entirely (no read, no diagnostics).
    if (selection.books && !selection.books.has(fl.uri)) {
      continue;
    }
    const manifest = await ctx.readText(fl.uri, token);
    if (!manifest.ok && manifest.reason === 'notFound') {
      // Disappeared mid-build; skip silently rather than error on a non-existent file.
      continue;
    }
    try {
      const parsed = parseJpbook(textOf(manifest, fl.fileRel));
      // Per-line diagnostics (same path the live editor uses); published on the .jpbook URI.
      const lineDiags = await diagnoseJpbook(target.rootUri, parsed);
      const outRel = jpbookOutRel(fl.fileRel);
      const colliding = (byOutRel.get(outRel) ?? []).filter((other) => other !== fl);

      if (colliding.length > 0) {
        const list = [fl.fileRel, ...colliding.map((c) => c.fileRel)].sort().join(', ');
        const collision = { code: 'build.outPathCollision' as const, args: [outRel, list] };
        // LSP send: rejects only on a dead connection (nothing to recover) -> drop the promise.
        void ctx.connection.sendDiagnostics({
          uri: fl.uri,
          diagnostics: [...lineDiags, fileLevelError(collision)],
        });
        yield { kind: 'error', error: { book: fl.fileRel, uri: fl.uri, ...collision } };
        continue;
      }

      void ctx.connection.sendDiagnostics({ uri: fl.uri, diagnostics: lineDiags });
      // An Error line fails the book whatever the format; the first one is the root cause (an
      // unclosed front matter reports its fence, not the chapter lines it swallowed).
      const lineError = firstErrorOf(parsed.lines);
      if (lineError !== null) {
        yield { kind: 'error', error: { book: fl.fileRel, uri: fl.uri, ...lineError } };
        continue;
      }
      // The divider and the タイトル／ペンネーム values are BODY-side inputs and ride the
      // BookInput (the title fallback is the EPUB dc:title rule); composeBookChrome carries
      // only the page furniture. Covers are html-only, so a missing cover file cannot fail a
      // txt/epub build; chapters read first, so a book missing both reports the same error
      // whichever format is built.
      const bookFiles = await readBookFiles(ctx, target.rootUri, parsed.lines, token);
      const coverFiles = selection.format === 'html' ? await readCoverFiles(ctx, target.rootUri, parsed.lines, token) : [];
      const input: BookInput = {
        ...bookFiles,
        divider: parsed.meta.divider,
        title: parsed.meta.title ?? chapterStem(outRel),
        author: parsed.meta.author ?? '',
        ...(coverFiles.length > 0 ? { cover: { files: coverFiles } } : {}),
      };
      yield { kind: 'artifact', outDir: target.outDirUri, artifact: emitArtifact(target.outDirUri, selection, outRel, input, parsed.meta) };
    } catch (cause) {
      yield { kind: 'error', error: { book: fl.fileRel, uri: fl.uri, ...toBuildMessage(cause) } };
    }
  }
}

/**
 * Resolves one configured project dir against its root: a contained relative path becomes
 * its absolute URI; anything invalid (empty / absolute / escaping / `.` …) silently falls
 * back to the default.
 */
function resolveProjectDir(rootUri: string, value: string, fallback: string): string {
  const resolved = resolveContained(rootUri, value);
  // The defaults are single-segment relative paths, so this join cannot escape the root.
  return resolved.ok ? resolved.abs : childUri(rootUri, fallback);
}

/** The roots a request targets: every `projectDirs` entry with its output dir resolved — the map is the SOLE source of buildable roots. */
function targetRoots(projectDirs: ProjectDirsMap): ProjectRoot[] {
  return Object.entries(projectDirs).map(([rawUri, dirs]) => {
    const rootUri = normalizeRootUri(rawUri);
    return { rootUri, outDirUri: resolveProjectDir(rootUri, dirs.outDir, PROJECT_DEFAULT.outDir) };
  });
}

/**
 * Handles `jpnov/build` for every root in `projectDirs`. Reports coarse
 * `$/progress` via the supplied work-done reporter (one tick per root). The result is
 * `ok` when no build-level errors were collected; per-book errors are surfaced in
 * `errors[]` and as diagnostics on each offending `.jpbook`. A cancelled `token` makes it
 * stop between books and return what's done — the client has stopped listening, so no
 * RequestCancelled is raised.
 */
export async function handleBuild(
  ctx: ServerContext,
  params: BuildParams,
  progress?: WorkDoneProgressReporter,
  token?: CancellationToken,
): Promise<BuildResult> {
  const roots = targetRoots(params.projectDirs);
  const artifacts: BuildArtifact[] = [];
  const outDirs = new Set<string>();
  const errors: BuildError[] = [];

  // `books` ABSENT => build every discovered book; PRESENT (even empty `[]`, which is truthy)
  // => restrict to exactly that set, so an empty selection legitimately builds nothing.
  // Settings are re-resolved once here (clamp + enum coercion of the untrusted payload)
  // and shared by every root in this build.
  const selection: BuildSelection = {
    books: params.books ? new Set(params.books) : undefined,
    format: params.format,
    settings: resolveHtmlSettings(params.settings),
  };

  // The server cannot localize a $/progress title (no vscode.l10n in the fork); the client shows
  // its own localized progress notification, so begin with no English label.
  progress?.begin('', 0, undefined, false);

  for (const [index, target] of roots.entries()) {
    if (token?.isCancellationRequested) {
      break;
    }
    try {
      // for-await (not Array.fromAsync) so outputs yielded before a mid-root throw are kept;
      // the throw itself (book discovery, iteration) becomes a root-level error.
      for await (const output of buildRoot(ctx, target, selection, token)) {
        if (token?.isCancellationRequested) {
          break;
        }
        if (output.kind === 'artifact') {
          artifacts.push(output.artifact);
          outDirs.add(output.outDir);
        } else {
          errors.push(output.error);
        }
      }
    } catch (cause) {
      errors.push({ book: target.rootUri, ...toBuildMessage(cause) });
    }
    progress?.report(Math.round(((index + 1) / roots.length) * 100));
  }

  progress?.done();

  // Spread: a Set doesn't survive JSON-RPC serialization; the wire carries a plain array.
  return { ok: errors.length === 0, outDirs: [...outDirs], artifacts, errors };
}

/**
 * Handles `jpnov/listBooks`: enumerates every `*.jpbook` under each targeted root as a
 * {@link BookEntry} for the client's Books panel. Each file is read ONCE, through the client
 * like a build, for its front-matter `title` (display metadata; an unreadable file simply lists
 * untitled) — but no diagnostics and no output-path collision check (those belong to an actual build).
 */
export async function handleListBooks(ctx: ServerContext, params: ListBooksParams): Promise<ListBooksResult> {
  const perRoot = await Promise.all(targetRoots(params.projectDirs).map(async (target) => {
    const jpbooks = await discoverJpbooks(target.rootUri, target.outDirUri);
    return Promise.all(jpbooks.map(async (fl): Promise<BookEntry> => {
      const reply = await ctx.readText(fl.uri);
      const title = reply.ok ? parseJpbook(reply.text).meta.title : undefined;
      return {
        uri: fl.uri,
        rootUri: target.rootUri,
        fileRel: fl.fileRel,
        outRel: jpbookOutRel(fl.fileRel),
        ...(title !== undefined && title !== '' ? { title } : {}),
      };
    }));
  }));
  return { books: perRoot.flat() };
}
