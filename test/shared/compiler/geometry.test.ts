/**
 * fitPaper: the paper-fit math behind the build's `@page`/font-size/border emission. No
 * pinned output values — the geometry constants are tuning knobs, so the sweep locks
 * behavior derived from their current values: the font is the largest 0.001mm quantum
 * that fits both axes, the block inset holds the PRINT_MARGIN surround with its slack
 * inside the 0.02–0.04em emission guard band, the physical top/bottom margins (the bare
 * insets — the bands are content inside them) hold the MARGIN_MM floors, and the border
 * box never leaves the paper. The emitted string formats are locked in css.test.ts from
 * this same fit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PaperFit } from '../../../src/shared/compiler/geometry.ts';
import {
  FOOTER_BAND,
  HEADER_BAND,
  LINENUM_BAND,
  MARGIN_MM,
  PAPER_ORIENTATIONS,
  PAPER_SIZES,
  PRINT_MARGIN,
  SIDE_PAD,
  fitPaper,
} from '../../../src/shared/compiler/geometry.ts';
import { LINE_PITCHES } from '../../../src/shared/config/types.ts';

test('auto orientation follows linesPerPage > charsPerLine / 2, strictly', () => {
  const at = (charsPerLine: number, linesPerPage: number): PaperFit =>
    fitPaper({ charsPerLine, linesPerPage, linePitch: 2, hTop: HEADER_BAND, size: 'a4', orientation: 'auto' });
  assert.deepEqual([at(40, 21).widthMm, at(40, 21).heightMm], [297, 210], '21 > 20 → landscape');
  assert.deepEqual([at(40, 20).widthMm, at(40, 20).heightMm], [210, 297], '20 > 20 is false → portrait');
  assert.deepEqual([at(33, 17).widthMm, at(33, 17).heightMm], [297, 210], '17 > 16.5 → landscape');
});

test('fit invariants hold over the whole settings domain', () => {
  const EPS = 1e-9;
  for (const linePitch of LINE_PITCHES) {
    for (let charsPerLine = 16; charsPerLine <= 64; charsPerLine++) {
      for (let linesPerPage = 16; linesPerPage <= 64; linesPerPage++) {
        for (const size of PAPER_SIZES) {
          for (const orientation of PAPER_ORIENTATIONS) {
            for (const hTop of [HEADER_BAND, HEADER_BAND + LINENUM_BAND]) {
              const fit = fitPaper({ charsPerLine, linesPerPage, linePitch, hTop, size, orientation });
              const label = `${String(charsPerLine)}x${String(linesPerPage)}@${String(linePitch)}/hTop${String(hTop)} on ${size}/${orientation}`;
              const sheetBlockEm = linesPerPage * linePitch + 2 * SIDE_PAD;
              const sheetInlineEm = charsPerLine + hTop + FOOTER_BAND;
              const floor = MARGIN_MM[size];
              // The font is MAXIMAL at its 0.001mm quantum: any larger and the sheet would
              // break the block PRINT_MARGIN surround or the inline MARGIN_MM floors.
              const capMm = Math.min(
                fit.widthMm / (sheetBlockEm + 2 * PRINT_MARGIN),
                (fit.heightMm - floor.top - floor.bottom) / sheetInlineEm,
              );
              assert.ok(fit.fontMm > 0, `${label}: fontMm must be positive`);
              assert.ok(fit.fontMm <= capMm + EPS, `${label}: font ${String(fit.fontMm)}mm over the fit cap`);
              assert.ok(fit.fontMm + 0.001 > capMm - EPS, `${label}: font ${String(fit.fontMm)}mm not maximal`);
              // Block axis: the em floor, and slack within the emission guard band
              // [0.02, 0.04) — never overflowing, never wasting more than the guard.
              assert.ok(
                fit.insetBlockEm >= PRINT_MARGIN - 0.02 - EPS,
                `${label}: block inset ${String(fit.insetBlockEm)}em under the PRINT_MARGIN floor`,
              );
              const blockSlackEm = fit.widthMm / fit.fontMm - (sheetBlockEm + 2 * fit.insetBlockEm);
              assert.ok(
                blockSlackEm >= 0.02 - EPS && blockSlackEm < 0.04 + EPS,
                `${label}: block slack ${String(blockSlackEm)}em outside the guard band`,
              );
              // Inline axis: each physical margin (the bare inset — the bands are content)
              // holds its mm floor up to the ≤0.02em per-side emission quantization, insets
              // never go negative, and the border box never leaves the paper (per-side
              // flooring caps the total slack under two guard bands).
              const topMm = fit.insetTopEm * fit.fontMm;
              const bottomMm = fit.insetBottomEm * fit.fontMm;
              assert.ok(fit.insetTopEm >= 0 && fit.insetBottomEm >= 0, `${label}: negative inline inset`);
              assert.ok(
                topMm >= floor.top - 0.02 * fit.fontMm - EPS,
                `${label}: top margin ${String(topMm)}mm under the ${String(floor.top)}mm floor`,
              );
              assert.ok(
                bottomMm >= floor.bottom - 0.02 * fit.fontMm - EPS,
                `${label}: bottom margin ${String(bottomMm)}mm under the ${String(floor.bottom)}mm floor`,
              );
              const inlineSlackEm = fit.heightMm / fit.fontMm - (sheetInlineEm + fit.insetTopEm + fit.insetBottomEm);
              assert.ok(
                inlineSlackEm >= -EPS && inlineSlackEm < 0.04 + EPS,
                `${label}: inline slack ${String(inlineSlackEm)}em outside the guard band`,
              );
            }
          }
        }
      }
    }
  }
});
