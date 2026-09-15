/**
 * Guards the deliberate DOUBLE HOME of the sheet geometry: FOLIO_BAND / SIDE_PAD /
 * EDGE_INSET live in geometry.ts (`@page` cannot read `var()` portably; each constant's
 * role is documented there) AND as plain literals in the authored `styles/*.css` fragments. If either side moves
 * alone, this fails loudly (see geometry.ts's module header). The line pitch is NOT double-homed:
 * it is the `jpnov.layout.linePitch` setting, so every fragment site must read `var(--pitch)` —
 * pinned as exact strings below, with a no-literal tripwire.
 *
 * The literal extraction keys on a KNOWN selector + property and never reads numbers embedded
 * in `calc()` expressions, so an intentional lowering to `calc(var())` breaks the assertion —
 * which is exactly when the constant relationship must be re-examined.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  EDGE_INSET,
  FOLIO_BAND,
  SIDE_PAD,
} from '../../../src/shared/compiler/geometry.ts';

const STYLES = new URL('../../../src/shared/compiler/styles/', import.meta.url);

function read(file: string): string {
  return readFileSync(fileURLToPath(new URL(file, STYLES)), 'utf8');
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The plain numeric literal of `selector{…prop:<number>…}` in raw fragment CSS, optionally
 * scoped inside an at-rule block (`within`, e.g. '@media print') via balanced-brace extraction.
 */
function cssValue(css: string, selector: string, prop: string, within?: string): number {
  let hay = css;
  if (within !== undefined) {
    const open = new RegExp(escapeRe(within) + '\\s*\\{').exec(css);
    assert.ok(open !== null, `block ${within} not found`);
    let depth = 0;
    let i = open.index + open[0].length - 1; // at the opening '{'
    const start = i + 1;
    for (; i < css.length; i++) {
      if (css[i] === '{') {
        depth++;
      } else if (css[i] === '}' && --depth === 0) {
        break;
      }
    }
    hay = css.slice(start, i);
  }
  const m = new RegExp(escapeRe(selector) + '\\{[^}]*?\\b' + escapeRe(prop) + ':(-?[\\d.]+)').exec(
    hay,
  );
  const value = m?.[1];
  assert.ok(value !== undefined, `${selector}{${prop}:<number>} not found`);
  return Number.parseFloat(value);
}

test('the .css geometry literals equal the geometry.ts constants (paper-fit double-home guard)', () => {
  const buildBase = read('build.base.css');

  // The sheet's physical band padding shorthand: top --htop (the header/line-number bands),
  // right SIDE_PAD, bottom FOLIO_BAND (the always-reserved folio band), left SIDE_PAD.
  const pad = /\.page\{[^}]*padding:calc\(var\(--htop\)\*1em\) ([\d.]+)em ([\d.]+)em ([\d.]+)em[;}]/.exec(buildBase);
  assert.ok(pad !== null, '.page{padding:calc(var(--htop)*1em) <side>em <folio>em <side>em} not found');
  assert.equal(Number.parseFloat(pad[2] ?? ''), FOLIO_BAND);
  // …and its one DERIVED literal: the outset frame's bottom inset in build.edge.css is
  // FOLIO_BAND − EDGE_INSET; a change to either constant could silently leave it behind —
  // guard it here.
  assert.equal(cssValue(read('build.edge.css'), '.page::before', 'bottom'), FOLIO_BAND - EDGE_INSET);

  // Print margin: the vertical sides pinned to ZERO — the paper inset rides the TS-emitted
  // border (geometry.ts fitPaper), so any vertical print margin would push the border box
  // (== the paper) past the @page box; the horizontal `auto` only centres the rounding
  // slack. PRINT_MARGIN lives only in the fit math now.
  assert.equal(cssValue(buildBase, '.page', 'margin', '@media print'), 0);

  // SIDE_PAD: the sheet's physical left/right padding (fitPaper's block-axis sheet size), the
  // outset frame's side insets (flush with the grid's side columns), and its one derived
  // literal — the folio corners at SIDE_PAD + EDGE_INSET (just inside the frame line).
  assert.equal(Number.parseFloat(pad[1] ?? ''), SIDE_PAD);
  assert.equal(Number.parseFloat(pad[3] ?? ''), SIDE_PAD);
  assert.equal(cssValue(read('build.edge.css'), '.page::before', 'left'), SIDE_PAD);
  assert.equal(cssValue(read('build.edge.css'), '.page::before', 'right'), SIDE_PAD);
  assert.equal(cssValue(read('build.folio.css'), '.pn.r', 'right'), SIDE_PAD + EDGE_INSET);
  assert.equal(cssValue(read('build.folio.css'), '.pn.l', 'left'), SIDE_PAD + EDGE_INSET);
});

test('the EDGE_INSET fragment sites all derive from the constant (reserve double-home guard)', () => {
  // Fragments write the String(n) canonical form ('0.7', not '.70'). Same-value literals
  // that are NOT this constant stay out: .pn{font-size:0.7em} and layout.ts's ruby-hang
  // tolerance.
  assert.equal(cssValue(read('preview.base.css'), '.segment', 'padding-inline'), EDGE_INSET);
  const calcSites: readonly (readonly [file: string, needle: string])[] = [
    ['preview.base.css', `(var(--cpl) + ${String(2 * EDGE_INSET)})`],
    ['preview.ln.css', `translateY(calc(-100% - ${String(EDGE_INSET)}rem - 2px))`],
    ['build.ln.css', `translateY(calc(-100% - ${String(EDGE_INSET)}rem))`],
    ['build.edge.css', `top:calc(var(--htop)*1em - ${String(EDGE_INSET)}em)`],
  ];
  for (const [file, needle] of calcSites) {
    assert.ok(read(file).includes(needle), `${file}: expected ${needle}`);
  }
});

test('the pitch-bearing fragment sites all read var(--pitch), and no literal pitch remains', () => {
  // The pitch sites live inside calc(), where cssValue() deliberately does not read — lock
  // the full var(--pitch) strings instead (the .line sizing and the 罫線 offsets MUST read
  // the same variable: the uniform-layout contract; the 罫線 themselves are emitted by
  // css.ts's edgeRules(), pinned in css.test.ts).
  assert.ok(
    read('preview.edge.css').includes('min-block-size:calc(var(--lpp)*var(--pitch)*1rem)'),
    'preview.edge.css page extent must read var(--pitch)',
  );
  assert.ok(read('preview.base.css').includes('line-height:var(--pitch);'), 'preview html line-height must read var(--pitch)');
  assert.ok(read('preview.base.css').includes('.line{block-size:calc(var(--pitch)*1em);'), 'preview .line must read var(--pitch)');
  assert.ok(read('build.base.css').includes('line-height:var(--pitch);'), 'build .page line-height must read var(--pitch)');
  assert.ok(read('build.base.css').includes('width:calc(var(--lpp)*var(--pitch)*1em);'), 'build .page extent must read var(--pitch)');
  assert.ok(read('build.base.css').includes('.line{block-size:calc(var(--pitch)*1em);'), 'build .line must read var(--pitch)');
  // Tripwire: a bare pitch number sneaking back into a pitch-bearing fragment would silently
  // detach that site from the setting (comments excepted — they may name the tiers).
  for (const file of ['preview.base.css', 'build.base.css', 'preview.edge.css', 'build.edge.css']) {
    const rules = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!rules.includes('2.25'), `${file} regrew a literal pitch`);
  }
});

test('the edge fragments paint NO background of their own (edgeRules owns the 罫線)', () => {
  // The 罫線 are css.ts edgeRules() per-boundary layers — the no-repeating-gradient ruling
  // (print tiling drifts) lives there; a fragment-side background would be a second home.
  for (const file of ['build.edge.css', 'preview.edge.css']) {
    const rules = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!rules.includes('background-image'), `${file} must not paint its own background`);
    assert.ok(!rules.includes('repeating-linear-gradient'), `${file} revived the tiled-gradient 罫線`);
  }
});

test('the base fragments carry NO ruby rules (the css.ts classRule lanes own rt sizing)', () => {
  // Every <rt> the layout emits sits inside a classed ruby (rr/lr/br) whose on-demand rule
  // set declares font-size:0.5em itself — a fragment-level ruby>rt rule would be a silent
  // second home for that value. Guard the absence in both fragments.
  assert.ok(!read('preview.base.css').includes('ruby>rt{'), 'preview.base.css grew a ruby>rt rule');
  assert.ok(!read('build.base.css').includes('ruby>rt{'), 'build.base.css grew a ruby>rt rule');
});
