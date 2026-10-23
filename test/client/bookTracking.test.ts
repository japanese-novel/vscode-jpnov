/**
 * The vscode half of rename tracking: which renames start the sweep over the workspace's
 * books, how a book is read (never opened), and the one edit that lands.
 *
 * Runs in CI via `npm run test:integration`; for direct runs see test/client/README.md.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { HEAD } from '../shared/book/_fixture.ts';
import { buildVscode, createMockState, doc, FileType, resetMockState, tick, Uri } from './_vscodeMock.ts';

const state = createMockState();
mock.module('vscode', { exports: buildVscode(state) });

const { registerRenameTracking } = await import('../../src/client/book/tracking.ts');

const ROOT = 'file:///ws';
const BOOK = `${ROOT}/vol1.jpbook`;
/** Two chapters below an empty metadata block: the fence is line 1, so the chapters are lines 2 and 3. */
const TEXT = `${HEAD}---\nch/a.jpnov\nb.jpnov\n`;

beforeEach(() => {
  resetMockState(state);
  // The book sits on the mock disk under the folder: found by the sweep, never doubled as an open book outside it.
  state.workspaceFolders = [{ uri: Uri.parse(ROOT), name: 'ws', index: 0 }];
  state.fsEntries.set(BOOK, FileType.File);
  state.fsContent.set(BOOK, TEXT);
  state.findFilesResults.set('**/*.jpbook', [Uri.parse(BOOK)]);
  state.config['jpnov.editor.updateRefsOnFileMove'] = 'always';
  registerRenameTracking();
});

async function rename(oldRel: string, newRel: string): Promise<void> {
  state.onDidRenameFiles.fire({ files: [{ oldUri: Uri.parse(`${ROOT}/${oldRel}`), newUri: Uri.parse(`${ROOT}/${newRel}`) }] });
  await tick();
}

test('a renamed image starts no sweep: no search, no read, no edit', async () => {
  await rename('cover.png', 'front.png');
  assert.deepEqual(state.findFilesCalls, []);
  assert.deepEqual(state.decodeCalls, []);
  assert.deepEqual(state.appliedEdits, []);
});

test('a renamed chapter rewrites the book read from disk, without opening it', async () => {
  await rename('b.jpnov', 'c.jpnov');
  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [3, 0, 3, 7], newText: 'c.jpnov' }]);
  assert.deepEqual(state.decodeCalls, [{ uri: BOOK }]);
  assert.deepEqual(state.openedDocs, []);
});

test('an open book is planned on its live text, the disk left unread', async () => {
  state.textDocuments.push(doc(BOOK, 'jpbook', `${HEAD}---\nb.jpnov\n`));
  await rename('b.jpnov', 'c.jpnov');
  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [2, 0, 2, 7], newText: 'c.jpnov' }]);
  assert.deepEqual(state.decodeCalls, []);
});

test('a renamed folder is found by its stat and moves the entries under it', async () => {
  state.fsEntries.set(`${ROOT}/chapters`, FileType.Directory);
  await rename('ch', 'chapters');
  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [2, 0, 2, 10], newText: 'chapters/a.jpnov' }]);
});

test('a moved book is planned alone, without a sweep: its entries keep naming the same files', async () => {
  const moved = `${ROOT}/books/vol1.jpbook`;
  state.fsEntries.set(moved, FileType.File);
  state.fsContent.set(moved, TEXT);
  await rename('vol1.jpbook', 'books/vol1.jpbook');
  assert.deepEqual(state.findFilesCalls, []);
  assert.deepEqual(state.appliedEdits, [
    { uri: moved, range: [2, 0, 2, 10], newText: '../ch/a.jpnov' },
    { uri: moved, range: [3, 0, 3, 7], newText: '../b.jpnov' },
  ]);
});

test('a renamed file of another kind that is no folder starts no sweep either', async () => {
  state.fsEntries.set(`${ROOT}/notes.txt`, FileType.File);
  await rename('memo.txt', 'notes.txt');
  assert.deepEqual(state.findFilesCalls, []);
});

test('the never mode does nothing at all', async () => {
  state.config['jpnov.editor.updateRefsOnFileMove'] = 'never';
  await rename('b.jpnov', 'c.jpnov');
  assert.deepEqual(state.findFilesCalls, []);
  assert.deepEqual(state.appliedEdits, []);
});
