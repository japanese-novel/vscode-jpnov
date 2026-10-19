# Client integration tests

These exercise the host-side client modules (`src/client/**`) against an in-memory
`vscode` mock (`_vscodeMock.ts`). They run in CI and locally via:

```sh
npm run test:integration
```

(together with the fs-fixture server suites `test/server/build.test.ts` /
`test/server/jpbook.test.ts`). The vscode-free client suites (`bookRename`, `documentSync`,
`editorIndent`, `editorWord`) live in plain `npm test` instead.

## How resolution works

Every test script passes `--import ./test/register.mjs`, which registers
`test/resolve-hooks.mjs`:

- `#/…` — Node's ESM loader rejects the `#/` prefix of the package.json `imports` map
  (`#/*` → `./src/*`), so the hook resolves those specifiers against `src/` itself.
- bare `vscode` — there is no installable `vscode` package (the extension host injects it
  at runtime; esbuild marks it `external`), so the hook resolves it to the inert
  `_vscodeShim.mjs`. The shim only satisfies resolution;
  `mock.module('vscode', { exports: buildVscode(state) })` layers the behavioral
  mock on top per test.

`extension.test.ts` loads the entry module, the one module that value-imports
`vscode-languageclient/node` (a CommonJS package that requires `vscode` on load). The suite
replaces that package through `mock.module('vscode-languageclient/node', …)` with a fake
client.

No `node_modules/` shim and no esbuild pre-bundling are needed; any suite can be run
directly as long as the register flag rides along:

```sh
node --import ./test/register.mjs --test --experimental-test-module-mocks "test/client/preview.test.ts"
```
