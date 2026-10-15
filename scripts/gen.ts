/**
 * Runs the three generators (`gen-styles.ts`, `gen-webview.ts`, `gen-grammar.ts`) in one go.
 * `npm run gen` and every esbuild build call it; the scripts that read `src/` reach it through
 * their `pre*` hooks (test/shared/packaging/gen-scripts.test.ts holds them to that).
 */
import { pathToFileURL } from 'node:url';

import { writeGrammar } from './gen-grammar.ts';
import { writeStylesModule } from './gen-styles.ts';
import { writeWebviewModules } from './gen-webview.ts';

/** Regenerates everything; returns whether any output changed. The generators do not read one another's output. */
export async function generateAll(production = false): Promise<boolean> {
  const styles = await writeStylesModule();
  const webview = await writeWebviewModules(production);
  const grammar = await writeGrammar();
  return styles || webview || grammar;
}

// CLI: `node scripts/gen.ts` (via `npm run gen`), not when esbuild.config.js imports this. Non-minified
// webview bundles — the production build re-runs generateAll(true) up front, so the packaged ones are minified.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateAll().then((changed) => {
    console.log(changed ? 'regenerated generated modules' : 'up to date: generated modules');
  }).catch((err: unknown) => {
    console.error('error generating modules:', err);
    process.exit(1);
  });
}
