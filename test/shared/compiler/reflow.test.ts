import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDENT_MAX } from '../../../src/shared/ast/notation.ts';
import { parse } from '../../../src/shared/ast/parse.ts';
import { CHARS_MIN, LAYOUT_DEFAULT } from '../../../src/shared/config/types.ts';
import { reflowStylesheet } from '../../../src/shared/compiler/css.ts';
import { buildRows, type Row } from '../../../src/shared/compiler/layout.ts';
import { reflowDocument, reflowSegments } from '../../../src/shared/compiler/reflow.ts';
import { assertWellFormedXml, assertXmlChars } from '../xml.ts';
import { blockIndent } from '../ast/_shape.ts';
import { BLANKS, D } from '../_kana.ts';

const CPL = LAYOUT_DEFAULT.charsPerLine;

function rows(src: string): Row[] {
  return buildRows(parse(src), { dash: 'horizontalBar' });
}

/** Segments with a throwaway sink (most assertions only look at the markup). */
function segs(src: string): ReturnType<typeof reflowSegments> {
  return reflowSegments(rows(src), CPL, new Set(), 'horizontalBar');
}

/** The one segment a plain source produces. */
function body(src: string): string {
  const out = segs(src);
  assert.equal(out.length, 1);
  return out[0]?.body ?? '';
}

test('one logical source line becomes one <p>, escaped', () => {
  assert.equal(body('吾輩は猫である。\nA & B <tag>'), '<p>吾輩は猫である。</p><p>A &amp; B &lt;tag&gt;</p>');
});

test('a blank source line survives as <p><br/></p>, 1:1, never merged', () => {
  assert.equal(body('あ\n\n\nい'), '<p>あ</p><p><br/></p><p><br/></p><p>い</p>');
});

test('CRLF: a blank \\r\\n line is <p><br/></p>; a 見出し label carries no \\r', () => {
  assert.equal(body('あ\r\n\r\nい'), '<p>あ</p><p><br/></p><p>い</p>');
  assert.equal(segs('序章［＃「序章」は大見出し］\r\n本文')[0]?.heading, '序章');
});

test('a comment-only line keeps its blank column, comment inside the <p>', () => {
  const b = body('あ\n［＃謎の注記］\nい');
  assert.equal(b, '<p>あ</p><p><!--謎の注記--><br/></p><p>い</p>');
});

test('見出し rows become real hN (大=1→h1), one per row, and feed the segment heading', () => {
  const out = segs('序章［＃「序章」は大見出し］\n本文');
  const first = out[0];
  assert.ok(first);
  assert.equal(first.body, '<h1>序章</h1><p>本文</p>');
  assert.equal(first.heading, '序章');
});

test('a blank line inside a 見出し block keeps its column as <hN><br/></hN> (#86)', () => {
  assert.equal(
    body('［＃ここから大見出し］\n序章\n\n副題\n［＃ここで大見出し終わり］\n本文'),
    '<h1>序章</h1><h1><br/></h1><h1>副題</h1><p>本文</p>',
  );
  assert.equal(body('［＃大見出し］\n序章\n［＃大見出し終わり］'), '<h1><br/></h1><h1>序章</h1>');
});

test('a blank 見出し leaves the segment label to the next one', () => {
  // Half-width, full-width, and a character no output carries: nothing of the heading shows.
  for (const blank of BLANKS) {
    const head = `［＃大見出し］${blank}［＃大見出し終わり］`;
    assert.equal(segs(`${head}\n本文`)[0]?.heading, null, JSON.stringify(blank));
    assert.equal(segs(`${head}\n王都［＃「王都」は中見出し］\n本文`)[0]?.heading, '王都', JSON.stringify(blank));
  }
});

test('a line of only dropped characters is a blank line', () => {
  assert.equal(body('あ\n\u0007\uFFFE\nい'), body('あ\n\nい'));
  assert.equal(body('あ\n\u0007\uFFFE\nい'), '<p>あ</p><p><br/></p><p>い</p>');
});

test('assertXmlChars follows the XML Char production', () => {
  // https://www.w3.org/TR/xml/#charsets
  for (const ok of ['\t\n\r', '　山田　太郎', '神', '�', '\u{10000}\u{10FFFF}', '\u007F\u0085']) {
    assertXmlChars(ok);
  }
  for (const bad of ['\0', '\u0008', '\u000B', '\u000C', '\u000E', '\u001F', '\uFFFE', '\uFFFF', '\uD800']) {
    assert.throws(() => {
      assertXmlChars(`あ${bad}い`);
    }, JSON.stringify(bad));
  }
});

test('a block 字下げ becomes the indent-N class and sinks into used; a ［＃○字下げ］ is its spaces', () => {
  const used = new Set<string>();
  const out = reflowSegments(rows(`${blockIndent(2)}\n文だ。`), CPL, used);
  assert.equal(out[0]?.body, '<p class="indent-2">文だ。</p>');
  assert.ok(used.has('indent-2'));
  const own = new Set<string>();
  assert.equal(reflowSegments(rows('［＃２字下げ］文だ。'), CPL, own)[0]?.body, '<p>　　文だ。</p>');
  assert.deepEqual([...own], []);
});

test('a block 字下げ caps at charsPerLine - 1, like the paginated build', () => {
  const cap = CHARS_MIN - 1;
  const over = CHARS_MIN + 5;
  assert.ok(over <= INDENT_MAX);
  const capped = `class="indent-${String(cap)}"`;
  const cases: readonly (readonly [name: string, src: string, body: string])[] = [
    ['block', `${blockIndent(over)}\n一\n二\n［＃ここで字下げ終わり］`, `<p ${capped}>一</p><p ${capped}>二</p>`],
    ['見出し', `${blockIndent(over)}\n序章［＃「序章」は大見出し］`, `<h1 ${capped}>序章</h1>`],
    ['at the cap', `${blockIndent(cap)}\n文だ。`, `<p ${capped}>文だ。</p>`],
  ];
  for (const [name, src, want] of cases) {
    const used = new Set<string>();
    assert.equal(reflowSegments(rows(src), CHARS_MIN, used)[0]?.body, want, name);
    assert.deepEqual([...used], [`indent-${String(cap)}`], name);
  }
});

test('charsPerLine 1 leaves no indent class', () => {
  const used = new Set<string>();
  assert.equal(reflowSegments(rows(`${blockIndent(2)}\n文`), 1, used)[0]?.body, '<p>文</p>');
  assert.deepEqual([...used], []);
});

test('改ページ splits segments; leading/trailing/consecutive breaks collapse', () => {
  const out = segs('［＃改ページ］\n一\n［＃改ページ］\n［＃改ページ］\n二\n［＃改ページ］');
  assert.deepEqual(out.map((s) => s.body), ['<p>一</p>', '<p>二</p>']);
});

test('right-only ruby is native <ruby> — no lane spans, no rr class sunk', () => {
  const used = new Set<string>();
  const out = reflowSegments(rows('青空《あおぞら》文庫'), CPL, used);
  assert.equal(out[0]?.body, '<p><ruby>青空<rt>あおぞら</rt></ruby>文庫</p>');
  assert.ok(!used.has('rr'));
});

test('left/both-side ruby are NATIVE nested ruby under .ru, class sunk', () => {
  const used = new Set<string>();
  const both = reflowSegments(
    rows('英雄《えいゆう》［＃「英雄」の左に「ひーろー」のルビ］'),
    CPL,
    used,
  );
  // The both-side form nests: inner ruby carries the right reading, the outer <rt> is the left.
  assert.equal(
    both[0]?.body,
    '<p><ruby class="ru"><ruby>英雄<rt>えいゆう</rt></ruby><rt>ひーろー</rt></ruby></p>',
  );
  assert.ok(used.has('ru'));
  assert.ok(!used.has('br'));

  // Left-only stays a single ruby; no lane spans, no rh-N stretch (grid-only concepts).
  const left = segs('字［＃「字」の左に「ながいよみ」のルビ］');
  assert.equal(left[0]?.body, '<p><ruby class="ru">字<rt>ながいよみ</rt></ruby></p>');
});

test('a dash run binds under .insep nowrap and carries the translated em dash', () => {
  const used = new Set<string>();
  const out = reflowSegments(rows('間――だ'), CPL, used, 'horizontalBar');
  // The run html joins the MEMBER html (already translated) — rebuilding from `text` would
  // smuggle the source glyphs back into the EPUB.
  assert.equal(out[0]?.body, '<p>間<span class="insep">——</span>だ</p>');
  assert.ok(used.has('insep'));

  // A lone dash and a mixed dash/leader pair stay free (same-class runs only, length ≥ 2).
  assert.equal(body('間―だ'), '<p>間—だ</p>');
  assert.equal(body('間―…だ'), '<p>間—…だ</p>');
  assert.equal(body('間……だ'), '<p>間<span class="insep">……</span>だ</p>');
});

test('a 見出し nav label translates its dash like the body', () => {
  const out = segs('第一章――序［＃「第一章――序」は大見出し］');
  assert.equal(out[0]?.heading, '第一章——序');
});

test('an emphasis boundary splits an insep run (equal channels required)', () => {
  const b = body('――――［＃「――」に傍点］');
  // The trailing two dashes carry 傍点; the leading two do not — two separate nowrap runs.
  assert.match(b, /<span class="insep">——<\/span><span class="emph-fs"><span class="insep">——<\/span><\/span>/);
});

test('縦中横 and emphasis channel runs ride through emitUnits unchanged', () => {
  const used = new Set<string>();
  const out = reflowSegments(rows('12［＃「12」は縦中横］だ、そうだ［＃「そうだ」に傍点］'), CPL, used);
  const b = out[0]?.body ?? '';
  assert.match(b, /<span class="tcy">12<\/span>/);
  assert.match(b, /<span class="emph-fs">そうだ<\/span>/);
  assert.ok(used.has('tcy'));
  assert.ok(used.has('emph-fs'));
});

test('reflowDocument is a namespaced XHTML shell with a stylesheet link', () => {
  const doc = reflowDocument('第一章 & 序', '<p>本文</p>', '../styles.css');
  assert.ok(doc.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'));
  assert.ok(doc.includes('<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" lang="ja">'));
  assert.ok(doc.includes('<title>第一章 &amp; 序</title>'));
  assert.ok(doc.includes('<link rel="stylesheet" type="text/css" href="../styles.css"/>'));
  assertWellFormedXml(doc);
});

test('the EPUB side carries no 印刷 button (reading systems own the UI)', () => {
  const doc = reflowDocument('章', '<p>本文</p>', '../styles.css');
  assert.doesNotMatch(doc, /window\.print/);
  assert.doesNotMatch(reflowStylesheet('relaxed', []), /\.print\{/);
});

test('the kitchen sink emits well-formed XML end to end', () => {
  const src = [
    '序章［＃「序章」は大見出し］',
    '',
    '［＃ここから２字下げ］',
    '［＃１字下げ］青空《あおぞら》の下、英雄《えいゆう》［＃「英雄」の左に「ひーろー」のルビ］は言った。',
    '［＃ここで字下げ終わり］',
    '「――――そうか」と12［＃「12」は縦中横］月の風［＃「風」に傍点］。',
    'A & B <not-a-tag> ［＃謎の注記-］',
    '［＃改ページ］',
    '終章［＃「終章」は大見出し］',
    'すえ。',
  ].join('\n');
  const used = new Set<string>();
  const out = reflowSegments(rows(src), CPL, used);
  assert.equal(out.length, 2);
  for (const seg of out) {
    const doc = reflowDocument(seg.heading ?? '無題', seg.body, '../styles.css');
    assertWellFormedXml(doc);
  }
  // The used sink feeds the same on-demand CSS pipe the other outputs use.
  const css = reflowStylesheet('relaxed', [...used].sort());
  assert.ok(css.includes('.insep{white-space:nowrap}'));
  assert.ok(css.includes('.indent-2{padding-inline-start:2em}'));
});

test('NFD kana reach the EPUB composed: base, reading and prose alike', () => {
  assert.equal(body(`｜カ${D}ラス戸《か${D}らすと${D}》か${D}開いた`), '<p><ruby>ガラス戸<rt>がらすど</rt></ruby>が開いた</p>');
  assert.equal(body(`聖剣［＃「聖剣」の左に「つるき${D}」のルビ］`), '<p><ruby class="ru">聖剣<rt>つるぎ</rt></ruby></p>');
});
