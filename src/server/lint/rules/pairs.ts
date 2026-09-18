/**
 * 括弧の対応 — a deterministic document-level bracket matcher. Openers push, closers pop; a
 * closer that skips openers reports the SKIPPED openers (they are the unclosed ones); a closer
 * with no matching opener reports itself; whatever is still open at EOF reports at its opener.
 * ASCII quotes stay out of the pair set — the open and close glyphs are identical, so pairing
 * them can only be guessed.
 *
 * A matched 《》 pair in prose is a base-less reading (the tokenizer keeps it literal; the syntax
 * layer warns with syntax.rubyBaseMissing) and balances here. An unmatched prose 《 or 》 is
 * always a broken ruby — flagging it here is the feature.
 *
 * Relative imports only (native test loader); vscode-free.
 */
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

export function noUnmatchedPairRule(ctx: RuleContext): LineRule {
  const open: { readonly expected: string; readonly src: number }[] = [];
  return {
    line(line: LintLine): void {
      const v = line.prose();
      for (let k = 0; k < v.text.length; k += 1) {
        const unit = v.units[k];
        const src = unit?.piece === null ? undefined : unit?.src;
        if (src === undefined) {
          continue; // a synthetic unit (〇 sentinel / separator) is never a bracket
        }
        const ch = v.text.charAt(k);
        const expected = PAIRS[ch];
        if (expected !== undefined) {
          open.push({ expected, src });
          continue;
        }
        if (!CLOSERS.has(ch)) {
          continue;
        }
        let at = -1;
        for (let d = open.length - 1; d >= 0; d -= 1) {
          if (open[d]?.expected === ch) {
            at = d;
            break;
          }
        }
        if (at === -1) {
          ctx.report({ start: src, end: src + 1 }); // dangling closer
          continue;
        }
        for (const skipped of open.splice(at + 1)) {
          ctx.report({ start: skipped.src, end: skipped.src + 1 }); // unclosed inner opener
        }
        open.pop();
      }
    },
    end(): void {
      for (const o of open) {
        ctx.report({ start: o.src, end: o.src + 1 });
      }
    },
  };
}
