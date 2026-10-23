import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';

import { checkJpbook, parseJpbook } from '../../src/shared/book/jpbook.ts';
import { readRootText, readSiteText, rootPath, sitePath } from '../scripts/root.ts';
import { SUBMISSION_JPBOOK } from '../src/copy/book.ts';

test('the shown .jpbook is one the product accepts', () => {
  const verdict = checkJpbook(parseJpbook(SUBMISSION_JPBOOK));
  assert.ok(verdict.ok, JSON.stringify(verdict));
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
