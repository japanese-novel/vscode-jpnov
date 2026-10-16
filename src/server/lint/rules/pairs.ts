/**
 * 括弧の対応 — a deterministic document-level bracket matcher. Openers push, closers pop; a
 * closer that skips openers reports the SKIPPED openers (they are the unclosed ones); a closer
 * with no matching opener reports itself; whatever is still open at EOF reports at its opener.
 * ASCII quotes stay out of the pair set — the open and close glyphs are identical, so pairing
 * them can only be guessed.
 *
 * A matched 《》 pair in prose is a base-less reading (the Scanner keeps it literal and reports
 * syntax.rubyBaseMissing) and balances here. An unmatched prose 《 or 》 is
 * always a broken ruby — flagging it here is the feature.
 *
 * Relative imports only (native test loader); vscode-free.
 */
import { charClass } from '../../../shared/utils/regex.ts';

import type { LineRule, LintLine, RuleContext } from '../types.ts';

const PAIRS: Readonly<Record<string, string>> = {
  '「': '」',
  '『': '』',
  '（': '）',
  '(': ')',
  '【': '】',
  '〈': '〉',
  '《': '》',
  '［': '］',
};
const CLOSERS = new Set(Object.values(PAIRS));
/** Every opener and closer (each one UTF-16 unit): the one scan over a line's prose. */
const BRACKETS = new RegExp(`[${charClass([...Object.keys(PAIRS), ...CLOSERS])}]`, 'g');

export function noUnmatchedPairRule(ctx: RuleContext): LineRule {
  const open: { readonly expected: string; readonly src: number }[] = [];
  // How many of `open` await each closer: a dangling closer is known in one step, and the walk
  // down the stack below runs only when it ends in a match that removes what it passed.
  const awaiting = new Map<string, number>();
  const count = (closer: string, by: number): void => {
    awaiting.set(closer, (awaiting.get(closer) ?? 0) + by);
  };
  return {
    line(line: LintLine): void {
      const v = line.prose();
      for (const m of v.text.matchAll(BRACKETS)) {
        const src = v.units[m.index]?.src;
        if (src === undefined) {
          continue;
        }
        const ch = m[0];
        const expected = PAIRS[ch];
        if (expected !== undefined) {
          open.push({ expected, src });
          count(expected, 1);
          continue;
        }
        if (!CLOSERS.has(ch)) {
          continue;
        }
        if ((awaiting.get(ch) ?? 0) === 0) {
          ctx.report({ start: src, end: src + 1 }); // dangling closer
          continue;
        }
        let at = open.length - 1;
        while (open[at]?.expected !== ch) {
          at -= 1;
        }
        for (const o of open.splice(at)) {
          count(o.expected, -1);
          if (o.expected !== ch) {
            ctx.report({ start: o.src, end: o.src + 1 }); // unclosed inner opener, skipped
          }
        }
      }
    },
    end(): void {
      for (const o of open) {
        ctx.report({ start: o.src, end: o.src + 1 });
      }
    },
  };
}
