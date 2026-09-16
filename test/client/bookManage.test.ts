/**
 * Unit tests for the Books panel's management commands (manage.ts), driven through the
 * registered `jpbook.*` handlers against the mocked `vscode`. Covers the QuickPick add-
 * chapters flow end to end (candidate enumeration → pick → the applied `.jpbook` edit)
 * and `createFile`'s chapter mode (prompt → write → append → open).
 *
 * Runs in CI via `npm run test:integration`; directly (see test/client/README.md):
 *   node --import ./test/register.mjs --test --experimental-test-module-mocks "test/client/bookManage.test.ts"
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildVscode, createMockState, doc, FileType, resetMockState, Uri } from './_vscodeMock.ts';

const state = createMockState();
mock.module('vscode', { namedExports: buildVscode(state) });

const { createFile, registerBookCommands } = await import('../../src/client/book/manage.ts');
const { COVER_TEMPLATE } = await import('../../src/shared/book/create.ts');

const ROOT = 'file:///ws';
const BOOK = `${ROOT}/book.jpbook`;

type List = 'chapters' | 'covers';
const ENTRY = { uri: BOOK, rootUri: ROOT, fileRel: 'book.jpbook', outRel: 'book' };

function listNode(list: List = 'chapters'): unknown {
  return { kind: 'list', list, entry: ENTRY };
}

/** One folder at ROOT, the book document with `text`, and the folder's .jpnov sweep results. */
function seed(text: string, files: readonly string[]): void {
  state.workspaceFolders = [{ uri: Uri.parse(ROOT), name: 'ws', index: 0 }];
  state.textDocuments.push(doc(BOOK, 'jpbook', text));
  state.findFilesResults.set(ROOT, files.map((rel) => Uri.parse(`${ROOT}/${rel}`)));
}

async function runAddFiles(list: List = 'chapters'): Promise<void> {
  const handler = state.registeredCommands.get('jpbook.addFiles');
  assert.ok(handler, 'jpbook.addFiles must be registered');
  await handler(listNode(list));
  assert.deepEqual(state.errorMessages, []);
}

beforeEach(() => {
  resetMockState(state);
  registerBookCommands();
});

test('addFiles(chapters) offers unlisted .jpnov files sorted, split into label/description', async () => {
  seed('ichi.jpnov\n', ['zoku/ni.jpnov', 'ichi.jpnov', '第三章.jpnov']);
  state.quickPickQueue.push([{ label: '第三章.jpnov', rel: '第三章.jpnov' }]);
  await runAddFiles();

  const call = state.quickPickCalls[0];
  assert.ok(call, 'expected one QuickPick');
  assert.deepEqual(call.items, [
    { label: 'ni.jpnov', description: 'zoku', rel: 'zoku/ni.jpnov' },
    { label: '第三章.jpnov', rel: '第三章.jpnov' },
  ]);
  assert.deepEqual(call.options, {
    canPickMany: true,
    matchOnDescription: true,
    placeHolder: 'Select chapter files to add',
  });

  const edit = state.appliedEdits[0];
  assert.ok(edit, 'expected the appended chapter to be applied');
  assert.equal(edit.uri, BOOK);
  assert.match(edit.newText, /第三章\.jpnov/);
});

test('addFiles with no .jpnov files informs and never opens a picker', async () => {
  seed('', []);
  await runAddFiles();

  assert.deepEqual(state.quickPickCalls, []);
  assert.deepEqual(state.infoMessages, ['Japanese Novel: no .jpnov files found in this workspace folder.']);
  assert.deepEqual(state.appliedEdits, []);
});

test('addFiles(chapters) with every candidate already listed informs and never opens a picker', async () => {
  seed('a.jpnov\nzoku/b.jpnov\n', ['a.jpnov', 'zoku/b.jpnov']);
  await runAddFiles();

  assert.deepEqual(state.quickPickCalls, []);
  assert.deepEqual(state.infoMessages, ['Japanese Novel: no chapter files left to add.']);
  assert.deepEqual(state.appliedEdits, []);
});

test('addFiles dismissed picker applies nothing', async () => {
  seed('', ['a.jpnov']);
  // Empty quickPickQueue -> showQuickPick resolves undefined (Esc).
  await runAddFiles();

  assert.equal(state.quickPickCalls.length, 1);
  assert.deepEqual(state.infoMessages, []);
  assert.deepEqual(state.appliedEdits, []);
});

// --- createFile (list mode: invoked with a list node) --------------------------

async function runCreateEntry(list: List = 'chapters'): Promise<void> {
  await createFile(undefined, listNode(list));
}

test('createFile with a list node parks the .jpnov suffix after the caret', async () => {
  seed('', []);
  // Empty inputBoxQueue -> showInputBox resolves undefined (Esc): nothing happens.
  await runCreateEntry();

  const options = state.inputBoxCalls[0]?.options;
  assert.ok(options, 'expected one input box');
  assert.equal(options.prompt, 'File name of the new chapter');
  assert.equal(options.value, '.jpnov');
  assert.deepEqual(options.valueSelection, [0, 0]);
  assert.equal(options.ignoreFocusOut, true);
  assert.deepEqual(state.writtenFiles, []);
  assert.deepEqual(state.appliedEdits, []);
});

test('the chapter validator rejects empty, unusable, and taken paths', async () => {
  seed('', []);
  state.fsEntries.set(`${ROOT}/taken.jpnov`, FileType.File);
  state.inputBoxQueue.push('fresh');
  await runCreateEntry();

  // The mock never invokes validateInput; probe the recorded validator directly.
  const validate = state.inputBoxCalls[0]?.options?.validateInput;
  assert.ok(validate, 'the chapter prompt must carry a validator');
  assert.equal(await validate('.jpnov'), 'Enter a file name');
  assert.equal(await validate('../ch.jpnov'), 'This file name cannot be used');
  assert.equal(await validate('/abs.jpnov'), 'This file name cannot be used');
  assert.equal(await validate('a*b.jpnov'), 'This file name cannot be used');
  assert.equal(await validate('taken.jpnov'), 'taken.jpnov already exists');
  assert.equal(await validate('another.jpnov'), null);
});

test('createFile with a chapters node writes the chapter, appends it root-relative, and opens it', async () => {
  seed('ichi.jpnov\n', []);
  // Backslash separator and a missing suffix: both normalized on accept.
  state.inputBoxQueue.push('src\\my-chapter');
  await runCreateEntry();

  assert.deepEqual(state.errorMessages, []);
  assert.deepEqual(state.createdDirs, [`${ROOT}/src`]);
  assert.deepEqual(state.writtenFiles, [{ uri: `${ROOT}/src/my-chapter.jpnov`, content: '' }]);
  const edit = state.appliedEdits[0];
  assert.ok(edit, 'expected the appended chapter to be applied');
  assert.equal(edit.uri, BOOK);
  assert.match(edit.newText, /src\/my-chapter\.jpnov/);
  assert.deepEqual(
    state.executedCommands.filter((c) => c.command === 'vscode.open').map((c) => String(c.args[0])),
    [`${ROOT}/src/my-chapter.jpnov`],
  );
});

test('createFile for an already-listed missing chapter skips the append and opens it', async () => {
  seed('src/lost.jpnov\n', []);
  state.inputBoxQueue.push('src/lost.jpnov');
  await runCreateEntry();

  assert.deepEqual(state.errorMessages, []);
  assert.deepEqual(state.writtenFiles, [{ uri: `${ROOT}/src/lost.jpnov`, content: '' }]);
  assert.deepEqual(state.appliedEdits, []);
  assert.equal(state.executedCommands.filter((c) => c.command === 'vscode.open').length, 1);
});

test('createFile never overwrites an existing chapter file', async () => {
  seed('', []);
  state.fsEntries.set(`${ROOT}/taken.jpnov`, FileType.File);
  state.inputBoxQueue.push('taken');
  await runCreateEntry();

  assert.deepEqual(state.errorMessages, ['Japanese Novel: taken.jpnov already exists. Nothing was created.']);
  assert.deepEqual(state.writtenFiles, []);
  assert.deepEqual(state.appliedEdits, []);
});

// --- the cover list ---------------------------------------------------------------

test('addFiles(covers) offers files not yet in the cover list — chapters included — under the cover wording', async () => {
  seed('---\ncover:\n  - c.jpnov\n---\na.jpnov\n', ['a.jpnov', 'c.jpnov', 'd.jpnov']);
  state.quickPickQueue.push([{ label: 'd.jpnov', rel: 'd.jpnov' }]);
  await runAddFiles('covers');

  const call = state.quickPickCalls[0];
  assert.ok(call, 'expected one QuickPick');
  assert.deepEqual(call.items, [{ label: 'a.jpnov', rel: 'a.jpnov' }, { label: 'd.jpnov', rel: 'd.jpnov' }]);
  assert.equal((call.options as { placeHolder: string }).placeHolder, 'Select cover page files to add');
  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [2, 11, 2, 11], newText: '\n  - d.jpnov' }]);
});

test('addFiles(covers) with every candidate listed informs with the cover wording', async () => {
  seed('---\ncover:\n  - a.jpnov\n---\n', ['a.jpnov']);
  await runAddFiles('covers');

  assert.deepEqual(state.quickPickCalls, []);
  assert.deepEqual(state.infoMessages, ['Japanese Novel: no cover page files left to add.']);
});

test('createFile with a covers node prompts for a cover page, seeds the sample, and opens a cover list', async () => {
  seed('---\ntitle: t\n---\na.jpnov\n', []);
  state.inputBoxQueue.push('表紙');
  await runCreateEntry('covers');

  assert.deepEqual(state.errorMessages, []);
  const options = state.inputBoxCalls[0]?.options;
  assert.ok(options, 'expected one input box');
  assert.equal(options.prompt, 'File name of the new cover page');
  assert.equal(options.value, '.jpnov');
  assert.deepEqual(state.writtenFiles, [{ uri: `${ROOT}/表紙.jpnov`, content: COVER_TEMPLATE }]);
  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [2, 0, 2, 0], newText: 'cover:\n  - 表紙.jpnov\n' }]);
  assert.deepEqual(
    state.executedCommands.filter((c) => c.command === 'vscode.open').map((c) => String(c.args[0])),
    [`${ROOT}/表紙.jpnov`],
  );
});

test('createFile for a cover in a book without front matter creates the block at the top', async () => {
  seed('a.jpnov\n', []);
  state.inputBoxQueue.push('cover');
  await runCreateEntry('covers');

  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [0, 0, 0, 0], newText: '---\ncover:\n  - cover.jpnov\n---\n' }]);
});

/** Runs a row command with a node naming the row as the panel rendered it (`version` = the document's, 1). */
async function runEntry(command: string, list: List, line: number, path: string, version = 1): Promise<void> {
  const handler = state.registeredCommands.get(command);
  assert.ok(handler, `${command} must be registered`);
  await handler({ kind: 'entry', list, line, path, version, entry: ENTRY });
  assert.deepEqual(state.errorMessages, []);
}

test('removeEntry / moveEntryUp / moveEntryDown plan edits inside the named list only', async () => {
  // The mock records edits without rewriting the document, so every run sees this text.
  seed('---\ncover:\n  - a.jpnov\n  - b.jpnov\n---\nx.jpnov\n', []);

  await runEntry('jpbook.removeEntry', 'covers', 2, 'a.jpnov');
  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [2, 0, 3, 0], newText: '' }]);
  state.appliedEdits.length = 0;

  await runEntry('jpbook.moveEntryDown', 'covers', 2, 'a.jpnov');
  assert.deepEqual(state.appliedEdits, [
    { uri: BOOK, range: [2, 0, 3, 0], newText: '' },
    { uri: BOOK, range: [3, 11, 3, 11], newText: '\n  - a.jpnov' },
  ]);
  state.appliedEdits.length = 0;

  await runEntry('jpbook.moveEntryUp', 'covers', 2, 'a.jpnov'); // already first
  await runEntry('jpbook.removeEntry', 'chapters', 2, 'a.jpnov'); // a cover line is not a chapter
  await runEntry('jpbook.moveEntryDown', 'chapters', 2, 'a.jpnov');
  assert.deepEqual(state.appliedEdits, []);
});

test('a row the panel rendered before the text changed plans nothing (#77)', async () => {
  seed('---\ncover:\n  - a.jpnov\n  - b.jpnov\n---\nx.jpnov\n', []);

  // The text moved past the version the row came from (an earlier verb, an unsaved edit).
  await runEntry('jpbook.removeEntry', 'covers', 2, 'a.jpnov', 2);
  await runEntry('jpbook.moveEntryDown', 'covers', 2, 'a.jpnov', 0);
  // Same version, but the line no longer lists the row's path (a neighbour slid in).
  await runEntry('jpbook.removeEntry', 'covers', 3, 'a.jpnov');
  await runEntry('jpbook.moveEntryDown', 'covers', 2, 'b.jpnov');
  await runEntry('jpbook.moveEntryUp', 'covers', 3, 'a.jpnov');
  assert.deepEqual(state.appliedEdits, []);
});
