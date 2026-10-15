/**
 * Holds the package.json scripts to the codegen contract: the generated modules (gitignored,
 * written by `npm run gen`) are imported by `src/`, so every script that reads `src/` generates
 * them first, through its own `pre*` hook. `prepare` stays for the consumers that run no script
 * (the editor's tsserver, the site build), which is also what hides a script that forgot: it
 * passes on every installed tree and fails on a bare one. There is one generation entry, `gen`
 * (scripts/gen.ts) — a script that picked a subset of the generators was how `prescreenshots`
 * came to lack a module (#204).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readPackageScripts, type Scripts } from '../repo.ts';

/** Scripts whose own command is the generation (scripts/gen.ts, or esbuild.config.js up front). */
const GENERATES: ReadonlySet<string> = new Set(['gen', 'build', 'build:dev', 'watch:esbuild']);

/** Scripts that read no `src/` themselves; a new entry is a decision. */
const READS_NO_SRC: ReadonlySet<string> = new Set([
  'package', // vsce runs vscode:prepublish, which the loop checks
  'watch:tsc', // a child of `watch`: prewatch generates once, the children would race
  'watch:tsc:webview',
]);

/** Whether `npm run <name>` generates before its own work: itself, via `pre<name>`, or by its first command. */
function generates(all: Scripts, name: string): boolean {
  if (GENERATES.has(name)) {
    return true;
  }
  return [all[`pre${name}`], all[name]].some((script) => {
    const target = script === undefined ? undefined : /^npm run (\S+)\s*(?:&&|$)/.exec(script)?.[1];
    return target !== undefined && generates(all, target);
  });
}

test('gen is the only generation entry', () => {
  const subsets = Object.keys(readPackageScripts()).filter((name) => name.startsWith('gen:'));
  assert.deepEqual(subsets, [], `scripts pick a subset of the generators: ${subsets.join(', ')}`);
});

test('every script that reads src/ generates first', () => {
  const all = readPackageScripts();
  for (const name of Object.keys(all)) {
    // A hook of another script is checked as part of that script (`prepare` is no hook: `pare` is no script).
    if ((name.startsWith('pre') && all[name.slice(3)] !== undefined) || READS_NO_SRC.has(name)) {
      continue;
    }
    assert.ok(
      generates(all, name),
      `scripts.${name} runs without the generated modules — add "pre${name}": "npm run gen" (or list it in READS_NO_SRC, with the reason)`,
    );
  }
});

test('every listed script still exists', () => {
  const all = readPackageScripts();
  for (const name of [...GENERATES, ...READS_NO_SRC]) {
    assert.ok(all[name] !== undefined, `names a script that no longer exists: ${name}`);
  }
});
