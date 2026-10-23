/**
 * A minimal in-memory `vscode` stand-in for client unit tests under `node --test`.
 *
 * The real `vscode` module only exists inside the extension host, so these tests run
 * against this stub installed via `mock.module('vscode', { exports })` (Node's
 * `--experimental-test-module-mocks`). It implements ONLY the surface the client
 * modules touch; anything else is intentionally absent so accidental new dependencies
 * fail loudly.
 *
 * Suites using this mock run in CI via `npm run test:integration`; for direct runs see
 * test/client/README.md.
 */
import { posix } from 'node:path';

import { CancellationTokenSource } from 'vscode-languageserver/node';

export type Listener<T> = (e: T) => unknown;

/** A trivial Event emitter matching vscode's `Event<T>` + `EventEmitter` shape. */
export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };

  fire(data: T): void {
    for (const l of [...this.listeners]) {
      l(data);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class Disposable {
  private readonly fn: () => void;
  constructor(fn: () => void) {
    this.fn = fn;
  }

  dispose(): void {
    this.fn();
  }

  static from(...items: { dispose(): void }[]): Disposable {
    return new Disposable(() => {
      for (const i of items) {
        i.dispose();
      }
    });
  }
}

/** A registration-only hook: it accepts the listener and never calls it. */
export function registrationOnly(): Disposable {
  return new Disposable(() => { /* no-op */ });
}

/** Just enough of vscode.Uri: parse/file + toString + path/scheme/authority. */
export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  private constructor(scheme: string, authority: string, path: string) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
  }

  static parse(value: string): Uri {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(\/.*)?$/.exec(value);
    if (m) {
      const [, scheme = 'file', authority = '', path = ''] = m;
      return new Uri(scheme, authority, path);
    }
    // Fallback: treat as a file path.
    return new Uri('file', '', value.startsWith('/') ? value : `/${value}`);
  }

  static file(path: string): Uri {
    return new Uri('file', '', path);
  }

  /** Folds `.` and `..` like VS Code's `joinPath` (which runs `posix.join`). */
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = posix.join(base.path, ...segments);
    return new Uri(base.scheme, base.authority, joined);
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }

  get fsPath(): string {
    return this.path;
  }
}

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;

/** vscode.FileSystemError: an Error carrying the `.code` the client narrows on. */
export class FileSystemError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'FileSystemError';
  }

  static FileNotFound(uri?: Uri | string): FileSystemError {
    return new FileSystemError('FileNotFound', uri === undefined ? undefined : String(uri));
  }
}

export class RelativePattern {
  readonly base: Uri | string | { uri: Uri };
  readonly pattern: string;
  constructor(base: Uri | string | { uri: Uri }, pattern: string) {
    this.base = base;
    this.pattern = pattern;
  }
}

/** Just enough of vscode.Range: the 4-number constructor the client's edit planners use. */
export class Range {
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

/** Just enough of vscode.WorkspaceEdit: collects `replace` calls for `workspace.applyEdit`. */
export class WorkspaceEdit {
  readonly replaces: { uri: Uri; range: Range; newText: string }[] = [];
  replace(uri: Uri, range: Range, newText: string): void {
    this.replaces.push({ uri, range, newText });
  }
}

export class MarkdownString {
  value = '';
  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }

  /** As VS Code: the markdown-special characters of `s` escaped. */
  appendText(s: string): this {
    this.value += s.replace(/[\\`*_{}[\]()#+\-.!~]/g, '\\$&');
    return this;
  }
}

/** As VS Code: one content becomes the one-element list. */
export class Hover {
  readonly contents: MarkdownString[];
  readonly range: Range | undefined;
  constructor(contents: MarkdownString, range?: Range) {
    this.contents = [contents];
    this.range = range;
  }
}

export const ViewColumn = { One: 1, Two: 2, Three: 3, Beside: -2 } as const;
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

export interface FakeTextDocument {
  uri: Uri;
  languageId: string;
  /** `TextDocument.version` (the panel's row verbs echo it); `doc()` starts at 1 and `applyEdit` leaves it alone. */
  version: number;
  /** `TextDocument.encoding` ('utf8', 'shiftjis', …); `doc()` defaults it to 'utf8'. */
  encoding?: string;
  getText(): string;
  /** `TextDocument.isDirty`; `doc()` leaves it unset (clean), the book-wide fix reads it before its edit. */
  isDirty?: boolean;
  /** Present on `doc()`-built documents (manage.ts saves after `applyEdit`); hand-rolled fakes may omit it. */
  save?(): Promise<boolean>;
}

export interface FakeWebview {
  html: string;
  cspSource: string;
  options: unknown;
  /** Maps an on-disk Uri to a webview-loadable one (identity here; real VS Code rewrites the scheme). */
  asWebviewUri(uri: Uri): Uri;
  /** Messages sent via `postMessage`, captured for assertions. */
  posted: unknown[];
  postMessage(message: unknown): Promise<boolean>;
  /** Host handler for webview->host messages (the WebviewView provider registers here). */
  onDidReceiveMessage(listener: Listener<unknown>): Disposable;
  /** Test helper: deliver a webview->host message to the registered handler(s). */
  receive(message: unknown): void;
}

/** Just enough of a TextEditor: its document + the cursor selections. */
export interface FakeSelection {
  active: { line: number; character: number };
}
export interface FakeTextEditor {
  document: FakeTextDocument;
  selections: readonly FakeSelection[];
  viewColumn?: number;
}
export interface FakeSelectionChange {
  textEditor: FakeTextEditor;
  selections: readonly FakeSelection[];
}

/** `ConfigurationChangeEvent`: the one method the listeners call. */
export interface FakeConfigurationChange {
  affectsConfiguration(section: string): boolean;
}

/** `FileRenameEvent`. */
export interface FakeFileRenameEvent {
  readonly files: readonly { readonly oldUri: Uri; readonly newUri: Uri }[];
}

/** `WorkspaceFoldersChangeEvent`. */
export interface FakeWorkspaceFoldersChange {
  added: readonly { uri: Uri }[];
  removed: readonly { uri: Uri }[];
}

export interface FakeWebviewPanel {
  viewType: string;
  title: string;
  webview: FakeWebview;
  /** `WebviewPanel.viewColumn`; tests set it to observe a reveal in place. */
  viewColumn: number | undefined;
  /** The arguments of every `reveal` call, captured for assertions. */
  revealed: { column: number | undefined; preserveFocus: boolean | undefined }[];
  disposed: boolean;
  /** `WebviewPanel.visible`; tests flip it with `setVisible`, which fires `onDidChangeViewState`. */
  visible: boolean;
  setVisible(visible: boolean): void;
  reveal(column?: number, preserveFocus?: boolean): void;
  dispose(): void;
  onDidDispose(listener: Listener<void>): Disposable;
  onDidChangeViewState(listener: Listener<{ webviewPanel: FakeWebviewPanel }>): Disposable;
}

/** The InputBoxOptions fields the extension's prompts set, typed once for assertions. */
export interface RecordedInputBox {
  prompt?: string;
  value?: string;
  valueSelection?: [number, number];
  ignoreFocusOut?: boolean;
  placeHolder?: string;
  validateInput?: (value: string) => string | null | Promise<string | null>;
}

/** Mutable test harness backing the mocked `vscode` namespace. */
export interface MockState {
  textDocuments: FakeTextDocument[];
  /** Hover providers registered via `languages.registerHoverProvider`, with their selector. */
  hoverProviders: { selector: unknown; provider: unknown }[];
  panels: FakeWebviewPanel[];
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  /** `commands.executeCommand` invocations, so tests can assert dispatched jpbook.* / vscode.open. */
  executedCommands: { command: string; args: unknown[] }[];
  writtenFiles: { uri: string; content: string }[];
  /**
   * Replaces from `workspace.applyEdit` (range as [startLine, startChar, endLine, endChar]).
   * Recorded only — document text never mutates, so multi-step flows must reseed their docs.
   */
  appliedEdits: { uri: string; range: [number, number, number, number]; newText: string }[];
  /** What `workspace.applyEdit` resolves to (false = the editor refused the edit). */
  applyEditResult: boolean;
  onDidChangeDoc: EventEmitter<{ document: FakeTextDocument }>;
  onDidChangeActiveEditor: EventEmitter<FakeTextEditor | undefined>;
  /** `window.activeTextEditor`: the editor being typed in; the preview reads its selections. */
  activeEditor: FakeTextEditor | undefined;
  /** Editors the preview's cursor-follow consults via `window.visibleTextEditors`. */
  visibleEditors: FakeTextEditor[];
  onDidChangeSelection: EventEmitter<FakeSelectionChange>;
  /** `workspace.onDidChangeConfiguration`: a test sets the values in `config` / `scopedConfig`, then fires this. */
  onDidChangeConfig: EventEmitter<FakeConfigurationChange>;
  /** `workspace.onDidChangeWorkspaceFolders`: a test edits `workspaceFolders`, then fires this. */
  onDidChangeFolders: EventEmitter<FakeWorkspaceFoldersChange>;
  /** `workspace.onDidOpenTextDocument` / `onDidCloseTextDocument` / `onDidSaveTextDocument`: a test fires these with a document. */
  onDidOpenDoc: EventEmitter<FakeTextDocument>;
  onDidCloseDoc: EventEmitter<FakeTextDocument>;
  onDidSaveDoc: EventEmitter<FakeTextDocument>;
  /** `workspace.onDidRenameFiles`: a test fires this with the event's `files`. */
  onDidRenameFiles: EventEmitter<FakeFileRenameEvent>;
  /** What `window.showSaveDialog` resolves to (undefined = dismissed), and the options of each call. */
  saveDialogResult: Uri | undefined;
  saveDialogCalls: unknown[];
  warningMessages: string[];
  /** Programmed `showQuickPick` responses (FIFO; undefined = Esc) and `createQuickPick` step scripts (see `FakeQuickPick`). */
  quickPickQueue: unknown[];
  quickPickCalls: { items: unknown; options: unknown }[];
  /** Every `createQuickPick()` instance, in creation order, for reading its final rows. */
  quickPicks: FakeQuickPick<{ label: string; description?: string }>[];
  /** `window.registerWebviewViewProvider` registrations by view id, so a test can resolve a view as VS Code would. */
  registeredViewProviders: Map<string, { resolveWebviewView(view: unknown): void }>;
  inputBoxQueue: (string | undefined)[];
  inputBoxCalls: { options: RecordedInputBox | undefined }[];
  /** Folders the init command may scaffold into; undefined = no folder open. */
  workspaceFolders: { uri: Uri; name: string; index: number }[] | undefined;
  workspaceFolderPickResult: { uri: Uri } | undefined;
  /** Uris `workspace.openTextDocument` must reject (simulates deleted/unloadable files). */
  unopenableDocs: Set<string>;
  /** In-memory filesystem the init guard probes: uri string → FileType. */
  fsEntries: Map<string, number>;
  /** The file system watchers created so far, by glob: a test fires their events. */
  watchers: Map<string, { create: EventEmitter<Uri>; delete: EventEmitter<Uri>; change: EventEmitter<Uri> }>;
  /** `fs.stat`'s `mtime`/`size` by uri string; an entry without one stats as 0/0. */
  fsStamps: Map<string, { mtime: number; size: number }>;
  /** File contents for readFile (uri string → utf8 text). */
  fsContent: Map<string, string>;
  /** Raw bytes for readFile (uri string → bytes), consulted before `fsContent`. */
  fsBytes: Map<string, Uint8Array>;
  /** `workspace.fs.readFile` rejections: uri string → the `FileSystemError.code` to reject with. */
  fsReadErrors: Map<string, string>;
  /** The encoding `workspace.decode(bytes, { uri })` picks per uri string ('utf8' when absent). */
  guessedEncoding: Map<string, string>;
  /** Recorded `workspace.decode` options, one entry per call (`{ uri }` or `{ encoding }`). */
  decodeCalls: ({ uri: string } | { encoding: string })[];
  /** Settings store for `workspace.getConfiguration().get(key, dflt)` (full key → value). */
  config: Record<string, unknown>;
  /** Scope-aware settings values: `${scopeUri}|${section.key}` (or `|full.key`) → value. */
  scopedConfig: Map<string, unknown>;
  /** `inspect()` results: `${scopeUri}|${section.key}` → the per-scope value object. */
  inspectResults: Map<
    string,
    { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }
  >;
  /** `getConfiguration().update()` calls (full key, value, `ConfigurationTarget`), which also land in `config`. */
  configUpdates: { key: string; value: unknown; target: unknown }[];
  /** `workspace.fs.readDirectory` responses: uri string → entries, or 'error' to reject. */
  readDirectoryResults: Map<string, [string, number][] | 'error'>;
  /** `workspace.findFiles` responses: the base folder's uri string (a `RelativePattern`) or the glob itself (a string) → matches ([] when absent), or 'error'. */
  findFilesResults: Map<string, Uri[] | 'error'>;
  /** Recorded findFiles invocations, so tests can assert a sweep was (not) consulted. */
  findFilesCalls: { include: RelativePattern | string; maxResults: number | undefined }[];
  createdDirs: string[];
  openedDocs: string[];
  errorMessages: string[];
  /** The button `showErrorMessage` resolves to (undefined = dismissed). */
  errorMessagePick: string | undefined;
  infoMessages: string[];
  /** `env.openExternal` targets (uri strings), e.g. the post-build output-folder opens. */
  openedExternal: string[];
  /** `window.showTextDocument` calls: the uri shown and the selection asked for, when any. */
  shownDocuments: { uri: string; selection: [number, number, number, number] | undefined }[];
  /** `withProgress` options seen, one per call (so tests can assert `cancellable`). */
  progressOptions: unknown[];
  /** Pre-set to true to hand the progress task an already-cancelled token. The mock token
   *  reports this flag only — its `onCancellationRequested` never fires mid-task. */
  progressCancelled: boolean;
}

export function createMockState(): MockState {
  return {
    textDocuments: [],
    hoverProviders: [],
    panels: [],
    registeredCommands: new Map(),
    executedCommands: [],
    writtenFiles: [],
    appliedEdits: [],
    applyEditResult: true,
    shownDocuments: [],
    onDidChangeDoc: new EventEmitter<{ document: FakeTextDocument }>(),
    onDidChangeActiveEditor: new EventEmitter<FakeTextEditor | undefined>(),
    activeEditor: undefined,
    visibleEditors: [],
    onDidChangeSelection: new EventEmitter<FakeSelectionChange>(),
    onDidChangeConfig: new EventEmitter<FakeConfigurationChange>(),
    onDidChangeFolders: new EventEmitter<FakeWorkspaceFoldersChange>(),
    onDidOpenDoc: new EventEmitter<FakeTextDocument>(),
    onDidCloseDoc: new EventEmitter<FakeTextDocument>(),
    onDidSaveDoc: new EventEmitter<FakeTextDocument>(),
    onDidRenameFiles: new EventEmitter<FakeFileRenameEvent>(),
    saveDialogResult: undefined,
    saveDialogCalls: [],
    warningMessages: [],
    quickPickQueue: [],
    quickPickCalls: [],
    quickPicks: [],
    registeredViewProviders: new Map(),
    inputBoxQueue: [],
    inputBoxCalls: [],
    workspaceFolders: undefined,
    workspaceFolderPickResult: undefined,
    unopenableDocs: new Set<string>(),
    fsEntries: new Map<string, number>(),
    watchers: new Map(),
    fsStamps: new Map<string, { mtime: number; size: number }>(),
    fsContent: new Map<string, string>(),
    fsBytes: new Map<string, Uint8Array>(),
    fsReadErrors: new Map<string, string>(),
    guessedEncoding: new Map<string, string>(),
    decodeCalls: [],
    config: {},
    scopedConfig: new Map<string, unknown>(),
    inspectResults: new Map(),
    configUpdates: [],
    readDirectoryResults: new Map<string, [string, number][] | 'error'>(),
    findFilesResults: new Map<string, Uri[] | 'error'>(),
    findFilesCalls: [],
    createdDirs: [],
    openedDocs: [],
    errorMessages: [],
    errorMessagePick: undefined,
    infoMessages: [],
    openedExternal: [],
    progressOptions: [],
    progressCancelled: false,
  };
}

/**
 * Reset a state object IN PLACE between tests. `mock.module('vscode', ...)` is installed
 * ONCE (before the modules under test import it), so the mock closes over a single
 * `MockState` instance for the whole file; per-test isolation comes from clearing that
 * instance here rather than swapping it (a swap would not reach already-cached modules).
 */
export function resetMockState(s: MockState): void {
  s.textDocuments.length = 0;
  s.panels.length = 0;
  s.registeredCommands.clear();
  s.executedCommands.length = 0;
  s.writtenFiles.length = 0;
  s.appliedEdits.length = 0;
  s.applyEditResult = true;
  s.shownDocuments.length = 0;
  s.activeEditor = undefined;
  s.visibleEditors.length = 0;
  s.onDidChangeSelection.dispose();
  s.onDidChangeDoc.dispose();
  s.onDidChangeActiveEditor.dispose();
  s.onDidChangeConfig.dispose();
  s.onDidChangeFolders.dispose();
  s.onDidOpenDoc.dispose();
  s.onDidCloseDoc.dispose();
  s.onDidSaveDoc.dispose();
  s.onDidRenameFiles.dispose();
  s.saveDialogResult = undefined;
  s.saveDialogCalls.length = 0;
  s.warningMessages.length = 0;
  s.quickPickQueue.length = 0;
  s.quickPickCalls.length = 0;
  s.quickPicks.length = 0;
  s.registeredViewProviders.clear();
  s.inputBoxQueue.length = 0;
  s.inputBoxCalls.length = 0;
  s.workspaceFolders = undefined;
  s.workspaceFolderPickResult = undefined;
  s.unopenableDocs.clear();
  s.fsEntries.clear();
  s.watchers.clear();
  s.fsStamps.clear();
  s.fsContent.clear();
  s.fsBytes.clear();
  s.fsReadErrors.clear();
  s.guessedEncoding.clear();
  s.decodeCalls.length = 0;
  s.config = {};
  s.scopedConfig.clear();
  s.inspectResults.clear();
  s.configUpdates.length = 0;
  s.readDirectoryResults.clear();
  s.findFilesResults.clear();
  s.findFilesCalls.length = 0;
  s.createdDirs.length = 0;
  s.openedDocs.length = 0;
  s.errorMessages.length = 0;
  s.errorMessagePick = undefined;
  s.infoMessages.length = 0;
  s.openedExternal.length = 0;
  s.progressOptions.length = 0;
  s.progressCancelled = false;
}

/** VS Code encoding ids → WHATWG decoder labels, for the ids the tests use. */
const DECODER_LABELS: Readonly<Partial<Record<string, string>>> = { utf8: 'utf-8', shiftjis: 'shift_jis' };

/**
 * Build a `vscode`-shaped namespace object bound to `state`, the `exports` of
 * `mock.module('vscode', { exports })`: the client does `import * as vscode`, so every member is
 * a named export.
 */
export function buildVscode(state: MockState): Record<string, unknown> {
  const window = {
    get activeTextEditor() {
      return state.activeEditor;
    },
    onDidChangeActiveTextEditor: state.onDidChangeActiveEditor.event,
    onDidChangeTextEditorSelection: state.onDidChangeSelection.event,
    get visibleTextEditors() {
      return state.visibleEditors;
    },
    createWebviewPanel(
      viewType: string,
      title: string,
      _show: unknown,
      _opts: unknown,
    ): FakeWebviewPanel {
      const panel = createFakePanel(viewType, title, _opts);
      state.panels.push(panel);
      return panel;
    },
    // Tests hand a panel to `Preview.adopt()` themselves; a view provider is recorded for the tests that open the view.
    registerWebviewViewProvider(id: string, provider: { resolveWebviewView(view: unknown): void }): Disposable {
      state.registeredViewProviders.set(id, provider);
      return registrationOnly();
    },
    registerWebviewPanelSerializer: registrationOnly,
    showErrorMessage(...args: unknown[]): Promise<string | undefined> {
      if (typeof args[0] === 'string') {
        state.errorMessages.push(args[0]);
      }
      return Promise.resolve(state.errorMessagePick);
    },
    showInformationMessage(...args: unknown[]): Promise<undefined> {
      if (typeof args[0] === 'string') {
        state.infoMessages.push(args[0]);
      }
      return Promise.resolve(undefined);
    },
    showWarningMessage(...args: unknown[]): Promise<undefined> {
      if (typeof args[0] === 'string') {
        state.warningMessages.push(args[0]);
      }
      return Promise.resolve(undefined);
    },
    showSaveDialog(options?: unknown): Promise<Uri | undefined> {
      state.saveDialogCalls.push(options);
      return Promise.resolve(state.saveDialogResult);
    },
    showQuickPick(items: unknown, options?: unknown): Promise<unknown> {
      state.quickPickCalls.push({ items, options });
      return Promise.resolve(state.quickPickQueue.shift());
    },
    createQuickPick(): FakeQuickPick<{ label: string; description?: string }> {
      const qp = new FakeQuickPick<{ label: string; description?: string }>(state);
      state.quickPicks.push(qp);
      return qp;
    },
    showInputBox(options?: RecordedInputBox): Promise<string | undefined> {
      state.inputBoxCalls.push({ options });
      return Promise.resolve(state.inputBoxQueue.shift());
    },
    showWorkspaceFolderPick(options?: unknown): Promise<{ uri: Uri } | undefined> {
      void options;
      return Promise.resolve(state.workspaceFolderPickResult);
    },
    showTextDocument(document: unknown, options?: { selection?: Range }): Promise<unknown> {
      const uri = document instanceof Uri ? document : (document as { uri: Uri }).uri;
      const sel = options?.selection;
      state.shownDocuments.push({
        uri: uri.toString(),
        selection: sel === undefined ? undefined : [sel.start.line, sel.start.character, sel.end.line, sel.end.character],
      });
      return Promise.resolve(document);
    },
    withProgress<R>(
      opts: unknown,
      task: (
        progress: { report(value: unknown): void },
        token: { isCancellationRequested: boolean; onCancellationRequested(l: () => void): Disposable },
      ) => Thenable<R>,
    ): Thenable<R> {
      state.progressOptions.push(opts);
      return task(
        {
          report(): void { /* progress text is not asserted */ },
        },
        {
          get isCancellationRequested(): boolean {
            return state.progressCancelled;
          },
          onCancellationRequested(): Disposable {
            return new Disposable(() => undefined);
          },
        },
      );
    },
  };

  const fsApi = {
    writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      const text = Buffer.from(content).toString('utf8');
      state.writtenFiles.push({ uri: uri.toString(), content: text });
      state.fsEntries.set(uri.toString(), FileType.File);
      state.fsContent.set(uri.toString(), text);
      return Promise.resolve();
    },
    readFile(uri: Uri): Promise<Uint8Array> {
      const key = uri.toString();
      const code = state.fsReadErrors.get(key);
      if (code !== undefined) {
        return Promise.reject(new FileSystemError(code));
      }
      if (!state.fsEntries.has(key)) {
        return Promise.reject(FileSystemError.FileNotFound(uri));
      }
      return Promise.resolve(state.fsBytes.get(key) ?? Buffer.from(state.fsContent.get(key) ?? '', 'utf8'));
    },
    stat(uri: Uri): Promise<{ type: number; mtime: number; size: number }> {
      const type = state.fsEntries.get(uri.toString());
      if (type === undefined) {
        return Promise.reject(FileSystemError.FileNotFound(uri));
      }
      return Promise.resolve({ type, ...(state.fsStamps.get(uri.toString()) ?? { mtime: 0, size: 0 }) });
    },
    createDirectory(uri: Uri): Promise<void> {
      state.createdDirs.push(uri.toString());
      state.fsEntries.set(uri.toString(), FileType.Directory);
      return Promise.resolve();
    },
    readDirectory(uri: Uri): Promise<[string, number][]> {
      const entries = state.readDirectoryResults.get(uri.toString());
      if (entries === 'error') {
        return Promise.reject(FileSystemError.FileNotFound(uri));
      }
      return Promise.resolve(entries ?? []);
    },
  };

  const workspace = {
    get textDocuments() {
      return state.textDocuments;
    },
    get workspaceFolders() {
      return state.workspaceFolders;
    },
    /** The folder containing `uri` (the longest `/`-bounded prefix), as VS Code picks it. */
    getWorkspaceFolder(uri: Uri): { uri: Uri; name: string; index: number } | undefined {
      const target = uri.toString();
      let best: { uri: Uri; name: string; index: number } | undefined;
      for (const folder of state.workspaceFolders ?? []) {
        const root = folder.uri.toString().replace(/\/+$/, '');
        if ((target === root || target.startsWith(`${root}/`)) && (best === undefined || root.length > best.uri.toString().length)) {
          best = folder;
        }
      }
      return best;
    },
    fs: fsApi,
    /** `vscode.workspace.decode`: the options are recorded; NUL bytes count as binary (VS Code's own heuristic). */
    decode(content: Uint8Array, options: { uri: Uri } | { encoding: string }): Promise<string> {
      const label = 'encoding' in options ? options.encoding : (state.guessedEncoding.get(options.uri.toString()) ?? 'utf8');
      state.decodeCalls.push('encoding' in options ? { encoding: options.encoding } : { uri: options.uri.toString() });
      if (content.includes(0)) {
        return Promise.reject(new Error('Stream is binary but only text is accepted for decoding'));
      }
      return Promise.resolve(new TextDecoder(DECODER_LABELS[label] ?? label).decode(content));
    },
    createFileSystemWatcher(glob: string): {
      onDidCreate: (l: Listener<Uri>) => Disposable;
      onDidDelete: (l: Listener<Uri>) => Disposable;
      onDidChange: (l: Listener<Uri>) => Disposable;
      dispose(): void;
    } {
      // A test fires a watcher's events through `state.watchers` by glob; most drive refresh() directly.
      const w = { create: new EventEmitter<Uri>(), delete: new EventEmitter<Uri>(), change: new EventEmitter<Uri>() };
      state.watchers.set(glob, w);
      return { onDidCreate: w.create.event, onDidDelete: w.delete.event, onDidChange: w.change.event, dispose() { /* no-op */ } };
    },
    onDidChangeTextDocument: state.onDidChangeDoc.event,
    onDidChangeConfiguration: state.onDidChangeConfig.event,
    onDidChangeWorkspaceFolders: state.onDidChangeFolders.event,
    // File-operation events (Explorer gestures): registration-only, like the watcher above.
    onDidCreateFiles: registrationOnly,
    onDidDeleteFiles: registrationOnly,
    onDidRenameFiles: state.onDidRenameFiles.event,
    onDidOpenTextDocument: state.onDidOpenDoc.event,
    onDidCloseTextDocument: state.onDidCloseDoc.event,
    onDidSaveTextDocument: state.onDidSaveDoc.event,
    // Settings reads. Bare getConfiguration() + full keys (renderConfig.ts) resolves from
    // `state.config` as before; the section/scope form (probe.ts)
    // consults `state.scopedConfig` first — keyed `${scopeUri}|${section ? section + '.' : ''}${key}`
    // — and falls back to `state.config` under the same composite key. `inspect()` reads
    // `state.inspectResults` under the same key shape (probe's section-level inspect included).
    getConfiguration(section?: string, scope?: { toString(): string } | null) {
      const scopeKey = scope ? scope.toString() : '';
      const fullKey = (key: string): string => (section ? `${section}.${key}` : key);
      return {
        get<T>(key: string, dflt: T): T {
          const scoped = `${scopeKey}|${fullKey(key)}`;
          if (state.scopedConfig.has(scoped)) {
            return state.scopedConfig.get(scoped) as T;
          }
          const full = fullKey(key);
          return full in state.config ? (state.config[full] as T) : dflt;
        },
        inspect(key: string):
          | { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }
          | undefined {
          return state.inspectResults.get(`${scopeKey}|${fullKey(key)}`);
        },
        // Recorded, and applied to `state.config` so a later `get` reads the written value (no
        // change event fires: a test fires `state.onDidChangeConfig` itself).
        update(key: string, value: unknown, target: unknown): Promise<void> {
          state.configUpdates.push({ key: fullKey(key), value, target });
          state.config[fullKey(key)] = value;
          return Promise.resolve();
        },
      };
    },
    applyEdit(edit: WorkspaceEdit): Promise<boolean> {
      for (const r of edit.replaces) {
        state.appliedEdits.push({
          uri: r.uri.toString(),
          range: [r.range.start.line, r.range.start.character, r.range.end.line, r.range.end.character],
          newText: r.newText,
        });
      }
      return Promise.resolve(state.applyEditResult);
    },
    openTextDocument(uri: Uri): Promise<FakeTextDocument> {
      state.openedDocs.push(uri.toString());
      if (state.unopenableDocs.has(uri.toString())) {
        return Promise.reject(FileSystemError.FileNotFound(uri));
      }
      // Prefer a registered document (lets tests control languageId/text); fall back
      // to fabricating a jpnov doc so pre-existing tests keep working unchanged.
      const existing = state.textDocuments.find(
        (d) => d.uri.toString() === uri.toString(),
      );
      return Promise.resolve(existing ?? doc(uri.toString(), 'jpnov'));
    },
    findFiles(
      include: RelativePattern | string,
      _exclude?: string | null,
      maxResults?: number,
    ): Promise<Uri[]> {
      state.findFilesCalls.push({ include, maxResults });
      const base = typeof include === 'string' ? include : include.base;
      const key = typeof base === 'string'
        ? base
        : base instanceof Uri
          ? base.toString()
          : base.uri.toString();
      const found = state.findFilesResults.get(key);
      if (found === 'error') {
        return Promise.reject(new Error('findFiles failed'));
      }
      return Promise.resolve((found ?? []).slice(0, maxResults));
    },
  };

  const commands = {
    registerCommand(
      id: string,
      handler: (...args: unknown[]) => unknown,
    ): Disposable {
      state.registeredCommands.set(id, handler);
      return new Disposable(() => state.registeredCommands.delete(id));
    },
    executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
      state.executedCommands.push({ command, args });
      const handler = state.registeredCommands.get(command);
      return Promise.resolve(handler ? handler(...args) : undefined);
    },
  };

  // l10n.t passthrough: returns the English source literal with {0}/{1}… substituted, so tests
  // assert against the source strings (no ja bundle is loaded under `node --test`).
  const l10n = {
    t(message: string, ...args: unknown[]): string {
      return message.replace(/\{(\d+)\}/g, (whole, index: string) => {
        const i = Number(index);
        return i < args.length ? String(args[i]) : whole;
      });
    },
  };

  const languages = {
    registerHoverProvider(selector: unknown, provider: unknown): Disposable {
      const entry = { selector, provider };
      state.hoverProviders.push(entry);
      return new Disposable(() => {
        state.hoverProviders = state.hoverProviders.filter((p) => p !== entry);
      });
    },
  };

  return {
    window,
    workspace,
    commands,
    languages,
    l10n,
    env: {
      language: 'en',
      // As VS Code does: a string (taken to be canonical already) is opened as written, a Uri
      // as `encodeURI(uri.toString(true))`.
      openExternal(target: string | Uri): Promise<boolean> {
        state.openedExternal.push(
          typeof target === 'string' ? target : encodeURI(decodeURIComponent(target.toString())),
        );
        return Promise.resolve(true);
      },
    },
    Uri,
    FileType,
    FileSystemError,
    RelativePattern,
    Range,
    WorkspaceEdit,
    MarkdownString,
    Hover,
    Disposable,
    EventEmitter,
    CancellationTokenSource,
    ViewColumn,
    ProgressLocation,
    ConfigurationTarget,
  };
}

/** One scripted action on a `createQuickPick()` fake. */
type QuickPickStep = { type: string } | { toggle: string } | { pick: string } | 'accept';

/**
 * A `window.createQuickPick()` fake. `show()` takes the next `quickPickQueue` entry, an array of
 * steps run in order: `{ type }` types that text (the value listeners run), `{ toggle }` flips the
 * tick of the item so labelled and `{ pick }` makes it the selection (the selection listeners
 * run), `'accept'` presses Enter — in single-select mode on the first item when none is picked.
 * A script without `'accept'`, or no entry at all, ends in Esc.
 *
 * Like VS Code, setting `items` reports an empty selection, setting `selectedItems` reports
 * that selection, and setting `value` reports the new value — each on a later turn.
 */
export class FakeQuickPick<T extends { label: string }> {
  title: string | undefined;
  placeholder: string | undefined;
  canSelectMany = false;
  matchOnDescription = false;
  ignoreFocusOut = false;
  activeItems: readonly T[] = [];
  private _value = '';
  private _items: readonly T[] = [];
  private _selectedItems: readonly T[] = [];
  private readonly valueChanged = new EventEmitter<string>();
  private readonly selectionChanged = new EventEmitter<readonly T[]>();
  private readonly accepted = new EventEmitter<void>();
  private readonly hidden = new EventEmitter<void>();
  readonly onDidChangeValue = this.valueChanged.event;
  readonly onDidChangeSelection = this.selectionChanged.event;
  readonly onDidAccept = this.accepted.event;
  readonly onDidHide = this.hidden.event;
  private readonly state: MockState;

  constructor(state: MockState) {
    this.state = state;
  }

  get value(): string {
    return this._value;
  }

  set value(text: string) {
    if (this._value !== text) {
      this._value = text;
      queueMicrotask(() => {
        this.valueChanged.fire(text);
      });
    }
  }

  get items(): readonly T[] {
    return this._items;
  }

  set items(items: readonly T[]) {
    this._items = items;
    if (this._selectedItems.length > 0) {
      this._selectedItems = [];
      queueMicrotask(() => {
        this.selectionChanged.fire([]);
      });
    }
  }

  get selectedItems(): readonly T[] {
    return this._selectedItems;
  }

  set selectedItems(items: readonly T[]) {
    this._selectedItems = items.filter((i) => this._items.includes(i));
    const echo = this._selectedItems;
    queueMicrotask(() => {
      this.selectionChanged.fire(echo);
    });
  }

  show(): void {
    const steps = (this.state.quickPickQueue.shift() ?? []) as readonly QuickPickStep[];
    void this.run(steps);
  }

  private async run(steps: readonly QuickPickStep[]): Promise<void> {
    for (const step of steps) {
      await tick();
      if (step === 'accept') {
        if (!this.canSelectMany && this._selectedItems.length === 0 && this._items[0] !== undefined) {
          this._selectedItems = [this._items[0]];
        }
        this.accepted.fire(undefined);
        return;
      }
      if ('type' in step) {
        this._value = step.type;
        this.valueChanged.fire(step.type);
        continue;
      }
      const label = 'pick' in step ? step.pick : step.toggle;
      const item = this._items.find((i) => i.label === label);
      if (item === undefined) {
        throw new Error(`FakeQuickPick: no item labelled ${label}`);
      }
      if ('pick' in step) {
        this._selectedItems = [item];
      } else {
        this._selectedItems = this._selectedItems.includes(item)
          ? this._selectedItems.filter((i) => i !== item)
          : this._items.filter((i) => i === item || this._selectedItems.includes(i));
      }
      this.selectionChanged.fire(this._selectedItems);
    }
    await tick();
    this.hide();
  }

  hide(): void {
    this.hidden.fire(undefined);
  }

  dispose(): void {
    this.valueChanged.dispose();
    this.selectionChanged.dispose();
    this.accepted.dispose();
    this.hidden.dispose();
  }
}

/** Lets fire-and-forget posts, renders and the quick pick fake's echoes settle. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fake editor showing `document` with one cursor, for the active/visible editors and the editor events. */
export function editorAt(document: FakeTextDocument, line = 0, character = 0, viewColumn = 1): FakeTextEditor {
  return { document, selections: [{ active: { line, character } }], viewColumn };
}

export function doc(uri: string, languageId: string, text = '', encoding = 'utf8'): FakeTextDocument {
  return { uri: Uri.parse(uri), languageId, version: 1, encoding, getText: () => text, save: () => Promise.resolve(true) };
}

/** A fake `vscode.Webview`: captures outbound `postMessage` (posted) + delivers inbound (receive). */
function makeFakeWebview(options?: unknown): FakeWebview {
  const recv = new EventEmitter<unknown>();
  return {
    html: '',
    cspSource: 'vscode-webview://test',
    options,
    asWebviewUri(uri: Uri): Uri {
      return uri;
    },
    posted: [],
    postMessage(message: unknown): Promise<boolean> {
      this.posted.push(message);
      return Promise.resolve(true);
    },
    onDidReceiveMessage(listener: Listener<unknown>): Disposable {
      return recv.event(listener);
    },
    receive(message: unknown): void {
      recv.fire(message);
    },
  };
}

/**
 * A standalone webview panel fake. `window.createWebviewPanel` delegates here (and
 * records into `state.panels`); tests can also build one directly to stand in for a
 * workbench-restored panel handed to `Preview.adopt()` — the extension never created
 * that panel, so it is deliberately NOT recorded in `state.panels`.
 */
export function createFakePanel(
  viewType = 'jpnov.preview',
  title = '',
  opts?: unknown,
): FakeWebviewPanel {
  const disposeEmitter = new EventEmitter<void>();
  const viewStateEmitter = new EventEmitter<{ webviewPanel: FakeWebviewPanel }>();
  return {
    viewType,
    title,
    webview: makeFakeWebview(opts),
    viewColumn: undefined,
    revealed: [],
    disposed: false,
    visible: true,
    setVisible(visible: boolean) {
      this.visible = visible;
      viewStateEmitter.fire({ webviewPanel: this });
    },
    reveal(column?: number, preserveFocus?: boolean) {
      this.revealed.push({ column, preserveFocus });
    },
    dispose() {
      this.disposed = true;
      disposeEmitter.fire();
    },
    onDidDispose: disposeEmitter.event,
    onDidChangeViewState: viewStateEmitter.event,
  };
}

export interface FakeWebviewView {
  webview: FakeWebview;
  onDidDispose(listener: Listener<void>): Disposable;
  dispose(): void;
}

/** A fake sidebar WebviewView handed to `BooksViewProvider.resolveWebviewView`. */
export function createFakeWebviewView(): FakeWebviewView {
  const disposeEmitter = new EventEmitter<void>();
  return {
    webview: makeFakeWebview(),
    onDidDispose: disposeEmitter.event,
    dispose() {
      disposeEmitter.fire();
    },
  };
}
