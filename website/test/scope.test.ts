import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderBook } from '../../src/shared/compiler/document.ts';
import { EDGE_INSET, fitPaper, HEADER_BAND, LINENUM_BAND } from '../../src/shared/compiler/geometry.ts';
import { renderPreview } from '../../src/shared/compiler/preview.ts';
import { LAYOUT_DEFAULT } from '../../src/shared/config/types.ts';
import { scopeFragment } from '../scripts/scope.ts';

const SRC = '　物語《ものがたり》が始まる。\n　覚悟［＃「覚悟」に傍点］を決めた。\n　第42［＃「42」は縦中横］話。\n［＃改ページ］\n「何だと!?」\n';
const LEAKS = ['html{', 'body{', ':root{', '@page', '@media', '--vscode-', 'position:fixed', '<script', 'onclick='];
const UNIT = /\d(?:rem|vh)\b/;

const preview = (): string => renderPreview(SRC, { ...LAYOUT_DEFAULT, charsPerLine: 20, chrome: { lineNumbers: true, edgeLine: 'red' } });
const book = (): string => renderBook({
  books: [{ files: [{ name: 'a.jpnov', src: SRC }], cover: { files: [{ name: 'c.jpnov', src: '［＃５字下げ］［＃ここに「タイトル」の値を表示］\n' }], title: '作品名', author: 'ペンネーム' } }],
  ...LAYOUT_DEFAULT,
  paperSize: 'a4',
  paperOrientation: 'auto',
  chrome: { lineNumbers: true, edgeLine: 'red', pageNumber: 'right', pageNumberFormat: '{page} / {totalPage}', header: '作品名　一' },
});

test('a preview fragment keeps every rule under its scope and no root or viewport dependency', () => {
  const { fragment } = scopeFragment(preview(), { scope: '.jp-r-t', kind: 'preview' });
  for (const leak of LEAKS) {
    assert.ok(!fragment.css.includes(leak) && !fragment.body.includes(leak), `leak: ${leak}`);
  }
  assert.ok(!UNIT.test(fragment.css), 'no rem/vh units');
  for (const rule of fragment.css.split('}').filter((r) => r.trim() !== '')) {
    assert.ok(rule.startsWith('.jp-r-t'), `unscoped rule: ${rule.slice(0, 60)}`);
  }
  assert.ok(fragment.css.includes(`--jp-em:calc(var(--jp-band) / (var(--cpl) + ${String(2 * EDGE_INSET)}))`));
  assert.ok(fragment.css.includes('.jp-r-t .line{position:relative;}'));
  assert.ok(fragment.css.includes('calc(0.35 * var(--jp-em))'));
  assert.ok(fragment.body.startsWith('<div class="book"><div class="segment">'));
  assert.equal(fragment.body.split('　').length, SRC.split('　').length, 'full-width spaces survive');
});

test('a book fragment carries the paper geometry from fitPaper and can keep one page', () => {
  const scoped = scopeFragment(book(), { scope: '.jp-r-b', kind: 'book', keepPages: [1], printButton: { href: '/x.html' } });
  const fit = fitPaper({ charsPerLine: 40, linesPerPage: 34, linePitch: 1.5, hTop: HEADER_BAND + LINENUM_BAND, size: 'a4', orientation: 'auto' });
  assert.deepEqual(scoped.paper, { widthMm: fit.widthMm, heightMm: fit.heightMm, fontMm: fit.fontMm });
  assert.equal(scoped.pageCount, 1);
  assert.equal(scoped.totalPages, 2);
  assert.ok(scoped.fragment.body.startsWith('<a class="print" href="/x.html" target="_blank" rel="noopener">印刷／PDF 保存</a><div class="book"><div class="page" data-page="1">'));
  assert.ok(scoped.fragment.body.includes('<div class="hd">作品名　一</div><div class="pn r">1 / 2</div>'));
  assert.ok(scoped.fragment.css.includes('.jp-r-b .print{position:absolute;'));
  assert.ok(scoped.fragment.css.includes('.jp-r-b .page{box-shadow:'), 'the screen rules are unwrapped, not dropped');
  for (const leak of LEAKS) {
    assert.ok(!scoped.fragment.css.includes(leak) && !scoped.fragment.body.includes(leak), `leak: ${leak}`);
  }
  assert.ok(!UNIT.test(scoped.fragment.css), 'no rem/vh units');
  const noButton = scopeFragment(book(), { scope: '.jp-r-b', kind: 'book', keepPages: [0] });
  assert.ok(noButton.fragment.body.startsWith('<div class="book"><div class="page cover" data-page="0">'));
});

test('the transform is deterministic', () => {
  const a = scopeFragment(preview(), { scope: '.jp-r-t', kind: 'preview' });
  const b = scopeFragment(preview(), { scope: '.jp-r-t', kind: 'preview' });
  assert.deepEqual(a, b);
});
