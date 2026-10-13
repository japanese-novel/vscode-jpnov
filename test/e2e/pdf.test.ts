/**
 * E2E over the BUNDLED server + a real Chromium print: builds a two-page book over LSP
 * stdio, prints the artifact the way a user's browser would, and asserts the PDF's physical
 * structure — every /MediaBox equals the configured paper to ±0.5mm (Chromium quantizes the
 * page box by ~0.17mm internally) and the PDF page count equals the rendered `.page` count,
 * the long-term tripwire for the paper-fit slack that keeps a border box from spilling onto
 * a second sheet (a printed `.print` button would trip it too).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bookTemplate } from '../../src/shared/book/create.ts';
import type { PaperFit } from '../../src/shared/compiler/geometry.ts';
import { HEADER_BAND, fitPaper } from '../../src/shared/compiler/geometry.ts';
import type { BuildResult, HtmlSettings } from '../../src/shared/protocol.ts';

import { printToPdfArgs } from './_browser.ts';
import { BROWSER_SKIP, browser, cleanups, removeCleanups } from './_setup.ts';
import { LspClient } from './lsp.ts';

const SERVER_MODULE = fileURLToPath(new URL('../../dist/server/server.js', import.meta.url));

const BASE_SETTINGS: HtmlSettings = {
  charsPerLine: 40,
  linesPerPage: 34,
  linePitch: 2,
  fontFamily: '',
  kinsoku: 'strict',
  dash: 'horizontalBar',
  lineNumbers: false,
  edgeLine: 'none',
  paperSize: 'a4',
  paperOrientation: 'auto',
};

/** ［＃改ページ］ splits the fixture into exactly two rendered pages. */
const CHAPTER_TEXT = '一章の本文。\n［＃改ページ］\n二章の本文。\n';

let client: LspClient | undefined;
let projectDirs: Record<string, { outDir: string }> = {};

before(async () => {
  assert.ok(
    existsSync(SERVER_MODULE),
    `missing ${SERVER_MODULE} — run \`npm run build:dev\` first (\`npm run test:e2e\` does)`,
  );
  client = new LspClient(SERVER_MODULE);
  await client.request('initialize', {
    processId: null,
    rootUri: null,
    capabilities: {},
    initializationOptions: { lintConfig: {} },
  });
  client.notify('initialized', {});

  const wsDir = await mkdtemp(join(tmpdir(), 'jpnov-e2e-pdf-ws-'));
  cleanups.push(wsDir);
  const wsUri = pathToFileURL(wsDir).href.replace(/\/$/, '');
  await writeFile(join(wsDir, 'hon.jpnov'), CHAPTER_TEXT, 'utf8');
  await writeFile(join(wsDir, 'hon.jpbook'), bookTemplate('用紙試験') + 'hon.jpnov\n', 'utf8');
  projectDirs = { [wsUri]: { outDir: 'dist' } };
});

after(async () => {
  if (client) {
    await client.dispose();
  }
  await removeCleanups();
});

/** Builds the fixture book with `settings` and returns the HTML artifact text. */
async function buildHtml(settings: HtmlSettings): Promise<string> {
  assert.ok(client, 'LSP client not started');
  const result = await client.request<BuildResult>('jpnov/build', {
    format: 'html',
    settings,
    projectDirs,
  });
  assert.equal(result.ok, true);
  const artifact = result.artifacts[0];
  assert.ok(artifact?.kind === 'html', 'the build must produce one HTML artifact');
  return artifact.content;
}

/**
 * Prints `html` headlessly (fresh profile per run). Readiness is the OUTPUT FILE —
 * non-empty and size-stable across one poll — never process exit: headless Chromium
 * lingers after writing.
 */
async function printPdf(browserPath: string, html: string, prefix: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), `jpnov-e2e-${prefix}-`));
  cleanups.push(dir);
  const htmlPath = join(dir, `${prefix}.html`);
  const pdfPath = join(dir, `${prefix}.pdf`);
  await writeFile(htmlPath, html, 'utf8');
  const profileDir = await mkdtemp(join(dir, 'profile-'));
  const ciFlags = process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
  const child = spawn(
    browserPath,
    [...printToPdfArgs(pathToFileURL(htmlPath).href, pdfPath, profileDir), ...ciFlags],
    { stdio: 'ignore', detached: true },
  );
  const deadline = performance.now() + 90_000;
  let lastSize = -1;
  try {
    while (performance.now() < deadline) {
      await delay(200);
      const size = await stat(pdfPath).then((s) => s.size, () => -1);
      if (size > 0 && size === lastSize) {
        return await readFile(pdfPath);
      }
      lastSize = size;
    }
  } finally {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      if (child.exitCode === null) {
        await once(child, 'exit');
      }
    }
  }
  throw new Error(`no PDF written within timeout for ${prefix}`);
}

/**
 * Structural paper assertions on the raw PDF bytes (Chromium writes these dictionaries
 * uncompressed today; if a future Skia moves them into object streams this fails loudly
 * and a minimal xref parse becomes the fallback).
 */
function assertPdfPaper(pdf: Buffer, fit: PaperFit, expectedPages: number, label: string): void {
  const text = pdf.toString('latin1');
  const MM_PER_PT = 25.4 / 72;

  const boxes = [...text.matchAll(/\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/g)];
  assert.ok(boxes.length >= expectedPages, `${label}: expected ≥${String(expectedPages)} MediaBox entries, saw ${String(boxes.length)}`);
  for (const box of boxes) {
    assert.equal(Number(box[1]), 0, `${label}: MediaBox origin x`);
    assert.equal(Number(box[2]), 0, `${label}: MediaBox origin y`);
    const wMm = Number(box[3]) * MM_PER_PT;
    const hMm = Number(box[4]) * MM_PER_PT;
    assert.ok(
      Math.abs(wMm - fit.widthMm) < 0.5,
      `${label}: paper width ${wMm.toFixed(2)}mm must be ${String(fit.widthMm)}mm ±0.5`,
    );
    assert.ok(
      Math.abs(hMm - fit.heightMm) < 0.5,
      `${label}: paper height ${hMm.toFixed(2)}mm must be ${String(fit.heightMm)}mm ±0.5`,
    );
  }

  const pageObjects = [...text.matchAll(/\/Type\s*\/Page(?!s)/g)].length;
  assert.equal(
    pageObjects,
    expectedPages,
    `${label}: one PDF page per rendered .page — a mismatch means a sheet split or a blank trailing page`,
  );
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(
    counts.includes(expectedPages),
    `${label}: the page tree must count ${String(expectedPages)} (saw ${counts.join(',')})`,
  );
}

test('the printed PDF is true A4 (auto → landscape), one PDF page per rendered page', BROWSER_SKIP, async () => {
  assert.ok(browser, 'JPNOV_E2E_REQUIRE_BROWSER=1 but no Chromium-family browser was found');
  const html = await buildHtml(BASE_SETTINGS);
  const expectedPages = (html.match(/class="page[ "]/g) ?? []).length;
  assert.equal(expectedPages, 2, 'the fixture must paginate to exactly two pages');
  const fit = fitPaper({
    charsPerLine: BASE_SETTINGS.charsPerLine,
    linesPerPage: BASE_SETTINGS.linesPerPage,
    linePitch: BASE_SETTINGS.linePitch,
    hTop: HEADER_BAND,
    size: BASE_SETTINGS.paperSize,
    orientation: BASE_SETTINGS.paperOrientation,
  });
  assert.deepEqual([fit.widthMm, fit.heightMm], [297, 210], '40×34 must auto-select landscape A4');
  assertPdfPaper(await printPdf(browser, html, 'a4-auto'), fit, expectedPages, 'a4/auto');
});

test('the printed PDF follows paper size and forced orientation (A6 portrait)', BROWSER_SKIP, async () => {
  assert.ok(browser, 'JPNOV_E2E_REQUIRE_BROWSER=1 but no Chromium-family browser was found');
  const settings: HtmlSettings = { ...BASE_SETTINGS, paperSize: 'a6', paperOrientation: 'portrait' };
  const html = await buildHtml(settings);
  const expectedPages = (html.match(/class="page[ "]/g) ?? []).length;
  assert.equal(expectedPages, 2, 'the fixture must paginate to exactly two pages');
  const fit = fitPaper({
    charsPerLine: settings.charsPerLine,
    linesPerPage: settings.linesPerPage,
    linePitch: settings.linePitch,
    hTop: HEADER_BAND,
    size: settings.paperSize,
    orientation: settings.paperOrientation,
  });
  assert.deepEqual([fit.widthMm, fit.heightMm], [105, 148], 'forced portrait must turn the A6 paper');
  assertPdfPaper(await printPdf(browser, html, 'a6-portrait'), fit, expectedPages, 'a6/portrait');
});
