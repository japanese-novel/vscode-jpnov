import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';

import type { JpbookMeta } from '../../../src/shared/book/jpbook.ts';
import type { BookInput } from '../../../src/shared/compiler/document.ts';
import { epubMembers } from '../../../src/shared/compiler/epub.ts';
import { ocfZip } from '../../../src/shared/compiler/ocf.ts';
import { assertWellFormedXml } from '../xml.ts';
import { VALUE_NAMES } from '../../../src/shared/compiler/tokenizer.ts';

const MODIFIED = '2026-08-04T00:00:00Z';

function members(book: BookInput, meta: JpbookMeta = {}, outRel = 'vol1'): ReturnType<typeof epubMembers> {
  return epubMembers({ book, meta, outRel, kinsoku: 'relaxed', autoTcy: 'punctuationPairs', dash: 'horizontalBar', modified: MODIFIED });
}

const TWO_CHAPTERS: BookInput = {
  files: [
    { name: 'vol1/a.jpnov', src: '一章［＃「一章」は大見出し］\n本文。\n［＃改ページ］\n続き。' },
    { name: 'vol1/b.jpnov', src: '結び。' },
  ],
};

test('epubMembers lays out the container: opf + nav + one css + chapter-anchored spine files', () => {
  assert.deepEqual(members(TWO_CHAPTERS).map((m) => m.name), [
    'META-INF/container.xml',
    'OEBPS/package.opf',
    'OEBPS/nav.xhtml',
    'OEBPS/styles.css',
    'OEBPS/text/ch001.xhtml',
    'OEBPS/text/ch001-2.xhtml',
    'OEBPS/text/ch002.xhtml',
  ]);
});

test('container.xml points at the package document', () => {
  const container = members(TWO_CHAPTERS)[0];
  assert.ok(container);
  assert.ok(container.content.includes('full-path="OEBPS/package.opf"'));
  assert.ok(container.content.includes('media-type="application/oebps-package+xml"'));
});

test('the opf carries the required metadata and an rtl spine in reading order', () => {
  const opf = members(TWO_CHAPTERS, { title: '試験 & 本', author: 'ペンネーム' }).find(
    (m) => m.name === 'OEBPS/package.opf',
  )?.content ?? '';
  assert.match(opf, /<dc:identifier id="pub-id">urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}<\/dc:identifier>/);
  assert.ok(opf.includes('<dc:title>試験 &amp; 本</dc:title>'));
  assert.ok(opf.includes('<dc:language>ja</dc:language>'));
  assert.ok(opf.includes('<dc:creator>ペンネーム</dc:creator>'));
  assert.ok(opf.includes(`<meta property="dcterms:modified">${MODIFIED}</meta>`));
  assert.ok(opf.includes('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'));
  assert.ok(opf.includes(
    '<spine page-progression-direction="rtl">' +
    '<itemref idref="ch001"/><itemref idref="ch001-2"/><itemref idref="ch002"/></spine>',
  ));
});

test('the identifier is stable across builds and books keep distinct identities', () => {
  const id = (outRel: string): string =>
    /urn:uuid:[0-9a-f-]{36}/.exec(
      members(TWO_CHAPTERS, {}, outRel).find((m) => m.name === 'OEBPS/package.opf')?.content ?? '',
    )?.[0] ?? '';
  assert.equal(id('vol1'), id('vol1'));
  assert.notEqual(id('vol1'), id('vol2'));
});

test('dc:creator appears only when the book has an author; title falls back to the outRel stem', () => {
  const opf = members(TWO_CHAPTERS, {}, 'part1/vol2').find((m) => m.name === 'OEBPS/package.opf')?.content ?? '';
  assert.ok(!opf.includes('<dc:creator>'));
  assert.ok(opf.includes('<dc:title>vol2</dc:title>'));
});

test('nav lists one entry per CHAPTER (not per split), labeled by first 見出し or file stem', () => {
  const nav = members(TWO_CHAPTERS).find((m) => m.name === 'OEBPS/nav.xhtml')?.content ?? '';
  assert.ok(nav.includes('<nav epub:type="toc">'));
  assert.ok(nav.includes('<li><a href="text/ch001.xhtml">一章</a></li>'));
  assert.ok(nav.includes('<li><a href="text/ch002.xhtml">b</a></li>'));
  assert.ok(!nav.includes('ch001-2.xhtml'), 'mid-chapter splits stay out of the nav');
  assertWellFormedXml(nav);
});

test('chapter documents are well-formed XHTML linking the one shared stylesheet', () => {
  const out = members(TWO_CHAPTERS);
  const docs = out.filter((m) => m.name.startsWith('OEBPS/text/'));
  assert.equal(docs.length, 3);
  for (const doc of docs) {
    assert.ok(doc.content.includes('<link rel="stylesheet" type="text/css" href="../styles.css"/>'));
    assertWellFormedXml(doc.content);
  }
  const first = docs[0];
  assert.ok(first);
  assert.ok(first.content.includes('<title>一章</title>'), 'doc title = its heading');
  assert.ok(first.content.includes('<h1>一章</h1>'));
});

test('styles.css is built from the whole book’s used classes, kinsoku mapped to line-break', () => {
  const book: BookInput = {
    files: [
      { name: 'a.jpnov', src: '本文。' },
      { name: 'b.jpnov', src: '英雄《えいゆう》［＃「英雄」の左に「ひーろー」のルビ］' },
    ],
  };
  const css = members(book).find((m) => m.name === 'OEBPS/styles.css')?.content ?? '';
  assert.ok(css.includes('writing-mode:vertical-rl'));
  assert.ok(css.includes('body{line-break:normal;hanging-punctuation:allow-end}'));
  assert.match(css, /ruby\.ru\{/); // the both-side class used in chapter 2 only still lands
});

test('an empty chapter source contributes nothing; an all-empty book still gets a spine', () => {
  const sparse = members({ files: [{ name: 'a.jpnov', src: '' }, { name: 'b.jpnov', src: '本文。' }] });
  assert.deepEqual(sparse.filter((m) => m.name.startsWith('OEBPS/text/')).map((m) => m.name), [
    'OEBPS/text/ch002.xhtml',
  ]);

  const empty = members({ files: [{ name: 'a.jpnov', src: '' }] }, { title: '空' });
  const doc = empty.find((m) => m.name === 'OEBPS/text/ch001.xhtml');
  assert.ok(doc, 'a synthesized blank chapter keeps the spine non-empty');
  assert.ok(doc.content.includes('<p><br/></p>'));
});

test('ocfZip puts the STORED mimetype first and round-trips every member', () => {
  const out = members(TWO_CHAPTERS);
  const zip = ocfZip(out);

  // Local file header of the FIRST entry: method (offset 8) must be 0 (STORED), the name
  // (offset 30) must be "mimetype", and the payload must follow it immediately.
  assert.equal(zip[8] ?? -1, 0);
  assert.equal(zip[9] ?? -1, 0);
  const nameLen = (zip[26] ?? 0) | ((zip[27] ?? 0) << 8);
  assert.equal(strFromU8(zip.subarray(30, 30 + nameLen)), 'mimetype');
  assert.equal(strFromU8(zip.subarray(30 + nameLen, 30 + nameLen + 20)), 'application/epub+zip');

  const back = unzipSync(zip);
  assert.deepEqual(Object.keys(back), ['mimetype', ...out.map((m) => m.name)]);
  for (const m of out) {
    assert.equal(strFromU8(back[m.name] ?? new Uint8Array()), m.content);
  }
});

test('a value annotation reflows as its name (EPUB has no page count)', () => {
  const out = members({ files: [{ name: 'vol1/a.jpnov', src: '全［＃ここに「総ページ数」の値を表示］ページ' }] });
  const xhtml = out.find((m) => m.name === 'OEBPS/text/ch001.xhtml')?.content ?? '';
  assert.match(xhtml, new RegExp(`全${VALUE_NAMES.totalPages}ページ`));
});

test('CRLF chapters yield the same members as their LF twins', () => {
  const crlf: BookInput = {
    files: TWO_CHAPTERS.files.map((f) => ({ ...f, src: f.src.replaceAll('\n', '\r\n') })),
  };
  assert.deepEqual(members(crlf), members(TWO_CHAPTERS));
});
