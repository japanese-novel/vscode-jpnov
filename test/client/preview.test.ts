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

import type { PreviewInit, RevealMessage } from '../../src/client/protocol.ts';
import type { RenderFileParams } from '../../src/shared/protocol.ts';

import {
  buildVscode,
  ConfigurationTarget,
  createFakePanel,
  createMockState,
  doc,
  resetMockState,
  tick,
  Uri,
  ViewColumn,
  type FakeTextDocument,
  type FakeTextEditor,
  type FakeWebviewPanel,
} from './_vscodeMock.ts';

// Install the vscode mock ONCE, bound to a single shared state, BEFORE importing the
// module under test (see _vscodeMock.resetMockState for the why).
const state = createMockState();
mock.module('vscode', { namedExports: buildVscode(state) });

const { Preview } = await import('../../src/client/preview/preview.ts');
const { WIDGET_CSS } = await import('../../src/client/preview/webviewBundle.generated.ts');

beforeEach(() => {
  resetMockState(state);
});

/** A fake LanguageClient: only `sendRequest` is used by the preview. */
function fakeClient(html: string): { sendRequest: () => Promise<{ html: string }> } {
  return { sendRequest: () => Promise.resolve({ html }) };
}

/** Waits out the render debounce that edits and widget changes share. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 150));
}

const SERVER_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{color:red}</style></head><body><p>本文</p></body></html>';

/** The single panel the preview is expected to have created. */
function firstPanel() {
  const [panel] = state.panels;
  assert.ok(panel, 'a webview panel was created');
  return panel;
}

/** A fake client that keeps every renderFile request's params (its length = the render count). */
function capturingClient(html: string): {
  params: RenderFileParams[];
  sendRequest: (type: unknown, params: unknown) => Promise<{ html: string }>;
} {
  const client = {
    params: [] as RenderFileParams[],
    sendRequest: (_type: unknown, params: unknown): Promise<{ html: string }> => {
      client.params.push(params as RenderFileParams);
      return Promise.resolve({ html });
    },
  };
  return client;
}

/** A fake client that counts renders, for asserting reveal-only paths. */
function countingClient(html: string): { readonly renders: number; sendRequest: (...args: unknown[]) => Promise<{ html: string }> } {
  const client = capturingClient(html);
  return {
    get renders() {
      return client.params.length;
    },
    sendRequest: (...args: unknown[]) => client.sendRequest(args[0], args[1]),
  };
}

/**
 * A fake client whose first `immediate` requests resolve at once and every later one waits for
 * `release()`; `params` keeps every request's params, in order.
 */
function gatedClient(html: string, immediate = 1): {
  params: RenderFileParams[];
  sendRequest: (type: unknown, params: unknown) => Promise<{ html: string }>;
  release: (result?: { html: string }) => void;
} {
  let resolvePending: (r: { html: string }) => void = () => undefined;
  const client = {
    params: [] as RenderFileParams[],
    sendRequest: (_type: unknown, params: unknown): Promise<{ html: string }> => {
      client.params.push(params as RenderFileParams);
      if (client.params.length <= immediate) {
        return Promise.resolve({ html });
      }
      return new Promise((resolve) => {
        resolvePending = resolve;
      });
    },
    release: (result: { html: string } = { html }): void => {
      resolvePending(result);
    },
  };
  return client;
}

/** A fake editor showing `document` with one cursor, for the active/visible editors and the editor events. */
function editorAt(document: FakeTextDocument, line = 0, character = 0, viewColumn = 1): FakeTextEditor {
  return { document, selections: [{ active: { line, character } }], viewColumn };
}

async function openPreviewWith(html: string) {
  return openWith(fakeClient(html));
}

/** Opens the preview beside an active `a.jpnov` editor through `client` and waits for the render. */
async function openWith(client: { sendRequest: (...args: unknown[]) => Promise<{ html: string }> }) {
  const d = doc('file:///proj/src/a.jpnov', 'jpnov', 'これは本文です。');
  state.textDocuments.push(d);
  // Active before the preview exists, as in production: the constructor seeds the followed editor.
  const editor = editorAt(d);
  state.activeEditor = editor;
  // The constructor type is LanguageClient; the runtime only needs sendRequest.
  const preview = new Preview(client as never);
  // The widget's save button goes through the command (extension.ts registers it in production).
  state.registeredCommands.set('jpnov.preview.saveLayout', () => preview.saveLayout());

  preview.open(true);
  // open() renders asynchronously (awaits sendRequest); let microtasks drain.
  await tick();
  return { preview, panel: firstPanel(), document: d, editor };
}

/** The first `reveal` message posted to `panel`'s webview, if any. */
function findReveal(panel: FakeWebviewPanel): RevealMessage | undefined {
  return panel.webview.posted.find(
    (m): m is RevealMessage =>
      typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'reveal',
  );
}

/** The cursor the latest render baked into `panel`'s `__INIT`, as [line, character]. */
function bakedCursor(panel: FakeWebviewPanel): [number, number] {
  const { line, character } = readInit(panel);
  return [line, character];
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
  state.activeEditor = editorAt(d);

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
  // restoration) lives in src/client/webview/preview/scroll.ts; which column it parks is checked in
  // test/e2e/previewFollow.test.ts, not by asserting the compiled text here.
  assert.match(html, /window\.__INIT=/);
  assert.match(html, /<p>本文<\/p><script /);
  assert.doesNotMatch(html, /scrollIntoView/);
});

test('render bakes the followed editor\'s earliest cursor into the __INIT bootstrap', async () => {
  const d = doc('file:///proj/src/a.jpnov', 'jpnov', 'x');
  state.textDocuments.push(d);
  // Three cursors; the earliest (line 4, character 2) wins, not selections[0] (line 9).
  const ed = editorAt(d, 9, 0);
  ed.selections = [...ed.selections, { active: { line: 4, character: 6 } }, { active: { line: 4, character: 2 } }];
  state.activeEditor = ed;
  state.visibleEditors.push(ed);
  const preview = new Preview(fakeClient(SERVER_HTML) as never);

  preview.open(true);
  await tick();

  assert.deepEqual(bakedCursor(firstPanel()), [4, 2]);
});

test('a cursor move posts a reveal for the earliest cursor, by line then character', async () => {
  const { panel, editor } = await openPreviewWith(SERVER_HTML);
  editor.selections = [{ active: { line: 7, character: 0 } }, { active: { line: 3, character: 9 } }, { active: { line: 3, character: 4 } }];
  state.onDidChangeSelection.fire({ textEditor: editor, selections: editor.selections });

  assert.deepEqual(
    findReveal(panel),
    { type: 'reveal', uri: 'file:///proj/src/a.jpnov', line: 3, character: 4 },
    'follows the earliest cursor, not selections[0]',
  );
});

test('an edit re-render while the editor is momentarily invisible keeps the last line', async () => {
  const d = doc('file:///proj/src/a.jpnov', 'jpnov', 'x');
  state.textDocuments.push(d);
  const ed = editorAt(d, 6, 0);
  state.activeEditor = ed;
  state.visibleEditors.push(ed);
  const preview = new Preview(fakeClient(SERVER_HTML) as never);

  preview.open(true);
  await tick();
  assert.deepEqual(bakedCursor(firstPanel()), [6, 0]);

  // Save-with-mutation transient: the editor blinks out of activeTextEditor and
  // visibleTextEditors together, and an edit lands; the followed editor still has its cursor.
  state.activeEditor = undefined;
  state.visibleEditors.length = 0;
  state.onDidChangeDoc.fire({ document: d });
  await settle();
  assert.deepEqual(bakedCursor(firstPanel()), [6, 0]);
});

test('a re-render while the panel has focus bakes the followed editor\'s cursor', async () => {
  const { panel, editor } = await openPreviewWith(SERVER_HTML);
  editor.selections = [{ active: { line: 9, character: 5 } }];
  state.onDidChangeSelection.fire({ textEditor: editor, selections: editor.selections });

  state.activeEditor = undefined; // the panel took focus; the edit comes from elsewhere
  state.onDidChangeDoc.fire({ document: editor.document });
  await settle();
  assert.deepEqual(bakedCursor(panel), [9, 5]);
});

// --- #157: two editors on the same document, and a switch to another document ---

test('a render follows the editor being typed in, not the first visible one, on the same document (#157)', async () => {
  const d = doc('file:///proj/src/a.jpnov', 'jpnov', 'x');
  state.textDocuments.push(d);
  const first = editorAt(d, 2, 0, 1);
  const second = editorAt(d, 30, 4, 2);
  state.visibleEditors.push(first, second);
  state.activeEditor = second;
  const preview = new Preview(fakeClient(SERVER_HTML) as never);

  preview.open(true);
  await tick();
  assert.deepEqual(bakedCursor(firstPanel()), [30, 4], 'the active editor, listed second');

  // Typing in the second group: its cursor moves, then the edit re-renders.
  second.selections = [{ active: { line: 30, character: 5 } }];
  state.onDidChangeSelection.fire({ textEditor: second, selections: second.selections });
  assert.deepEqual(findReveal(firstPanel()), { type: 'reveal', uri: 'file:///proj/src/a.jpnov', line: 30, character: 5 });
  state.onDidChangeDoc.fire({ document: d });
  await settle();
  assert.deepEqual(bakedCursor(firstPanel()), [30, 5], 'the re-render stays with the editor being typed in');
});

test('a cursor move in an editor that is not followed posts no reveal (#157)', async () => {
  const { panel, document } = await openPreviewWith(SERVER_HTML);
  // An edit in the followed group shifted the other group's cursor: VS Code reports it as a move.
  const other = editorAt(document, 41, 0, 2);
  state.onDidChangeSelection.fire({ textEditor: other, selections: other.selections });
  assert.equal(findReveal(panel), undefined);
});

test('a reveal posted while another document\'s render is in flight names that document (#157)', async () => {
  const client = gatedClient(SERVER_HTML);
  const { panel } = await openWith(client); // shows a.jpnov
  const b = doc('file:///proj/src/b.jpnov', 'jpnov', '二');
  state.textDocuments.push(b);
  const edB = editorAt(b, 12, 3);
  state.onDidChangeActiveEditor.fire(edB); // b's render is now in flight
  // The tab switch restores b's cursor: a selection event for b arrives before b's html.
  state.onDidChangeSelection.fire({ textEditor: edB, selections: edB.selections });
  assert.match(panel.webview.html, /本文/, 'a.jpnov is still shown');
  // The scroller in a.jpnov's page ignores a reveal for b.jpnov (scroll.ts checks the uri).
  assert.deepEqual(findReveal(panel), { type: 'reveal', uri: 'file:///proj/src/b.jpnov', line: 12, character: 3 });

  client.release({ html: SERVER_HTML.replace('本文', '二') });
  await tick();
  assert.match(panel.webview.html, /<p>二<\/p>/);
  assert.deepEqual(bakedCursor(panel), [12, 3]);
});

// --- #88: the preview command without a previewable active editor -----------

test('open() with no active editor keeps the shown document and only reveals (#88)', async () => {
  const client = countingClient(SERVER_HTML);
  const { preview, panel, editor } = await openWith(client);
  panel.viewColumn = 2;
  state.activeEditor = undefined; // the walkthrough page (or the panel itself) took focus

  preview.open(true);
  await tick();

  assertStillShown(panel);
  assert.equal(client.renders, 1, 'reveal only, no re-render');
  // Revealed in its own column with focus kept on the caller.
  assert.deepEqual(panel.revealed, [{ column: 2, preserveFocus: true }]);
  // Cursor tracking is intact: a later cursor move still reaches the live webview.
  editor.selections = [{ active: { line: 3, character: 0 } }];
  state.onDidChangeSelection.fire({ textEditor: editor, selections: editor.selections });
  assert.equal(findReveal(panel)?.line, 3);
});

test('open() with a non-.jpnov active editor keeps the shown document and reveals in place', async () => {
  const client = countingClient(SERVER_HTML);
  const { preview, panel } = await openWith(client);
  panel.viewColumn = 2;
  state.activeEditor = editorAt(doc('file:///proj/notes.md', 'markdown', 'x'));

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
  state.activeEditor = editorAt(document, 0, 0, 3);

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
  state.activeEditor = editorAt(d);
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
  state.onDidChangeActiveEditor.fire(editorAt(b));
  state.onDidChangeActiveEditor.fire(editorAt(doc('file:///proj/notes.txt', 'plaintext', 'x')));
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
    state.activeEditor = editorAt(doc(uri, 'jpnov', 'x'));
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

test('adopt() with persisted state renders that document and bakes its cursor', async () => {
  state.textDocuments.push(doc('file:///proj/src/a.jpnov', 'jpnov', '本文です。'));

  const { panel } = adoptWith(fakeClient(SERVER_HTML), {
    uri: 'file:///proj/src/a.jpnov',
    line: 5,
    character: 3,
  });
  await tick();

  assert.deepEqual(state.openedDocs, ['file:///proj/src/a.jpnov']);
  assert.match(panel.webview.html, /本文/);
  // No editor is visible, so the persisted cursor drives the initial scroll.
  assert.deepEqual(bakedCursor(panel), [5, 3]);
});

test('adopt() parks an older session\'s state, or an unusable character, at the head of its line', async () => {
  for (const character of [undefined, 'y', Number.NaN]) {
    resetMockState(state);
    state.textDocuments.push(doc('file:///proj/src/a.jpnov', 'jpnov', '本文です。'));
    const { panel } = adoptWith(fakeClient(SERVER_HTML), { uri: 'file:///proj/src/a.jpnov', line: 5, character });
    await tick();
    assert.deepEqual(bakedCursor(panel), [5, 0], String(character));
  }
});

test('adopt() prefers the active previewable editor over stale persisted state', async () => {
  const active = doc('file:///proj/src/b.jpnov', 'jpnov', 'アクティブ');
  state.textDocuments.push(active);
  state.activeEditor = editorAt(active);

  const { panel } = adoptWith(fakeClient(SERVER_HTML), {
    uri: 'file:///proj/src/a.jpnov',
    line: 9,
  });
  await tick();

  assert.equal(state.openedDocs.length, 0, 'the stale uri is never loaded');
  assert.equal(panel.title, 'b.jpnov — Preview');
  // A different document's persisted line must not leak into this render.
  assert.deepEqual(bakedCursor(panel), [0, 0]);
});

test('adopt() with the active editor matching the persisted uri bakes its live cursor', async () => {
  const active = doc('file:///proj/src/a.jpnov', 'jpnov', '本文');
  state.textDocuments.push(active);
  state.activeEditor = editorAt(active, 5, 2);

  const { panel } = adoptWith(fakeClient(SERVER_HTML), {
    uri: 'file:///proj/src/a.jpnov',
    line: 7,
  });
  await tick();

  assert.deepEqual(bakedCursor(panel), [5, 2], 'the editor\'s cursor, not the persisted line');
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
  state.activeEditor = editorAt(active);

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
  state.onDidChangeActiveEditor.fire(editorAt(doc('file:///proj/src/c.jpnov', 'jpnov', 'x')));
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
  state.activeEditor = editorAt(d);

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
  await settle();
  assert.equal(client.renders, 2);

  // ...and a cursor move in an editor that then becomes active posts a reveal for the shown document.
  const ed = editorAt(d, 8, 1);
  state.onDidChangeActiveEditor.fire(ed);
  await tick();
  state.onDidChangeSelection.fire({ textEditor: ed, selections: ed.selections });
  assert.deepEqual(
    findReveal(panel),
    { type: 'reveal', uri: 'file:///proj/src/a.jpnov', line: 8, character: 1 },
    'a reveal message was posted',
  );
});

test('adopt() re-enables scripts on the revived webview', () => {
  const { panel } = adoptWith(fakeClient(SERVER_HTML), undefined);
  assert.deepEqual(panel.webview.options, { enableScripts: true });
});

test('a render resolving after the panel closed writes nothing and does not throw', async () => {
  const client = gatedClient(SERVER_HTML, 0); // every render waits
  const preview = new Preview(client as never);
  const d = doc('file:///proj/src/a.jpnov', 'jpnov', 'x');
  state.textDocuments.push(d);
  state.activeEditor = editorAt(d);

  preview.open(true);
  await tick();
  const panel = firstPanel();
  assert.equal(panel.webview.html, '', 'render still in flight');

  panel.dispose(); // the user closes the tab mid-render
  client.release();
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
  state.activeEditor = editorAt(d);

  preview.open(true);
  await tick();

  const params = captured as { settings?: unknown };
  // The wire carries the uri and the snapshot only: the server renders its synced copy.
  assert.deepEqual(Object.keys(params), ['uri', 'settings']);
  // Overrides read from the store; untouched keys fall back to the product defaults.
  assert.deepEqual(params.settings, {
    charsPerLine: 24,
    linesPerPage: 34,
    linePitch: 1.5,
    fontFamily: '',
    kinsoku: 'strict',
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

// #71 — the layout widget's preview-only overrides (charsPerLine / linesPerPage).

/** The `__INIT` bootstrap the latest render baked into `panel`'s html. */
function readInit(panel: FakeWebviewPanel): PreviewInit {
  const json = /window\.__INIT=(\{.*?\});<\/script>/.exec(panel.webview.html)?.[1];
  assert.ok(json, '__INIT bootstrap present');
  return JSON.parse(json) as PreviewInit;
}

/** The last value the preview set the `jpnov.previewAdjusted` context key to; undefined if never. */
function lastAdjustedContext(): unknown {
  const calls = state.executedCommands.filter((c) => c.command === 'setContext' && c.args[0] === 'jpnov.previewAdjusted');
  return calls.at(-1)?.args[1];
}

/** A widget message as the webview posts it; `receive` delivers it to the host's listener. */
function layoutMessage(key: string, value: unknown): { type: 'layout'; key: string; value: unknown } {
  return { type: 'layout', key, value };
}

test('the render carries the layout widget: its nonced stylesheet and the settings values in __INIT', async () => {
  state.config['jpnov.layout.charsPerLine'] = 100; // hand-edited out of range: the widget shows what the server renders
  const { panel } = await openPreviewWith(SERVER_HTML);
  const html = panel.webview.html;
  const cspNonce = /style-src 'nonce-([^']+)'/.exec(html)?.[1];
  assert.ok(cspNonce);
  assert.ok(html.includes(`<style nonce="${cspNonce}">${WIDGET_CSS}</style></head>`), 'widget stylesheet before </head>');
  assert.doesNotMatch(html, /nonce="[^"]*"[^>]*nonce=/, 'no tag carries two nonces');
  assert.match(html, /<p>本文<\/p><script /, 'the bootstrap still opens the body scripts');

  const { layout } = readInit(panel);
  const { labels, ...values } = layout;
  assert.deepEqual(values, { charsPerLine: 64, linesPerPage: 34, adjusted: false, min: 16, max: 64 });
  assert.deepEqual(labels, {
    chars: 'chars',
    lines: 'lines',
    charsPerLine: 'Characters per line',
    linesPerPage: 'Lines per page',
    hint: 'Characters per line × lines per page. Changes here apply to the preview only.',
    reset: 'Reset Preview Layout to Settings',
    save: 'Save Preview Layout to Settings…',
    show: 'Show Preview Layout Controls',
  });
  assert.equal(lastAdjustedContext(), false, 'every render mirrors the context key');
});

test('a widget change re-renders with the override, re-focuses its input once, and marks the preview adjusted', async () => {
  const client = capturingClient(SERVER_HTML);
  const { panel, document } = await openWith(client);

  panel.webview.receive(layoutMessage('charsPerLine', 41));
  panel.webview.receive(layoutMessage('charsPerLine', 42)); // a held spinner: one render for the burst
  await settle();

  assert.equal(client.params.length, 2);
  const second = client.params[1];
  assert.ok(second);
  assert.equal(second.settings.charsPerLine, 42);
  assert.equal(second.settings.linesPerPage, 34);
  const { layout } = readInit(panel);
  assert.equal(layout.charsPerLine, 42);
  assert.equal(layout.adjusted, true);
  assert.equal(layout.focus, 'charsPerLine');
  assert.equal(layout.labels.hint, 'Preview only. The settings are still 40 chars × 34 lines.');
  assert.equal(lastAdjustedContext(), true);

  // An edit-driven render keeps the override but must not pull focus into the widget.
  state.onDidChangeDoc.fire({ document });
  await settle();
  assert.equal(client.params.length, 3);
  assert.equal(client.params[2]?.settings.charsPerLine, 42);
  assert.equal(readInit(panel).layout.focus, undefined);
});

test('malformed, out-of-range or unknown widget messages are dropped', async () => {
  const client = countingClient(SERVER_HTML);
  const { panel } = await openWith(client);
  const bogus: unknown[] = [
    layoutMessage('charsPerLine', 65),
    layoutMessage('charsPerLine', 15),
    layoutMessage('charsPerLine', 40.5),
    layoutMessage('charsPerLine', '42'),
    layoutMessage('fontFamily', 42),
    { type: 'bogus' },
    'layout',
    null,
  ];
  for (const m of bogus) {
    panel.webview.receive(m);
  }
  await settle();
  assert.equal(client.renders, 1);
  assert.equal(lastAdjustedContext(), false);
});

test('a widget change while the shown document is closed renders nothing and leaks no focus into the next render', async () => {
  const client = capturingClient(SERVER_HTML);
  const { panel } = await openWith(client);
  state.textDocuments.length = 0; // the chapter tab was closed; the panel keeps its last render
  panel.webview.receive(layoutMessage('charsPerLine', 42));
  await settle();
  assert.equal(client.params.length, 1, 'nothing to render');

  assert.equal(lastAdjustedContext(), true, 'the override is armed, so the palette offers reset/save');

  const other = doc('file:///proj/src/b.jpnov', 'jpnov', '二');
  state.textDocuments.push(other);
  state.onDidChangeActiveEditor.fire(editorAt(other));
  await tick();
  assert.equal(client.params.length, 2);
  const { layout } = readInit(panel);
  assert.equal(layout.charsPerLine, 42, "the override is the panel's: the next document renders with it");
  assert.equal(layout.focus, undefined);
});

test('a render that was in flight keeps showing what it laid out, not a change made meanwhile', async () => {
  const client = gatedClient(SERVER_HTML);
  const { panel } = await openWith(client);
  panel.webview.receive(layoutMessage('charsPerLine', 41));
  await settle(); // render A (41) is now in flight
  panel.webview.receive(layoutMessage('charsPerLine', 42)); // render B scheduled
  client.release();
  await tick();
  assert.equal(client.params[1]?.settings.charsPerLine, 41);
  assert.equal(readInit(panel).layout.charsPerLine, 41, 'A shows the value A rendered');

  await settle();
  client.release();
  await tick();
  assert.equal(client.params[2]?.settings.charsPerLine, 42);
  assert.equal(readInit(panel).layout.charsPerLine, 42);
});

test('reset cancels a widget render still pending, so nothing re-opens the chip afterwards', async () => {
  const client = capturingClient(SERVER_HTML);
  const { panel } = await openWith(client);
  panel.webview.receive(layoutMessage('charsPerLine', 42));
  panel.webview.receive({ type: 'reset' }); // within the debounce window
  await settle();
  assert.equal(client.params.length, 2, 'the reset render only');
  const { layout } = readInit(panel);
  assert.equal(layout.adjusted, false);
  assert.equal(layout.focus, undefined);
});

test('a widget value equal to the resolved setting is no override; the wire still ships the raw setting', async () => {
  state.config['jpnov.layout.linesPerPage'] = 200; // the server clamps it to 64, so 64 is "the setting"
  const client = capturingClient(SERVER_HTML);
  const { panel } = await openWith(client);
  panel.webview.receive(layoutMessage('linesPerPage', 30));
  await settle();
  assert.equal(readInit(panel).layout.adjusted, true);

  panel.webview.receive(layoutMessage('linesPerPage', 64));
  await settle();
  assert.equal(client.params.length, 3);
  assert.equal(client.params[2]?.settings.linesPerPage, 200);
  const { layout } = readInit(panel);
  assert.equal(layout.adjusted, false);
  assert.equal(layout.linesPerPage, 64);
  assert.equal(lastAdjustedContext(), false);
});

test('a render retires an override whose setting moved and keeps the others', async () => {
  const client = capturingClient(SERVER_HTML);
  const { preview, panel } = await openWith(client);
  panel.webview.receive(layoutMessage('charsPerLine', 42));
  panel.webview.receive(layoutMessage('linesPerPage', 30));
  await settle();
  const grid = (): [number | undefined, number | undefined] =>
    [client.params.at(-1)?.settings.charsPerLine, client.params.at(-1)?.settings.linesPerPage];

  state.config['jpnov.layout.fontFamily'] = 'serif'; // an unrelated setting: both overrides stay
  preview.refresh();
  await tick();
  assert.deepEqual(grid(), [42, 30]);

  state.config['jpnov.layout.linesPerPage'] = 36; // the author edits the setting behind an override
  preview.refresh();
  await tick();
  assert.deepEqual(grid(), [42, 36]);
  assert.equal(readInit(panel).layout.adjusted, true);
  assert.equal(lastAdjustedContext(), true);

  state.config['jpnov.layout.charsPerLine'] = 42; // the setting catches up with the override
  preview.refresh();
  await tick();
  assert.deepEqual(grid(), [42, 36]);
  assert.equal(readInit(panel).layout.adjusted, false);
  assert.equal(lastAdjustedContext(), false);
});

test('reset (the widget button or the command) drops every override and re-renders from the settings', async () => {
  const client = capturingClient(SERVER_HTML);
  const { preview, panel } = await openWith(client);
  panel.webview.receive(layoutMessage('charsPerLine', 42));
  panel.webview.receive(layoutMessage('linesPerPage', 30));
  await settle();

  panel.webview.receive({ type: 'reset' });
  await tick();
  assert.deepEqual(
    [client.params.at(-1)?.settings.charsPerLine, client.params.at(-1)?.settings.linesPerPage],
    [40, 34],
  );
  assert.equal(readInit(panel).layout.adjusted, false);
  assert.equal(lastAdjustedContext(), false);

  const renders = client.params.length;
  preview.resetLayout(); // nothing to reset: no render either
  await tick();
  assert.equal(client.params.length, renders);
});

test('save without a folder offers the user settings only and writes just the overridden keys', async () => {
  const client = capturingClient(SERVER_HTML);
  const { preview, panel } = await openWith(client);
  panel.webview.receive(layoutMessage('charsPerLine', 42));
  await settle();

  state.quickPickQueue.push({ target: ConfigurationTarget.Global });
  panel.webview.receive({ type: 'save' });
  await tick();

  const [call] = state.quickPickCalls;
  assert.ok(call);
  const items = call.items as { label: string; description: string; detail?: string; target: number }[];
  assert.deepEqual(items.map((i) => [i.label, i.description, i.detail, i.target]), [
    ['User Settings', 'Applies to every folder you open', undefined, ConfigurationTarget.Global],
  ]);
  assert.deepEqual(call.options, { placeHolder: 'Select where to save' });
  assert.deepEqual(state.configUpdates, [
    { key: 'jpnov.layout.charsPerLine', value: 42, target: ConfigurationTarget.Global },
  ]);

  // The write's change event re-renders (extension.ts); the setting now holds the value, so the override retires.
  preview.refresh();
  await tick();
  assert.equal(client.params.at(-1)?.settings.charsPerLine, 42);
  assert.equal(readInit(panel).layout.adjusted, false);
  assert.equal(lastAdjustedContext(), false);
});

test('a save to the user settings that a workspace value shadows keeps the override, and the pick says so', async () => {
  state.workspaceFolders = [{ uri: Uri.parse('file:///proj'), name: 'proj', index: 0 }];
  state.inspectResults.set('|jpnov.layout.charsPerLine', { workspaceValue: 40 });
  const client = capturingClient(SERVER_HTML);
  const { preview, panel } = await openWith(client);
  panel.webview.receive(layoutMessage('charsPerLine', 42));
  await settle();

  state.quickPickQueue.push({ target: ConfigurationTarget.Global });
  panel.webview.receive({ type: 'save' });
  await tick();
  const items = state.quickPickCalls[0]?.items as { label: string; detail?: string }[];
  assert.equal(items[0]?.detail, 'A workspace setting already exists and takes precedence');
  assert.deepEqual(state.configUpdates, [
    { key: 'jpnov.layout.charsPerLine', value: 42, target: ConfigurationTarget.Global },
  ]);

  state.config['jpnov.layout.charsPerLine'] = 40; // the workspace value still wins
  preview.refresh();
  await tick();
  const { layout } = readInit(panel);
  assert.equal(layout.adjusted, true, 'the preview keeps showing the value the settings do not');
  assert.equal(layout.labels.hint, 'Preview only. The settings are still 40 chars × 34 lines.');
  assert.equal(client.params.at(-1)?.settings.charsPerLine, 42);
});

test('save with a folder open offers the workspace too, and flags a user value a workspace value would shadow', async () => {
  state.workspaceFolders = [{ uri: Uri.parse('file:///proj'), name: 'proj', index: 0 }];
  state.inspectResults.set('|jpnov.layout.charsPerLine', { workspaceValue: 40 });
  const client = capturingClient(SERVER_HTML);
  const { preview, panel } = await openWith(client);
  panel.webview.receive(layoutMessage('charsPerLine', 42));
  panel.webview.receive(layoutMessage('linesPerPage', 30));
  await settle();

  state.quickPickQueue.push({ target: ConfigurationTarget.Workspace });
  panel.webview.receive({ type: 'save' });
  await tick();

  const items = state.quickPickCalls[0]?.items as { label: string; description: string; detail?: string; target: number }[];
  assert.deepEqual(items.map((i) => [i.label, i.description, i.detail, i.target]), [
    ['User Settings', 'Applies to every folder you open', 'A workspace setting already exists and takes precedence', ConfigurationTarget.Global],
    ['Workspace Settings', 'Applies to the open folder only', undefined, ConfigurationTarget.Workspace],
  ]);
  assert.deepEqual(state.configUpdates, [
    { key: 'jpnov.layout.charsPerLine', value: 42, target: ConfigurationTarget.Workspace },
    { key: 'jpnov.layout.linesPerPage', value: 30, target: ConfigurationTarget.Workspace },
  ]);
  preview.refresh();
  await tick();
  assert.equal(readInit(panel).layout.adjusted, false);
});

test('cancelling the save pick writes nothing and keeps the override', async () => {
  const client = capturingClient(SERVER_HTML);
  const { panel } = await openWith(client);
  panel.webview.receive(layoutMessage('charsPerLine', 42));
  await settle();
  const renders = client.params.length;

  state.quickPickQueue.push(undefined);
  panel.webview.receive({ type: 'save' });
  await tick();

  assert.equal(state.quickPickCalls.length, 1);
  assert.equal(state.configUpdates.length, 0);
  assert.equal(client.params.length, renders);
  assert.equal(readInit(panel).layout.adjusted, true);
  assert.equal(lastAdjustedContext(), true);
});

test('a save picked after the panel closed still writes the values that were pending', async () => {
  const client = capturingClient(SERVER_HTML);
  const { panel } = await openWith(client);
  panel.webview.receive(layoutMessage('charsPerLine', 42));
  await settle();

  let choose: (pick: unknown) => void = () => undefined;
  state.quickPickQueue.push(new Promise<unknown>((resolve) => {
    choose = resolve;
  }));
  panel.webview.receive({ type: 'save' });
  await tick();
  panel.dispose(); // teardown() clears the overrides while the pick is still open
  assert.equal(lastAdjustedContext(), false);

  choose({ target: ConfigurationTarget.Global });
  await tick();
  assert.deepEqual(state.configUpdates, [
    { key: 'jpnov.layout.charsPerLine', value: 42, target: ConfigurationTarget.Global },
  ]);
});

test('closing the panel drops the overrides: the next panel renders from the settings', async () => {
  const client = capturingClient(SERVER_HTML);
  const { preview, panel } = await openWith(client);
  panel.webview.receive(layoutMessage('charsPerLine', 42));
  await settle();
  assert.equal(lastAdjustedContext(), true);

  panel.dispose();
  assert.equal(lastAdjustedContext(), false);

  preview.open(true);
  await tick();
  const second = state.panels[1];
  assert.ok(second, 'a fresh panel');
  assert.equal(client.params.at(-1)?.settings.charsPerLine, 40);
  assert.equal(readInit(second).layout.adjusted, false);
});
