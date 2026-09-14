/**
 * Copy guards: the Japanese terms the product deliberately avoids never appear, and every
 * 「…」-quoted label in the copy is a string the product (or VS Code) actually shows.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { test } from 'node:test';

import { VALUE_FIELD_BY_NAME } from '../../src/shared/compiler/tokenizer.ts';
import { UI } from '../src/copy/ui.ts';
import { readRootText, sitePath } from '../scripts/root.ts';

const FORBIDDEN = ['柱', 'ノンブル', '文章チェック', '題名', '著者', '和文小説'];
/** Names quoted in prose that are not product labels; the manifest name is the Marketplace search term. */
const QUOTED_NAMES = ['Japanese Novel', 'Visual Studio Code', 'Japanese Language Pack', 'これは人名らしい', 'ようこそ', (JSON.parse(await readRootText('package.json')) as { name: string }).name];

/** The files under `dir` matching `ext`, the `skip` sub-directories excluded. */
async function files(dir: string, ext: RegExp, skip: readonly string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries
    .map((rel) => rel.split(sep).join('/'))
    .filter((rel) => ext.test(rel) && !skip.some((d) => rel.startsWith(`${d}/`)))
    .map((rel) => join(dir, rel));
}

async function texts(paths: readonly string[]): Promise<{ path: string; text: string }[]> {
  return Promise.all(paths.map(async (path) => ({ path, text: await readFile(path, 'utf8') })));
}

function values(json: string): Set<string> {
  const out = new Set<string>();
  for (const v of Object.values(JSON.parse(json) as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out.add(v);
    }
  }
  return out;
}

const PRODUCT_STRINGS = new Set([...values(await readRootText('l10n/bundle.l10n.ja.json')), ...values(await readRootText('package.nls.ja.json'))]);

test('the copy never uses the terms the product avoids', async () => {
  const hits: string[] = [];
  for (const { path, text } of await texts(await files(sitePath('src'), /\.(astro|ts|md)$/, ['generated', 'samples']))) {
    for (const term of FORBIDDEN) {
      if (text.includes(term)) {
        hits.push(`${path}: ${term}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test('every UI label the copy types is a string the extension ships', () => {
  for (const [key, label] of Object.entries(UI)) {
    assert.ok(PRODUCT_STRINGS.has(label), `UI.${key} = "${label}" is not a product string`);
  }
});

test('every 「…」 in the copy is a product label or a known name', async () => {
  const allowed = new Set([...Object.values(UI), ...PRODUCT_STRINGS, ...QUOTED_NAMES, ...VALUE_FIELD_BY_NAME.keys()]);
  const bad: string[] = [];
  const copy = [...await files(sitePath('src/components/sections'), /\.astro$/), ...await files(sitePath('src/pages'), /\.astro$/), sitePath('src/stage/beats.ts')];
  for (const { path, text } of await texts(copy)) {
    for (const m of text.matchAll(/「([^」\n]+)」/g)) {
      if (m[1] !== undefined && !allowed.has(m[1])) {
        bad.push(`${path}: 「${m[1]}」`);
      }
    }
  }
  assert.deepEqual(bad, [], 'quote product labels verbatim, or wrap other names in <Q>');
});
