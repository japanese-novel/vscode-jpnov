import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILD_CHROME_DEFAULT,
  BUILD_PAPER_DEFAULT,
  PREVIEW_CHROME_DEFAULT,
  resolveHtmlSettings,
  resolvePreviewSettings,
} from '../../../src/shared/config/settings.ts';
import { LAYOUT_DEFAULT } from '../../../src/shared/config/types.ts';
import type { HtmlSettings, PreviewSettings } from '../../../src/shared/protocol.ts';

/** A fully-valid baseline built from the single-source constants. */
const HTML_BASE: HtmlSettings = {
  ...LAYOUT_DEFAULT,
  lineNumbers: BUILD_CHROME_DEFAULT.lineNumbers,
  edgeLine: BUILD_CHROME_DEFAULT.edgeLine,
  ...BUILD_PAPER_DEFAULT,
};
const PREVIEW_BASE: PreviewSettings = {
  ...LAYOUT_DEFAULT,
  ...PREVIEW_CHROME_DEFAULT,
};

/**
 * An intentionally-invalid wire payload: the spread keeps the declared field types, so
 * this models the untrusted IPC value without any cast noise.
 */
function badHtml(patch: Record<string, unknown>): HtmlSettings {
  return { ...HTML_BASE, ...patch };
}
function badPreview(patch: Record<string, unknown>): PreviewSettings {
  return { ...PREVIEW_BASE, ...patch };
}

test('valid settings pass through unchanged', () => {
  assert.deepEqual(resolveHtmlSettings(HTML_BASE), HTML_BASE);
  assert.deepEqual(resolvePreviewSettings(PREVIEW_BASE), PREVIEW_BASE);
});

test('product defaults differ per target: preview line numbers on, html off', () => {
  assert.equal(PREVIEW_CHROME_DEFAULT.lineNumbers, true);
  assert.equal(BUILD_CHROME_DEFAULT.lineNumbers, false);
});

test('grid geometry clamps to [16..64] and falls back on non-integers', () => {
  assert.equal(resolveHtmlSettings({ ...HTML_BASE, charsPerLine: 3 }).charsPerLine, 16);
  assert.equal(resolveHtmlSettings({ ...HTML_BASE, charsPerLine: 99 }).charsPerLine, 64);
  assert.equal(resolveHtmlSettings({ ...HTML_BASE, linesPerPage: 1 }).linesPerPage, 16);
  assert.equal(
    resolveHtmlSettings(badHtml({ charsPerLine: 'wide' })).charsPerLine,
    LAYOUT_DEFAULT.charsPerLine,
  );
  assert.equal(
    resolveHtmlSettings(badHtml({ linesPerPage: Number.NaN })).linesPerPage,
    LAYOUT_DEFAULT.linesPerPage,
  );
  assert.equal(resolvePreviewSettings({ ...PREVIEW_BASE, charsPerLine: 64 }).charsPerLine, 64);
  // linesPerPage rides the preview snapshot too (the edge frame's page extent) — same clamp.
  assert.equal(resolvePreviewSettings({ ...PREVIEW_BASE, linesPerPage: 1 }).linesPerPage, 16);
  assert.equal(
    resolvePreviewSettings(badPreview({ linesPerPage: 'tall' })).linesPerPage,
    LAYOUT_DEFAULT.linesPerPage,
  );
});

test('linePitch rides both snapshots: kept on the four tiers, defaulted otherwise', () => {
  assert.equal(LAYOUT_DEFAULT.linePitch, 1.5); // the product default — the common book pitch
  assert.equal(resolveHtmlSettings({ ...HTML_BASE, linePitch: 2.25 }).linePitch, 2.25);
  assert.equal(resolvePreviewSettings({ ...PREVIEW_BASE, linePitch: 1.5 }).linePitch, 1.5);
  // Off-tier numbers, numeric strings and booleans all coerce — the enum is the contract.
  assert.equal(resolveHtmlSettings(badHtml({ linePitch: 2.5 })).linePitch, LAYOUT_DEFAULT.linePitch);
  assert.equal(resolveHtmlSettings(badHtml({ linePitch: '2' })).linePitch, LAYOUT_DEFAULT.linePitch);
  assert.equal(resolveHtmlSettings(badHtml({ linePitch: Number.NaN })).linePitch, LAYOUT_DEFAULT.linePitch);
  assert.equal(resolvePreviewSettings(badPreview({ linePitch: true })).linePitch, LAYOUT_DEFAULT.linePitch);
});

test('fontFamily rides both snapshots: any string kept verbatim, non-strings defaulted', () => {
  assert.equal(LAYOUT_DEFAULT.fontFamily, ''); // blank = the built-in stack (css.ts emission)
  assert.equal(
    resolveHtmlSettings({ ...HTML_BASE, fontFamily: '"游明朝", serif' }).fontFamily,
    '"游明朝", serif',
  );
  assert.equal(
    resolvePreviewSettings({ ...PREVIEW_BASE, fontFamily: 'Yu Mincho' }).fontFamily,
    'Yu Mincho',
  );
  // The resolver is type-only — sanitizing is css.ts's job at emission.
  assert.equal(resolveHtmlSettings(badHtml({ fontFamily: 42 })).fontFamily, LAYOUT_DEFAULT.fontFamily);
  assert.equal(
    resolvePreviewSettings(badPreview({ fontFamily: null })).fontFamily,
    LAYOUT_DEFAULT.fontFamily,
  );
});

test('kinsoku rides both snapshots: kept when a known member, defaulted otherwise', () => {
  assert.equal(resolveHtmlSettings({ ...HTML_BASE, kinsoku: 'strict' }).kinsoku, 'strict');
  assert.equal(resolvePreviewSettings({ ...PREVIEW_BASE, kinsoku: 'none' }).kinsoku, 'none');
  assert.equal(resolveHtmlSettings(badHtml({ kinsoku: 'loose' })).kinsoku, LAYOUT_DEFAULT.kinsoku);
  assert.equal(LAYOUT_DEFAULT.kinsoku, 'strict'); // 禁則 ships at the Word 高レベル / Pages tier
  // A boolean coerces to the default like any other invalid value — deliberately no compat shim.
  assert.equal(resolveHtmlSettings(badHtml({ kinsoku: true })).kinsoku, LAYOUT_DEFAULT.kinsoku);
});

test('autoTcy rides both snapshots: kept when a known member, defaulted otherwise', () => {
  assert.equal(
    resolveHtmlSettings({ ...HTML_BASE, autoTcy: 'punctuationPairs' }).autoTcy,
    'punctuationPairs',
  );
  assert.equal(
    resolvePreviewSettings({ ...PREVIEW_BASE, autoTcy: 'punctuationPairs' }).autoTcy,
    'punctuationPairs',
  );
  assert.equal(resolveHtmlSettings(badHtml({ autoTcy: 'always' })).autoTcy, LAYOUT_DEFAULT.autoTcy);
  assert.equal(resolveHtmlSettings(badHtml({ autoTcy: true })).autoTcy, LAYOUT_DEFAULT.autoTcy);
  assert.equal(LAYOUT_DEFAULT.autoTcy, 'punctuationPairs'); // 自動縦中横 ships ON (auto-combines half-width !! !? ?! ??)
});

test('dash rides both snapshots: kept when known, defaulted otherwise — retired "off" included', () => {
  assert.equal(resolveHtmlSettings({ ...HTML_BASE, dash: 'emDash' }).dash, 'emDash');
  assert.equal(resolvePreviewSettings({ ...PREVIEW_BASE, dash: 'boxDrawing' }).dash, 'boxDrawing');
  // A settings.json still carrying the retired 'off' member renders with the default glyph;
  // the lint side keeps reading that spelling as disabled (select.ts).
  assert.equal(resolveHtmlSettings(badHtml({ dash: 'off' })).dash, LAYOUT_DEFAULT.dash);
  assert.equal(resolveHtmlSettings(badHtml({ dash: true })).dash, LAYOUT_DEFAULT.dash);
  assert.equal(LAYOUT_DEFAULT.dash, 'horizontalBar'); // 全角ダッシュ ― is the shipped default
});

test('bogus enum and boolean values coerce to their defaults', () => {
  assert.equal(resolveHtmlSettings(badHtml({ edgeLine: 'blue' })).edgeLine, 'none');
  assert.equal(
    resolveHtmlSettings(badHtml({ lineNumbers: 'yes' })).lineNumbers,
    BUILD_CHROME_DEFAULT.lineNumbers,
  );
  assert.equal(
    resolvePreviewSettings({ ...PREVIEW_BASE, edgeLine: 'red' }).edgeLine,
    'red',
  );
});

test('paper size/orientation ride the html snapshot: kept when known, defaulted otherwise', () => {
  assert.equal(resolveHtmlSettings({ ...HTML_BASE, paperSize: 'a6' }).paperSize, 'a6');
  assert.equal(
    resolveHtmlSettings({ ...HTML_BASE, paperOrientation: 'portrait' }).paperOrientation,
    'portrait',
  );
  assert.equal(resolveHtmlSettings(badHtml({ paperSize: 'b5' })).paperSize, BUILD_PAPER_DEFAULT.paperSize);
  assert.equal(
    resolveHtmlSettings(badHtml({ paperOrientation: 'sideways' })).paperOrientation,
    BUILD_PAPER_DEFAULT.paperOrientation,
  );
  assert.equal(resolveHtmlSettings(badHtml({ paperSize: true })).paperSize, BUILD_PAPER_DEFAULT.paperSize);
  assert.equal(
    resolveHtmlSettings(badHtml({ paperOrientation: false })).paperOrientation,
    BUILD_PAPER_DEFAULT.paperOrientation,
  );
});

test('the wire settings carry NO page furniture — that is jpbook front-matter territory', () => {
  // Junk furniture fields on the payload must be dropped, not forwarded: the resolver's
  // output is EXACTLY the wire fields of each shape, whatever a stale or hostile sender ships.
  const PREVIEW_WIRE_KEYS = ['autoTcy', 'charsPerLine', 'dash', 'edgeLine', 'fontFamily', 'kinsoku', 'lineNumbers', 'linePitch', 'linesPerPage'];
  const HTML_WIRE_KEYS = [...PREVIEW_WIRE_KEYS, 'paperOrientation', 'paperSize'].sort();
  const resolved = resolveHtmlSettings(badHtml({ header: '柱', footerAlign: 'none' }));
  assert.deepEqual(Object.keys(resolved).sort(), HTML_WIRE_KEYS);
  const resolvedPreview = resolvePreviewSettings(badPreview({ header: '柱', footerAlign: 'none' }));
  assert.deepEqual(Object.keys(resolvedPreview).sort(), PREVIEW_WIRE_KEYS);
});
