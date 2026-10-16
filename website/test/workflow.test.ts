import assert from 'node:assert/strict';
import { glob, readdir, readFile, stat } from 'node:fs/promises';
import { matchesGlob, posix } from 'node:path';
import { test } from 'node:test';

import { readRootText, rootPath, sitePath } from '../scripts/root.ts';

// The workflow runs only for pushes that touch its `paths`, so every root file the site reads must be listed there.
const WORKFLOW = '.github/workflows/website.yml';
const LINES = (await readRootText(WORKFLOW)).split('\n');
const START = LINES.findIndex((line) => line.trim() === 'paths:') + 1;
const END = LINES.findIndex((line, i) => i >= START && !/^\s+- /.test(line));
const PATHS = LINES.slice(START, END).map((line) => line.replace(/^\s+- /, '').trim());

const SOURCE_EXTENSIONS = /\.(?:ts|astro|mjs|json)$/;
const SITE_CONFIGS = ['astro.config.ts', 'eslint.config.mjs', 'tsconfig.json'];

const RELATIVE_STRING = /(['"])(\.\.?\/[^'"\s]*)\1/g;
const RELATIVE_IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|^import\s+)'(\.\.?\/[^']+)'/gm;
const ROOT_READ = /\b(?:readRootText|rootPath)\(\s*(['`])([^'`]+)\1/g;

async function siteSources(): Promise<string[]> {
  const nested = await Promise.all(['src', 'scripts', 'test'].map(async (dir) => (await readdir(sitePath(dir), { recursive: true })).map((name) => `${dir}/${name}`)));
  return [...nested.flat().filter((rel) => !rel.startsWith('src/generated/')), ...SITE_CONFIGS].filter((rel) => SOURCE_EXTENSIONS.test(rel));
}

/** Repository-relative files outside `website/` that `text` (at repository path `from`) refers to. */
function rootTargets(from: string, text: string, pattern: RegExp, group: number): string[] {
  return [...text.matchAll(pattern)]
    .map((m) => m[group] ?? '')
    .filter((spec) => !spec.endsWith('/') && spec !== '..')
    .map((spec) => posix.normalize(posix.join(posix.dirname(from), spec.replace(/\?.*$/, ''))))
    .filter((rel) => !rel.startsWith('website/') && !rel.startsWith('../'));
}

/** The files a root read reaches: a template's `${…}` and a directory listing stand for every file there. */
async function expand(literal: string): Promise<string[]> {
  const pattern = literal.replace(/\$\{[^}]*\}/g, '*');
  const isDirectory = await stat(rootPath(pattern)).then((s) => s.isDirectory(), () => false);
  return Array.fromAsync(glob(isDirectory ? `${pattern}/*` : pattern, { cwd: rootPath('') }));
}

async function readByTheSite(): Promise<Set<string>> {
  // Seeds the workflow itself needs: the root `npm ci` runs gen.ts through `prepare`, and setup-node reads .nvmrc.
  const imported = new Set<string>(['scripts/gen.ts']);
  const read = new Set<string>(['.nvmrc']);
  for (const rel of await siteSources()) {
    const text = await readFile(sitePath(rel), 'utf8');
    for (const target of rootTargets(`website/${rel}`, text, RELATIVE_STRING, 2)) {
      imported.add(target);
    }
    for (const m of text.matchAll(ROOT_READ)) {
      for (const target of await expand(m[2] ?? '')) {
        read.add(target);
      }
    }
  }
  // Follow the imports of the root modules that run (not of those only read as text): the compiler reaches into the
  // webview probe, gen.ts into its generators.
  for (const rel of imported) {
    if (/\.(?:ts|mjs)$/.test(rel)) {
      for (const target of rootTargets(rel, await readRootText(rel), RELATIVE_IMPORT, 1)) {
        imported.add(target);
      }
    }
  }
  return new Set([...imported, ...read]);
}

const READ = await readByTheSite();

test('the collection reaches the specimens and the compiler’s imports', () => {
  for (const anchor of ['docs/specimens/neko.jpnov', 'src/client/webview/probe/emrShift.ts', 'scripts/write.ts', 'tsconfig.base.json']) {
    assert.ok(READ.has(anchor), `the collection lost ${anchor}`);
  }
});

test(`every root file the site reads is in the paths of ${WORKFLOW}`, () => {
  const missing = [...READ].filter((rel) => !PATHS.some((entry) => matchesGlob(rel, entry))).sort();
  assert.deepEqual(missing, [], `add these to on.push.paths in ${WORKFLOW}`);
});

test(`every entry in the paths of ${WORKFLOW} is still read by the site`, () => {
  const stale = PATHS.filter((entry) => entry !== 'website/**' && entry !== WORKFLOW && ![...READ].some((rel) => matchesGlob(rel, entry)));
  assert.deepEqual(stale, [], `remove these from on.push.paths in ${WORKFLOW}`);
});
