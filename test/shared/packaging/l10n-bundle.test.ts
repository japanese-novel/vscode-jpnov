/**
 * The JA bundle is a map from English source strings: a source string written twice (one
 * feature's label reused as another's) makes the later line silently win for both, so every
 * key must appear once. JSON.parse keeps the last duplicate, hence the line scan. Every message
 * template is one of those keys, or the client would show the English fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { TEMPLATES } from '../../../src/shared/messages.ts';

const BUNDLE = new URL('../../../l10n/bundle.l10n.ja.json', import.meta.url);

test('the JA bundle writes every source string once', async () => {
  const text = await readFile(BUNDLE, 'utf8');
  const keys = [...text.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gmu)].map((m) => m[1] ?? '');
  const seen = new Set<string>();
  const twice = keys.filter((key) => {
    const dup = seen.has(key);
    seen.add(key);
    return dup;
  });
  assert.deepEqual(twice, [], 'source strings written more than once');
  assert.equal(keys.length, Object.keys(JSON.parse(text) as object).length);
});

test('the JA bundle translates every message template', async () => {
  const bundle = JSON.parse(await readFile(BUNDLE, 'utf8')) as Record<string, string>;
  const missing = Object.entries(TEMPLATES).filter(([, template]) => !(template in bundle)).map(([code]) => code);
  assert.deepEqual(missing, [], 'codes whose template is not a bundle key');
});
