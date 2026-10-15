/** Repo-root anchor + raw-file reader shared by the packaging/manifest guard tests. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Repository root as a URL base: resolve with `new URL(rel, REPO_ROOT)`. */
export const REPO_ROOT = new URL('../../', import.meta.url);

export function readRepoFile(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, REPO_ROOT)), 'utf8');
}

export type Scripts = Readonly<Record<string, string | undefined>>;

/** The `scripts` of package.json, for the tests that hold them to a convention. */
export function readPackageScripts(): Scripts {
  const pkg = JSON.parse(readRepoFile('package.json')) as { readonly scripts?: Scripts };
  return pkg.scripts ?? {};
}
