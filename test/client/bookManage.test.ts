/**
 * Unit tests for the Books panel's management commands (manage.ts), driven through the
 * registered `jpbook.*` handlers against the mocked `vscode`. Covers the add-files picker end
 * to end (candidate enumeration → ticks and typed names → the files written and the applied
 * `.jpbook` edit) and the Book Info edits.
 *
 * Runs in CI via `npm run test:integration`; directly (see test/client/README.md):
 *   node --import ./test/register.mjs --test --experimental-test-module-mocks "test/client/bookManage.test.ts"
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fullWidthDigits, INDENT_MAX } from '../../src/shared/ast/notation.ts';
import { FURNITURE_ALIGNS } from '../../src/shared/compiler/chrome.ts';
import { buildVscode, createMockState, doc, FakeQuickPick, FileType, RelativePattern, resetMockState, Uri } from './_vscodeMock.ts';
import type { EntryNode, ListNode, MetaNode } from '../../src/client/book/manage.ts';
import { HEAD } from '../shared/book/_fixture.ts';

const state = createMockState();
mock.module('vscode', { exports: buildVscode(state) });

const { addEntries, editEntry, editMeta, moveEntry, removeEntryRow } = await import('../../src/client/book/manage.ts');
const { COVER_TEMPLATE } = await import('../../src/shared/book/create.ts');

const ROOT = 'file:///ws';
/** A book at the folder root: its entries count from the folder itself. */
const BOOK = `${ROOT}/book.jpbook`;

type List = 'chapters' | 'covers' | 'characters' | 'keywords';
const ENTRY = { uri: BOOK, rootUri: ROOT, fileRel: 'book.jpbook' };

function listNode(list: List = 'chapters', entry: typeof ENTRY = ENTRY): ListNode {
  return { list, entry };
}

/** The book document with `text` below the header (fixtures and expected lines count from there), and the .jpnov sweep results of its folder. */
function seed(text: string, files: readonly string[], book = BOOK): void {
  state.workspaceFolders = [{ uri: Uri.parse(ROOT), name: 'ws', index: 0 }];
  state.textDocuments.push(doc(book, 'jpbook', HEAD + text));
  state.findFilesResults.set(ROOT, files.map((rel) => Uri.parse(`${ROOT}/${rel}`)));
}

async function runAddFiles(list: List = 'chapters', entry: typeof ENTRY = ENTRY): Promise<void> {
  await addEntries(listNode(list, entry));
}

/** The one picker the run opened. */
function picker(): FakeQuickPick<{ label: string; description?: string }> {
  const qp = state.quickPicks[0];
  assert.ok(qp, 'expected one QuickPick');
  assert.equal(state.quickPicks.length, 1);
  return qp;
}

function opened(): string[] {
  return state.executedCommands.filter((c) => c.command === 'vscode.open').map((c) => String(c.args[0]));
}

function assertNothingWritten(): void {
  assert.deepEqual(state.writtenFiles, []);
  assert.deepEqual(state.appliedEdits, []);
  assert.deepEqual(opened(), []);
}

const CREATE_CHAPTER = 'Create a new chapter';

beforeEach(() => {
  resetMockState(state);
});

test('addFiles(chapters) offers unlisted .jpnov files sorted, split into label/description', async () => {
  seed('---\nichi.jpnov\n', ['zoku/ni.jpnov', 'ichi.jpnov', '第三章.jpnov']);
  state.quickPickQueue.push([{ toggle: '第三章.jpnov' }, 'accept']);
  await runAddFiles();

  const qp = picker();
  assert.deepEqual(qp.items, [
    { label: 'ni.jpnov', description: 'zoku', role: 'existing', rel: 'zoku/ni.jpnov' },
    { label: '第三章.jpnov', role: 'existing', rel: '第三章.jpnov' },
  ]);
  assert.equal(qp.canSelectMany, true);
  assert.equal(qp.matchOnDescription, true);
  assert.equal(qp.ignoreFocusOut, true);
  assert.equal(qp.placeholder, 'Pick chapter files to add, or type a name to create a new one');

  assert.deepEqual(state.errorMessages, []);
  const edit = state.appliedEdits[0];
  assert.ok(edit, 'expected the appended chapter to be applied');
  assert.equal(edit.uri, BOOK);
  assert.match(edit.newText, /第三章\.jpnov/);
  assert.deepEqual(state.writtenFiles, []);
  assert.deepEqual(opened(), []);
});

test('addFiles with no .jpnov files still opens the picker for a typed name', async () => {
  seed('', []);
  await runAddFiles();
  assert.deepEqual(picker().items, []);
  assert.deepEqual(state.infoMessages, []);
});

test('addFiles with every file listed still opens the picker for a typed name', async () => {
  seed('---\na.jpnov\nzoku/b.jpnov\n', ['a.jpnov', 'zoku/b.jpnov']);
  await runAddFiles();
  assert.deepEqual(picker().items, []);
  assert.deepEqual(state.infoMessages, []);
  assertNothingWritten();
});

test('a dismissed picker, or Enter with nothing ticked, applies nothing', async () => {
  seed('', ['a.jpnov']);
  // Empty quickPickQueue -> Esc.
  await runAddFiles();
  state.quickPickQueue.push(['accept']);
  await runAddFiles();

  assert.equal(state.quickPicks.length, 2);
  assert.deepEqual(state.infoMessages, []);
  assertNothingWritten();
});

// --- typed names: creating files from the same picker ------------------------------

test('a typed name that is no file yet rides as a create row; ticking it parks it and clears the input', async () => {
  seed('---\nichi.jpnov\n', ['ichi.jpnov']);
  // Backslash separator and a missing suffix: both normalized while typing.
  state.quickPickQueue.push([{ type: 'src\\my-chapter' }, { toggle: 'src/my-chapter.jpnov' }, 'accept']);
  await runAddFiles();

  const qp = picker();
  assert.equal(qp.value, '');
  assert.deepEqual(qp.items, [
    { label: 'src/my-chapter.jpnov', description: CREATE_CHAPTER, role: 'create', rel: 'src/my-chapter.jpnov', alwaysShow: true },
  ]);
  assert.deepEqual(qp.selectedItems, qp.items);

  assert.deepEqual(state.errorMessages, []);
  assert.deepEqual(state.createdDirs, [`${ROOT}/src`]);
  assert.deepEqual(state.writtenFiles, [{ uri: `${ROOT}/src/my-chapter.jpnov`, content: '' }]);
  const edit = state.appliedEdits[0];
  assert.ok(edit, 'expected the appended chapter to be applied');
  assert.equal(edit.uri, BOOK);
  assert.match(edit.newText, /src\/my-chapter\.jpnov/);
  assert.deepEqual(opened(), [`${ROOT}/src/my-chapter.jpnov`]);
});

test('ticked files come first and the new names after them, in one edit; the last new file opens', async () => {
  seed('---\nichi.jpnov\n', ['ichi.jpnov', 'b.jpnov', 'a.jpnov']);
  state.quickPickQueue.push([
    { toggle: 'b.jpnov' },
    { type: 'new2' },
    { toggle: 'new2.jpnov' },
    { type: 'new1' },
    { toggle: 'new1.jpnov' },
    { toggle: 'a.jpnov' },
    'accept',
  ]);
  await runAddFiles();

  assert.deepEqual(state.errorMessages, []);
  assert.deepEqual(picker().items.map((i) => i.label), ['new2.jpnov', 'new1.jpnov', 'a.jpnov', 'b.jpnov']);
  assert.deepEqual(state.writtenFiles.map((f) => f.uri), [`${ROOT}/new2.jpnov`, `${ROOT}/new1.jpnov`]);
  assert.deepEqual(state.appliedEdits.map((e) => e.newText), ['a.jpnov\nb.jpnov\nnew2.jpnov\nnew1.jpnov\n']);
  assert.deepEqual(opened(), [`${ROOT}/new1.jpnov`]);
});

test('Enter takes the typed name along with the ticks, without a tick on its row', async () => {
  seed('---\nichi.jpnov\n', ['ichi.jpnov', 'b.jpnov']);
  state.quickPickQueue.push([{ toggle: 'b.jpnov' }, { type: '三章' }, 'accept']);
  await runAddFiles();

  assert.deepEqual(state.errorMessages, []);
  assert.deepEqual(state.writtenFiles, [{ uri: `${ROOT}/三章.jpnov`, content: '' }]);
  assert.deepEqual(state.appliedEdits.map((e) => e.newText), ['b.jpnov\n三章.jpnov\n']);
  assert.deepEqual(opened(), [`${ROOT}/三章.jpnov`]);
});

test('an unticked parked name stays listed and is not created', async () => {
  seed('', []);
  state.quickPickQueue.push([{ type: 'x' }, { toggle: 'x.jpnov' }, { toggle: 'x.jpnov' }, 'accept']);
  await runAddFiles();

  const qp = picker();
  assert.deepEqual(qp.items.map((i) => i.label), ['x.jpnov']);
  assert.deepEqual(qp.selectedItems, []);
  assertNothingWritten();
});

test('an unusable name is a row that says so, cannot stay ticked, and is not taken by Enter', async () => {
  seed('', []);
  state.quickPickQueue.push([{ type: 'a*b' }, { toggle: 'a*b' }, 'accept']);
  await runAddFiles();

  const qp = picker();
  assert.deepEqual(qp.items, [
    { label: 'a*b', description: 'This file name cannot be used', role: 'info', rel: 'a*b', alwaysShow: true },
  ]);
  assert.deepEqual(qp.selectedItems, []);
  assertNothingWritten();
});

// --- the book's folder as the base -------------------------------------------------

/** A book in a subfolder of the workspace folder: its entries count from `books/`. */
const DEEP_BOOK = `${ROOT}/books/book.jpbook`;
const DEEP_ENTRY = { uri: DEEP_BOOK, rootUri: ROOT, fileRel: 'books/book.jpbook' };

test('candidates are paths from the book\'s folder, those above it (../) listed after the rest', async () => {
  seed('---\n../ichi.jpnov\n', ['zoku/ni.jpnov', 'ichi.jpnov', 'books/san.jpnov', 'books/sub/yon.jpnov'], DEEP_BOOK);
  state.quickPickQueue.push([{ toggle: 'ni.jpnov' }, 'accept']);
  await runAddFiles('chapters', DEEP_ENTRY);

  assert.deepEqual(picker().items, [
    { label: 'san.jpnov', role: 'existing', rel: 'san.jpnov' },
    { label: 'yon.jpnov', description: 'sub', role: 'existing', rel: 'sub/yon.jpnov' },
    { label: 'ni.jpnov', description: '../zoku', role: 'existing', rel: '../zoku/ni.jpnov' },
  ]);
  assert.deepEqual(state.appliedEdits.map((e) => [e.uri, e.newText]), [[DEEP_BOOK, '../zoku/ni.jpnov\n']]);
  assert.deepEqual(state.warningMessages, []);
});

test('a typed ../ name creates the file above the book\'s folder, inside the workspace folder: no warning', async () => {
  seed('', [], DEEP_BOOK);
  state.quickPickQueue.push([{ type: '../x' }, 'accept']);
  await runAddFiles('chapters', DEEP_ENTRY);

  assert.deepEqual(state.errorMessages, []);
  assert.deepEqual(state.warningMessages, []);
  assert.deepEqual(state.writtenFiles, [{ uri: `${ROOT}/x.jpnov`, content: '' }]);
  assert.deepEqual(state.appliedEdits.map((e) => e.newText), ['---\n../x.jpnov\n']);
});

test('a typed name landing outside the workspace folder is created all the same, with a warning', async () => {
  seed('', [], DEEP_BOOK);
  state.quickPickQueue.push([{ type: '../../out/x' }, 'accept']);
  await runAddFiles('chapters', DEEP_ENTRY);

  assert.deepEqual(state.errorMessages, []);
  assert.deepEqual(state.writtenFiles, [{ uri: 'file:///out/x.jpnov', content: '' }]);
  assert.deepEqual(state.warningMessages, [
    'Japanese Novel: ../../out/x.jpnov was created outside the workspace folder. The Explorer does not show it; after a rename or move, fix the paths in the book file by hand.',
  ]);
  assert.deepEqual(state.appliedEdits.map((e) => e.newText), ['---\n../../out/x.jpnov\n']);
});

test('a book under no workspace folder searches its own folder and warns about nothing', async () => {
  const alone = 'file:///home/本.jpbook';
  state.textDocuments.push(doc(alone, 'jpbook', `${HEAD}---\n`));
  state.findFilesResults.set('file:///home', [Uri.parse('file:///home/ichi.jpnov')]);
  state.quickPickQueue.push([{ toggle: 'ichi.jpnov' }, { type: '../ni' }, 'accept']);
  await runAddFiles('chapters', { uri: alone, rootUri: null as unknown as string, fileRel: '本.jpbook' });

  assert.deepEqual(state.findFilesCalls.map((c) => ((c.include as RelativePattern).base as Uri).toString()), ['file:///home']);
  assert.deepEqual(picker().items.filter((i) => i.description === undefined).map((i) => i.label), ['ichi.jpnov']);
  assert.deepEqual(state.warningMessages, []);
  assert.deepEqual(state.writtenFiles, [{ uri: 'file:///ni.jpnov', content: '' }]);
  assert.deepEqual(state.appliedEdits.map((e) => e.newText), ['ichi.jpnov\n../ni.jpnov\n']);
});

test('a typed name of a file on disk is no create row: listed = told so, unlisted = its candidate row', async () => {
  seed('---\ntaken.jpnov\n', ['taken.jpnov', 'zoku/ni.jpnov']);
  state.quickPickQueue.push([{ type: 'zoku\\ni' }, { type: 'taken' }, { toggle: 'taken.jpnov' }, 'accept']);
  await runAddFiles();

  const qp = picker();
  assert.deepEqual(qp.items, [
    { label: 'taken.jpnov', description: 'Already in this book', role: 'info', rel: 'taken.jpnov', alwaysShow: true },
    { label: 'ni.jpnov', description: 'zoku', role: 'existing', rel: 'zoku/ni.jpnov' },
  ]);
  assert.deepEqual(qp.selectedItems, []);
  assertNothingWritten();
});

test('re-creating a listed chapter whose file went missing writes it, appends nothing, and opens it', async () => {
  seed('---\nsrc/lost.jpnov\n', []);
  state.quickPickQueue.push([{ type: 'src/lost.jpnov' }, { toggle: 'src/lost.jpnov' }, 'accept']);
  await runAddFiles();

  assert.deepEqual(state.errorMessages, []);
  assert.deepEqual(state.writtenFiles, [{ uri: `${ROOT}/src/lost.jpnov`, content: '' }]);
  assert.deepEqual(state.appliedEdits, []);
  assert.deepEqual(opened(), [`${ROOT}/src/lost.jpnov`]);
});

test('a file that appeared on disk after the sweep is never overwritten', async () => {
  seed('', []);
  state.fsEntries.set(`${ROOT}/taken.jpnov`, FileType.File);
  state.quickPickQueue.push([{ type: 'taken' }, { toggle: 'taken.jpnov' }, 'accept']);
  await runAddFiles();

  assert.deepEqual(state.errorMessages, ['Japanese Novel: taken.jpnov already exists. Nothing was created.']);
  assertNothingWritten();
});

// --- the cover list ---------------------------------------------------------------

test('addFiles(covers) offers files not yet in the cover list — chapters included — under the cover wording', async () => {
  seed('cover:\n  - c.jpnov\n---\na.jpnov\n', ['a.jpnov', 'c.jpnov', 'd.jpnov']);
  state.quickPickQueue.push([{ toggle: 'd.jpnov' }, 'accept']);
  await runAddFiles('covers');

  const qp = picker();
  assert.deepEqual(qp.items, [
    { label: 'a.jpnov', role: 'existing', rel: 'a.jpnov' },
    { label: 'd.jpnov', role: 'existing', rel: 'd.jpnov' },
  ]);
  assert.equal(qp.placeholder, 'Pick cover page files to add, or type a name to create a new one');
  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [2, 11, 2, 11], newText: '\n  - d.jpnov' }]);
});

test('a new cover page seeds the sample, opens a cover list, and opens in the editor', async () => {
  seed('title: t\n---\na.jpnov\n', []);
  state.quickPickQueue.push([{ type: '表紙' }, { toggle: '表紙.jpnov' }, 'accept']);
  await runAddFiles('covers');

  assert.deepEqual(state.errorMessages, []);
  assert.equal(picker().items[0]?.description, 'Create a new cover page');
  assert.deepEqual(state.writtenFiles, [{ uri: `${ROOT}/表紙.jpnov`, content: COVER_TEMPLATE }]);
  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [2, 0, 2, 0], newText: 'cover:\n  - 表紙.jpnov\n' }]);
  assert.deepEqual(opened(), [`${ROOT}/表紙.jpnov`]);
});

test('a new cover in a book with empty metadata opens the list right above the fence', async () => {
  seed('---\na.jpnov\n', []);
  state.quickPickQueue.push([{ type: 'cover' }, { toggle: 'cover.jpnov' }, 'accept']);
  await runAddFiles('covers');

  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [1, 0, 1, 0], newText: 'cover:\n  - cover.jpnov\n' }]);
});

/** A node naming the row as the panel rendered it (`version` = the document's, 1). */
function entryNode(list: List, line: number, path: string, version = 1): EntryNode {
  return { list, line, path, version, entry: ENTRY };
}

/** Runs a row verb on the seeded book; no verb toasts. */
async function runEntry(verb: (node: EntryNode) => Promise<void>, list: List, line: number, path: string, version = 1): Promise<void> {
  await verb(entryNode(list, line, path, version));
  assert.deepEqual(state.errorMessages, []);
}

/** Moves the row before `before` (null = the end of the list), as the up/down buttons and a drop ask. */
const runMove = (list: List, line: number, path: string, before: { line: number; path: string } | null, version = 1): Promise<void> =>
  runEntry((node) => moveEntry(node, before), list, line, path, version);

test('removeEntryRow / moveEntry plan edits inside the named list only', async () => {
  // The mock records edits without rewriting the document, so every run sees this text.
  seed('cover:\n  - a.jpnov\n  - b.jpnov\n---\nx.jpnov\n', []);

  await runEntry(removeEntryRow, 'covers', 2, 'a.jpnov');
  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [2, 0, 3, 0], newText: '' }]);
  state.appliedEdits.length = 0;

  await runMove('covers', 2, 'a.jpnov', null); // down from the first of two: to the end
  assert.deepEqual(state.appliedEdits, [
    { uri: BOOK, range: [2, 0, 3, 0], newText: '' },
    { uri: BOOK, range: [3, 11, 3, 11], newText: '\n  - a.jpnov' },
  ]);
  state.appliedEdits.length = 0;

  await runMove('covers', 2, 'a.jpnov', { line: 2, path: 'a.jpnov' }); // before itself: a no-op
  await runMove('covers', 2, 'a.jpnov', { line: 3, path: 'b.jpnov' }); // already there
  await runEntry(removeEntryRow, 'chapters', 2, 'a.jpnov'); // a cover line is not a chapter
  await runMove('chapters', 2, 'a.jpnov', null);
  await runMove('covers', 2, 'a.jpnov', { line: 5, path: 'x.jpnov' }); // the target is not in the list
  assert.deepEqual(state.appliedEdits, []);
});

test('a row the panel rendered before the text changed plans nothing (#77)', async () => {
  seed('cover:\n  - a.jpnov\n  - b.jpnov\n---\nx.jpnov\n', []);

  // The text moved past the version the row came from (an earlier verb, an unsaved edit).
  await runEntry(removeEntryRow, 'covers', 2, 'a.jpnov', 2);
  await runMove('covers', 2, 'a.jpnov', null, 0);
  // Same version, but the line no longer lists the row's path (a neighbour slid in).
  await runEntry(removeEntryRow, 'covers', 3, 'a.jpnov');
  await runMove('covers', 2, 'b.jpnov', null);
  await runMove('covers', 3, 'a.jpnov', { line: 2, path: 'a.jpnov' });
  await runMove('covers', 3, 'b.jpnov', { line: 2, path: 'b.jpnov' }); // the target moved
  assert.deepEqual(state.appliedEdits, []);
});

// --- editMeta -----------------------------------------------------------------

/** The book as `text`, alone: a row loop seeds one document per row. */
function reseed(text: string): void {
  state.textDocuments.length = 0;
  state.appliedEdits.length = 0;
  seed(text, []);
}

/** The validator of the last input box, as the mock recorded it. */
function lastValidator(): (value: string) => string | null | Promise<string | null> {
  const validate = state.inputBoxCalls.at(-1)?.options?.validateInput;
  assert.ok(validate, 'the input box validates');
  return validate;
}

/** Runs `editMeta` on the seeded book as the panel dispatches it; returns how often the book was saved. */
async function runEditMeta(metaKey: string): Promise<number> {
  let saves = 0;
  const book = state.textDocuments.find((d) => d.uri.toString() === BOOK);
  assert.ok(book, 'seed the book first');
  book.save = () => {
    saves += 1;
    return Promise.resolve(true);
  };
  await editMeta({ entry: ENTRY, metaKey: metaKey as MetaNode['metaKey'], value: undefined });
  assert.deepEqual(state.errorMessages, []);
  return saves;
}

/** What the panel's dialog answers: a quick pick's entry (see `FakeQuickPick`) or an input box's text; `undefined` = Esc. */
type Answer = { readonly picked: unknown } | { readonly typed: string | undefined };

function answer(...given: Answer[]): void {
  for (const one of given) {
    if ('picked' in one) {
      state.quickPickQueue.push(one.picked);
    } else {
      state.inputBoxQueue.push(one.typed);
    }
  }
}

test('editMeta edits the lines of ONE key and saves the book', async () => {
  interface Planned {
    readonly range: [number, number, number, number];
    readonly newText: string;
  }
  const cases: readonly (readonly [name: string, text: string, key: string, given: Answer | readonly Answer[], edits: readonly Planned[]])[] = [
    [
      'an emptied input box writes `key:`',
      'title: 作品名\nheader: 作品名　一\n---\na.jpnov\n', 'title', { typed: '' },
      [{ range: [1, 0, 1, 10], newText: 'title:' }],
    ],
    [
      'whitespace alone is an empty value',
      'title: 作品名\nheader: 作品名　一\n---\na.jpnov\n', 'title', { typed: ' 　 ' },
      [{ range: [1, 0, 1, 10], newText: 'title:' }],
    ],
    [
      'a key without a line is inserted at its position (before a later key)',
      'header: 作品名　一\n---\na.jpnov\n', 'title', { typed: '' },
      [{ range: [1, 0, 1, 0], newText: 'title:\n' }],
    ],
    [
      'a key in an empty metadata block goes right above the fence',
      '---\na.jpnov\n', 'title', { typed: '作品名' },
      [{ range: [1, 0, 1, 0], newText: 'title: 作品名\n' }],
    ],
    [
      'a key without a line, the last in order, lands after the last key',
      'title: 作品名\n\n---\na.jpnov\n', 'divider',
      [{ picked: { label: '＊', pick: 'preset' } }, { picked: { label: 'Centred', indented: false } }],
      [{ range: [1, 10, 1, 10], newText: '\ndivider: ＊' }],
    ],
    [
      'Enter on a key with no valid line rewrites its first line and deletes the rest',
      'Title: 作品名\ntitle:\n---\n', 'title', { typed: '' },
      [{ range: [1, 0, 1, 10], newText: 'title:' }, { range: [2, 0, 3, 0], newText: '' }],
    ],
    [
      'the header pick "Title" writes the title value annotation',
      'title: 作品名\n---\n', 'header', { picked: [{ pick: 'Title' }, 'accept'] },
      [{ range: [1, 10, 1, 10], newText: '\nheader: ［＃ここに「タイトル」の値を表示］' }],
    ],
    [
      'the header pick "Title and chapter number" writes the title, a full-width space and the chapter number in 命数',
      'title: 作品名\n---\n', 'header', { picked: [{ pick: 'Title and chapter number' }, 'accept'] },
      [{ range: [1, 10, 1, 10], newText: '\nheader: ［＃ここに「タイトル」の値を表示］　［＃ここに「見出し番号」の値を命数で表示］' }],
    ],
    [
      'the header pick "No header" is written as `header:`',
      'title: 作品名\nheader: 作品名　一\n---\n', 'header', { picked: [{ pick: 'No header' }, 'accept'] },
      [{ range: [2, 0, 2, 13], newText: 'header:' }],
    ],
    [
      'a typed header is the first item, taken as typed',
      'title: 作品名\n---\n', 'header', { picked: [{ type: ' 作品名　一 ' }, 'accept'] },
      [{ range: [1, 10, 1, 10], newText: '\nheader: 作品名　一' }],
    ],
    [
      'the footer pick "No footer" is written as `footer:`',
      'title: 作品名\n---\n', 'footer', { picked: [{ pick: 'No footer' }, 'accept'] },
      [{ range: [1, 10, 1, 10], newText: '\nfooter:' }],
    ],
    [
      'the footer pick "Restore default" deletes the footer line: the page numbers come back',
      'title: 作品名\nfooter:\n---\n', 'footer', { picked: [{ pick: 'Restore default' }, 'accept'] },
      [{ range: [2, 0, 3, 0], newText: '' }],
    ],
    [
      'the header pick "Restore default" deletes the header line, repeats included',
      'title: 作品名\nheader: 作品名　一\nHeader: x\n---\n', 'header', { picked: [{ pick: 'Restore default' }, 'accept'] },
      [{ range: [2, 0, 4, 0], newText: '' }],
    ],
    [
      'a typed author is the first item, taken as typed',
      'title: 作品名\n---\n', 'author', { picked: [{ type: ' ペンネーム ' }, 'accept'] },
      [{ range: [1, 10, 1, 10], newText: '\nauthor: ペンネーム' }],
    ],
    [
      'the author pick "Restore default" deletes the author line (Enter on an emptied box picks it)',
      'title: 作品名\nauthor: ペンネーム\n---\n', 'author', { picked: [{ type: '' }, 'accept'] },
      [{ range: [2, 0, 3, 0], newText: '' }],
    ],
    [
      'the alignment pick "Restore default" deletes the line, a rejected one included',
      'footerAlign: bottom\n---\n', 'footerAlign', { picked: { label: 'Restore default', description: 'Right', value: null } },
      [{ range: [1, 0, 2, 0], newText: '' }],
    ],
    [
      'the divider pick "Restore default" deletes the divider line',
      'title: 作品名\ndivider: ＊\n---\n', 'divider', { picked: { label: 'Restore default', pick: 'restore' } },
      [{ range: [2, 0, 3, 0], newText: '' }],
    ],
    [
      'a typed footer is the first item, taken as typed',
      'title: 作品名\nfooter:\n---\n', 'footer', { picked: [{ type: ' ページ番号 ' }, 'accept'] },
      [{ range: [2, 0, 2, 7], newText: 'footer: ページ番号' }],
    ],
    [
      'the divider picker\'s "(none)" writes `divider:`',
      'title: 作品名\ndivider: ＊\n---\n', 'divider', { picked: { label: '(none)', pick: 'none' } },
      [{ range: [2, 0, 2, 10], newText: 'divider:' }],
    ],
    [
      'an indented divider is written with its 字下げ (full-width digits accepted)',
      'title: 作品名\ndivider: ＊\n---\n', 'divider',
      [{ picked: { label: '＊', pick: 'preset' } }, { picked: { label: 'Indented', indented: true } }, { typed: '３' }],
      [{ range: [2, 0, 2, 10], newText: 'divider: ［＃３字下げ］＊' }],
    ],
    [
      'a picked alignment replaces the rejected line',
      'footerAlign: bottom\n---\n', 'footerAlign', { picked: { label: 'Left', description: 'left', value: 'left' } },
      [{ range: [1, 0, 1, 19], newText: 'footerAlign: left' }],
    ],
    [
      'the valid line is rewritten first, then the others deleted',
      'FooterAlign: left\nfooterAlign: right\n---\n', 'footerAlign',
      { picked: { label: 'Alternate: right, then left', description: 'rightLeft', value: 'rightLeft' } },
      [{ range: [2, 0, 2, 18], newText: 'footerAlign: rightLeft' }, { range: [1, 0, 2, 0], newText: '' }],
    ],
    [
      'a picked header alignment lands after the header',
      'header: 作品名　一\n---\n', 'headerAlign', { picked: { label: 'Right', description: 'right', value: 'right' } },
      [{ range: [1, 13, 1, 13], newText: '\nheaderAlign: right' }],
    ],
  ];
  for (const [name, text, key, given, edits] of cases) {
    reseed(text);
    answer(...[given].flat());
    const saves = await runEditMeta(key);
    assert.deepEqual(state.appliedEdits, edits.map((e) => ({ uri: BOOK, ...e })), name);
    assert.equal(saves, 1, name);
  }
});

test('the divider 字下げ box takes 1-99 only: the line head is not on offer (#86)', async () => {
  reseed('title: 作品名\ndivider: ＊\n---\n');
  answer({ picked: { label: '＊', pick: 'preset' } }, { picked: { label: 'Indented', indented: true } }, { typed: undefined });
  assert.equal(await runEditMeta('divider'), 0);
  const validate = lastValidator();
  for (const ok of ['1', '３', String(INDENT_MAX), fullWidthDigits(INDENT_MAX), ' 5 ']) {
    assert.equal(validate(ok), null, ok);
  }
  for (const bad of ['0', '００', String(INDENT_MAX + 1), '', 'a', '-1']) {
    assert.equal(validate(bad), `Enter a number (1-${String(INDENT_MAX)})`, bad);
  }
});

test('editMeta offers the five alignments and the default for the header and the footer, each with its own prompt', async () => {
  const labels = ['Right', 'Left', 'Alternate: right, then left', 'Alternate: left, then right', 'Center', 'Restore default'];
  for (const [key, placeHolder, dflt] of [['headerAlign', 'Where the header goes', 'Center'], ['footerAlign', 'Where the footer goes', 'Right']] as const) {
    reseed('header: 作品名　一\n---\n');
    state.quickPickCalls.length = 0;
    answer({ picked: undefined });
    assert.equal(await runEditMeta(key), 0, key);
    const call = state.quickPickCalls[0];
    assert.ok(call, key);
    const items = call.items as readonly { readonly label: string; readonly description: string; readonly value: string | null }[];
    assert.deepEqual(items.map((i) => i.value), [...FURNITURE_ALIGNS, null], key);
    assert.deepEqual(items.map((i) => i.label), labels, key);
    assert.equal(items[5]?.description, dflt, key);
    assert.deepEqual(call.options, { placeHolder }, key);
  }
});

test('the line pickers list what each key offers, the default last, and say what the default shows', async () => {
  const rows = async (key: string): Promise<[string, string | undefined][]> => {
    reseed('title: 作品名\n---\n');
    state.quickPicks.length = 0;
    answer({ picked: [] });
    assert.equal(await runEditMeta(key), 0, key);
    const qp = state.quickPicks[0];
    assert.ok(qp, key);
    return qp.items.map((i) => [i.label, i.description]);
  };
  assert.deepEqual(await rows('header'), [
    ['Title', '［＃ここに「タイトル」の値を表示］'],
    ['Title and chapter number', '［＃ここに「タイトル」の値を表示］　［＃ここに「見出し番号」の値を命数で表示］'],
    ['No header', undefined],
    ['Restore default', '(hidden)'],
  ]);
  assert.deepEqual(await rows('footer'), [['No footer', undefined], ['Restore default', '［＃ここに「ページ番号」の値を表示］ / ［＃ここに「総ページ数」の値を表示］']]);
  assert.deepEqual(await rows('author'), [['Restore default', '(not set)']]);
});

test('"Restore default" on a key no line writes changes nothing and saves nothing', async () => {
  reseed('title: 作品名\n---\na.jpnov\n');
  answer({ picked: [{ pick: 'Restore default' }, 'accept'] });
  assert.equal(await runEditMeta('footer'), 0);
  assert.deepEqual(state.appliedEdits, []);
});

test('a dismissed dialog applies nothing and saves nothing', async () => {
  const cases: readonly (readonly [name: string, key: string, given: Answer])[] = [
    ['a dismissed input box', 'title', { typed: undefined }],
    ['a dismissed header pick', 'header', { picked: undefined }],
    ['a dismissed footer pick', 'footer', { picked: undefined }],
    ['a dismissed divider pick', 'divider', { picked: undefined }],
    ['a dismissed alignment pick', 'headerAlign', { picked: undefined }],
  ];
  for (const [name, key, given] of cases) {
    reseed('header: 作品名　一\n---\na.jpnov\n');
    answer(given);
    const saves = await runEditMeta(key);
    assert.deepEqual(state.appliedEdits, [], name);
    assert.equal(saves, 0, name);
  }
});

test('a refused edit or a failed save is toasted (#90)', async () => {
  const run = (): Promise<void> => removeEntryRow(entryNode('chapters', 2, 'a.jpnov'));

  let saves = 0;
  const book = (save: boolean): void => {
    state.textDocuments.push({ ...doc(BOOK, 'jpbook', `${HEAD}---\na.jpnov\n`), save: () => {
      saves += 1;
      return Promise.resolve(save);
    } });
  };

  book(true);
  state.applyEditResult = false;
  await run();
  assert.deepEqual(state.errorMessages, ["Japanese Novel: couldn't edit book.jpbook."]);
  assert.equal(saves, 0);

  resetMockState(state);
  book(false);
  await run();
  assert.equal(state.appliedEdits.length, 1);
  assert.equal(saves, 1);
  assert.deepEqual(state.errorMessages, ["Japanese Novel: couldn't save book.jpbook."]);
});

// --- the name lists -------------------------------------------------------------

test('addEntries(characters) asks for one name in an input box and opens the list above the fence', async () => {
  seed('title: t\n---\na.jpnov\n', []);
  state.inputBoxQueue.push(' 山田《やまだ》太郎《たろう》 ');
  await runAddFiles('characters');

  assert.deepEqual(state.quickPicks, [], 'no file picker for a name');
  assert.equal(state.inputBoxCalls.length, 1);
  assert.equal(state.inputBoxCalls[0]?.options?.value, '');
  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [2, 0, 2, 0], newText: 'characters:\n  - 山田《やまだ》太郎《たろう》\n' }]);
  assert.deepEqual(state.writtenFiles, []);
  assert.deepEqual(opened(), []);
});

test('addEntries(keywords) extends an open list; a dismissed or empty input box adds nothing', async () => {
  seed('keywords:\n  - 王都\n---\na.jpnov\n', []);
  state.inputBoxQueue.push('聖剣');
  await runAddFiles('keywords');
  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [2, 6, 2, 6], newText: '\n  - 聖剣' }]);
  state.appliedEdits.length = 0;

  state.inputBoxQueue.push(undefined); // Esc
  await runAddFiles('keywords');
  assert.deepEqual(state.appliedEdits, []);
});

test('the name input refuses an empty value, a non-ruby annotation, and a base already in the list', async () => {
  seed('characters:\n  - 山田　太郎\n---\na.jpnov\n', []);
  state.inputBoxQueue.push(undefined);
  await runAddFiles('characters');
  const validate = lastValidator();
  assert.equal(await validate(''), 'Enter a name');
  assert.equal(await validate('  '), 'Enter a name');
  assert.equal(await validate('山田［＃太字］'), 'a name is text and ruby only, no annotation and no 「」『』; this item is ignored: 山田［＃太字］');
  assert.equal(await validate('《やまだ》'), 'a name is text and ruby only, no annotation and no 「」『』; this item is ignored: 《やまだ》');
  assert.equal(await validate('山田《やまだ》太郎《たろう》'), 'Already in this book'); // the same base, another writing
  assert.equal(await validate('山田太郎'), 'Already in this book');
  assert.equal(await validate('山田　花子'), null);
  assert.equal(await validate('John Smith'), null);

  // A keyword's input has its own words; the character list is no obstacle to it.
  state.inputBoxQueue.push(undefined);
  await runAddFiles('keywords');
  const keyword = lastValidator();
  assert.equal(await keyword(''), 'Enter a keyword');
  assert.equal(await keyword('山田太郎'), null);
});

test('editEntry rewrites a name in place, prefilled with the item as written; its own base is no duplicate', async () => {
  seed('characters:\n  - 山田　太郎\n  - 山田　花子\n---\na.jpnov\n', []);
  state.inputBoxQueue.push('山田《やまだ》太郎《たろう》');
  await runEntry(editEntry, 'characters', 2, '山田　太郎');
  assert.equal(state.inputBoxCalls[0]?.options?.value, '山田　太郎');
  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [2, 4, 2, 9], newText: '山田《やまだ》太郎《たろう》' }]);
  const validate = lastValidator();
  assert.equal(await validate('山田太郎'), null, 'the row being edited is not its own duplicate');
  assert.equal(await validate('山田　花子'), 'Already in this book');
  state.appliedEdits.length = 0;

  // A stale row, or a row of a file list, plans nothing.
  state.inputBoxQueue.push('x');
  await runEntry(editEntry, 'characters', 2, '山田　太郎', 2);
  state.inputBoxQueue.push('x');
  await runEntry(editEntry, 'chapters', 5, 'a.jpnov');
  assert.deepEqual(state.appliedEdits, []);
});

test('removeEntryRow / moveEntry work on a name list like any other', async () => {
  seed('characters:\n  - 山田　太郎\n  - 山田　花子\n---\na.jpnov\n', []);
  await runEntry(removeEntryRow, 'characters', 2, '山田　太郎');
  assert.deepEqual(state.appliedEdits, [{ uri: BOOK, range: [2, 0, 3, 0], newText: '' }]);
  state.appliedEdits.length = 0;
  await runMove('characters', 2, '山田　太郎', null);
  assert.deepEqual(state.appliedEdits, [
    { uri: BOOK, range: [2, 0, 3, 0], newText: '' },
    { uri: BOOK, range: [3, 9, 3, 9], newText: '\n  - 山田　太郎' },
  ]);
});
