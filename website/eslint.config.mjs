import { houseConfig } from '../eslint.house.mjs';

// The site lints with the root's ESLint install (npm run in website/ has the root's bin on PATH)
// in the house config. .astro files are not linted here; `astro check` type-checks them.
export default houseConfig({
  tsconfigRootDir: import.meta.dirname,
  ignores: ['dist/', 'node_modules/', '.astro/', '.cache/', 'src/generated/'],
});
