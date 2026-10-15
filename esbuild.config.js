import { readFile } from 'node:fs/promises';

import * as esbuild from 'esbuild';

import { generateAll } from './scripts/gen.ts';
import { styleSourcePaths, writeStylesModule } from './scripts/gen-styles.ts';
import { webviewSourcePaths, writeWebviewModules } from './scripts/gen-webview.ts';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Regenerate every generated module up front (the same run as `npm run gen`) so every build
// (dev, prod, and watch's first pass) bundles fresh sources; the codegen plugins keep --watch
// rebuilds fresh thereafter. The webview bundle is minified in production so the packaged
// extension ships minified webview code. The grammar is no bundle input: VS Code reads it from
// syntaxes/, so a build only keeps it fresh.
await generateAll(production);

/** @type {import('esbuild').BuildOptions} */
const base = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  // The VS Code extension host (and the forked Node language server) run their own
  // bundled Node; the engines floor (VS Code ^1.131) bundles Node 24.
  target: 'node24',
  // `vscode` is injected into the client by the host at runtime and has no npm
  // package to bundle. (The server never imports it.)
  external: ['vscode'],
  sourcemap: production ? false : 'linked',
  minify: production,
  treeShaking: true,
  logLevel: 'info',
  // vscode-languageclient@10 / vscode-languageserver@10 ship CommonJS builds that
  // perform dynamic `require(...)`. ESM output has no global `require`, so recreate
  // it from import.meta.url — otherwise the bundles crash on first load with
  // "Dynamic require of … is not supported". Required for BOTH bundles.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
};

/**
 * Dictionary-backed lint rules are forbidden. If a dependency ever pulls a morphological
 * analyzer (kuromoji/kuromojin) or its IPADIC/MeCab dictionary into the SERVER bundle, fail the build
 * loudly here rather than silently shipping a ~15 MB dictionary. Scoped to the server build (the
 * one that hosts the lint engine).
 */
const kuromojiTripwire = {
  name: 'kuromoji-tripwire',
  /** @param {import('esbuild').PluginBuild} build */
  setup(build) {
    build.onResolve({ filter: /kuromoji|ipadic|mecab/ }, (args) => ({
      errors: [
        {
          text: `[kuromoji-tripwire] Dictionary deps are forbidden, but "${args.path}" was imported by "${args.importer}". Drop the offending rule.`,
        },
      ],
    }));
  },
};

/**
 * Re-runs the styles codegen when a fragment changes: loading the generated module registers
 * the authored `styles/*.css` files as watch dependencies, so in --watch a raw `.css` edit
 * regenerates `styles.generated.ts` and re-triggers the (server-only — the client bundle never
 * imports it) rebuild. Non-watch builds are covered by the up-front generateAll() call.
 * @type {import('esbuild').Plugin}
 */
const stylesCodegen = {
  name: 'styles-codegen',
  setup(build) {
    build.onLoad({ filter: /styles[/\\]styles\.generated\.ts$/ }, async (args) => {
      await writeStylesModule();
      return {
        contents: await readFile(args.path, 'utf8'),
        loader: 'ts',
        watchFiles: await styleSourcePaths(),
      };
    });
  },
};

/**
 * The browser-program counterpart of stylesCodegen: the IIFE-string bundles that
 * `book/webviewHtml.ts` / `preview/preview.ts` inline into their webviews and css.ts's
 * emrProbe() inlines into the paginated outputs. Loading any of the generated modules
 * re-runs the codegen (which bundles the browser TS via a nested esbuild) and registers the
 * browser sources as watch deps, so a `--watch` edit to a webview `.ts`/`.css` re-bundles and
 * re-triggers the dependent rebuild. Non-watch builds are covered by the up-front call above.
 * @type {import('esbuild').Plugin}
 */
const webviewCodegen = {
  name: 'webview-codegen',
  setup(build) {
    build.onLoad({ filter: /(?:webviewBundle|emrProbe)\.generated\.ts$/ }, async (args) => {
      // The up-front generateAll() already produced these; only --watch needs to re-run on a
      // source change (bundling the webview TS via nested esbuild is the costly step — skip it in
      // one-shot builds, where it would only re-bundle to an identical result).
      if (watch) {
        await writeWebviewModules(production);
      }
      return {
        contents: await readFile(args.path, 'utf8'),
        loader: 'ts',
        watchFiles: await webviewSourcePaths(),
      };
    });
  },
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    ...base,
    entryPoints: ['src/client/extension.ts'],
    outfile: 'dist/client/extension.js',
    plugins: [webviewCodegen],
  },
  {
    ...base,
    entryPoints: ['src/server/server.ts'],
    outfile: 'dist/server/server.js',
    plugins: [kuromojiTripwire, stylesCodegen],
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((opts) => esbuild.context(opts)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('[esbuild] watching both client + server for changes…');
} else {
  await Promise.all(builds.map((opts) => esbuild.build(opts)));
  console.log('[esbuild] build complete (client + server)');
}
