// The house lint shared by the root and website configs: typescript-eslint strict + stylistic
// (type-aware), @stylistic's customize() with the options below, the pinned rules, node:test's
// floating `test()` allowance, and no type-aware rules for plain JS. A consumer passes its
// tsconfig root and ignores and appends its own.
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export const STYLE = {
  indent: 2,
  quotes: 'single',
  semi: true,
  arrowParens: true,
  braceStyle: '1tbs',
  quoteProps: 'as-needed',
  commaDangle: 'always-multiline',
  jsx: false,
};

// Pinned regardless of customize() contents so plugin upgrades can't drift these.
export const PINNED_RULES = {
  // Single quotes, with exactly one escape hatch: a string containing a single quote may be
  // double-quoted ("couldn't"). Backticks only where template features are actually used.
  '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'never' }],
  '@stylistic/object-curly-spacing': ['error', 'always'],
  '@stylistic/space-in-parens': ['error', 'never'],
  '@stylistic/function-call-spacing': ['error', 'never'],
  '@stylistic/array-bracket-spacing': ['error', 'never'],
  '@stylistic/computed-property-spacing': ['error', 'never'],
  '@stylistic/space-before-function-paren': ['error', { anonymous: 'always', named: 'never', asyncArrow: 'always' }],
  '@stylistic/no-multi-spaces': 'error',
  '@stylistic/no-trailing-spaces': 'error',
  '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 0 }],
  '@stylistic/eol-last': ['error', 'always'],
  '@stylistic/semi-spacing': 'error',
  '@stylistic/switch-colon-spacing': 'error',
  // Wrapped binary chains use a hanging indent (+1 level, Prettier-style); the rule wants them flat.
  '@stylistic/indent-binary-ops': 'off',
  // ?/: and type-union | lead the next line; && || + trail. Matches the whole repo.
  '@stylistic/operator-linebreak': ['error', 'after', { overrides: { '?': 'before', ':': 'before', '|': 'before' } }],
};

/** The shared flat config; the returned array is ready to export or to extend. */
export function houseConfig({ tsconfigRootDir, ignores }) {
  return tseslint.config(
    { ignores },
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    stylistic.configs.customize(STYLE),
    { rules: PINNED_RULES },
    {
      files: ['**/*.ts'],
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
    },
    {
      // node:test's top-level `test()` returns a promise tracked by the runner;
      // not awaiting it is the intended, safe pattern.
      files: ['test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-floating-promises': 'off',
      },
    },
    {
      // Config/build scripts are plain JS outside the TS program — no type-aware rules.
      files: ['**/*.{js,mjs,cjs}'],
      ...tseslint.configs.disableTypeChecked,
    },
  );
}
