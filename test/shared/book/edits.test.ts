import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendEntries,
  entryLines,
  listedEntries,
  metaRows,
  moveEntryTo,
  removeEntry,
  resolveEntry,
  upsertMeta,
} from '../../../src/shared/book/edits.ts';
import { META_KEYS, parseJpbook, type EntryList } from '../../../src/shared/book/jpbook.ts';

/** Applies LSP-style replaces to `text` (offsets computed per line) — the test's oracle. */
function apply(text: string, replaces: readonly { start: { line: number; character: number }; end: { line: number; character: number }; newText: string }[]): string {
  const offsets: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      offsets.push(i + 1);
    }
  }
  const abs = (p: { line: number; character: number }): number => (offsets[p.line] ?? text.length) + p.character;
  const sorted = [...replaces].sort((a, b) => abs(b.start) - abs(a.start));
  let out = text;
  for (const r of sorted) {
    out = out.slice(0, abs(r.start)) + r.newText + out.slice(abs(r.end));
  }
  return out;
}

// --- upsertMeta ---------------------------------------------------------------

test('upsertMeta rewrites an existing key in place (line position and neighbours untouched)', () => {
  const text = '---\ntitle: 一\nheader: 柱\n---\na.jpnov\n';
  const out = apply(text, [upsertMeta(text, 'title', '二')]);
  assert.equal(out, '---\ntitle: 二\nheader: 柱\n---\na.jpnov\n');
});

test('upsertMeta rewrites the WINNING (first) occurrence and normalizes a full-width colon', () => {
  const text = '---\ntitle：古い\ntitle: 負け\n---\n';
  const out = apply(text, [upsertMeta(text, 'title', '新しい')]);
  assert.equal(out, '---\ntitle: 新しい\ntitle: 負け\n---\n');
});

test('upsertMeta appends an absent key before the closing fence (no reordering)', () => {
  const text = '---\nheader: 柱\n---\na.jpnov\n';
  const out = apply(text, [upsertMeta(text, 'pageNumber', 'none')]);
  assert.equal(out, '---\nheader: 柱\npageNumber: none\n---\na.jpnov\n');
});

test('upsertMeta creates the front matter when the file has none', () => {
  const text = 'a.jpnov\n';
  const out = apply(text, [upsertMeta(text, 'title', '第一巻')]);
  assert.equal(out, '---\ntitle: 第一巻\n---\na.jpnov\n');
  assert.deepEqual(parseJpbook(out).meta, { title: '第一巻' });
});

test('upsertMeta creates the block even in an empty document', () => {
  const out = apply('', [upsertMeta('', 'header', '柱')]);
  assert.equal(out, '---\nheader: 柱\n---\n');
});

test('upsertMeta appends inside an UNTERMINATED block (still metadata territory)', () => {
  const text = '---\ntitle: t';
  const out = apply(text, [upsertMeta(text, 'header', '柱')]);
  assert.equal(out, '---\ntitle: t\nheader: 柱');
  assert.deepEqual(parseJpbook(out).meta, { title: 't', header: '柱' });
});

test('upsertMeta keeps an explicitly-default or empty value (upsert never deletes)', () => {
  const text = '---\npageNumber: left\n---\n';
  const out = apply(text, [upsertMeta(text, 'pageNumber', 'right')]);
  assert.equal(out, '---\npageNumber: right\n---\n');
  const cleared = apply(out, [upsertMeta(out, 'header', '')]);
  assert.equal(cleared, '---\npageNumber: right\nheader:\n---\n');
});

test('upsertMeta sanitizes pasted newlines and edge whitespace out of the value', () => {
  const out = apply('', [upsertMeta('', 'title', '  一\n二  ')]);
  assert.equal(out, '---\ntitle: 一 二\n---\n');
});

test('upsertMeta follows a CRLF document', () => {
  const text = '---\r\ntitle: t\r\n---\r\n';
  const out = apply(text, [upsertMeta(text, 'header', '柱')]);
  assert.equal(out, '---\r\ntitle: t\r\nheader: 柱\r\n---\r\n');
});

// --- appendEntries (chapters) -------------------------------------------------------------

test('appendEntries(chapters) appends at EOF and skips already-listed paths', () => {
  const text = '---\ntitle: t\n---\na.jpnov\n';
  const edit = appendEntries(text, 'chapters', ['a.jpnov', 'ch/b.jpnov', 'c.jpnov']);
  assert.ok(edit);
  assert.equal(apply(text, [edit]), '---\ntitle: t\n---\na.jpnov\nch/b.jpnov\nc.jpnov\n');
});

test('appendEntries(chapters) returns null when everything is already listed', () => {
  assert.equal(appendEntries('a.jpnov\n', 'chapters', ['a.jpnov']), null);
});

test('appendEntries(chapters) handles a document without a trailing newline', () => {
  const edit = appendEntries('a.jpnov', 'chapters', ['b.jpnov']);
  assert.ok(edit);
  assert.equal(apply('a.jpnov', [edit]), 'a.jpnov\nb.jpnov');
});

// --- removeEntry (chapters) ---------------------------------------------------------------

test('removeEntry(chapters) deletes the whole line, trailing newline included', () => {
  const text = 'a.jpnov\nb.jpnov\nc.jpnov\n';
  const edit = removeEntry(text, 'chapters', 1);
  assert.ok(edit);
  assert.equal(apply(text, [edit]), 'a.jpnov\nc.jpnov\n');
});

test('removeEntry(chapters) of the final line swallows the PRECEDING newline', () => {
  const text = 'a.jpnov\nb.jpnov';
  const edit = removeEntry(text, 'chapters', 1);
  assert.ok(edit);
  assert.equal(apply(text, [edit]), 'a.jpnov');
});

test('removeEntry(chapters) refuses non-chapter lines', () => {
  const text = '---\ntitle: t\n---\na.jpnov\n';
  assert.equal(removeEntry(text, 'chapters', 1), null);
  assert.equal(removeEntry(text, 'chapters', 0), null);
});

// --- moveEntryTo (chapters) ----------------------------------------------------------------

test('moveEntryTo(chapters) moves a chapter before another; blanks and metadata stay put', () => {
  const text = '---\ntitle: t\n---\na.jpnov\n\nb.jpnov\nc.jpnov\n';
  const edits = moveEntryTo(text, 'chapters', 6, 3); // c before a
  assert.ok(edits);
  assert.equal(apply(text, edits), '---\ntitle: t\n---\nc.jpnov\na.jpnov\n\nb.jpnov\n');
});

test('moveEntryTo(chapters, null) moves a chapter after the last one', () => {
  const text = 'a.jpnov\nb.jpnov\nc.jpnov\n';
  const edits = moveEntryTo(text, 'chapters', 0, null);
  assert.ok(edits);
  assert.equal(apply(text, edits), 'b.jpnov\nc.jpnov\na.jpnov\n');
});

test('moveEntryTo(chapters) returns null for no-ops and non-chapters', () => {
  const text = 'a.jpnov\nb.jpnov\n';
  assert.equal(moveEntryTo(text, 'chapters', 0, 0), null);
  assert.equal(moveEntryTo(text, 'chapters', 0, 1), null); // already directly above
  assert.equal(moveEntryTo(text, 'chapters', 1, null), null); // already last
  assert.equal(moveEntryTo(text, 'chapters', 5, 0), null);
});

test('moveEntryTo(chapters) treats a blank line between chapters as still-adjacent (no-op)', () => {
  // a (line 3) already precedes b (line 5) in chapter order, with a blank at line 4; moving a
  // before b must be a no-op, not a spurious edit that relocates the blank line.
  const text = '---\ntitle: t\n---\na.jpnov\n\nb.jpnov\nc.jpnov\n';
  assert.equal(moveEntryTo(text, 'chapters', 3, 5), null);
});

// --- panel projections ---------------------------------------------------------

test('entryLines(chapters) and metaRows project the panel model in fixed order', () => {
  const text = '---\nheader: 柱\n---\na.jpnov\nnote.md\nb.jpnov\n';
  const parsed = parseJpbook(text);
  assert.deepEqual(entryLines(parsed.lines, 'chapters'), [3, 5]);
  assert.deepEqual(metaRows(parsed.meta), [
    { key: 'title', value: undefined },
    { key: 'author', value: undefined },
    { key: 'header', value: '柱' },
    { key: 'pageNumber', value: undefined },
    { key: 'pageNumberFormat', value: undefined },
    { key: 'divider', value: undefined },
  ]);
});

test('upsertMeta never splits a cover list: an absent key still lands before the fence', () => {
  const text = ['---', 'title: 一', 'cover:', '  - c1.jpnov', '  - c2.jpnov', '---', 'a.jpnov'].join('\n');
  const out = apply(text, [upsertMeta(text, 'header', '柱')]);
  assert.equal(out, ['---', 'title: 一', 'cover:', '  - c1.jpnov', '  - c2.jpnov', 'header: 柱', '---', 'a.jpnov'].join('\n'));
  // The list still parses as one contiguous block after the edit.
  assert.deepEqual(
    parseJpbook(out).lines.map((l) => l.kind),
    ['fence', 'meta', 'cover', 'coverEntry', 'coverEntry', 'meta', 'fence', 'ok'],
  );
});

test('a cover list never leaks into the metadata the panel edits', () => {
  const text = ['---', 'title: 一', 'cover:', '  - c1.jpnov', '---', 'a.jpnov'].join('\n');
  // The list lives in the LINE KINDS, so the panel's six single-line rows stay complete.
  assert.deepEqual(parseJpbook(text).meta, { title: '一' });
  assert.deepEqual(metaRows(parseJpbook(text).meta).map((r) => r.key), [...META_KEYS]);
});

// --- cover list planners ---------------------------------------------------------

/** Line kinds with object kinds collapsed to their severity, so fixtures can pin the shape. */
function kindsOf(text: string): string[] {
  return parseJpbook(text).lines.map((l) => (typeof l.kind === 'string' ? l.kind : 'error' in l.kind ? 'error' : 'warning'));
}

test('appendEntries(covers) inserts after the last item, mirroring its indent and marker', () => {
  const text = ['---', 'title: 一', 'cover:', '  - c1.jpnov', '---', 'a.jpnov', ''].join('\n');
  const edit = appendEntries(text, 'covers', ['c1.jpnov', 'c2.jpnov', 'sub/c3.jpnov']);
  assert.deepEqual(edit, { start: { line: 3, character: 12 }, end: { line: 3, character: 12 }, newText: '\n  - c2.jpnov\n  - sub/c3.jpnov' });
  const out = apply(text, [edit]);
  assert.equal(out, ['---', 'title: 一', 'cover:', '  - c1.jpnov', '  - c2.jpnov', '  - sub/c3.jpnov', '---', 'a.jpnov', ''].join('\n'));
  assert.deepEqual(kindsOf(out), ['fence', 'meta', 'cover', 'coverEntry', 'coverEntry', 'coverEntry', 'fence', 'ok', 'blank']);
});

test('appendEntries(covers) follows the existing marker style', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['---\ncover:\n－c1.jpnov\n---\n', '---\ncover:\n－c1.jpnov\n－c2.jpnov\n---\n'],
    ['---\ncover:\n- c1.jpnov\n---\n', '---\ncover:\n- c1.jpnov\n- c2.jpnov\n---\n'],
    ['---\ncover:\n\t- c1.jpnov\n---\n', '---\ncover:\n\t- c1.jpnov\n\t- c2.jpnov\n---\n'],
  ];
  for (const [text, expected] of cases) {
    const edit = appendEntries(text, 'covers', ['c2.jpnov']);
    assert.ok(edit);
    assert.equal(apply(text, [edit]), expected, text);
  }
});

test('appendEntries(covers) anchors an empty list on its key line with the default prefix', () => {
  const text = '---\ncover:\n---\na.jpnov\n';
  const edit = appendEntries(text, 'covers', ['x.jpnov']);
  assert.deepEqual(edit, { start: { line: 1, character: 6 }, end: { line: 1, character: 6 }, newText: '\n  - x.jpnov' });
  assert.equal(apply(text, [edit]), '---\ncover:\n  - x.jpnov\n---\na.jpnov\n');
});

test('appendEntries(covers) without a key adds one before the closing fence', () => {
  const text = '---\ntitle: t\n---\na.jpnov\n';
  const edit = appendEntries(text, 'covers', ['x.jpnov']);
  assert.deepEqual(edit, { start: { line: 2, character: 0 }, end: { line: 2, character: 0 }, newText: 'cover:\n  - x.jpnov\n' });
  assert.equal(apply(text, [edit]), '---\ntitle: t\ncover:\n  - x.jpnov\n---\na.jpnov\n');
});

test('appendEntries(covers) creates the front matter when the file has none', () => {
  const text = 'a.jpnov\n';
  const edit = appendEntries(text, 'covers', ['x.jpnov']);
  assert.ok(edit);
  const out = apply(text, [edit]);
  assert.equal(out, '---\ncover:\n  - x.jpnov\n---\na.jpnov\n');
  assert.deepEqual(kindsOf(out), ['fence', 'cover', 'coverEntry', 'fence', 'ok', 'blank']);
  const empty = appendEntries('', 'covers', ['x.jpnov']);
  assert.ok(empty);
  assert.equal(apply('', [empty]), '---\ncover:\n  - x.jpnov\n---\n');
});

test('appendEntries(covers) stays inside an UNTERMINATED block', () => {
  const noKey = '---\ntitle: t';
  const e1 = appendEntries(noKey, 'covers', ['x.jpnov']);
  assert.ok(e1);
  const out = apply(noKey, [e1]);
  assert.equal(out, '---\ntitle: t\ncover:\n  - x.jpnov');
  assert.deepEqual(kindsOf(out), ['error', 'meta', 'cover', 'coverEntry']);
  const withKey = '---\ncover:\n  - a.jpnov';
  const e2 = appendEntries(withKey, 'covers', ['b.jpnov']);
  assert.ok(e2);
  assert.equal(apply(withKey, [e2]), '---\ncover:\n  - a.jpnov\n  - b.jpnov');
});

test('appendEntries(covers) follows a CRLF document', () => {
  const withKey = '---\r\ncover:\r\n  - a.jpnov\r\n---\r\n';
  const e1 = appendEntries(withKey, 'covers', ['b.jpnov']);
  assert.ok(e1);
  assert.equal(apply(withKey, [e1]), '---\r\ncover:\r\n  - a.jpnov\r\n  - b.jpnov\r\n---\r\n');
  const noKey = '---\r\ntitle: t\r\n---\r\n';
  const e2 = appendEntries(noKey, 'covers', ['b.jpnov']);
  assert.ok(e2);
  assert.equal(apply(noKey, [e2]), '---\r\ntitle: t\r\ncover:\r\n  - b.jpnov\r\n---\r\n');
});

test('appendEntries(covers) leaves a `cover: value` error line alone and opens a real list', () => {
  const text = '---\ncover: a.jpnov\n---\n';
  const edit = appendEntries(text, 'covers', ['b.jpnov']);
  assert.ok(edit);
  const out = apply(text, [edit]);
  assert.equal(out, '---\ncover: a.jpnov\ncover:\n  - b.jpnov\n---\n');
  assert.deepEqual(kindsOf(out), ['fence', 'error', 'cover', 'coverEntry', 'fence', 'blank']);
});

test('appendEntries(covers) extends the OPEN list; a muted second list is neither anchor nor dedupe source', () => {
  const text = '---\ncover:\n  - a.jpnov\ncover:\n  - m.jpnov\n---\n';
  const edit = appendEntries(text, 'covers', ['b.jpnov', 'm.jpnov']);
  assert.deepEqual(edit, { start: { line: 2, character: 11 }, end: { line: 2, character: 11 }, newText: '\n  - b.jpnov\n  - m.jpnov' });
  const out = apply(text, [edit]);
  assert.equal(out, '---\ncover:\n  - a.jpnov\n  - b.jpnov\n  - m.jpnov\ncover:\n  - m.jpnov\n---\n');
  assert.deepEqual(kindsOf(out), ['fence', 'cover', 'coverEntry', 'coverEntry', 'coverEntry', 'warning', 'warning', 'fence', 'blank']);
});

test('the two lists dedupe independently (a file may be both a cover and a chapter)', () => {
  const text = '---\ncover:\n  - a.jpnov\n---\na.jpnov\nb.jpnov\n';
  const covers = appendEntries(text, 'covers', ['a.jpnov', 'b.jpnov']);
  assert.deepEqual(covers, { start: { line: 2, character: 11 }, end: { line: 2, character: 11 }, newText: '\n  - b.jpnov' });
  assert.equal(appendEntries(text, 'chapters', ['a.jpnov', 'b.jpnov']), null);
  const coverOnly = '---\ncover:\n  - a.jpnov\n---\n';
  const chapter = appendEntries(coverOnly, 'chapters', ['a.jpnov']);
  assert.ok(chapter);
  assert.equal(apply(coverOnly, [chapter]), '---\ncover:\n  - a.jpnov\n---\na.jpnov\n');
});

test('a coverDuplicate item counts as listed and as a row', () => {
  const text = '---\ncover:\n  - a.jpnov\n  - a.jpnov\n---\n';
  assert.equal(appendEntries(text, 'covers', ['a.jpnov']), null);
  assert.deepEqual(entryLines(parseJpbook(text).lines, 'covers'), [2, 3]);
});

test('removeEntry(covers) deletes the item and keeps the bare key', () => {
  const text = '---\ncover:\n  - a.jpnov\n---\nx.jpnov\n';
  const edit = removeEntry(text, 'covers', 2);
  assert.deepEqual(edit, { start: { line: 2, character: 0 }, end: { line: 3, character: 0 }, newText: '' });
  const out = apply(text, [edit]);
  assert.equal(out, '---\ncover:\n---\nx.jpnov\n');
  assert.deepEqual(kindsOf(out), ['fence', 'cover', 'fence', 'ok', 'blank']);
});

test('removeEntry(covers) of the final document line swallows the PRECEDING newline', () => {
  const text = '---\ncover:\n  - a.jpnov';
  const edit = removeEntry(text, 'covers', 2);
  assert.deepEqual(edit, { start: { line: 1, character: 6 }, end: { line: 2, character: 11 }, newText: '' });
  assert.equal(apply(text, [edit]), '---\ncover:');
});

test('removeEntry refuses the other list, the key line and the fences', () => {
  const text = '---\ncover:\n  - a.jpnov\n---\nx.jpnov\n';
  assert.equal(removeEntry(text, 'chapters', 2), null);
  assert.equal(removeEntry(text, 'covers', 4), null);
  assert.equal(removeEntry(text, 'covers', 1), null);
  assert.equal(removeEntry(text, 'covers', 0), null);
});

test('moveEntryTo(covers) moves an item before another; blanks stay put', () => {
  const text = '---\ncover:\n  - a.jpnov\n\n  - b.jpnov\n  - c.jpnov\n---\nx.jpnov\n';
  const edits = moveEntryTo(text, 'covers', 5, 2); // c before a
  assert.deepEqual(edits, [
    { start: { line: 5, character: 0 }, end: { line: 6, character: 0 }, newText: '' },
    { start: { line: 2, character: 0 }, end: { line: 2, character: 0 }, newText: '  - c.jpnov\n' },
  ]);
  assert.equal(apply(text, edits), '---\ncover:\n  - c.jpnov\n  - a.jpnov\n\n  - b.jpnov\n---\nx.jpnov\n');
});

test('moveEntryTo(covers, null) moves an item after the last one, still inside the list', () => {
  const text = '---\ncover:\n  - a.jpnov\n\n  - b.jpnov\n  - c.jpnov\n---\nx.jpnov\n';
  const edits = moveEntryTo(text, 'covers', 2, null);
  assert.deepEqual(edits, [
    { start: { line: 2, character: 0 }, end: { line: 3, character: 0 }, newText: '' },
    { start: { line: 5, character: 11 }, end: { line: 5, character: 11 }, newText: '\n  - a.jpnov' },
  ]);
  assert.equal(apply(text, edits), '---\ncover:\n\n  - b.jpnov\n  - c.jpnov\n  - a.jpnov\n---\nx.jpnov\n');
});

test('moveEntryTo returns null for no-ops and for lines of the other list', () => {
  const text = '---\ncover:\n  - a.jpnov\n\n  - b.jpnov\n  - c.jpnov\n---\nx.jpnov\n';
  assert.equal(moveEntryTo(text, 'covers', 2, 2), null); // onto itself
  assert.equal(moveEntryTo(text, 'covers', 2, 4), null); // already directly above (across a blank)
  assert.equal(moveEntryTo(text, 'covers', 5, null), null); // already last
  assert.equal(moveEntryTo(text, 'covers', 7, 2), null); // a chapter as the mover
  assert.equal(moveEntryTo(text, 'covers', 2, 7), null); // a chapter as the target
  assert.equal(moveEntryTo(text, 'chapters', 2, null), null); // a cover under the chapter list
});

// --- resolveEntry (the panel row → live line check) --------------------------------------

test('resolveEntry accepts a row only where its list still has that path on that line', () => {
  const lines = parseJpbook('---\ncover:\n  - c.jpnov\n－d.jpnov\n---\na.jpnov\nb.jpnov\n').lines;
  assert.equal(resolveEntry(lines, 'chapters', { line: 5, path: 'a.jpnov' }), 5);
  assert.equal(resolveEntry(lines, 'chapters', { line: 6, path: 'a.jpnov' }), null); // the row slid
  assert.equal(resolveEntry(lines, 'covers', { line: 5, path: 'a.jpnov' }), null); // a chapter is not a cover
  // A cover row is named by its path alone, whatever the item's marker.
  assert.equal(resolveEntry(lines, 'covers', { line: 2, path: 'c.jpnov' }), 2);
  assert.equal(resolveEntry(lines, 'covers', { line: 2, path: '- c.jpnov' }), null);
  assert.equal(resolveEntry(lines, 'covers', { line: 3, path: 'd.jpnov' }), 3);
  assert.equal(resolveEntry(lines, 'chapters', { line: 0, path: '---' }), null);
  assert.equal(resolveEntry(lines, 'chapters', { line: 99, path: 'a.jpnov' }), null);
});

test('resolveEntry never re-anchors by path: a duplicate listing is two rows, each its own line', () => {
  const lines = parseJpbook('a.jpnov\na.jpnov\nb.jpnov\n').lines;
  assert.equal(resolveEntry(lines, 'chapters', { line: 1, path: 'a.jpnov' }), 1);
  // Row 2 held a.jpnov before an edit; b.jpnov is there now — the surviving copy at line 1 is not "it".
  assert.equal(resolveEntry(lines, 'chapters', { line: 2, path: 'a.jpnov' }), null);
});

test('resolveEntry compares the listed path, not the raw line (CRLF and surrounding whitespace)', () => {
  const lines = parseJpbook('a.jpnov\r\n  b.jpnov  \r\n').lines;
  assert.equal(resolveEntry(lines, 'chapters', { line: 1, path: 'b.jpnov' }), 1);
});

test('entryLines and listedEntries project each list on its own', () => {
  const text = '---\ncover:\n  - a.jpnov\n  - a.jpnov\ncover:\n  - m.jpnov\n---\nx.jpnov\n';
  const lines = parseJpbook(text).lines;
  const expected: Record<EntryList, { lines: number[]; listed: string[] }> = {
    covers: { lines: [2, 3], listed: ['a.jpnov'] },
    chapters: { lines: [7], listed: ['x.jpnov'] },
  };
  for (const list of ['covers', 'chapters'] as const) {
    assert.deepEqual(entryLines(lines, list), expected[list].lines, list);
    assert.deepEqual([...listedEntries(lines, list)], expected[list].listed, list);
  }
  // A cover path is listed without its marker, whatever the marker style.
  assert.deepEqual([...listedEntries(parseJpbook('---\ncover:\n－a.jpnov\n---\n').lines, 'covers')], ['a.jpnov']);
});
