/**
 * Locks the shipped lint experience: with no user overrides, exactly the data-hygiene rules, the
 * ダッシュ rule, and the five format rules run; every other rule is off. Drives the real `selectRules`
 * with the catalog's shipped defaults (package.json carries the same values: config-codegen.test.ts
 * holds it to the catalog), so a flipped default or a mis-scoped rule fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shippedLintConfig } from '../../../src/shared/lint/catalog.ts';
import { selectRules } from '../../../src/shared/lint/select.ts';

test('shipped defaults enable exactly the hygiene rules, ダッシュ, and the format rules', () => {
  const selection = selectRules(shippedLintConfig());
  // Alphabetically sorted; the format rules (ellipsis, exclamationSpace, questionExclamationMarks, indent,
  // endPeriod, closingPunct, noIndent), the bracket matcher and the full-width space rule ship ON — the
  // discrete successors of the retired general-novel-style bundle plus the 和文 conventions ruled
  // default-worthy.
  const shipped = [
    'lint.common.dash',
    'lint.common.ellipsis',
    'lint.common.exclamationSpace',
    'lint.common.noControlChar',
    'lint.common.noHalfWidthSpace',
    'lint.common.noHankakuKana',
    'lint.common.noNfd',
    'lint.common.noTrailingSpace',
    'lint.common.noUnmatchedPair',
    'lint.common.noZeroWidth',
    'lint.common.questionExclamationMarks',
    'lint.common.shiftJisSafe',
    'lint.dialogue.closingPunct',
    'lint.dialogue.noIndent',
    'lint.narration.endPeriod',
    'lint.narration.indent',
  ];
  assert.deepEqual(selection.map((r) => r.code).sort(), shipped);
});
