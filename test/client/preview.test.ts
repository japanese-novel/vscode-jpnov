/**
 * Integration test for the live preview's webview hardening + render plumbing, plus
 * window-reload revival: `adopt()` re-wiring a workbench-restored panel and
 * re-rendering from the persisted `{uri, line}` webview state. Also #88: the preview
 * command without a previewable active editor keeps the shown document, and a new panel
 * falls back to the last `.jpnov` document.
 *
 * The interesting, load-bearing client logic here is turning the SERVER's standalone
 * preview document into a webview-safe one: a strict CSP `<meta>` plus a per-render
 * nonce on the inline `<style>`. We drive `open()` against a mocked active editor and a
 * fake LanguageClient, then assert on the resulting `webview.html`.
 *
 * Runs in CI via `npm run test:integration`; for direct runs see test/client/README.md.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVscode,
  createFakePanel,
  createMockState,
  doc,
  resetMockState,
  ViewColumn,
  type FakeWebviewPanel,
} from './_vscodeMock.ts';

// Install the vscode mock ONCE, bound to a single shared state, BEFORE importing the
// module under test (see _vscodeMock.resetMockState for the why).
const state = createMockState();
mock.module('vscode', { namedExports: buildVscode(state) });

const { Preview } = await import('../../src/client/preview/preview.ts');

beforeEach(() => {
  resetMockState(state);
});

/** A fake LanguageClient: only `sendRequest` is used by the preview. */
function fakeClient(html: string): { sendRequest: () => Promise<{ html: string }> } {
  return { sendRequest: () => Promise.resolve({ html }) };
}

/** Drain pending microtasks/timers so fire-and-forget renders settle. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const SERVER_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{color:red}</style></head><body><p>本文</p></body></html>';

/** The single panel the preview is expected to have created. */
function firstPanel() {
  const [panel] = state.panels;
  assert.ok(panel, 'a webview panel was created');
  return panel;
}

/** A fake client that counts renders, for asserting reveal-only paths. */
function countingClient(html: string): { renders: number; sendRequest: () => Promise<{ html: string }> } {
  const client = {
    renders: 0,
    sendRequest: (): Promise<{ html: string }> => {
      client.renders += 1;
      return Promise.resolve({ html });
    },
  };
  return client;
}

async function openPreviewWith(html: string) {
  return openWith(fakeClient(html));
}

/** Opens the preview beside an active `a.jpnov` editor through `client` and waits for the render. */
async function openWith(client: { sendRequest: (...args: unknown[]) => Promise<{ html: string }> }) {
  // The constructor type is LanguageClient; the runtime only needs sendRequest.
  const preview = new Preview(client as never);

  const d = doc('file:///proj/src/a.jpnov', 'jpnov', 'これは本文です。');
  state.textDocuments.push(d);
  state.activeEditor = { document: d, viewColumn: 1 };

  preview.open(true);
  // open() renders asynchronously (awaits sendRequest); let microtasks drain.
  await tick();
  return { preview, panel: firstPanel(), document: d };
}

/** The first `reveal` message posted to `panel`'s webview, if any. */
function findReveal(panel: FakeWebviewPanel): { line: number } | undefined {
  return panel.webview.posted.find(
    (m): m is { type: 'reveal'; line: number } =>
      typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'reveal',
  );
}

/** `panel` still shows `a.jpnov` as openWith() rendered it: no shell, no title change, no second panel. */
function assertStillShown(panel: FakeWebviewPanel): void {
  assert.equal(state.panels.length, 1, 'no second panel');
  assert.match(panel.webview.html, /本文/);
  assert.doesNotMatch(panel.webview.html, /Open a \.jpnov file to preview/);
  assert.equal(panel.title, 'a.jpnov — Preview');
}

test('open() creates a single webview panel and renders the active .jpnov', async () => {
  const { panel } = await openPreviewWith(SERVER_HTML);
  assert.equal(state.panels.length, 1);
  assert.equal(panel.viewType, 'jpnov.preview');
  assert.match(panel.webview.html, /本文/);
});

test('hardened html injects a Content-Security-Policy meta with default-src none', async () => {
  const { panel } = await openPreviewWith(SERVER_HTML);
  const html = panel.webview.html;
  assert.match(html, /<meta http-equiv="Content-Security-Policy"/i);
  assert.match(html, /default-src 'none'/);
  // scripts are allowed ONLY via a per-render nonce (the cursor-follow scroller).
  assert.match(html, /script-src 'nonce-[^']+'/);
});

test('the inline <style> carries a nonce that matches the CSP style-src', async () => {
  const { panel } = await openPreviewWith(SERVER_HTML);
  const html = panel.webview.html;

  const styleNonce = /<style[^>]*\snonce="([^"]+)"/i.exec(html);
  assert.ok(styleNonce, 'inline <style> has a nonce attribute');
  const cspNonce = /style-src 'nonce-([^']+)'/.exec(html);
  assert.ok(cspNonce, 'CSP names a style nonce');
  assert.equal(styleNonce[1], cspNonce[1], 'style nonce equals CSP nonce');
});

test('CSP allows the webview cspSource for styles/img/font', async () => {
  const { panel } = await openPreviewWith(SERVER_HTML);
  const html = panel.webview.html;
  assert.match(html, /style-src [^;]*vscode-webview:\/\/test/);
  assert.match(html, /img-src [^;]*vscode-webview:\/\/test/);
});

test('the original document body survives hardening', async () => {
  const { panel } = await openPreviewWith(SERVER_HTML);
  assert.match(panel.webview.html, /<p>本文<\/p>/);
});

test('a server render error is surfaced inside a hardened shell, not thrown', async () => {
  const failing = {
    sendRequest: () => Promise.reject(new Error('compiler exploded')),
  };
  const preview = new Preview(failing as never);

  const d = doc('file:///proj/src/a.jpnov', 'jpnov', 'x');
  state.textDocuments.push(d);
  state.activeEditor = { document: d, viewColumn: 1 };

  preview.open(true);
  await tick();

  const html = firstPanel().webview.html;
  assert.match(html, /Preview failed/);
  assert.match(html, /compiler exploded/);
  assert.match(html, /Content-Security-Policy/);
});

test('opening with no active editor shows the empty-state shell', async () => {
  const preview = new Preview(fakeClient(SERVER_HTML) as never);
  state.activeEditor = undefined;

  preview.open(true);
  await tick();

  const html = firstPanel().webview.html;
  assert.match(html, /Open a \.jpnov file to preview/);
  assert.match(html, /Content-Security-Policy/);
});

test('dispose() tears down the panel', async () => {
  const { preview, panel } = await openPreviewWith(SERVER_HTML);
  preview.dispose();
  assert.equal(panel.disposed, true);
});

test('a nonce-matched cursor-follow script is injected before </body>', async () => {
  const { panel } = await openPreviewWith(SERVER_HTML);
  const html = panel.webview.html;
  const scriptNonce = /<script nonce="([^"]+)">/i.exec(html);
  assert.ok(scriptNonce, 'a nonced <script> is injected');
  const cspNonce = /script-src 'nonce-([^']+)'/.exec(html);
  assert.ok(cspNonce, 'CSP names a script nonce');
  assert.equal(scriptNonce[1], cspNonce[1], 'script nonce equals CSP script nonce');
  // The nonce'd script seeds __INIT then runs the bundled scroller, injected at the end of <body>.
  // The scroller's own behavior (golden-ratio park, glide, resize/load re-assert, manual scroll
  // restoration) lives in src/client/webview/preview/scroll.ts — verified by port fidelity + F5, not by
  // asserting the compiled text here.
  assert.match(html, /window\.__INIT=/);
  assert.match(html, /<p>本文<\/p><script /);
  assert.doesNotMatch(html, /scrollIntoView/);
});

test('render bakes the top-most cursor line into the __INIT bootstrap', async () => {
  const preview = new Preview(fakeClient(SERVER_HTML) as never);
  const d = doc('file:///proj/src/a.jpnov', 'jpnov', 'x');
  state.textDocuments.push(d);
  state.activeEditor = { document: d, viewColumn: 1 };
  // Two cursors; the earliest (line 4) wins, not selections[0] (line 9).
  state.visibleEditors.push({
    document: d,
    selections: [{ active: { line: 9 } }, { active: { line: 4 } }],
  });

  preview.open(true);
  await tick();

  assert.match(firstPanel().webview.html, /"line":4/);
});

test('a cursor move posts a reveal for the top-most (earliest) cursor line', async () => {
  const { panel } = await openPreviewWith(SERVER_HTML);
  const ed = {
    document: doc('file:///proj/src/a.jpnov', 'jpnov', 'x'),
    selections: [{ active: { line: 7 } }, { active: { line: 3 } }],
  };
  state.onDidChangeSelection.fire({ textEditor: ed, selections: ed.selections });

  const reveal = findReveal(panel);
  assert.ok(reveal, 'a reveal message was posted on cursor move');
  assert.equal(reveal.line, 3, 'follows the earliest cursor, not selections[0]');
});

test('an edit re-render while the editor is momentarily invisible keeps the last line', async () => {
  const preview = new Preview(fakeClient(SERVER_HTML) as never);
  const d = doc('file:///proj/src/a.jpnov', 'jpnov', 'x');
  state.textDocuments.push(d);
  state.activeEditor = { document: d, viewColumn: 1 };
  state.visibleEditors.push({ document: d, selections: [{ active: { line: 6 } }] });

  preview.open(true);
  await tick();
  assert.match(firstPanel().webview.html, /"line":6/);

  // Save-with-mutation transient: the editor blinks out of visibleTextEditors, an edit lands.
  state.visibleEditors.length = 0;
  state.onDidChangeDoc.fire({ document: d });
  await new Promise((r) => setTimeout(r, 150));
  assert.match(firstPanel().webview.html, /"line":6/);
});

test('a cursor-move reveal updates the line a later render falls back to', async () => {
  const { panel } = await openPreviewWith(SERVER_HTML); // no visibleTextEditors entry
  const ed = {
    document: doc('file:///proj/src/a.jpnov', 'jpnov', 'x'),
    selections: [{ active: { line: 9 } }],
  };
  state.onDidChangeSelection.fire({ textEditor: ed, selections: ed.selections });

  state.onDidChangeDoc.fire({ document: ed.document });
  await new Promise((r) => setTimeout(r, 150));
  assert.match(panel.webview.html, /"line":9/);
});

// --- #88: the preview command without a previewable active editor -----------

test('open() with no active editor keeps the shown document and only reveals (#88)', async () => {
  const client = countingClient(SERVER_HTML);
  const { preview, panel, document } = await openWith(client);
  panel.viewColumn = 2;
  state.activeEditor = undefined; // the walkthrough page (or the panel itself) took focus

  preview.open(true);
  await tick();

  assertStillShown(panel);
  assert.equal(client.renders, 1, 'reveal only, no re-render');
  // Revealed in its own column with focus kept on the caller.
  assert.deepEqual(panel.revealed, [{ column: 2, preserveFocus: true }]);
  // Cursor tracking is intact: a later cursor move still reaches the live webview.
  const ed = { document, selections: [{ active: { line: 3 } }] };
  state.onDidChangeSelection.fire({ textEditor: ed, selections: ed.selections });
  assert.equal(findReveal(panel)?.line, 3);
});

test('open() with a non-.jpnov active editor keeps the shown document and reveals in place', async () => {
  const client = countingClient(SERVER_HTML);
  const { preview, panel } = await openWith(client);
  panel.viewColumn = 2;
  state.activeEditor = { document: doc('file:///proj/notes.md', 'markdown', 'x'), viewColumn: 1 };

  preview.open(false);
  await tick();

  assertStillShown(panel);
  assert.equal(client.renders, 1);
  // "Open Preview" takes focus; with no editor column to move to, the panel stays in its own.
  assert.deepEqual(panel.revealed, [{ column: 2, preserveFocus: false }]);
});

test('open() with the .jpnov editor active reveals in its column or beside it', async () => {
  const { preview, panel, document } = await openWith(fakeClient(SERVER_HTML));
  panel.viewColumn = 2;
  state.activeEditor = { document, viewColumn: 3 };

  preview.open(false);
  preview.open(true);
  await tick();

  assert.deepEqual(panel.revealed, [
    { column: 3, preserveFocus: false },
    { column: ViewColumn.Beside, preserveFocus: true },
  ]);
});

test('a fresh open() with no active editor falls back to the last active .jpnov editor', async () => {
  const d = doc('file:///proj/src/a.jpnov', 'jpnov', '本文');
  state.textDocuments.push(d);
  state.activeEditor = { document: d, viewColumn: 1 };
  const preview = new Preview(fakeClient(SERVER_HTML) as never); // seeded from the active editor
  state.activeEditor = undefined; // the walkthrough page took over before the link was clicked

  preview.open(true);
  await tick();

  const panel = firstPanel();
  assert.match(panel.webview.html, /本文/);
  assert.equal(panel.title, 'a.jpnov — Preview');
});

test('the fallback tracks editor switches while no panel is open and ignores non-.jpnov editors', async () => {
  const preview = new Preview(fakeClient(SERVER_HTML) as never);
  const b = doc('file:///proj/src/b.jpnov', 'jpnov', '本文');
  state.textDocuments.push(b);
  state.onDidChangeActiveEditor.fire({ document: b });
  state.onDidChangeActiveEditor.fire({ document: doc('file:///proj/notes.txt', 'plaintext', 'x') });
  state.onDidChangeActiveEditor.fire(undefined);
  assert.equal(state.panels.length, 0, 'tracking never opens a panel');

  preview.open(true);
  await tick();

  assert.equal(firstPanel().title, 'b.jpnov — Preview');
});

test('the fallback skips a remembered document that was closed or changed language', async () => {
  const uri = 'file:///proj/src/a.jpnov';
  for (const reopened of [undefined, doc(uri, 'plaintext', 'x')]) {
    resetMockState(state);
    state.activeEditor = { document: doc(uri, 'jpnov', 'x'), viewColumn: 1 };
    const preview = new Preview(fakeClient(SERVER_HTML) as never);
    state.activeEditor = undefined;
    if (reopened !== undefined) {
      state.textDocuments.push(reopened);
    }

    preview.open(true);
    await tick();

    assert.match(firstPanel().webview.html, /Open a \.jpnov file to preview/);
  }
});

// --- window-reload revival (adopt) -----------------------------------------

/** Adopt a workbench-restored fake panel, as extension.ts's serializer glue does. */
function adoptWith(
  client: { sendRequest: () => Promise<{ html: string }> },
  state_: unknown,
) {
  const preview = new Preview(client as never);
  const panel = createFakePanel();
  preview.adopt(panel as never, state_);
  return { preview, panel };
}

test('the __INIT bootstrap carries the uri the scroller persists for the next reload', async () => {
  const { panel } = await openPreviewWith(SERVER_HTML);
  const html = panel.webview.html;
  // The scroller reads uri/line from __INIT and persists them via the webview state API — the
  // payload the window-reload serializer later hands back to adopt(). The uri is `<`-escaped so a
  // hostile file name cannot break out of the inline script.
  assert.match(html, /window\.__INIT=\{[^<]*"uri":"file:\/\/\/proj\/src\/a\.jpnov"/);
});

test('adopt() with persisted state renders that document and bakes its cursor line', async () => {
  state.textDocuments.push(doc('file:///proj/src/a.jpnov', 'jpnov', '本文です。'));

  const { panel } = adoptWith(fakeClient(SERVER_HTML), {
    uri: 'file:///proj/src/a.jpnov',
    line: 5,
  });
  await tick();

  assert.deepEqual(state.openedDocs, ['file:///proj/src/a.jpnov']);
  assert.match(panel.webview.html, /本文/);
  // No editor is visible, so the persisted line drives the initial scroll.
  assert.match(panel.webview.html, /"line":5/);
});

test('adopt() prefers the active previewable editor over stale persisted state', async () => {
  const active = doc('file:///proj/src/b.jpnov', 'jpnov', 'アクティブ');
  state.textDocuments.push(active);
  state.activeEditor = { document: active, viewColumn: 1 };

  const { panel } = adoptWith(fakeClient(SERVER_HTML), {
    uri: 'file:///proj/src/a.jpnov',
    line: 9,
  });
  await tick();

  assert.equal(state.openedDocs.length, 0, 'the stale uri is never loaded');
  assert.equal(panel.title, 'b.jpnov — Preview');
  // A different document's persisted line must not leak into this render.
  assert.match(panel.webview.html, /"line":0/);
});

test('adopt() with the active editor matching the persisted uri restores its line', async () => {
  const active = doc('file:///proj/src/a.jpnov', 'jpnov', '本文');
  state.textDocuments.push(active);
  state.activeEditor = { document: active, viewColumn: 1 };
  // No visibleTextEditors entry: startup editor restoration hasn't resolved yet.

  const { panel } = adoptWith(fakeClient(SERVER_HTML), {
    uri: 'file:///proj/src/a.jpnov',
    line: 7,
  });
  await tick();

  assert.match(panel.webview.html, /"line":7/);
});

test('adopt() with no state and no editor shows the empty-state shell (pre-fix sessions)', async () => {
  const { panel } = adoptWith(fakeClient(SERVER_HTML), undefined);

  // Synchronous first paint — the day-one migration path must never stay blank.
  assert.match(panel.webview.html, /Open a \.jpnov file to preview/);
  assert.match(panel.webview.html, /Content-Security-Policy/);
  await tick();
  assert.match(panel.webview.html, /Open a \.jpnov file to preview/);
});

test('adopt() tolerates garbage state shapes without throwing', async () => {
  for (const garbage of [42, 'x', ['file:///a.jpnov'], { uri: 99, line: 'y' }]) {
    resetMockState(state);
    const { panel } = adoptWith(fakeClient(SERVER_HTML), garbage);
    await tick();
    assert.match(panel.webview.html, /Open a \.jpnov file to preview/);
  }
});

test('adopt() paints the loading shell synchronously before the restored render lands', () => {
  state.textDocuments.push(doc('file:///proj/src/a.jpnov', 'jpnov', 'x'));

  const { panel } = adoptWith(fakeClient(SERVER_HTML), {
    uri: 'file:///proj/src/a.jpnov',
  });

  // Asserted BEFORE draining microtasks: a wedged server start must never leave blank.
  assert.match(panel.webview.html, /Loading preview/);
  assert.match(panel.webview.html, /class="spinner"/);
  assert.match(panel.webview.html, /Content-Security-Policy/);
});

test('adopt() paints the loading shell synchronously in the active-editor branch too', () => {
  const active = doc('file:///proj/src/b.jpnov', 'jpnov', 'x');
  state.textDocuments.push(active);
  state.activeEditor = { document: active, viewColumn: 1 };

  const { panel } = adoptWith(fakeClient(SERVER_HTML), undefined);

  // The server is cold right after a reload; the wait shows a spinner, not a blank tab.
  assert.match(panel.webview.html, /Loading preview/);
  assert.match(panel.webview.html, /class="spinner"/);
});

test('adopt() falls back to the empty-state shell when the persisted file is gone', async () => {
  state.unopenableDocs.add('file:///proj/src/gone.jpnov');

  const { panel } = adoptWith(fakeClient(SERVER_HTML), {
    uri: 'file:///proj/src/gone.jpnov',
    line: 2,
  });
  await tick();

  assert.match(panel.webview.html, /Open a \.jpnov file to preview/);
  assert.equal(panel.disposed, false, 'the panel stays; only its content degrades');

  // The adopted panel is fully live: focusing a previewable editor re-renders it.
  state.onDidChangeActiveEditor.fire({
    document: doc('file:///proj/src/c.jpnov', 'jpnov', 'x'),
  });
  await tick();
  assert.match(panel.webview.html, /本文/);
});

test('adopt() rejects a persisted doc that is no longer previewable', async () => {
  state.textDocuments.push(doc('file:///proj/notes.txt', 'plaintext', 'x'));

  const { panel } = adoptWith(fakeClient(SERVER_HTML), {
    uri: 'file:///proj/notes.txt',
  });
  await tick();

  assert.match(panel.webview.html, /Open a \.jpnov file to preview/);
});

test('adopt() while a live panel exists disposes the incoming panel', async () => {
  const { preview, panel } = await openPreviewWith(SERVER_HTML);

  const revived = createFakePanel();
  preview.adopt(revived as never, { uri: 'file:///proj/src/a.jpnov' });
  await tick();

  assert.equal(revived.disposed, true, 'the redundant revival is closed');
  assert.equal(panel.disposed, false, 'the live panel is untouched');
  assert.match(panel.webview.html, /本文/);
});

test('a document restored by adopt() is what a later fresh open() falls back to', async () => {
  state.textDocuments.push(doc('file:///proj/src/a.jpnov', 'jpnov', '本文'));
  const { preview, panel } = adoptWith(fakeClient(SERVER_HTML), { uri: 'file:///proj/src/a.jpnov' });
  await tick();

  panel.dispose(); // the user closes the restored tab, then clicks the walkthrough link
  preview.open(true);
  await tick();

  assert.equal(firstPanel().title, 'a.jpnov — Preview');
});

test('open() after adoption reveals the adopted panel instead of creating a second one', async () => {
  const d = doc('file:///proj/src/a.jpnov', 'jpnov', 'x');
  state.textDocuments.push(d);
  state.activeEditor = { document: d, viewColumn: 1 };

  const { preview } = adoptWith(fakeClient(SERVER_HTML), undefined);
  await tick();

  preview.open(true);
  await tick();

  assert.equal(state.panels.length, 0, 'createWebviewPanel is never called');
});

test('adoption wires the live-update listeners (edit re-render + cursor reveal)', async () => {
  const client = countingClient(SERVER_HTML);
  const d = doc('file:///proj/src/a.jpnov', 'jpnov', '一');
  state.textDocuments.push(d);

  const { panel } = adoptWith(client, { uri: 'file:///proj/src/a.jpnov', line: 0 });
  await tick();
  assert.equal(client.renders, 1);

  // An edit to the shown document re-renders — after the 120ms typing debounce settles.
  state.onDidChangeDoc.fire({ document: d });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(client.renders, 2);

  // ...and a cursor move posts a reveal for the shown document.
  const ed = { document: d, selections: [{ active: { line: 8 } }] };
  state.onDidChangeSelection.fire({ textEditor: ed, selections: ed.selections });
  const reveal = findReveal(panel);
  assert.ok(reveal, 'a reveal message was posted');
  assert.equal(reveal.line, 8);
});

test('adopt() re-enables scripts on the revived webview', () => {
  const { panel } = adoptWith(fakeClient(SERVER_HTML), undefined);
  assert.deepEqual(panel.webview.options, { enableScripts: true });
});

test('a render resolving after the panel closed writes nothing and does not throw', async () => {
  // Definitely assigned: open() below calls sendRequest synchronously.
  let resolveRender!: (r: { html: string }) => void;
  const deferred = {
    sendRequest: () =>
      new Promise<{ html: string }>((res) => {
        resolveRender = res;
      }),
  };
  const preview = new Preview(deferred as never);
  const d = doc('file:///proj/src/a.jpnov', 'jpnov', 'x');
  state.textDocuments.push(d);
  state.activeEditor = { document: d, viewColumn: 1 };

  preview.open(true);
  const panel = firstPanel();
  assert.equal(panel.webview.html, '', 'render still in flight');

  panel.dispose(); // the user closes the tab mid-render
  resolveRender({ html: SERVER_HTML });
  await tick();

  assert.equal(panel.webview.html, '', 'no write to a disposed panel');
});

test('renderDocument ships the settings snapshot on the renderFile request', async () => {
  state.config['jpnov.layout.charsPerLine'] = 24;
  state.config['jpnov.layout.preview.edgeLine'] = 'red';
  let captured: unknown;
  const capturing = {
    sendRequest: (_type: unknown, params: unknown) => {
      captured = params;
      return Promise.resolve({ html: SERVER_HTML });
    },
  };
  const preview = new Preview(capturing as never);
  const d = doc('file:///proj/src/a.jpnov', 'jpnov', '一');
  state.textDocuments.push(d);
  state.activeEditor = { document: d, viewColumn: 1 };

  preview.open(true);
  await tick();

  const params = captured as { settings?: unknown };
  // Overrides read from the store; untouched keys fall back to the product defaults.
  assert.deepEqual(params.settings, {
    charsPerLine: 24,
    linesPerPage: 34,
    linePitch: 1.5,
    fontFamily: '',
    kinsoku: 'strict',
    autoTcy: 'punctuationPairs',
    dash: 'horizontalBar',
    lineNumbers: true,
    edgeLine: 'red',
  });
});

test('refresh() re-renders the shown document with fresh settings', async () => {
  const client = countingClient(SERVER_HTML);
  const { preview } = await openWith(client);
  assert.equal(client.renders, 1);

  preview.refresh();
  await tick();
  assert.equal(client.renders, 2);
});

test('refresh() with nothing shown is a no-op', async () => {
  const preview = new Preview(fakeClient(SERVER_HTML) as never);
  preview.refresh(); // must not throw and must not create a panel
  await tick();
  assert.equal(state.panels.length, 0);
});
