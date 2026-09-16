/**
 * Integration test for the Books panel's WebviewView provider: the CSP-hardened shell it
 * resolves, the `state` / `detail` it pushes, and the messages it dispatches back to the
 * `jpbook.*` commands. We drive the provider against a fake LanguageClient and a fake
 * WebviewView, then assert on `webview.html`, `webview.posted`, and `state.executedCommands`.
 *
 * Runs in CI via `npm run test:integration`; for direct runs see test/client/README.md.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CancellationTokenSource } from 'vscode-languageserver/node';

import {
  buildVscode,
  createFakeWebviewView,
  createMockState,
  doc,
  resetMockState,
  Uri,
  FileType,
} from './_vscodeMock.ts';

const state = createMockState();
mock.module('vscode', { namedExports: buildVscode(state) });

const { BooksViewProvider } = await import('../../src/client/book/view.ts');
const { raceRequest } = await import('../../src/client/requests.ts');
const { ListBooksRequest, BuildRequest } = await import('../../src/shared/protocol.ts');

/** A stand-in extension root (the provider asWebviewUri-serves the codicon assets under it). */
const EXT = Uri.parse('file:///ext');

beforeEach(() => {
  resetMockState(state);
});

/** Drain microtasks so fire-and-forget posts settle. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** A BookEntry with the fields the provider reads. */
function entry(rootUri: string, outRel: string, title?: string) {
  return { uri: `${rootUri}/src/${outRel}.jpbook`, rootUri, fileRel: `${outRel}.jpbook`, outRel, title };
}

/** A fake LanguageClient: answers listBooks with `books`, records the build params + token. */
function fakeClient(books: unknown[], buildResult?: unknown) {
  const calls: {
    build: { books?: string[]; format?: string } | null;
    buildToken: unknown;
  } = { build: null, buildToken: undefined };
  return {
    calls,
    sendRequest(type: string, params: unknown, token?: unknown): Promise<unknown> {
      if (type === ListBooksRequest) {
        return Promise.resolve({ books });
      }
      if (type === BuildRequest) {
        calls.build = params as { books?: string[]; format?: string };
        calls.buildToken = token;
        return Promise.resolve(buildResult ?? { ok: true, outDirs: [], artifacts: [], errors: [] });
      }
      return Promise.resolve({});
    },
  };
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

/** Construct + refresh + resolve + ready. Sets one workspace folder when there are books. */
async function setup(books: ReturnType<typeof entry>[], buildResult?: unknown) {
  const client = fakeClient(books, buildResult);
  const provider = new BooksViewProvider(client as never, EXT as never);
  await provider.refresh(); // populate books, default-checked
  const first = books[0];
  if (first !== undefined) {
    state.workspaceFolders = [{ uri: Uri.parse(first.rootUri), name: 'ws', index: 0 }];
  }
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view as never);
  view.webview.receive({ type: 'ready' });
  await tick();
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

test('the ready handshake posts the book list, all books checked by default', async () => {
  const root = 'file:///ws';
  const { view } = await setup([entry(root, 'vol1', 'Volume One'), entry(root, 'part1/vol2')]);
  const st = lastState(view);
  assert.equal(st.noFolder, false);
  const groups = st.groups as { rootLabel: string | null; books: { title: string; fileRel: string; checked: boolean }[] }[];
  const books = groups.flatMap((g) => g.books);
  assert.equal(books.length, 2);
  assert.ok(books.every((b) => b.checked));
  // single root -> flat (no section label); title falls back to the outRel last segment.
  const firstGroup = groups[0];
  assert.ok(firstGroup);
  assert.equal(firstGroup.rootLabel, null);
  const vol2 = books.find((b) => b.fileRel === 'part1/vol2.jpbook');
  assert.ok(vol2);
  assert.equal(vol2.title, 'vol2');
  assert.ok(books.find((b) => b.title === 'Volume One'));
});

test('multiple roots produce per-root labeled groups', async () => {
  const { view } = await setup([entry('file:///w1', 'x'), entry('file:///w2', 'y')]);
  const st = lastState(view);
  const groups = st.groups as { rootLabel: string | null }[];
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.rootLabel));
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
  view.webview.receive({ type: 'deselectAll' });
  await tick();
  const cleared = lastState(view).groups as { books: { checked: boolean }[] }[];
  assert.ok(cleared.flatMap((g) => g.books).every((b) => !b.checked));
  view.webview.receive({ type: 'selectAll' });
  await tick();
  const all = lastState(view).groups as { books: { checked: boolean }[] }[];
  assert.ok(all.flatMap((g) => g.books).every((b) => b.checked));
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
  const { view, client } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'deselectAll' });
  await tick();
  view.webview.receive({ type: 'build', format: 'txt' });
  await tick();
  assert.equal(client.calls.build, null);
  assert.ok(state.infoMessages.some((m) => /no books selected/i.test(m)));
});

test('a build carrying a uri sends exactly that book and leaves the selection untouched', async () => {
  const root = 'file:///ws';
  const { view, client } = await setup([entry(root, 'a'), entry(root, 'b')]);
  view.webview.receive({ type: 'deselectAll' });
  await tick();
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
  state.textDocuments.push(doc(aUri, 'jpbook', 'gone.jpnov\n'));
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

test('a partial batch keeps the success flow intact and still opens the failing book', async () => {
  const root = 'file:///ws';
  const bUri = `${root}/src/sub/b.jpbook`;
  state.textDocuments.push(doc(bUri, 'jpbook', 'sub/lost.jpnov\n'));
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

test('an error without a book uri (a root-level fault) stays toast-only', async () => {
  const root = 'file:///ws';
  const { view } = await setup([entry(root, 'a', 'A')], {
    ok: false,
    outDirs: [],
    artifacts: [],
    errors: [{ book: root, code: 'build.failed', args: ['boom'] }],
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
  state.textDocuments.push(doc(aUri, 'jpbook', 'gone.jpnov\n'));
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
  state.textDocuments.push(doc(bUri, 'jpbook', 'lost.jpnov\n'));
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
  state.textDocuments.push(doc(bookUri, 'jpbook', '---\ntitle: A\ncover:\n  - 表紙.jpnov\n  - sub/ch2.jpnov\n---\nch1.jpnov\nsub/ch2.jpnov\n'));
  state.fsEntries.set('file:///ws/ch1.jpnov', FileType.File); // ch1 exists; ch2 does not
  const { view } = await setup([entry(root, 'a', 'A')]);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  const detail = firstDetail(view) as {
    uri: string;
    title: string;
    version: number;
    chapters: { name: string; folder: string; missing: boolean; line: number; path: string }[];
    covers: { name: string; folder: string; missing: boolean; line: number; path: string }[];
    meta: { key: string; value: string; note: string }[];
  };
  assert.equal(detail.uri, bookUri);
  assert.equal(detail.version, 1); // the document version the rows were parsed from
  // Cover rows carry the item's path (marker stripped) and line; a file may sit in both lists.
  assert.deepEqual(
    detail.covers.map((c) => [c.line, c.path, c.folder, c.name, c.missing]),
    [[3, '表紙.jpnov', '', '表紙.jpnov', true], [4, 'sub/ch2.jpnov', 'sub', 'ch2.jpnov', true]],
  );
  assert.equal(detail.chapters.length, 2);
  const ch1 = detail.chapters.find((c) => c.name === 'ch1.jpnov');
  assert.ok(ch1);
  assert.equal(ch1.missing, false);
  const ch2 = detail.chapters.find((c) => c.name === 'ch2.jpnov');
  assert.ok(ch2);
  assert.equal(ch2.missing, true);
  assert.equal(ch2.folder, 'sub');
  assert.equal(ch2.line, 7);
  assert.equal(ch2.path, 'sub/ch2.jpnov');
  assert.equal(detail.meta.length, 6);
  // A set value carries no status note; the note is separate from the value (rendered by the label).
  const titleRow = detail.meta.find((m) => m.key === 'title');
  assert.ok(titleRow);
  assert.equal(titleRow.value, 'A');
  assert.equal(titleRow.note, '');
  // An absent no-default key (divider) has an empty value and a "(not set)" note.
  const dividerRow = detail.meta.find((m) => m.key === 'divider');
  assert.ok(dividerRow);
  assert.equal(dividerRow.value, '');
  assert.equal(dividerRow.note, '(not set)');
});

// --- edit dispatch (reuses manage.ts via executeCommand) --------------------

test('editMeta dispatches jpbook.editMeta with the entry, key, and current value', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', '---\nheader: My Header\n---\nch1.jpnov\n'));
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
  state.textDocuments.push(doc(bookUri, 'jpbook', 'ch1.jpnov\n'));
  const { view } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'editMeta', uri: bookUri, metaKey: 'bogus' });
  await tick();
  assert.equal(state.executedCommands.find((c) => c.command === 'jpbook.editMeta'), undefined);
});

/** The number of `detail` pushes so far — every row verb (remove / move / drop) is answered with one. */
function detailCount(view: { webview: { posted: unknown[] } }): number {
  return posts(view).filter((m) => m.type === 'detail').length;
}

test('entry actions dispatch the matching jpbook command naming the row, and re-push the detail', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', '---\ncover:\n  - x.jpnov\n---\ny.jpnov\n'));
  const { view } = await setup([entry(root, 'a')]);
  view.webview.receive({ type: 'openDetail', uri: bookUri });
  await tick();
  const before = detailCount(view);
  const row = { uri: bookUri, list: 'covers', line: 2, path: 'x.jpnov', version: 1 };
  view.webview.receive({ type: 'moveEntry', ...row, dir: -1 });
  view.webview.receive({ type: 'moveEntry', ...row, dir: 1 });
  view.webview.receive({ type: 'removeEntry', ...row });
  view.webview.receive({ type: 'addEntries', uri: bookUri, list: 'covers' });
  view.webview.receive({ type: 'createEntry', uri: bookUri, list: 'chapters' });
  await tick();
  const cmds = state.executedCommands.map((c) => c.command);
  assert.ok(cmds.includes('jpbook.moveEntryUp'));
  assert.ok(cmds.includes('jpbook.moveEntryDown'));
  assert.ok(cmds.includes('jpbook.removeEntry'));
  assert.ok(cmds.includes('jpbook.addFiles'));
  assert.ok(cmds.includes('jpbook.createFile'));
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
  const create = state.executedCommands.find((c) => c.command === 'jpbook.createFile');
  assert.ok(create);
  const listArg = create.args[0] as { kind: string; list: string; entry: { uri: string } };
  assert.equal(listArg.kind, 'list');
  assert.equal(listArg.list, 'chapters');
  assert.equal(listArg.entry.uri, bookUri);
  const add = state.executedCommands.find((c) => c.command === 'jpbook.addFiles');
  assert.ok(add);
  assert.equal((add.args[0] as { list: string }).list, 'covers');
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
  state.textDocuments.push(doc(bookUri, 'jpbook', '---\ncover:\n  - a.jpnov\n  - b.jpnov\n---\nx.jpnov\ny.jpnov\n'));
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
  state.textDocuments.push(doc(bookUri, 'jpbook', 'x.jpnov\ny.jpnov\n'));
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
  const row = { type: 'removeEntry', uri: bookUri, list: 'chapters', line: 0, path: 'x.jpnov', version: 1 };
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
  state.textDocuments.push(doc(bookUri, 'jpbook', 'x.jpnov\ny.jpnov\n'));
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
  const row = { type: 'removeEntry', uri: bookUri, list: 'chapters', line: 0, path: 'x.jpnov', version: 1 };
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

test('no workspace folder posts the no-folder empty state', async () => {
  const { view } = await setup([]);
  assert.equal(lastState(view).noFolder, true);
});

test('a folder with no books posts an empty (non-noFolder) list', async () => {
  state.workspaceFolders = [{ uri: Uri.parse('file:///ws'), name: 'ws', index: 0 }];
  const provider = new BooksViewProvider(fakeClient([]) as never, EXT as never);
  await provider.refresh();
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view as never);
  view.webview.receive({ type: 'ready' });
  await tick();
  const st = lastState(view);
  assert.equal(st.noFolder, false);
  assert.equal((st.groups as unknown[]).length, 0);
});

test('welcome actions run the create-book / open-folder / guide commands', async () => {
  const { view } = await setup([]);
  view.webview.receive({ type: 'welcome', action: 'createBook' });
  view.webview.receive({ type: 'welcome', action: 'openFolder' });
  view.webview.receive({ type: 'welcome', action: 'openGuide' });
  await tick();
  const cmds = state.executedCommands.map((c) => c.command);
  assert.ok(cmds.includes('jpbook.createFile'));
  assert.ok(cmds.includes('workbench.action.files.openFolder'));
  assert.ok(cmds.includes('jpnov.openGuide'));
});

test('the view chrome mirrors the open detail: book title + the create-book gating context', async () => {
  const root = 'file:///ws';
  const bookUri = `${root}/src/a.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', '---\ntitle: A\n---\n'));
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
  state.textDocuments.push(doc(bookUri, 'jpbook', 'ch1.jpnov\n'));
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
