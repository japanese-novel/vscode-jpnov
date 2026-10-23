/** Repository and site anchors for the build scripts and tests, plus the generated-module guard. */
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Renders } from './contract.ts';

const ROOT = new URL('../../', import.meta.url);
const SITE = new URL('../', import.meta.url);

export function rootPath(rel: string): string {
  return fileURLToPath(new URL(rel, ROOT));
}

export function sitePath(rel: string): string {
  return fileURLToPath(new URL(rel, SITE));
}

export function readRootText(rel: string): Promise<string> {
  return readFile(rootPath(rel), 'utf8');
}

export function readSiteText(rel: string): Promise<string> {
  return readFile(sitePath(rel), 'utf8');
}

/** The product renders `npm run gen` wrote to src/generated/ (verify and dev run it; check, test and build do not). */
export async function readRenders(): Promise<Renders> {
  try {
    return JSON.parse(await readSiteText('src/generated/renders.json')) as Renders;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('src/generated/renders.json is missing: run "npm run gen" in website/ first', { cause: err });
    }
    throw err;
  }
}

/** The compiler imports two gitignored modules that the root's `prepare` (`npm run gen`) writes. */
export async function assertGenerated(): Promise<void> {
  for (const rel of ['src/shared/compiler/styles/styles.generated.ts', 'src/shared/compiler/emrProbe.generated.ts']) {
    try {
      await access(rootPath(rel));
    } catch {
      throw new Error(`${rel} is missing: run "npm ci" (or "npm run gen") at the repository root first`);
    }
  }
}
