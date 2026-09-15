import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reflowStylesheet } from '../../../src/shared/compiler/css.ts';
import { buildRows, type Row } from '../../../src/shared/compiler/layout.ts';
import { reflowDocument, reflowSegments } from '../../../src/shared/compiler/reflow.ts';
import { tokenize } from '../../../src/shared/compiler/tokenizer.ts';
import { assertWellFormedXml } from '../xml.ts';

function rows(src: string): Row[] {
  return buildRows(tokenize(src), { dash: 'horizontalBar' });
}

/** Segments with a throwaway sink (most assertions only look at the markup). */
function segs(src: string): ReturnType<typeof reflowSegments> {
  return reflowSegments(rows(src), new Set(), 'horizontalBar');
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

test('字下げ becomes the indent-N class and sinks into used', () => {
  const used = new Set<string>();
  const out = reflowSegments(rows('［＃２字下げ］文だ。'), used);
  assert.equal(out[0]?.body, '<p class="indent-2">文だ。</p>');
  assert.ok(used.has('indent-2'));
});

test('改ページ splits segments; leading/trailing/consecutive breaks collapse', () => {
  const out = segs('［＃改ページ］\n一\n［＃改ページ］\n［＃改ページ］\n二\n［＃改ページ］');
  assert.deepEqual(out.map((s) => s.body), ['<p>一</p>', '<p>二</p>']);
});

test('right-only ruby is native <ruby> — no lane spans, no rr class sunk', () => {
  const used = new Set<string>();
  const out = reflowSegments(rows('青空《あおぞら》文庫'), used);
  assert.equal(out[0]?.body, '<p><ruby>青空<rt>あおぞら</rt></ruby>文庫</p>');
  assert.ok(!used.has('rr'));
});

test('left/both-side ruby are NATIVE nested ruby under .ru, class sunk', () => {
  const used = new Set<string>();
  const both = reflowSegments(
    rows('英雄《えいゆう》［＃「英雄」の左に「ひーろー」のルビ］'),
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
  const out = reflowSegments(rows('間――だ'), used, 'horizontalBar');
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
  const out = reflowSegments(rows('12［＃「12」は縦中横］だ、そうだ［＃「そうだ」に傍点］'), used);
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
    '［＃２字下げ］青空《あおぞら》の下、英雄《えいゆう》［＃「英雄」の左に「ひーろー」のルビ］は言った。',
    '「――――そうか」と12［＃「12」は縦中横］月の風［＃「風」に傍点］。',
    'A & B <not-a-tag> ［＃謎の注記-］',
    '［＃改ページ］',
    '終章［＃「終章」は大見出し］',
    'すえ。',
  ].join('\n');
  const used = new Set<string>();
  const out = reflowSegments(rows(src), used);
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
