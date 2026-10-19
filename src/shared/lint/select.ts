/**
 * Resolves the user's raw lint settings into the enabled-only {@link RuleSelection} the server acts
 * on. This is the ONE place enablement, threshold clamping, option normalization, and code
 * derivation happen — `server/lint/engine.ts` only reads the result (it re-filters nothing).
 *
 * It consumes the {@link RULES} catalog and the wire config type and references no rule module;
 * the rule MODULE join happens later, keyed by {@link ActiveRule.id}.
 */
import type { RawLintConfigWire } from '../protocol.ts';
import { clampInt } from '../utils/numbers.ts';

import { RULES, diagCode, settingKey } from './catalog.ts';
import type { CatalogId, LintCode } from './catalog.ts';

/**
 * One enabled rule, ready for the engine. `options` is normalized: booleans -> `true`; thresholds
 * -> `{ max }` (already clamped); enums -> `{ mode }` (the chosen non-off value). Every threshold
 * rule reads `options.max` directly, so no per-rule option-key adapter is needed.
 */
export interface ActiveRule {
  /** Catalog id; the key into `RULE_IMPL`. */
  readonly id: CatalogId;
  /** Normalized options: `true` (boolean), `{ max }` (threshold), or `{ mode }` (enum). */
  readonly options: true | { readonly max: number } | { readonly mode: string };
  /** The diagnostic code stamped on every message this rule produces. */
  readonly code: LintCode;
}

/** The `mode` of an enum rule's options; undefined for any other kind. */
export function modeOf(options: ActiveRule['options']): string | undefined {
  return typeof options === 'object' && 'mode' in options ? options.mode : undefined;
}

/** The enabled rules, in catalog order. */
export type RuleSelection = readonly ActiveRule[];

/**
 * Filters {@link RULES} to the rules the user has enabled in `raw`, producing one
 * {@link ActiveRule} per enabled row. A boolean rule is enabled iff its key is exactly `true`; a
 * threshold rule is enabled iff its key is a finite number (then clamped to the rule's bounds).
 * Absent / `null` / wrong-typed values leave a rule OFF; this reads only `raw`, so the shipped
 * on/off split lives entirely in the package.json defaults.
 */
export function selectRules(raw: RawLintConfigWire): RuleSelection {
  const out: ActiveRule[] = [];
  for (const rule of RULES) {
    const value = raw[settingKey(rule)];
    let options: ActiveRule['options'] | undefined;
    if (rule.kind === 'boolean') {
      if (value === true) {
        options = true;
      }
    } else if (rule.kind === 'threshold') {
      if (typeof value === 'number' && Number.isFinite(value)) {
        // A threshold rule always carries min/max in the catalog (enforced by `as const satisfies`).
        options = { max: clampInt(value, rule.min, rule.max) };
      }
    } else {
      // enum: enabled on any member other than 'off' — the spelling client/lintConfig.ts also drops.
      const values: readonly string[] = rule.values;
      if (typeof value === 'string' && value !== 'off' && values.includes(value)) {
        options = { mode: value };
      }
    }
    if (options !== undefined) {
      out.push({ id: rule.id, options, code: diagCode(rule) });
    }
  }
  return out;
}

/** True when no rule is enabled — the server's fast path skips the document walk entirely. */
export function isSelectionEmpty(selection: RuleSelection): boolean {
  return selection.length === 0;
}
