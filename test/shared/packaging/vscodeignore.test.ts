/**
 * Holds the allowlist-style `.vscodeignore` in sync with every file package.json references.
 * The ignore file ignores `**` then negates specific paths back in; a manifest asset with no
 * covering negation is SILENTLY dropped from the vsix (this shipped a container icon and the
 * walkthrough media as 404s once). This derives the referenced-file set from the manifest and
 * fails on the first uncovered — or nonexistent — one.
 *
 * Scope note: only MANIFEST-referenced files are derivable. A file referenced solely from code
 * (e.g. `asAbsolutePath('…')`) must be added to {@link CODE_REFERENCED} by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isRecord } from '../../../src/shared/utils/guards.ts';
import { readRepoFile, REPO_ROOT } from '../repo.ts';

/** Files the runtime loads by path (not discoverable from the manifest). */
const CODE_REFERENCED = [
  'dist/server/server.js', // extension.ts asAbsolutePath -> forked server module
  'media/codicon/codicon.css', // book/webviewHtml.ts asWebviewUri -> Books-panel codicon stylesheet
  'media/codicon/codicon.ttf', // @font-face in codicon.css (sibling of the stylesheet)
];

/** vsce metadata that must survive the allowlist. */
const PACKAGING_METADATA = ['package.json', 'package.nls.json', 'package.nls.ja.json', 'README.md', 'LICENSE'];

type Json = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** Collects `value` into `out` when it is a relative asset path (codicon `$(…)` refs are not files). */
function push(out: string[], value: unknown): void {
  if (typeof value === 'string' && value !== '' && !value.startsWith('$(')) {
    out.push(value.replace(/^\.\//, ''));
  }
}

/** A walkthrough step's `media` is {markdown|image|svg: path-or-theme-map}; collect every path in it. */
function pushMedia(out: string[], media: unknown): void {
  if (!isRecord(media)) {
    return;
  }
  for (const value of Object.values(media)) {
    if (typeof value === 'string') {
      push(out, value);
    } else if (isRecord(value)) {
      for (const themed of Object.values(value)) {
        push(out, themed); // {light,dark,highContrast,…} theme map
      }
    }
  }
}

/** Every relative file path the manifest references. */
function manifestAssets(): string[] {
  const pkg = JSON.parse(readRepoFile('package.json')) as Json;
  const out: string[] = [];
  push(out, pkg.main);
  push(out, pkg.icon);
  if (typeof pkg.l10n === 'string') {
    // `l10n` names a directory; the JA bundle inside it is what must actually ship.
    out.push(`${pkg.l10n.replace(/^\.\//, '')}/bundle.l10n.ja.json`);
  }
  const c: Json = isRecord(pkg.contributes) ? pkg.contributes : {};
  for (const lang of asArray(c.languages)) {
    if (isRecord(lang)) {
      push(out, lang.configuration);
    }
  }
  for (const grammar of asArray(c.grammars)) {
    if (isRecord(grammar)) {
      push(out, grammar.path);
    }
  }
  const containerGroups: Json = isRecord(c.viewsContainers) ? c.viewsContainers : {};
  for (const containers of Object.values(containerGroups)) {
    for (const container of asArray(containers)) {
      if (isRecord(container)) {
        push(out, container.icon);
      }
    }
  }
  const viewGroups: Json = isRecord(c.views) ? c.views : {};
  for (const views of Object.values(viewGroups)) {
    for (const view of asArray(views)) {
      if (isRecord(view)) {
        push(out, view.icon);
      }
    }
  }
  for (const command of asArray(c.commands)) {
    if (isRecord(command)) {
      push(out, command.icon); // ours are codicons today; guards a future image icon
    }
  }
  for (const walkthrough of asArray(c.walkthroughs)) {
    if (!isRecord(walkthrough)) {
      continue;
    }
    for (const step of asArray(walkthrough.steps)) {
      if (isRecord(step)) {
        pushMedia(out, step.media);
      }
    }
  }
  return out;
}

/** The `!…` negations of the allowlist; asserts the ignore-everything base rule is intact. */
function allowlist(): string[] {
  const lines = readRepoFile('.vscodeignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  assert.ok(lines.includes('**'), '.vscodeignore must keep the `**` ignore-everything base rule');
  return lines.filter((line) => line.startsWith('!')).map((line) => line.slice(1));
}

/** Whether one negation re-includes `path` (exact file, or a `dir/**` subtree). */
function covered(path: string, negations: string[]): boolean {
  return negations.some(
    (n) => n === path || (n.endsWith('/**') && path.startsWith(n.slice(0, -2))),
  );
}

test('every manifest-referenced asset exists on disk', () => {
  for (const asset of manifestAssets()) {
    if (asset.startsWith('dist/')) {
      continue; // build output; absent in a fresh clone, produced by npm run build
    }
    assert.ok(existsSync(fileURLToPath(new URL(asset, REPO_ROOT))), `missing on disk: ${asset}`);
  }
});

test('.vscodeignore allowlist covers every file the extension ships by reference', () => {
  const negations = allowlist();
  for (const asset of [...manifestAssets(), ...CODE_REFERENCED, ...PACKAGING_METADATA]) {
    assert.ok(covered(asset, negations), `.vscodeignore does not re-include: ${asset}`);
  }
});
