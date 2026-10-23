/**
 * The "Books" panel: a client-owned WebviewView (`contributes.views.jpnov`, `"type": "webview"`)
 * listing every buildable book — those under the workspace folders, plus the `.jpbook` files open
 * outside them — with a checkbox, plus a per-book DETAIL screen; the bottom bar
 * builds ONLY the checked books. This provider is the single source of truth for the book list
 * and the selection — the webview only renders the last pushed `state` and dispatches actions.
 * The SERVER enumerates and renders (`jpnov/listBooks`, `jpnov/build`); the provider owns every
 * artifact write (the server never touches `vscode.fs`; `readText.ts` answers its reads) and the
 * Print action's browser hand-off.
 * Form editing lives in `manage.ts`, reached by dispatching `jpbook.*` commands with a
 * synthesized node. extension.ts registers the view and hands it here once the server is started.
 */
import * as vscode from 'vscode';

import type { LanguageClient } from 'vscode-languageclient/node';

import {
  BookCountsRequest,
  BuildRequest,
  FixAllRequest,
  ListBooksRequest,
  ProblemsRequest,
  type BookCountsParams,
  type BookCountsResult,
  type BookEntry,
  type BuildError,
  type BuildFormat,
  type BuildParams,
  type BuildResult,
  type FixAllParams,
  type FixAllResult,
  type ListBooksParams,
  type ListBooksResult,
  type ProblemRef,
  type ProblemsParams,
  type ProblemsResult,
} from '#/shared/protocol.ts';

import { entryKeyOf, entryLines, metaRows, type EntryRef } from '#/shared/book/edits.ts';
import { parseJpbook, type EntryList, isEntryList, isNameList, jpbookStem, META_KEYS, type MetaKey, type ParsedLine } from '#/shared/book/jpbook.ts';
import { encodeTxt, TXT_ENCODING_DEFAULT, TXT_ENCODINGS } from '#/shared/encoding.ts';
import { errorText } from '#/shared/utils/errors.ts';
import { isRecord } from '#/shared/utils/guards.ts';
import { compareRanges, type Position, type Range } from '#/shared/utils/position.ts';
import { ocfZip } from '#/shared/compiler/ocf.ts';

import type {
  BookVM,
  BuildAction,
  ChapterProblemsVM,
  CountsVM,
  DetailMessage,
  EntryVM,
  MetaVM,
  ProblemRefVM,
  ProblemsMessage,
  ProblemVM,
  StateMessage,
} from '../protocol.ts';

import { formatCounts } from './counts.ts';

import { BROWSER_NAMES, isBrowser, openInBrowser, PRINT_BROWSER_DEFAULT, PRINT_BROWSER_SETTINGS, printCandidates } from './browser.ts';
import { addEntries, applyBookEdits, editEntry, editMeta, metaLabel, metaValueParts, moveEntry, removeEntryRow, type EntryNode } from './manage.ts';
import { booksHtml } from './webviewHtml.ts';
import { guarded } from '../commands.ts';
import { renderMessage } from '../messages.ts';
import { toVsRange } from '../ranges.ts';
import { bookDir, compareStr, lastPathSegment, resolveUri, splitRelPath } from '../paths.ts';
import { bookTargets, isOpenBook } from '../projectConfig.ts';
import { readText } from './readText.ts';
import { affectsRenderSettings, buildHtmlSettings } from '../renderConfig.ts';
import { cappedRequest, raceRequest } from '../requests.ts';

/** Trailing-edge delay for file-event bursts, the detail's re-post and the list's re-list alike (matches the preview's render debounce). */
const REPOST_DEBOUNCE_MS = 120;

/** Trailing-edge delay after a keystroke in a chapter of the open detail: its figures follow the typing, one layout per pause. */
const COUNTS_DEBOUNCE_MS = 500;

/** Hard cap on the count round-trip: one book laid out twice, so a reply this late means a stuck server. */
const COUNTS_REQUEST_TIMEOUT_MS = 30_000;

/** Hard cap on the build round-trip: a whole-root scan is bounded work, so a reply this late
 *  means a stuck server. */
const BUILD_REQUEST_TIMEOUT_MS = 120_000;

/** Hard cap on the enumeration round-trip: a directory walk, so a reply this late means a stuck server. */
const LIST_REQUEST_TIMEOUT_MS = 30_000;

/** The form of a file URI the OS gets: `#`, `?` and `%` kept percent-encoded as written. */
function osUrl(uri: string): string {
  return vscode.Uri.parse(uri).toString();
}

/**
 * Opens a file URI in the OS. VS Code rebuilds a `Uri` target as `encodeURI(uri.toString(true))`,
 * which lets `#` and `?` through as fragment and query; a string target equal to its own
 * `Uri.toString()` is used as written, so the encoded form goes in despite the `Uri`-only type.
 */
function openExternally(uri: string): void {
  // openExternal resolves to false on failure rather than rejecting, so void is safe.
  void vscode.env.openExternal(osUrl(uri) as unknown as vscode.Uri);
}

/** The book's display label: its `title`, else (the key missing or empty) its file name without `.jpbook`. */
function bookTitle(entry: BookEntry): string {
  return entry.title ?? jpbookStem(splitRelPath(entry.fileRel).name);
}

/** The heading of a list section: the workspace folder's name, or the open files under none. */
function groupLabel(rootUri: string | null): string {
  return rootUri === null ? vscode.l10n.t('Open files') : lastPathSegment(rootUri);
}

/** A row as a webview verb names it: the rendered line + path, and the detail's document version. */
type RowRef = EntryRef & { readonly version: number };

/** A chapter of the open detail: its file, the path its entry row names, and whether the file is missing. */
interface ChapterRow {
  readonly uri: string;
  readonly path: string;
  readonly missing: boolean;
}

/** A position a webview verb names, or null unless both coordinates are counts (what `vscode.Range` accepts). */
function cursorOf(value: unknown): Position | null {
  const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
  return isRecord(value) && count(value.line) && count(value.character)
    ? { line: value.line, character: value.character }
    : null;
}

/** The span a webview verb names, or null unless both ends are positions. */
function textRangeOf(value: unknown): Range | null {
  if (!isRecord(value)) {
    return null;
  }
  const start = cursorOf(value.start);
  const end = cursorOf(value.end);
  return start === null || end === null ? null : { start, end };
}

/** A problem as the fix verb names it, or null unless its chapter, place and code are all present. */
function problemRefOf(value: unknown): ProblemRefVM | null {
  if (!isRecord(value) || typeof value.chapter !== 'string' || typeof value.code !== 'string') {
    return null;
  }
  const range = textRangeOf(value.range);
  return range === null ? null : { chapter: value.chapter, range, code: value.code };
}

/** The row a webview entry verb names, or null unless `line`, `path` and `version` are all present. */
function rowRefOf(msg: Readonly<Record<string, unknown>>): RowRef | null {
  const { line, path, version } = msg;
  return typeof line === 'number' && typeof path === 'string' && typeof version === 'number'
    ? { line, path, version }
    : null;
}

export class BooksViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  /** The view id (matches `contributes.views.jpnov[].id` in package.json). */
  static readonly viewId = 'jpnov.books';

  private readonly client: LanguageClient;
  /** The extension root, for `asWebviewUri`-serving the codicon stylesheet + font. */
  private readonly extensionUri: vscode.Uri;
  /** Open each build's output folder in the OS file manager; mirrored into every `state` push.
   *  Session-scoped like the checkbox selection — a new window starts back at on. */
  private revealOutput = true;
  private readonly disposables: vscode.Disposable[] = [];
  /** The live view, once resolved (visible at least once). Undefined while never-shown / disposed. */
  private view: vscode.WebviewView | undefined;
  /** Per-resolve message subscription, replaced on re-resolve and disposed with the provider. */
  private messageSub: vscode.Disposable | undefined;

  /** Latest enumerated books (from `jpnov/listBooks`), sorted server-side per root. */
  private books: readonly BookEntry[] = [];
  /** The build selection: book URIs whose checkbox is ticked. */
  private readonly checked = new Set<string>();
  /** Serializes `refresh()` so a slow `listBooks` can't clobber a newer enumeration. */
  private refreshSeq = 0;
  /** False until the first successful enumeration, so the webview shows a loading state (not the
   *  misleading "no books yet" welcome) during the server-start window before books are known. */
  private hasLoaded = false;
  /** The book whose DETAIL screen is currently open, so edits/refreshes re-push it. */
  private openDetailUri: string | undefined;
  /** Trailing-edge timer coalescing chapter-file events into one detail re-post per burst. */
  private repostTimer: ReturnType<typeof setTimeout> | undefined;
  /** Trailing-edge timer coalescing `.jpbook` events into one re-list per burst. */
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Re-lists once `REPOST_DEBOUNCE_MS` pass without another event. Fire-and-forget: refresh()
   * self-catches its sendRequest and is refreshSeq-serialized, so a dropped result is safe.
   */
  private readonly scheduleRefresh = (): void => {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), REPOST_DEBOUNCE_MS);
  };

  /** The chapters of the last posted detail by file URI (each file once, in the book's order), under
   *  the book they belong to: the documents whose edits re-count it, and the files the problems screen works on. */
  private detailChapters: { readonly book: string; readonly rows: ReadonlyMap<string, ChapterRow> } = { book: '', rows: new Map() };
  /** The contributed view title captured at resolve, restored when the detail closes. */
  private defaultTitle: string | undefined;
  /** Serializes the row verbs (remove / move / drop), see `runEntryVerb`. */
  private entryChain: Promise<void> = Promise.resolve();
  /** How many times the watcher saw each chapter file change: part of its stamp, so a rewrite that keeps the size and the mtime still reads anew. */
  private readonly diskChanges = new Map<string, number>();

  constructor(client: LanguageClient, extensionUri: vscode.Uri) {
    this.client = client;
    this.extensionUri = extensionUri;

    // A `.jpbook` appearing/disappearing changes the book SET, and a SAVE can change its
    // title (a book label), chapters (the open detail, and which pages the server's vocabulary
    // colours) or names (the vocabulary itself), so create/delete/change all re-list, one list
    // per burst (a branch switch fires one event per book). The watcher only fires onDidChange
    // for on-disk writes — not per keystroke.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.jpbook');
    /** A book outside every folder opened, closed or saved: the list changes, the glob watcher below never sees it. */
    const outsideBook = (d: vscode.TextDocument): void => {
      if (isOpenBook(d)) {
        this.scheduleRefresh();
      }
    };
    // Chapter existence backs the detail's missing flags, and chapter text its figures, so a
    // `.jpnov` appearing, disappearing or changing on disk re-posts the open detail.
    const chapterWatcher = vscode.workspace.createFileSystemWatcher('**/*.jpnov');
    const repostDetail = (): void => {
      this.schedule(REPOST_DEBOUNCE_MS);
    };
    /** A chapter of the open detail that no editor holds: only the disk can change it. */
    const closedChapter = (uri: vscode.Uri): boolean =>
      this.detailChapters.rows.has(uri.toString()) && !vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString());

    this.disposables.push(
      watcher,
      watcher.onDidCreate(this.scheduleRefresh),
      watcher.onDidDelete(this.scheduleRefresh),
      watcher.onDidChange(this.scheduleRefresh),
      chapterWatcher,
      chapterWatcher.onDidCreate(repostDetail),
      chapterWatcher.onDidDelete(repostDetail),
      // An open chapter's save changes nothing the buffer path has not counted already.
      chapterWatcher.onDidChange((uri) => {
        this.diskChanges.set(uri.toString(), (this.diskChanges.get(uri.toString()) ?? 0) + 1);
        if (closedChapter(uri)) {
          repostDetail();
        }
      }),
      // Deleting/creating a FOLDER emits one watcher event for the folder path — no `.jpnov`
      // match — so Explorer-driven folder operations re-stat through the workspace events.
      vscode.workspace.onDidCreateFiles(repostDetail),
      vscode.workspace.onDidDeleteFiles(repostDetail),
      // The detail renders the live buffer, so it follows the buffer: an edit whose save failed
      // (or a hand edit, an undo) fires no watcher event. The figures follow the chapters' buffers
      // the same way (the server reads them through the editor), a pause after typing at a time.
      vscode.workspace.onDidChangeTextDocument((e) => {
        const uri = e.document.uri.toString();
        if (uri === this.openDetailUri) {
          repostDetail();
        } else if (this.detailChapters.rows.has(uri)) {
          this.schedule(COUNTS_DEBOUNCE_MS);
        }
      }),
      // The figures are laid out on the render settings, so a change to them re-counts.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (affectsRenderSettings(e)) {
          repostDetail();
        }
      }),
      vscode.workspace.onDidOpenTextDocument(outsideBook),
      vscode.workspace.onDidCloseTextDocument(outsideBook),
      vscode.workspace.onDidSaveTextDocument(outsideBook),
    );
  }

  /**
   * Re-posts the open detail once `delay` ms pass without another call. Debounced: a bulk
   * operation (branch switch, folder paste) fires one event per file, and each re-post stats
   * every listed chapter and lays the book out — one run per burst.
   */
  private schedule(delay: number): void {
    if (this.openDetailUri === undefined) {
      return;
    }
    clearTimeout(this.repostTimer);
    this.repostTimer = setTimeout(() => {
      if (this.openDetailUri !== undefined) {
        void this.postDetail(this.openDetailUri);
      }
    }, delay);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // Scripts are locked to a per-render nonce (CSP); the only loadable resource is the codicon
    // stylesheet + font under the extension's media/codicon.
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media', 'codicon')],
    };
    view.webview.html = booksHtml(view.webview, this.extensionUri);

    this.messageSub?.dispose();
    this.messageSub = view.webview.onDidReceiveMessage((m: unknown) => {
      void this.onMessage(m);
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    this.defaultTitle = view.title;
    this.applyDetailChrome();
    // The webview posts `ready` once its script loads; we answer with the current state there,
    // so no eager post is needed here (and none would land before the document loads anyway).
  }

  /**
   * Mirrors the open detail into the view chrome: the title bar shows the book title (the
   * list restores the contributed name), and the `jpnov.booksDetail` context key hides the
   * view/title create-book `+` — the detail screen has its own `+` for chapters.
   */
  private applyDetailChrome(): void {
    void vscode.commands.executeCommand('setContext', 'jpnov.booksDetail', this.openDetailUri !== undefined);
    const view = this.view;
    if (view === undefined) {
      return;
    }
    const entry = this.openDetailUri === undefined ? undefined : this.entryOf(this.openDetailUri);
    // The d.ts marks `title` exact-optional, but the runtime setter accepts undefined
    // (restores the contributed name) — widen the target instead of writing ''.
    (view as { title?: string | undefined }).title = entry === undefined ? this.defaultTitle : bookTitle(entry);
  }

  /** Webview `selectAll`: tick every book. */
  private selectAll(): void {
    for (const b of this.books) {
      this.checked.add(b.uri);
    }
    this.postState();
  }

  /** Webview `deselectAll`: clear every tick. */
  private deselectAll(): void {
    this.checked.clear();
    this.postState();
  }

  /**
   * `jpbook.refresh` (and the file watcher / folder changes): re-enumerate books and reconcile
   * the checkbox set — drop ticks for books that vanished, default any newly-discovered book to
   * CHECKED — then re-push the list (and the open detail, if any). Leaves the current list in
   * place if the request fails or times out (e.g. server not yet started); `report` (the user's
   * own refresh) says so in a toast that offers the window reload, the one way back from a
   * server that will not start.
   */
  async refresh(report = false): Promise<void> {
    // A direct refresh lists everything a scheduled one would: the pending one is dropped.
    clearTimeout(this.refreshTimer);
    const seq = ++this.refreshSeq;
    const params: ListBooksParams = bookTargets();
    let result: ListBooksResult;
    try {
      result = await cappedRequest(
        (token) => this.client.sendRequest<ListBooksResult>(ListBooksRequest, params, token),
        LIST_REQUEST_TIMEOUT_MS,
      );
    } catch (err) {
      if (report) {
        const reload = vscode.l10n.t('Reload Window');
        const message = vscode.l10n.t("Japanese Novel: couldn't load the books. {0}", errorText(err));
        void vscode.window.showErrorMessage(message, reload).then((pick) => {
          if (pick === reload) {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
      }
      return;
    }
    if (seq !== this.refreshSeq) {
      return; // a newer refresh already superseded this one
    }

    const next = new Set(result.books.map((b) => b.uri));
    for (const uri of [...this.checked]) {
      if (!next.has(uri)) {
        this.checked.delete(uri);
      }
    }
    this.books = result.books;
    this.hasLoaded = true;

    // A vanished open book returns the webview to the list; otherwise re-push its (possibly edited) detail.
    if (this.openDetailUri !== undefined && !next.has(this.openDetailUri)) {
      this.closeOpenDetail();
    }
    this.applyDetailChrome(); // also refreshes the title after a title edit
    this.postState();
    // Scheduled, not direct: the re-list after a row verb's save lands beside the verb's own re-push.
    this.schedule(REPOST_DEBOUNCE_MS);
  }

  /** Shows the view and focuses it; the built-in `<viewId>.focus` command exists once the view is contributed. */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${BooksViewProvider.viewId}.focus`).then(undefined, () => undefined);
  }

  /**
   * Post-create hand-off from `jpbook.createFile`: focus the view and open the new book's
   * detail. The detail key is the file's `Uri` string, which the server's enumeration composes
   * the same way (`childUri`); a normalization-insensitive re-find is the fallback for volumes
   * that store names as NFD.
   */
  async revealNewBook(file: vscode.Uri): Promise<void> {
    // Focusing resolves a never-shown webview; the ready handshake then re-pulls state +
    // detail, so this must precede the refresh.
    await this.focus();
    // Set BEFORE refreshing: whichever refresh lands first (this one, the watcher's
    // onDidCreate, or the post-start fill) re-pushes the open detail once enumerated.
    this.openDetailUri = file.toString();
    await this.refresh();
    if (this.entryOf(this.openDetailUri) === undefined) {
      const path = file.path.normalize('NFC');
      const entry = this.books.find((b) => vscode.Uri.parse(b.uri).path.normalize('NFC') === path);
      if (entry === undefined) {
        return;
      }
      this.openDetailUri = entry.uri;
      this.applyDetailChrome();
    }
    // reveal: the webview sits on the list screen and would drop a plain re-push.
    await this.postDetail(this.openDetailUri, true);
  }

  /**
   * Failed-build hand-off: focus the view, then open one listed book's detail with `reveal`;
   * no refresh runs here, so the chrome is applied explicitly.
   */
  private async revealDetail(uri: string): Promise<void> {
    await this.focus();
    this.openDetailUri = uri;
    this.applyDetailChrome();
    await this.postDetail(uri, true);
  }

  dispose(): void {
    clearTimeout(this.repostTimer);
    clearTimeout(this.refreshTimer);
    this.messageSub?.dispose();
    this.messageSub = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }

  /** Book entry for a URI from the current enumeration, or undefined if it vanished. */
  private entryOf(uri: unknown): BookEntry | undefined {
    return typeof uri === 'string' ? this.books.find((b) => b.uri === uri) : undefined;
  }

  private async onMessage(m: unknown): Promise<void> {
    if (!isRecord(m) || typeof m.type !== 'string') {
      return;
    }
    switch (m.type) {
      case 'ready':
        this.postState();
        if (this.openDetailUri !== undefined) {
          // reveal: a fresh script starts on the list screen and would drop a plain push.
          await this.postDetail(this.openDetailUri, true);
        }
        break;
      case 'toggle':
        // Optimistic on the webview; here we only record the authoritative selection (no echo,
        // so a per-row toggle never re-renders and drops keyboard focus). A later full `state`
        // push — refresh / select-all — reconciles the checkboxes.
        if (typeof m.uri === 'string') {
          if (m.checked === true) {
            this.checked.add(m.uri);
          } else {
            this.checked.delete(m.uri);
          }
        }
        break;
      case 'selectAll':
        this.selectAll();
        break;
      case 'deselectAll':
        this.deselectAll();
        break;
      case 'revealOutput':
        // Optimistic on the webview (like `toggle`): record without echoing.
        this.revealOutput = m.on === true;
        break;
      case 'build':
        if (m.format === 'print' || m.format === 'txt' || m.format === 'epub') {
          if (typeof m.uri === 'string') {
            if (this.entryOf(m.uri) !== undefined) {
              await this.buildSelected(m.format, [m.uri]);
            }
          } else {
            await this.buildSelected(m.format);
          }
        }
        break;
      case 'openDetail':
        if (typeof m.uri === 'string') {
          if (this.entryOf(m.uri) === undefined) {
            this.failDetail(m.uri); // the row outlived its book
            break;
          }
          this.openDetailUri = m.uri;
          this.applyDetailChrome();
          await this.postDetail(m.uri);
        }
        break;
      case 'closeDetail':
        this.openDetailUri = undefined;
        this.applyDetailChrome();
        break;
      case 'openFile':
        if (typeof m.uri === 'string') {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(m.uri));
        }
        break;
      case 'editMeta':
        await this.dispatchEditMeta(m.uri, m.metaKey);
        break;
      case 'addEntries':
        await this.dispatchList(m.uri, m.list);
        break;
      case 'editEntry':
        await this.runEntryVerb(m.uri, () => this.dispatchEntry(editEntry, m.uri, m.list, rowRefOf(m)));
        break;
      case 'removeEntry':
        await this.runEntryVerb(m.uri, () => this.dispatchEntry(removeEntryRow, m.uri, m.list, rowRefOf(m)));
        break;
      case 'moveEntryTo':
        await this.runEntryVerb(m.uri, () => this.dispatchMoveTo(m.uri, m.list, rowRefOf(m), m.before, m.beforePath));
        break;
      case 'welcome':
        this.dispatchWelcome(m.action);
        break;
      case 'fixProblems':
        await this.fixProblems(m.uri, m.problems);
        break;
      case 'openProblem': {
        const range = textRangeOf(m.range);
        if (typeof m.uri === 'string' && this.detailChapters.rows.has(m.uri) && range !== null) {
          await vscode.window.showTextDocument(vscode.Uri.parse(m.uri), {
            selection: toVsRange(range),
          });
        }
        break;
      }
    }
  }

  /** Re-parse the book for the CURRENT value (authoritative), then open the native meta editor. */
  private async dispatchEditMeta(uri: unknown, metaKey: unknown): Promise<void> {
    const entry = this.entryOf(uri);
    if (entry === undefined || typeof metaKey !== 'string' || !(META_KEYS as readonly string[]).includes(metaKey)) {
      return;
    }
    let value: string | undefined;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
      value = parseJpbook(doc.getText()).meta[metaKey as MetaKey];
    } catch {
      return;
    }
    await guarded(() => editMeta({ entry, metaKey: metaKey as MetaKey, value }));
  }

  /** Runs the add verb on the named list. */
  private async dispatchList(uri: unknown, list: unknown): Promise<void> {
    const entry = this.entryOf(uri);
    if (entry === undefined || !isEntryList(list)) {
      return;
    }
    await guarded(() => addEntries({ list, entry }));
  }

  /**
   * Runs a row verb (remove / move / drop) after the ones before it, then re-pushes the open detail
   * whether or not anything changed: each verb plans against the text the previous one left, and
   * the panel re-syncs at once instead of after the save → watcher → listBooks round trip. A
   * failed verb never wedges the chain.
   */
  private runEntryVerb(uri: unknown, verb: () => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      await verb(); // never rejects: every verb runs under guarded()
      if (typeof uri === 'string' && uri === this.openDetailUri) {
        await this.postDetail(uri);
      }
    };
    this.entryChain = this.entryChain.then(run, run);
    return this.entryChain;
  }

  /** Forgets the open detail and returns the webview to the list; the caller re-applies the chrome. */
  private closeOpenDetail(): void {
    this.openDetailUri = undefined;
    void this.view?.webview.postMessage({ type: 'closeDetail' });
  }

  /**
   * A book that cannot be read (deleted under the panel): back to the list with a toast, and a
   * re-list so the dead row goes now.
   */
  private failDetail(uri: string): void {
    this.closeOpenDetail();
    this.applyDetailChrome();
    void vscode.window.showErrorMessage(vscode.l10n.t("Japanese Novel: couldn't open {0}.", lastPathSegment(uri)));
    void this.refresh();
  }

  /** The row an entry verb names, or null unless the book, the list and the row are all named. */
  private entryNodeOf(uri: unknown, list: unknown, ref: RowRef | null): EntryNode | null {
    const entry = this.entryOf(uri);
    return entry === undefined || !isEntryList(list) || ref === null ? null : { list, entry, ...ref };
  }

  /** Runs an entry verb (edit / remove) on the named row — `manage.ts` checks the row against the live text. */
  private async dispatchEntry(verb: (node: EntryNode) => Promise<void>, uri: unknown, list: unknown, ref: RowRef | null): Promise<void> {
    const node = this.entryNodeOf(uri, list, ref);
    if (node !== null) {
      await guarded(() => verb(node));
    }
  }

  /** Moves the row `ref` before the row `before`/`beforePath` (both null = the end of its list): the up/down buttons and a drop. */
  private async dispatchMoveTo(uri: unknown, list: unknown, ref: RowRef | null, before: unknown, beforePath: unknown): Promise<void> {
    const node = this.entryNodeOf(uri, list, ref);
    if (node === null) {
      return;
    }
    let target: EntryRef | null;
    if (before === null && beforePath === null) {
      target = null;
    } else if (typeof before === 'number' && typeof beforePath === 'string') {
      target = { line: before, path: beforePath };
    } else {
      return;
    }
    await guarded(() => moveEntry(node, target));
  }

  /** Runs an empty-state welcome-link action (create book / open guide). */
  private dispatchWelcome(action: unknown): void {
    if (action === 'createBook') {
      void vscode.commands.executeCommand('jpbook.createFile');
    } else if (action === 'openGuide') {
      void vscode.commands.executeCommand('jpnov.openGuide');
    }
  }

  /** Push the book list (one section per root, the open files under none last; a single section shown flat) + selection to the webview. */
  private postState(): void {
    const view = this.view;
    if (view === undefined) {
      return;
    }
    const byRoot = Map.groupBy(this.books, (b) => b.rootUri);
    const multi = byRoot.size > 1;
    const groups = [...byRoot.entries()]
      .sort((a, b) => Number(a[0] === null) - Number(b[0] === null) || compareStr(groupLabel(a[0]), groupLabel(b[0])))
      .map(([rootUri, entries]) => ({
        label: multi ? groupLabel(rootUri) : null,
        books: entries
          .sort((a, b) => compareStr(a.fileRel, b.fileRel))
          .map((entry): BookVM => ({
            uri: entry.uri,
            title: bookTitle(entry),
            fileRel: entry.fileRel,
            checked: this.checked.has(entry.uri),
          })),
      }));
    const message: StateMessage = {
      type: 'state',
      loading: !this.hasLoaded,
      noFolder: (vscode.workspace.workspaceFolders ?? []).length === 0,
      revealOutput: this.revealOutput,
      groups,
    };
    void view.webview.postMessage(message);
  }

  /**
   * Parse one book and push its lists (covers and chapters with missing-file flags, characters
   * and keywords) + metadata rows to the webview. `reveal` marks a host-initiated open — without
   * it the webview drops the push unless its detail screen is already the user's intent.
   */
  private async postDetail(uri: string, reveal = false): Promise<void> {
    const view = this.view;
    const entry = this.entryOf(uri);
    if (view === undefined || entry === undefined) {
      return;
    }
    // A direct post counts everything a scheduled one would: the pending one is dropped.
    clearTimeout(this.repostTimer);
    let text: string;
    let version: number;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      text = doc.getText();
      version = doc.version;
    } catch {
      if (this.openDetailUri === uri) {
        this.failDetail(uri);
      }
      return;
    }
    if (this.openDetailUri !== uri) {
      return; // the user navigated away while the document loaded
    }
    const parsed = parseJpbook(text);
    // The count waits for the chapters' stat alone: it sends the server their stamps.
    const stamps = new Map<string, string>();
    const chapterRows = this.entryVMs(entry, parsed.lines, 'chapters', stamps);
    const [chapters, covers, characters, keywords, counts] = await Promise.all([
      chapterRows,
      this.entryVMs(entry, parsed.lines, 'covers'),
      this.entryVMs(entry, parsed.lines, 'characters'),
      this.entryVMs(entry, parsed.lines, 'keywords'),
      chapterRows.then(() => this.countsOf(uri, stamps)),
    ]);
    const meta: MetaVM[] = metaRows(parsed.meta).map((row) => {
      const parts = metaValueParts(row.key, row.value);
      return { key: row.key, label: metaLabel(row.key), value: parts.value, note: parts.note };
    });
    if (this.openDetailUri !== uri) {
      return; // navigated away during the async stats
    }
    const rows = new Map<string, ChapterRow>();
    for (const c of chapters) {
      if (c.fileUri !== null && !rows.has(c.fileUri)) {
        rows.set(c.fileUri, { uri: c.fileUri, path: c.path, missing: c.missing });
      }
    }
    this.detailChapters = { book: uri, rows };
    // The walkthrough's chapter and highlight steps (`onContext:` in package.json) complete here:
    // the detail is reposted on every edit of the open book, 「章を追加…」 included, and a book
    // written by hand or in an earlier session counts the same.
    if (chapters.length > 0) {
      void vscode.commands.executeCommand('setContext', 'jpnov.hasChapters', true);
    }
    if (characters.length + keywords.length > 0) {
      void vscode.commands.executeCommand('setContext', 'jpnov.hasNames', true);
    }
    const message: DetailMessage = {
      type: 'detail',
      uri,
      title: bookTitle(entry),
      version,
      chapters,
      covers,
      characters,
      keywords,
      meta,
      counts,
      ...(reveal ? { reveal } : {}),
    };
    void view.webview.postMessage(message);
  }

  /**
   * The book's body figures from the server, laid out on the build's settings snapshot and
   * worded here for the detail's status bar (the webview prints what it gets); `stamps` are the
   * chapters' files as just stat'ed, what lets the server keep a closed chapter's text. Null when
   * a chapter could not be read, the server did not answer in time, or it is not running: the
   * detail then shows no figures.
   */
  private async countsOf(uri: string, stamps: ReadonlyMap<string, string>): Promise<CountsVM | null> {
    const params: BookCountsParams = {
      uri,
      settings: buildHtmlSettings(),
      stamps: [...stamps].map(([fileUri, stamp]) => ({ uri: fileUri, stamp })),
    };
    let result: BookCountsResult;
    try {
      result = await cappedRequest(
        (token) => this.client.sendRequest<BookCountsResult>(BookCountsRequest, params, token),
        COUNTS_REQUEST_TIMEOUT_MS,
      );
    } catch {
      return null;
    }
    const { counts } = result;
    if (counts === null) {
      return null;
    }
    return formatCounts(counts, (key, ...args) => vscode.l10n.t(key, ...args), (value) => value.toLocaleString(vscode.env.language));
  }

  /** One list's rows: the listed path (the row's identity, split into name/folder for display), file
   *  URI, fs.stat-backed missing flag; a name row is its text alone, nothing to stat. `stamps`, when
   *  given, receives each present file's stamp (`${mtime}/${size}/${changes seen}`) by URI, for `jpnov/bookCounts`. */
  private async entryVMs(entry: BookEntry, lines: readonly ParsedLine[], list: EntryList, stamps?: Map<string, string>): Promise<EntryVM[]> {
    return Promise.all(
      entryLines(lines, list).map(async (line): Promise<EntryVM> => {
        const pl = lines[line];
        const path = pl === undefined ? '' : entryKeyOf(pl);
        if (isNameList(list)) {
          return { line, path, name: path, folder: '', fileUri: null, missing: false };
        }
        const { name, dir } = splitRelPath(path);
        const target = resolveUri(bookDir(entry.uri), path);
        let missing = false;
        try {
          const st = await vscode.workspace.fs.stat(target);
          missing = (st.type & vscode.FileType.File) === 0;
          if (!missing) {
            const key = target.toString();
            stamps?.set(key, `${String(st.mtime)}/${String(st.size)}/${String(this.diskChanges.get(key) ?? 0)}`);
          }
        } catch {
          missing = true;
        }
        return { line, path, name, folder: dir, fileUri: target.toString(), missing };
      }),
    );
  }

  /** The present chapters of the open detail (a missing one is skipped: the panel marks it), once its
   *  rows are posted; undefined before that or without an open detail. */
  private openChapters(): readonly ChapterRow[] | undefined {
    const { book, rows } = this.detailChapters;
    return book === this.openDetailUri ? [...rows.values()].filter((c) => !c.missing) : undefined;
  }

  /**
   * `jpbook.fixProblems` (the detail screen's title bar): list every chapter's problems in the
   * webview's PROBLEMS screen, each chapter on the text the editor shows (read as the server
   * reads it, so a closed chapter stays closed); the user picks what to fix there
   * (`fixProblems`). The chapters that could not be checked are skipped under one toast; a book
   * without a problem is toasted and shows no screen.
   */
  async showProblems(): Promise<void> {
    const uri = this.openDetailUri;
    const chapters = this.openChapters();
    if (uri === undefined || chapters === undefined) {
      return;
    }
    const settled = chapters.length === 0
      ? []
      : await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Japanese Novel: checking {0} chapter(s)…', String(chapters.length)),
          },
          () => Promise.allSettled(chapters.map((ch) => this.problemsOf(ch))),
        );
    const view = this.view;
    if (this.openDetailUri !== uri || view === undefined) {
      return; // the user left the book while the chapters were checked
    }
    const failures = settled.flatMap((s) => (s.status === 'rejected' ? [errorText(s.reason)] : []));
    if (failures.length > 0) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Japanese Novel: couldn't check {0} chapter(s). {1}", String(failures.length), failures[0] ?? ''),
      );
    }
    const listed = settled.flatMap((s) => (s.status === 'fulfilled' && s.value.problems.length > 0 ? [s.value] : []));
    if (listed.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Japanese Novel: no problems in this book.'));
      return;
    }
    const message: ProblemsMessage = { type: 'problems', uri, chapters: listed };
    void view.webview.postMessage(message);
  }

  /**
   * One chapter's problems on the text the editor shows, in order of place and worded for the
   * webview; rejects when the chapter could not be read or the server failed.
   */
  private async problemsOf(ch: ChapterRow): Promise<ChapterProblemsVM> {
    const read = await readText({ uri: ch.uri });
    if (!read.ok) {
      throw new Error(read.why);
    }
    const result = await this.client.sendRequest<ProblemsResult>(ProblemsRequest, { uri: ch.uri, text: read.text } satisfies ProblemsParams);
    const problems = [...result.problems]
      .sort((a, b) => compareRanges(a.range, b.range))
      .map((p): ProblemVM => ({
        range: p.range,
        code: p.message.code,
        severity: p.severity,
        message: renderMessage(p.message),
        where: vscode.l10n.t('Line {0}', String(p.range.start.line + 1)),
        fixable: p.fixable,
      }));
    return { uri: ch.uri, path: ch.path, problems };
  }

  /**
   * Webview `fixProblems`: the problems the user checked, grouped by chapter and fixed chapter by
   * chapter, each on the text the editor holds (a problem the text no longer has is left alone).
   * A chapter the detail does not list is skipped; a malformed verb is ignored. A chapter that was
   * clean is saved after its edit; one that was already dirty keeps the fixes unsaved, as its own
   * edits are. A refused edit or a failed save is toasted and skipped; one toast at the end counts
   * the fixes and the chapters they landed in.
   */
  private async fixProblems(uri: unknown, problems: unknown): Promise<void> {
    const chapters = this.openChapters();
    if (uri !== this.openDetailUri || chapters === undefined || !Array.isArray(problems)) {
      return;
    }
    const refs = problems.map(problemRefOf);
    if (!refs.every((r): r is ProblemRefVM => r !== null)) {
      return;
    }
    const byChapter = Map.groupBy(refs, (r) => r.chapter);
    const targets = chapters.flatMap((ch) => {
      const only = byChapter.get(ch.uri);
      // The wire carries the problem alone: the chapter is the key it was grouped by.
      return only === undefined ? [] : [{ uri: ch.uri, only: only.map(({ range, code }): ProblemRef => ({ range, code })) }];
    });
    const { fixed, touched } = targets.length === 0
      ? { fixed: 0, touched: 0 }
      : await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Japanese Novel: fixing {0} chapter(s)…', String(targets.length)),
          },
          async () => {
            let fixed = 0;
            let touched = 0;
            for (const t of targets) {
              const n = await this.fixChapter(t.uri, t.only);
              if (n !== undefined) {
                fixed += n;
                touched += 1;
              }
            }
            return { fixed, touched };
          },
        );
    void vscode.window.showInformationMessage(
      fixed > 0
        ? vscode.l10n.t('Japanese Novel: fixed {0} problem(s) in {1} chapter(s).', String(fixed), String(touched))
        : vscode.l10n.t('Japanese Novel: none of the selected problems could be fixed; the text may have changed since they were listed.'),
    );
  }

  /** Fix-all over one chapter, limited to the problems `only` names: the number of fixes that landed, or undefined when none did (nothing to fix, or a failure, toasted). */
  private async fixChapter(uri: string, only: readonly ProblemRef[]): Promise<number | undefined> {
    let doc: vscode.TextDocument;
    let result: FixAllResult;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      result = await this.client.sendRequest<FixAllResult>(FixAllRequest, { uri, text: doc.getText(), only } satisfies FixAllParams);
    } catch (err) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Japanese Novel: couldn't edit {0}. {1}", lastPathSegment(uri), errorText(err)),
      );
      return undefined;
    }
    if (result.edits.length === 0) {
      return undefined;
    }
    return (await applyBookEdits(doc.uri, result.edits, !doc.isDirty)) ? result.fixed : undefined;
  }

  /**
   * The localized "built {N} file(s)" success toast (Japanese is number-invariant). With the
   * footer's reveal toggle on, also opens the first output dir of `BuildResult.outDirs` (the
   * default puts every book of a folder in one; an outDir beside each book would open one
   * window per book).
   */
  private reportBuilt(count: number, label: string, outDirs: readonly string[]): void {
    // showInformationMessage never rejects, so void is safe.
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Japanese Novel: built {0} {1} file(s).', String(count), label),
    );
    const first = outDirs[0];
    if (this.revealOutput && first !== undefined) {
      // openExternal opens the folder's contents; revealFileInOS would only select it in its parent.
      openExternally(first);
    }
  }

  /**
   * The build driver behind the panel's build buttons (webview `build` messages): render
   * the CHECKED books (or exactly `only`, when given) to `action`'s one
   * format (`print` = `.html` on the wire, then opened in the browser the print setting names
   * — the HTML artifact's only build path; `epub` comes back as member files the client zips), write
   * the results (the client owns all filesystem writes), and report. An empty selection is
   * a no-op with a nudge rather than a silent "built 0". A failed book opens its detail
   * afterwards (the first one, when several fail).
   */
  async buildSelected(action: BuildAction, only?: readonly string[]): Promise<void> {
    const books = only ?? [...this.checked];
    // 'HTML' / 'EPUB' are proper nouns (not localized); 'text' translates. The label is
    // passed already-localized into the count templates below (Print builds HTML files, so
    // its progress/report honestly say HTML).
    const label = action === 'txt'
      ? vscode.l10n.t('text')
      : { print: 'HTML', epub: 'EPUB' }[action];
    if (books.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Japanese Novel: no books selected. Check a book in the Books view, then build.'),
      );
      return;
    }

    const c = this.client;
    // Print asks the server for HTML on the wire and opens the result; txt/epub pass through.
    const wireFormat: BuildFormat = action === 'print' ? 'html' : action;
    const failures = await vscode.window.withProgress<readonly BuildError[]>(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Japanese Novel: building {0} book(s) to {1}…', String(books.length), label),
        cancellable: true,
      },
      async (_progress, token) => {
        let result: BuildResult;
        try {
          const params: BuildParams = {
            books,
            format: wireFormat,
            settings: buildHtmlSettings(),
            ...bookTargets(),
          };
          // The token rides the wire too: $/cancelRequest lets the server stop early.
          result = await raceRequest(
            c.sendRequest<BuildResult>(BuildRequest, params, token),
            token,
            BUILD_REQUEST_TIMEOUT_MS,
          );
        } catch (err) {
          if (token.isCancellationRequested) {
            return []; // user cancelled: silence, not a failure toast
          }
          const message = errorText(err);
          // This granular popup means buildSelected returns normally (no rethrow) -> no
          // boundary double-popup from the command wrapper.
          void vscode.window.showErrorMessage(vscode.l10n.t('Japanese Novel: build failed. {0}', message));
          return [];
        }
        if (token.isCancellationRequested) {
          return []; // cancelled while the reply was landing: write nothing
        }

        // The CLIENT owns every filesystem write and encoding decision (reads: book/readText.ts); a setting value off the list is the default.
        const encodingSetting = vscode.workspace.getConfiguration().get<string>('jpnov.layout.txt.encoding');
        const txtEncoding = TXT_ENCODINGS.find((e) => e === encodingSetting) ?? TXT_ENCODING_DEFAULT;
        const written: string[] = [];
        let substitutions = 0;
        // One write shape for every artifact kind: success lands in `written`, failure
        // toasts and moves on (a bad uri never aborts the batch).
        const write = async (uri: string, bytes: Uint8Array): Promise<void> => {
          try {
            await vscode.workspace.fs.writeFile(vscode.Uri.parse(uri), bytes);
            written.push(uri);
          } catch (err) {
            const message = errorText(err);
            void vscode.window.showErrorMessage(
              vscode.l10n.t("Japanese Novel: couldn't write {0}. {1}", uri, message),
            );
          }
        };
        for (const artifact of result.artifacts) {
          let bytes: Uint8Array;
          switch (artifact.kind) {
            case 'txt': {
              const encoded = encodeTxt(artifact.content, txtEncoding);
              bytes = encoded.bytes;
              substitutions += encoded.substitutions;
              break;
            }
            case 'html':
              bytes = Buffer.from(artifact.content, 'utf8');
              break;
            case 'epub':
              bytes = ocfZip(artifact.members);
              break;
            default: {
              const exhaustive: never = artifact;
              throw new Error(`buildSelected: unhandled artifact ${JSON.stringify(exhaustive)}`);
            }
          }
          await write(artifact.path, bytes);
        }

        // The server sends a {code,args}; the client renders it to localized text.
        const errors = result.errors;
        for (const e of errors) {
          void vscode.window.showErrorMessage(
            vscode.l10n.t('Japanese Novel: build error for {0}. {1}', e.book, renderMessage(e)),
          );
        }

        if (written.length > 0) {
          // Print: open each written artifact in a browser — a webview cannot print (its
          // iframe sandbox has no allow-modals, so print() is a silent no-op). A chosen browser
          // that is not installed falls back to the OS default with one toast; a remote session
          // always uses the OS default (a process would run on the remote machine). The tab
          // presents the output, so print skips the folder reveal below.
          if (action === 'print') {
            const browserSetting = vscode.workspace.getConfiguration().get<string>('jpnov.layout.print.browser');
            const choice = PRINT_BROWSER_SETTINGS.find((b) => b === browserSetting) ?? PRINT_BROWSER_DEFAULT;
            const candidates = vscode.env.remoteName === undefined ? printCandidates(choice, process.platform) : [];
            const unopened = await openInBrowser(written.map(osUrl), candidates);
            for (const url of unopened) {
              openExternally(url);
            }
            if (unopened.length > 0 && candidates.length > 0) {
              void vscode.window.showInformationMessage(
                isBrowser(choice)
                  ? vscode.l10n.t("Japanese Novel: {0} wasn't found; opened in the default browser instead.", BROWSER_NAMES[choice])
                  : vscode.l10n.t('Japanese Novel: no Chrome, Edge or Firefox found; opened in the default browser. Safari ignores the paper size and orientation.'),
              );
            }
          }
          // One artifact per book now (a single format), so the file count IS the book count.
          this.reportBuilt(written.length, label, action === 'print' ? [] : result.outDirs);
          // Checks off the walkthrough's build step (`onContext:jpnov.hasBuilt` in package.json).
          void vscode.commands.executeCommand('setContext', 'jpnov.hasBuilt', true);
          if (substitutions > 0) {
            void vscode.window.showWarningMessage(
              vscode.l10n.t('Japanese Novel: {0} character(s) became 〓 in the text output.', String(substitutions)),
            );
          }
        } else if (errors.length === 0) {
          void vscode.window.showInformationMessage(
            vscode.l10n.t('Japanese Novel: nothing to build.'),
          );
        }
        return errors;
      },
    );

    // After the progress closes, the first failing book (server order = toast order) opens;
    // an error without a listed book (root-level fault, vanished book) stays toast-only.
    const failing = failures.find((e) => this.entryOf(e.uri) !== undefined)?.uri;
    if (failing !== undefined) {
      await this.revealDetail(failing);
    }
  }
}
