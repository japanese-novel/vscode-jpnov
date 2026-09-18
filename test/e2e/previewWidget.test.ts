/**
 * E2E for the preview's layout widget (#71): the REAL preview bundle runs in a headless Chromium
 * against a stub `acquireVsCodeApi`, seeded with a host-shaped `__INIT`. Each page drives the
 * inputs and buttons synchronously at parse time (`--dump-dom` serializes at load) and reports the
 * DOM the widget built plus the messages it posted. A dumped page never holds focus (no focus
 * events fire), so focus leaving the chip is synthesised; the real fold is checked on the host.
 * Skips without a discoverable browser unless `JPNOV_E2E_REQUIRE_BROWSER=1` (CI).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import { PREVIEW_JS, WIDGET_CSS } from '../../src/client/preview/webviewBundle.generated.ts';
import type { PreviewInit, PreviewLayoutInit } from '../../src/client/protocol.ts';

import { resolveBrowserExecutable } from './_browser.ts';
import { MARKER, measurePage } from './_headless.ts';

const browser = resolveBrowserExecutable({
  env: process.env,
  platform: process.platform,
  exists: existsSync,
});
const browserRequired = process.env.JPNOV_E2E_REQUIRE_BROWSER === '1';
const BROWSER_SKIP = {
  skip: browser === undefined && !browserRequired
    ? 'no Chromium-family browser on this machine (CI requires one via JPNOV_E2E_REQUIRE_BROWSER=1)'
    : false,
};

const cleanups: string[] = [];
after(async () => {
  await Promise.all(
    cleanups.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

/** Every label reads as its own tag, so the DOM report names controls without echoing real copy. */
const LABELS = {
  chars: '字',
  lines: '行',
  charsPerLine: 'CPL',
  linesPerPage: 'LPP',
  hint: 'HINT',
  reset: 'RESET',
  save: 'SAVE',
  show: 'SHOW',
} as const;

function layout(over: Partial<PreviewLayoutInit>): PreviewLayoutInit {
  return { charsPerLine: 40, linesPerPage: 34, adjusted: false, min: 16, max: 64, labels: LABELS, ...over };
}

/** The page as the host serves it: the widget stylesheet, a body, the stub API + `__INIT`, the real bundle. */
function page(init: PreviewInit): string {
  return [
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">',
    `<style>${WIDGET_CSS}</style>`,
    '</head><body><p>本文</p>',
    '<script>window.__posted = [];',
    'window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState: () => {} });',
    `window.__INIT = ${JSON.stringify(init).replace(/</g, '\\u003c')};</script>`,
    `<script>${PREVIEW_JS}</script>`,
    '</body></html>',
  ].join('');
}

/**
 * The parse-time driver: `step` acts on the built widget and records what the bundle posted
 * meanwhile, the input values, which input holds focus and what is on screen; the report ends
 * with the DOM facts.
 */
function scenario(steps: string): string {
  return `<script>
(() => {
  const posted = window.__posted;
  const chip = document.querySelector('.jw');
  const inputs = [...document.querySelectorAll('.jw input')];
  const [cpl, lpp] = inputs;
  const summary = document.querySelector('.jw-summary');
  const active = () => (document.activeElement === cpl ? 'cpl' : document.activeElement === lpp ? 'lpp' : null);
  // Rendered = has a box; an ancestor's display:none leaves a descendant's computed display alone.
  const shown = (el) => el !== null && el.getClientRects().length > 0;
  const view = () => ({ chipShown: shown(chip), fieldsShown: shown(cpl), summaryShown: shown(summary) });
  const steps = [];
  const step = (name, act) => {
    const from = posted.length;
    act();
    steps.push({ name, posted: posted.slice(from), values: inputs.map((i) => i.value), active: active(), ...view() });
  };
  const change = (el, v) => { el.value = v; el.dispatchEvent(new Event('change')); };
  const key = (el, k) => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k })); };
  // Headless --dump-dom pages never hold focus, so focus events must be synthesised (bubbling, like the real ones).
  const leave = (el, to) => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: to })); };
  const button = (label) => document.querySelector('.jw-btn[aria-label="' + label + '"]');
  ${steps}
  document.documentElement.setAttribute('${MARKER}', JSON.stringify({
    present: chip !== null,
    adjusted: chip !== null && chip.hasAttribute('data-adjusted'),
    title: chip === null ? null : chip.title,
    names: inputs.map((i) => i.getAttribute('aria-label')),
    bounds: [cpl.min, cpl.max],
    fields: [...document.querySelectorAll('.jw-field')].map((f) => f.textContent),
    buttons: [...document.querySelectorAll('.jw-btn')].map((b) => b.getAttribute('aria-label')),
    summaryText: summary === null ? null : summary.textContent,
    summaryName: summary === null ? null : summary.title,
    steps,
  }));
})();
</script>`;
}

/** What is on screen: the chip itself, its inputs, its folded summary. */
interface View {
  readonly chipShown: boolean;
  readonly fieldsShown: boolean;
  readonly summaryShown: boolean;
}
interface Step extends View {
  readonly name: string;
  readonly posted: readonly unknown[];
  readonly values: readonly string[];
  readonly active: 'cpl' | 'lpp' | null;
}
interface Report {
  readonly present: boolean;
  readonly adjusted: boolean;
  readonly title: string | null;
  readonly names: readonly string[];
  readonly bounds: readonly string[];
  readonly fields: readonly string[];
  readonly buttons: readonly string[];
  readonly summaryText: string | null;
  readonly summaryName: string | null;
  readonly steps: readonly Step[];
}
const OPEN: View = { chipShown: true, fieldsShown: true, summaryShown: false };
const FOLDED: View = { chipShown: true, fieldsShown: false, summaryShown: true };

const set = (key: 'charsPerLine' | 'linesPerPage', value: number): unknown => ({ type: 'layout', key, value });

test('folded by default, the widget opens on its summary, clamps and de-duplicates its inputs, and folds when focus leaves', BROWSER_SKIP, async () => {
  assert.ok(browser, 'JPNOV_E2E_REQUIRE_BROWSER=1 but no Chromium-family browser was found');
  const init: PreviewInit = { uri: 'file:///ws/a.jpnov', line: 0, layout: layout({}) };
  const driver = scenario(`
  step('loaded', () => {});
  step('summary-click', () => { summary.click(); });
  step('in-range', () => change(cpl, '42'));
  step('over-max', () => change(cpl, '70'));
  step('under-min', () => change(lpp, '3'));
  step('cleared', () => change(lpp, ''));
  step('same', () => change(lpp, '16'));
  step('enter', () => { cpl.value = '30'; key(cpl, 'Enter'); });
  step('fraction', () => change(cpl, '33.6'));
  step('focus-stays', () => { leave(cpl, lpp); });
  step('focus-leaves', () => { leave(cpl, null); });
  step('summary-again', () => { summary.click(); });
  `);
  const report = JSON.parse(await measurePage(browser, page(init), driver, 'preview-widget', cleanups)) as Report;

  assert.equal(report.present, true);
  assert.equal(report.adjusted, false);
  assert.equal(report.title, 'HINT');
  assert.deepEqual(report.names, ['CPL', 'LPP']);
  assert.deepEqual(report.bounds, ['16', '64']);
  assert.deepEqual(report.fields, ['字', '行']);
  assert.deepEqual(report.buttons, [], 'no reset/save buttons while the values are the settings');
  assert.equal(report.summaryName, 'SHOW');
  assert.equal(report.summaryText, '34 字 × 16 行', 'the summary follows the committed values');
  assert.deepEqual(report.steps, [
    { name: 'loaded', posted: [], values: ['40', '34'], active: null, ...FOLDED },
    { name: 'summary-click', posted: [], values: ['40', '34'], active: 'cpl', ...OPEN },
    { name: 'in-range', posted: [set('charsPerLine', 42)], values: ['42', '34'], active: 'cpl', ...OPEN },
    { name: 'over-max', posted: [set('charsPerLine', 64)], values: ['64', '34'], active: 'cpl', ...OPEN },
    { name: 'under-min', posted: [set('linesPerPage', 16)], values: ['64', '16'], active: 'cpl', ...OPEN },
    { name: 'cleared', posted: [], values: ['64', '16'], active: 'cpl', ...OPEN },
    { name: 'same', posted: [], values: ['64', '16'], active: 'cpl', ...OPEN },
    { name: 'enter', posted: [set('charsPerLine', 30)], values: ['30', '16'], active: 'cpl', ...OPEN },
    { name: 'fraction', posted: [set('charsPerLine', 34)], values: ['34', '16'], active: 'cpl', ...OPEN },
    // Synthetic focusout: the handler folds only when focus leaves the chip (focus itself stays put).
    { name: 'focus-stays', posted: [], values: ['34', '16'], active: 'cpl', ...OPEN },
    { name: 'focus-leaves', posted: [], values: ['34', '16'], active: 'cpl', ...FOLDED },
    { name: 'summary-again', posted: [], values: ['34', '16'], active: 'cpl', ...OPEN },
  ]);
});

test('a render caused by the widget opens it on the named input, and the buttons post reset/save', BROWSER_SKIP, async () => {
  assert.ok(browser, 'JPNOV_E2E_REQUIRE_BROWSER=1 but no Chromium-family browser was found');
  const init: PreviewInit = {
    uri: 'file:///ws/a.jpnov',
    line: 0,
    layout: layout({ charsPerLine: 42, adjusted: true, focus: 'charsPerLine' }),
  };
  const driver = scenario(`
  step('loaded', () => {});
  step('refocused', () => { window.dispatchEvent(new Event('focus')); });
  step('reset', () => { button('RESET').click(); });
  step('save', () => { button('SAVE').click(); });
  step('focus-leaves', () => { leave(cpl, null); });
  `);
  const report = JSON.parse(await measurePage(browser, page(init), driver, 'preview-widget-adjusted', cleanups)) as Report;

  assert.equal(report.adjusted, true);
  assert.deepEqual(report.buttons, ['RESET', 'SAVE']);
  assert.equal(report.summaryText, '42 字 × 34 行');
  const [loaded, refocused, reset, save, left] = report.steps;
  assert.deepEqual(loaded, { name: 'loaded', posted: [], values: ['42', '34'], active: loaded?.active ?? null, ...OPEN }, 'opens at once');
  // Focus lands on the input either at once (the document already had focus) or when the
  // workbench hands focus back after the swap (the window `focus` event).
  assert.equal(refocused?.active, 'cpl');
  assert.deepEqual(reset?.posted, [{ type: 'reset' }]);
  assert.deepEqual(save?.posted, [{ type: 'save' }]);
  assert.deepEqual(left, { name: 'focus-leaves', posted: [], values: ['42', '34'], active: 'cpl', ...FOLDED }, 'folds to the framed summary');
});

test('folded while adjusted, the framed summary is the way back in', BROWSER_SKIP, async () => {
  assert.ok(browser, 'JPNOV_E2E_REQUIRE_BROWSER=1 but no Chromium-family browser was found');
  const init: PreviewInit = { uri: 'file:///ws/a.jpnov', line: 0, layout: layout({ charsPerLine: 42, adjusted: true }) };
  const driver = scenario(`
  step('loaded', () => {});
  step('summary-click', () => { summary.click(); });
  `);
  const report = JSON.parse(await measurePage(browser, page(init), driver, 'preview-widget-folded-adjusted', cleanups)) as Report;
  assert.equal(report.adjusted, true);
  assert.deepEqual(report.steps, [
    { name: 'loaded', posted: [], values: ['42', '34'], active: null, ...FOLDED },
    { name: 'summary-click', posted: [], values: ['42', '34'], active: 'cpl', ...OPEN },
  ]);
});
