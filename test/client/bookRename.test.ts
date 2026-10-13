import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeFsPath, planBookEdits as planWhole, type FileRename } from '../../src/client/book/rename.ts';
import { HEAD } from '../shared/book/_fixture.ts';

/** The book's path after the event: entries count from its folder, `/ws/novel`. */
const BOOK = '/ws/novel/vol1.jpbook';
/** The planner over `HEAD + text`, its edit lines counted from below the header like the fixtures. */
const planBookEdits = (book: string, text: string, renames: readonly FileRename[]): ReturnType<typeof planWhole> =>
  planWhole(book, HEAD + text, renames).map((e) => ({ ...e, line: e.line - 1 }));
const R = (oldPath: string, newPath: string): FileRename => ({ oldPath, newPath });
/** Chapter lines below an empty metadata block: the fence is line 0, so the chapters start at line 1. */
const below = (chapters: string): string => `---\n${chapters}`;

test('a file rename rewrites exactly the path span (whitespace preserved)', () => {
  const edits = planBookEdits(BOOK, below('　a.jpnov  \nb.jpnov'), [R('/ws/novel/a.jpnov', '/ws/novel/z.jpnov')]);
  assert.deepEqual(edits, [{ line: 1, startChar: 1, endChar: 8, newText: 'z.jpnov' }]);
});

test('a move into a subfolder rewrites to the deeper relative path', () => {
  const edits = planBookEdits(BOOK, below('a.jpnov'), [R('/ws/novel/a.jpnov', '/ws/novel/ch/a.jpnov')]);
  assert.equal(edits[0]?.newText, 'ch/a.jpnov');
});

test('a folder rename matches by prefix and rewrites every entry under it', () => {
  const edits = planBookEdits(BOOK, below('ch/01.jpnov\nother.jpnov\nch/02.jpnov'), [
    R('/ws/novel/ch', '/ws/novel/chapters'),
  ]);
  assert.deepEqual(edits.map((e) => [e.line, e.newText]), [
    [1, 'chapters/01.jpnov'],
    [3, 'chapters/02.jpnov'],
  ]);
});

test('prefix matching is segment-exact: renaming ch never touches chx/', () => {
  const edits = planBookEdits(BOOK, below('chx/a.jpnov'), [R('/ws/novel/ch', '/ws/novel/chapters')]);
  assert.deepEqual(edits, []);
});

test('a moved book rewrites its entries so they keep naming the same files', () => {
  const edits = planBookEdits('/ws/novel/books/vol1.jpbook', below('ch/01.jpnov\nch/02.jpnov'), [
    R('/ws/novel/vol1.jpbook', '/ws/novel/books/vol1.jpbook'),
  ]);
  assert.deepEqual(edits.map((e) => [e.line, e.newText]), [[1, '../ch/01.jpnov'], [2, '../ch/02.jpnov']]);
});

test('a book moved along with its chapters needs no edit', () => {
  const edits = planBookEdits('/ws/archive/novel/vol1.jpbook', below('ch/01.jpnov\n../shared/x.jpnov'), [
    R('/ws/novel', '/ws/archive/novel'),
  ]);
  // `ch/01.jpnov` moved with the book; `../shared/x.jpnov` now sits one level further up.
  assert.deepEqual(edits.map((e) => [e.line, e.newText]), [[2, '../../shared/x.jpnov']]);
});

test('a move out of the workspace folder is written with ../', () => {
  const edits = planBookEdits(BOOK, below('a.jpnov\nb.jpnov'), [R('/ws/novel/a.jpnov', '/elsewhere/a.jpnov')]);
  assert.deepEqual(edits, [{ line: 1, startChar: 0, endChar: 7, newText: '../../elsewhere/a.jpnov' }]);
});

test('an entry above the book follows its file like any other', () => {
  const edits = planBookEdits(BOOK, below('../drafts/a.jpnov'), [R('/ws/drafts/a.jpnov', '/ws/final/a.jpnov')]);
  assert.deepEqual(edits.map((e) => e.newText), ['../final/a.jpnov']);
});

test('duplicate lines follow the rename along with the ok line', () => {
  const edits = planBookEdits(BOOK, below('a.jpnov\na.jpnov'), [R('/ws/novel/a.jpnov', '/ws/novel/b.jpnov')]);
  assert.deepEqual(edits.map((e) => e.line), [1, 2]);
});

test('metadata, fence and error lines are never rewritten', () => {
  const text = 'title: a.jpnov\n---\nnote.md\na.jpnov';
  const edits = planBookEdits(BOOK, text, [R('/ws/novel/a.jpnov', '/ws/novel/b.jpnov')]);
  assert.deepEqual(edits, [{ line: 3, startChar: 0, endChar: 7, newText: 'b.jpnov' }]);
});

test('a ./-style entry still matches; the rewrite canonicalizes it, and an untouched one is left as written', () => {
  const edits = planBookEdits(BOOK, below('./a.jpnov\n./b.jpnov'), [R('/ws/novel/a.jpnov', '/ws/novel/c.jpnov')]);
  assert.deepEqual(edits.map((e) => [e.line, e.newText]), [[1, 'c.jpnov']]);
});

test('a rename onto a non-.jpnov name is still written (diagnostics flag the line after)', () => {
  const edits = planBookEdits(BOOK, below('a.jpnov'), [R('/ws/novel/a.jpnov', '/ws/novel/a.txt')]);
  assert.equal(edits[0]?.newText, 'a.txt');
});

test('several renames in one event apply together; another book plans empty', () => {
  const renames = [
    R('/ws/novel/a.jpnov', '/ws/novel/x.jpnov'),
    R('/ws/novel/sub', '/ws/novel/part1'),
  ];
  const edits = planBookEdits(BOOK, below('a.jpnov\nsub/b.jpnov'), renames);
  assert.deepEqual(edits.map((e) => e.newText), ['x.jpnov', 'part1/b.jpnov']);

  assert.deepEqual(planBookEdits('/ws/other/vol.jpbook', below('c.jpnov'), renames), []);
});

test('CRLF lines keep the span clear of the \\r', () => {
  const edits = planBookEdits(BOOK, '---\r\na.jpnov\r\n', [R('/ws/novel/a.jpnov', '/ws/novel/b.jpnov')]);
  assert.deepEqual(edits, [{ line: 1, startChar: 0, endChar: 7, newText: 'b.jpnov' }]);
});

test('normalizeFsPath flips Windows separators only', () => {
  assert.equal(normalizeFsPath('C:\\ws\\novel\\a.jpnov'), 'C:/ws/novel/a.jpnov');
  assert.equal(normalizeFsPath('/ws/novel/a.jpnov'), '/ws/novel/a.jpnov');
});

test('cover entries rename too, the "- " / "cover: " marker surviving untouched', () => {
  const text = ['cover: src/c0.jpnov', '  - src/c1.jpnov', '  - src/c1.jpnov', '---', 'src/a.jpnov'].join('\n');
  const edits = planBookEdits(BOOK, text, [R('/ws/novel/src', '/ws/novel/前付')]);
  // The duplicate moves too — it must keep duplicating what it did.
  assert.deepEqual(edits, [
    { line: 0, startChar: 7, endChar: 19, newText: '前付/c0.jpnov' },
    { line: 1, startChar: 4, endChar: 16, newText: '前付/c1.jpnov' },
    { line: 2, startChar: 4, endChar: 16, newText: '前付/c1.jpnov' },
    { line: 4, startChar: 0, endChar: 11, newText: '前付/a.jpnov' },
  ]);
});

test('a single-file cover list renames like any other item', () => {
  const edits = planBookEdits(BOOK, 'cover:\n- c.jpnov\n---\na.jpnov', [
    R('/ws/novel/c.jpnov', '/ws/novel/front/c.jpnov'),
  ]);
  assert.deepEqual(edits, [{ line: 1, startChar: 2, endChar: 9, newText: 'front/c.jpnov' }]);
});

test('cover lines the parser rejected are never rewritten', () => {
  // Orphan and muted items are problem lines, so neither is rewritten.
  const text = ['title: t', '- c.jpnov', 'cover:', '- c.jpnov', 'cover:', '- c.jpnov', '---'].join('\n');
  const edits = planBookEdits(BOOK, text, [R('/ws/novel/c.jpnov', '/ws/novel/z.jpnov')]);
  assert.deepEqual(edits.map((e) => e.line), [3]); // only the one real cover entry
});
