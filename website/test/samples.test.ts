import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';

import { COVER_TEMPLATE } from '../../src/shared/book/create.ts';
import { checkJpbook, parseJpbook } from '../../src/shared/book/jpbook.ts';
import { DEFAULT_FONT_STACK } from '../../src/shared/compiler/css.ts';
import { COUNT_KEYS } from '../scripts/counts.ts';
import { readRootText, readSiteText, rootPath, sitePath } from '../scripts/root.ts';
import { SUBMISSION_JPBOOK } from '../src/copy/book.ts';

test('the cover sample is the product’s own template', async () => {
  assert.equal(await readSiteText('src/samples/cover.jpnov'), COVER_TEMPLATE);
});

test('the shown .jpbook is one the product accepts', () => {
  const verdict = checkJpbook(parseJpbook(SUBMISSION_JPBOOK));
  assert.ok(verdict.ok, JSON.stringify(verdict));
});

test('the Mincho stack is the product’s default stack', async () => {
  assert.ok((await readSiteText('src/styles/global.css')).includes(`--font-mincho: ${DEFAULT_FONT_STACK};`));
});

test('the samples and the shared specimens are LF-only and NFC', async () => {
  const samples = await readdir(sitePath('src/samples'));
  const specimens = (await readdir(rootPath('docs/specimens'))).filter((name) => name.endsWith('.jpnov'));
  const texts = await Promise.all([
    ...samples.map(async (name) => ({ name, text: await readSiteText(`src/samples/${name}`) })),
    ...specimens.map(async (name) => ({ name, text: await readRootText(`docs/specimens/${name}`) })),
  ]);
  for (const { name, text } of texts) {
    assert.ok(!text.includes('\r'), `${name} has CR`);
    assert.equal(text, text.normalize('NFC'), `${name} is not NFC`);
    assert.ok(text.endsWith('\n'), `${name} lacks a final newline`);
  }
});

test('no browser script bundles the renders', async () => {
  for (const dir of ['src/stage', 'src/scripts']) {
    for (const name of await readdir(sitePath(dir))) {
      assert.ok(!(await readSiteText(`${dir}/${name}`)).includes('generated/renders'), `${dir}/${name} imports renders.json`);
    }
  }
});

test('the status row’s bundle keys are the ones the Books view formats with', async () => {
  const view = await readRootText('src/client/book/view.ts');
  for (const item of Object.values(COUNT_KEYS)) {
    assert.ok(view.includes(`'${item.text}'`) && view.includes(`'${item.title}'`), `${item.text} / ${item.title} not found in view.ts`);
  }
});

test('the build-button glyphs are the product’s own paths', async () => {
  const main = await readRootText('src/client/webview/book/main.ts');
  const sidebar = await readSiteText('src/components/stage/SideBar.astro');
  for (const m of sidebar.matchAll(/const \w+_PATH = '([^']+)';/g)) {
    assert.ok(m[1] !== undefined && main.includes(m[1]), 'glyph path not found in main.ts');
  }
});
