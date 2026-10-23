import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  completeEntryLine,
  checkJpbook,
  completeMeta,
  completeMetaLine,
  composeBookChrome,
  composeBookInput,
  entryPaths,
  ITEM_MARKS,
  entryIdentity,
  inlineKeyOf,
  KNOWN_KEYS,
  isEntryOf,
  HEADER,
  JPBOOK_VERSION,
  META_DEFAULTS,
  META_KEYS,
  metaEndOf,
  parseDividerValue,
  parseJpbook,
  writtenKeysOf,
  type CompletionEntry,
  type JpbookLineKind,
  type ParsedJpbook,
  type ParsedLine,
} from '../../../src/shared/book/jpbook.ts';
import { composeDividerValue, INDENT_MAX } from '../../../src/shared/ast/notation.ts';
import { FURNITURE_ALIGNS } from '../../../src/shared/compiler/chrome.ts';
import { below, HEAD, meta, metaBody, metaWith } from './_fixture.ts';

/** Parses `text` as the lines written below the header, numbered from there. */
const parse = (text: string): ParsedJpbook => below(parseJpbook(HEAD + text), 1);
const kinds = (text: string): JpbookLineKind[] => parse(text).lines.map((l) => l.kind);
/** The lines of `text` written below an (empty) metadata block's `---`, numbered from that point. */
const chapters = (text: string): readonly ParsedLine[] => below(parse(`---\n${text}`), 1).lines;
const chapterKinds = (text: string): JpbookLineKind[] => chapters(text).map((l) => l.kind);
const E = (name: string, isDir = false): CompletionEntry => ({ name, isDir });
/** The value and span an entry line lists, its identity aside; null off an entry. */
const valueOf = (pl: ParsedLine): { value: string; range: ParsedLine['range'] } | null =>
  pl.item === undefined ? null : { value: pl.item.value, range: pl.item.range };
/** The entry a chapter line of `path` carries. */
const chapterItem = (path: string, startChar = 0): ParsedLine['item'] =>
  ({ value: path, range: { startChar, endChar: startChar + path.length }, identity: entryIdentity(path) });

// --- parseJpbook: chapter lines ---------------------------------------------

test('parseJpbook returns ordered ok lines with exact ranges', () => {
  assert.deepEqual(chapters('a.jpnov\nb.jpnov'), [
    { line: 0, range: { startChar: 0, endChar: 7 }, raw: 'a.jpnov', value: 'a.jpnov', kind: 'ok', list: 'chapters', item: chapterItem('a.jpnov') },
    { line: 1, range: { startChar: 0, endChar: 7 }, raw: 'b.jpnov', value: 'b.jpnov', kind: 'ok', list: 'chapters', item: chapterItem('b.jpnov') },
  ]);
});

test('parseJpbook skips blank / whitespace-only / full-width-space-only lines (zero-width range)', () => {
  const got = chapters('a.jpnov\n\n   \n　　\nb.jpnov');
  assert.deepEqual(got.map((l) => l.kind), ['ok', 'blank', 'blank', 'blank', 'ok']);
  for (const l of got.filter((x) => x.kind === 'blank')) {
    assert.deepEqual(l.range, { startChar: 0, endChar: 0 });
    assert.equal(l.value, '');
  }
});

test('parseJpbook is CRLF-safe: strips trailing \\r, range excludes it', () => {
  const got = chapters('a.jpnov\r\nb.jpnov\r\n');
  assert.equal(got.length, 3);
  assert.deepEqual(got[0], { line: 0, range: { startChar: 0, endChar: 7 }, raw: 'a.jpnov', value: 'a.jpnov', kind: 'ok', list: 'chapters', item: chapterItem('a.jpnov') });
  assert.equal(got[1]?.value, 'b.jpnov');
  assert.equal(got[2]?.kind, 'blank');
});

test('parseJpbook trims edges (incl. full-width) but preserves interior whitespace', () => {
  const got = chapters('  chapter one.jpnov  \n　a b.jpnov');
  assert.deepEqual(got[0], {
    line: 0,
    range: { startChar: 2, endChar: 19 },
    raw: '  chapter one.jpnov  ',
    value: 'chapter one.jpnov',
    kind: 'ok',
    list: 'chapters',
    item: chapterItem('chapter one.jpnov', 2),
  });
  assert.deepEqual(got[1], {
    line: 1,
    range: { startChar: 1, endChar: 10 },
    raw: '　a b.jpnov',
    value: 'a b.jpnov',
    kind: 'ok',
    list: 'chapters',
    item: chapterItem('a b.jpnov', 1),
  });
});

test('parseJpbook allows subdir paths', () => {
  assert.deepEqual(chapters('chapters/01.jpnov'), [
    { line: 0, range: { startChar: 0, endChar: 17 }, raw: 'chapters/01.jpnov', value: 'chapters/01.jpnov', kind: 'ok', list: 'chapters', item: chapterItem('chapters/01.jpnov') },
  ]);
});

test('parseJpbook rejects backslash with an error carrying the path range', () => {
  const l = chapters('sub\\a.jpnov')[0];
  assert.ok(l);
  assert.deepEqual(l.kind, { error: { code: 'jpbook.backslashSeparator', args: ['sub\\a.jpnov'] } });
  assert.deepEqual(l.range, { startChar: 0, endChar: 11 });
});

test('parseJpbook rejects non-.jpnov entries', () => {
  const l = chapters('note.md')[0];
  assert.ok(l);
  assert.deepEqual(l.kind, { error: { code: 'jpbook.notJpnov', args: ['note.md'] } });
});

test('parseJpbook takes the .jpnov extension in any letter case (#86)', () => {
  assert.deepEqual(chapterKinds('a.JPNOV\nb.Jpnov'), ['ok', 'ok']);
  assert.deepEqual(kinds('cover:\n- c.JPNOV\n'), ['cover', 'coverEntry', 'blank']);
});

test('parseJpbook marks later exact repeats as duplicate; first stays ok', () => {
  assert.deepEqual(chapterKinds('a.jpnov\nb.jpnov\na.jpnov'), ['ok', 'ok', 'duplicate']);
});

test('parseJpbook dedupes by entryIdentity: ./, empty segments, a folded .. and NFC name one file (#86, #193)', () => {
  assert.deepEqual(chapterKinds('a.jpnov\nx/../a.jpnov'), ['ok', 'duplicate']);
  // A path above the book is its own entry; two spellings of it are one.
  assert.deepEqual(chapterKinds('a.jpnov\n../a.jpnov\n../x/../a.jpnov'), ['ok', 'ok', 'duplicate']);
  assert.equal(entryIdentity('x/../a.jpnov'), 'a.jpnov');
  assert.equal(entryIdentity('../x/../a.jpnov'), '../a.jpnov');
  assert.deepEqual(chapterKinds('a.jpnov\n./a.jpnov\nb//c.jpnov\nb/c.jpnov\nが.jpnov\nが.jpnov'), [
    'ok', 'duplicate', 'ok', 'duplicate', 'ok', 'duplicate',
  ]);
  assert.deepEqual(kinds('cover:\n- c.jpnov\n- ./c.jpnov\n'), ['cover', 'coverEntry', 'coverDuplicate', 'blank']);
  // The line keeps its value as written; only the identity folds.
  assert.equal(chapters('./a.jpnov')[0]?.value, './a.jpnov');
  assert.equal(entryIdentity('./b//c.jpnov'), 'b/c.jpnov');
});

// --- parseJpbook: metadata ---------------------------------------------------

const ORPHAN = (value: string): JpbookLineKind => ({
  error: { code: 'jpbook.itemWithoutKey', args: [value] },
});

test('parseJpbook: an empty metadata block (a lone fence): the keys an empty value suits are empty, the others absent', () => {
  const got = parse('---\na.jpnov');
  assert.deepEqual(got.lines.map((l) => l.kind), ['fence', 'ok']);
  assert.deepEqual(got.meta, {});
  assert.equal(got.fence, 0);
});

test('parseJpbook collects the metadata above the fence and parses the chapters below it', () => {
  const got = parse('title: 作品名　第一巻\nheader: 作品名　一\n---\na.jpnov');
  assert.deepEqual(got.lines.map((l) => l.kind), ['meta', 'meta', 'fence', 'ok']);
  assert.deepEqual(got.meta, { title: '作品名　第一巻', header: '作品名　一' });
  assert.equal(got.fence, 2);
});

test('parseJpbook: a metadata line carries its value with the column span of the value; a line in Error does not', () => {
  const got = parse('title: 作品名\ndivider:  　＊\nheaderAlign: nope\nheader:\n');
  assert.deepEqual(got.lines.map((l) => l.meta), [
    { key: 'title', value: '作品名', range: { startChar: 7, endChar: 10 } },
    { key: 'divider', value: '＊', range: { startChar: 11, endChar: 12 } }, // past the spaces, half- or full-width
    undefined,
    { key: 'header', value: '', range: { startChar: 7, endChar: 7 } },
    undefined,
  ]);
  assert.ok(got.lines.every((l) => l.item === undefined)); // never an entry
});

test('parseJpbook: a complete book; blank lines around the fence are skipped', () => {
  const got = parseJpbook(`${meta()}\n\na.jpnov\n`);
  assert.equal(got.fence, 8);
  assert.equal(metaEndOf(got), 8);
  assert.deepEqual(Object.keys(got.meta), [...META_KEYS]);
  assert.equal(got.lines[11]?.kind, 'ok');
});

test('parseJpbook: without a fence the whole file is metadata', () => {
  const got = parse('title: t\na.jpnov\n');
  assert.equal(got.fence, null);
  assert.equal(metaEndOf(got), 3);
  assert.deepEqual(got.lines.map((l) => l.kind), [
    'meta', { error: { code: 'jpbook.metaNotKeyValue', args: ['a.jpnov'] } }, 'blank',
  ]);
  assert.equal(parse('').fence, null);
});

test('parseJpbook accepts every recognized key and validates the enum', () => {
  const got = parse(
    'title: t\nheader: h\nheaderAlign: right\nfooterAlign: left\nfooter: ［＃ここに「ページ番号」の値を表示］\n',
  );
  assert.deepEqual(got.meta, {
    title: 't',
    header: 'h',
    headerAlign: 'right',
    footerAlign: 'left',
    footer: '［＃ここに「ページ番号」の値を表示］',
  });
});

test('parseJpbook accepts a full-width colon separator', () => {
  const got = parse('title：第一巻\n');
  assert.deepEqual(got.meta, { title: '第一巻' });
  assert.equal(got.lines[0]?.kind, 'meta');
});

test('parseJpbook: an empty value is the value written; an empty title is an Error that takes its key', () => {
  const text = 'title:\nauthor:　\nheader:\nfooter:\ndivider:\n';
  const got = parse(text);
  assert.deepEqual(got.meta, { author: '', header: '', footer: '', divider: '' });
  assert.deepEqual(kinds(text).slice(0, 5), [
    { error: { code: 'jpbook.metaEmptyValue', args: ['title'] } }, 'meta', 'meta', 'meta', 'meta',
  ]);
});

// --- parseJpbook: the header -------------------------------------------------

test('parseJpbook: the first line is the header, naming the version; a BOM before it is tolerated', () => {
  assert.equal(HEADER, 'jpbook/1');
  const ok = parseJpbook('jpbook/1\ntitle: t\n');
  assert.deepEqual(ok.lines[0], { line: 0, range: { startChar: 0, endChar: 8 }, raw: 'jpbook/1', value: 'jpbook/1', kind: 'header' });
  assert.deepEqual(ok.meta, { title: 't' });

  const bom = parseJpbook('\uFEFFjpbook/1\r\ntitle: t\r\n');
  assert.deepEqual(bom.lines[0], { line: 0, range: { startChar: 1, endChar: 9 }, raw: '\uFEFFjpbook/1', value: 'jpbook/1', kind: 'header' });
  assert.deepEqual(bom.meta, { title: 't' });

  // A header-shaped line below the header is a key-less metadata line like any other.
  assert.deepEqual(kinds('jpbook/1\n')[0], { error: { code: 'jpbook.metaNotKeyValue', args: ['jpbook/1'] } });
});

test('parseJpbook: a first line that is no header is the one Error; nothing below it is read', () => {
  // Nothing else is tolerated before or around it: no blank line, no indent, no other spelling.
  for (const first of ['', ' jpbook/1', 'JPBOOK/1', 'jpbook 1', 'version: 1.0', '---', 'title: t']) {
    const got = parseJpbook(`${first}\ntitle: t\n\nnot a key\n---\na.jpnov\n`);
    assert.deepEqual(got.lines[0]?.kind, { error: { code: 'jpbook.headerMissing', args: [HEADER] } }, first);
    assert.deepEqual(got.lines.slice(1).map((l) => l.kind), ['unread', 'blank', 'unread', 'unread', 'unread', 'blank'], first);
    assert.equal(got.fence, null, first);
    assert.deepEqual(got.meta, {}, first);
    assert.equal(got.metaError, null, first);
    assert.deepEqual(checkJpbook(got), { ok: false, error: { code: 'jpbook.headerMissing', args: [HEADER] } }, first);
  }
  // The lines keep their content and spans, so edits can still find their way around them.
  const unread = parseJpbook('\n  title: t\n').lines[1];
  assert.deepEqual(unread, { line: 1, range: { startChar: 2, endChar: 10 }, raw: '  title: t', value: 'title: t', kind: 'unread' });
});

test('parseJpbook: a header naming a version this extension has no parser for is the one Error', () => {
  // Exact match only: a minor number, a space, an empty version are all versions it does not read.
  for (const version of ['2', '1.0', '', '1 ', '01']) {
    const got = parseJpbook(`jpbook/${version}\ntitle: t\n---\na.jpnov\n`);
    assert.deepEqual(
      got.lines[0]?.kind,
      { error: { code: 'jpbook.versionUnsupported', args: [version, JPBOOK_VERSION] } },
      version,
    );
    assert.deepEqual(got.lines.slice(1).map((l) => l.kind), ['unread', 'unread', 'unread', 'blank'], version);
    assert.equal(got.metaError, null, version);
    assert.deepEqual(
      checkJpbook(got),
      { ok: false, error: { code: 'jpbook.versionUnsupported', args: [version, JPBOOK_VERSION] } },
      version,
    );
  }
});

test('parseJpbook: a title that shows nothing in an output is empty too', () => {
  // The control characters no output can carry are dropped, so they count as blank.
  for (const title of ['\u0007', '\u0007\u3000\u001F']) {
    assert.deepEqual(parse(`title: ${title}\n---\n`).lines[0]?.kind, {
      error: { code: 'jpbook.metaEmptyValue', args: ['title'] },
    }, JSON.stringify(title));
  }
  assert.deepEqual(parse('title: a\u0007\n---\n').meta, { title: 'a\u0007' });
});

test('parseJpbook: an empty first title line still takes its key', () => {
  const got = parse('title:\ntitle: 作品名\n---\n');
  assert.deepEqual(got.meta, {});
  assert.deepEqual(got.lines[1]?.kind, { warning: { code: 'jpbook.metaDuplicateKey', args: ['title'] } });
  // Taken by its line in Error: not reported again on the fence.
  assert.equal(got.metaError, null);
});

test('parseJpbook: blank lines among the metadata are skipped', () => {
  assert.deepEqual(kinds('\ntitle: t\n\n'), ['blank', 'meta', 'blank', 'blank']);
});

test('parseJpbook warns on an unknown key (with the known-key list) and ignores it', () => {
  const got = parse('publisher: 誰か\n');
  assert.deepEqual(got.meta, {});
  assert.deepEqual(got.lines[0]?.kind, {
    warning: {
      code: 'jpbook.metaUnknownKey',
      args: ['publisher', KNOWN_KEYS.join(', ')],
    },
  });
});

test('parseJpbook warns on a duplicate key; the first value wins', () => {
  const got = parse('title: 一\ntitle: 二\n');
  assert.deepEqual(got.meta, { title: '一' });
  assert.deepEqual(got.lines[1]?.kind, { warning: { code: 'jpbook.metaDuplicateKey', args: ['title'] } });
});

test('divider is a free-string key; parse/composeDividerValue split mark and 字下げ', () => {
  assert.deepEqual(parse('divider: ＊　＊　＊\na.jpnov\n').meta, { divider: '＊　＊　＊' });
  assert.deepEqual(parseDividerValue('＊　＊　＊'), { mark: '＊　＊　＊', indent: null });
  assert.deepEqual(parseDividerValue('［＃２字下げ］◇'), { mark: '◇', indent: 2 });
  // The 字下げ must LEAD the value: the box edits a position, not spaces inside the mark.
  assert.deepEqual(parseDividerValue('＊［＃２字下げ］'), { mark: '＊［＃２字下げ］', indent: null });
  assert.equal(composeDividerValue({ mark: '＊', indent: null }), '＊');
  assert.equal(composeDividerValue({ mark: '＊', indent: 15 }), '［＃１５字下げ］＊');
  assert.deepEqual(parseDividerValue(composeDividerValue({ mark: '†', indent: 3 })), { mark: '†', indent: 3 });
  // The scanner's limit: the largest 字下げ splits off, a larger one stays in the mark.
  assert.deepEqual(parseDividerValue(composeDividerValue({ mark: '◇', indent: INDENT_MAX })), { mark: '◇', indent: INDENT_MAX });
  const over = composeDividerValue({ mark: '◇', indent: INDENT_MAX + 1 });
  assert.deepEqual(parseDividerValue(over), { mark: over, indent: null });
});

test('parseJpbook: headerAlign and footerAlign take the five alignments and reject anything else', () => {
  for (const key of ['headerAlign', 'footerAlign'] as const) {
    for (const align of FURNITURE_ALIGNS) {
      assert.deepEqual(parse(`${key}: ${align}\n`).meta, { [key]: align }, `${key}: ${align}`);
    }
    // A rejected value (the retired `none` too) or an empty one is an Error — the default is
    // for the unwritten key, not a written one — and takes the key: a later line is a repeat, not the value.
    for (const bad of ['middle', 'none', '']) {
      const got = parse(`${key}: ${bad}\n${key}: left\n`);
      assert.deepEqual(got.lines[0]?.kind, {
        error: bad === '' ? { code: 'jpbook.metaEmptyValue', args: [key] } : { code: 'jpbook.metaBadEnum', args: [key, bad, FURNITURE_ALIGNS.join(', ')] },
      }, `${key}: ${bad}`);
      assert.deepEqual(got.lines[1]?.kind, { warning: { code: 'jpbook.metaDuplicateKey', args: [key] } });
      assert.deepEqual(got.meta, {}, `${key}: ${bad}`);
      assert.notEqual(parse(`${key}: ${bad}\n---\n`).metaError?.error.args?.[0], key, `${key}: ${bad}`);
    }
  }
});

test('parseJpbook errors on a colon-less (or key-less) metadata line, and only that line', () => {
  assert.deepEqual(parse(': no key\n---\n').lines[0]?.kind, {
    error: { code: 'jpbook.metaNotKeyValue', args: [': no key'] },
  });
  // A half-typed key stays in the metadata: the keys below it and the chapters keep their kinds.
  const got = parse('title: t\nhea\nfooter:\n---\na.jpnov\n');
  assert.deepEqual(got.lines.map((l) => l.kind), [
    'meta', { error: { code: 'jpbook.metaNotKeyValue', args: ['hea'] } }, 'meta', 'fence', 'ok', 'blank',
  ]);
  assert.deepEqual(got.meta, { title: 't', footer: '' });
});

test('parseJpbook: below the fence nothing is metadata (a second `---` or a key line is a bad path)', () => {
  assert.deepEqual(kinds('---\na.jpnov\n---\ntitle: x\n- c.jpnov\n'), [
    'fence',
    'ok',
    { error: { code: 'jpbook.notJpnov', args: ['---'] } },
    { error: { code: 'jpbook.notJpnov', args: ['title: x'] } },
    'ok',
    'blank',
  ]);
});

test('parseJpbook: a `---` on the first line closes an empty metadata block at once', () => {
  // Its keys then read as chapters, and every key is missing: the diagnostic says so on line 0.
  const got = parse('---\ntitle: t\n---\na.jpnov\n');
  assert.deepEqual(got.lines.map((l) => l.kind), [
    'fence',
    { error: { code: 'jpbook.notJpnov', args: ['title: t'] } },
    { error: { code: 'jpbook.notJpnov', args: ['---'] } },
    'ok',
    'blank',
  ]);
  assert.equal(got.fence, 0);
});

// --- parseJpbook: the cover list ---------------------------------------------

const DUP_COVER: JpbookLineKind = { warning: { code: 'jpbook.metaDuplicateKey', args: ['cover'] } };

test('cover: a bare key opens a list of "- " items; the body still parses', () => {
  assert.deepEqual(kinds('cover:\n- c1.jpnov\n- c2.jpnov\n---\nch.jpnov\n'), [
    'cover', 'coverEntry', 'coverEntry', 'fence', 'ok', 'blank',
  ]);
});

test('cover: a value on the key line opens the list and is its first item', () => {
  assert.deepEqual(kinds('cover: c.jpnov\n'), ['coverEntry', 'blank']);
  assert.deepEqual(kinds('cover: c.jpnov\n- c2.jpnov\n'), ['coverEntry', 'coverEntry', 'blank']);
  assert.deepEqual(kinds('cover: c.jpnov\n- c.jpnov\n'), ['coverEntry', 'coverDuplicate', 'blank']);
  // The key is taken either way: a second key, valued or bare, is a muted duplicate.
  assert.deepEqual(kinds('cover: c.jpnov\ncover:\n- c2.jpnov\n'), ['coverEntry', DUP_COVER, DUP_COVER, 'blank']);
  assert.deepEqual(kinds('cover:\ncover: c.jpnov\n'), ['cover', DUP_COVER, 'blank']);
  // A bad value still opens the list and reports itself, quoting the whole line.
  assert.deepEqual(kinds('cover: note.md\n- c.jpnov\n'), [
    { error: { code: 'jpbook.notJpnov', args: ['cover: note.md'] } }, 'coverEntry', 'blank',
  ]);
  assert.deepEqual(parse('cover: sub\\c.jpnov\n').lines[0]?.kind, {
    error: { code: 'jpbook.backslashSeparator', args: ['cover: sub\\c.jpnov'] },
  });
});

test('cover: an item with no open list is an error; the fence and any other key close one', () => {
  assert.deepEqual(kinds('- c.jpnov\n'), [ORPHAN('- c.jpnov'), 'blank']);
  assert.deepEqual(kinds('cover:\n- c1.jpnov\ntitle: t\n- c2.jpnov\n'), [
    'cover', 'coverEntry', 'meta', ORPHAN('- c2.jpnov'), 'blank',
  ]);
  // Past the fence a "- x.jpnov" line is an ordinary chapter path.
  assert.deepEqual(kinds('cover:\n---\n- c.jpnov\n'), ['cover', 'fence', 'ok', 'blank']);
  assert.equal(chapters('a.jpnov\n- c.jpnov\n')[1]?.value, '- c.jpnov');
});

test('cover: blank lines do not close an open list', () => {
  assert.deepEqual(kinds('cover:\n\n- c.jpnov\n'), ['cover', 'blank', 'coverEntry', 'blank']);
});

test('cover: an empty list is as legal as an absent key', () => {
  const got = parse('cover:\n---\nch.jpnov\n');
  assert.deepEqual(got.lines.map((l) => l.kind), ['cover', 'fence', 'ok', 'blank']);
  assert.deepEqual(got.meta, {}); // cover is never a JpbookMeta field
});

test('cover: items take a full-width dash and need no space after it', () => {
  assert.deepEqual(kinds('cover:\n－c1.jpnov\n-c2.jpnov\n　- c3.jpnov\n'), [
    'cover', 'coverEntry', 'coverEntry', 'coverEntry', 'blank',
  ]);
});

test('cover: the key takes a full-width colon like every other key', () => {
  assert.deepEqual(kinds('cover：\n- c.jpnov\n'), ['cover', 'coverEntry', 'blank']);
  assert.deepEqual(kinds('cover：c.jpnov\n'), ['coverEntry', 'blank']);
});

test('cover: item paths validate like chapter paths, quoting the line an item stands on', () => {
  // Items quote the WHOLE line: a sliced marker can leave a leftover-fence lookalike (`----`).
  assert.deepEqual(parse('cover:\n- note.md\n').lines[1]?.kind, {
    error: { code: 'jpbook.notJpnov', args: ['- note.md'] },
  });
  assert.deepEqual(parse('cover:\n- sub\\c.jpnov\n').lines[1]?.kind, {
    error: { code: 'jpbook.backslashSeparator', args: ['- sub\\c.jpnov'] },
  });
  assert.deepEqual(parse('cover:\n----\n').lines[1]?.kind, {
    error: { code: 'jpbook.notJpnov', args: ['----'] },
  });
});

test('the metadata key list is the user-visible contract', () => {
  // A stable contract, pinned literally: everything else derives from these constants.
  assert.deepEqual([...KNOWN_KEYS], [
    'title', 'author', 'header', 'headerAlign', 'footer', 'footerAlign', 'divider', 'cover', 'characters', 'keywords',
  ]);
  assert.deepEqual([...FURNITURE_ALIGNS], ['right', 'left', 'rightLeft', 'leftRight', 'center']);
  assert.deepEqual([...ITEM_MARKS], ['-', '－']);
});

test('cover: a marker with no path behind it reports the line, not an empty name', () => {
  assert.deepEqual(parse('cover:\n-\n－\n').lines[1]?.kind, {
    error: { code: 'jpbook.notJpnov', args: ['-'] },
  });
  assert.deepEqual(parse('cover:\n-\n－\n').lines[2]?.kind, {
    error: { code: 'jpbook.notJpnov', args: ['－'] },
  });
});

test('cover: repeats dedupe among covers only — a chapter may also be a cover', () => {
  assert.deepEqual(kinds('cover:\n- c.jpnov\n- c.jpnov\n'), ['cover', 'coverEntry', 'coverDuplicate', 'blank']);
  assert.deepEqual(kinds('cover:\n- a.jpnov\n---\na.jpnov\n'), ['cover', 'coverEntry', 'fence', 'ok', 'blank']);
});

test('cover: a duplicate key warns and mutes its items (no orphan cascade)', () => {
  assert.deepEqual(kinds('cover:\n- c1.jpnov\ncover:\n- c2.jpnov\n'), [
    'cover', 'coverEntry', DUP_COVER, DUP_COVER, 'blank',
  ]);
  assert.deepEqual(kinds('cover:\ncover:\n'), ['cover', DUP_COVER, 'blank']);
});

test('itemValueOf spans the PATH only, past the marker and any leading whitespace', () => {
  const lines = parse('cover:\n  - src/c2.jpnov\n---\n').lines;
  const item = lines[1];
  assert.ok(item);
  assert.deepEqual(valueOf(item), {
    value: 'src/c2.jpnov',
    range: { startChar: 4, endChar: 16 },
  });
  // The span ends where the trimmed line does — only the marker is excluded.
  assert.equal(valueOf(item)?.range.endChar, item.range.endChar);
  assert.ok(isEntryOf('covers')(item));
  assert.equal(item.list, 'covers');
  const fence = lines[2];
  assert.ok(fence);
  // The fence IS item-shaped (`itemShape('---', …)` slices `--`); what makes this null is the
  // line's KIND. Never relax that guard back to a shape test.
  assert.equal(valueOf(fence), null);
});

test('itemValueOf returns null for the bare key line (no path to point at)', () => {
  const key = parse('cover:\n- c.jpnov\n').lines[0];
  assert.ok(key);
  assert.equal(key.kind, 'cover');
  assert.equal(key.list, 'covers'); // the key line belongs to its list, an entry of it it is not
  assert.equal(isEntryOf('covers')(key), false);
  assert.equal(inlineKeyOf(key), null);
  assert.equal(valueOf(key), null);
});

test('itemValueOf spans the value of an inline cover: key line, past the colon and its whitespace', () => {
  const lines = parse('cover: src/c.jpnov\n  cover：  c.jpnov\n- d.jpnov\n').lines;
  const [inline, wide, item] = lines;
  assert.ok(inline && wide && item);
  assert.deepEqual(valueOf(inline), { value: 'src/c.jpnov', range: { startChar: 7, endChar: 18 } });
  assert.equal(inlineKeyOf(inline), 'cover');
  // The second key is a muted duplicate: no path to point at, however it is written.
  assert.equal(valueOf(wide), null);
  assert.equal(inlineKeyOf(item), null);
  const indented = parse('  cover：  c.jpnov\n').lines[0];
  assert.ok(indented);
  assert.deepEqual(valueOf(indented), { value: 'c.jpnov', range: { startChar: 10, endChar: 17 } });
});

// --- parseJpbook: the name lists ----------------------------------------------

const NOT_PLAIN = (value: string): JpbookLineKind => ({ warning: { code: 'jpbook.nameNotPlain', args: [value] } });
const EMPTY_NAME: JpbookLineKind = { warning: { code: 'jpbook.nameEmpty', args: [] } };

test('characters/keywords: a bare key opens a list of "- " names; a value on the key line is its first item', () => {
  assert.deepEqual(kinds('characters:\n- 山田　太郎\n- John Smith\nkeywords:\n- 王都\n---\nch.jpnov\n'), [
    'names', 'name', 'name', 'names', 'name', 'fence', 'ok', 'blank',
  ]);
  assert.deepEqual(kinds('characters: 山田　太郎\n- 山田　花子\n'), ['name', 'name', 'blank']);
  const got = parse('characters: 山田　太郎\n- 山田《やまだ》花子《はなこ》\nkeywords:\n  - 王都《おうと》\n');
  assert.deepEqual(got.lines.map((l) => l.list), ['characters', 'characters', 'keywords', 'keywords', undefined]);
  assert.deepEqual(got.names.characters.map((n) => [n.line, n.text, n.name.parts.map((p) => p.base)]), [
    [0, '山田　太郎', ['山田', '太郎']],
    [1, '山田《やまだ》花子《はなこ》', ['山田', '花子']],
  ]);
  assert.deepEqual(got.names.keywords.map((n) => [n.line, n.text, n.name.parts]), [[3, '王都《おうと》', [{ base: '王都', reading: 'おうと' }]]]);
  assert.deepEqual(got.meta, {}); // the lists are never JpbookMeta fields
  // The item's value and span, past the marker or the colon.
  assert.deepEqual(valueOf(got.lines[0] ?? fail()), { value: '山田　太郎', range: { startChar: 12, endChar: 17 } });
  assert.deepEqual(valueOf(got.lines[3] ?? fail()), { value: '王都《おうと》', range: { startChar: 4, endChar: 11 } });
  assert.equal(inlineKeyOf(got.lines[0] ?? fail()), 'characters');
  const second = got.lines[1] ?? fail();
  assert.equal(second.item?.identity, '山田花子');
  assert.equal(isEntryOf('characters')(second), true);
  assert.equal(isEntryOf('keywords')(second), false);
});

function fail(): never {
  assert.fail('line missing');
}

test('characters/keywords: an item that is no name warns and is ignored; a repeated base warns too', () => {
  assert.deepEqual(kinds('characters:\n- 山田［＃「山田」に傍点］\n- 《やまだ》\n- 山田《》\n-\n- 山田\n'), [
    'names', NOT_PLAIN('山田［＃「山田」に傍点］'), NOT_PLAIN('《やまだ》'), NOT_PLAIN('山田《》'), EMPTY_NAME, 'name', 'blank',
  ]);
  // The base decides a repeat: another writing (a reading, a split, a space) of the same base is one.
  const got = parse('characters:\n- 山田　太郎\n- 山田《やまだ》太郎《たろう》\n- 山田太郎\n- John Smith\n- JohnSmith\nkeywords:\n- 山田太郎\n');
  assert.deepEqual(got.lines.map((l) => l.kind), ['names', 'name', 'nameDuplicate', 'nameDuplicate', 'name', 'nameDuplicate', 'names', 'name', 'blank']);
  assert.deepEqual(got.names.characters.map((n) => n.text), ['山田　太郎', 'John Smith']);
  assert.deepEqual(got.names.keywords.map((n) => n.text), ['山田太郎']); // the two lists dedupe on their own
  // A rejected or repeated item still belongs to its list (the editor knows what it was meant to be).
  assert.deepEqual(got.lines.map((l) => l.list), [...Array<string>(6).fill('characters'), 'keywords', 'keywords', undefined]);
  assert.deepEqual(parse('characters:\n- 山田［＃太字］\n').lines[1]?.list, 'characters');
  // A dialogue corner in an item: a marker to the highlighter, so never a name (#140).
  const corners = parse('keywords:\n- 」と\n- 『聖剣』\n- 聖剣\n');
  assert.deepEqual(corners.lines.map((l) => l.kind), ['names', NOT_PLAIN('」と'), NOT_PLAIN('『聖剣』'), 'name', 'blank']);
  assert.deepEqual(corners.names.keywords.map((n) => n.text), ['聖剣']);
});

test('characters/keywords: an item with no open list is the same Error as an orphan cover item; keys close lists', () => {
  assert.deepEqual(kinds('- 山田\n'), [ORPHAN('- 山田'), 'blank']);
  assert.deepEqual(kinds('characters:\n- 山田\ntitle: t\n- 太郎\n'), ['names', 'name', 'meta', ORPHAN('- 太郎'), 'blank']);
  // One list's key closes another's; a repeated key is a muted duplicate (its items warn, nothing collects).
  assert.deepEqual(kinds('characters:\n- 山田\nkeywords:\n- 王都\ncharacters:\n- 太郎\n'), [
    'names', 'name', 'names', 'name',
    { warning: { code: 'jpbook.metaDuplicateKey', args: ['characters'] } },
    { warning: { code: 'jpbook.metaDuplicateKey', args: ['characters'] } },
    'blank',
  ]);
  assert.deepEqual(parse('characters:\n- 山田\ncharacters:\n- 太郎\n').names.characters.map((n) => n.text), ['山田']);
  // A cover list and a name list are independent; `- x.jpnov` under characters is a name.
  assert.deepEqual(kinds('cover:\n- c.jpnov\ncharacters:\n- c.jpnov\n'), ['cover', 'coverEntry', 'names', 'name', 'blank']);
});

test('characters/keywords: an empty list is as legal as an absent key, and never an Error', () => {
  const got = parse('characters:\nkeywords:\n---\nch.jpnov\n');
  assert.deepEqual(got.lines.map((l) => l.kind), ['names', 'names', 'fence', 'ok', 'blank']);
  assert.deepEqual(got.names, { characters: [], keywords: [] });
  assert.equal(checkJpbook(parseJpbook(`${metaWith('characters:\n- 山田［＃太字］\n-')}a.jpnov`)).ok, true);
  assert.deepEqual(parse('---\n').names, { characters: [], keywords: [] });
});

// --- writtenKeysOf -----------------------------------------------------------

test('writtenKeysOf: the keys of every metadata line (in Error or not), chapters excluded, a line opted out', () => {
  const parsed = parse('title:\nTitle: x\nfooterAlign: bad\ncover: c0.jpnov\n- c.jpnov\ntitle: y\n---\na.jpnov\nheader: h\n');
  // Every key as written; completion only ever asks about the known ones.
  assert.deepEqual([...writtenKeysOf(parsed, -1)], ['title', 'Title', 'footerAlign', 'cover']);
  assert.deepEqual([...writtenKeysOf(parsed, 0)], ['Title', 'footerAlign', 'cover', 'title']);
  assert.deepEqual([...writtenKeysOf(parse(''), -1)], []);
});

// --- checkJpbook -------------------------------------------------------------

test('checkJpbook: the complete metadata when no line is in Error and no key is missing', () => {
  const tolerated = `${metaWith('publisher: x\ntitle: b', { title: 'a', divider: '＊' })}a.jpnov\na.jpnov`;
  assert.deepEqual(checkJpbook(parseJpbook(tolerated)), {
    ok: true,
    meta: {
      title: 'a',
      author: '',
      header: '',
      headerAlign: 'center',
      footer: '［＃ここに「ページ番号」の値を表示］ / ［＃ここに「総ページ数」の値を表示］',
      footerAlign: 'right',
      divider: '＊',
    },
  });
});

test('checkJpbook: an unwritten key takes its default; an unwritten title is the fence\'s Error', () => {
  assert.deepEqual(checkJpbook(parseJpbook(`${HEAD}---\n`)), {
    ok: false,
    error: { code: 'jpbook.metaEmptyValue', args: ['title'] },
  });
  assert.deepEqual(checkJpbook(parseJpbook(`${meta({}, ['title'])}a.jpnov`)), {
    ok: false,
    error: { code: 'jpbook.metaEmptyValue', args: ['title'] },
  });
  // A title alone: the page numbers at the right, a centred (empty) header, no author, no divider.
  assert.deepEqual(checkJpbook(parseJpbook(`${HEAD}title: 作品名\n---\na.jpnov`)), { ok: true, meta: { title: '作品名', ...META_DEFAULTS } });
  // A written empty footer is no footer; the unwritten alignment beside it is still its default.
  const lean = checkJpbook(parseJpbook(`${meta({ footer: '' }, ['footerAlign'])}a.jpnov`));
  assert.ok(lean.ok);
  assert.deepEqual([lean.meta.footer, lean.meta.footerAlign], ['', 'right']);
  assert.deepEqual(Object.keys(META_DEFAULTS), META_KEYS.filter((key) => key !== 'title'));
});

test('checkJpbook: the first Error line in document order (the root cause, not its cascade)', () => {
  // An empty title and a bad alignment are Errors on their own lines, never "missing".
  assert.deepEqual(checkJpbook(parseJpbook(`${meta({ title: '' })}a.jpnov`)), {
    ok: false,
    error: { code: 'jpbook.metaEmptyValue', args: ['title'] },
  });
  assert.deepEqual(checkJpbook(parseJpbook(`jpbook/2\n${metaBody({ title: '' })}---\n`)), {
    ok: false,
    error: { code: 'jpbook.versionUnsupported', args: ['2', '1'] },
  });
  assert.deepEqual(checkJpbook(parseJpbook(meta({ footerAlign: 'bottom' }))), {
    ok: false,
    error: { code: 'jpbook.metaBadEnum', args: ['footerAlign', 'bottom', FURNITURE_ALIGNS.join(', ')] },
  });
  // An unwritten title sits on the fence: after the metadata lines, before the chapters.
  assert.deepEqual(checkJpbook(parseJpbook(`${meta({ divider: '' }, ['title'])}a.jpnov\nb.txt\nc\\d.jpnov`)), {
    ok: false,
    error: { code: 'jpbook.metaEmptyValue', args: ['title'] },
  });
  assert.deepEqual(checkJpbook(parseJpbook(`${meta()}a.jpnov\nb.txt\nc\\d.jpnov`)), {
    ok: false,
    error: { code: 'jpbook.notJpnov', args: ['b.txt'] },
  });
  // A `cover: value` line is an entry; a bad value on it is the first error.
  assert.equal(checkJpbook(parseJpbook(`${metaWith('cover: x.jpnov\n- y.jpnov')}a.jpnov`)).ok, true);
  assert.deepEqual(checkJpbook(parseJpbook(`${metaWith('cover: note.md\n- y.jpnov')}a.jpnov`)), {
    ok: false,
    error: { code: 'jpbook.notJpnov', args: ['cover: note.md'] },
  });
});

test('checkJpbook: no closing fence is the root cause, before the chapter lines it swallowed', () => {
  assert.deepEqual(checkJpbook(parseJpbook(`${HEAD}${metaBody()}a.jpnov\nb.jpnov`)), {
    ok: false,
    error: { code: 'jpbook.metaUnterminated', args: [] },
  });
});

test('metaError: unclosed on the first non-blank line below the header (else the header); the unwritten title on the fence', () => {
  const unterminated = { code: 'jpbook.metaUnterminated', args: [] };
  assert.deepEqual(parse('\n  title: t\na.jpnov').metaError, { line: 1, range: { startChar: 2, endChar: 10 }, error: unterminated });
  assert.deepEqual(parseJpbook(`${HEAD}\n`).metaError, { line: 0, range: { startChar: 0, endChar: 8 }, error: unterminated });
  const empty = (key: string): unknown => ({ code: 'jpbook.metaEmptyValue', args: [key] });
  assert.equal(parse('title: t\n ---\n').metaError, null);
  assert.deepEqual(parse('headerAlign: right\n ---\n').metaError, { line: 1, range: { startChar: 1, endChar: 4 }, error: empty('title') });
  assert.deepEqual([parse(' ---\n').metaError?.line, parse(' ---\n').metaError?.error], [0, empty('title')]);
  assert.equal(parseJpbook(meta()).metaError, null);
});

// --- composeBookChrome --------------------------------------------------------

const BASE = { lineNumbers: true, edgeLine: 'red' } as const;

test('composeBookChrome: the metadata values are the furniture, as written; the proofing base stays', () => {
  assert.deepEqual(
    composeBookChrome(BASE, {
      header: '第二巻',
      headerAlign: 'leftRight',
      footer: '［＃ここに「ページ番号」の値を表示］',
      footerAlign: 'center',
    }),
    {
      lineNumbers: true,
      edgeLine: 'red',
      header: '第二巻',
      headerAlign: 'leftRight',
      footer: '［＃ここに「ページ番号」の値を表示］',
      footerAlign: 'center',
    },
  );
  // An empty header or footer is preserved: it hides the band.
  const hidden = composeBookChrome(BASE, { header: '', headerAlign: 'center', footer: '', footerAlign: 'right' });
  assert.equal(hidden.header, '');
  assert.equal(hidden.footer, '');
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

/** Completion on a metadata line with no key written yet. */
const complete = (prefix: string) => completeMetaLine(prefix, new Set());

test('completeMetaLine offers every key on an empty line, inserted as "key: "', () => {
  const got = complete('');
  assert.deepEqual(got.map((c) => c.label), [...KNOWN_KEYS]);
  const first = got[0];
  assert.ok(first);
  assert.equal(first.insertText, 'title: ');
  assert.equal(first.kind, 'key');
  assert.deepEqual(first.replace, { startChar: 0, endChar: 0 });
});

test('completeMetaLine leaves out the keys already written', () => {
  assert.deepEqual(completeMetaLine('', new Set(['title', 'cover'])).map((c) => c.label), [
    'author', 'header', 'headerAlign', 'footer', 'footerAlign', 'divider', 'characters', 'keywords',
  ]);
  assert.deepEqual(completeMetaLine('t', new Set(['title'])), []);
});

test('completeMetaLine filters keys by case-insensitive prefix, replacing the typed span', () => {
  const got = complete('  FOOT');
  assert.deepEqual(got.map((c) => c.label), ['footer', 'footerAlign']);
  assert.deepEqual(got[0]?.replace, { startChar: 2, endChar: 6 });
  assert.deepEqual(complete('head').map((c) => c.label), ['header', 'headerAlign']);
});

test('completeMetaLine offers the alignments after "headerAlign:" and "footerAlign:"', () => {
  for (const key of ['headerAlign', 'footerAlign']) {
    assert.deepEqual(complete(`${key}: `).map((c) => c.label), [...FURNITURE_ALIGNS], key);
    const got = complete(`${key}: le`);
    assert.deepEqual(got.map((c) => c.label), ['left', 'leftRight'], key);
    const first = got[0];
    assert.ok(first);
    assert.equal(first.kind, 'value');
    assert.deepEqual(first.replace, { startChar: key.length + 2, endChar: key.length + 4 });
  }
});

test('completeMetaLine offers nothing after the colon of a free-text key', () => {
  assert.deepEqual(complete('title: 夜'), []);
  assert.deepEqual(complete('header: '), []);
});

test('completeMetaLine offers the preset marks after "divider:"', () => {
  assert.deepEqual(complete('divider: ').map((c) => c.label), ['＊', '＊　＊　＊', '◇']);
  const first = complete('divider: ')[0];
  assert.ok(first);
  assert.equal(first.kind, 'value');
});

// --- entryPaths / composeBookInput: the build's inputs ---------------------------

test('entryPaths lists the entries of one kind in manifest order, duplicates skipped', () => {
  const parsed = parseJpbook(`${metaWith('cover:\n  - c.jpnov')}a.jpnov\nb.jpnov\na.jpnov\n`);
  assert.deepEqual(entryPaths(parsed.lines, 'ok'), ['a.jpnov', 'b.jpnov']);
  assert.deepEqual(entryPaths(parsed.lines, 'coverEntry'), ['c.jpnov']);
});

test('composeBookInput carries the body-side values and a cover only when one was read', () => {
  const bookMeta = completeMeta(parseJpbook(meta({ divider: '［＃３字下げ］＊' })));
  const files = [{ name: 'a.jpnov', src: '' }];
  assert.deepEqual(composeBookInput(bookMeta, files, []), { files, divider: { mark: '＊', indent: 3 }, title: '作品名', author: bookMeta.author });
  assert.deepEqual(composeBookInput(bookMeta, files, files).cover, { files });
});
