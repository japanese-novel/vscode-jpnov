import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeFsPath, planBookEdits as planWhole, type FileRename } from '../../src/client/book/rename.ts';
import { HEAD } from '../shared/book/_fixture.ts';

const ROOT = '/ws/novel';
/** The planner over `HEAD + text`, its edit lines counted from below the header like the fixtures. */
const planBookEdits = (root: string, text: string, renames: readonly FileRename[]): ReturnType<typeof planWhole> => {
  const plan = planWhole(root, HEAD + text, renames);
  return { ...plan, edits: plan.edits.map((e) => ({ ...e, line: e.line - 1 })) };
};
const R = (oldPath: string, newPath: string): FileRename => ({ oldPath, newPath });
/** Chapter lines below an empty metadata block: the fence is line 0, so the chapters start at line 1. */
const below = (chapters: string): string => `---\n${chapters}`;

test('a file rename rewrites exactly the path span (whitespace preserved)', () => {
  const plan = planBookEdits(ROOT, below('　a.jpnov  \nb.jpnov'), [R('/ws/novel/a.jpnov', '/ws/novel/z.jpnov')]);
  assert.deepEqual(plan, {
    edits: [{ line: 1, startChar: 1, endChar: 8, newText: 'z.jpnov' }],
    unrepresentable: [],
  });
});

test('a move into a subfolder rewrites to the deeper relative path', () => {
  const plan = planBookEdits(ROOT, below('a.jpnov'), [R('/ws/novel/a.jpnov', '/ws/novel/ch/a.jpnov')]);
  assert.equal(plan.edits[0]?.newText, 'ch/a.jpnov');
});

test('a folder rename matches by prefix and rewrites every entry under it', () => {
  const plan = planBookEdits(ROOT, below('ch/01.jpnov\nother.jpnov\nch/02.jpnov'), [
    R('/ws/novel/ch', '/ws/novel/chapters'),
  ]);
  assert.deepEqual(plan.edits.map((e) => [e.line, e.newText]), [
    [1, 'chapters/01.jpnov'],
    [3, 'chapters/02.jpnov'],
  ]);
});

test('prefix matching is segment-exact: renaming ch never touches chx/', () => {
  const plan = planBookEdits(ROOT, below('chx/a.jpnov'), [R('/ws/novel/ch', '/ws/novel/chapters')]);
  assert.deepEqual(plan.edits, []);
});

test('moving the .jpbook itself never touches its entries (root-relative by design)', () => {
  // Moving the .jpbook itself must not invalidate entries — they are root-relative, not book-relative.
  const plan = planBookEdits(ROOT, below('ch/01.jpnov\nch/02.jpnov'), [
    R('/ws/novel/vol1.jpbook', '/ws/novel/books/vol1.jpbook'),
  ]);
  assert.deepEqual(plan, { edits: [], unrepresentable: [] });
});

test('a move OUT of the workspace folder is unrepresentable, never rewritten', () => {
  const plan = planBookEdits(ROOT, below('a.jpnov\nb.jpnov'), [R('/ws/novel/a.jpnov', '/elsewhere/a.jpnov')]);
  assert.deepEqual(plan.edits, []);
  assert.deepEqual(plan.unrepresentable, ['a.jpnov']);
});

test('duplicate lines follow the rename along with the ok line', () => {
  const plan = planBookEdits(ROOT, below('a.jpnov\na.jpnov'), [R('/ws/novel/a.jpnov', '/ws/novel/b.jpnov')]);
  assert.deepEqual(plan.edits.map((e) => e.line), [1, 2]);
});

test('metadata, fence and error lines are never rewritten', () => {
  const text = 'title: a.jpnov\n---\nnote.md\na.jpnov';
  const plan = planBookEdits(ROOT, text, [R('/ws/novel/a.jpnov', '/ws/novel/b.jpnov')]);
  assert.deepEqual(plan.edits, [{ line: 3, startChar: 0, endChar: 7, newText: 'b.jpnov' }]);
});

test('a ./-style entry still matches; the rewrite canonicalizes it', () => {
  const plan = planBookEdits(ROOT, below('./a.jpnov'), [R('/ws/novel/a.jpnov', '/ws/novel/b.jpnov')]);
  assert.equal(plan.edits[0]?.newText, 'b.jpnov');
});

test('a rename onto a non-.jpnov name is still written (diagnostics flag the line after)', () => {
  const plan = planBookEdits(ROOT, below('a.jpnov'), [R('/ws/novel/a.jpnov', '/ws/novel/a.txt')]);
  assert.equal(plan.edits[0]?.newText, 'a.txt');
});

test('several renames in one event apply together; other roots plan empty', () => {
  const renames = [
    R('/ws/novel/a.jpnov', '/ws/novel/x.jpnov'),
    R('/ws/novel/sub', '/ws/novel/part1'),
  ];
  const plan = planBookEdits(ROOT, below('a.jpnov\nsub/b.jpnov'), renames);
  assert.deepEqual(plan.edits.map((e) => e.newText), ['x.jpnov', 'part1/b.jpnov']);

  const untouched = planBookEdits('/ws/other', below('c.jpnov'), renames);
  assert.deepEqual(untouched, { edits: [], unrepresentable: [] });
});

test('CRLF lines keep the span clear of the \\r', () => {
  const plan = planBookEdits(ROOT, '---\r\na.jpnov\r\n', [R('/ws/novel/a.jpnov', '/ws/novel/b.jpnov')]);
  assert.deepEqual(plan.edits, [{ line: 1, startChar: 0, endChar: 7, newText: 'b.jpnov' }]);
});

test('normalizeFsPath flips Windows separators only', () => {
  assert.equal(normalizeFsPath('C:\\ws\\novel\\a.jpnov'), 'C:/ws/novel/a.jpnov');
  assert.equal(normalizeFsPath('/ws/novel/a.jpnov'), '/ws/novel/a.jpnov');
});

test('cover entries rename too, the "- " / "cover: " marker surviving untouched', () => {
  const text = ['cover:', '  - src/c1.jpnov', '  - src/c1.jpnov', '---', 'src/a.jpnov'].join('\n');
  const plan = planBookEdits(ROOT, text, [R('/ws/novel/src', '/ws/novel/前付')]);
  // The duplicate moves too — it must keep duplicating what it did.
  assert.deepEqual(plan.edits, [
    { line: 1, startChar: 4, endChar: 16, newText: '前付/c1.jpnov' },
    { line: 2, startChar: 4, endChar: 16, newText: '前付/c1.jpnov' },
    { line: 4, startChar: 0, endChar: 11, newText: '前付/a.jpnov' },
  ]);
});

test('a single-file cover list renames like any other item', () => {
  const plan = planBookEdits(ROOT, 'cover:\n- c.jpnov\n---\na.jpnov', [
    R('/ws/novel/c.jpnov', '/ws/novel/front/c.jpnov'),
  ]);
  assert.deepEqual(plan.edits, [{ line: 1, startChar: 2, endChar: 9, newText: 'front/c.jpnov' }]);
});

test('a cover leaving the workspace folder is reported, never rewritten', () => {
  const plan = planBookEdits(ROOT, 'cover:\n- c.jpnov\n---\na.jpnov', [
    R('/ws/novel/c.jpnov', '/elsewhere/c.jpnov'),
  ]);
  assert.deepEqual(plan, { edits: [], unrepresentable: ['c.jpnov'] });
});

test('cover lines the parser rejected are never rewritten', () => {
  // Orphan and muted items are problem lines, so neither is rewritten.
  const text = ['title: t', '- c.jpnov', 'cover:', '- c.jpnov', 'cover:', '- c.jpnov', '---'].join('\n');
  const plan = planBookEdits(ROOT, text, [R('/ws/novel/c.jpnov', '/ws/novel/z.jpnov')]);
  assert.deepEqual(plan.edits.map((e) => e.line), [3]); // only the one real cover entry
});
