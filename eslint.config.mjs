import tseslint from 'typescript-eslint';

import { houseConfig } from './eslint.house.mjs';

/** `n` steps of `../`, as regex source. */
const climbs = (n) => `(?:\\.\\./){${String(n)}}`;

/**
 * What a webview file `climb` folders below src/client may import, as regex alternatives: the
 * files of its own folder up to the webview root, the contract at src/client, the utils leaf at src/.
 */
const webviewImports = (climb) =>
  [
    '\\./[^/]+\\.ts',
    ...Array.from({ length: climb - 1 }, (_, i) => `${climbs(i + 1)}[^/]+\\.ts`),
    `${climbs(climb)}protocol\\.ts`,
    `${climbs(climb + 1)}shared/utils/[^/]+\\.ts`,
  ].join('|');

export default tseslint.config(
  ...houseConfig({
    tsconfigRootDir: import.meta.dirname,
    // Generated modules (gitignored, produced by `npm run gen`) are machine-written string
    // blobs — never hand-edited, so never linted (the JSON-encoded bundles use double quotes).
    // website/ is its own npm project with its own ESLint config (website/eslint.config.mjs).
    ignores: ['dist/', 'node_modules/', '**/*.vsix', '.scratch/', '**/*.generated.ts', 'media/codicon/', 'website/'],
  }),
  {
    // A leaked value-import of `vscode` crashes the forked Node language server
    // (there is no `vscode` module outside the extension host). Only src/client/**
    // may import it; shared + server import nothing from it, `import type` included.
    // The AST is read through its front doors; what it is built with stays inside it.
    files: ['src/server/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message: 'vscode must not be imported in shared/server, `import type` included',
            },
          ],
          patterns: [
            {
              regex: '/ast/(cells|classify|parts)\\.ts$',
              message: 'internal to src/shared/ast: read the AST through nodes, notation, scan, resolve, parse, print or span',
            },
          ],
        },
      ],
    },
  },
  {
    // The AST is a layer of its own: an allow-list of its own modules, ../chars.ts and the utils
    // leaf. This block replaces the one above for these files (vscode is outside the list).
    files: ['src/shared/ast/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!(?:\\./[^/]+|\\.\\./chars\\.ts|\\.\\./utils/[^/]+\\.ts)$)',
              message: 'src/shared/ast may import only ../chars.ts, ../utils/<file>.ts and its own modules',
            },
          ],
        },
      ],
    },
  },
  {
    // The leaves: the character tables the AST stands on, and the helpers that know nothing of the
    // notation, the manifest, the settings or the wire (not a stage, the leaf under every stage).
    // Each imports nothing, utils' own files included, so every program may read them, the
    // webviews among them.
    files: ['src/shared/chars.ts', 'src/shared/utils/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '.', message: 'a leaf of src/shared: chars.ts and utils/ import nothing' }] },
      ],
    },
  },
  {
    // A chapter inside a nested workspace folder would come back relative to that folder.
    files: ['src/client/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'asRelativePath',
          message: 'It counts from the workspace folder of the file; a book entry counts from the directory of its .jpbook (BookEntry.uri).',
        },
      ],
    },
  },
  // The blocks below use the typescript-eslint rule: it adds to the blocks above, where a
  // second `no-restricted-imports` block would replace them.
  {
    // The preview (server.ts) and the builds (build.ts) alone reach the rows: the editor side
    // reads the nodes and the AST.
    files: ['src/server/**/*.ts'],
    ignores: ['src/server/server.ts', 'src/server/build.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '/shared/compiler/',
              message: 'in src/server only server.ts and build.ts may import src/shared/compiler',
            },
          ],
        },
      ],
    },
  },
  {
    // Output takes a book in its own shape: it knows neither the manifest, the wire nor a program.
    files: ['src/shared/compiler/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)(book|server|client)/|(^|/)protocol\\.ts$',
              message: 'src/shared/compiler may not import src/shared/book, protocol.ts, src/server or src/client',
            },
          ],
        },
      ],
    },
  },
  // A webview is a program of its own: an allow-list of its folder, the types of the host's
  // contract, and the utils leaf. A relative import says how far it climbs, so each depth of the
  // folder has its own list: `climb` reaches src/client, one more reaches src/.
  ...[
    { files: 'src/client/webview/*.ts', climb: 1 },
    { files: 'src/client/webview/*/*.ts', climb: 2 },
  ].map(({ files, climb }) => ({
    files: [files],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: `^(?!(?:${webviewImports(climb)})$)`,
              message: 'a webview may import only its own folder, src/shared/utils and the types of src/client/protocol.ts',
            },
            {
              // The rule lets a type import that matches this pattern pass the one above too,
              // so it names the contract alone.
              regex: `^${climbs(climb)}protocol\\.ts$`,
              allowTypeImports: true,
              message: 'a webview takes only types from src/client/protocol.ts',
            },
          ],
        },
      ],
    },
  })),
);
