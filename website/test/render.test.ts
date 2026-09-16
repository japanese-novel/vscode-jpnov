import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { test } from 'node:test';

import { buildRenders, serialize } from '../scripts/pipeline.ts';
import { readSiteText, sitePath } from '../scripts/root.ts';
import { SAMPLES } from '../scripts/samples.ts';
import { LINKS } from '../src/copy/links.ts';
import { BAIT_LINE } from '../src/stage/sample.ts';

const renders = await buildRenders();
const sample = (name: keyof typeof renders.samples) => renders.samples[name];

test('every sample renders', () => {
  assert.deepEqual(Object.keys(renders.samples), SAMPLES.map((s) => s.name));
});

test('the emphasised stage state carries exactly the indent finding, with its Japanese message and fix', () => {
  const s = sample('stageEmphasised');
  assert.equal(s.kind, 'preview');
  assert.equal(s.diagnostics.length, 1);
  const d = s.diagnostics.at(0);
  assert.ok(d !== undefined);
  assert.equal(d.code, 'lint.narration.indent');
  assert.equal(d.message.ja, '行頭が字下げされていません');
  assert.equal(d.range.start.line, BAIT_LINE);
  assert.deepEqual(d.fix, { range: { start: { line: BAIT_LINE, character: 0 }, end: { line: BAIT_LINE, character: 0 } }, newText: '　' });
});

test('the fixed stage state is the product fix-all result and is lint-clean', async () => {
  const s = sample('stageFixed');
  assert.equal(s.kind, 'preview');
  assert.deepEqual(s.diagnostics, []);
  assert.equal(s.fixAll?.title.ja, '自動修正できる問題をすべて修正（小説）');
  assert.equal(s.src, await readSiteText('src/samples/chapter1.jpnov'));
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

test('the stage previews share one scope and the book footer counts two body pages', () => {
  for (const name of ['stageTyping', 'stageEmphasised', 'stageFixed'] as const) {
    const s = sample(name);
    assert.equal(s.kind, 'preview');
    assert.equal(s.preview.scope, '.jp-r-stage');
    assert.ok(s.preview.body.includes('pb-label') && s.preview.body.includes('class="tcy"') && s.preview.body.includes('ruby class="rr"'));
  }
  const book = sample('stageBook');
  assert.equal(book.kind, 'book');
  assert.equal(book.totalPages, 2);
  assert.ok(book.fragment.body.includes('<div class="hd">作品名　一</div><div class="ft r">1 / 2</div>'));
  assert.ok(book.fragment.body.startsWith(`<a class="print" href="${LINKS.sampleBook}?p=1" target="_blank" rel="noopener">印刷／PDF 保存</a>`));
  const cover = sample('cover');
  assert.equal(cover.kind, 'book');
  assert.equal(cover.pageCount, 1);
  assert.ok(cover.fragment.body.includes('作品名') && cover.fragment.body.includes('ペンネーム'));
  assert.ok(!cover.fragment.body.includes('NaN'), 'cover values are substituted');
});

test('renders.json on disk is current', async () => {
  assert.equal(await readSiteText('src/generated/renders.json'), serialize(renders));
});

test('the stage book’s link opens the product’s own artifact, which prints itself', async () => {
  const html = renders.artifacts.book;
  assert.ok(/^<!doctype html>/i.test(html));
  assert.ok(html.includes('<button class="print" type="button" onclick="window.print()">印刷／PDF 保存</button>'));
  assert.ok(html.includes("get('p')==='1'"), 'the ?p=1 autorun the link relies on');
  assert.ok(html.includes('@page') && html.includes('作品名') && html.includes('ペンネーム'));
  await assert.doesNotReject(access(sitePath(`src/pages${LINKS.sampleBook}.ts`)), 'the endpoint serving the link');
});
