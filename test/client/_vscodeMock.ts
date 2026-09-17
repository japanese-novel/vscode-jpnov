/**
 * A minimal in-memory `vscode` stand-in for client unit tests under `node --test`.
 *
 * The real `vscode` module only exists inside the extension host, so these tests run
 * against this stub installed via `mock.module('vscode', ...)` (Node's
 * `--experimental-test-module-mocks`). It implements ONLY the surface the client
 * modules touch; anything else is intentionally absent so accidental new dependencies
 * fail loudly.
 *
 * Suites using this mock run in CI via `npm run test:integration`; for direct runs see
 * test/client/README.md.
 */

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

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path.replace(/\/+$/, ''), ...segments].join('/');
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

  static FileExists(uri?: Uri | string): FileSystemError {
    return new FileSystemError('FileExists', uri === undefined ? undefined : String(uri));
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

export class ThemeColor {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class MarkdownString {
  value = '';
  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }
}

export const ViewColumn = { One: 1, Two: 2, Three: 3, Beside: -2 } as const;
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;

export interface FakeTextDocument {
  uri: Uri;
  languageId: string;
  /** `TextDocument.version` (the panel's row verbs echo it); `doc()` starts at 1 and `applyEdit` leaves it alone. */
  version: number;
  /** `TextDocument.encoding` ('utf8', 'shiftjis', …); `doc()` defaults it to 'utf8'. */
  encoding?: string;
  getText(): string;
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
  active: { line: number };
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

export interface FakeWebviewPanel {
  viewType: string;
  title: string;
  webview: FakeWebview;
  disposed: boolean;
  reveal(): void;
  dispose(): void;
  onDidDispose(listener: Listener<void>): Disposable;
}

/** Mutable test harness backing the mocked `vscode` namespace. */
/** The InputBoxOptions fields the extension's prompts set, typed once for assertions. */
export interface RecordedInputBox {
  prompt?: string;
  value?: string;
  valueSelection?: [number, number];
  ignoreFocusOut?: boolean;
  placeHolder?: string;
  validateInput?: (value: string) => string | null | Promise<string | null>;
}

export interface MockState {
  textDocuments: FakeTextDocument[];
  panels: FakeWebviewPanel[];
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  /** `commands.executeCommand` invocations, so tests can assert dispatched jpbook.* / vscode.open. */
  executedCommands: { command: string; args: unknown[] }[];
  /** WebviewView providers registered via `window.registerWebviewViewProvider`, keyed by view id. */
  registeredViewProviders: Map<string, unknown>;
  writtenFiles: { uri: string; content: string }[];
  /**
   * Replaces from `workspace.applyEdit` (range as [startLine, startChar, endLine, endChar]).
   * Recorded only — document text never mutates, so multi-step flows must reseed their docs.
   */
  appliedEdits: { uri: string; range: [number, number, number, number]; newText: string }[];
  onDidChangeDoc: EventEmitter<{ document: FakeTextDocument }>;
  onDidChangeActiveEditor: EventEmitter<{ document: FakeTextDocument } | undefined>;
  activeEditor: { document: FakeTextDocument; viewColumn?: number } | undefined;
  /** Editors the preview's cursor-follow consults via `window.visibleTextEditors`. */
  visibleEditors: FakeTextEditor[];
  onDidChangeSelection: EventEmitter<FakeSelectionChange>;
  /** Programmed `showQuickPick` responses (FIFO; undefined = Esc/cancel). */
  quickPickQueue: unknown[];
  quickPickCalls: { items: unknown; options: unknown }[];
  inputBoxQueue: (string | undefined)[];
  inputBoxCalls: { options: RecordedInputBox | undefined }[];
  /** Folders the init command may scaffold into; undefined = no folder open. */
  workspaceFolders: { uri: Uri; name: string; index: number }[] | undefined;
  workspaceFolderPickResult: { uri: Uri } | undefined;
  /** Uris `workspace.openTextDocument` must reject (simulates deleted/unloadable files). */
  unopenableDocs: Set<string>;
  /** In-memory filesystem the init guard probes: uri string → FileType. */
  fsEntries: Map<string, number>;
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
  /** `workspace.fs.readDirectory` responses: uri string → entries, or 'error' to reject. */
  readDirectoryResults: Map<string, [string, number][] | 'error'>;
  /** `workspace.findFiles` responses: base folder uri string → matches ([] when absent), or 'error'. */
  findFilesResults: Map<string, Uri[] | 'error'>;
  /** Recorded findFiles invocations, so tests can assert the deep search was (not) consulted. */
  findFilesCalls: { include: RelativePattern; maxResults: number | undefined }[];
  createdDirs: string[];
  openedDocs: string[];
  errorMessages: string[];
  infoMessages: string[];
  /** `env.openExternal` targets (uri strings), e.g. the post-build output-folder opens. */
  openedExternal: string[];
  /** `withProgress` options seen, one per call (so tests can assert `cancellable`). */
  progressOptions: unknown[];
  /** Pre-set to true to hand the progress task an already-cancelled token. The mock token
   *  reports this flag only — its `onCancellationRequested` never fires mid-task. */
  progressCancelled: boolean;
}

export function createMockState(): MockState {
  return {
    textDocuments: [],
    panels: [],
    registeredCommands: new Map(),
    executedCommands: [],
    registeredViewProviders: new Map(),
    writtenFiles: [],
    appliedEdits: [],
    onDidChangeDoc: new EventEmitter<{ document: FakeTextDocument }>(),
    onDidChangeActiveEditor: new EventEmitter<
      { document: FakeTextDocument } | undefined
    >(),
    activeEditor: undefined,
    visibleEditors: [],
    onDidChangeSelection: new EventEmitter<FakeSelectionChange>(),
    quickPickQueue: [],
    quickPickCalls: [],
    inputBoxQueue: [],
    inputBoxCalls: [],
    workspaceFolders: undefined,
    workspaceFolderPickResult: undefined,
    unopenableDocs: new Set<string>(),
    fsEntries: new Map<string, number>(),
    fsContent: new Map<string, string>(),
    fsBytes: new Map<string, Uint8Array>(),
    fsReadErrors: new Map<string, string>(),
    guessedEncoding: new Map<string, string>(),
    decodeCalls: [],
    config: {},
    scopedConfig: new Map<string, unknown>(),
    inspectResults: new Map(),
    readDirectoryResults: new Map<string, [string, number][] | 'error'>(),
    findFilesResults: new Map<string, Uri[] | 'error'>(),
    findFilesCalls: [],
    createdDirs: [],
    openedDocs: [],
    errorMessages: [],
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
  s.registeredViewProviders.clear();
  s.writtenFiles.length = 0;
  s.appliedEdits.length = 0;
  s.activeEditor = undefined;
  s.visibleEditors.length = 0;
  s.onDidChangeSelection.dispose();
  s.onDidChangeDoc.dispose();
  s.onDidChangeActiveEditor.dispose();
  s.quickPickQueue.length = 0;
  s.quickPickCalls.length = 0;
  s.inputBoxQueue.length = 0;
  s.inputBoxCalls.length = 0;
  s.workspaceFolders = undefined;
  s.workspaceFolderPickResult = undefined;
  s.unopenableDocs.clear();
  s.fsEntries.clear();
  s.fsContent.clear();
  s.fsBytes.clear();
  s.fsReadErrors.clear();
  s.guessedEncoding.clear();
  s.decodeCalls.length = 0;
  s.config = {};
  s.scopedConfig.clear();
  s.inspectResults.clear();
  s.readDirectoryResults.clear();
  s.findFilesResults.clear();
  s.findFilesCalls.length = 0;
  s.createdDirs.length = 0;
  s.openedDocs.length = 0;
  s.errorMessages.length = 0;
  s.infoMessages.length = 0;
  s.openedExternal.length = 0;
  s.progressOptions.length = 0;
  s.progressCancelled = false;
}

/** VS Code encoding ids → WHATWG decoder labels, for the ids the tests use. */
const DECODER_LABELS: Readonly<Partial<Record<string, string>>> = { utf8: 'utf-8', shiftjis: 'shift_jis' };

/**
 * Build a `vscode`-shaped namespace object bound to `state`. Pass this to
 * `mock.module('vscode', { defaultExport: ..., namedExports: ... })` — but because the
 * client does `import * as vscode`, install it as the default+namespace via the
 * `namedExports` returned here.
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
    registerWebviewViewProvider(viewId: string, provider: unknown): Disposable {
      state.registeredViewProviders.set(viewId, provider);
      return new Disposable(() => state.registeredViewProviders.delete(viewId));
    },
    showErrorMessage(...args: unknown[]): Promise<undefined> {
      if (typeof args[0] === 'string') {
        state.errorMessages.push(args[0]);
      }
      return Promise.resolve(undefined);
    },
    showInformationMessage(...args: unknown[]): Promise<undefined> {
      if (typeof args[0] === 'string') {
        state.infoMessages.push(args[0]);
      }
      return Promise.resolve(undefined);
    },
    showQuickPick(items: unknown, options?: unknown): Promise<unknown> {
      state.quickPickCalls.push({ items, options });
      return Promise.resolve(state.quickPickQueue.shift());
    },
    showInputBox(options?: RecordedInputBox): Promise<string | undefined> {
      state.inputBoxCalls.push({ options });
      return Promise.resolve(state.inputBoxQueue.shift());
    },
    showWorkspaceFolderPick(options?: unknown): Promise<{ uri: Uri } | undefined> {
      void options;
      return Promise.resolve(state.workspaceFolderPickResult);
    },
    showTextDocument(document: unknown): Promise<unknown> {
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
    stat(uri: Uri): Promise<{ type: number }> {
      const type = state.fsEntries.get(uri.toString());
      if (type === undefined) {
        return Promise.reject(FileSystemError.FileNotFound(uri));
      }
      return Promise.resolve({ type });
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
    createFileSystemWatcher(): {
      onDidCreate: (l: Listener<Uri>) => Disposable;
      onDidDelete: (l: Listener<Uri>) => Disposable;
      onDidChange: (l: Listener<Uri>) => Disposable;
      dispose(): void;
    } {
      // The Books provider only needs a disposable-returning watcher; tests drive refresh() directly.
      const on = (listener: Listener<Uri>): Disposable => {
        void listener;
        return new Disposable(() => { /* no-op */ });
      };
      return { onDidCreate: on, onDidDelete: on, onDidChange: on, dispose() { /* no-op */ } };
    },
    onDidChangeTextDocument: state.onDidChangeDoc.event,
    // File-operation events (Explorer gestures): registration-only, like the watcher above.
    onDidCreateFiles(listener: Listener<unknown>): Disposable {
      void listener;
      return new Disposable(() => { /* no-op */ });
    },
    onDidDeleteFiles(listener: Listener<unknown>): Disposable {
      void listener;
      return new Disposable(() => { /* no-op */ });
    },
    // Settings reads. Bare getConfiguration() + full keys (renderConfig.ts) resolves from
    // `state.config` as before; the section/scope form (highlightConfig.ts, probe.ts)
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
      return Promise.resolve(true);
    },
    // Single-folder parity: strip the containing folder's prefix; a uri outside every
    // folder comes back unshortened.
    asRelativePath(uri: Uri): string {
      const s = uri.toString();
      for (const folder of state.workspaceFolders ?? []) {
        const base = `${folder.uri.toString().replace(/\/+$/, '')}/`;
        if (s.startsWith(base)) {
          return s.slice(base.length);
        }
      }
      return uri.fsPath;
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
      include: RelativePattern,
      _exclude?: string | null,
      maxResults?: number,
    ): Promise<Uri[]> {
      state.findFilesCalls.push({ include, maxResults });
      const base = include.base;
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

  return {
    window,
    workspace,
    commands,
    l10n,
    env: {
      language: 'en',
      openExternal(target: { toString(): string }): Promise<boolean> {
        state.openedExternal.push(String(target));
        return Promise.resolve(true);
      },
    },
    Uri,
    FileType,
    FileSystemError,
    RelativePattern,
    Range,
    WorkspaceEdit,
    ThemeColor,
    MarkdownString,
    Disposable,
    EventEmitter,
    ViewColumn,
    ProgressLocation,
  };
}

export function doc(uri: string, languageId: string, text = '', encoding = 'utf8'): FakeTextDocument {
  return { uri: Uri.parse(uri), languageId, version: 1, encoding, getText: () => text, save: () => Promise.resolve(true) };
}

/** A fake `vscode.Webview`: captures outbound `postMessage` (posted) + delivers inbound (receive). */
export function makeFakeWebview(options?: unknown): FakeWebview {
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
  return {
    viewType,
    title,
    webview: makeFakeWebview(opts),
    disposed: false,
    reveal() {
      /* no-op */
    },
    dispose() {
      this.disposed = true;
      disposeEmitter.fire();
    },
    onDidDispose: disposeEmitter.event,
  };
}

export interface FakeWebviewView {
  webview: FakeWebview;
  visible: boolean;
  onDidDispose(listener: Listener<void>): Disposable;
  onDidChangeVisibility(listener: Listener<void>): Disposable;
  dispose(): void;
}

/** A fake sidebar WebviewView handed to `BooksViewProvider.resolveWebviewView`. */
export function createFakeWebviewView(): FakeWebviewView {
  const disposeEmitter = new EventEmitter<void>();
  const visEmitter = new EventEmitter<void>();
  return {
    webview: makeFakeWebview(),
    visible: true,
    onDidDispose: disposeEmitter.event,
    onDidChangeVisibility: visEmitter.event,
    dispose() {
      disposeEmitter.fire();
    },
  };
}
