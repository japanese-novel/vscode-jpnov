import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';

import type { BookInput } from '../../../src/shared/compiler/document.ts';
import { epubMembers } from '../../../src/shared/compiler/epub.ts';
import { ocfZip } from '../../../src/shared/compiler/ocf.ts';
import { BLANKS } from '../_kana.ts';
import { assertWellFormedXml, assertXmlChars } from '../xml.ts';
import { INDENT_MAX, VALUE_DEFAULTS, indentAnnotation } from '../../../src/shared/ast/notation.ts';
import { CHARS_MIN, LAYOUT_DEFAULT } from '../../../src/shared/config/types.ts';

const MODIFIED = '2026-08-04T00:00:00Z';

/** The members of `book`, under the title the build would have decided for it. */
function members(
  book: BookInput,
  outRel = 'vol1',
  charsPerLine = LAYOUT_DEFAULT.charsPerLine,
): ReturnType<typeof epubMembers> {
  return epubMembers({
    book: { ...book, title: book.title ?? '作品名' },
    outRel,
    kinsoku: 'relaxed',
    dash: 'horizontalBar',
    charsPerLine,
    modified: MODIFIED,
  });
}

/** The content of the member `name`, '' when `out` has none. */
function contentOf(out: ReturnType<typeof epubMembers>, name: string): string {
  return out.find((m) => m.name === name)?.content ?? '';
}

/** Every member holds XML Chars only, and every member but the stylesheet is well-formed XML. */
function assertCleanMembers(out: ReturnType<typeof epubMembers>): void {
  for (const m of out) {
    assertXmlChars(m.content);
    if (m.name !== 'OEBPS/styles.css') {
      assertWellFormedXml(m.content);
    }
  }
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
  const opf = members({ ...TWO_CHAPTERS, title: '試験 & 本', author: 'ペンネーム' }).find(
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
      members(TWO_CHAPTERS, outRel).find((m) => m.name === 'OEBPS/package.opf')?.content ?? '',
    )?.[0] ?? '';
  assert.equal(id('vol1'), id('vol1'));
  assert.notEqual(id('vol1'), id('vol2'));
});

test('dc:creator appears only when the book has an author', () => {
  const opfOf = (book: BookInput): string => members(book).find((m) => m.name === 'OEBPS/package.opf')?.content ?? '';
  assert.ok(!opfOf(TWO_CHAPTERS).includes('<dc:creator>'));
  // The build hands a book without an author the empty string; a blank one shows nothing either.
  for (const author of ['', ...BLANKS]) {
    const opf = opfOf({ ...TWO_CHAPTERS, author });
    assert.ok(!opf.includes('<dc:creator>'), JSON.stringify(author));
    assertWellFormedXml(opf);
  }
});

/** Characters XML cannot carry, in every place a book holds text. */
const HOSTILE: BookInput = {
  title: '\u0000作\u0007品名\uFFFE',
  author: 'ペン\u0001ネーム\uFFFF',
  files: [
    {
      name: 'vol1/a\u0008.jpnov',
      src: [
        '聖\u000B剣［＃「聖剣」は大見出し］',
        '王\u0007都\uFFFEへ行く。',
        '\u000C\uFFFF',
        '｜山\u000E田《やま\u001Fだ》と山田《\u0002やまだ》',
        '［＃縦中横］１\u0003２［＃縦中横終わり］と１２\u0004［＃「１２」は縦中横］',
        '聖剣［＃「聖剣」の左に「つる\u0005ぎ」のルビ］',
        '［＃-\u0007-］あ［＃\u0006メモ\uFFFE-',
      ].join('\n'),
    },
    { name: 'vol1/\u0010王\u0011都\uFFFE.jpnov', src: '本\u0012文。' },
  ],
};

test('no member carries a character XML cannot, wherever the book held one', () => {
  const out = members(HOSTILE);
  assertCleanMembers(out);
  const content = (name: string): string => contentOf(out, name);
  const opf = content('OEBPS/package.opf');
  assert.ok(opf.includes('<dc:title>作品名</dc:title>'));
  assert.ok(opf.includes('<dc:creator>ペンネーム</dc:creator>'));
  const nav = content('OEBPS/nav.xhtml');
  assert.ok(nav.includes('<li><a href="text/ch001.xhtml">聖剣</a></li>'));
  assert.ok(nav.includes('<li><a href="text/ch002.xhtml">王都</a></li>'));
  const first = content('OEBPS/text/ch001.xhtml');
  assert.ok(first.includes('<title>聖剣</title>'));
  assert.ok(first.includes('<p>王都へ行く。</p><p><br/></p>'));
  assert.ok(first.includes('<!--- - -->'));
  assert.ok(content('OEBPS/text/ch002.xhtml').includes('<title>王都</title><'));
});

test('a blank file name is labeled by its spine id; a blank title takes the first nav label', () => {
  const content = (book: BookInput, name: string): string => contentOf(members(book), name);
  const titleOf = (book: BookInput): string | undefined =>
    /<dc:title>([^<]*)<\/dc:title>/.exec(content(book, 'OEBPS/package.opf'))?.[1];
  const labelsOf = (book: BookInput): string[] =>
    [...content(book, 'OEBPS/nav.xhtml').matchAll(/<a href="text\/([^.]+)\.xhtml">([^<]*)<\/a>/g)].map((m) => `${m[1] ?? ''}=${m[2] ?? ''}`);

  for (const name of ['.jpnov', 'vol1/.jpnov', 'vol1/　.jpnov', 'vol1/\u0007.jpnov']) {
    const book: BookInput = { files: [{ name: 'vol1/a.jpnov', src: '本文。' }, { name, src: '本文。' }] };
    assert.deepEqual(labelsOf(book), ['ch001=a', 'ch002=ch002'], JSON.stringify(name));
    assert.ok(content(book, 'OEBPS/text/ch002.xhtml').includes('<title>ch002</title>'), JSON.stringify(name));
  }

  for (const title of ['', ...BLANKS]) {
    assert.equal(titleOf({ ...TWO_CHAPTERS, title }), '一章', JSON.stringify(title));
    // No chapter has anything to show: the title, the nav label and the document title are the spine id.
    const empty: BookInput = { files: [{ name: 'a.jpnov', src: '' }], title };
    assert.equal(titleOf(empty), 'ch001', JSON.stringify(title));
    assert.deepEqual(labelsOf(empty), ['ch001=ch001'], JSON.stringify(title));
    assert.ok(content(empty, 'OEBPS/text/ch001.xhtml').includes('<title>ch001</title>'), JSON.stringify(title));
    assertCleanMembers(members(empty));
  }
  // A blank 見出し does not label the chapter either.
  assert.deepEqual(
    labelsOf({ files: [{ name: 'vol1/a.jpnov', src: '［＃大見出し］　［＃大見出し終わり］\n本文。' }] }),
    ['ch001=a'],
  );
});

test('nav lists one entry per CHAPTER (not per split), labeled by first 見出し or file stem', () => {
  const nav = members(TWO_CHAPTERS).find((m) => m.name === 'OEBPS/nav.xhtml')?.content ?? '';
  assert.ok(nav.includes('<nav epub:type="toc">'));
  assert.ok(nav.includes('<li><a href="text/ch001.xhtml">一章</a></li>'));
  assert.ok(nav.includes('<li><a href="text/ch002.xhtml">b</a></li>'));
  assert.ok(!nav.includes('ch001-2.xhtml'), 'mid-chapter splits stay out of the nav');
  assertWellFormedXml(nav);

  // The stem drops the directories and the extension in any letter case; a name without one is itself.
  const stems = members({ files: [{ name: 'vol1/第一章.JPNOV', src: '本文。' }, { name: 'readme', src: '本文。' }] });
  const labels = contentOf(stems, 'OEBPS/nav.xhtml');
  assert.ok(labels.includes('<li><a href="text/ch001.xhtml">第一章</a></li>'));
  assert.ok(labels.includes('<li><a href="text/ch002.xhtml">readme</a></li>'));
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

test('charsPerLine caps the 字下げ class and its one stylesheet rule', () => {
  const cap = String(CHARS_MIN - 1);
  const book: BookInput = { files: [{ name: 'a.jpnov', src: `${indentAnnotation(INDENT_MAX)}文だ。` }] };
  const out = members(book, 'vol1', CHARS_MIN);
  const css = contentOf(out, 'OEBPS/styles.css');
  assert.deepEqual(css.match(/\.indent-[^}]*\}/g), [`.indent-${cap}{padding-inline-start:${cap}em}`]);
  const doc = contentOf(out, 'OEBPS/text/ch001.xhtml');
  assert.ok(doc.includes(`<p class="indent-${cap}">文だ。</p>`));
  assertWellFormedXml(doc);
});

test('an empty chapter source contributes nothing; an all-empty book still gets a spine', () => {
  const sparse = members({ files: [{ name: 'a.jpnov', src: '' }, { name: 'b.jpnov', src: '本文。' }] });
  assert.deepEqual(sparse.filter((m) => m.name.startsWith('OEBPS/text/')).map((m) => m.name), [
    'OEBPS/text/ch002.xhtml',
  ]);

  const empty = members({ files: [{ name: 'a.jpnov', src: '' }], title: '空' });
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

test('a value annotation reflows as its default (EPUB has no page count)', () => {
  const out = members({ files: [{ name: 'vol1/a.jpnov', src: '全［＃ここに「総ページ数」の値を表示］ページ' }] });
  const xhtml = out.find((m) => m.name === 'OEBPS/text/ch001.xhtml')?.content ?? '';
  assert.match(xhtml, new RegExp(`全${VALUE_DEFAULTS.totalPages}ページ`));
});

test('CRLF chapters yield the same members as their LF twins', () => {
  const crlf: BookInput = {
    files: TWO_CHAPTERS.files.map((f) => ({ ...f, src: f.src.replaceAll('\n', '\r\n') })),
  };
  assert.deepEqual(members(crlf), members(TWO_CHAPTERS));
});
