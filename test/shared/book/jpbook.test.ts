import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  completeEntryLine,
  checkJpbook,
  completeMetaLine,
  composeBookChrome,
  composeDividerValue,
  COVER_ITEM_MARKS,
  coverPathOf,
  entryIdentity,
  KNOWN_KEYS,
  isCover,
  jpbookOutRel,
  HEADER,
  JPBOOK_VERSION,
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
import { INDENT_MAX } from '../../../src/shared/ast/notation.ts';
import { FURNITURE_ALIGNS } from '../../../src/shared/compiler/chrome.ts';
import { below, HEAD, meta, metaBody, metaWith } from './_fixture.ts';

/** Parses `text` as the lines written below the header, numbered from there. */
const parse = (text: string): ParsedJpbook => below(parseJpbook(HEAD + text), 1);
const kinds = (text: string): JpbookLineKind[] => parse(text).lines.map((l) => l.kind);
/** What the keys an empty value suits read as when no line writes them. */
const EMPTIES = { author: '', header: '', footer: '', divider: '' } as const;
/** The lines of `text` written below an (empty) metadata block's `---`, numbered from that point. */
const chapters = (text: string): readonly ParsedLine[] => below(parse(`---\n${text}`), 1).lines;
const chapterKinds = (text: string): JpbookLineKind[] => chapters(text).map((l) => l.kind);
const E = (name: string, isDir = false): CompletionEntry => ({ name, isDir });

// --- parseJpbook: chapter lines ---------------------------------------------

test('parseJpbook returns ordered ok lines with exact ranges', () => {
  assert.deepEqual(chapters('a.jpnov\nb.jpnov'), [
    { line: 0, range: { startChar: 0, endChar: 7 }, raw: 'a.jpnov', value: 'a.jpnov', kind: 'ok' },
    { line: 1, range: { startChar: 0, endChar: 7 }, raw: 'b.jpnov', value: 'b.jpnov', kind: 'ok' },
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
  assert.deepEqual(got[0], { line: 0, range: { startChar: 0, endChar: 7 }, raw: 'a.jpnov', value: 'a.jpnov', kind: 'ok' });
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
  assert.deepEqual(chapters('chapters/01.jpnov'), [
    { line: 0, range: { startChar: 0, endChar: 17 }, raw: 'chapters/01.jpnov', value: 'chapters/01.jpnov', kind: 'ok' },
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

test('parseJpbook dedupes by entryIdentity: ./, empty segments and NFC name one file (#86)', () => {
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
  error: { code: 'jpbook.coverItemWithoutKey', args: [value] },
});

test('parseJpbook: an empty metadata block (a lone fence): the keys an empty value suits are empty, the others absent', () => {
  const got = parse('---\na.jpnov');
  assert.deepEqual(got.lines.map((l) => l.kind), ['fence', 'ok']);
  assert.deepEqual(got.meta, EMPTIES);
  assert.equal(got.fence, 0);
});

test('parseJpbook collects the metadata above the fence and parses the chapters below it', () => {
  const got = parse('title: 作品名　第一巻\nheader: 作品名　一\n---\na.jpnov');
  assert.deepEqual(got.lines.map((l) => l.kind), ['meta', 'meta', 'fence', 'ok']);
  assert.deepEqual(got.meta, { ...EMPTIES, title: '作品名　第一巻', header: '作品名　一' });
  assert.equal(got.fence, 2);
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
    ...EMPTIES,
    title: 't',
    header: 'h',
    headerAlign: 'right',
    footerAlign: 'left',
    footer: '［＃ここに「ページ番号」の値を表示］',
  });
});

test('parseJpbook accepts a full-width colon separator', () => {
  const got = parse('title：第一巻\n');
  assert.deepEqual(got.meta, { ...EMPTIES, title: '第一巻' });
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
  assert.deepEqual(ok.meta, { ...EMPTIES, title: 't' });

  const bom = parseJpbook('\uFEFFjpbook/1\r\ntitle: t\r\n');
  assert.deepEqual(bom.lines[0], { line: 0, range: { startChar: 1, endChar: 9 }, raw: '\uFEFFjpbook/1', value: 'jpbook/1', kind: 'header' });
  assert.deepEqual(bom.meta, { ...EMPTIES, title: 't' });

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
    assert.deepEqual(got.metaErrors, [], first);
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
    assert.deepEqual(got.metaErrors, [], version);
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
  assert.deepEqual(parse('title: a\u0007\n---\n').meta, { ...EMPTIES, title: 'a\u0007' });
});

test('parseJpbook: an empty first title line still takes its key', () => {
  const got = parse('title:\ntitle: 作品名\n---\n');
  assert.deepEqual(got.meta, EMPTIES);
  assert.deepEqual(got.lines[1]?.kind, { warning: { code: 'jpbook.metaDuplicateKey', args: ['title'] } });
  // Taken by its line in Error: not reported again on the fence.
  assert.deepEqual(got.metaErrors.map((e) => e.error.args?.[0]), ['headerAlign', 'footerAlign']);
});

test('parseJpbook: blank lines among the metadata are skipped', () => {
  assert.deepEqual(kinds('\ntitle: t\n\n'), ['blank', 'meta', 'blank', 'blank']);
});

test('parseJpbook warns on an unknown key (with the known-key list) and ignores it', () => {
  const got = parse('publisher: 誰か\n');
  assert.deepEqual(got.meta, EMPTIES);
  assert.deepEqual(got.lines[0]?.kind, {
    warning: {
      code: 'jpbook.metaUnknownKey',
      args: ['publisher', KNOWN_KEYS.join(', ')],
    },
  });
});

test('parseJpbook warns on a duplicate key; the first value wins', () => {
  const got = parse('title: 一\ntitle: 二\n');
  assert.deepEqual(got.meta, { ...EMPTIES, title: '一' });
  assert.deepEqual(got.lines[1]?.kind, { warning: { code: 'jpbook.metaDuplicateKey', args: ['title'] } });
});

test('divider is a free-string key; parse/composeDividerValue split mark and 字下げ', () => {
  assert.deepEqual(parse('divider: ＊　＊　＊\na.jpnov\n').meta, { ...EMPTIES, divider: '＊　＊　＊' });
  assert.deepEqual(parseDividerValue('＊　＊　＊'), { mark: '＊　＊　＊', indent: null });
  assert.deepEqual(parseDividerValue('［＃２字下げ］◇'), { mark: '◇', indent: 2 });
  // The 字下げ must LEAD the value (the scanner's own line-head contract).
  assert.deepEqual(parseDividerValue('＊［＃２字下げ］'), { mark: '＊［＃２字下げ］', indent: null });
  assert.equal(composeDividerValue('＊', null), '＊');
  assert.equal(composeDividerValue('＊', 15), '［＃１５字下げ］＊');
  assert.deepEqual(parseDividerValue(composeDividerValue('†', 3)), { mark: '†', indent: 3 });
  // The scanner's limit: the largest 字下げ splits off, a larger one stays in the mark.
  assert.deepEqual(parseDividerValue(composeDividerValue('◇', INDENT_MAX)), { mark: '◇', indent: INDENT_MAX });
  const over = composeDividerValue('◇', INDENT_MAX + 1);
  assert.deepEqual(parseDividerValue(over), { mark: over, indent: null });
});

test('parseJpbook: headerAlign and footerAlign take the five alignments and reject anything else', () => {
  for (const key of ['headerAlign', 'footerAlign'] as const) {
    for (const align of FURNITURE_ALIGNS) {
      assert.deepEqual(parse(`${key}: ${align}\n`).meta, { ...EMPTIES, [key]: align }, `${key}: ${align}`);
    }
    // A rejected value (the retired `none` too) or an empty one is an Error — there is no
    // default to fall back on — and takes the key: a later line is a repeat, not the value.
    for (const bad of ['middle', 'none', '']) {
      const got = parse(`${key}: ${bad}\n${key}: left\n`);
      assert.deepEqual(got.lines[0]?.kind, {
        error: bad === '' ? { code: 'jpbook.metaEmptyValue', args: [key] } : { code: 'jpbook.metaBadEnum', args: [key, bad, FURNITURE_ALIGNS.join(', ')] },
      }, `${key}: ${bad}`);
      assert.deepEqual(got.lines[1]?.kind, { warning: { code: 'jpbook.metaDuplicateKey', args: [key] } });
      assert.deepEqual(got.meta, EMPTIES, `${key}: ${bad}`);
      assert.ok(!parse(`${key}: ${bad}\n---\n`).metaErrors.some((e) => e.error.args?.[0] === key), `${key}: ${bad}`);
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
  assert.deepEqual(got.meta, { ...EMPTIES, title: 't' });
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

test('cover: a value on the key line is an error steering to the list form', () => {
  // ONE spelling: a `key: value` paints as a string, where VS Code withholds completion.
  const NEEDS_LIST = (value: string): JpbookLineKind => ({
    error: { code: 'jpbook.coverNeedsList', args: [value] },
  });
  assert.deepEqual(kinds('cover: c.jpnov\n'), [NEEDS_LIST('cover: c.jpnov'), 'blank']);
  // The rejected key opens nothing…
  assert.deepEqual(kinds('cover: c.jpnov\n- c2.jpnov\n'), [
    NEEDS_LIST('cover: c.jpnov'), ORPHAN('- c2.jpnov'), 'blank',
  ]);
  // …and does not consume the key, so a real list still works below it.
  assert.deepEqual(kinds('cover: c.jpnov\ncover:\n- c2.jpnov\n'), [
    NEEDS_LIST('cover: c.jpnov'), 'cover', 'coverEntry', 'blank',
  ]);
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
  assert.deepEqual(got.meta, EMPTIES); // cover is never a JpbookMeta field
});

test('cover: items take a full-width dash and need no space after it', () => {
  assert.deepEqual(kinds('cover:\n－c1.jpnov\n-c2.jpnov\n　- c3.jpnov\n'), [
    'cover', 'coverEntry', 'coverEntry', 'coverEntry', 'blank',
  ]);
});

test('cover: the key takes a full-width colon like every other key', () => {
  assert.deepEqual(kinds('cover：\n- c.jpnov\n'), ['cover', 'coverEntry', 'blank']);
  assert.deepEqual(parse('cover：c.jpnov\n').lines[0]?.kind, {
    error: { code: 'jpbook.coverNeedsList', args: ['cover：c.jpnov'] },
  });
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
    'title', 'author', 'header', 'headerAlign', 'footer', 'footerAlign', 'divider', 'cover',
  ]);
  assert.deepEqual([...FURNITURE_ALIGNS], ['right', 'left', 'rightLeft', 'leftRight', 'center']);
  assert.deepEqual([...COVER_ITEM_MARKS], ['-', '－']);
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

test('cover: a duplicate key warns; a duplicate bare key mutes its items (no orphan cascade)', () => {
  assert.deepEqual(kinds('cover:\n- c1.jpnov\ncover:\n- c2.jpnov\n'), [
    'cover', 'coverEntry', DUP_COVER, DUP_COVER, 'blank',
  ]);
  // A second BARE key is the only duplicate shape left; each `cover: value` line is its own error.
  assert.deepEqual(kinds('cover:\ncover:\n'), ['cover', DUP_COVER, 'blank']);
});

test('coverPathOf spans the PATH only, past the marker and any leading whitespace', () => {
  const lines = parse('cover:\n  - src/c2.jpnov\n---\n').lines;
  const item = lines[1];
  assert.ok(item);
  assert.deepEqual(coverPathOf(item), {
    value: 'src/c2.jpnov',
    range: { startChar: 4, endChar: 16 },
  });
  // The span ends where the trimmed line does — only the marker is excluded.
  assert.equal(coverPathOf(item)?.range.endChar, item.range.endChar);
  assert.ok(isCover(item));
  const fence = lines[2];
  assert.ok(fence);
  // The fence IS item-shaped (`coverShape('---')` slices `--`); what makes this null is the
  // line's KIND. Never relax that guard back to a shape test.
  assert.equal(coverPathOf(fence), null);
});

test('coverPathOf returns null for the bare key line (no path to point at)', () => {
  const key = parse('cover:\n- c.jpnov\n').lines[0];
  assert.ok(key);
  assert.equal(key.kind, 'cover');
  assert.equal(isCover(key), false);
  assert.equal(coverPathOf(key), null);
});

// --- writtenKeysOf -----------------------------------------------------------

test('writtenKeysOf: the keys of every metadata line (in Error or not), chapters excluded, a line opted out', () => {
  const parsed = parse('title:\nTitle: x\nfooterAlign: bad\ncover:\n- c.jpnov\ntitle: y\n---\na.jpnov\nheader: h\n');
  // Every key as written; completion only ever asks about the known ones.
  assert.deepEqual([...writtenKeysOf(parsed)], ['title', 'Title', 'footerAlign', 'cover']);
  assert.deepEqual([...writtenKeysOf(parsed, 0)], ['Title', 'footerAlign', 'cover', 'title']);
  assert.deepEqual([...writtenKeysOf(parse(''))], []);
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

test('checkJpbook: an unwritten key is an empty one — fine where empty suits, else the empty value\'s own Error', () => {
  assert.deepEqual(checkJpbook(parseJpbook(`${HEAD}---\n`)), {
    ok: false,
    error: { code: 'jpbook.metaEmptyValue', args: ['title'] },
  });
  assert.deepEqual(checkJpbook(parseJpbook(`${meta({}, ['title'])}a.jpnov`)), {
    ok: false,
    error: { code: 'jpbook.metaEmptyValue', args: ['title'] },
  });
  assert.deepEqual(checkJpbook(parseJpbook(`${meta({}, ['footerAlign'])}a.jpnov`)), {
    ok: false,
    error: { code: 'jpbook.metaEmptyValue', args: ['footerAlign'] },
  });
  const lean = checkJpbook(parseJpbook(`${meta({}, ['author', 'header', 'footer', 'divider'])}a.jpnov`));
  assert.ok(lean.ok);
  assert.deepEqual([lean.meta.author, lean.meta.header, lean.meta.footer, lean.meta.divider], ['', '', '', '']);
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
  // An unwritten alignment sits on the fence: after the metadata lines, before the chapters.
  assert.deepEqual(checkJpbook(parseJpbook(`${meta({ title: '' }, ['footerAlign'])}a.jpnov`)), {
    ok: false,
    error: { code: 'jpbook.metaEmptyValue', args: ['title'] },
  });
  assert.deepEqual(checkJpbook(parseJpbook(`${meta({}, ['footerAlign'])}a.jpnov\nb.txt\nc\\d.jpnov`)), {
    ok: false,
    error: { code: 'jpbook.metaEmptyValue', args: ['footerAlign'] },
  });
  assert.deepEqual(checkJpbook(parseJpbook(`${meta()}a.jpnov\nb.txt\nc\\d.jpnov`)), {
    ok: false,
    error: { code: 'jpbook.notJpnov', args: ['b.txt'] },
  });
  // A `cover: value` line comes before the orphan items it leaves behind.
  assert.deepEqual(checkJpbook(parseJpbook(`${metaWith('cover: x.jpnov\n- y.jpnov')}a.jpnov`)), {
    ok: false,
    error: { code: 'jpbook.coverNeedsList', args: ['cover: x.jpnov'] },
  });
});

test('checkJpbook: no closing fence is the root cause, before the chapter lines it swallowed', () => {
  assert.deepEqual(checkJpbook(parseJpbook(`${HEAD}${metaBody()}a.jpnov\nb.jpnov`)), {
    ok: false,
    error: { code: 'jpbook.metaUnterminated', args: [] },
  });
});

test('metaErrors: unclosed on the first non-blank line below the header (else the header); the unwritten title and alignments on the fence', () => {
  const unterminated = { code: 'jpbook.metaUnterminated', args: [] };
  assert.deepEqual(parse('\n  title: t\na.jpnov').metaErrors, [
    { line: 1, range: { startChar: 2, endChar: 10 }, error: unterminated },
  ]);
  assert.deepEqual(parseJpbook(`${HEAD}\n`).metaErrors, [{ line: 0, range: { startChar: 0, endChar: 8 }, error: unterminated }]);
  const empty = (key: string): unknown => ({ code: 'jpbook.metaEmptyValue', args: [key] });
  assert.deepEqual(parse('title: t\n ---\n').metaErrors, ['headerAlign', 'footerAlign'].map((key) => ({
    line: 1, range: { startChar: 1, endChar: 4 }, error: empty(key),
  })));
  assert.deepEqual(parse(' ---\n').metaErrors.map((e) => [e.line, e.error]), [
    [0, empty('title')], [0, empty('headerAlign')], [0, empty('footerAlign')],
  ]);
  assert.deepEqual(parseJpbook(meta()).metaErrors, []);
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
  assert.deepEqual(got.map((c) => c.label), [...KNOWN_KEYS]);
  const first = got[0];
  assert.ok(first);
  assert.equal(first.insertText, 'title: ');
  assert.equal(first.kind, 'key');
  assert.deepEqual(first.replace, { startChar: 0, endChar: 0 });
});

test('completeMetaLine leaves out the keys already written', () => {
  assert.deepEqual(completeMetaLine('', new Set(['title', 'cover'])).map((c) => c.label), [
    'author', 'header', 'headerAlign', 'footer', 'footerAlign', 'divider',
  ]);
  assert.deepEqual(completeMetaLine('t', new Set(['title'])), []);
});

test('completeMetaLine filters keys by case-insensitive prefix, replacing the typed span', () => {
  const got = completeMetaLine('  FOOT');
  assert.deepEqual(got.map((c) => c.label), ['footer', 'footerAlign']);
  assert.deepEqual(got[0]?.replace, { startChar: 2, endChar: 6 });
  assert.deepEqual(completeMetaLine('head').map((c) => c.label), ['header', 'headerAlign']);
});

test('completeMetaLine offers the alignments after "headerAlign:" and "footerAlign:"', () => {
  for (const key of ['headerAlign', 'footerAlign']) {
    assert.deepEqual(completeMetaLine(`${key}: `).map((c) => c.label), [...FURNITURE_ALIGNS], key);
    const got = completeMetaLine(`${key}: le`);
    assert.deepEqual(got.map((c) => c.label), ['left', 'leftRight'], key);
    const first = got[0];
    assert.ok(first);
    assert.equal(first.kind, 'value');
    assert.deepEqual(first.replace, { startChar: key.length + 2, endChar: key.length + 4 });
  }
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
