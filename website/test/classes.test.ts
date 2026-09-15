/**
 * Class namespaces: every class the site defines is `jp-*`, the product fragments keep their bare
 * names, and Tailwind runs with source(none) so no utility can land on either (#70).
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Renders } from '../scripts/contract.ts';
import { readSiteText, sitePath } from '../scripts/root.ts';

const PREFIX = 'jp-';
const CLASS_NAME = /\.([A-Za-z_][\w-]*)/g;
/** Only these at-rules nest selectors; every other block holds declarations. */
const GROUP_AT_RULE = /^@(?:media|supports|layer)\b/;

async function files(dir: string, ext: string): Promise<string[]> {
  const entries = await readdir(sitePath(dir), { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(ext) && !e.parentPath.includes(sitePath('src/generated')))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

/** The selector preludes of a stylesheet, comments and declaration blocks skipped. */
function selectors(css: string): string[] {
  const out: string[] = [];
  const stack: ('sel' | 'decl')[] = [];
  let prelude = '';
  const ctx = (): 'sel' | 'decl' => stack.at(-1) ?? 'sel';
  const flush = (): void => {
    const text = prelude.trim();
    prelude = '';
    if (text !== '' && ctx() === 'sel' && !text.startsWith('@')) {
      out.push(text);
    }
  };
  for (let i = 0; i < css.length; i++) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      i = (end < 0 ? css.length : end + 2) - 1;
      continue;
    }
    const ch = css[i] ?? '';
    if (ch === '{') {
      const head = prelude.trim();
      flush();
      stack.push(ctx() === 'sel' && (!head.startsWith('@') || GROUP_AT_RULE.test(head)) ? (head.startsWith('@') ? 'sel' : 'decl') : 'decl');
    } else if (ch === '}') {
      prelude = '';
      stack.pop();
    } else if (ch === ';' && ctx() === 'decl') {
      prelude = '';
    } else {
      prelude += ch;
    }
  }
  return out;
}

/** Class names per compound of one complex selector, in document order. */
function compounds(selector: string): string[][] {
  return selector.split(/\s*[>+~]\s*|\s+/).map((compound) => [...compound.matchAll(CLASS_NAME)].map((m) => m[1] ?? ''));
}

/** Class tokens a component writes: `class="…"`, `class={\`…\`}`, `class:list` literals and `classList` calls. */
function markupTokens(source: string): string[] {
  const tokens: string[] = [];
  const push = (value: string): void => {
    for (const token of value.split(/\s+/)) {
      if (token !== '' && !token.startsWith('${')) {
        tokens.push(token);
      }
    }
  };
  for (const m of source.matchAll(/class="([^"]*)"|class=\{`([^`]*)`\}/g)) {
    push(m[1] ?? m[2] ?? '');
  }
  for (const m of source.matchAll(/class:list=\{\[([\s\S]*?)\]\}/g)) {
    const list = m[1] ?? '';
    for (const s of list.matchAll(/['`]([A-Za-z_][\w-]*)/g)) {
      push(s[1] ?? '');
    }
    for (const key of list.matchAll(/[{,]\s*([A-Za-z_][\w-]*)(?=\s*:)/g)) {
      push(key[1] ?? '');
    }
  }
  for (const m of source.matchAll(/classList\.(?:add|remove|contains|toggle)\('([^']+)'\)|className: '([^']+)'/g)) {
    push(m[1] ?? m[2] ?? '');
  }
  return tokens;
}

const styles = await Promise.all((await files('src/styles', '.css')).map(async (path) => ({ path, css: await readFile(path, 'utf8') })));
const components = await Promise.all((await files('src', '.astro')).concat(await files('src', '.ts')).map(async (path) => ({ path, source: await readFile(path, 'utf8') })));
const renders = JSON.parse(await readSiteText('src/generated/renders.json')) as Renders;

/** The product's class names, from every embedded fragment (body tokens and stylesheet selectors, the scope class excluded). */
const product = new Set<string>();
for (const sample of Object.values(renders.samples)) {
  const fragment = sample.kind === 'book' ? sample.fragment : sample.preview;
  for (const m of fragment.body.matchAll(/class="([^"]*)"/g)) {
    for (const token of (m[1] ?? '').split(' ')) {
      if (token !== '') {
        product.add(token);
      }
    }
  }
  for (const m of fragment.css.matchAll(CLASS_NAME)) {
    if (`.${m[1] ?? ''}` !== fragment.scope) {
      product.add(m[1] ?? '');
    }
  }
}

test('Tailwind runs with source(none) and nothing re-adds a source', async () => {
  const css = await readSiteText('src/styles/global.css');
  assert.match(css.replace(/\/\*[\s\S]*?\*\//g, '').trimStart(), /^@import 'tailwindcss' source\(none\);/, 'the first statement of global.css');
  assert.match(css, /^@theme static \{/m, 'window.css and stage.css read theme variables Tailwind cannot see used');
  for (const { path, source } of components) {
    assert.ok(!source.includes('@source'), `${path} adds a Tailwind source`);
  }
  for (const { path, css: text } of styles) {
    assert.ok(!text.includes('@source') && !text.includes('@apply'), `${path} adds a Tailwind source or utility`);
  }
});

test('site stylesheets define jp-* classes only and reach a bare product class only under a jp-* ancestor', () => {
  assert.ok(product.size > 0 && product.has('grid') && product.has('line'));
  for (const { path, css } of styles) {
    for (const prelude of selectors(css)) {
      for (const complex of prelude.split(',')) {
        let scoped = false;
        for (const names of compounds(complex)) {
          for (const name of names) {
            if (name.startsWith(PREFIX)) {
              continue;
            }
            assert.ok(scoped, `${path}: "${complex.trim()}" styles .${name} outside a ${PREFIX}* ancestor`);
            assert.ok(product.has(name), `${path}: "${complex.trim()}" reaches .${name}, which the product does not emit`);
          }
          scoped ||= names.some((name) => name.startsWith(PREFIX));
        }
      }
    }
  }
});

test('components and scripts write jp-* classes only', () => {
  for (const { path, source } of components) {
    for (const token of markupTokens(source)) {
      assert.ok(token.startsWith(PREFIX), `${path}: class "${token}"`);
    }
  }
});

test('the product emits no jp-* class', () => {
  for (const name of product) {
    assert.ok(!name.startsWith(PREFIX), `product class "${name}"`);
  }
});
