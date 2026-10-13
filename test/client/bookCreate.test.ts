/**
 * Unit tests for `jpbook.createFile`'s book mode (manage.ts) against the mocked `vscode`:
 * the folder resolution, the parked-`.jpbook` prompt, the written book template, the
 * non-overwrite guard, and the post-create detail reveal on BooksViewProvider.
 *
 * Runs in CI via `npm run test:integration`; directly (see test/client/README.md):
 *   node --import ./test/register.mjs --test --experimental-test-module-mocks "test/client/bookCreate.test.ts"
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { bookTemplate } from '../../src/shared/book/create.ts';
import { meta } from '../shared/book/_fixture.ts';
import { buildVscode, createFakeWebviewView, createMockState, doc, resetMockState, tick, Uri, FileType } from './_vscodeMock.ts';

const state = createMockState();
mock.module('vscode', { namedExports: buildVscode(state) });

const { createFile } = await import('../../src/client/book/manage.ts');
const { BooksViewProvider } = await import('../../src/client/book/view.ts');
const { ListBooksRequest } = await import('../../src/shared/protocol.ts');

const ROOT = 'file:///ws';

function seedFolder(): void {
  state.workspaceFolders = [{ uri: Uri.parse(ROOT), name: 'ws', index: 0 }];
}

beforeEach(() => {
  resetMockState(state);
});

/** A fake LanguageClient answering listBooks with `books`. */
function fakeClient(books: unknown[]): { sendRequest(type: string): Promise<unknown> } {
  return {
    sendRequest(type: string): Promise<unknown> {
      return Promise.resolve(type === ListBooksRequest ? { books } : {});
    },
  };
}

/** A resolved provider + ready fake view whose client enumerates `books`. */
async function setupProvider(books: unknown[]): Promise<{
  provider: InstanceType<typeof BooksViewProvider>;
  view: ReturnType<typeof createFakeWebviewView>;
}> {
  const provider = new BooksViewProvider(fakeClient(books) as never, Uri.parse('file:///ext') as never);
  const view = createFakeWebviewView();
  provider.resolveWebviewView(view as never);
  view.webview.receive({ type: 'ready' });
  await tick();
  return { provider, view };
}

/** The reveal-flagged detail push — the only push the webview's list screen accepts. */
function revealedDetail(
  view: ReturnType<typeof createFakeWebviewView>,
): { type?: string; uri?: string; reveal?: boolean } | undefined {
  const posted = view.webview.posted as { type?: string; uri?: string; reveal?: boolean }[];
  return posted.find((m) => m.type === 'detail' && m.reveal === true);
}

// --- createFile (book mode) ---------------------------------------------------

test('a typed file name writes the book template, titled after the file, at the folder root', async () => {
  seedFolder();
  state.inputBoxQueue.push('My Book');

  await createFile(undefined);

  assert.deepEqual(state.errorMessages, []);
  assert.deepEqual(state.writtenFiles, [{ uri: `${ROOT}/My Book.jpbook`, content: bookTemplate('My Book') }]);
  const options = state.inputBoxCalls[0]?.options;
  assert.ok(options, 'expected one input box');
  assert.equal(options.prompt, 'File name of the new book');
  assert.equal(options.value, '.jpbook');
  assert.deepEqual(options.valueSelection, [0, 0]);
  assert.equal(options.ignoreFocusOut, true);
});

test('a subfolder path creates the folder and normalizes the separator', async () => {
  seedFolder();
  state.inputBoxQueue.push('books\\vol1');

  await createFile(undefined);

  assert.deepEqual(state.errorMessages, []);
  assert.deepEqual(state.createdDirs, [`${ROOT}/books`]);
  assert.deepEqual(state.writtenFiles, [{ uri: `${ROOT}/books/vol1.jpbook`, content: bookTemplate('vol1') }]);
});

test('a dismissed prompt writes nothing', async () => {
  seedFolder();
  // Empty inputBoxQueue -> showInputBox resolves undefined (Esc).
  await createFile(undefined);

  assert.deepEqual(state.writtenFiles, []);
  assert.deepEqual(state.errorMessages, []);
});

test('no open folder routes to the folder picker instead of prompting', async () => {
  await createFile(undefined);

  assert.deepEqual(state.inputBoxCalls, []);
  assert.deepEqual(state.writtenFiles, []);
  assert.deepEqual(state.errorMessages, []);
  assert.ok(state.executedCommands.some((c) => c.command === 'workbench.action.files.openFolder'));
});

test('multi-root goes through the folder pick and writes into the chosen root', async () => {
  const root2 = 'file:///second';
  state.workspaceFolders = [
    { uri: Uri.parse(ROOT), name: 'ws', index: 0 },
    { uri: Uri.parse(root2), name: 'second', index: 1 },
  ];
  state.workspaceFolderPickResult = { uri: Uri.parse(root2) };
  state.inputBoxQueue.push('Y');

  await createFile(undefined);

  assert.deepEqual(state.writtenFiles, [{ uri: `${root2}/Y.jpbook`, content: bookTemplate('Y') }]);
});

test('multi-root with the folder pick dismissed writes nothing', async () => {
  state.workspaceFolders = [
    { uri: Uri.parse(ROOT), name: 'ws', index: 0 },
    { uri: Uri.parse('file:///second'), name: 'second', index: 1 },
  ];
  state.workspaceFolderPickResult = undefined;

  await createFile(undefined);

  assert.deepEqual(state.inputBoxCalls, []);
  assert.deepEqual(state.writtenFiles, []);
});

test('an existing target cancels creation', async () => {
  seedFolder();
  state.fsEntries.set(`${ROOT}/X.jpbook`, FileType.File);
  state.inputBoxQueue.push('X');

  await createFile(undefined);

  assert.deepEqual(state.writtenFiles, []);
  assert.deepEqual(state.errorMessages, ['Japanese Novel: X.jpbook already exists. Nothing was created.']);
});

test('a created book is revealed in the panel', async () => {
  seedFolder();
  const bookUri = `${ROOT}/新刊.jpbook`;
  const { provider, view } = await setupProvider([{ uri: bookUri, rootUri: ROOT, fileRel: '新刊.jpbook', outRel: '新刊' }]);
  state.inputBoxQueue.push('新刊');

  await createFile(provider);
  await tick();

  assert.deepEqual(state.errorMessages, []);
  assert.deepEqual(state.writtenFiles, [{ uri: bookUri, content: bookTemplate('新刊') }]);
  assert.equal(revealedDetail(view)?.uri, bookUri);
});

// --- revealNewBook ------------------------------------------------------------

test('revealNewBook focuses the view and opens the detail of a non-ASCII book', async () => {
  seedFolder();
  const bookUri = `${ROOT}/本.jpbook`;
  state.textDocuments.push(doc(bookUri, 'jpbook', meta({ title: '本' }) + 'ch1.jpnov\n'));
  const { provider, view } = await setupProvider([{ uri: bookUri, rootUri: ROOT, fileRel: '本.jpbook', outRel: '本' }]);

  await provider.revealNewBook(Uri.parse(bookUri) as never);
  await tick();

  assert.ok(state.executedCommands.some((c) => c.command === 'jpnov.books.focus'));
  // The reveal-flagged push is what the webview accepts on its list screen; a plain
  // re-push would be dropped as a stale race.
  assert.equal(revealedDetail(view)?.uri, bookUri);
  // A newly discovered book defaults to checked in the pushed state.
  const posted = view.webview.posted as { type?: string }[];
  const states = posted.filter((m) => m.type === 'state') as { groups?: { books: { uri: string; checked: boolean }[] }[] }[];
  const last = states[states.length - 1];
  assert.equal(last?.groups?.[0]?.books[0]?.checked, true);
  // The view chrome follows: title = the book, context key hides the title-bar `+`.
  assert.equal((view as { title?: string }).title, '本');
  const ctx = state.executedCommands
    .filter((c) => c.command === 'setContext' && c.args[0] === 'jpnov.booksDetail')
    .map((c) => c.args[1]);
  assert.equal(ctx.at(-1), true);
});

test('revealNewBook re-finds the book when the stored name is NFD-normalized', async () => {
  seedFolder();
  const nfdName = 'ガイド.jpbook'.normalize('NFD');
  const bookUri = `${ROOT}/${nfdName}`;
  state.textDocuments.push(doc(bookUri, 'jpbook', ''));
  const { provider, view } = await setupProvider([{ uri: bookUri, rootUri: ROOT, fileRel: nfdName, outRel: 'ガイド'.normalize('NFD') }]);

  await provider.revealNewBook(Uri.parse(`${ROOT}/ガイド.jpbook`) as never);
  await tick();

  assert.equal(revealedDetail(view)?.uri, bookUri);
});
