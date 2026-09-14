/** Repository and site anchors for the build scripts and tests, plus the generated-module guard. */
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const ROOT = new URL('../../', import.meta.url);
export const SITE = new URL('../', import.meta.url);

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
