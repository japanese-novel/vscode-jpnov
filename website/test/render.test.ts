import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { test } from 'node:test';

import { readRenders, sitePath } from '../scripts/root.ts';
import { LINKS } from '../src/copy/links.ts';
import { BAIT_LINE } from '../src/stage/sample.ts';

// What `npm run gen` wrote: pipeline.ts stops gen when a sample is missing, when the emphasised
// state carries anything but the one indent finding, or when the product's fix-all does not give
// chapter1.jpnov back.
const renders = await readRenders();
const sample = (name: keyof typeof renders.samples) => renders.samples[name];

test('the emphasised stage state carries the indent finding on the bait line, with its Japanese message', () => {
  const s = sample('stageEmphasised');
  assert.equal(s.kind, 'preview');
  const d = s.diagnostics.at(0);
  assert.ok(d !== undefined);
  assert.equal(d.source, 'jpnov');
  assert.equal(d.message, '行頭が字下げされていません');
  assert.equal(d.range.start.line, BAIT_LINE);
});

test('the fixed stage state is lint-clean', () => {
  const s = sample('stageFixed');
  assert.equal(s.kind, 'preview');
  assert.deepEqual(s.diagnostics, []);
});

test('editor lines carry the product colouring and reproduce the source', () => {
  const s = sample('stageTyping');
  assert.equal(s.kind, 'preview');
  const runs = s.editorLines.flat();
  const has = (kind: string, text: string): boolean => runs.some((r) => r.kind === kind && r.text === text);
  assert.ok(has('character', '花子は'), 'a subject is one run');
  assert.ok(has('character', '太郎') && has('character', 'は'), 'a subject split by a ruby reading is two runs');
  assert.ok(has('marker', '《たろう》'), 'a reading is one merged marker run');
  assert.ok(has('keyword', '聖剣'));
  assert.ok(has('directive', '縦中横'));
  assert.equal(s.editorLines.map((l) => l.map((r) => r.text).join('')).join('\n'), s.src.replace(/\n$/, ''));
});

test('the stage previews carry the notation and the book footer counts two body pages', () => {
  for (const name of ['stageTyping', 'stageEmphasised', 'stageFixed'] as const) {
    const s = sample(name);
    assert.equal(s.kind, 'preview');
    assert.ok(s.preview.body.includes('pb-label') && s.preview.body.includes('class="tcy"') && s.preview.body.includes('ruby class="rr"'));
  }
  const book = sample('stageBook');
  assert.equal(book.kind, 'book');
  assert.ok(book.fragment.body.includes('<div class="hd c">作品名　一</div><div class="ft r">1 / 2</div>'));
  assert.deepEqual(
    [book.counts.pages, book.counts.sheets, book.counts.chars],
    [{ text: '2 ページ', title: '本文のページ数' }, { text: '400 字詰め 2 枚', title: '原稿用紙換算枚数（400 字詰め）' }, { text: '289 字', title: '文字数' }],
    'the status row is the product’s wording of bookCounts(); its pages are the footer’s 総ページ数',
  );
  assert.deepEqual(book.countsBefore.chars, { text: '239 字', title: '文字数' }, 'without 第二章 the body is shorter');
  assert.ok(book.fragment.body.startsWith(`<a class="print" href="${LINKS.sampleBook}?p=1" target="_blank" rel="noopener">印刷／PDF 保存</a>`));
  const cover = sample('cover');
  assert.equal(cover.kind, 'book');
  assert.ok(cover.fragment.body.includes('作品名') && cover.fragment.body.includes('ペンネーム'));
  assert.ok(!cover.fragment.body.includes('NaN'), 'cover values are substituted');
});

test('the stage book’s link opens the product’s own artifact, which prints itself', async () => {
  const html = renders.artifacts.book;
  assert.ok(/^<!doctype html>/i.test(html));
  assert.ok(html.includes('<button class="print" type="button" onclick="window.print()">印刷／PDF 保存</button>'));
  assert.ok(html.includes("get('p')==='1'"), 'the ?p=1 autorun the link relies on');
  assert.ok(html.includes('@page') && html.includes('作品名') && html.includes('ペンネーム'));
  await assert.doesNotReject(access(sitePath(`src/pages${LINKS.sampleBook}.ts`)), 'the endpoint serving the link');
});
