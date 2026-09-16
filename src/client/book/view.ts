/**
 * The "Books" panel: a client-owned WebviewView (`contributes.views.jpnov`, `"type": "webview"`)
 * listing every buildable book with a checkbox, plus a per-book DETAIL screen; the bottom bar
 * builds ONLY the checked books. This provider is the single source of truth for the book list
 * and the selection — the webview only renders the last pushed `state` and dispatches actions.
 * The SERVER enumerates and renders (`jpnov/listBooks`, `jpnov/build`); the provider owns every
 * artifact write (the server never touches `vscode.fs`) and the Print action's browser hand-off.
 * Form editing lives in `manage.ts`, reached by dispatching `jpbook.*` commands with a
 * synthesized node. Visibility is gated by the `jpnov.active` context key (extension.ts).
 */
import * as vscode from 'vscode';

import type { LanguageClient } from 'vscode-languageclient/node';

import {
  BuildRequest,
  ListBooksRequest,
  type BookEntry,
  type BuildError,
  type BuildFormat,
  type BuildParams,
  type BuildResult,
  type ListBooksParams,
  type ListBooksResult,
} from '#/shared/protocol.ts';

import { entryKeyOf, entryLines, metaRows, moveEntryTo, resolveEntry, type EntryRef } from '#/shared/book/edits.ts';
import {
  isEntryList,
  META_KEYS,
  parseJpbook,
  type EntryList,
  type MetaKey,
  type ParsedLine,
} from '#/shared/book/jpbook.ts';
import { encodeTxt, TXT_ENCODING_DEFAULT, type TxtEncoding } from '#/shared/encoding.ts';
import { errorText } from '#/shared/errors.ts';
import { ocfZip } from '#/shared/compiler/ocf.ts';

import type { BookVM, BuildAction, DetailMessage, EntryVM, MetaVM, StateMessage } from '../protocol.ts';

import { applyBookEdits, metaLabel, metaValueParts } from './manage.ts';
import type { BookNode } from './nodes.ts';
import { booksHtml } from './webviewHtml.ts';
import { renderMessage } from '../messages.ts';
import { chapterUri, lastPathSegment, splitRelPath } from '../paths.ts';
import { buildProjectDirs } from '../projectConfig.ts';
import { buildHtmlSettings } from '../renderConfig.ts';
import { raceRequest } from '../requests.ts';

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Trailing-edge delay for chapter-file event bursts (matches the preview's render debounce). */
const REPOST_DEBOUNCE_MS = 120;

/** Hard cap on the build round-trip: a whole-root scan is bounded work, so a reply this late
 *  means a stuck server. */
const BUILD_REQUEST_TIMEOUT_MS = 120_000;

/** The book's display label: its front-matter title, else the last segment of the output name. */
function bookTitle(entry: BookEntry): string {
  return entry.title ?? splitRelPath(entry.outRel).name;
}

/** A row as a webview verb names it: the rendered line + path, and the detail's document version. */
type RowRef = EntryRef & { readonly version: number };

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
  /** The contributed view title captured at resolve, restored when the detail closes. */
  private defaultTitle: string | undefined;
  /** Serializes the row verbs (remove / move / drop), see `runEntryVerb`. */
  private entryChain: Promise<void> = Promise.resolve();

  constructor(client: LanguageClient, extensionUri: vscode.Uri) {
    this.client = client;
    this.extensionUri = extensionUri;

    // A `.jpbook` appearing/disappearing changes the book SET, and a SAVE can change its
    // front-matter title (a book label) or chapters (the open detail), so create/delete/change
    // all re-list. The watcher only fires onDidChange for on-disk writes — not per keystroke.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.jpbook');
    // Chapter existence backs the detail's missing flags, so a `.jpnov` appearing/disappearing
    // re-stats the open detail. Content saves don't move the panel — change events stay ignored.
    const chapterWatcher = vscode.workspace.createFileSystemWatcher('**/*.jpnov', false, true, false);
    // Debounced: a bulk operation (branch switch, folder paste) fires one event per file,
    // and each re-post stats every listed chapter — one run per burst is enough.
    const repostDetail = (): void => {
      if (this.openDetailUri === undefined) {
        return;
      }
      clearTimeout(this.repostTimer);
      this.repostTimer = setTimeout(() => {
        if (this.openDetailUri !== undefined) {
          void this.postDetail(this.openDetailUri);
        }
      }, REPOST_DEBOUNCE_MS);
    };

    this.disposables.push(
      vscode.window.registerWebviewViewProvider(BooksViewProvider.viewId, this, {
        // Keep the DOM (scroll / detail nav) alive when the view is hidden; a ready->state
        // handshake re-hydrates if VS Code disposes it anyway.
        webviewOptions: { retainContextWhenHidden: true },
      }),
      watcher,
      // Fire-and-forget re-list: refresh() self-catches its sendRequest and is refreshSeq-serialized,
      // so a dropped result is safe.
      watcher.onDidCreate(() => void this.refresh()),
      watcher.onDidDelete(() => void this.refresh()),
      watcher.onDidChange(() => void this.refresh()),
      chapterWatcher,
      chapterWatcher.onDidCreate(repostDetail),
      chapterWatcher.onDidDelete(repostDetail),
      // Deleting/creating a FOLDER emits one watcher event for the folder path — no `.jpnov`
      // match — so Explorer-driven folder operations re-stat through the workspace events.
      vscode.workspace.onDidCreateFiles(repostDetail),
      vscode.workspace.onDidDeleteFiles(repostDetail),
    );
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
  selectAll(): void {
    for (const b of this.books) {
      this.checked.add(b.uri);
    }
    this.postState();
  }

  /** Webview `deselectAll`: clear every tick. */
  deselectAll(): void {
    this.checked.clear();
    this.postState();
  }

  /**
   * `jpbook.refresh` (and the file watcher / folder changes): re-enumerate books and reconcile
   * the checkbox set — drop ticks for books that vanished, default any newly-discovered book to
   * CHECKED — then re-push the list (and the open detail, if any). Leaves the current list in
   * place if the request fails (e.g. server not yet started).
   */
  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    const params: ListBooksParams = { projectDirs: buildProjectDirs() };
    let result: ListBooksResult;
    try {
      result = await this.client.sendRequest<ListBooksResult>(ListBooksRequest, params);
    } catch {
      return;
    }
    if (seq !== this.refreshSeq) {
      return; // a newer refresh already superseded this one
    }

    const prev = new Set(this.books.map((b) => b.uri));
    const next = new Set(result.books.map((b) => b.uri));
    for (const uri of [...this.checked]) {
      if (!next.has(uri)) {
        this.checked.delete(uri);
      }
    }
    for (const uri of next) {
      if (!prev.has(uri)) {
        this.checked.add(uri);
      }
    }
    this.books = result.books;
    this.hasLoaded = true;

    // A vanished open book returns the webview to the list; otherwise re-push its (possibly edited) detail.
    if (this.openDetailUri !== undefined && !next.has(this.openDetailUri)) {
      this.openDetailUri = undefined;
      void this.view?.webview.postMessage({ type: 'closeDetail' });
    }
    this.applyDetailChrome(); // also refreshes the title after a front-matter title edit
    this.postState();
    if (this.openDetailUri !== undefined) {
      void this.postDetail(this.openDetailUri);
    }
  }

  /**
   * Post-create hand-off from `jpbook.createFile`: focus the view and open the new book's
   * detail. The detail key is the file's `Uri` string, which the server's enumeration composes
   * the same way (`childUri`); a normalization-insensitive re-find is the fallback for volumes
   * that store names as NFD.
   */
  async revealNewBook(folder: vscode.Uri, fileName: string): Promise<void> {
    // `<viewId>.focus` resolves a never-shown webview; the ready handshake then re-pulls
    // state + detail, so this must precede the refresh.
    await vscode.commands.executeCommand(`${BooksViewProvider.viewId}.focus`).then(undefined, () => undefined);
    const folderUri = folder.toString();
    const rootUri = folderUri.endsWith('/') ? folderUri.slice(0, -1) : folderUri;
    // Set BEFORE refreshing: whichever refresh lands first (this one, the watcher's
    // onDidCreate, or the post-start fill) re-pushes the open detail once enumerated.
    this.openDetailUri = chapterUri(rootUri, fileName).toString();
    await this.refresh();
    if (this.entryOf(this.openDetailUri) === undefined) {
      const entry = this.books.find(
        (b) => b.rootUri === rootUri && b.fileRel.normalize('NFC') === fileName.normalize('NFC'),
      );
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
    await vscode.commands.executeCommand(`${BooksViewProvider.viewId}.focus`).then(undefined, () => undefined);
    this.openDetailUri = uri;
    this.applyDetailChrome();
    await this.postDetail(uri, true);
  }

  dispose(): void {
    clearTimeout(this.repostTimer);
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
    if (typeof m !== 'object' || m === null || !('type' in m)) {
      return;
    }
    const msg = m as { type: string; [k: string]: unknown };
    switch (msg.type) {
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
        if (typeof msg.uri === 'string') {
          if (msg.checked === true) {
            this.checked.add(msg.uri);
          } else {
            this.checked.delete(msg.uri);
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
        this.revealOutput = msg.on === true;
        break;
      case 'build':
        if (msg.format === 'print' || msg.format === 'txt' || msg.format === 'epub') {
          if (typeof msg.uri === 'string') {
            if (this.entryOf(msg.uri) !== undefined) {
              await this.buildSelected(msg.format, [msg.uri]);
            }
          } else {
            await this.buildSelected(msg.format);
          }
        }
        break;
      case 'openDetail':
        if (typeof msg.uri === 'string') {
          this.openDetailUri = msg.uri;
          this.applyDetailChrome();
          await this.postDetail(msg.uri);
        }
        break;
      case 'closeDetail':
        this.openDetailUri = undefined;
        this.applyDetailChrome();
        break;
      case 'openFile':
        if (typeof msg.uri === 'string') {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(msg.uri));
        }
        break;
      case 'editMeta':
        await this.dispatchEditMeta(msg.uri, msg.metaKey);
        break;
      case 'addEntries':
        await this.dispatchList('jpbook.addFiles', msg.uri, msg.list);
        break;
      case 'createEntry':
        await this.dispatchList('jpbook.createFile', msg.uri, msg.list);
        break;
      case 'removeEntry':
        await this.runEntryVerb(msg.uri, () => this.dispatchEntry('jpbook.removeEntry', msg.uri, msg.list, rowRefOf(msg)));
        break;
      case 'moveEntry':
        await this.runEntryVerb(msg.uri, () =>
          this.dispatchEntry(msg.dir === -1 ? 'jpbook.moveEntryUp' : 'jpbook.moveEntryDown', msg.uri, msg.list, rowRefOf(msg)));
        break;
      case 'moveEntryTo':
        await this.runEntryVerb(msg.uri, () => this.dispatchMoveTo(msg.uri, msg.list, rowRefOf(msg), msg.before, msg.beforePath));
        break;
      case 'welcome':
        this.dispatchWelcome(msg.action);
        break;
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
    const node: BookNode = { kind: 'meta', entry, metaKey: metaKey as MetaKey, value };
    await vscode.commands.executeCommand('jpbook.editMeta', node);
  }

  /** Dispatch a list command (add / create) with a synthesized list node. */
  private async dispatchList(command: string, uri: unknown, list: unknown): Promise<void> {
    const entry = this.entryOf(uri);
    if (entry === undefined || !isEntryList(list)) {
      return;
    }
    const node: BookNode = { kind: 'list', list, entry };
    await vscode.commands.executeCommand(command, node);
  }

  /**
   * Runs a row verb (remove / move / drop) after the ones before it, then re-pushes the open detail
   * whether or not anything changed: each verb plans against the text the previous one left, and
   * the panel re-syncs at once instead of after the save → watcher → listBooks round trip. A
   * failed verb never wedges the chain.
   */
  private runEntryVerb(uri: unknown, verb: () => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        await verb();
      } catch {
        // already reported at the command boundary
      }
      if (typeof uri === 'string' && uri === this.openDetailUri) {
        await this.postDetail(uri);
      }
    };
    this.entryChain = this.entryChain.then(run, run);
    return this.entryChain;
  }

  /** Dispatch an entry command (remove / move) with a synthesized node — `manage.ts` checks the row against the live text. */
  private async dispatchEntry(command: string, uri: unknown, list: unknown, ref: RowRef | null): Promise<void> {
    const entry = this.entryOf(uri);
    if (entry === undefined || !isEntryList(list) || ref === null) {
      return;
    }
    const node: BookNode = { kind: 'entry', list, entry, ...ref };
    await vscode.commands.executeCommand(command, node);
  }

  /**
   * Drag-and-drop reorder: move the row `ref` to sit before the row `before`/`beforePath` (both
   * null = end of its list), through the same planner + save path as the up/down buttons. Both
   * rows must still be where the panel showed them (version + resolveEntry); otherwise, as for a
   * no-op move, nothing is planned — never a fallback to the end of the list.
   */
  private async dispatchMoveTo(
    uri: unknown,
    list: unknown,
    ref: RowRef | null,
    before: unknown,
    beforePath: unknown,
  ): Promise<void> {
    const entry = this.entryOf(uri);
    if (entry === undefined || !isEntryList(list) || ref === null) {
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
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
    } catch {
      return;
    }
    if (doc.version !== ref.version) {
      return;
    }
    const text = doc.getText();
    const lines = parseJpbook(text).lines;
    const from = resolveEntry(lines, list, ref);
    const beforeLine = target === null ? null : resolveEntry(lines, list, target);
    if (from === null || (target !== null && beforeLine === null)) {
      return;
    }
    const edits = moveEntryTo(text, list, from, beforeLine);
    if (edits !== null) {
      await applyBookEdits(doc.uri, edits);
    }
  }

  /** Runs an empty-state welcome-link action (create book / open guide / open folder). */
  private dispatchWelcome(action: unknown): void {
    if (action === 'createBook') {
      void vscode.commands.executeCommand('jpbook.createFile');
    } else if (action === 'openGuide') {
      void vscode.commands.executeCommand('jpnov.openGuide');
    } else if (action === 'openFolder') {
      void vscode.commands.executeCommand('workbench.action.files.openFolder');
    }
  }

  /** Push the book list (per-root sections; single root shown flat) + selection to the webview. */
  private postState(): void {
    const view = this.view;
    if (view === undefined) {
      return;
    }
    const byRoot = Map.groupBy(this.books, (b) => b.rootUri);
    const multiRoot = byRoot.size > 1;
    const groups = [...byRoot.entries()]
      .sort((a, b) => compareStr(lastPathSegment(a[0]), lastPathSegment(b[0])))
      .map(([rootUri, entries]) => ({
        rootLabel: multiRoot ? lastPathSegment(rootUri) : null,
        books: entries
          .sort((a, b) => compareStr(a.outRel, b.outRel))
          .map((entry): BookVM => ({
            uri: entry.uri,
            title: bookTitle(entry),
            fileRel: entry.fileRel,
            checked: this.checked.has(entry.uri),
          })),
      }));
    const noFolder = (vscode.workspace.workspaceFolders ?? []).length === 0;
    const message: StateMessage = {
      type: 'state',
      loading: !this.hasLoaded,
      noFolder,
      revealOutput: this.revealOutput,
      groups,
    };
    void view.webview.postMessage(message);
  }

  /**
   * Parse one book and push its covers and chapters (with missing-file flags) + metadata rows
   * to the webview. `reveal` marks a host-initiated open — without it the webview drops the push
   * unless its detail screen is already the user's intent.
   */
  private async postDetail(uri: string, reveal = false): Promise<void> {
    const view = this.view;
    const entry = this.entryOf(uri);
    if (view === undefined || entry === undefined) {
      return;
    }
    let text: string;
    let version: number;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      text = doc.getText();
      version = doc.version;
    } catch {
      return;
    }
    if (this.openDetailUri !== uri) {
      return; // the user navigated away while the document loaded
    }
    const parsed = parseJpbook(text);
    const [chapters, covers] = await Promise.all([
      this.entryVMs(entry, parsed.lines, 'chapters'),
      this.entryVMs(entry, parsed.lines, 'covers'),
    ]);
    const meta: MetaVM[] = metaRows(parsed.meta).map((row) => {
      const parts = metaValueParts(row.key, row.value);
      return { key: row.key, label: metaLabel(row.key), value: parts.value, note: parts.note };
    });
    if (this.openDetailUri !== uri) {
      return; // navigated away during the async stats
    }
    const message: DetailMessage = {
      type: 'detail',
      uri,
      title: bookTitle(entry),
      version,
      chapters,
      covers,
      meta,
      ...(reveal ? { reveal } : {}),
    };
    void view.webview.postMessage(message);
  }

  /** One list's rows: the listed path (the row's identity, split into name/folder for display), file
   *  URI, fs.stat-backed missing flag. */
  private async entryVMs(entry: BookEntry, lines: readonly ParsedLine[], list: EntryList): Promise<EntryVM[]> {
    return Promise.all(
      entryLines(lines, list).map(async (line): Promise<EntryVM> => {
        const pl = lines[line];
        const path = pl === undefined ? '' : entryKeyOf(pl);
        const { name, dir } = splitRelPath(path);
        const target = chapterUri(entry.rootUri, path);
        let missing = false;
        try {
          const st = await vscode.workspace.fs.stat(target);
          missing = (st.type & vscode.FileType.File) === 0;
        } catch {
          missing = true;
        }
        return { line, path, name, folder: dir, fileUri: target.toString(), missing };
      }),
    );
  }

  /**
   * The localized "built {N} file(s)" success toast (Japanese is number-invariant). With the
   * footer's reveal toggle on, also opens each output dir — `BuildResult.outDirs`, already
   * deduplicated server-side.
   */
  private reportBuilt(count: number, label: string, outDirs: readonly string[]): void {
    // showInformationMessage never rejects, so void is safe.
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Japanese Novel: built {0} {1} file(s).', String(count), label),
    );
    if (!this.revealOutput) {
      return;
    }
    for (const dir of outDirs) {
      // openExternal opens the folder's contents; revealFileInOS would only select it in its parent.
      void vscode.env.openExternal(vscode.Uri.parse(dir));
    }
  }

  /**
   * The build driver behind the panel's build buttons (webview `build` messages): render
   * the CHECKED books (or exactly `only`, when given) to `action`'s one
   * format (`print` = `.html` on the wire, then opened in the OS default browser — the HTML
   * artifact's only build path; `epub` comes back as member files the client zips), write
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
            projectDirs: buildProjectDirs(),
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

        // The CLIENT owns all filesystem writes and encodings.
        const txtEncoding = vscode.workspace
          .getConfiguration()
          .get<TxtEncoding>('jpnov.layout.txt.encoding', TXT_ENCODING_DEFAULT);
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
          // Print: open each written artifact in the OS default browser — a webview
          // cannot print (its iframe sandbox has no allow-modals, so print() is a
          // silent no-op). The tab already presents the output, so print skips the
          // folder reveal below.
          if (action === 'print') {
            for (const file of written) {
              void vscode.env.openExternal(vscode.Uri.parse(file));
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
