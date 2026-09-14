import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readRootText, readSiteText } from '../scripts/root.ts';

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}
interface Lockfile {
  readonly packages: Readonly<Record<string, { readonly version?: string }>>;
}

const site = JSON.parse(await readSiteText('package.json')) as Manifest;
const root = JSON.parse(await readRootText('package.json')) as Manifest;
const siteLock = JSON.parse(await readSiteText('package-lock.json')) as Lockfile;
const rootLock = JSON.parse(await readRootText('package-lock.json')) as Lockfile;

// Two npm projects, so the shared packages stay in lockstep here rather than through a workspace.
test('packages shared with the root resolve to the root’s versions (fix: npm install <name>@<root version> in website/)', () => {
  const shared = Object.keys(site.devDependencies ?? {}).filter((name) => rootLock.packages[`node_modules/${name}`] !== undefined);
  assert.ok(shared.includes('typescript') && shared.includes('vscode-languageserver-textdocument'), 'the shared set lost its anchors');
  for (const name of shared) {
    const rootVersion = rootLock.packages[`node_modules/${name}`]?.version;
    const siteVersion = siteLock.packages[`node_modules/${name}`]?.version;
    assert.equal(siteVersion, rootVersion, `${name}: site ${siteVersion ?? '?'} vs root ${rootVersion ?? '?'}`);
    const declared = root.devDependencies?.[name] ?? root.dependencies?.[name];
    if (declared !== undefined) {
      assert.equal(site.devDependencies?.[name], declared, `${name}: declared range differs from the root’s`);
    }
  }
});

test('the lint toolchain is the root’s install, not declared here', () => {
  for (const name of ['eslint', 'typescript-eslint', '@stylistic/eslint-plugin', '@types/node']) {
    assert.equal(site.devDependencies?.[name], undefined, `${name} comes from the root install`);
  }
});
