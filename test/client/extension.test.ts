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

import { LintConfigChangedNotification, ListBooksRequest } from '../../src/shared/protocol.ts';
import {
  buildVscode,
  createMockState,
  doc,
  EventEmitter,
  registrationOnly,
  resetMockState,
  Uri,
} from './_vscodeMock.ts';

const state = createMockState();
mock.module('vscode', { namedExports: buildVscode(state) });

/** vscode-languageclient's public `State`. */
const State = { Stopped: 1, Running: 2, Starting: 3, StartFailed: 4 } as const;
type StateValue = (typeof State)[keyof typeof State];

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
  readonly onNotification = registrationOnly;
  readonly onRequest = registrationOnly;
  private readonly seed: Snapshots;
  private readonly stateChanged = new EventEmitter<{ oldState: StateValue; newState: StateValue }>();
  readonly onDidChangeState = this.stateChanged.event;
  private settle: () => void = () => undefined;

  constructor(
    _id: string,
    _name: string,
    _serverOptions: unknown,
    clientOptions: { initializationOptions: Snapshots },
  ) {
    this.seed = clientOptions.initializationOptions;
    FakeLanguageClient.last = this;
  }

  /** A new server process takes the seed, the same value on every start; Starting until `run()`. */
  start(): Promise<void> {
    this.holds = structuredClone(this.seed);
    this.move(State.Starting);
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  /** The initialize reply: Running, then `start()` resolves — the library's order. */
  run(): void {
    this.move(State.Running);
    this.settle();
  }

  /** The server process dies and the library restarts it by itself: Stopped, then a new start. */
  crash(): void {
    this.move(State.Stopped);
    void this.start();
  }

  /** The library gave up restarting: Stopped for the rest of the session. */
  halt(): void {
    this.move(State.Stopped);
  }

  stop(): Promise<void> {
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

  /** The only request these flows make is `jpnov/listBooks`. */
  sendRequest(type: string): Promise<unknown> {
    this.sent.push(type);
    return Promise.resolve({ books: [] });
  }

  private move(to: StateValue): void {
    const event = { oldState: this.state, newState: to };
    this.state = to;
    this.stateChanged.fire(event);
  }
}

mock.module('vscode-languageclient/node', {
  namedExports: { LanguageClient: FakeLanguageClient, PrepareRenameRequest: { type: 'textDocument/prepareRename' }, State, TransportKind: { ipc: 1 } },
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

// The extension host's order: deactivate() first, then the subscriptions.
afterEach(async () => {
  FakeLanguageClient.last = undefined;
  const stopping = deactivate();
  for (const d of subscriptions.splice(0)) {
    d.dispose();
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

test('the listeners send nothing while the server starts', () => {
  const client = start();
  for (const change of CHANGES) {
    change.apply();
  }
  assert.deepEqual(client.sent, []);
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
