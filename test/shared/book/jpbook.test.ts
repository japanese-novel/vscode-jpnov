import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  completeEntryLine,
  completeMetaLine,
  composeBookChrome,
  composeDividerValue,
  COVER_ITEM_MARKS,
  coverPathOf,
  firstErrorOf,
  FRONT_MATTER_KEYS,
  isCover,
  jpbookOutRel,
  metaRegionOf,
  parseDividerValue,
  parseJpbook,
  type CompletionEntry,
  type JpbookLineKind,
} from '../../../src/shared/book/jpbook.ts';

const kinds = (text: string): JpbookLineKind[] => parseJpbook(text).lines.map((l) => l.kind);
const E = (name: string, isDir = false): CompletionEntry => ({ name, isDir });

// --- parseJpbook: chapter lines ---------------------------------------------

test('parseJpbook returns ordered ok lines with exact ranges', () => {
  assert.deepEqual(parseJpbook('a.jpnov\nb.jpnov').lines, [
    { line: 0, range: { startChar: 0, endChar: 7 }, raw: 'a.jpnov', value: 'a.jpnov', kind: 'ok' },
    { line: 1, range: { startChar: 0, endChar: 7 }, raw: 'b.jpnov', value: 'b.jpnov', kind: 'ok' },
  ]);
});

test('parseJpbook skips blank / whitespace-only / full-width-space-only lines (zero-width range)', () => {
  const got = parseJpbook('a.jpnov\n\n   \n　　\nb.jpnov').lines;
  assert.deepEqual(got.map((l) => l.kind), ['ok', 'blank', 'blank', 'blank', 'ok']);
  for (const l of got.filter((x) => x.kind === 'blank')) {
    assert.deepEqual(l.range, { startChar: 0, endChar: 0 });
    assert.equal(l.value, '');
  }
});

test('parseJpbook is CRLF-safe: strips trailing \\r, range excludes it', () => {
  const got = parseJpbook('a.jpnov\r\nb.jpnov\r\n').lines;
  assert.equal(got.length, 3);
  assert.deepEqual(got[0], { line: 0, range: { startChar: 0, endChar: 7 }, raw: 'a.jpnov', value: 'a.jpnov', kind: 'ok' });
  assert.equal(got[1]?.value, 'b.jpnov');
  assert.equal(got[2]?.kind, 'blank');
});

test('parseJpbook trims edges (incl. full-width) but preserves interior whitespace', () => {
  const got = parseJpbook('  chapter one.jpnov  \n　a b.jpnov').lines;
  assert.deepEqual(got[0], {
    line: 0,
    range: { startChar: 2, endChar: 19 },
    raw: '  chapter one.jpnov  ',
    value: 'chapter one.jpnov',
    kind: 'ok',
  });
  assert.deepEqual(got[1], {
    line: 1,
    range: { startChar: 1, endChar: 10 },
    raw: '　a b.jpnov',
    value: 'a b.jpnov',
    kind: 'ok',
  });
});

test('parseJpbook allows subdir paths', () => {
  assert.deepEqual(parseJpbook('chapters/01.jpnov').lines, [
    { line: 0, range: { startChar: 0, endChar: 17 }, raw: 'chapters/01.jpnov', value: 'chapters/01.jpnov', kind: 'ok' },
  ]);
});

test('parseJpbook rejects backslash with an error carrying the path range', () => {
  const l = parseJpbook('sub\\a.jpnov').lines[0];
  assert.ok(l);
  assert.deepEqual(l.kind, { error: { code: 'jpbook.backslashSeparator', args: ['sub\\a.jpnov'] } });
  assert.deepEqual(l.range, { startChar: 0, endChar: 11 });
});

test('parseJpbook rejects non-.jpnov entries', () => {
  const l = parseJpbook('note.md').lines[0];
  assert.ok(l);
  assert.deepEqual(l.kind, { error: { code: 'jpbook.notJpnov', args: ['note.md'] } });
});

test('parseJpbook marks later exact repeats as duplicate; first stays ok', () => {
  assert.deepEqual(kinds('a.jpnov\nb.jpnov\na.jpnov'), ['ok', 'ok', 'duplicate']);
});

// --- parseJpbook: front matter ----------------------------------------------

test('parseJpbook with no front matter yields an empty meta', () => {
  assert.deepEqual(parseJpbook('a.jpnov').meta, {});
});

test('parseJpbook collects fenced metadata and still parses the body', () => {
  const got = parseJpbook('---\ntitle: 作品名　第一巻\nheader: 作品名　一\n---\na.jpnov');
  assert.deepEqual(got.lines.map((l) => l.kind), ['fence', 'meta', 'meta', 'fence', 'ok']);
  assert.deepEqual(got.meta, { title: '作品名　第一巻', header: '作品名　一' });
});

test('parseJpbook accepts every recognized key and validates the enum', () => {
  const got = parseJpbook(
    '---\ntitle: t\nheader: h\nfooterAlign: left\nfooter: ［＃ここに「ページ番号」の値を表示］\n---\n',
  );
  assert.deepEqual(got.meta, {
    title: 't',
    header: 'h',
    footerAlign: 'left',
    footer: '［＃ここに「ページ番号」の値を表示］',
  });
});

test('parseJpbook accepts a full-width colon separator', () => {
  const got = parseJpbook('---\ntitle：第一巻\n---\n');
  assert.deepEqual(got.meta, { title: '第一巻' });
  assert.equal(got.lines[1]?.kind, 'meta');
});

test('parseJpbook: an empty value is kept (explicitly blank)', () => {
  assert.deepEqual(parseJpbook('---\nheader:\n---\n').meta, { header: '' });
});

test('parseJpbook: blank lines inside the front matter are skipped', () => {
  assert.deepEqual(kinds('---\n\ntitle: t\n\n---\n'), ['fence', 'blank', 'meta', 'blank', 'fence', 'blank']);
});

test('parseJpbook warns on an unknown key (with the known-key list) and ignores it', () => {
  const got = parseJpbook('---\npublisher: 誰か\n---\n');
  assert.deepEqual(got.meta, {});
  assert.deepEqual(got.lines[1]?.kind, {
    warning: {
      code: 'jpbook.metaUnknownKey',
      args: ['publisher', FRONT_MATTER_KEYS.join(', ')],
    },
  });
});

test('parseJpbook warns on a duplicate key; the first value wins', () => {
  const got = parseJpbook('---\ntitle: 一\ntitle: 二\n---\n');
  assert.deepEqual(got.meta, { title: '一' });
  assert.deepEqual(got.lines[2]?.kind, { warning: { code: 'jpbook.metaDuplicateKey', args: ['title'] } });
});

test('divider is a free-string key; parse/composeDividerValue split mark and 字下げ', () => {
  assert.deepEqual(parseJpbook('---\ndivider: ＊　＊　＊\n---\na.jpnov\n').meta, {
    divider: '＊　＊　＊',
  });
  assert.deepEqual(parseDividerValue('＊　＊　＊'), { mark: '＊　＊　＊', indent: null });
  assert.deepEqual(parseDividerValue('［＃２字下げ］◇'), { mark: '◇', indent: 2 });
  // The 字下げ must LEAD the value (the tokenizer's own line-head contract).
  assert.deepEqual(parseDividerValue('＊［＃２字下げ］'), { mark: '＊［＃２字下げ］', indent: null });
  assert.equal(composeDividerValue('＊', null), '＊');
  assert.equal(composeDividerValue('＊', 15), '［＃１５字下げ］＊');
  assert.deepEqual(parseDividerValue(composeDividerValue('†', 3)), { mark: '†', indent: 3 });
});

test('parseJpbook warns on an invalid footerAlign value and leaves it unset', () => {
  const got = parseJpbook('---\nfooterAlign: middle\n---\n');
  assert.deepEqual(got.meta, {});
  assert.deepEqual(got.lines[1]?.kind, {
    warning: {
      code: 'jpbook.metaBadEnum',
      args: ['footerAlign', 'middle', 'right, left, rightLeft, leftRight, none'],
    },
  });
});

test('parseJpbook errors on a colon-less (or key-less) metadata line', () => {
  assert.deepEqual(parseJpbook('---\njust text\n---\n').lines[1]?.kind, {
    error: { code: 'jpbook.metaNotKeyValue', args: ['just text'] },
  });
  assert.deepEqual(parseJpbook('---\n: no key\n---\n').lines[1]?.kind, {
    error: { code: 'jpbook.metaNotKeyValue', args: [': no key'] },
  });
});

test('parseJpbook: an unterminated block turns the opening fence into an error; meta still collects', () => {
  const got = parseJpbook('---\ntitle: t\na.jpnov');
  assert.deepEqual(got.lines[0]?.kind, { error: { code: 'jpbook.metaUnterminated', args: [] } });
  assert.equal(got.lines[1]?.kind, 'meta');
  // The path line is INSIDE the (unterminated) block, so it reads as a broken meta line.
  assert.deepEqual(got.lines[2]?.kind, { error: { code: 'jpbook.metaNotKeyValue', args: ['a.jpnov'] } });
  assert.deepEqual(got.meta, { title: 't' });
});

test('parseJpbook: front matter opens ONLY on the first non-blank line', () => {
  // Leading blanks are fine…
  assert.deepEqual(kinds('\n---\ntitle: t\n---\n'), ['blank', 'fence', 'meta', 'fence', 'blank']);
  // …but after a chapter line a --- is just an invalid path.
  assert.deepEqual(parseJpbook('a.jpnov\n---').lines[1]?.kind, {
    error: { code: 'jpbook.notJpnov', args: ['---'] },
  });
});

// --- parseJpbook: the cover list ---------------------------------------------

const ORPHAN = (value: string): JpbookLineKind => ({
  error: { code: 'jpbook.coverItemWithoutKey', args: [value] },
});
const DUP_COVER: JpbookLineKind = { warning: { code: 'jpbook.metaDuplicateKey', args: ['cover'] } };

test('cover: a bare key opens a list of "- " items; the body still parses', () => {
  assert.deepEqual(kinds('---\ncover:\n- c1.jpnov\n- c2.jpnov\n---\nch.jpnov\n'), [
    'fence', 'cover', 'coverEntry', 'coverEntry', 'fence', 'ok', 'blank',
  ]);
});

test('cover: a value on the key line is an error steering to the list form', () => {
  // ONE spelling: a `key: value` paints as a string, where VS Code withholds completion.
  const NEEDS_LIST = (value: string): JpbookLineKind => ({
    error: { code: 'jpbook.coverNeedsList', args: [value] },
  });
  assert.deepEqual(kinds('---\ncover: c.jpnov\n---\n'), [
    'fence', NEEDS_LIST('cover: c.jpnov'), 'fence', 'blank',
  ]);
  // The rejected key opens nothing…
  assert.deepEqual(kinds('---\ncover: c.jpnov\n- c2.jpnov\n---\n'), [
    'fence', NEEDS_LIST('cover: c.jpnov'), ORPHAN('- c2.jpnov'), 'fence', 'blank',
  ]);
  // …and does not consume the key, so a real list still works below it.
  assert.deepEqual(kinds('---\ncover: c.jpnov\ncover:\n- c2.jpnov\n---\n'), [
    'fence', NEEDS_LIST('cover: c.jpnov'), 'cover', 'coverEntry', 'fence', 'blank',
  ]);
});

test('cover: an item with no open list is an error; the fence and any other key close one', () => {
  assert.deepEqual(kinds('---\n- c.jpnov\n---\n'), ['fence', ORPHAN('- c.jpnov'), 'fence', 'blank']);
  assert.deepEqual(kinds('---\ncover:\n- c1.jpnov\ntitle: t\n- c2.jpnov\n---\n'), [
    'fence', 'cover', 'coverEntry', 'meta', ORPHAN('- c2.jpnov'), 'fence', 'blank',
  ]);
  // Past the closing fence a "- x.jpnov" line is an ordinary chapter path again.
  assert.deepEqual(kinds('---\ncover:\n---\n- c.jpnov\n'), ['fence', 'cover', 'fence', 'ok', 'blank']);
});

test('cover: blank lines do not close an open list', () => {
  assert.deepEqual(kinds('---\ncover:\n\n- c.jpnov\n---\n'), [
    'fence', 'cover', 'blank', 'coverEntry', 'fence', 'blank',
  ]);
});

test('cover: an empty list is as legal as an absent key', () => {
  const got = parseJpbook('---\ncover:\n---\nch.jpnov\n');
  assert.deepEqual(got.lines.map((l) => l.kind), ['fence', 'cover', 'fence', 'ok', 'blank']);
  assert.deepEqual(got.meta, {}); // cover is never a JpbookMeta field
});

test('cover: items take a full-width dash and need no space after it', () => {
  assert.deepEqual(kinds('---\ncover:\n－c1.jpnov\n-c2.jpnov\n　- c3.jpnov\n---\n'), [
    'fence', 'cover', 'coverEntry', 'coverEntry', 'coverEntry', 'fence', 'blank',
  ]);
});

test('cover: the key takes a full-width colon like every other key', () => {
  assert.deepEqual(kinds('---\ncover：\n- c.jpnov\n---\n'), [
    'fence', 'cover', 'coverEntry', 'fence', 'blank',
  ]);
  assert.deepEqual(parseJpbook('---\ncover：c.jpnov\n---\n').lines[1]?.kind, {
    error: { code: 'jpbook.coverNeedsList', args: ['cover：c.jpnov'] },
  });
});

test('cover: item paths validate like chapter paths, quoting the line an item stands on', () => {
  // Items quote the WHOLE line: a sliced marker can leave a fence-lookalike (`----`).
  assert.deepEqual(parseJpbook('---\ncover:\n- note.md\n---\n').lines[2]?.kind, {
    error: { code: 'jpbook.notJpnov', args: ['- note.md'] },
  });
  assert.deepEqual(parseJpbook('---\ncover:\n- sub\\c.jpnov\n---\n').lines[2]?.kind, {
    error: { code: 'jpbook.backslashSeparator', args: ['- sub\\c.jpnov'] },
  });
  assert.deepEqual(parseJpbook('---\ncover:\n----\n---\n').lines[2]?.kind, {
    error: { code: 'jpbook.notJpnov', args: ['----'] },
  });
});

test('the front-matter key list is the user-visible contract', () => {
  // A stable contract, pinned literally: everything else derives from these constants.
  assert.deepEqual([...FRONT_MATTER_KEYS], [
    'title', 'author', 'header', 'footer', 'footerAlign', 'divider', 'cover',
  ]);
  assert.deepEqual([...COVER_ITEM_MARKS], ['-', '－']);
});

test('cover: a marker with no path behind it reports the line, not an empty name', () => {
  assert.deepEqual(parseJpbook('---\ncover:\n-\n－\n---\n').lines[2]?.kind, {
    error: { code: 'jpbook.notJpnov', args: ['-'] },
  });
  assert.deepEqual(parseJpbook('---\ncover:\n-\n－\n---\n').lines[3]?.kind, {
    error: { code: 'jpbook.notJpnov', args: ['－'] },
  });
});

test('cover: repeats dedupe among covers only — a chapter may also be a cover', () => {
  assert.deepEqual(kinds('---\ncover:\n- c.jpnov\n- c.jpnov\n---\n'), [
    'fence', 'cover', 'coverEntry', 'coverDuplicate', 'fence', 'blank',
  ]);
  assert.deepEqual(kinds('---\ncover:\n- a.jpnov\n---\na.jpnov\n'), [
    'fence', 'cover', 'coverEntry', 'fence', 'ok', 'blank',
  ]);
});

test('cover: a duplicate key warns; a duplicate bare key mutes its items (no orphan cascade)', () => {
  assert.deepEqual(kinds('---\ncover:\n- c1.jpnov\ncover:\n- c2.jpnov\n---\n'), [
    'fence', 'cover', 'coverEntry', DUP_COVER, DUP_COVER, 'fence', 'blank',
  ]);
  // A second BARE key is the only duplicate shape left; each `cover: value` line is its own error.
  assert.deepEqual(kinds('---\ncover:\ncover:\n---\n'), ['fence', 'cover', DUP_COVER, 'fence', 'blank']);
});

test('cover: an unterminated front matter still parses its list', () => {
  assert.deepEqual(kinds('---\ncover:\n- c.jpnov\n'), [
    { error: { code: 'jpbook.metaUnterminated', args: [] } }, 'cover', 'coverEntry', 'blank',
  ]);
});

test('coverPathOf spans the PATH only, past the marker and any leading whitespace', () => {
  const lines = parseJpbook('---\ncover:\n  - src/c2.jpnov\n---\n').lines;
  const item = lines[2];
  assert.ok(item);
  assert.deepEqual(coverPathOf(item), {
    value: 'src/c2.jpnov',
    range: { startChar: 4, endChar: 16 },
  });
  // The span ends where the trimmed line does — only the marker is excluded.
  assert.equal(coverPathOf(item)?.range.endChar, item.range.endChar);
  assert.ok(isCover(item));
  const fence = lines[0];
  assert.ok(fence);
  // The fence IS item-shaped (`coverShape('---')` slices `--`); what makes this null is the
  // line's KIND. Never relax that guard back to a shape test.
  assert.equal(coverPathOf(fence), null);
});

test('coverPathOf returns null for the bare key line (no path to point at)', () => {
  const key = parseJpbook('---\ncover:\n- c.jpnov\n---\n').lines[1];
  assert.ok(key);
  assert.equal(key.kind, 'cover');
  assert.equal(isCover(key), false);
  assert.equal(coverPathOf(key), null);
});

// --- metaRegionOf ------------------------------------------------------------

test('metaRegionOf: closed block, unterminated block, and no block', () => {
  assert.deepEqual(metaRegionOf(parseJpbook('---\ntitle: t\n---\na.jpnov').lines), { open: 0, close: 2 });
  assert.deepEqual(metaRegionOf(parseJpbook('\n---\ntitle: t').lines), { open: 1, close: null });
  assert.equal(metaRegionOf(parseJpbook('a.jpnov').lines), null);
  assert.equal(metaRegionOf(parseJpbook('').lines), null);
});

// --- firstErrorOf ------------------------------------------------------------

test('firstErrorOf: null for an empty manifest and for one with only warnings and duplicates', () => {
  assert.equal(firstErrorOf(parseJpbook('').lines), null);
  const tolerated = '---\npublisher: x\ntitle: a\ntitle: b\nfooterAlign: bad\n---\na.jpnov\na.jpnov';
  assert.equal(firstErrorOf(parseJpbook(tolerated).lines), null);
});

test('firstErrorOf: the first Error line in document order (the root cause, not its cascade)', () => {
  // An unterminated block reports its patched fence, not the chapter lines it swallowed.
  assert.deepEqual(firstErrorOf(parseJpbook('---\ntitle: t\na.jpnov\nb.jpnov').lines), {
    code: 'jpbook.metaUnterminated',
    args: [],
  });
  assert.deepEqual(firstErrorOf(parseJpbook('a.jpnov\nb.txt\nc\\d.jpnov').lines), {
    code: 'jpbook.notJpnov',
    args: ['b.txt'],
  });
  // A `cover: value` line comes before the orphan items it leaves behind.
  assert.deepEqual(firstErrorOf(parseJpbook('---\ncover: x.jpnov\n- y.jpnov\n---\na.jpnov').lines), {
    code: 'jpbook.coverNeedsList',
    args: ['cover: x.jpnov'],
  });
});

// --- composeBookChrome --------------------------------------------------------

const BASE = { lineNumbers: true, edgeLine: 'red' } as const;

test('composeBookChrome: absent keys fall back to the product defaults', () => {
  assert.deepEqual(composeBookChrome(BASE, {}), {
    lineNumbers: true,
    edgeLine: 'red',
    footerAlign: 'right',
    footer: '［＃ここに「ページ番号」の値を表示］ / ［＃ここに「総ページ数」の値を表示］',
    header: '',
  });
});

test('composeBookChrome: front-matter values override the furniture, never the proofing base', () => {
  assert.deepEqual(
    composeBookChrome(BASE, {
      header: '第二巻',
      footerAlign: 'none',
      footer: '［＃ここに「ページ番号」の値を表示］',
    }),
    {
      lineNumbers: true,
      edgeLine: 'red',
      footerAlign: 'none',
      footer: '［＃ここに「ページ番号」の値を表示］',
      header: '第二巻',
    },
  );
});

test('composeBookChrome: an explicitly empty footer is preserved (footer suppression)', () => {
  assert.equal(composeBookChrome(BASE, { footer: '' }).footer, '');
});

// --- jpbookOutRel --------------------------------------------------------

test('jpbookOutRel: flat name maps to its stem', () => {
  assert.equal(jpbookOutRel('volume01.jpbook'), 'volume01');
});

test('jpbookOutRel: index collapses to the parent directory', () => {
  assert.equal(jpbookOutRel('volume01/index.jpbook'), 'volume01');
  assert.equal(jpbookOutRel('part1/vol2/index.jpbook'), 'part1/vol2');
});

test('jpbookOutRel: nested segments path-join (mirror the source tree)', () => {
  assert.equal(jpbookOutRel('part1/vol2.jpbook'), 'part1/vol2');
  assert.equal(jpbookOutRel('a/b/c.jpbook'), 'a/b/c');
  assert.equal(jpbookOutRel('part1\\vol2.jpbook'), 'part1/vol2');
  assert.equal(jpbookOutRel('01-volume/01-volume/index.jpbook'), '01-volume/01-volume');
});

test('jpbookOutRel: root-level index keeps index (no parent)', () => {
  assert.equal(jpbookOutRel('index.jpbook'), 'index');
});

test('jpbookOutRel collision: index form and flat form produce the same path', () => {
  assert.equal(jpbookOutRel('volume01/index.jpbook'), jpbookOutRel('volume01.jpbook'));
});

// --- completeEntryLine --------------------------------------------------

test('completeEntryLine filters by segment; hides dotfiles, .jpbook, non-.jpnov', () => {
  const got = completeEntryLine('ch', [
    E('chapter1.jpnov'),
    E('chapter2.jpnov'),
    E('notes.md'),
    E('.hidden.jpnov'),
    E('index.jpbook'),
    E('sub', true),
  ]);
  assert.deepEqual(got, [
    { label: 'chapter1.jpnov', insertText: 'chapter1.jpnov', kind: 'file', replace: { startChar: 0, endChar: 2 } },
    { label: 'chapter2.jpnov', insertText: 'chapter2.jpnov', kind: 'file', replace: { startChar: 0, endChar: 2 } },
  ]);
});

test('completeEntryLine drills into directories with a trailing slash', () => {
  const dir = completeEntryLine('', [E('sub', true), E('a.jpnov')]).find((c) => c.kind === 'folder');
  assert.equal(dir?.insertText, 'sub/');
});

test('completeEntryLine replace range is the segment after the last slash', () => {
  assert.deepEqual(completeEntryLine('chapters/ch', [E('chapter1.jpnov')]), [
    { label: 'chapter1.jpnov', insertText: 'chapter1.jpnov', kind: 'file', replace: { startChar: 9, endChar: 11 } },
  ]);
});

test('completeEntryLine matches case-insensitively but inserts the on-disk casing', () => {
  const got = completeEntryLine('CH', [E('Chapter1.jpnov')]);
  assert.equal(got.length, 1);
  assert.equal(got[0]?.insertText, 'Chapter1.jpnov');
});

test('completeEntryLine excludes leading whitespace from the replace range', () => {
  const got = completeEntryLine('  ch', [E('chapter1.jpnov')]);
  assert.deepEqual(got[0]?.replace, { startChar: 2, endChar: 4 });
});

test('completeEntryLine respects the cap', () => {
  const many = Array.from({ length: 10 }, (_, i) => E(`f${String(i)}.jpnov`));
  assert.equal(completeEntryLine('f', many, 3).length, 3);
});

// --- completeMetaLine --------------------------------------------------------

test('completeMetaLine offers every key on an empty line, inserted as "key: "', () => {
  const got = completeMetaLine('');
  assert.deepEqual(got.map((c) => c.label), [...FRONT_MATTER_KEYS]);
  const first = got[0];
  assert.ok(first);
  assert.equal(first.insertText, 'title: ');
  assert.equal(first.kind, 'key');
  assert.deepEqual(first.replace, { startChar: 0, endChar: 0 });
});

test('completeMetaLine filters keys by case-insensitive prefix, replacing the typed span', () => {
  const got = completeMetaLine('  FOOT');
  assert.deepEqual(got.map((c) => c.label), ['footer', 'footerAlign']);
  assert.deepEqual(got[0]?.replace, { startChar: 2, endChar: 6 });
});

test('completeMetaLine offers enum members after "footerAlign:"', () => {
  const got = completeMetaLine('footerAlign: le');
  assert.deepEqual(got.map((c) => c.label), ['left', 'leftRight']);
  const first = got[0];
  assert.ok(first);
  assert.equal(first.kind, 'value');
  assert.deepEqual(first.replace, { startChar: 13, endChar: 15 });
});

test('completeMetaLine offers nothing after the colon of a free-text key', () => {
  assert.deepEqual(completeMetaLine('title: 夜'), []);
  assert.deepEqual(completeMetaLine('header: '), []);
});

test('completeMetaLine offers the preset marks after "divider:"', () => {
  assert.deepEqual(completeMetaLine('divider: ').map((c) => c.label), ['＊', '＊　＊　＊', '◇']);
  const first = completeMetaLine('divider: ')[0];
  assert.ok(first);
  assert.equal(first.kind, 'value');
});
