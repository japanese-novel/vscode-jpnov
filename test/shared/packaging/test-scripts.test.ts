/**
 * Holds the package.json test scripts in sync with the tests on disk. The client and server
 * suites are EXPLICIT path lists (the unit/integration split follows each file's dependency
 * nature, not its directory, so no glob can express it), and an explicit list rots silently:
 * a new `*.test.ts` covered by no script would simply never run, and `node --test` exits 0
 * on a glob that matches nothing. The suites must PARTITION the tree — every file in exactly
 * one script, every entry still matching something.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readPackageScripts, REPO_ROOT } from '../repo.ts';

const SCRIPTS = ['test', 'test:integration', 'test:e2e'] as const;

// A subtree glob, e.g. "test/shared/**/*.test.ts"; any OTHER starred shape is unsupported
// and fails loudly in covers() — extend the matcher when the wiring convention grows.
const SUBTREE = /^([^*]+)\/\*\*\/\*\.test\.ts$/;

// The quoted arguments of one script that name suites — the wiring convention is that every
// suite file/glob is a double-quoted argument ending in .test.ts (loader flags are not).
function patternsOf(script: string): string[] {
  return [...script.matchAll(/"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((p): p is string => p?.endsWith('.test.ts') === true);
}

function scriptPatterns(): ReadonlyMap<string, readonly string[]> {
  const all = readPackageScripts();
  const out = new Map<string, readonly string[]>();
  for (const name of SCRIPTS) {
    const script = all[name];
    assert.ok(script !== undefined, `package.json scripts.${name} is missing`);
    const patterns = patternsOf(script);
    assert.ok(patterns.length > 0, `scripts.${name} names no test patterns`);
    out.set(name, patterns);
  }
  return out;
}

function covers(file: string, pattern: string): boolean {
  const dir = SUBTREE.exec(pattern)?.[1];
  if (dir !== undefined) {
    return file.startsWith(`${dir}/`);
  }
  assert.ok(!pattern.includes('*'), `unsupported test-script pattern shape: ${pattern}`);
  return file === pattern;
}

function testFilesOnDisk(): string[] {
  const dir = fileURLToPath(new URL('test/', REPO_ROOT));
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.test.ts'))
    .map((rel) => `test/${rel.replaceAll('\\', '/')}`)
    .sort();
}

test('every *.test.ts on disk runs in exactly one test script', () => {
  const patterns = scriptPatterns();
  for (const file of testFilesOnDisk()) {
    const owners = [...patterns]
      .filter(([, pats]) => pats.some((pattern) => covers(file, pattern)))
      .map(([name]) => name);
    assert.equal(
      owners.length,
      1,
      owners.length === 0
        ? `${file} is covered by no test script — add it to package.json`
        : `${file} runs in several suites: ${owners.join(', ')}`,
    );
  }
});

test('every test-script entry still matches something on disk', () => {
  const files = testFilesOnDisk();
  for (const [name, patterns] of scriptPatterns()) {
    for (const pattern of patterns) {
      assert.ok(
        files.some((file) => covers(file, pattern)),
        `scripts.${name} entry matches nothing: ${pattern}`,
      );
    }
  }
});
