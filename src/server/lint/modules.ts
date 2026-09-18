/**
 * Binds each catalog rule id to HOW it runs: a `line` rule (a per-document {@link LineRule}
 * instance fed every {@link LintLine} by the engine) or a `raw` scan over the document source.
 *
 * `satisfies Record<CatalogId, RuleImpl>` makes the catalog and the implementations a compile-time
 * pair: a rule added to `catalog.ts` without an entry here (or vice-versa) fails to build.
 * Character-class scanners are lifted through the adapters in rules/adapt.ts; everything else is a
 * hand-written factory in rules/.
 *
 * Relative imports only (native test loader); vscode-free.
 */
import type { CatalogId } from '../../shared/lint/catalog.ts';

import { dashScan, fullWidthSpaceScan, minusPositionScan, shiftJisSafeScan } from './prescan.ts';
import type { PreScan } from './prescan.ts';
import { perPieceScan, viewScan } from './rules/adapt.ts';
import {
  controlCharRule,
  hankakuKanaRule,
  nfdRule,
  rubyKanaRule,
  unnaturalAlphabetRule,
  zeroWidthRule,
} from './rules/chars.ts';
import {
  blankRunRule,
  closingPunctRule,
  ellipsisRule,
  endPeriodRule,
  exclamationRunRule,
  exclamationSpaceRule,
  indentRule,
  noIndentRule,
  trailingSpaceRule,
} from './rules/format.ts';
import {
  arabicDigitsRule,
  maxKanjiRunRule,
  maxTenRule,
  sentenceLengthRule,
} from './rules/metrics.ts';
import { noUnmatchedPairRule } from './rules/pairs.ts';
import type { LineRule, RuleContext } from './types.ts';

/**
 * How a rule executes:
 *  - `line` — `create(ctx)` yields a per-document instance fed every line, then `end()`. Cross-line
 *             state lives in the factory's closure; the engine re-instantiates per run.
 *  - `raw`  — a pure scanner over the DOCUMENT SOURCE, run once per document. For rules that must
 *             see what the prose views drop (annotation interiors — a 左ルビ reading appears in no
 *             view but reaches a built `.txt` verbatim); a `line` rule can read `LintLine.raw`
 *             for that too.
 */
export type RuleImpl =
  | { readonly kind: 'line'; readonly create: (ctx: RuleContext) => LineRule }
  | { readonly kind: 'raw'; readonly scan: PreScan };

function line(create: (ctx: RuleContext) => LineRule): RuleImpl {
  return { kind: 'line', create };
}

/** Catalog id -> implementation. The `Record<CatalogId, …>` type requires exactly the catalog ids
 *  (a missing/extra impl fails to compile). */
export const RULE_IMPL: Record<CatalogId, RuleImpl> = {
  sentenceLength: line(sentenceLengthRule),
  maxTen: line(maxTenRule),
  maxKanjiRun: line(maxKanjiRunRule),
  // Per PIECE: a dash run interrupted by markup is two runs, not one — parity per rendered run.
  dash: line(perPieceScan(dashScan)),
  ellipsis: line(ellipsisRule),
  exclamationSpace: line(exclamationSpaceRule),
  exclamationRun: line(exclamationRunRule),
  arabicDigits: line(arabicDigitsRule),
  noTrailingSpace: line(trailingSpaceRule),
  blankRun: line(blankRunRule),
  noUnmatchedPair: line(noUnmatchedPairRule),
  noHankakuKana: line(hankakuKanaRule),
  noNfd: line(nfdRule),
  noZeroWidth: line(zeroWidthRule),
  noControlChar: line(controlCharRule),
  shiftJisSafe: { kind: 'raw', scan: shiftJisSafeScan },
  jaNoSpaceBetweenFullWidth: line(viewScan(fullWidthSpaceScan, 'prose')),
  jaUnnaturalAlphabet: line(unnaturalAlphabetRule),
  minusPosition: line(viewScan(minusPositionScan, 'prose')),
  indent: line(indentRule),
  endPeriod: line(endPeriodRule),
  closingPunct: line(closingPunctRule),
  noIndent: line(noIndentRule),
  kana: line(rubyKanaRule),
};
