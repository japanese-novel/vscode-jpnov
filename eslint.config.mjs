import tseslint from 'typescript-eslint';

import { houseConfig } from './eslint.house.mjs';

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
    // may value-import it; shared + server stay vscode-free. `import type` is fine.
    files: ['src/server/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message:
                'vscode must not be value-imported in shared/server (type-only import type is fine)',
            },
          ],
        },
      ],
    },
  },
);
