/**
 * The entry module's server sync: once the server runs, the lint selection it holds is the
 * current one and the books have been listed (the listing is what gives it the narration
 * vocabulary) — also when a setting or a workspace folder changed while it was starting, and
 * after the restart that follows a crash. `activate()` runs against the vscode mock and a fake
 * LanguageClient the test steps through its states.
 *
 * Runs in CI via `npm run test:integration`; for direct runs see test/client/README.md.
 */
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { ErrorHandler, LanguageClientOptions } from 'vscode-languageclient/node';

import { LintConfigChangedNotification, ListBooksRequest, RenderFileRequest, type RenderFileParams } from '../../src/shared/protocol.ts';
import {
  buildVscode,
  createMockState,
  doc,
  editorAt,
  EventEmitter,
  registrationOnly,
  resetMockState,
  tick,
  Uri,
} from './_vscodeMock.ts';

const state = createMockState();
mock.module('vscode', { namedExports: buildVscode(state) });

/** vscode-languageclient's public `State`, `CloseAction` and `ErrorAction`. */
const State = { Stopped: 1, Running: 2, Starting: 3, StartFailed: 4 } as const;
type StateValue = (typeof State)[keyof typeof State];
const CloseAction = { DoNotRestart: 1, Restart: 2 } as const;
const ErrorAction = { Continue: 1, Shutdown: 2 } as const;

/** What the library's default error handler answers; the entry module delegates to it once the server ran. */
const DEFAULT_ERROR = { action: ErrorAction.Continue, message: 'the default policy' };
const DEFAULT_CLOSED = { action: CloseAction.Restart, message: 'the default policy' };

/** The client options the entry module passes: the library's, with the members these tests read made required. */
type ClientOptions = Omit<LanguageClientOptions, 'initializationOptions' | 'errorHandler' | 'initializationFailedHandler'> & {
  initializationOptions: Snapshots;
  errorHandler: ErrorHandler;
  initializationFailedHandler: NonNullable<LanguageClientOptions['initializationFailedHandler']>;
};

const RENDER_HTML = '<html><head></head><body>本文</body></html>';

/** The snapshot: `initializationOptions` carries it, its notification replaces it. */
interface Snapshots {
  lintConfig?: unknown;
}

/** The server's handlers: the snapshot each notification replaces. */
const HANDLERS: Readonly<Record<string, keyof Snapshots>> = {
  [LintConfigChangedNotification]: 'lintConfig',
};

/** `holds` models the server process: the seed of its latest start, replaced by each notification its handlers know. */
class FakeLanguageClient {
  static last: FakeLanguageClient | undefined;
  state: StateValue = State.Stopped;
  holds: Snapshots = {};
  /** Notification and request methods, in the order sent. */
  readonly sent: string[] = [];
  /** Every `jpnov/renderFile` request's params, in order. */
  readonly renders: RenderFileParams[] = [];
  /** Set: every render request rejects with it (a request a crash cut short, or made while the server was down). */
  renderError: Error | undefined;
  /** How often `stop()` was called. */
  stops = 0;
  readonly options: ClientOptions;
  readonly onNotification = registrationOnly;
  readonly onRequest = registrationOnly;
  private readonly seed: Snapshots;
  private readonly stateChanged = new EventEmitter<{ oldState: StateValue; newState: StateValue }>();
  readonly onDidChangeState = this.stateChanged.event;
  private starting: Promise<void> | undefined;
  private settle: () => void = () => undefined;

  constructor(
    _id: string,
    _name: string,
    _serverOptions: unknown,
    clientOptions: ClientOptions,
  ) {
    this.options = clientOptions;
    this.seed = clientOptions.initializationOptions;
    FakeLanguageClient.last = this;
  }

  /**
   * A new server process takes the seed, the same value on every start; Starting until `run()`.
   * Until the client stops, a second call returns the same start (pending or done), as the library does.
   */
  start(): Promise<void> {
    if (this.starting !== undefined) {
      return this.starting;
    }
    this.holds = structuredClone(this.seed);
    this.move(State.Starting);
    this.starting = new Promise((resolve) => {
      this.settle = resolve;
    });
    return this.starting;
  }

  createDefaultErrorHandler(): ErrorHandler {
    return { error: () => DEFAULT_ERROR, closed: () => DEFAULT_CLOSED };
  }

  /** The initialize reply: Running, then `start()` resolves — the library's order. */
  run(): void {
    this.move(State.Running);
    this.settle();
  }

  /** The server process dies and the library restarts it by itself: Stopped, then a new start. */
  crash(): void {
    this.halt();
    void this.start();
  }

  /** The library gave up restarting: Stopped for the rest of the session. */
  halt(): void {
    this.starting = undefined;
    this.move(State.Stopped);
  }

  stop(): Promise<void> {
    this.stops++;
    this.halt();
    return Promise.resolve();
  }

  sendNotification(type: string, params: Snapshots): Promise<void> {
    this.sent.push(type);
    const key = HANDLERS[type];
    if (key !== undefined) {
      this.holds[key] = params[key];
    }
    return Promise.resolve();
  }

  /** `jpnov/renderFile` answers a page (or fails on demand); the only other request is `jpnov/listBooks`. */
  sendRequest(type: string, params?: unknown): Promise<unknown> {
    this.sent.push(type);
    if (type === RenderFileRequest) {
      this.renders.push(params as RenderFileParams);
      return this.renderError === undefined ? Promise.resolve({ html: RENDER_HTML }) : Promise.reject(this.renderError);
    }
    return Promise.resolve({ books: [] });
  }

  private move(to: StateValue): void {
    const event = { oldState: this.state, newState: to };
    this.state = to;
    this.stateChanged.fire(event);
  }
}

mock.module('vscode-languageclient/node', {
  namedExports: {
    CloseAction,
    ErrorAction,
    LanguageClient: FakeLanguageClient,
    PrepareRenameRequest: { type: 'textDocument/prepareRename' },
    State,
    TransportKind: { ipc: 1 },
  },
});

const { activate, deactivate } = await import('../../src/client/extension.ts');

const A = 'file:///ws/a';
const B = 'file:///ws/b';
const C = 'file:///ws/c';
const LINT = 'jpnov.lint.common.questionExclamationMarks';

function folder(uri: string, index: number): { uri: Uri; name: string; index: number } {
  return { uri: Uri.parse(uri), name: `f${String(index)}`, index };
}

/** Fires the configuration event for `key`; a section matches the key itself or a dotted prefix of it, as in VS Code. */
function configChanged(key: string): void {
  state.onDidChangeConfig.fire({
    affectsConfiguration: (section) => key === section || key.startsWith(`${section}.`),
  });
}

const subscriptions: { dispose(): void }[] = [];

beforeEach(() => {
  resetMockState(state);
});

// The extension host's order: deactivate() first, then the subscriptions. deactivate() waits
// for a start still under way before it stops the client, so a test that left the server
// starting has it come up here.
afterEach(async () => {
  const client = FakeLanguageClient.last;
  FakeLanguageClient.last = undefined;
  const stopping = deactivate();
  for (const d of subscriptions.splice(0)) {
    d.dispose();
  }
  if (client?.state === State.Starting) {
    client.run();
  }
  await stopping;
});

/** Activates against whatever folders and documents the state holds. */
function activateHost(): void {
  state.config['jpnov.editor.autoIndent'] = false; // off: the mock has no `languages` namespace for its editor hooks
  activate({
    subscriptions,
    asAbsolutePath: (rel: string) => `/ext/${rel}`,
    extensionUri: Uri.parse('file:///ext'),
  } as never);
}

/** Activates with two folders and a novel document already open, which starts the server at once. */
function start(): FakeLanguageClient {
  state.workspaceFolders = [folder(A, 0), folder(B, 1)];
  state.textDocuments.push(doc(`${A}/one.jpnov`, 'jpnov'));
  activateHost();
  const client = FakeLanguageClient.last;
  assert.ok(client);
  return client;
}

interface Change {
  name: string;
  /** Changes a setting or the folders, then fires the event VS Code would fire. */
  apply(): void;
  /** What the server must hold afterwards. */
  holds: Snapshots;
  /** True when the change re-lists the books (the folders decide which books there are). */
  lists?: true;
}

const CHANGES: readonly Change[] = [
  {
    name: 'a jpnov.lint.* setting',
    apply() {
      state.config[LINT] = 'tcy';
      configChanged(LINT);
    },
    holds: { lintConfig: { [LINT]: 'tcy' } },
  },
  {
    name: 'an added folder',
    apply() {
      const added = folder(C, 2);
      state.workspaceFolders?.push(added);
      state.onDidChangeFolders.fire({ added: [added], removed: [] });
    },
    holds: { lintConfig: {} },
    lists: true,
  },
  {
    name: 'a removed folder',
    apply() {
      const removed = state.workspaceFolders?.splice(1) ?? [];
      state.onDidChangeFolders.fire({ added: [], removed });
    },
    holds: { lintConfig: {} },
    lists: true,
  },
];

interface Moment {
  name: string;
  /** Takes a started client to Running, applying `change` at this moment of its life. */
  play(client: FakeLanguageClient, change: Change): void;
  /** How often the server comes up, and whether the change lands while it runs. */
  starts: number;
  whileRunning: boolean;
}

const MOMENTS: readonly Moment[] = [
  {
    name: 'a change while the server starts reaches it once it runs (#84)',
    play(client, change) {
      change.apply();
      client.run();
    },
    starts: 1,
    whileRunning: false,
  },
  {
    name: 'a change while the server runs reaches it at once',
    play(client, change) {
      client.run();
      change.apply();
    },
    starts: 1,
    whileRunning: true,
  },
  {
    name: 'a change made while the server runs survives its crash and restart (#84)',
    play(client, change) {
      client.run();
      change.apply();
      client.crash();
      client.run();
    },
    starts: 2,
    whileRunning: true,
  },
  {
    name: 'a change while the server restarts after a crash reaches it once it runs (#84)',
    play(client, change) {
      client.run();
      client.crash();
      change.apply();
      client.run();
    },
    starts: 2,
    whileRunning: false,
  },
];

for (const moment of MOMENTS) {
  for (const change of CHANGES) {
    test(`${moment.name}: ${change.name}`, () => {
      const client = start();
      moment.play(client, change);
      assert.deepEqual(client.holds, change.holds);
      // Every start lists the books; a folder change while running lists them again.
      const listings = client.sent.filter((method) => method === ListBooksRequest).length;
      assert.equal(listings, moment.starts + (change.lists === true && moment.whileRunning ? 1 : 0));
    });
  }
}

test('each start sends the seeded snapshot once, then lists the books (the server reads their names from that)', () => {
  const client = start();
  client.run();
  assert.deepEqual(client.sent, [LintConfigChangedNotification, ListBooksRequest]);
  client.crash();
  client.run();
  assert.deepEqual(client.sent.slice(2), [LintConfigChangedNotification, ListBooksRequest]);
});

test('the lint and folder listeners send nothing while the server starts', () => {
  const client = start();
  for (const change of CHANGES) {
    change.apply();
  }
  assert.deepEqual(client.sent, []);
});

/** Starts with the novel document in an active editor and the preview open beside it (its first render requested). */
async function startWithPreview(): Promise<FakeLanguageClient> {
  state.workspaceFolders = [folder(A, 0)];
  const d = doc(`${A}/one.jpnov`, 'jpnov', '本文');
  state.textDocuments.push(d);
  state.activeEditor = editorAt(d);
  activateHost();
  const client = FakeLanguageClient.last;
  assert.ok(client);
  await state.registeredCommands.get('jpnov.previewToSide')?.();
  await tick();
  assert.equal(client.renders.length, 1);
  return client;
}

test('a layout change while the server starts re-renders the preview with the new value, and the start adds no render (#163)', async () => {
  const client = await startWithPreview();
  state.config['jpnov.layout.charsPerLine'] = 30;
  configChanged('jpnov.layout.charsPerLine');
  await tick();
  client.run();
  await tick();
  assert.equal(client.renders.length, 2);
  assert.equal(client.renders[1]?.settings.charsPerLine, 30);
});

test('a render that failed while the server was down is repainted once it runs (#163)', async () => {
  const client = await startWithPreview();
  client.run();
  await tick();
  const [panel] = state.panels;
  assert.ok(panel);

  client.crash();
  client.renderError = new Error('Pending response rejected since connection got disposed');
  configChanged('jpnov.layout.charsPerLine');
  await tick();
  assert.equal(client.renders.length, 2);
  assert.match(panel.webview.html, /Preview failed/);

  client.renderError = undefined;
  client.run();
  await tick();
  assert.equal(client.renders.length, 3);
  assert.doesNotMatch(panel.webview.html, /Preview failed/);
});

test('a crash before the server ran ends the start without a restart; afterwards the library policy decides (#163)', () => {
  const client = start();
  const { errorHandler, initializationFailedHandler } = client.options;
  assert.equal(initializationFailedHandler(new Error('x')), false);
  assert.deepEqual(errorHandler.closed(), { action: CloseAction.DoNotRestart, handled: true });
  client.run();
  assert.deepEqual(errorHandler.closed(), DEFAULT_CLOSED);
  assert.deepEqual(errorHandler.error(new Error('x'), undefined, 1), DEFAULT_ERROR);
});

test('deactivate() while the server starts waits for the start, then stops the client (#163)', async () => {
  const client = start();
  const stopping = deactivate();
  assert.equal(client.stops, 0);
  client.run();
  await stopping;
  assert.equal(client.stops, 1);
});

test('deactivate() stops a running client at once', async () => {
  const client = start();
  client.run();
  await deactivate();
  assert.equal(client.stops, 1);
});

test('deactivate() after the server is down for good stops nothing (the library rejects that too)', async () => {
  const client = start();
  client.run();
  client.halt();
  await deactivate();
  assert.equal(client.stops, 0);
});

test('nothing is sent once the server is down for good', () => {
  const client = start();
  client.run();
  const before = client.sent.length;
  client.halt();
  for (const change of CHANGES) {
    change.apply();
  }
  assert.deepEqual(client.sent.slice(before), []);
});

test('jpbook.open starts the server, then focuses the Books view (the walkthrough link, from a cold window)', async () => {
  state.workspaceFolders = [folder(A, 0)]; // no novel document, no project files: nothing started us
  activateHost();
  assert.equal(FakeLanguageClient.last, undefined);

  await state.registeredCommands.get('jpbook.open')?.();
  assert.ok(FakeLanguageClient.last, 'the command is a start trigger');
  const order = state.executedCommands
    .filter((c) => (c.command === 'setContext' && c.args[0] === 'jpnov.active') || c.command === 'jpnov.books.focus')
    .map((c) => c.command);
  assert.deepEqual(order, ['setContext', 'jpnov.books.focus'], 'the view is revealed before it is focused');
});
