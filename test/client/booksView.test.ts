/**
 * Integration test for the Books panel's WebviewView provider: the CSP-hardened shell it
 * resolves, the `state` / `detail` it pushes, and the messages it dispatches back to the
 * `jpbook.*` commands. We drive the provider against a fake LanguageClient and a fake
 * WebviewView, then assert on `webview.html`, `webview.posted`, and `state.executedCommands`.
 *
 * Runs in CI via `npm run test:integration`; for direct runs see test/client/README.md.
 */
import { test, mock, beforeEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { CancellationTokenSource } from 'vscode-languageserver/node';

import { META_DEFAULTS, META_KEYS } from '../../src/shared/book/jpbook.ts';
import { PROJECT_DEFAULT } from '../../src/shared/config/types.ts';
import { encodeTxt, type TxtEncoding } from '../../src/shared/encoding.ts';
import { HEAD, meta } from '../shared/book/_fixture.ts';
import { encodePathSegment } from '../../src/shared/utils/uri.ts';
import {
  buildVscode,
  createFakeWebviewView,
  createMockState,
  doc,
  resetMockState,
  tick,
  Uri,
  FileType,
} from './_vscodeMock.ts';

const state = createMockState();
mock.module('vscode', { exports: buildVscode(state) });

const { BooksViewProvider } = await import('../../src/client/book/view.ts');
const { raceRequest } = await import('../../src/client/requests.ts');
const { ListBooksRequest, BuildRequest, FixAllRequest, ProblemsRequest, BookCountsRequest } = await import('../../src/shared/protocol.ts');

/** A stand-in extension root (the provider asWebviewUri-serves the codicon assets under it). */
const EXT = Uri.parse('file:///ext');

beforeEach(() => {
  resetMockState(state);
});

/** A BookEntry with the fields the provider reads: the book sits in `src/` under its root. */
function entry(rootUri: string, rel: string, title?: string) {
  return { uri: `${rootUri}/src/${rel}.jpbook`, rootUri, fileRel: `src/${rel}.jpbook`, title };
}

/** A BookEntry for a `.jpbook` open under no workspace folder. */
function openEntry(uri: string, title?: string) {
  return { uri, rootUri: null, fileRel: uri.slice(uri.lastIndexOf('/') + 1), title };
}

/** What the fake server counts for every book unless a test sets `countsReply`. */
const COUNTS = { pages: 2, sheets: 3, chars: 45 };

/** What jpnov/problems and jpnov/fixAll answer for one chapter's text. */
interface ChapterServer {
  readonly problems?: (text: string) => unknown;
  readonly fixAll?: (text: string, only: unknown) => unknown;
}

/** A fake LanguageClient: answers listBooks with `books`, records the build params + token;
 *  `server` answers jpnov/problems and jpnov/fixAll from the text sent (both recorded); jpnov/bookCounts
 *  answers `countsReply` (an Error rejects) and records its params. */
function fakeClient(books: unknown[], buildResult?: unknown, server: ChapterServer = {}) {
  const calls: {
    build: { books?: string[]; format?: string } | null;
    buildToken: unknown;
    problems: { uri: string; text: string }[];
    fixAll: { uri: string; text: string; only?: unknown }[];
    counts: { uri: string; settings: unknown }[];
  } = { build: null, buildToken: undefined, problems: [], fixAll: [], counts: [] };
  const client = {
    calls,
    countsReply: { counts: COUNTS } as unknown,
    sendRequest(type: string, params: unknown, token?: unknown): Promise<unknown> {
      if (type === BookCountsRequest) {
        calls.counts.push(params as { uri: string; settings: unknown });
        return client.countsReply instanceof Error ? Promise.reject(client.countsReply) : Promise.resolve(client.countsReply);
      }
      if (type === ListBooksRequest) {
        return Promise.resolve({ books });
      }
      if (type === ProblemsRequest) {
        const p = params as { uri: string; text: string };
        calls.problems.push(p);
        const reply = server.problems === undefined ? { problems: [] } : server.problems(p.text);
        return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
      }
      if (type === FixAllRequest) {
        const p = params as { uri: string; text: string; only?: unknown };
        calls.fixAll.push(p);
        return Promise.resolve(server.fixAll === undefined ? { edits: [], fixed: 0 } : server.fixAll(p.text, p.only));
      }
      if (type === BuildRequest) {
        calls.build = params as { books?: string[]; format?: string };
        calls.buildToken = token;
        return Promise.resolve(buildResult ?? { ok: true, outDirs: [], artifacts: [], errors: [] });
      }
      return Promise.resolve({});
    },
  };
  return client;
}

type MsgList = { type?: string; [k: string]: unknown }[];

function posts(view: { webview: { posted: unknown[] } }): MsgList {
  return view.webview.posted as MsgList;
}
function lastState(view: { webview: { posted: unknown[] } }): { type?: string; [k: string]: unknown } {
  const all = posts(view).filter((m) => m.type === 'state');
  const st = all[all.length - 1];
  assert.ok(st, 'expected a state message');
  return st;
}
function firstDetail(view: { webview: { posted: unknown[] } }): { type?: string; [k: string]: unknown } {
  const d = posts(view).find((m) => m.type === 'detail');
  assert.ok(d, 'expected a detail message');
  return d;
}

/** Construct + refresh + resolve + ready. Sets one workspace folder when the first book has a root. */
async function setup(
  books: (ReturnType<typeof entry> | ReturnType<typeof openEntry>)[],
  buildResult?: unknown,
  server?: ChapterServer,
  select = true, // nothing is checked by default; the build tests need a selection
) {
  const client = fakeClient(books, buildResult, server);
  const provider = new BooksViewProvider(client as never, EXT as never);
  await provider.refresh(); // populate books, none checked
  const first = books[0];
  if (first?.rootUri != null) {
    state.workspaceFolders = [{ uri: Uri.parse(first.rootUri), name: 'ws', index: 0 }];
  }
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view as never);
  view.webview.receive({ type: 'ready' });
  await tick();
  if (select) {
    view.webview.receive({ type: 'selectAll' });
    await tick();
  }
  return { provider, view, client };
}

// --- shell / hardening ------------------------------------------------------

test('resolveWebviewView renders a CSP-hardened shell with the app root', () => {
  const provider = new BooksViewProvider(fakeClient([]) as never, EXT as never);
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view as never);
  const html = view.webview.html;
  assert.match(html, /<meta http-equiv="Content-Security-Policy"/i);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-[^']+'/);
  assert.match(html, /<div id="app">/);
  // The codicon stylesheet is linked (served from the extension's media/ via asWebviewUri).
  assert.match(html, /<link[^>]+codicon\.css[^>]+rel="stylesheet"/);
  const opts = view.webview.options as { enableScripts: boolean; localResourceRoots: readonly unknown[] };
  assert.equal(opts.enableScripts, true);
  assert.equal(opts.localResourceRoots.length, 1);
});

test('the inline style and script carry the CSP nonce', () => {
  const provider = new BooksViewProvider(fakeClient([]) as never, EXT as never);
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view as never);
  const html = view.webview.html;
  const styleNonce = /<style nonce="([^"]+)"/.exec(html);
  const scriptNonce = /<script nonce="([^"]+)"/.exec(html);
  const cspStyle = /style-src 'nonce-([^']+)'/.exec(html);
  const cspScript = /script-src 'nonce-([^']+)'/.exec(html);
  assert.ok(styleNonce && scriptNonce && cspStyle && cspScript);
  assert.equal(styleNonce[1], cspStyle[1]);
  assert.equal(scriptNonce[1], cspScript[1]);
});

// --- state ------------------------------------------------------------------

test('the ready handshake posts the book list, no book checked by default', async () => {
  const root = 'file:///ws';
  const { view } = await setup([entry(root, 'vol1', 'Volume One'), entry(root, 'part1/vol2')], undefined, undefined, false);
  const st = lastState(view);
  const groups = st.groups as { label: string | null; books: { title: string; fileRel: string; checked: boolean }[] }[];
  const books = groups.flatMap((g) => g.books);
  assert.equal(books.length, 2);
  assert.ok(books.every((b) => !b.checked));
  // single root -> flat (no section label); title falls back to the file name without `.jpbook`.
  const firstGroup = groups[0];
  assert.ok(firstGroup);
  assert.equal(firstGroup.label, null);
  const vol2 = books.find((b) => b.fileRel === 'src/part1/vol2.jpbook');
  assert.ok(vol2);
  assert.equal(vol2.title, 'vol2');
  assert.ok(books.find((b) => b.title === 'Volume One'));
});

test('multiple roots produce per-root labeled groups', async () => {
  const { view } = await setup([entry('file:///w1', 'x'), entry('file:///w2', 'y')]);
  const st = lastState(view);
  const groups = st.groups as { label: string | null }[];
  assert.deepEqual(groups.map((g) => g.label), ['w1', 'w2']);
});

test('books open under no folder form the last group, "Open files"; alone they are flat', async () => {
  const { view } = await setup([openEntry('file:///home/本.jpbook'), entry('file:///ws', 'x')]);
  const groups = lastState(view).groups as { label: string | null; books: { title: string }[] }[];
  assert.deepEqual(groups.map((g) => [g.label, g.books.map((b) => b.title)]), [['ws', ['x']], ['Open files', ['本']]]);

  const alone = await setup([openEntry('file:///home/本.jpbook', '作品名')]);
  const flat = lastState(alone.view).groups as { label: string | null; books: { title: string; fileRel: string }[] }[];
  assert.deepEqual(flat.map((g) => [g.label, g.books.map((b) => [b.title, b.fileRel])]), [[null, [['作品名', '本.jpbook']]]]);
});

test('the list and the build carry the open books (with the outDir resolved for each) beside the folders', async () => {
  state.scopedConfig.set('file:///home/本.jpbook|jpnov.layout.outDir', 'out');
  state.textDocuments.push(doc('file:///home/本.jpbook', 'jpbook', `${HEAD}title: 本\n---\n`));
  state.textDocuments.push(doc('file:///ws/src/x.jpbook', 'jpbook', `${HEAD}title: x\n---\n`)); // under the folder: not an open book
  state.textDocuments.push(doc('file:///home/memo.jpnov', 'jpnov', '')); // not a book
  const client = fakeClient([entry('file:///ws', 'x'), openEntry('file:///home/本.jpbook')]);
  const provider = new BooksViewProvider(client as never, EXT as never);
  state.workspaceFolders = [{ uri: Uri.parse('file:///ws'), name: 'ws', index: 0 }];
  const sent: unknown[] = [];
  const original = client.sendRequest.bind(client);
  client.sendRequest = (type: string, params: unknown, token?: unknown): Promise<unknown> => {
    sent.push(params);
    return original(type, params, token);
  };
  await provider.refresh();
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view as never);
  view.webview.receive({ type: 'ready' });
  await tick();
  view.webview.receive({ type: 'selectAll' });
  await tick();
  view.webview.receive({ type: 'build', format: 'txt' });
  await tick();

  const expected = { projectDirs: { 'file:///ws': { outDir: PROJECT_DEFAULT.outDir } }, openBooks: [{ uri: 'file:///home/本.jpbook', outDir: 'out' }] };
  assert.deepEqual(sent[0], expected);
  const build = sent[1] as { projectDirs: unknown; openBooks: unknown };
  assert.deepEqual({ projectDirs: build.projectDirs, openBooks: build.openBooks }, expected);
});

test('opening, closing or saving a .jpbook outside every folder re-lists; one under a folder does not', async () => {
  const { client } = await setup([entry('file:///ws', 'x')]);
  let lists = 0;
  const original = client.sendRequest.bind(client);
  client.sendRequest = (type: string, params: unknown, token?: unknown): Promise<unknown> => {
    lists += type === ListBooksRequest ? 1 : 0;
    return original(type, params, token);
  };
  const outside = doc('file:///home/本.jpbook', 'jpbook', '');
  state.onDidOpenDoc.fire(outside);
  state.onDidCloseDoc.fire(outside);
  state.onDidSaveDoc.fire(outside);
  state.onDidOpenDoc.fire(doc('file:///ws/src/x.jpbook', 'jpbook', ''));
  state.onDidOpenDoc.fire(doc('file:///home/memo.jpnov', 'jpnov', ''));
  await tick();
  assert.equal(lists, 3);
});

test('state posted before the first enumeration is flagged loading', async () => {
  // Resolve + ready WITHOUT a prior refresh() (server still starting): the panel must show a
  // loading placeholder, not the misleading "no books yet" welcome.
  const provider = new BooksViewProvider(fakeClient([]) as never, EXT as never);
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view as never);
  view.webview.receive({ type: 'ready' });
  await tick();
  assert.equal(lastState(view).loading, true);
});

test('a toggle updates the selection without re-posting state', async () => {
  const root = 'file:///ws';
  const { view } = await setup([entry(root, 'a'), entry(root, 'b')]);
  const before = posts(view).filter((m) => m.type === 'state').length;
  view.webview.receive({ type: 'toggle', uri: `${root}/src/b.jpbook`, checked: false });
  await tick();
  const after = posts(view).filter((m) => m.type === 'state').length;
  assert.equal(after, before, 'a per-row toggle does not echo state (keeps focus)');
});

test('selectAll / deselectAll re-post the full selection', async () => {
  const root = 'file:///ws';
  const { view } = await setup([entry(root, 'a'), entry(root, 'b')]);
  view.webview.receive({ type: 'selectAll' });
  await tick();
  const all = lastState(view).groups as { books: { checked: boolean }[] }[];
  assert.ok(all.flatMap((g) => g.books).every((b) => b.checked));
  view.webview.receive({ type: 'deselectAll' });
  await tick();
  const cleared = lastState(view).groups as { books: { checked: boolean }[] }[];
  assert.ok(cleared.flatMap((g) => g.books).every((b) => !b.checked));
});

// --- build ------------------------------------------------------------------

test('build sends only the checked books, in the chosen format', async () => {
  const root = 'file:///ws';
  const { view, client } = await setup([entry(root, 'a'), entry(root, 'b')]);
  view.webview.receive({ type: 'toggle', uri: `${root}/src/b.jpbook`, checked: false });
  await tick();
  view.webview.receive({ type: 'build', format: 'txt' });
  await tick();
  assert.ok(client.calls.build);
  assert.deepEqual(client.calls.build.books, [`${root}/src/a.jpbook`]);
  assert.equal(client.calls.build.format, 'txt');
});

test('the retired html format is ignored: no request, no toast', async () => {
  const root = 'file:///ws';
  const { view, client } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'build', format: 'html' });
  await tick();
  assert.equal(client.calls.build, null);
  assert.equal(state.infoMessages.length, 0);
});

test('build with an empty selection nudges and sends no request', async () => {
  const root = 'file:///ws';
  const { view, client } = await setup([entry(root, 'a')], undefined, undefined, false);
  view.webview.receive({ type: 'build', format: 'txt' });
  await tick();
  assert.equal(client.calls.build, null);
  assert.ok(state.infoMessages.some((m) => /no books selected/i.test(m)));
});

test('a build carrying a uri sends exactly that book and leaves the selection untouched', async () => {
  const root = 'file:///ws';
  const { view, client } = await setup([entry(root, 'a'), entry(root, 'b')], undefined, undefined, false);
  view.webview.receive({ type: 'build', format: 'epub', uri: `${root}/src/a.jpbook` });
  await tick();
  assert.ok(client.calls.build, 'fires despite the empty selection');
  assert.deepEqual(client.calls.build.books, [`${root}/src/a.jpbook`]);
  assert.equal(client.calls.build.format, 'epub');
  // A later selection-driven build still sees the empty checked set: the uri build didn't add to it.
  client.calls.build = null;
  view.webview.receive({ type: 'build', format: 'txt' });
  await tick();
  assert.equal(client.calls.build, null);
  assert.ok(state.infoMessages.some((m) => /no books selected/i.test(m)));
});

test('a uri build for a vanished book is dropped silently', async () => {
  const root = 'file:///ws';
  const { view, client } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'build', format: 'txt', uri: `${root}/src/ghost.jpbook` });
  await tick();
  assert.equal(client.calls.build, null);
  assert.equal(state.infoMessages.length, 0);
  assert.equal(state.errorMessages.length, 0);
});

test('build runs under a cancellable progress and hands its token to the wire', async () => {
  const root = 'file:///ws';
  const { view, client } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'build', format: 'txt' });
  await tick();
  const opts = state.progressOptions[0] as { cancellable?: boolean } | undefined;
  assert.equal(opts?.cancellable, true);
  assert.ok(client.calls.buildToken !== undefined, 'sendRequest must receive the progress token');
});

test('a cancelled build stays silent: no failure toast, nothing written, nothing opened', async () => {
  const root = 'file:///ws';
  const artifact = { kind: 'html', path: `${root}/dist/a.html`, content: '<p>x</p>' };
  const { view, client } = await setup(
    [entry(root, 'a')],
    { ok: true, outDirs: [`${root}/dist`], artifacts: [artifact], errors: [] },
  );
  state.progressCancelled = true;
  view.webview.receive({ type: 'build', format: 'print' });
  await tick();
  assert.ok(client.calls.build, 'the request went out before the cancel took effect');
  assert.equal(state.errorMessages.length, 0);
  assert.equal(state.writtenFiles.length, 0);
  assert.equal(state.openedExternal.length, 0);
});

test('a successful build opens the configured output dir, once — never a nested subfolder', async () => {
  const root = 'file:///ws';
  const { view } = await setup([entry(root, 'a'), entry(root, 'sub/b')], {
    ok: true,
    // One dir for both books — the nested book's file sits below it; the server sends it once.
    outDirs: [`${root}/out`],
    artifacts: [
      { kind: 'txt', path: `${root}/out/a.txt`, content: 'a' },
      { kind: 'txt', path: `${root}/out/sub/b.txt`, content: 'b' },
    ],
    errors: [],
  });
  view.webview.receive({ type: 'build', format: 'txt' });
  await tick();
  assert.deepEqual(state.openedExternal, [`${root}/out`]);
});

/** The `jpnov.layout.txt.encoding` setting as written and the encoding the text is written with: an off-list value is the default. */
const TXT_ENCODING_SETTINGS: readonly [unknown, TxtEncoding][] = [
  [undefined, 'shiftJis'],
  ['utf8', 'utf8'],
  ['utf16', 'shiftJis'],
];

for (const [setting, encoding] of TXT_ENCODING_SETTINGS) {
  test(`a txt build writes the text in the encoding the setting ${JSON.stringify(setting)} names, else the default`, async () => {
    const root = 'file:///ws';
    const { view } = await setup([entry(root, 'a')], {
      ok: true,
      outDirs: [`${root}/out`],
      artifacts: [{ kind: 'txt', path: `${root}/out/a.txt`, content: 'あ' }],
      errors: [],
    });
    if (setting !== undefined) {
      state.config['jpnov.layout.txt.encoding'] = setting; // absent = not set, as VS Code reports it
    }
    view.webview.receive({ type: 'build', format: 'txt' });
    await tick();
    // The mock keeps writes as UTF-8-decoded text, which still tells the two encodings apart.
    const expected = Buffer.from(encodeTxt('あ', encoding).bytes).toString('utf8');
    assert.deepEqual(state.writtenFiles.map((w) => [w.uri, w.content]), [[`${root}/out/a.txt`, expected]]);
  });
}

test('print asks the wire for html, writes it, and opens the FILES in the browser — not the folder', async () => {
  const root = 'file:///ws';
  const { view, client } = await setup(
    [entry(root, 'a'), entry(root, 'sub/b')],
    {
      ok: true,
      outDirs: [`${root}/out`],
      artifacts: [
        { kind: 'html', path: `${root}/out/a.html`, content: '<p>a</p>' },
        { kind: 'html', path: `${root}/out/sub/b.html`, content: '<p>b</p>' },
      ],
      errors: [],
    },
  );
  view.webview.receive({ type: 'build', format: 'print' });
  await tick();
  assert.ok(client.calls.build);
  assert.equal(client.calls.build.format, 'html'); // print is a client-side action; the wire stays html
  assert.deepEqual(state.writtenFiles.map((w) => w.uri), [`${root}/out/a.html`, `${root}/out/sub/b.html`]);
  // Every written artifact opens in the browser; the folder reveal stays quiet for print.
  assert.deepEqual(state.openedExternal, [`${root}/out/a.html`, `${root}/out/sub/b.html`]);
});

test('a successful build sets jpnov.hasBuilt (the walkthrough step completion); a cancelled one does not', async () => {
  const root = 'file:///ws';
  const result = {
    ok: true,
    outDirs: [`${root}/out`],
    artifacts: [{ kind: 'txt', path: `${root}/out/a.txt`, content: 'a' }],
    errors: [],
  };
  const hasBuilt = (): boolean =>
    state.executedCommands.some((c) => c.command === 'setContext' && c.args[0] === 'jpnov.hasBuilt' && c.args[1] === true);
  {
    const { view } = await setup([entry(root, 'a')], result);
    state.progressCancelled = true;
    view.webview.receive({ type: 'build', format: 'txt' });
    await tick();
    assert.equal(hasBuilt(), false);
  }
  state.progressCancelled = false;
  {
    const { view } = await setup([entry(root, 'a')], result);
    view.webview.receive({ type: 'build', format: 'txt' });
    await tick();
    assert.equal(hasBuilt(), true);
  }
});

test('the reveal-output toggle turns the reveal off; the toast still fires', async () => {
  const root = 'file:///ws';
  const { view } = await setup(
    [entry(root, 'a')],
    {
      ok: true,
      outDirs: [`${root}/out`],
      artifacts: [{ kind: 'txt', path: `${root}/out/a.txt`, content: 'a' }],
      errors: [],
    },
  );
  view.webview.receive({ type: 'revealOutput', on: false });
  view.webview.receive({ type: 'build', format: 'txt' });
  await tick();
  assert.ok(state.infoMessages.some((m) => m.includes('built 1')), 'the success toast still fires');
  assert.equal(state.openedExternal.length, 0);
});

test('state pushes mirror the reveal-output toggle (default on)', async () => {
  const { view } = await setup([entry('file:///ws', 'a')]);
  assert.equal(lastState(view).revealOutput, true);
  view.webview.receive({ type: 'revealOutput', on: false });
  view.webview.receive({ type: 'selectAll' }); // any state-pushing action
  await tick();
  assert.equal(lastState(view).revealOutput, false);
});

// --- build failure hand-off -------------------------------------------------

/** The reveal-flagged detail posts — the only pushes the webview's list screen adopts. */
function revealedDetails(view: { webview: { posted: unknown[] } }): MsgList {
  return posts(view).filter((m) => m.type === 'detail' && m.reveal === true);
}

/** A per-book build error as the server reports it: `uri` is the panel's key, `book` the toast label. */
function bookError(root: string, outRel: string, missing: string) {
  return {
    book: `${outRel}.jpbook`,
    uri: `${root}/src/${outRel}.jpbook`,
    code: 'book.entryFileNotFound',
    args: [missing],
  };
}

test('a failed build toasts every error, then opens the FIRST failing book with reveal', async () => {
  const root = 'file:///ws';
  const aUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(aUri, 'jpbook', `${HEAD}---\ngone.jpnov\n`));
  const { view } = await setup([entry(root, 'a', 'A'), entry(root, 'b', 'B')], {
    ok: false,
    outDirs: [],
    artifacts: [],
    errors: [bookError(root, 'a', 'gone.jpnov'), bookError(root, 'b', 'lost.jpnov')],
  });
  view.webview.receive({ type: 'build', format: 'txt' });
  await tick();
  assert.equal(state.errorMessages.filter((m) => m.includes('build error for')).length, 2);
  assert.ok(state.executedCommands.some((c) => c.command === 'jpnov.books.focus'));
  assert.deepEqual(revealedDetails(view).map((m) => m.uri), [aUri]);
  assert.equal((view as { title?: string }).title, 'A');
  const ctx = state.executedCommands.filter((c) => c.command === 'setContext' && c.args[0] === 'jpnov.booksDetail');
  assert.equal(ctx.at(-1)?.args[1], true);
  assert.equal(state.infoMessages.length, 0); // no success toast
  assert.equal(state.openedExternal.length, 0);
});

test('`#`, `?` and `%` in an output path reach the OS percent-encoded, for the folder and for print', async () => {
  const root = 'file:///ws';
  const dir = `${root}/${encodePathSegment('出力#1')}`;
  const files = ['a#b', 'a?b', '100%'].map((name) => `${dir}/${encodePathSegment(name)}.html`);
  const cases = [
    { format: 'txt', opened: [dir] },
    { format: 'print', opened: files },
  ] as const;
  for (const { format, opened } of cases) {
    resetMockState(state);
    const { view } = await setup([entry(root, 'a')], {
      ok: true,
      outDirs: [dir],
      // The view writes whatever kind arrives; the paths are what this test is about.
      artifacts: files.map((path) => ({ kind: 'html', path, content: '<p>a</p>' })),
      errors: [],
    });
    view.webview.receive({ type: 'build', format });
    await tick();
    assert.deepEqual(state.openedExternal, opened);
  }
});

test('a partial batch keeps the success flow intact and still opens the failing book', async () => {
  const root = 'file:///ws';
  const bUri = `${root}/src/sub/b.jpbook`;
  state.textDocuments.push(doc(bUri, 'jpbook', `${HEAD}---\nsub/lost.jpnov\n`));
  const { view } = await setup([entry(root, 'a', 'A'), entry(root, 'sub/b', 'B')], {
    ok: false,
    outDirs: [`${root}/out`],
    artifacts: [{ kind: 'txt', path: `${root}/out/a.txt`, content: 'a' }],
    errors: [bookError(root, 'sub/b', 'sub/lost.jpnov')],
  });
  view.webview.receive({ type: 'build', format: 'txt' });
  await tick();
  assert.deepEqual(state.writtenFiles.map((w) => w.uri), [`${root}/out/a.txt`]);
  assert.ok(state.infoMessages.some((m) => m.includes('built 1')));
  assert.deepEqual(state.openedExternal, [`${root}/out`]);
  assert.equal(state.errorMessages.length, 1);
  assert.deepEqual(revealedDetails(view).map((m) => m.uri), [bUri]);
});

test('an error naming a book the list does not hold stays toast-only', async () => {
  const root = 'file:///ws';
  const { view } = await setup([entry(root, 'a', 'A')], {
    ok: false,
    outDirs: [],
    artifacts: [],
    errors: [{ book: 'gone.jpbook', uri: `${root}/gone.jpbook`, code: 'build.failed', args: ['boom'] }],
  });
  view.webview.receive({ type: 'build', format: 'txt' });
  await tick();
  assert.equal(state.errorMessages.length, 1);
  assert.ok(!state.executedCommands.some((c) => c.command === 'jpnov.books.focus'));
  assert.ok(!posts(view).some((m) => m.type === 'detail'));
});

test('a failure of the book already open re-posts its detail with reveal', async () => {
  const root = 'file:///ws';
  const aUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(aUri, 'jpbook', `${HEAD}---\ngone.jpnov\n`));
  const { view } = await setup([entry(root, 'a', 'A')], {
    ok: false,
    outDirs: [],
    artifacts: [],
    errors: [bookError(root, 'a', 'gone.jpnov')],
  });
  view.webview.receive({ type: 'openDetail', uri: aUri });
  await tick();
  view.webview.receive({ type: 'build', format: 'print', uri: aUri });
  await tick();
  const details = posts(view).filter((m) => m.type === 'detail');
  assert.equal(details.length, 2);
  const [own, handoff] = details;
  assert.ok(own);
  assert.ok(handoff);
  assert.equal(own.reveal, undefined); // the user's own open
  assert.equal(handoff.reveal, true); // the failed build's hand-off
  assert.equal(handoff.uri, aUri);
});

test('an error whose book is not listed is skipped in favour of the next one', async () => {
  const root = 'file:///ws';
  const bUri = `${root}/src/b.jpbook`;
  state.textDocuments.push(doc(bUri, 'jpbook', `${HEAD}---\nlost.jpnov\n`));
  const { view } = await setup([entry(root, 'a', 'A'), entry(root, 'b', 'B')], {
    ok: false,
    outDirs: [],
    artifacts: [],
    errors: [bookError(root, 'ghost', 'x.jpnov'), bookError(root, 'b', 'lost.jpnov')],
  });
  view.webview.receive({ type: 'build', format: 'txt' });
  await tick();
  assert.deepEqual(revealedDetails(view).map((m) => m.uri), [bUri]);
});

// --- detail -----------------------------------------------------------------

test('openDetail posts covers and chapters (missing flagged) and the metadata rows', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}title: A\ncover:\n  - 表紙.jpnov\n  - sub/ch2.jpnov\n---\nch1.jpnov\nsub/ch2.jpnov\n../up.jpnov\n`));
  // Entries count from the book's folder, `src/`: ch1 and ../up exist, ch2 does not.
  state.fsEntries.set('file:///ws/src/ch1.jpnov', FileType.File);
  state.fsEntries.set('file:///ws/up.jpnov', FileType.File);
  const { view } = await setup([entry(root, 'a', 'A')]);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  const detail = firstDetail(view) as {
    uri: string;
    title: string;
    version: number;
    chapters: { name: string; folder: string; missing: boolean; line: number; path: string; fileUri: string }[];
    covers: { name: string; folder: string; missing: boolean; line: number; path: string; fileUri: string }[];
    meta: { key: string; value: string; note: string }[];
  };
  assert.equal(detail.uri, bookUri);
  assert.equal(detail.version, 1); // the document version the rows were parsed from
  // Cover rows carry the item's path (marker stripped) and line; a file may sit in both lists.
  assert.deepEqual(
    detail.covers.map((c) => [c.line, c.path, c.folder, c.name, c.missing]),
    [[3, '表紙.jpnov', '', '表紙.jpnov', true], [4, 'sub/ch2.jpnov', 'sub', 'ch2.jpnov', true]],
  );
  assert.equal(detail.chapters.length, 3);
  const ch1 = detail.chapters.find((c) => c.name === 'ch1.jpnov');
  assert.ok(ch1);
  assert.equal(ch1.missing, false);
  assert.equal(ch1.fileUri, 'file:///ws/src/ch1.jpnov');
  const up = detail.chapters.find((c) => c.name === 'up.jpnov');
  assert.ok(up);
  assert.deepEqual([up.folder, up.fileUri, up.missing], ['..', 'file:///ws/up.jpnov', false]);
  const ch2 = detail.chapters.find((c) => c.name === 'ch2.jpnov');
  assert.ok(ch2);
  assert.equal(ch2.missing, true);
  assert.equal(ch2.folder, 'sub');
  assert.equal(ch2.line, 7);
  assert.equal(ch2.fileUri, 'file:///ws/src/sub/ch2.jpnov');
  assert.equal(ch2.path, 'sub/ch2.jpnov');
  assert.equal(detail.meta.length, META_KEYS.length);
  // A set value carries no status note; the note is separate from the value (rendered by the label).
  const titleRow = detail.meta.find((m) => m.key === 'title');
  assert.ok(titleRow);
  assert.equal(titleRow.value, 'A');
  assert.equal(titleRow.note, '');
  // An unwritten divider defaults to none: "(none)", the default being empty.
  const dividerRow = detail.meta.find((m) => m.key === 'divider');
  assert.ok(dividerRow);
  assert.equal(dividerRow.value, '');
  assert.equal(dividerRow.note, '(none)');
});

// --- the problems screen (jpbook.fixProblems) -----------------------------------------

/**
 * A book listing `listing` under file:///ws/src, its chapters registered as documents (`dirty` as
 * given, saves recorded in `saved`) and present on disk, opened to its detail. `server` answers
 * jpnov/problems and jpnov/fixAll from the text sent.
 */
async function openBookWithChapters(
  listing: string,
  chapters: { uri: string; text: string; dirty: boolean }[],
  server?: ChapterServer,
) {
  const bookUri = 'file:///ws/src/a.jpbook';
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}title: A\n---\n${listing}`));
  const saved: string[] = [];
  for (const ch of chapters) {
    state.fsEntries.set(ch.uri, FileType.File);
    const d = doc(ch.uri, 'jpnov', ch.text);
    d.isDirty = ch.dirty;
    d.save = () => {
      saved.push(ch.uri);
      return Promise.resolve(true);
    };
    state.textDocuments.push(d);
  }
  const { provider, view, client } = await setup([entry('file:///ws', 'a', 'A')], undefined, server);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  return { provider, view, client, saved, bookUri };
}

const R = (l1: number, c1: number, l2: number, c2: number) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });

/** One problem per chapter from its text: a fixable 縦中横 pair on line 0, plus an unfixable long sentence on line 1 when there is one. */
function problemsOf(text: string): unknown {
  const lines = text.split('\n');
  return {
    problems: [
      ...(lines.length > 2 ? [{ range: R(1, 0, 1, 3), severity: 'warning', message: { code: 'lint.common.sentenceLength', args: [3, 1] }, fixable: false }] : []),
      { range: R(0, 2, 0, 4), severity: 'warning', message: { code: 'lint.common.questionExclamationMarks.tcy', args: ['!?'] }, fixable: true },
    ],
  };
}

test('showProblems lists every listed chapter once with its problems in order of place, localized; a chapter without problems or missing is left out', async () => {
  // ch1 is listed twice (checked once), ch2 is missing on disk, up sits above the book's folder and
  // is not open (read from disk, and left closed), clean has nothing.
  const { provider, view, client } = await openBookWithChapters(
    'ch1.jpnov\nsub/ch2.jpnov\nch1.jpnov\n../up.jpnov\nclean.jpnov\n',
    [
      { uri: 'file:///ws/src/ch1.jpnov', text: 'なに!?\n長い文。\n', dirty: true },
      { uri: 'file:///ws/src/clean.jpnov', text: '本文。\n', dirty: false },
    ],
    { problems: (text) => (text === '本文。\n' ? { problems: [] } : problemsOf(text)) },
  );
  state.fsEntries.set('file:///ws/up.jpnov', FileType.File);
  state.fsContent.set('file:///ws/up.jpnov', 'だ!?\n');
  view.webview.receive({ type: 'openDetail', uri: 'file:///ws/src/a.jpbook' }); // re-stat with up present
  await tick();
  await provider.showProblems();
  // The chapters are checked at once, so the requests land in no fixed order; the list keeps the book's.
  assert.deepEqual(new Map(client.calls.problems.map((p) => [p.uri, p.text])), new Map([
    ['file:///ws/src/ch1.jpnov', 'なに!?\n長い文。\n'],
    ['file:///ws/up.jpnov', 'だ!?\n'],
    ['file:///ws/src/clean.jpnov', '本文。\n'],
  ]));
  assert.ok(!state.openedDocs.includes('file:///ws/up.jpnov'), 'listing opens no chapter');
  const msg = posts(view).find((m) => m.type === 'problems');
  assert.ok(msg);
  assert.equal(msg.uri, 'file:///ws/src/a.jpbook');
  const tcy = { range: R(0, 2, 0, 4), code: 'lint.common.questionExclamationMarks.tcy', severity: 'warning', message: 'add the 縦中横 annotation so !? sits in one square', where: 'Line 1', fixable: true };
  assert.deepEqual(msg.chapters, [
    {
      uri: 'file:///ws/src/ch1.jpnov', path: 'ch1.jpnov',
      problems: [tcy, { range: R(1, 0, 1, 3), code: 'lint.common.sentenceLength', severity: 'warning', message: 'this sentence is too long', where: 'Line 2', fixable: false }],
    },
    { uri: 'file:///ws/up.jpnov', path: '../up.jpnov', problems: [tcy] },
  ]);
  assert.equal((state.progressOptions[0] as { title?: string }).title, 'Japanese Novel: checking 3 chapter(s)…');
  assert.deepEqual(state.errorMessages, []);
  assert.deepEqual(state.infoMessages, []);
});

test('showProblems with nothing to list: a toast and no screen; a chapter that cannot be checked is toasted and skipped', async () => {
  const { provider, view, client } = await openBookWithChapters(
    'ch1.jpnov\nbad.jpnov\n',
    [
      { uri: 'file:///ws/src/ch1.jpnov', text: '本文。\n', dirty: false },
      { uri: 'file:///ws/src/bad.jpnov', text: 'x\n', dirty: false },
    ],
    { problems: (text) => (text === 'x\n' ? new Error('boom') : { problems: [] }) },
  );
  await provider.showProblems();
  assert.equal(client.calls.problems.length, 2);
  assert.equal(posts(view).find((m) => m.type === 'problems'), undefined);
  assert.deepEqual(state.errorMessages, ["Japanese Novel: couldn't check 1 chapter(s). boom"]);
  assert.deepEqual(state.infoMessages, ['Japanese Novel: no problems in this book.']);
});

test('showProblems does nothing without an open detail, and drops the list when the detail closed meanwhile', async () => {
  const { provider, client } = await setup([entry('file:///ws', 'a', 'A')]);
  await provider.showProblems();
  assert.equal(client.calls.problems.length, 0);
  assert.deepEqual(state.infoMessages, []);

  resetMockState(state);
  const opened = await openBookWithChapters('ch1.jpnov\n', [{ uri: 'file:///ws/src/ch1.jpnov', text: 'なに!?\n', dirty: false }], {
    problems: (text) => {
      opened.view.webview.receive({ type: 'closeDetail' }); // Back, while the server is at work
      return problemsOf(text);
    },
  });
  await opened.provider.showProblems();
  assert.equal(opened.client.calls.problems.length, 1);
  assert.equal(posts(opened.view).find((m) => m.type === 'problems'), undefined);
  assert.deepEqual(state.infoMessages, []);
});

test('fixProblems fixes the problems named, chapter by chapter: a dirty one stays unsaved, a clean one is saved, an unlisted chapter is skipped', async () => {
  const { view, client, saved, bookUri } = await openBookWithChapters(
    'ch1.jpnov\n../up.jpnov\n',
    [
      { uri: 'file:///ws/src/ch1.jpnov', text: 'なに!?\n', dirty: true },
      { uri: 'file:///ws/up.jpnov', text: 'だ!?\n', dirty: false },
      { uri: 'file:///ws/src/other.jpnov', text: 'ね!?\n', dirty: false },
    ],
    {
      // One edit and one fix per chapter, placed by the text the client sent (its live buffer).
      fixAll: (text, only) => ({
        edits: [{ range: R(0, 0, 0, text.length - 1), newText: text.trim() + '［＃「!?」は縦中横］' }],
        fixed: (only as unknown[]).length,
      }),
    },
  );
  const tcy = (chapter: string) => ({ chapter, range: R(0, 2, 0, 4), code: 'lint.common.questionExclamationMarks.tcy' });
  view.webview.receive({
    type: 'fixProblems',
    uri: bookUri,
    problems: [
      tcy('file:///ws/up.jpnov'),
      tcy('file:///ws/src/ch1.jpnov'),
      { chapter: 'file:///ws/src/ch1.jpnov', range: R(1, 0, 1, 1), code: 'lint.narration.indent' },
      tcy('file:///ws/src/other.jpnov'), // not a chapter of this book
    ],
  });
  await tick();
  // Chapters go in the book's order, each with its own refs.
  assert.deepEqual(client.calls.fixAll, [
    { uri: 'file:///ws/src/ch1.jpnov', text: 'なに!?\n', only: [{ range: R(0, 2, 0, 4), code: 'lint.common.questionExclamationMarks.tcy' }, { range: R(1, 0, 1, 1), code: 'lint.narration.indent' }] },
    { uri: 'file:///ws/up.jpnov', text: 'だ!?\n', only: [{ range: R(0, 2, 0, 4), code: 'lint.common.questionExclamationMarks.tcy' }] },
  ]);
  assert.deepEqual(state.appliedEdits, [
    { uri: 'file:///ws/src/ch1.jpnov', range: [0, 0, 0, 4], newText: 'なに!?［＃「!?」は縦中横］' },
    { uri: 'file:///ws/up.jpnov', range: [0, 0, 0, 3], newText: 'だ!?［＃「!?」は縦中横］' },
  ]);
  assert.deepEqual(saved, ['file:///ws/up.jpnov']); // the dirty ch1 keeps its fixes unsaved
  assert.deepEqual(state.errorMessages, []);
  assert.deepEqual(state.infoMessages, ['Japanese Novel: fixed 3 problem(s) in 2 chapter(s).']);
  assert.equal((state.progressOptions[0] as { title?: string }).title, 'Japanese Novel: fixing 2 chapter(s)…');
});

test('fixProblems with nothing fixed: no edit, no save, the "none fixed" toast; a refused edit is toasted and left out of the count', async () => {
  const { view, client, saved, bookUri } = await openBookWithChapters('ch1.jpnov\n', [
    { uri: 'file:///ws/src/ch1.jpnov', text: '本文。\n', dirty: false },
  ]);
  view.webview.receive({ type: 'fixProblems', uri: bookUri, problems: [{ chapter: 'file:///ws/src/ch1.jpnov', range: R(0, 0, 0, 1), code: 'lint.narration.indent' }] });
  await tick();
  assert.equal(client.calls.fixAll.length, 1);
  assert.deepEqual(state.appliedEdits, []);
  assert.deepEqual(saved, []);
  assert.deepEqual(state.infoMessages, ['Japanese Novel: none of the selected problems could be fixed; the text may have changed since they were listed.']);

  resetMockState(state);
  state.applyEditResult = false;
  const refused = await openBookWithChapters(
    'ch1.jpnov\n',
    [{ uri: 'file:///ws/src/ch1.jpnov', text: 'なに!?\n', dirty: false }],
    { fixAll: () => ({ edits: [{ range: R(0, 2, 0, 4), newText: '⁉' }], fixed: 1 }) },
  );
  refused.view.webview.receive({ type: 'fixProblems', uri: refused.bookUri, problems: [{ chapter: 'file:///ws/src/ch1.jpnov', range: R(0, 2, 0, 4), code: 'lint.common.questionExclamationMarks' }] });
  await tick();
  assert.deepEqual(refused.saved, []);
  assert.deepEqual(state.errorMessages, ["Japanese Novel: couldn't edit ch1.jpnov."]);
  assert.deepEqual(state.infoMessages, ['Japanese Novel: none of the selected problems could be fixed; the text may have changed since they were listed.']);
});

test('fixProblems ignores a verb for another book or with a malformed problem', async () => {
  const { view, client, bookUri } = await openBookWithChapters('ch1.jpnov\n', [
    { uri: 'file:///ws/src/ch1.jpnov', text: 'なに!?\n', dirty: false },
  ]);
  const ok = { chapter: 'file:///ws/src/ch1.jpnov', range: R(0, 2, 0, 4), code: 'lint.common.questionExclamationMarks' };
  view.webview.receive({ type: 'fixProblems', uri: 'file:///ws/src/b.jpbook', problems: [ok] });
  view.webview.receive({ type: 'fixProblems', uri: bookUri, problems: [ok, { chapter: 'file:///ws/src/ch1.jpnov', range: { start: { line: 0 } }, code: 'x' }] });
  view.webview.receive({ type: 'fixProblems', uri: bookUri, problems: 'all' });
  await tick();
  assert.equal(client.calls.fixAll.length, 0);
  assert.deepEqual(state.infoMessages, []);
});

test('openProblem shows a chapter of the open book at the problem; another file is ignored', async () => {
  const { view } = await openBookWithChapters('ch1.jpnov\n', [
    { uri: 'file:///ws/src/ch1.jpnov', text: 'なに!?\n', dirty: false },
  ]);
  view.webview.receive({ type: 'openProblem', uri: 'file:///ws/src/ch1.jpnov', range: R(0, 2, 0, 4) });
  view.webview.receive({ type: 'openProblem', uri: 'file:///ws/src/other.jpnov', range: R(0, 2, 0, 4) });
  view.webview.receive({ type: 'openProblem', uri: 'file:///ws/src/ch1.jpnov', range: { start: 2 } });
  view.webview.receive({ type: 'openProblem', uri: 'file:///ws/src/ch1.jpnov', range: R(-1, 0, 0, 1.5) });
  await tick();
  assert.deepEqual(state.shownDocuments, [{ uri: 'file:///ws/src/ch1.jpnov', selection: [0, 2, 0, 4] }]);
});

test('the metadata rows note an empty key (not set, hidden, none) and an unwritten one (its default)', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  const text = meta({ title: '', header: '', divider: '' }, ['author', 'headerAlign', 'footer']) + 'ch1.jpnov\n';
  state.textDocuments.push(doc(bookUri, 'jpbook', text));
  const { view } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  const detail = firstDetail(view) as { meta: { key: string; value: string; note: string }[] };
  const rows = new Map(detail.meta.map((m) => [m.key, [m.value, m.note]]));
  assert.deepEqual(rows.get('title'), ['', '(not set)']); // an empty title is an Error: no value
  assert.deepEqual(rows.get('author'), ['', '(not set)']);
  assert.deepEqual(rows.get('header'), ['', '(hidden)']);
  assert.deepEqual(rows.get('divider'), ['', '(none)']);
  // An unwritten key shows what its default does: the page numbers, a centred header.
  assert.deepEqual(rows.get('footer'), [META_DEFAULTS.footer, '(default)']);
  assert.deepEqual(rows.get('headerAlign'), ['Center', '(default)']);
  // An alignment row shows its own value, whatever its header or footer holds.
  assert.deepEqual(rows.get('footerAlign'), ['Right', '']);
});

// --- edit dispatch (reuses manage.ts via executeCommand) --------------------

test('editMeta dispatches jpbook.editMeta with the entry, key, and current value', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}header: My Header\n---\nch1.jpnov\n`));
  const { view } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'editMeta', uri: bookUri, metaKey: 'header' });
  await tick();
  const call = state.executedCommands.find((c) => c.command === 'jpbook.editMeta');
  assert.ok(call);
  const node = call.args[0] as { kind: string; metaKey: string; value: string; entry: { uri: string } };
  assert.equal(node.kind, 'meta');
  assert.equal(node.metaKey, 'header');
  assert.equal(node.value, 'My Header');
  assert.equal(node.entry.uri, bookUri);
});

test('an unknown metaKey is ignored (no dispatch)', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}---\nch1.jpnov\n`));
  const { view } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'editMeta', uri: bookUri, metaKey: 'bogus' });
  await tick();
  assert.equal(state.executedCommands.find((c) => c.command === 'jpbook.editMeta'), undefined);
});

/** The number of `detail` pushes so far — every row verb (remove / move / drop) is answered with one. */
function detailCount(view: { webview: { posted: unknown[] } }): number {
  return posts(view).filter((m) => m.type === 'detail').length;
}

/** Fires `event` under a mocked clock, runs every pending timer, then lets the real work settle (tick() is a real setTimeout). */
async function afterPause(t: TestContext, event: () => void): Promise<void> {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  event();
  t.mock.timers.runAll();
  t.mock.timers.reset();
  await tick();
}

test('entry actions dispatch the matching jpbook command naming the row, and re-push the detail', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}cover:\n  - x.jpnov\n---\ny.jpnov\n`));
  const { view } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  const before = detailCount(view);
  const row = { uri: bookUri, list: 'covers', line: 2, path: 'x.jpnov', version: 1 };
  view.webview.receive({ type: 'moveEntry', ...row, dir: -1 });
  view.webview.receive({ type: 'moveEntry', ...row, dir: 1 });
  view.webview.receive({ type: 'removeEntry', ...row });
  view.webview.receive({ type: 'addEntries', uri: bookUri, list: 'covers' });
  await tick();
  const cmds = state.executedCommands.map((c) => c.command);
  assert.ok(cmds.includes('jpbook.moveEntryUp'));
  assert.ok(cmds.includes('jpbook.moveEntryDown'));
  assert.ok(cmds.includes('jpbook.removeEntry'));
  assert.ok(cmds.includes('jpbook.addEntries'));
  const rm = state.executedCommands.find((c) => c.command === 'jpbook.removeEntry');
  assert.ok(rm);
  const node = rm.args[0] as {
    kind: string; list: string; line: number; path: string; version: number; entry: { uri: string };
  };
  assert.equal(node.kind, 'entry');
  assert.equal(node.list, 'covers');
  assert.equal(node.line, 2);
  assert.equal(node.path, 'x.jpnov');
  assert.equal(node.version, 1);
  assert.equal(node.entry.uri, bookUri);
  // The three row verbs — not the list verbs — were each answered with a detail re-push.
  assert.equal(detailCount(view), before + 3);
  const add = state.executedCommands.find((c) => c.command === 'jpbook.addEntries');
  assert.ok(add);
  const listArg = add.args[0] as { kind: string; list: string; entry: { uri: string } };
  assert.equal(listArg.kind, 'list');
  assert.equal(listArg.list, 'covers');
  assert.equal(listArg.entry.uri, bookUri);
});

test('an unknown list or a half-named row is ignored (no dispatch)', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  const { view } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'removeEntry', uri: bookUri, list: 'bogus', line: 4, path: 'x.jpnov', version: 1 });
  view.webview.receive({ type: 'removeEntry', uri: bookUri, list: 'covers', line: 4 }); // no path / version
  view.webview.receive({ type: 'moveEntry', uri: bookUri, list: 'covers', line: 4, path: 'x.jpnov', dir: 1 });
  view.webview.receive({ type: 'addEntries', uri: bookUri, list: 1 });
  await tick();
  assert.deepEqual(state.executedCommands.filter((c) => c.command.startsWith('jpbook.')), []);
});

test('moveEntryTo (drag-and-drop) plans against the named list only, for rows the text still has', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}cover:\n  - a.jpnov\n  - b.jpnov\n---\nx.jpnov\ny.jpnov\n`));
  const { view } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  // Every drop — planned or not — is answered with a detail re-push (the panel's DOM lags the edit).
  const drop = async (m: Record<string, unknown>): Promise<void> => {
    const n = detailCount(view);
    view.webview.receive({ type: 'moveEntryTo', uri: bookUri, list: 'covers', version: 1, ...m });
    await tick();
    assert.equal(detailCount(view), n + 1);
  };
  await drop({ line: 3, path: 'b.jpnov', before: 2, beforePath: 'a.jpnov' });
  assert.deepEqual(state.appliedEdits, [
    { uri: bookUri, range: [3, 0, 4, 0], newText: '' },
    { uri: bookUri, range: [2, 0, 2, 0], newText: '  - b.jpnov\n' },
  ]);
  state.appliedEdits.length = 0;
  // Both target fields null = after the list's last entry.
  await drop({ line: 2, path: 'a.jpnov', before: null, beforePath: null });
  assert.deepEqual(state.appliedEdits, [
    { uri: bookUri, range: [2, 0, 3, 0], newText: '' },
    { uri: bookUri, range: [3, 11, 3, 11], newText: '\n  - a.jpnov' },
  ]);
  state.appliedEdits.length = 0;
  // Nothing is planned for: the other list's name over the same lines; a moved-on version; a moved row
  // or target that no longer lists that path (a lost target is never "the end"); a half-named target.
  await drop({ list: 'chapters', line: 3, path: 'b.jpnov', before: 2, beforePath: 'a.jpnov' });
  await drop({ line: 3, path: 'b.jpnov', before: 2, beforePath: 'a.jpnov', version: 2 });
  await drop({ line: 3, path: 'a.jpnov', before: 2, beforePath: 'a.jpnov' });
  await drop({ line: 3, path: 'b.jpnov', before: 2, beforePath: 'b.jpnov' });
  await drop({ line: 3, path: 'b.jpnov', before: 2, beforePath: null });
  assert.deepEqual(state.appliedEdits, []);
});

test('row verbs run one at a time, each answered by a detail re-push before the next starts (#77)', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}---\nx.jpnov\ny.jpnov\n`));
  const { view } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  const base = detailCount(view);
  const log: string[] = [];
  const pushesSeen: number[] = [];
  state.registeredCommands.set('jpbook.removeEntry', async () => {
    log.push('start');
    pushesSeen.push(detailCount(view) - base);
    await tick();
    log.push('end');
  });
  // A double-click: both messages name the same row, the second while the first is still running.
  const row = { type: 'removeEntry', uri: bookUri, list: 'chapters', line: 2, path: 'x.jpnov', version: 1 };
  view.webview.receive(row);
  view.webview.receive(row);
  for (let i = 0; i < 10 && log.length < 4; i++) {
    await tick();
  }
  assert.deepEqual(log, ['start', 'end', 'start', 'end']);
  assert.deepEqual(pushesSeen, [0, 1]); // the second verb saw the first's re-push
  assert.equal(detailCount(view), base + 2);
});

test('a row verb that fails neither wedges the chain nor skips its re-push', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}---\nx.jpnov\ny.jpnov\n`));
  const { view } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  const base = detailCount(view);
  const log: string[] = [];
  state.registeredCommands.set('jpbook.removeEntry', () => {
    if (log.length === 0) {
      log.push('first failed');
      return Promise.reject(new Error('boom'));
    }
    log.push('second ran');
    return Promise.resolve();
  });
  const row = { type: 'removeEntry', uri: bookUri, list: 'chapters', line: 2, path: 'x.jpnov', version: 1 };
  view.webview.receive(row);
  view.webview.receive(row);
  await tick();
  await tick();
  assert.deepEqual(log, ['first failed', 'second ran']);
  assert.equal(detailCount(view), base + 2);
});

test('openFile opens the given uri', async () => {
  const root = 'file:///ws';
  const { view } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'openFile', uri: 'file:///ws/ch1.jpnov' });
  await tick();
  const open = state.executedCommands.find((c) => c.command === 'vscode.open');
  assert.ok(open);
});

// --- empty states -----------------------------------------------------------

test('no books posts an empty list with or without a folder; noFolder says whether to recommend one', async () => {
  const { view } = await setup([]);
  const st = lastState(view);
  assert.equal(st.loading, false);
  assert.deepEqual(st.groups, []);
  assert.equal(st.noFolder, true);

  state.workspaceFolders = [{ uri: Uri.parse('file:///ws'), name: 'ws', index: 0 }];
  const withFolder = await setup([]);
  assert.deepEqual(lastState(withFolder.view).groups, []);
  assert.equal(lastState(withFolder.view).noFolder, false);
});

test('welcome actions run the create-book / guide commands; an unknown action runs nothing', async () => {
  const { view } = await setup([]);
  view.webview.receive({ type: 'welcome', action: 'createBook' });
  view.webview.receive({ type: 'welcome', action: 'openFolder' });
  view.webview.receive({ type: 'welcome', action: 'openGuide' });
  await tick();
  const cmds = state.executedCommands.map((c) => c.command);
  assert.ok(cmds.includes('jpbook.createFile'));
  assert.ok(!cmds.includes('workbench.action.files.openFolder'));
  assert.ok(cmds.includes('jpnov.openGuide'));
});

test('the view chrome mirrors the open detail: book title + the create-book gating context', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}title: A\n---\n`));
  const { view } = await setup([entry(root, 'a', 'A')]);
  const ctx = (): unknown[] => state.executedCommands
    .filter((c) => c.command === 'setContext' && c.args[0] === 'jpnov.booksDetail')
    .map((c) => c.args[1]);
  const title = (): string | undefined => (view as { title?: string }).title;

  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  assert.equal(title(), 'A');
  assert.equal(ctx().at(-1), true);

  view.webview.receive({ type: 'closeDetail' });
  await tick();
  assert.equal(title(), undefined); // the fake view carries no contributed title to restore
  assert.equal(ctx().at(-1), false);
});

// --- lifecycle --------------------------------------------------------------

test('a refresh whose open book vanished returns the webview to the list', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}---\nch1.jpnov\n`));
  const client = fakeClient([entry(root, 'a')]);
  const provider = new BooksViewProvider(client as never, EXT as never);
  await provider.refresh();
  state.workspaceFolders = [{ uri: Uri.parse(root), name: 'ws', index: 0 }];
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view as never);
  view.webview.receive({ type: 'ready' });
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  // The book disappears; a refresh should tell the webview to close the detail.
  client.calls.build = null;
  (client as unknown as { sendRequest: (t: string) => Promise<unknown> }).sendRequest = (t: string) =>
    t === ListBooksRequest ? Promise.resolve({ books: [] }) : Promise.resolve({});
  await provider.refresh();
  await tick();
  assert.ok(posts(view).some((m) => m.type === 'closeDetail'));
});

test('dispose is idempotent and does not throw', async () => {
  const { provider } = await setup([entry('file:///ws', 'a')]);
  provider.dispose();
  provider.dispose();
});

test('an epub build zips member files client-side and writes one .epub per book', async () => {
  const root = 'file:///ws';
  const artifacts = [
    {
      kind: 'epub',
      path: `${root}/dist/a.epub`,
      members: [
        { name: 'META-INF/container.xml', content: '<container/>' },
        { name: 'OEBPS/package.opf', content: '<package/>' },
      ],
    },
  ];
  const { view, client } = await setup(
    [entry(root, 'a')],
    { ok: true, outDirs: [`${root}/dist`], artifacts, errors: [] },
  );
  view.webview.receive({ type: 'build', format: 'epub' });
  await tick();
  await tick();
  assert.equal(client.calls.build?.format, 'epub');
  const written = state.writtenFiles.find((f) => f.uri === `${root}/dist/a.epub`);
  assert.ok(written, 'the client wrote the .epub');
  assert.ok(written.content.startsWith('PK'), 'what it wrote is a ZIP container');
  assert.ok(state.infoMessages.some((m) => m.includes('EPUB')), 'the toast names the format');
});

// --- raceRequest ------------------------------------------------------------

test('raceRequest rejects on the timeout cap while the request hangs', async () => {
  const hang = new Promise<never>(() => undefined);
  const src = new CancellationTokenSource();
  await assert.rejects(raceRequest(hang, src.token, 10), /no reply from the language server/);
});

test('raceRequest rejects when the token cancels mid-flight', async () => {
  const src = new CancellationTokenSource();
  const raced = raceRequest(new Promise<never>(() => undefined), src.token, 5_000);
  src.cancel();
  await assert.rejects(raced, /cancelled/);
});

test('raceRequest passes a settling request straight through', async () => {
  assert.equal(await raceRequest(Promise.resolve(42), new CancellationTokenSource().token, 5_000), 42);
  await assert.rejects(
    raceRequest(Promise.reject(new Error('server boom')), new CancellationTokenSource().token, 5_000),
    /server boom/,
  );
});

// --- failures that used to stay silent (#90) --------------------------------

test('a failed refresh toasts only when the user asked for it, and the panel stays loading', async () => {
  const client = { sendRequest: () => Promise.reject(new Error('Client is not running')) };
  const provider = new BooksViewProvider(client as never, EXT as never);
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view as never);
  await provider.refresh();
  assert.deepEqual(state.errorMessages, []);
  await provider.refresh(true);
  assert.deepEqual(state.errorMessages, ["Japanese Novel: couldn't load the books. Client is not running"]);
  view.webview.receive({ type: 'ready' });
  await tick();
  assert.equal(lastState(view).loading, true);
  const reloads = (): number => state.executedCommands.filter((c) => c.command === 'workbench.action.reloadWindow').length;
  assert.equal(reloads(), 0); // the toast was dismissed
  state.errorMessagePick = 'Reload Window';
  await provider.refresh(true);
  await tick();
  assert.equal(reloads(), 1);
});

test('a refresh the server never answers gives up at the cap and cancels the request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let token: { isCancellationRequested: boolean } | undefined;
  const client = {
    sendRequest: (_type: string, _params: unknown, tok: { isCancellationRequested: boolean }) => {
      token = tok;
      return new Promise(() => undefined);
    },
  };
  const provider = new BooksViewProvider(client as never, EXT as never);
  const done = provider.refresh(true);
  t.mock.timers.runAll();
  await done;
  assert.equal(token?.isCancellationRequested, true);
  assert.equal(state.errorMessages.length, 1);
  assert.match(state.errorMessages[0] ?? '', /^Japanese Novel: couldn't load the books\. no reply from the language server within \d+s$/);
});

test('a book that cannot be opened returns the view to the list with a toast and a re-list', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  const { view, client } = await setup([entry(root, 'a', 'A')]);
  let lists = 0;
  const send = client.sendRequest.bind(client);
  client.sendRequest = (type: string, params: unknown, token?: unknown): Promise<unknown> => {
    lists += type === ListBooksRequest ? 1 : 0;
    return send(type, params, token);
  };
  state.unopenableDocs.add(bookUri);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  assert.ok(posts(view).some((m) => m.type === 'closeDetail'));
  assert.equal(posts(view).some((m) => m.type === 'detail'), false);
  assert.deepEqual(state.errorMessages, ["Japanese Novel: couldn't open a.jpbook."]);
  assert.equal((view as { title?: string }).title, undefined);
  const ctx = state.executedCommands.filter((c) => c.command === 'setContext' && c.args[0] === 'jpnov.booksDetail');
  assert.equal(ctx.at(-1)?.args[1], false);
  assert.equal(lists, 1);
});

test('a row whose book left the list is refused the same way', async () => {
  const { view } = await setup([entry('file:///ws', 'a')]);
  view.webview.receive({ type: 'openDetail', uri: 'file:///ws/src/gone.jpbook' });
  await tick();
  assert.ok(posts(view).some((m) => m.type === 'closeDetail'));
  assert.deepEqual(state.errorMessages, ["Japanese Novel: couldn't open gone.jpbook."]);
});

test('the open detail follows its buffer: a change to the book re-pushes it, another document does not', async (t) => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  const book = doc(bookUri, 'jpbook', `${HEAD}---\nch1.jpnov\n`);
  state.textDocuments.push(book);
  const { view } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  const base = detailCount(view);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  state.onDidChangeDoc.fire({ document: doc(`${root}/ch1.jpnov`, 'jpnov') });
  t.mock.timers.runAll();
  state.onDidChangeDoc.fire({ document: book });
  state.onDidChangeDoc.fire({ document: book }); // one burst, one re-push
  t.mock.timers.runAll();
  t.mock.timers.reset();
  await tick();
  assert.equal(detailCount(view), base + 1);
});

test('openDetail asks the server for the body\'s figures on the build settings and words them for the detail', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}---\nch1.jpnov\n`));
  const { view, client } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  assert.deepEqual(firstDetail(view).counts, {
    pages: { text: '2 page(s)', title: 'Body pages' },
    sheets: { text: '3 sheet(s)', title: 'Manuscript sheets (400-character 原稿用紙)' },
    chars: { text: '45 character(s)', title: 'Character count' },
  });
  const [request, ...more] = client.calls.counts;
  assert.ok(request !== undefined && more.length === 0, 'one count request per detail');
  assert.equal(request.uri, bookUri);
  assert.ok(typeof request.settings === 'object', 'the build settings snapshot rides the request');
});

test('the detail shows no figures when the server cannot count or does not answer', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}---\nch1.jpnov\n`));
  const { view, client } = await setup([entry(root, 'a')]);
  client.countsReply = { counts: null };
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  assert.equal(firstDetail(view).counts, null);
  client.countsReply = new Error('server down');
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  const details = posts(view).filter((m) => m.type === 'detail');
  assert.equal(details.length, 2);
  assert.ok(details.every((d) => d.counts === null));
});

test('a pause after typing in a chapter of the open book re-counts it; another .jpnov and a closed detail do not', async (t) => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}---\nch1.jpnov\n`));
  const { view } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  const base = detailCount(view);
  await afterPause(t, () => {
    state.onDidChangeDoc.fire({ document: doc(`${root}/other.jpnov`, 'jpnov') });
  });
  assert.equal(detailCount(view), base);
  await afterPause(t, () => {
    state.onDidChangeDoc.fire({ document: doc(`${root}/src/ch1.jpnov`, 'jpnov') });
    state.onDidChangeDoc.fire({ document: doc(`${root}/src/ch1.jpnov`, 'jpnov') }); // one pause, one re-count
  });
  assert.equal(detailCount(view), base + 1);
  view.webview.receive({ type: 'closeDetail' });
  await tick();
  await afterPause(t, () => {
    state.onDidChangeDoc.fire({ document: doc(`${root}/src/ch1.jpnov`, 'jpnov') });
  });
  assert.equal(detailCount(view), base + 1);
});

test('a layout setting change re-counts the open detail; an unrelated setting does not', async (t) => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}---\nch1.jpnov\n`));
  const { view } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  const base = detailCount(view);
  await afterPause(t, () => {
    state.onDidChangeConfig.fire({ affectsConfiguration: (section) => section === 'jpnov.editor' });
  });
  assert.equal(detailCount(view), base);
  await afterPause(t, () => {
    state.onDidChangeConfig.fire({ affectsConfiguration: (section) => section === 'jpnov.layout' });
  });
  assert.equal(detailCount(view), base + 1);
});

test('openDetail posts the characters and keywords as rows with no file; editEntry dispatches its command and re-pushes', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', `${HEAD}title: A\ncharacters: 山田　太郎\n  - 山田《やまだ》花子《はなこ》\n  - 山田太郎\nkeywords:\n  - 王都\n---\nch1.jpnov\n`));
  const { view } = await setup([entry(root, 'a', 'A')]);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  const detail = firstDetail(view) as {
    characters: { name: string; folder: string; missing: boolean; line: number; path: string; fileUri: string | null }[];
    keywords: { name: string; folder: string; missing: boolean; line: number; path: string; fileUri: string | null }[];
  };
  // A repeated base is a row too (the panel can remove it); nothing is stat-ed.
  assert.deepEqual(
    detail.characters.map((c) => [c.line, c.path, c.name, c.folder, c.fileUri, c.missing]),
    [[2, '山田　太郎', '山田　太郎', '', null, false], [3, '山田《やまだ》花子《はなこ》', '山田《やまだ》花子《はなこ》', '', null, false], [4, '山田太郎', '山田太郎', '', null, false]],
  );
  assert.deepEqual(detail.keywords.map((k) => [k.line, k.path, k.fileUri]), [[6, '王都', null]]);

  const before = detailCount(view);
  view.webview.receive({ type: 'editEntry', uri: bookUri, list: 'characters', line: 3, path: '山田《やまだ》花子《はなこ》', version: 1 });
  view.webview.receive({ type: 'addEntries', uri: bookUri, list: 'keywords' });
  await tick();
  const edit = state.executedCommands.find((c) => c.command === 'jpbook.editEntry');
  assert.ok(edit);
  const node = edit.args[0] as { kind: string; list: string; line: number; path: string; version: number };
  assert.deepEqual([node.kind, node.list, node.line, node.path, node.version], ['entry', 'characters', 3, '山田《やまだ》花子《はなこ》', 1]);
  const add = state.executedCommands.find((c) => c.command === 'jpbook.addEntries');
  assert.equal((add?.args[0] as { list: string }).list, 'keywords');
  assert.equal(detailCount(view), before + 1, 'the row verb re-pushes the detail; the list verb does not');
});
