/**
 * Adapters that lift a pure {@link PreScan} character scanner into a per-line rule, so a scanner
 * written against plain text (dash, minus position, full-width spacing, the hygiene scans) needs
 * no walker knowledge.
 *
 * `viewScan` runs the scanner over a chosen VIEW of each line: the scanner sees prose adjacency
 * (elided markup invisible), and this adapter is the ONE place a view hit is converted to a fix —
 * a replacement only when every unit of the hit lies in the same {@link Piece}; a deletion also
 * over a stretch of typed units and whole ［＃○字下げ］ annotations that is one in the source,
 * unless it would empty a ruby or a 縦中横 (the stranded markup would print literally); otherwise
 * the warning survives and the fix is dropped.
 *
 * `perPieceScan` runs the scanner over each piece alone: a run interrupted by markup is two runs,
 * not one (the dash rule's contract — parity is per rendered run), and a fix is safe by
 * construction.
 */
import type { PreScan } from '../prescan.ts';
import type { Span } from '../../../shared/ast/nodes.ts';

import type { FixSpec, LineRule, LintLine, ProseView, RuleContext } from '../types.ts';

/** The resolved `{ max }` of a threshold rule (`selectRules` guarantees the shape). */
export function maxOf(ctx: RuleContext): number {
  return typeof ctx.options === 'object' && 'max' in ctx.options ? ctx.options.max : Infinity;
}

/** The source span of a non-empty view hit `[a, b)`: from where its first unit was written to
 *  where its last one ends, so a hit ending at elided markup never bleeds across the gap. */
export function viewSpan(view: ProseView, a: number, b: number): Span {
  const first = view.units[a];
  const last = view.units[Math.max(a, b - 1)];
  const start = first?.src ?? 0;
  return { start, end: last?.end ?? start };
}

/** A deletion of view hit `[a, b)` as one source span, or undefined (see the module header). */
function erase(view: ProseView, a: number, b: number): FixSpec | undefined {
  const first = view.units[a];
  if (first === undefined) {
    return undefined;
  }
  let at = first.src;
  for (let k = a; k < b;) {
    const carrier = view.units[k]?.carrier ?? null;
    if (carrier === null) {
      return undefined;
    }
    let j = k; // past the hit's last unit of this carrier
    while (j < b && view.units[j]?.carrier === carrier) {
      j += 1;
    }
    // The hit holds the carrier whole: its first unit and its last.
    const whole = view.units[k - 1]?.carrier !== carrier && view.units[j]?.carrier !== carrier;
    if (carrier.kind === 'indent') {
      if (!whole || carrier.src !== at) {
        return undefined; // the annotation goes whole or not at all
      }
      at = carrier.end;
    } else if (carrier.kind === 'cell' && whole) {
      return undefined; // the stranded markup would print literally
    } else {
      for (; k < j; k += 1) {
        const unit = view.units[k];
        if (unit?.piece == null || unit.src !== at) {
          return undefined;
        }
        at = unit.end;
      }
    }
    k = j;
  }
  return { erase: { start: first.src, end: at } };
}

/** A fix for view hit `[a, b)`: a replacement iff every unit shares one piece; a deletion as {@link erase} allows it. */
export function viewFix(view: ProseView, a: number, b: number, text: string): FixSpec | undefined {
  if (text === '') {
    return erase(view, a, b);
  }
  const first = view.units[a];
  const last = view.units[b - 1];
  const piece = first?.piece ?? null;
  if (first === undefined || last === undefined || piece === null) {
    return undefined;
  }
  for (let k = a + 1; k < b; k += 1) {
    if (view.units[k]?.piece !== piece) {
      return undefined;
    }
  }
  return { replace: { slice: piece, start: first.src - piece.srcStart, end: last.end - piece.srcStart }, text };
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
              : { fix: { replace: { slice: piece, start: hit.start, end: hit.end }, text: hit.fix } }),
          });
        }
      }
    },
  });
}
