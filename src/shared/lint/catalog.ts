/**
 * The lint rule catalog — the SINGLE SOURCE OF TRUTH for every prose-lint rule.
 *
 * One {@link RuleMeta} row = one `(scope, id)` pair = one diagnostic code (`lint.<scope>.<id>`)
 * = one vscode setting key (`jpnov.lint.<scope>.<id>`). Everything else conforms to this list:
 *   - {@link LintCode} (and thus `MsgCode` in protocol.ts) is DERIVED from these rows, so adding a
 *     rule here extends the message union automatically — there is no hand-listed union to drift.
 *   - the server's rule selection (`select.ts`) filters these rows by the user's settings.
 *   - the server's rule implementations (`server/lint/modules.ts`) are keyed by `id` and checked
 *     against {@link CatalogId} with `Record<CatalogId, …>`, so a missing/extra impl fails to compile.
 *   - the package.json `contributes.configuration` block and its nls keys are asserted to match
 *     these rows by `test/shared/lint/config-codegen.test.ts`.
 *
 * A rule's {@link Scope} is where the USER toggles it and what the settings UI groups by; the
 * engine does not fan anything out — each rule implementation reads the view/flags it needs
 * (`common` implementations read the whole prose view, `narration`/`dialogue` ones the matching
 * form, `ruby` the 読み).
 *
 * Pure data, import-free. Rule MODULES live server-side only — this file never references them.
 */

/** Where the user toggles a rule: `common` applies to both 地の文 and セリフ; the engine's rule
 *  implementations self-select what they read (a prose view, line flags, the ruby readings). */
export type Scope = 'common' | 'narration' | 'dialogue' | 'ruby';

/**
 * One rule's static metadata. `kind` fixes the setting shape:
 *   - `boolean`   -> `jpnov.lint.…` is a `boolean` (default `false`).
 *   - `threshold` -> `jpnov.lint.…` is `integer | null` (default `null` = off); a number is clamped
 *     to `[min, max]`. `suggested` is the recommended value shown to the user (NOT a default).
 *   - `enum`      -> `jpnov.lint.…` is a string drop-down. `select.ts` keys enablement off the
 *     literal `'off'` member, at any position in `values`; a list without `'off'` is enabled on
 *     every member (the rule cannot be turned off).
 */
export interface RuleMeta {
  /** Unique WITHIN a scope; the tail of both the setting key and the diagnostic code. */
  readonly id: string;
  readonly scope: Scope;
  readonly kind: 'boolean' | 'threshold' | 'enum';
  /** Threshold rules only: inclusive clamp bounds + the recommended (non-default) value. */
  readonly min?: number;
  readonly max?: number;
  readonly suggested?: number;
  /** Enum rules only: the drop-down choices, in display order; an `'off'` member, when
   *  present, is the disabled state. */
  readonly values?: readonly string[];
  /** The package.json default. Omit for `false` (boolean) / `values[0]` (enum). */
  readonly default?: boolean | string;
}

/**
 * Every rule. `common` rules are global typography/structure checks meaningful in both 地の文
 * and セリフ; `narration`/`dialogue` rules are form-specific; the single `ruby` rule is a 3-way
 * drop-down.
 *
 * Every rule is a character-class scanner or a small state machine over the walker's lines
 * (`src/server/lint/`); none reads a dictionary or a word list.
 *
 * `as const satisfies …` keeps the literal `id`/`scope` types (so {@link LintCode} can derive the
 * exact code union) while still type-checking each row against {@link RuleMeta}.
 */
export const RULES = [
  { id: 'sentenceLength', scope: 'common', kind: 'threshold', min: 1, max: 1000, suggested: 100 },
  { id: 'maxTen', scope: 'common', kind: 'threshold', min: 1, max: 20, suggested: 3 },
  { id: 'maxKanjiRun', scope: 'common', kind: 'threshold', min: 1, max: 20, suggested: 6 },
  {
    id: 'dash',
    scope: 'common',
    kind: 'enum',
    // Mirrors DASH_MODES/DASH_BY_MODE (catalog.test.ts locks the pair; this file imports nothing).
    // No 'off': the glyph also drives typesetting, and a foreign dash renders untranslated — the
    // check must always run.
    values: ['emDash', 'horizontalBar', 'boxDrawing'],
    default: 'horizontalBar',
  },
  { id: 'ellipsis', scope: 'common', kind: 'boolean', default: true },
  { id: 'exclamationSpace', scope: 'common', kind: 'boolean', default: true },
  { id: 'exclamationRun', scope: 'common', kind: 'boolean' },
  { id: 'questionExclamationMarks', scope: 'common', kind: 'enum', values: ['off', 'fullWidth', 'tcy'], default: 'fullWidth' },
  { id: 'arabicDigits', scope: 'common', kind: 'threshold', min: 1, max: 10, suggested: 2 },
  { id: 'noTrailingSpace', scope: 'common', kind: 'boolean', default: true },
  { id: 'blankRun', scope: 'common', kind: 'threshold', min: 0, max: 20, suggested: 1 },
  { id: 'noUnmatchedPair', scope: 'common', kind: 'boolean', default: true },
  { id: 'noHankakuKana', scope: 'common', kind: 'boolean', default: true },
  { id: 'noNfd', scope: 'common', kind: 'boolean', default: true },
  { id: 'noZeroWidth', scope: 'common', kind: 'boolean', default: true },
  { id: 'noControlChar', scope: 'common', kind: 'boolean', default: true },
  { id: 'shiftJisSafe', scope: 'common', kind: 'boolean', default: true },
  { id: 'noHalfWidthSpace', scope: 'common', kind: 'boolean', default: true },
  { id: 'noStrayLetter', scope: 'common', kind: 'boolean' },
  { id: 'minusPosition', scope: 'common', kind: 'boolean' },
  { id: 'indent', scope: 'narration', kind: 'boolean', default: true },
  { id: 'endPeriod', scope: 'narration', kind: 'boolean', default: true },
  { id: 'closingPunct', scope: 'dialogue', kind: 'boolean', default: true },
  { id: 'noIndent', scope: 'dialogue', kind: 'boolean', default: true },
  { id: 'kana', scope: 'ruby', kind: 'enum', values: ['off', 'hiragana', 'katakana'] },
] as const satisfies readonly RuleMeta[];

/** Every `id` that appears in {@link RULES} (the keys `server/lint/modules.ts` must implement). */
export type CatalogId = (typeof RULES)[number]['id'];

/**
 * One rule row -> its diagnostic code. Written as a DISTRIBUTIVE conditional (naked `R`) so that,
 * applied to the union of rows, each row's `scope`/`id` stay PAIRED — a bare
 * `` `lint.${…['scope']}.${…['id']}` `` over the union would cross-product every scope with every id.
 */
type CodeOf<R> = R extends RuleMeta ? `lint.${R['scope']}.${R['id']}` : never;

/**
 * The exact set of diagnostic codes, derived from {@link RULES}. `MsgCode` in protocol.ts includes
 * this, so the message renderers stay exhaustive over exactly these codes and a rule added to the
 * catalog forces a new render arm to be added (or compilation fails).
 */
export type LintCode = CodeOf<(typeof RULES)[number]>;

/** Setting-key prefix; the only place the `jpnov.lint.` namespace is spelled. */
const SETTING_PREFIX = 'jpnov.lint.';

/** The vscode setting key for a rule, e.g. `jpnov.lint.common.maxTen`. */
export function settingKey(rule: RuleMeta): string {
  return `${SETTING_PREFIX}${rule.scope}.${rule.id}`;
}

/** The diagnostic code for a rule, e.g. `lint.common.maxTen` (always `settingKey` minus `jpnov.`). */
export function diagCode(rule: RuleMeta): LintCode {
  return `lint.${rule.scope}.${rule.id}` as LintCode;
}

/** Every setting key, in catalog order — the client reads exactly these to snapshot the config. */
export function allSettingKeys(): string[] {
  return RULES.map(settingKey);
}

/** The package.json default of a rule: `false`, `null` (off) or the first value unless the row says otherwise. */
export function ruleDefault(rule: RuleMeta): boolean | string | null {
  if (rule.kind === 'boolean') {
    return rule.default === true;
  }
  if (rule.kind === 'threshold') {
    return null;
  }
  return typeof rule.default === 'string' ? rule.default : (rule.values?.[0] ?? null);
}

/** Every setting at its shipped default: the wire map the client sends for untouched settings. */
export function shippedLintConfig(): Readonly<Record<string, boolean | string | null>> {
  return Object.fromEntries(RULES.map((rule) => [settingKey(rule), ruleDefault(rule)]));
}
