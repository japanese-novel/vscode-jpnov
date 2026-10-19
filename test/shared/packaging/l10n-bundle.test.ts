/**
 * The JA bundle is a map from English source strings: a source string written twice (one
 * feature's label reused as another's) makes the later line silently win for both, so every
 * key must appear once. JSON.parse keeps the last duplicate, hence the line scan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
