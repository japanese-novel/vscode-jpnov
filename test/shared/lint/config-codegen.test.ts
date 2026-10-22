/**
 * Holds package.json + the nls bundles in sync with the catalog. The expected configuration is
 * DERIVED from RULES (see _configSchema.ts); if a rule is added/changed without regenerating the
 * committed `contributes.configuration`, this fails and prints the diff to paste.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { RULES } from '../../../src/shared/lint/catalog.ts';

import { expectedConfiguration, expectedNlsKeys, ruleDescriptionKey } from './_configSchema.ts';

const ROOT = new URL('../../../', import.meta.url); // repo root, from test/shared/lint/

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fileURLToPath(new URL(rel, ROOT)), 'utf8')) as Record<string, unknown>;
}

test('package.json contributes.configuration matches the catalog', () => {
  const pkg = readJson('package.json');
  const contributes = pkg.contributes as { configuration: unknown };
  assert.deepEqual(contributes.configuration, expectedConfiguration());
});

test('every referenced nls key is defined in both the EN and JA bundles', () => {
  const en = readJson('package.nls.json');
  const ja = readJson('package.nls.ja.json');
  for (const key of expectedNlsKeys()) {
    assert.ok(key in en, `missing EN nls key: ${key}`);
    assert.ok(key in ja, `missing JA nls key: ${key}`);
  }
});

test('no orphaned configuration nls keys linger in either bundle', () => {
  // The reverse direction: a renamed/removed setting must take its bundle strings with it,
  // or stale keys (invisible in the UI) accumulate. Scoped to the configuration prefixes —
  // command/view/walkthrough keys have other owners.
  const expected = new Set(expectedNlsKeys());
  for (const bundle of ['package.nls.json', 'package.nls.ja.json']) {
    for (const key of Object.keys(readJson(bundle))) {
      if (/^jpnov\.(layout|lint|editor)\./.test(key)) {
        assert.ok(expected.has(key), `orphaned nls key in ${bundle}: ${key}`);
      }
    }
  }
});

test('a threshold description recommends the value the catalog suggests', () => {
  const en = readJson('package.nls.json');
  const ja = readJson('package.nls.ja.json');
  for (const rule of RULES) {
    if (rule.kind !== 'threshold') {
      continue;
    }
    const key = ruleDescriptionKey(rule);
    assert.ok(String(en[key]).includes(`Recommended: ${String(rule.suggested)}.`), `EN ${key}`);
    assert.ok(String(ja[key]).includes(`推奨: ${String(rule.suggested)}。`), `JA ${key}`);
  }
});
