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
  const first = view.unit(a);
  const last = view.unit(Math.max(a, b - 1));
  const start = first?.src ?? 0;
  return { start, end: last?.end ?? start };
}

/** The units `[k, j)` of one carrier, as the one source span a deletion takes them in, or
 *  undefined: a ［＃○字下げ］ goes whole or not at all, a ruby or a 縦中横 never whole (the stranded
 *  markup would print literally), typed units in place and flush with each other. `whole` says
 *  the view holds no other unit of the carrier. */
function takes(view: ProseView, k: number, j: number, whole: boolean): Span | undefined {
  const first = view.unit(k);
  const carrier = first?.carrier ?? null;
  if (first === undefined || carrier === null) {
    return undefined;
  }
  if (carrier.kind === 'indent') {
    return whole ? { start: carrier.src, end: carrier.end } : undefined;
  }
  if (carrier.kind === 'cell' && whole) {
    return undefined;
  }
  let at = first.src;
  for (let i = k; i < j; i += 1) {
    const unit = view.unit(i);
    if (unit?.piece == null || unit.src !== at) {
      return undefined;
    }
    at = unit.end;
  }
  return { start: first.src, end: at };
}

/** The units of the carrier of unit `k` on either side of it, within `[a, b)`: `[from, to)`, and whether that is the carrier whole. */
function carrierRun(view: ProseView, a: number, b: number, k: number): { from: number; to: number; whole: boolean } {
  const carrier = view.unit(k)?.carrier;
  let from = k;
  while (from > a && view.unit(from - 1)?.carrier === carrier) {
    from -= 1;
  }
  let to = k + 1;
  while (to < b && view.unit(to)?.carrier === carrier) {
    to += 1;
  }
  return { from, to, whole: view.unit(from - 1)?.carrier !== carrier && view.unit(to)?.carrier !== carrier };
}

/** A deletion of view hit `[a, b)` as one source span, or undefined (see the module header). */
function erase(view: ProseView, a: number, b: number): FixSpec | undefined {
  const first = view.unit(a);
  if (first === undefined) {
    return undefined;
  }
  let at = first.src;
  for (let k = a; k < b;) {
    const { to, whole } = carrierRun(view, a, b, k);
    const span = takes(view, k, to, whole);
    if (span?.start !== at) {
      return undefined;
    }
    at = span.end;
    k = to;
  }
  return { erase: { start: first.src, end: at } };
}

/** The smallest `j` in `[a, b]` such that the view hit `[j, b)` is one deletion as {@link erase}
 *  allows it: back from `b` one carrier at a time, so a run that straddles markup yields its tail. */
export function erasableFrom(view: ProseView, a: number, b: number): number {
  const last = view.unit(b - 1);
  if (last === undefined) {
    return b;
  }
  let j = b;
  let at = last.end;
  while (j > a) {
    const { from, whole } = carrierRun(view, a, b, j - 1);
    const span = takes(view, from, j, whole);
    if (span?.end !== at) {
      break;
    }
    at = span.start;
    j = from;
  }
  return j;
}

/** A fix for view hit `[a, b)`: a replacement iff every unit shares one piece; a deletion as {@link erase} allows it. */
export function viewFix(view: ProseView, a: number, b: number, text: string): FixSpec | undefined {
  if (text === '') {
    return erase(view, a, b);
  }
  const first = view.unit(a);
  const last = view.unit(b - 1);
  const piece = first?.piece ?? null;
  if (first === undefined || last === undefined || piece === null) {
    return undefined;
  }
  for (let k = a + 1; k < b; k += 1) {
    if (view.unit(k)?.piece !== piece) {
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
