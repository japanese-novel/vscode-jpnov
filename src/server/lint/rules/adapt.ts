/**
 * Adapters that lift a pure {@link PreScan} character scanner into a per-line rule, so a scanner
 * written against plain text (dash, minus position, full-width spacing, the hygiene scans) needs
 * no walker knowledge.
 *
 * `viewScan` runs the scanner over a chosen VIEW of each line: the scanner sees prose adjacency
 * (elided markup invisible), and this adapter is the ONE place a view hit is converted to a fix —
 * only when every unit of the hit lies in the same {@link Piece} (source-contiguous) and the fix
 * would not delete a whole ruby base; otherwise the warning survives and the fix is dropped.
 *
 * `perPieceScan` runs the scanner over each piece alone: a run interrupted by markup is two runs,
 * not one (the dash rule's contract — parity is per rendered run), and a fix is safe by
 * construction.
 *
 * Relative imports only (native test loader); vscode-free.
 */
import type { PreScan } from '../prescan.ts';
import type { FixSpec, LineRule, LintLine, ProseView, RuleContext, SrcSpan } from '../types.ts';

/** The resolved `{ max }` of a threshold rule (`selectRules` guarantees the shape). */
export function maxOf(ctx: RuleContext): number {
  return typeof ctx.options === 'object' && 'max' in ctx.options ? ctx.options.max : Infinity;
}

/** The source span of a non-empty view hit `[a, b)`: anchored on the LAST included unit, so a hit
 *  ending at elided markup never bleeds across the gap. */
export function viewSpan(view: ProseView, a: number, b: number): SrcSpan {
  const start = view.units[a]?.src ?? 0;
  const last = view.units[Math.max(a, b - 1)];
  return { start, end: (last?.src ?? start) + 1 };
}

/** A replacement fix for view hit `[a, b)` iff every unit shares one piece and the fix does not
 *  delete a whole ruby base (the stranded ｜《…》 would print literally); undefined otherwise. */
export function viewFix(view: ProseView, a: number, b: number, text: string): FixSpec | undefined {
  const first = view.units[a];
  const piece = first?.piece ?? null;
  if (first === undefined || piece === null) {
    return undefined;
  }
  for (let k = a + 1; k < b; k += 1) {
    if (view.units[k]?.piece !== piece) {
      return undefined;
    }
  }
  const start = first.indexInPiece;
  const end = (view.units[b - 1]?.indexInPiece ?? start) + 1;
  if (text === '' && start === 0 && end === piece.text.length && piece.rubyBase) {
    return undefined;
  }
  return { replace: { piece, start, end }, text };
}

/** Lifts `scan` onto one view of every line (`'prose'` = both 地の文 and 台詞 with adjacency). */
export function viewScan(
  scan: PreScan,
  view: 'prose' | 'narration' | 'dialogue',
): (ctx: RuleContext) => LineRule {
  return (ctx) => ({
    line(l: LintLine): void {
      const v = l[view]();
      for (const hit of scan(v.text, ctx.options)) {
        const fix = hit.fix === undefined ? undefined : viewFix(v, hit.start, hit.end, hit.fix);
        ctx.report(viewSpan(v, hit.start, hit.end), {
          ...(hit.message === undefined ? {} : { message: hit.message }),
          ...(fix === undefined ? {} : { fix }),
        });
      }
    },
  });
}

/** Lifts `scan` onto each PIECE of every line alone (runs never cross markup; fixes are safe by
 *  construction). */
export function perPieceScan(scan: PreScan): (ctx: RuleContext) => LineRule {
  return (ctx) => ({
    line(l: LintLine): void {
      for (const piece of l.pieces) {
        for (const hit of scan(piece.text, ctx.options)) {
          const span = { start: piece.srcStart + hit.start, end: piece.srcStart + hit.end };
          ctx.report(span, {
            ...(hit.message === undefined ? {} : { message: hit.message }),
            ...(hit.fix === undefined
              ? {}
              : { fix: { replace: { piece, start: hit.start, end: hit.end }, text: hit.fix } }),
          });
        }
      }
    },
  });
}
