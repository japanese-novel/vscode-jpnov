import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TextDocument } from 'vscode-languageserver-textdocument';

import * as edits from '../../../src/shared/book/edits.ts';
import { entryLines, listedEntries, metaRows, resolveEntry } from '../../../src/shared/book/edits.ts';
import type { TextReplace } from '../../../src/shared/utils/position.ts';
import {
  META_KEYS,
  metaKeyOf,
  parseJpbook as parseWhole,
  type EntryList,
  type JpbookLineKind,
  type MetaKey,
  type ParsedJpbook,
} from '../../../src/shared/book/jpbook.ts';
import { below, HEAD, shiftReplace } from './_fixture.ts';

// The fixtures below are the lines under the header: the planners run on `HEAD + text`, with the
// line arguments and the positions they return shifted across the header line, and a parse is
// numbered from below it too. No edit ever lands on the header (a position there would shift to -1).
const shift = (r: TextReplace): TextReplace => shiftReplace(r);
const setMeta = (text: string, key: MetaKey, value: string): TextReplace[] => edits.setMeta(HEAD + text, key, value).map(shift);
const removeMeta = (text: string, key: MetaKey): TextReplace[] => edits.removeMeta(HEAD + text, key).map(shift);
const appendEntries = (text: string, list: EntryList, rels: readonly string[]): TextReplace | null => {
  const r = edits.appendEntries(HEAD + text, list, rels);
  return r === null ? null : shift(r);
};
const removeEntry = (text: string, list: EntryList, line: number): TextReplace | null => {
  const r = edits.removeEntry(HEAD + text, list, line + 1);
  return r === null ? null : shift(r);
};
const moveEntryTo = (text: string, list: EntryList, from: number, before: number | null): TextReplace[] | null =>
  edits.moveEntryTo(HEAD + text, list, from + 1, before === null ? null : before + 1)?.map(shift) ?? null;
const parseJpbook = (text: string): ParsedJpbook => below(parseWhole(HEAD + text), 1);

/** `replaces` applied to `text` as the editor applies a WorkspaceEdit; overlapping edits throw. */
function apply(text: string, replaces: readonly TextReplace[]): string {
  return TextDocument.applyEdits(TextDocument.create('mem://x.jpbook', 'jpbook', 1, text), [...replaces]);
}

// --- setMeta -------------------------------------------------------------------

const FOOTER = '［＃ここに「ページ番号」の値を表示］';

/** What the row pins, the text, the key and the value the panel sets, the text afterwards. */
type MetaCase = readonly [name: string, text: string, key: MetaKey, value: string, expected: string];

/** Runs each row once. No edit may add an Error line on another key, or take an item out of a cover list. */
function runMetaCases(cases: readonly MetaCase[]): void {
  const count = (text: string, kind: string, except: MetaKey): number =>
    parseJpbook(text).lines.filter((l) => kindOf(l.kind) === kind && metaKeyOf(l.value) !== except).length;
  for (const [name, text, key, value, expected] of cases) {
    const out = apply(text, setMeta(text, key, value));
    assert.equal(out, expected, name);
    assert.ok(count(out, 'error', key) <= count(text, 'error', key), `${name}: a new Error line`);
    assert.ok(count(out, 'coverEntry', key) >= count(text, 'coverEntry', key), `${name}: a lost cover item`);
  }
}

test('setMeta rewrites the key in place, in canonical form; other keys stay put', () => {
  runMetaCases([
    ['an existing key', 'title: 作品名\nheader: 作品名　一\n---\na.jpnov\n', 'title', '作品名　第一巻', 'title: 作品名　第一巻\nheader: 作品名　一\n---\na.jpnov\n'],
    ['a full-width colon', 'title：作品名\n---\n', 'title', '作品名　第一巻', 'title: 作品名　第一巻\n---\n'],
    ['the default value is written like any other', 'footerAlign: left\n---\n', 'footerAlign', 'right', 'footerAlign: right\n---\n'],
    ['pasted newlines and edge whitespace', 'title: 作品名\n---\n', 'title', '  作品名\n第一巻  ', 'title: 作品名 第一巻\n---\n'],
    ['an empty footer is a value', `footer: ${FOOTER}\n---\n`, 'footer', '', 'footer:\n---\n'],
    ['an empty title is written too (its Error says so)', 'title: 作品名\nheader: 作品名　一\n---\n第一章.jpnov\n', 'title', '', 'title:\nheader: 作品名　一\n---\n第一章.jpnov\n'],
    ['whitespace only is empty', 'title: 作品名\nheader: 作品名　一\n---\n', 'title', ' 　 ', 'title:\nheader: 作品名　一\n---\n'],
    ['a divider cleared', 'title: 作品名\ndivider: ＊　＊　＊\n---\n', 'divider', '', 'title: 作品名\ndivider:\n---\n'],
    ['CRLF', 'title: 作品名\r\n---\r\n', 'title', '作品名　第一巻', 'title: 作品名　第一巻\r\n---\r\n'],
    ['no fence yet, the last document line', 'header: 作品名　一\ntitle: 作品名', 'title', '作品名　第一巻', 'header: 作品名　一\ntitle: 作品名　第一巻'],
  ]);
});

test('setMeta leaves ONE line for the key: its repeats and invalid lines go', () => {
  runMetaCases([
    ['a repeat', 'title: 作品名\nauthor: ペンネーム\ntitle: 作品名　第一巻\n---\n', 'title', '作品名　第二巻', 'title: 作品名　第二巻\nauthor: ペンネーム\n---\n'],
    ['a rejected value', 'footerAlign: bottom\n---\n', 'footerAlign', 'left', 'footerAlign: left\n---\n'],
    ['an empty footerAlign', 'footerAlign:\n---\n', 'footerAlign', 'left', 'footerAlign: left\n---\n'],
    ['an empty title', 'title:\nauthor: ペンネーム\n---\n', 'title', '作品名', 'title: 作品名\nauthor: ペンネーム\n---\n'],
    ['a rejected value above the valid line', 'footerAlign: bottom\nfooterAlign: left\n---\n', 'footerAlign', 'rightLeft', 'footerAlign: rightLeft\n---\n'],
    ['the key in another case', 'Title: 作品名\n---\n', 'title', '作品名　第一巻', 'title: 作品名　第一巻\n---\n'],
    ['the key in lower case', 'footeralign: left\n---\n', 'footerAlign', 'rightLeft', 'footerAlign: rightLeft\n---\n'],
    ['the key in full-width letters', 'ｔｉｔｌｅ：作品名\n---\n', 'title', '作品名　第一巻', 'title: 作品名　第一巻\n---\n'],
    ['another case above the valid line', 'Title: 作品名\ntitle: 作品名\n---\n', 'title', '作品名　第一巻', 'title: 作品名　第一巻\n---\n'],
    ['another case on the last document line', 'title: 作品名\nTitle: 作品名', 'title', '作品名　第一巻', 'title: 作品名　第一巻'],
    ['an empty first line and its repeat', 'title:\ntitle: 作品名\n---\n', 'title', '作品名　第一巻', 'title: 作品名　第一巻\n---\n'],
    ['repeats go when the key is cleared', 'title: 作品名\nauthor: ペンネーム\ntitle: 作品名　第一巻\n---\n', 'title', '', 'title:\nauthor: ペンネーム\n---\n'],
    ['neighbours ending the document', 'header: 作品名　一\ntitle: 作品名\ntitle: 作品名　第一巻', 'title', '', 'header: 作品名　一\ntitle:'],
    ['CRLF, repeats', 'title: 作品名\r\nheader: 作品名　一\r\nTitle: x\r\n---\r\n', 'title', '作品名　第一巻', 'title: 作品名　第一巻\r\nheader: 作品名　一\r\n---\r\n'],
    ['footerAlign is not a line of footer', 'footerAlign: left\n---\n', 'footer', '', 'footer:\nfooterAlign: left\n---\n'],
    ['headerAlign is not a line of header', 'headerAlign: left\n---\n', 'header', '作品名　一', 'header: 作品名　一\nheaderAlign: left\n---\n'],
    ['a key-shaped line below the fence is not a line of the key', 'title: 作品名\n---\na.jpnov\nheader: h\n', 'header', '柱', 'title: 作品名\nheader: 柱\n---\na.jpnov\nheader: h\n'],
  ]);
});

test('setMeta inserts an absent key at its place in the key order', () => {
  runMetaCases([
    ['after the nearest earlier key', 'title: 作品名\ndivider: ＊\n---\n', 'author', 'ペンネーム', 'title: 作品名\nauthor: ペンネーム\ndivider: ＊\n---\n'],
    ['before the nearest later key', 'header: 作品名　一\n---\na.jpnov\n', 'title', '作品名', 'title: 作品名\nheader: 作品名　一\n---\na.jpnov\n'],
    ['an empty line anchors like any other', 'title:\n---\n', 'author', 'ペンネーム', 'title:\nauthor: ペンネーム\n---\n'],
    ['a rejected line anchors too', 'footerAlign: bottom\n---\n', 'divider', '＊', 'footerAlign: bottom\ndivider: ＊\n---\n'],
    ['above a cover list', 'cover:\n  - 表紙.jpnov\n---\n第一章.jpnov\n', 'divider', '＊', 'divider: ＊\ncover:\n  - 表紙.jpnov\n---\n第一章.jpnov\n'],
    ['between an earlier key and a cover list', 'title: 作品名\ncover:\n  - 表紙.jpnov\n  - あらすじ.jpnov\n---\na.jpnov', 'header', '作品名　一', 'title: 作品名\nheader: 作品名　一\ncover:\n  - 表紙.jpnov\n  - あらすじ.jpnov\n---\na.jpnov'],
    ['between a cover list and a later key', 'cover:\n  - 表紙.jpnov\ndivider: ＊\n---\n', 'header', '作品名　一', 'cover:\n  - 表紙.jpnov\nheader: 作品名　一\ndivider: ＊\n---\n'],
    ['an empty metadata block: right above the fence', '---\na.jpnov\n', 'title', '作品名', 'title: 作品名\n---\na.jpnov\n'],
    ['no fence: the whole document is metadata, so at its end', 'a.jpnov\n', 'title', '作品名', 'a.jpnov\ntitle: 作品名\n'],
    ['an empty document', '', 'header', '作品名　一', 'header: 作品名　一\n'],
    ['unclosed metadata: stays inside it', 'title: 作品名', 'header', '作品名　一', 'title: 作品名\nheader: 作品名　一'],
    ['unclosed metadata without a later key: at the end', 'cover:\n  - c.jpnov', 'title', '作品名', 'title: 作品名\ncover:\n  - c.jpnov'],
    ['CRLF, after a key', 'title: 作品名\r\n---\r\n', 'header', '作品名　一', 'title: 作品名\r\nheader: 作品名　一\r\n---\r\n'],
    ['CRLF, before a key', 'header: 作品名　一\r\n---\r\n', 'title', '作品名', 'title: 作品名\r\nheader: 作品名　一\r\n---\r\n'],
  ]);
});

test('setMeta: keys filled in any order end in the key order, above the fence', () => {
  const fills: readonly (readonly [MetaKey, string])[] = [
    ['author', 'ペンネーム'], ['divider', '＊'], ['title', '作品名'], ['footerAlign', 'left'], ['headerAlign', 'right'], ['footer', ''],
    ['header', '作品名　一'],
  ];
  let text = '---\na.jpnov\n';
  for (const [key, value] of fills) {
    text = apply(text, setMeta(text, key, value));
  }
  assert.equal(
    text,
    'title: 作品名\nauthor: ペンネーム\nheader: 作品名　一\nheaderAlign: right\nfooter:\nfooterAlign: left\ndivider: ＊\n---\na.jpnov\n',
  );
  assert.deepEqual(Object.keys(parseJpbook(text).meta), [...META_KEYS]);
});

// --- appendEntries (chapters) -------------------------------------------------------------

test('appendEntries(chapters) appends at EOF and skips already-listed paths', () => {
  const text = 'title: t\n---\na.jpnov\n';
  const edit = appendEntries(text, 'chapters', ['a.jpnov', 'ch/b.jpnov', 'c.jpnov']);
  assert.ok(edit);
  assert.equal(apply(text, [edit]), 'title: t\n---\na.jpnov\nch/b.jpnov\nc.jpnov\n');
});

test('appendEntries(chapters) returns null when everything is already listed', () => {
  assert.equal(appendEntries('---\na.jpnov\n', 'chapters', ['a.jpnov']), null);
  // Listed as `./a.jpnov`: the same file, so nothing is new (#86).
  assert.equal(appendEntries('---\n./a.jpnov\n', 'chapters', ['a.jpnov']), null);
  assert.deepEqual([...listedEntries(parseJpbook('---\n./a.jpnov\n').lines, 'chapters')], ['a.jpnov']);
});

test('appendEntries(chapters) handles a document without a trailing newline', () => {
  const edit = appendEntries('---\na.jpnov', 'chapters', ['b.jpnov']);
  assert.ok(edit);
  assert.equal(apply('---\na.jpnov', [edit]), '---\na.jpnov\nb.jpnov');
});

test('appendEntries(chapters) closes unclosed metadata with a fence first', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['title: t\n', 'title: t\n---\na.jpnov\n'],
    ['title: t', 'title: t\n---\na.jpnov'],
    ['', '---\na.jpnov\n'],
  ];
  for (const [text, expected] of cases) {
    const edit = appendEntries(text, 'chapters', ['a.jpnov']);
    assert.ok(edit);
    const out = apply(text, [edit]);
    assert.equal(out, expected, JSON.stringify(text));
    assert.equal(parseJpbook(out).lines.find((l) => l.value === 'a.jpnov')?.kind, 'ok');
  }
});

// --- removeEntry (chapters) ---------------------------------------------------------------

test('removeEntry(chapters) deletes the whole line, trailing newline included', () => {
  const text = '---\na.jpnov\nb.jpnov\nc.jpnov\n';
  const edit = removeEntry(text, 'chapters', 2);
  assert.ok(edit);
  assert.equal(apply(text, [edit]), '---\na.jpnov\nc.jpnov\n');
});

test('removeEntry(chapters) of the final line swallows the PRECEDING newline', () => {
  const text = '---\na.jpnov\nb.jpnov';
  const edit = removeEntry(text, 'chapters', 2);
  assert.ok(edit);
  assert.equal(apply(text, [edit]), '---\na.jpnov');
});

test('removeEntry(chapters) refuses non-chapter lines', () => {
  const text = 'title: t\n---\na.jpnov\n';
  assert.equal(removeEntry(text, 'chapters', 0), null);
  assert.equal(removeEntry(text, 'chapters', 1), null);
  assert.equal(removeEntry(text, 'chapters', 5), null);
});

// --- moveEntryTo (chapters) ----------------------------------------------------------------

test('moveEntryTo(chapters) moves a chapter before another; blanks and metadata stay put', () => {
  const text = 'title: t\n---\na.jpnov\n\nb.jpnov\nc.jpnov\n';
  const edits = moveEntryTo(text, 'chapters', 5, 2); // c before a
  assert.ok(edits);
  assert.equal(apply(text, edits), 'title: t\n---\nc.jpnov\na.jpnov\n\nb.jpnov\n');
});

test('moveEntryTo(chapters, null) moves a chapter after the last one', () => {
  const text = '---\na.jpnov\nb.jpnov\nc.jpnov\n';
  const edits = moveEntryTo(text, 'chapters', 1, null);
  assert.ok(edits);
  assert.equal(apply(text, edits), '---\nb.jpnov\nc.jpnov\na.jpnov\n');
});

test('moveEntryTo(chapters) returns null for no-ops and non-chapters', () => {
  const text = '---\na.jpnov\nb.jpnov\n';
  assert.equal(moveEntryTo(text, 'chapters', 1, 1), null);
  assert.equal(moveEntryTo(text, 'chapters', 1, 2), null); // already directly above
  assert.equal(moveEntryTo(text, 'chapters', 2, null), null); // already last
  assert.equal(moveEntryTo(text, 'chapters', 0, 1), null); // the fence
  assert.equal(moveEntryTo(text, 'chapters', 5, 1), null);
});

test('moveEntryTo(chapters) treats a blank line between chapters as still-adjacent (no-op)', () => {
  // a (line 2) already precedes b (line 4) in chapter order, with a blank at line 3; moving a
  // before b must be a no-op, not a spurious edit that relocates the blank line.
  const text = 'title: t\n---\na.jpnov\n\nb.jpnov\nc.jpnov\n';
  assert.equal(moveEntryTo(text, 'chapters', 2, 4), null);
});

// --- panel projections ---------------------------------------------------------

test('entryLines(chapters) and metaRows project the panel model in fixed order', () => {
  const text = 'header: 柱\n---\na.jpnov\nnote.md\nb.jpnov\n';
  const parsed = parseJpbook(text);
  assert.deepEqual(entryLines(parsed.lines, 'chapters'), [2, 4]);
  assert.deepEqual(metaRows(parsed.meta), [
    { key: 'title', value: undefined },
    { key: 'author', value: undefined },
    { key: 'header', value: '柱' },
    { key: 'headerAlign', value: undefined },
    { key: 'footer', value: undefined },
    { key: 'footerAlign', value: undefined },
    { key: 'divider', value: undefined },
  ]);
});

test('removeMeta deletes every line of the key, so its default applies; nothing when none is written', () => {
  // The valid line, a repeat in another case, and a line in Error all go; the neighbours stay.
  const text = 'title: 作品名\nFooterAlign: left\nheader: h\nfooterAlign: right\nfooterAlign:\n---\na.jpnov\n';
  assert.deepEqual(removeMeta(text, 'footerAlign'), [
    { range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, newText: '' },
    { range: { start: { line: 3, character: 0 }, end: { line: 5, character: 0 } }, newText: '' },
  ]);
  assert.equal(apply(text, removeMeta(text, 'footerAlign')), 'title: 作品名\nheader: h\n---\na.jpnov\n');
  assert.deepEqual(removeMeta(text, 'author'), []);
  // The last line of a file without a fence: the preceding newline goes with it.
  assert.equal(apply('title: 作品名\nfooter:', removeMeta('title: 作品名\nfooter:', 'footer')), 'title: 作品名');
  assert.equal(apply('title: 作品名\r\nfooter: x\r\n---\r\n', removeMeta('title: 作品名\r\nfooter: x\r\n---\r\n', 'footer')), 'title: 作品名\r\n---\r\n');
  // A chapter line below the fence never holds a key.
  assert.deepEqual(removeMeta('---\nheader: h\n', 'header'), []);
});

test('setMeta never splits a cover list: an absent key lands beside a key line', () => {
  const text = ['title: 作品名', 'cover:', '  - c1.jpnov', '  - c2.jpnov', '---', 'a.jpnov'].join('\n');
  const out = apply(text, setMeta(text, 'header', '作品名　一'));
  // The list still parses as one contiguous block after the edit.
  assert.deepEqual(
    parseJpbook(out).lines.map((l) => l.kind),
    ['meta', 'meta', 'cover', 'coverEntry', 'coverEntry', 'fence', 'ok'],
  );
});

test('a cover list never leaks into the metadata the panel edits', () => {
  const text = ['title: 一', 'cover:', '  - c1.jpnov', '---', 'a.jpnov'].join('\n');
  // The list lives in the LINE KINDS, so the panel's seven single-line rows stay complete.
  assert.deepEqual(parseJpbook(text).meta, { title: '一' });
  assert.deepEqual(metaRows(parseJpbook(text).meta).map((r) => r.key), [...META_KEYS]);
});

// --- cover list planners ---------------------------------------------------------

/** A line kind with object kinds collapsed to their severity, so fixtures can pin the shape. */
function kindOf(kind: JpbookLineKind): string {
  return typeof kind === 'string' ? kind : 'error' in kind ? 'error' : 'warning';
}

function kindsOf(text: string): string[] {
  return parseJpbook(text).lines.map((l) => kindOf(l.kind));
}

test('appendEntries(covers) inserts after the last item, mirroring its indent and marker', () => {
  const text = ['title: 一', 'cover:', '  - c1.jpnov', '---', 'a.jpnov', ''].join('\n');
  const edit = appendEntries(text, 'covers', ['c1.jpnov', 'c2.jpnov', 'sub/c3.jpnov']);
  assert.deepEqual(edit, { range: { start: { line: 2, character: 12 }, end: { line: 2, character: 12 } }, newText: '\n  - c2.jpnov\n  - sub/c3.jpnov' });
  const out = apply(text, [edit]);
  assert.equal(out, ['title: 一', 'cover:', '  - c1.jpnov', '  - c2.jpnov', '  - sub/c3.jpnov', '---', 'a.jpnov', ''].join('\n'));
  assert.deepEqual(kindsOf(out), ['meta', 'cover', 'coverEntry', 'coverEntry', 'coverEntry', 'fence', 'ok', 'blank']);
});

test('appendEntries(covers) follows the existing marker style', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['cover:\n－c1.jpnov\n---\n', 'cover:\n－c1.jpnov\n－c2.jpnov\n---\n'],
    ['cover:\n- c1.jpnov\n---\n', 'cover:\n- c1.jpnov\n- c2.jpnov\n---\n'],
    ['cover:\n\t- c1.jpnov\n---\n', 'cover:\n\t- c1.jpnov\n\t- c2.jpnov\n---\n'],
  ];
  for (const [text, expected] of cases) {
    const edit = appendEntries(text, 'covers', ['c2.jpnov']);
    assert.ok(edit);
    assert.equal(apply(text, [edit]), expected, text);
  }
});

test('appendEntries(covers) anchors an empty list on its key line with the default prefix', () => {
  const text = 'cover:\n---\na.jpnov\n';
  const edit = appendEntries(text, 'covers', ['x.jpnov']);
  assert.deepEqual(edit, { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 6 } }, newText: '\n  - x.jpnov' });
  assert.equal(apply(text, [edit]), 'cover:\n  - x.jpnov\n---\na.jpnov\n');
});

test('appendEntries(covers) without a key adds one right above the fence', () => {
  const text = 'title: t\n---\na.jpnov\n';
  const edit = appendEntries(text, 'covers', ['x.jpnov']);
  assert.deepEqual(edit, { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: 'cover:\n  - x.jpnov\n' });
  assert.equal(apply(text, [edit]), 'title: t\ncover:\n  - x.jpnov\n---\na.jpnov\n');
  const empty = '---\na.jpnov\n';
  const e2 = appendEntries(empty, 'covers', ['x.jpnov']);
  assert.ok(e2);
  assert.equal(apply(empty, [e2]), 'cover:\n  - x.jpnov\n---\na.jpnov\n');
});

test('appendEntries(covers) without a fence appends to the metadata, which runs to the end', () => {
  for (const [text, expected] of [
    ['a.jpnov\n', 'a.jpnov\ncover:\n  - x.jpnov\n'],
    ['', 'cover:\n  - x.jpnov\n'],
  ] as const) {
    const edit = appendEntries(text, 'covers', ['x.jpnov']);
    assert.ok(edit);
    const out = apply(text, [edit]);
    assert.equal(out, expected, JSON.stringify(text));
    assert.equal(parseJpbook(out).fence, null);
  }
});

test('appendEntries(covers) stays inside unclosed metadata', () => {
  const noKey = 'title: t';
  const e1 = appendEntries(noKey, 'covers', ['x.jpnov']);
  assert.ok(e1);
  const out = apply(noKey, [e1]);
  assert.equal(out, 'title: t\ncover:\n  - x.jpnov');
  assert.deepEqual(kindsOf(out), ['meta', 'cover', 'coverEntry']);
  const withKey = 'cover:\n  - a.jpnov';
  const e2 = appendEntries(withKey, 'covers', ['b.jpnov']);
  assert.ok(e2);
  assert.equal(apply(withKey, [e2]), 'cover:\n  - a.jpnov\n  - b.jpnov');
});

test('appendEntries(covers) follows a CRLF document', () => {
  const withKey = 'cover:\r\n  - a.jpnov\r\n---\r\n';
  const e1 = appendEntries(withKey, 'covers', ['b.jpnov']);
  assert.ok(e1);
  assert.equal(apply(withKey, [e1]), 'cover:\r\n  - a.jpnov\r\n  - b.jpnov\r\n---\r\n');
  const noKey = 'title: t\r\n---\r\n';
  const e2 = appendEntries(noKey, 'covers', ['b.jpnov']);
  assert.ok(e2);
  assert.equal(apply(noKey, [e2]), 'title: t\r\ncover:\r\n  - b.jpnov\r\n---\r\n');
});

test('appendEntries(covers) extends a list opened by an inline `cover: path`, mirroring its `- ` items', () => {
  const text = 'cover: a.jpnov\n---\n';
  const edit = appendEntries(text, 'covers', ['b.jpnov']);
  assert.ok(edit);
  const out = apply(text, [edit]);
  assert.equal(out, 'cover: a.jpnov\n  - b.jpnov\n---\n');
  assert.deepEqual(kindsOf(out), ['coverEntry', 'coverEntry', 'fence', 'blank']);
  assert.equal(appendEntries(text, 'covers', ['a.jpnov']), null);
  const items = 'cover: a.jpnov\n- b.jpnov\n---\n';
  const e2 = appendEntries(items, 'covers', ['c.jpnov']);
  assert.ok(e2);
  assert.equal(apply(items, [e2]), 'cover: a.jpnov\n- b.jpnov\n- c.jpnov\n---\n');
});

test('removeEntry and moveEntryTo keep the list open around an inline `cover: path`', () => {
  const text = 'cover: a.jpnov\n  - b.jpnov\n---\n';
  const removed = removeEntry(text, 'covers', 0);
  assert.ok(removed);
  assert.equal(apply(text, [removed]), 'cover:\n  - b.jpnov\n---\n');
  // The inline entry travels as a `- ` item.
  const toEnd = moveEntryTo(text, 'covers', 0, null);
  assert.ok(toEnd);
  assert.equal(apply(text, toEnd), 'cover:\n  - b.jpnov\n  - a.jpnov\n---\n');
  // Moving before it turns it into an item under a bare key.
  const before = moveEntryTo(text, 'covers', 1, 0);
  assert.ok(before);
  assert.equal(apply(text, before), 'cover:\n  - b.jpnov\n  - a.jpnov\n---\n');
  assert.deepEqual(entryLines(parseJpbook(text).lines, 'covers'), [0, 1]);
  assert.equal(resolveEntry(parseJpbook(text).lines, 'covers', { line: 0, path: 'a.jpnov' }), 0);
});

test('appendEntries(covers) extends the OPEN list; a muted second list is neither anchor nor dedupe source', () => {
  const text = 'cover:\n  - a.jpnov\ncover:\n  - m.jpnov\n---\n';
  const edit = appendEntries(text, 'covers', ['b.jpnov', 'm.jpnov']);
  assert.deepEqual(edit, { range: { start: { line: 1, character: 11 }, end: { line: 1, character: 11 } }, newText: '\n  - b.jpnov\n  - m.jpnov' });
  const out = apply(text, [edit]);
  assert.equal(out, 'cover:\n  - a.jpnov\n  - b.jpnov\n  - m.jpnov\ncover:\n  - m.jpnov\n---\n');
  assert.deepEqual(kindsOf(out), ['cover', 'coverEntry', 'coverEntry', 'coverEntry', 'warning', 'warning', 'fence', 'blank']);
});

test('the two lists dedupe independently (a file may be both a cover and a chapter)', () => {
  const text = 'cover:\n  - a.jpnov\n---\na.jpnov\nb.jpnov\n';
  const covers = appendEntries(text, 'covers', ['a.jpnov', 'b.jpnov']);
  assert.deepEqual(covers, { range: { start: { line: 1, character: 11 }, end: { line: 1, character: 11 } }, newText: '\n  - b.jpnov' });
  assert.equal(appendEntries(text, 'chapters', ['a.jpnov', 'b.jpnov']), null);
  const coverOnly = 'cover:\n  - a.jpnov\n---\n';
  const chapter = appendEntries(coverOnly, 'chapters', ['a.jpnov']);
  assert.ok(chapter);
  assert.equal(apply(coverOnly, [chapter]), 'cover:\n  - a.jpnov\n---\na.jpnov\n');
});

test('a coverDuplicate item counts as listed and as a row', () => {
  const text = 'cover:\n  - a.jpnov\n  - a.jpnov\n---\n';
  assert.equal(appendEntries(text, 'covers', ['a.jpnov']), null);
  assert.deepEqual(entryLines(parseJpbook(text).lines, 'covers'), [1, 2]);
});

test('removeEntry(covers) deletes the item and keeps the bare key', () => {
  const text = 'cover:\n  - a.jpnov\n---\nx.jpnov\n';
  const edit = removeEntry(text, 'covers', 1);
  assert.deepEqual(edit, { range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, newText: '' });
  const out = apply(text, [edit]);
  assert.equal(out, 'cover:\n---\nx.jpnov\n');
  assert.deepEqual(kindsOf(out), ['cover', 'fence', 'ok', 'blank']);
});

test('removeEntry(covers) of the final document line swallows the PRECEDING newline', () => {
  const text = 'cover:\n  - a.jpnov';
  const edit = removeEntry(text, 'covers', 1);
  assert.deepEqual(edit, { range: { start: { line: 0, character: 6 }, end: { line: 1, character: 11 } }, newText: '' });
  assert.equal(apply(text, [edit]), 'cover:');
});

test('removeEntry refuses the other list, the key line and the fence', () => {
  const text = 'cover:\n  - a.jpnov\n---\nx.jpnov\n';
  assert.equal(removeEntry(text, 'chapters', 1), null);
  assert.equal(removeEntry(text, 'covers', 3), null);
  assert.equal(removeEntry(text, 'covers', 0), null);
  assert.equal(removeEntry(text, 'covers', 2), null);
});

test('moveEntryTo(covers) moves an item before another; blanks stay put', () => {
  const text = 'cover:\n  - a.jpnov\n\n  - b.jpnov\n  - c.jpnov\n---\nx.jpnov\n';
  const edits = moveEntryTo(text, 'covers', 4, 1); // c before a
  assert.deepEqual(edits, [
    { range: { start: { line: 4, character: 0 }, end: { line: 5, character: 0 } }, newText: '' },
    { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: '  - c.jpnov\n' },
  ]);
  assert.equal(apply(text, edits), 'cover:\n  - c.jpnov\n  - a.jpnov\n\n  - b.jpnov\n---\nx.jpnov\n');
});

test('moveEntryTo(covers, null) moves an item after the last one, still inside the list', () => {
  const text = 'cover:\n  - a.jpnov\n\n  - b.jpnov\n  - c.jpnov\n---\nx.jpnov\n';
  const edits = moveEntryTo(text, 'covers', 1, null);
  assert.deepEqual(edits, [
    { range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, newText: '' },
    { range: { start: { line: 4, character: 11 }, end: { line: 4, character: 11 } }, newText: '\n  - a.jpnov' },
  ]);
  assert.equal(apply(text, edits), 'cover:\n\n  - b.jpnov\n  - c.jpnov\n  - a.jpnov\n---\nx.jpnov\n');
});

test('moveEntryTo returns null for no-ops and for lines of the other list', () => {
  const text = 'cover:\n  - a.jpnov\n\n  - b.jpnov\n  - c.jpnov\n---\nx.jpnov\n';
  assert.equal(moveEntryTo(text, 'covers', 1, 1), null); // onto itself
  assert.equal(moveEntryTo(text, 'covers', 1, 3), null); // already directly above (across a blank)
  assert.equal(moveEntryTo(text, 'covers', 4, null), null); // already last
  assert.equal(moveEntryTo(text, 'covers', 6, 1), null); // a chapter as the mover
  assert.equal(moveEntryTo(text, 'covers', 1, 6), null); // a chapter as the target
  assert.equal(moveEntryTo(text, 'chapters', 1, null), null); // a cover under the chapter list
});

// --- resolveEntry (the panel row → live line check) --------------------------------------

test('resolveEntry accepts a row only where its list still has that path on that line', () => {
  const lines = parseJpbook('cover:\n  - c.jpnov\n－d.jpnov\n---\na.jpnov\nb.jpnov\n').lines;
  assert.equal(resolveEntry(lines, 'chapters', { line: 4, path: 'a.jpnov' }), 4);
  assert.equal(resolveEntry(lines, 'chapters', { line: 5, path: 'a.jpnov' }), null); // the row slid
  assert.equal(resolveEntry(lines, 'covers', { line: 4, path: 'a.jpnov' }), null); // a chapter is not a cover
  // A cover row is named by its path alone, whatever the item's marker.
  assert.equal(resolveEntry(lines, 'covers', { line: 1, path: 'c.jpnov' }), 1);
  assert.equal(resolveEntry(lines, 'covers', { line: 1, path: '- c.jpnov' }), null);
  assert.equal(resolveEntry(lines, 'covers', { line: 2, path: 'd.jpnov' }), 2);
  assert.equal(resolveEntry(lines, 'chapters', { line: 3, path: '---' }), null);
  assert.equal(resolveEntry(lines, 'chapters', { line: 99, path: 'a.jpnov' }), null);
});

test('resolveEntry never re-anchors by path: a duplicate listing is two rows, each its own line', () => {
  const lines = parseJpbook('---\na.jpnov\na.jpnov\nb.jpnov\n').lines;
  assert.equal(resolveEntry(lines, 'chapters', { line: 2, path: 'a.jpnov' }), 2);
  // Row 3 held a.jpnov before an edit; b.jpnov is there now — the surviving copy at line 2 is not "it".
  assert.equal(resolveEntry(lines, 'chapters', { line: 3, path: 'a.jpnov' }), null);
});

test('resolveEntry compares the listed path, not the raw line (CRLF and surrounding whitespace)', () => {
  const lines = parseJpbook('---\r\na.jpnov\r\n  b.jpnov  \r\n').lines;
  assert.equal(resolveEntry(lines, 'chapters', { line: 2, path: 'b.jpnov' }), 2);
});

test('entryLines and listedEntries project each list on its own', () => {
  const text = 'cover:\n  - a.jpnov\n  - a.jpnov\ncover:\n  - m.jpnov\n---\nx.jpnov\n';
  const lines = parseJpbook(text).lines;
  const expected: Record<EntryList, { lines: number[]; listed: string[] }> = {
    covers: { lines: [1, 2], listed: ['a.jpnov'] },
    chapters: { lines: [6], listed: ['x.jpnov'] },
    characters: { lines: [], listed: [] },
    keywords: { lines: [], listed: [] },
  };
  for (const list of ['covers', 'chapters', 'characters', 'keywords'] as const) {
    assert.deepEqual(entryLines(lines, list), expected[list].lines, list);
    assert.deepEqual([...listedEntries(lines, list)], expected[list].listed, list);
  }
  // A cover path is listed without its marker, whatever the marker style.
  assert.deepEqual([...listedEntries(parseJpbook('cover:\n－a.jpnov\n---\n').lines, 'covers')], ['a.jpnov']);
});

// --- name list planners -------------------------------------------------------------

const replaceEntry = (text: string, list: EntryList, line: number, value: string): TextReplace | null => {
  const r = edits.replaceEntry(HEAD + text, list, line + 1, value);
  return r === null ? null : shift(r);
};

test('appendEntries(characters/keywords) opens the list at the end of the metadata, then extends it like covers', () => {
  const text = 'title: t\ncover:\n  - c.jpnov\n---\na.jpnov\n';
  const opened = appendEntries(text, 'characters', ['山田　太郎', 'John Smith']);
  assert.ok(opened);
  const out = apply(text, [opened]);
  assert.equal(out, 'title: t\ncover:\n  - c.jpnov\ncharacters:\n  - 山田　太郎\n  - John Smith\n---\na.jpnov\n');
  assert.deepEqual(kindsOf(out), ['meta', 'cover', 'coverEntry', 'names', 'name', 'name', 'fence', 'ok', 'blank']);
  // The new key closed the cover list where it stood; the covers are intact.
  assert.deepEqual(entryLines(parseJpbook(out).lines, 'covers'), [2]);

  const extended = appendEntries(out, 'characters', ['山田　花子']);
  assert.ok(extended);
  assert.equal(apply(out, [extended]), 'title: t\ncover:\n  - c.jpnov\ncharacters:\n  - 山田　太郎\n  - John Smith\n  - 山田　花子\n---\na.jpnov\n');
  const keyed = appendEntries(out, 'keywords', ['王都《おうと》']);
  assert.ok(keyed);
  assert.equal(apply(out, [keyed]), 'title: t\ncover:\n  - c.jpnov\ncharacters:\n  - 山田　太郎\n  - John Smith\nkeywords:\n  - 王都《おうと》\n---\na.jpnov\n');
});

test('appendEntries(characters) dedupes by the base: another writing of a listed name is nothing new', () => {
  const text = 'characters:\n  - 山田　太郎\n---\n';
  assert.equal(appendEntries(text, 'characters', ['山田《やまだ》太郎《たろう》', '山田太郎']), null);
  // The lists dedupe on their own: a character may be a keyword too.
  const edit = appendEntries(text, 'keywords', ['山田太郎']);
  assert.ok(edit);
  assert.equal(apply(text, [edit]), 'characters:\n  - 山田　太郎\nkeywords:\n  - 山田太郎\n---\n');
  assert.deepEqual([...listedEntries(parseJpbook(text).lines, 'characters')], ['山田太郎']);
});

test('removeEntry / moveEntryTo / replaceEntry work on a name list, an inline `characters: name` included', () => {
  const text = 'characters: 山田　太郎\n  - 山田　花子\n---\n';
  const removed = removeEntry(text, 'characters', 0);
  assert.ok(removed);
  assert.equal(apply(text, [removed]), 'characters:\n  - 山田　花子\n---\n');
  const toEnd = moveEntryTo(text, 'characters', 0, null);
  assert.ok(toEnd);
  assert.equal(apply(text, toEnd), 'characters:\n  - 山田　花子\n  - 山田　太郎\n---\n');
  const edited = replaceEntry(text, 'characters', 1, ' 山田《やまだ》花子《はなこ》 ');
  assert.ok(edited);
  assert.equal(apply(text, [edited]), 'characters: 山田　太郎\n  - 山田《やまだ》花子《はなこ》\n---\n');
  const inline = replaceEntry(text, 'characters', 0, 'John Smith');
  assert.ok(inline);
  assert.equal(apply(text, [inline]), 'characters: John Smith\n  - 山田　花子\n---\n');
  // Not an entry of the list, or nothing to write: no edit.
  assert.equal(replaceEntry(text, 'keywords', 1, 'x'), null);
  assert.equal(replaceEntry(text, 'characters', 1, ' '), null);
  assert.equal(resolveEntry(parseJpbook(text).lines, 'characters', { line: 1, path: '山田　花子' }), 1);
});

test('setMeta never lands a key under a name list key, where it would close the list', () => {
  const text = ['title: 作品名', 'characters:', '  - 山田　太郎', 'keywords:', '  - 王都', '---', 'a.jpnov'].join('\n');
  const out = apply(text, setMeta(text, 'divider', '＊'));
  assert.deepEqual(kindsOf(out), ['meta', 'meta', 'names', 'name', 'names', 'name', 'fence', 'ok']);
});
