/**
 * E2E smoke over the BUNDLED server: drives `dist/server/server.js` over LSP stdio exactly
 * like the extension host does, so it catches bundling regressions (createRequire banner,
 * tripwires, protocol wiring) the in-process suites cannot. `npm run test:e2e` builds first
 * via `pretest:e2e`. The final leg renders the built page in a headless Chromium and asserts
 * the vertical-flow metrics; without a discoverable browser it skips, unless
 * `JPNOV_E2E_REQUIRE_BROWSER=1` (CI) makes the absence a failure.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { HEADER_BAND, fitPaper } from '../../src/shared/compiler/geometry.ts';
import { LINE_PITCHES } from '../../src/shared/config/types.ts';
import type {
  BuildResult,
  HtmlSettings,
  ListBooksResult,
  PreviewSettings,
  RenderFileResult,
} from '../../src/shared/protocol.ts';

import { resolveBrowserExecutable } from './_browser.ts';
import { MARKER, measurePage } from './_headless.ts';
import { LspClient } from './lsp.ts';

const SERVER_MODULE = fileURLToPath(new URL('../../dist/server/server.js', import.meta.url));

const PREVIEW_SETTINGS: PreviewSettings = {
  charsPerLine: 40,
  linesPerPage: 34,
  linePitch: 2,
  fontFamily: '',
  kinsoku: 'strict',
  autoTcy: 'punctuationPairs',
  dash: 'horizontalBar',
  lineNumbers: true,
  edgeLine: 'none',
};

const HTML_SETTINGS: HtmlSettings = {
  charsPerLine: 40,
  linesPerPage: 34,
  linePitch: 2,
  fontFamily: '',
  kinsoku: 'strict',
  autoTcy: 'punctuationPairs',
  dash: 'horizontalBar',
  lineNumbers: false,
  edgeLine: 'none',
  paperSize: 'a4',
  paperOrientation: 'auto',
};

/** Exercises ruby, explicit + automatic (half-width pair) 縦中横, and 改ページ in one pass. */
const CHAPTER_TEXT = [
  '｜夜霧《よぎり》の街を行く。',
  '［＃縦中横］12［＃縦中横終わり］時の鐘が鳴る。',
  '走った!?',
  '［＃改ページ］',
  '二章の本文。',
  '',
].join('\n');

const browser = resolveBrowserExecutable({
  env: process.env,
  platform: process.platform,
  exists: existsSync,
});
const browserRequired = process.env.JPNOV_E2E_REQUIRE_BROWSER === '1';
/** Shared options for every browser-rendering leg. */
const BROWSER_SKIP = {
  skip: browser === undefined && !browserRequired
    ? 'no Chromium-family browser on this machine (CI requires one via JPNOV_E2E_REQUIRE_BROWSER=1)'
    : false,
};

let client: LspClient | undefined;
const cleanups: string[] = [];
let builtHtml: string | undefined;

const conn = (): LspClient => {
  assert.ok(client, 'LSP client not started');
  return client;
};

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
});

after(async () => {
  if (client) {
    await client.dispose();
  }
  await Promise.all(
    cleanups.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

test('jpnov/renderFile renders ruby, 縦中横, and the pagebreak marker over the wire', async () => {
  const { html } = await conn().request<RenderFileResult>('jpnov/renderFile', {
    uri: 'file:///e2e/preview.jpnov',
    text: CHAPTER_TEXT,
    settings: PREVIEW_SETTINGS,
  });

  assert.ok(html.includes('<ruby class="rr">'), 'ruby must render on the custom right lane');
  assert.ok(
    html.includes('<rt><span><span>よ</span><span>ぎ</span><span>り</span></span></rt>'),
    'the reading must survive as per-character cells',
  );
  assert.ok(!html.includes('《'), 'the Aozora reading brackets must be consumed');
  assert.ok(html.includes('<span class="tcy">12</span>'), 'explicit 縦中横 span must combine');
  assert.ok(html.includes('<span class="tcy">!?</span>'), 'autoTcy must combine the half-width !? pair');
  assert.ok(html.includes('vertical-rl'), 'vertical flow CSS must be inlined');
  assert.ok(html.includes('text-combine-upright'), 'the on-demand tcy fragment must be gated in');
  assert.ok(html.includes('pagebreak'), '改ページ must surface as the preview pagebreak marker');
});

test('jpnov/listBooks + jpnov/build round-trip a real workspace over the wire', async () => {
  const wsDir = await mkdtemp(join(tmpdir(), 'jpnov-e2e-ws-'));
  cleanups.push(wsDir);
  const wsUri = pathToFileURL(wsDir).href.replace(/\/$/, '');
  await writeFile(join(wsDir, 'hon.jpnov'), CHAPTER_TEXT, 'utf8');
  await writeFile(join(wsDir, 'hon.jpbook'), '---\ntitle: 試験本\n---\nhon.jpnov\n', 'utf8');
  const projectDirs = { [wsUri]: { outDir: 'dist' } };

  const list = await conn().request<ListBooksResult>('jpnov/listBooks', { projectDirs });
  assert.equal(list.books.length, 1);
  const book = list.books[0];
  assert.ok(book);
  assert.equal(book.outRel, 'hon');
  assert.equal(book.title, '試験本');

  const result = await conn().request<BuildResult>('jpnov/build', {
    format: 'html',
    settings: HTML_SETTINGS,
    projectDirs,
  });
  assert.equal(result.ok, true);
  assert.equal(result.artifacts.length, 1);

  const htmlArtifact = result.artifacts[0];
  assert.ok(htmlArtifact?.kind === 'html');
  assert.equal(htmlArtifact.path, `${wsUri}/dist/hon.html`);
  assert.ok(/class="page[ "]/.test(htmlArtifact.content), 'built HTML must paginate');
  assert.ok(htmlArtifact.content.includes('class="line"'), 'built HTML must emit line columns');
  assert.ok(htmlArtifact.content.includes('<ruby'), 'built HTML must keep the ruby markup');

  const txtResult = await conn().request<BuildResult>('jpnov/build', {
    format: 'txt',
    settings: HTML_SETTINGS,
    projectDirs,
  });
  const txtArtifact = txtResult.artifacts[0];
  assert.ok(txtArtifact?.kind === 'txt');
  assert.equal(txtArtifact.path, `${wsUri}/dist/hon.txt`);
  // deepEqual over the REAL wire: locks outDirs arriving as a plain array (a Set would not survive).
  assert.deepEqual(txtResult.outDirs, [`${wsUri}/dist`]);
  assert.ok(txtArtifact.content.includes('夜霧'), 'the .txt artifact carries the raw Aozora source');

  builtHtml = htmlArtifact.content;
});

/**
 * Runs SYNCHRONOUSLY at parse time (getBoundingClientRect forces layout), because
 * `--dump-dom` serializes right at document load — a load/rAF listener would fire too late
 * to make it into the dump.
 */
const MEASURE_SCRIPT = `<script>
(() => {
  const page = document.querySelector('.page');
  const grid = document.querySelector('.grid');
  const pageRect = page ? page.getBoundingClientRect() : { width: 0, height: 0 };
  const line = document.querySelector('.line');
  let painted = 0;
  if (line) {
    const range = document.createRange();
    range.selectNodeContents(line);
    painted = Math.round(range.getBoundingClientRect().height);
  }
  // 傍点 lattice deviation: with line 0 plain and line 1 carrying .emr (both opening on the
  // SAME canary glyph), the first glyphs must sit exactly one pitch apart — the emr
  // counter-shift holding the grid against Chromium's emphasis-mark baseline push.
  const lines = document.querySelectorAll('.line');
  let emphDev = null;
  if (lines.length >= 2 && lines[1].classList.contains('emr')) {
    const gx = (el) => {
      const r = document.createRange();
      const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
      r.setStart(tn, 0); r.setEnd(tn, 1);
      return r.getBoundingClientRect().x;
    };
    emphDev = gx(lines[1]) - (gx(lines[0]) - lines[0].getBoundingClientRect().width);
  }
  // Ruby lane containment: the reading lane is out of flow, so a ruby box is exactly as tall
  // as its base spans; a lane that joined the flow (WebKit's <rt> rule, #65) adds the reading.
  // Measured against the base spans, not em: a fallback font without vertical metrics
  // advances a glyph by more than 1em (CI has no Hiragino).
  const ruby = document.querySelector('ruby');
  const baseExtent = ruby
    ? [...ruby.children].filter((c) => c.tagName === 'SPAN').reduce((n, s) => n + s.getBoundingClientRect().height, 0)
    : 0;
  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
  document.documentElement.setAttribute('${MARKER}', JSON.stringify({
    emphDev,
    rubyLaneSpillPx: ruby ? ruby.getBoundingClientRect().height - baseExtent : 0,
    writingMode: grid ? getComputedStyle(grid).writingMode : 'missing',
    rootFontSize: rootPx,
    pageWidth: pageRect.width,
    pageHeight: pageRect.height,
    lineCount: document.querySelectorAll('.line').length,
    linePitchPx: line ? line.getBoundingClientRect().width : 0,
    paintedExtent: painted,
    rubyCount: document.querySelectorAll('ruby').length,
    tcyCount: document.querySelectorAll('.tcy').length,
  }));
})();
</script>`;

interface VerifyMetrics {
  /** 傍点 glyph-lattice deviation in px, or null when line 1 carries no `.emr`. */
  readonly emphDev: number | null;
  /** The first ruby box's inline extent beyond its base spans, in px — 0 while the lane stays out of flow. */
  readonly rubyLaneSpillPx: number;
  readonly writingMode: string;
  readonly rootFontSize: number;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly lineCount: number;
  /** Rendered width of one .line column — the 行送り in device px. */
  readonly linePitchPx: number;
  readonly paintedExtent: number;
  readonly rubyCount: number;
  readonly tcyCount: number;
}

test('the built page renders vertically in a headless Chromium', BROWSER_SKIP, async () => {
  assert.ok(browser, 'JPNOV_E2E_REQUIRE_BROWSER=1 but no Chromium-family browser was found');
  assert.ok(builtHtml, 'the build leg must have produced an HTML artifact');
  assert.ok(builtHtml.includes('</body>'), 'built HTML must close <body> for script injection');

  const metrics = JSON.parse(await measurePage(browser, builtHtml, MEASURE_SCRIPT, 'hon', cleanups)) as VerifyMetrics;

  assert.equal(metrics.writingMode, 'vertical-rl', 'the page grid must flow vertical-rl');
  // Paper fit: on screen the page border box IS the physical paper (root font in mm) —
  // the same fitPaper numbers the PDF leg asserts in pt.
  const fit = fitPaper({
    charsPerLine: HTML_SETTINGS.charsPerLine,
    linesPerPage: HTML_SETTINGS.linesPerPage,
    linePitch: HTML_SETTINGS.linePitch,
    hTop: HEADER_BAND, // lineNumbers off in HTML_SETTINGS
    size: HTML_SETTINGS.paperSize,
    orientation: HTML_SETTINGS.paperOrientation,
  });
  const MM_TO_PX = 96 / 25.4;
  assert.ok(
    Math.abs(metrics.rootFontSize - fit.fontMm * MM_TO_PX) < 0.05,
    `root font must be the fitted physical size (${String(metrics.rootFontSize)}px vs ${String(fit.fontMm * MM_TO_PX)}px)`,
  );
  // Never larger than the paper (an overflowing sheet would spill onto a second printed
  // page); up to ~4.5px smaller — Chromium floors fractional border widths to whole CSS px
  // (the paper inset is a border), on top of the 0.02–0.04em emission slack.
  for (const [measured, paperPx] of [
    [metrics.pageWidth, fit.widthMm * MM_TO_PX],
    [metrics.pageHeight, fit.heightMm * MM_TO_PX],
  ] as const) {
    assert.ok(
      measured <= paperPx + 0.5 && measured >= paperPx - 4.5,
      `the page border box must be the paper (${String(metrics.pageWidth)}×${String(metrics.pageHeight)}px` +
        ` vs ${String(fit.widthMm)}×${String(fit.heightMm)}mm)`,
    );
  }
  assert.ok(
    Math.abs(metrics.linePitchPx - HTML_SETTINGS.linePitch * metrics.rootFontSize) < 0.25,
    `a line column must be exactly one 行送り wide (${String(metrics.linePitchPx)}px vs ${String(HTML_SETTINGS.linePitch * metrics.rootFontSize)}px)`,
  );
  assert.ok(metrics.lineCount >= 2, `expected multiple line columns, saw ${String(metrics.lineCount)}`);
  assert.ok(
    metrics.paintedExtent >= metrics.rootFontSize,
    `a line must paint at least one character tall (painted ${String(metrics.paintedExtent)}px)`,
  );
  assert.ok(metrics.rubyCount >= 1, 'the ruby annotation must reach the DOM');
  // 夜霧《よぎり》: the 3-kana reading lane must not inflate the box beyond its 2-glyph base.
  assert.ok(
    Math.abs(metrics.rubyLaneSpillPx) < 0.5,
    `a ruby box must be exactly as tall as its base spans (lane spill ${String(metrics.rubyLaneSpillPx)}px)`,
  );
  assert.ok(metrics.tcyCount >= 2, 'both 縦中横 units must reach the DOM');
});

test('the built page follows every 行送り tier (column width and fitted font track it)', BROWSER_SKIP, async () => {
  assert.ok(browser, 'JPNOV_E2E_REQUIRE_BROWSER=1 but no Chromium-family browser was found');
  const wsDir = await mkdtemp(join(tmpdir(), 'jpnov-e2e-pitch-'));
  cleanups.push(wsDir);
  const wsUri = pathToFileURL(wsDir).href.replace(/\/$/, '');
  // Line 0 plain, line 1 with 傍点, both opening on the same canary glyph — feeds the
  // measure script's emphDev lattice check.
  const pitchText = '中の本文。\n中傍点行［＃「傍点行」に傍点］。\n';
  await writeFile(join(wsDir, 'hon.jpnov'), pitchText, 'utf8');
  await writeFile(join(wsDir, 'hon.jpbook'), '---\ntitle: 試験本\n---\nhon.jpnov\n', 'utf8');
  const projectDirs = { [wsUri]: { outDir: 'dist' } };
  const MM_TO_PX = 96 / 25.4;

  for (const linePitch of LINE_PITCHES) {
    const result = await conn().request<BuildResult>('jpnov/build', {
      format: 'html',
      settings: { ...HTML_SETTINGS, linePitch },
      projectDirs,
    });
    assert.equal(result.ok, true, `@${String(linePitch)}: build must succeed`);
    const artifact = result.artifacts[0];
    assert.ok(artifact?.kind === 'html', `@${String(linePitch)}: build must emit the HTML artifact`);

    const fit = fitPaper({
      charsPerLine: HTML_SETTINGS.charsPerLine,
      linesPerPage: HTML_SETTINGS.linesPerPage,
      linePitch,
      hTop: HEADER_BAND,
      size: HTML_SETTINGS.paperSize,
      orientation: HTML_SETTINGS.paperOrientation,
    });
    const prefix = `pitch-${String(linePitch).replace('.', '_')}`;
    const m = JSON.parse(await measurePage(browser, artifact.content, MEASURE_SCRIPT, prefix, cleanups)) as VerifyMetrics;
    assert.ok(
      Math.abs(m.rootFontSize - fit.fontMm * MM_TO_PX) < 0.05,
      `@${String(linePitch)}: root font must track the pitch-fitted size (${String(m.rootFontSize)}px vs ${String(fit.fontMm * MM_TO_PX)}px)`,
    );
    // Same bound as the default-leg test: never past the paper, ≤ ~4.5px under it (border
    // widths snap down to whole CSS px on screen).
    for (const [measured, paperPx] of [
      [m.pageWidth, fit.widthMm * MM_TO_PX],
      [m.pageHeight, fit.heightMm * MM_TO_PX],
    ] as const) {
      assert.ok(
        measured <= paperPx + 0.5 && measured >= paperPx - 4.5,
        `@${String(linePitch)}: the page border box must stay the paper` +
          ` (${String(m.pageWidth)}×${String(m.pageHeight)}px vs ${String(fit.widthMm)}×${String(fit.heightMm)}mm)`,
      );
    }
    assert.ok(
      Math.abs(m.linePitchPx - linePitch * m.rootFontSize) < 0.25,
      `@${String(linePitch)}: a line column must be exactly one 行送り wide (${String(m.linePitchPx)}px vs ${String(linePitch * m.rootFontSize)}px)`,
    );
    // The .emr counter-shift must hold a 傍点 line on the glyph lattice at every tier ON ANY
    // ENGINE AND FONT: the emitted probe measures the real push beside a real line (the CSS
    // closed form alone is exact only for a+d = 1em fonts on Chromium ≤151 — CI's fallback
    // serif is not one — and Chromium 152 leaves a sub-pixel residue that a detached or
    // scaled probe misses).
    assert.ok(
      m.emphDev !== null && Math.abs(m.emphDev) < 0.75,
      `@${String(linePitch)}: a 傍点 line must stay on the glyph lattice (dev ${String(m.emphDev)}px)`,
    );
  }
});

/** The fixture both ダッシュ tests share: a plain configured pair and a 太字 pair. */
const DASH_TEXT = '　約束は――もう果たせない。\n　彼女は［＃太字］――［＃太字終わり］と黙った。\n';

/** Same parse-time trick as MEASURE_SCRIPT, for the bare-glyph ダッシュ advance. */
const DASH_MEASURE_SCRIPT = `<script>
(() => {
  const b = document.querySelector('.b');
  document.documentElement.setAttribute('${MARKER}', JSON.stringify({
    rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
    pairExtent: b ? b.getBoundingClientRect().height : 0,
  }));
})();
</script>`;

interface DashMetrics {
  readonly rootFontSize: number;
  readonly pairExtent: number;
}

test('ダッシュ stays a font glyph — the configured spelling is emitted as the em dash', async () => {
  // Dashes must NOT be drawn in CSS: a sub-pixel box pixel-snaps in print (the same Skia
  // lesson as the リーダー below); the em dash glyph joins a doubled pair on its own.
  const { html } = await conn().request<RenderFileResult>('jpnov/renderFile', {
    uri: 'file:///e2e/dash.jpnov',
    text: DASH_TEXT,
    settings: PREVIEW_SETTINGS,
  });
  assert.match(html, /約束は——もう/, 'the configured ― pair is typeset as an em dash pair');
  assert.match(html, /<span class="b">——<\/span>/, '太字 wraps the translated run');
  assert.doesNotMatch(html, /class="dash/, 'dashes ride the font, never a drawn substitute');
  assert.doesNotMatch(html, /―/, 'no source dash leaks untranslated (fixture has no tcy/ruby)');
});

test('a ダッシュ pair advances exactly two cells as bare glyphs', BROWSER_SKIP, async () => {
  assert.ok(browser, 'JPNOV_E2E_REQUIRE_BROWSER=1 but no Chromium-family browser was found');
  const { html } = await conn().request<RenderFileResult>('jpnov/renderFile', {
    uri: 'file:///e2e/dash.jpnov',
    text: DASH_TEXT,
    settings: PREVIEW_SETTINGS,
  });
  const m = JSON.parse(await measurePage(browser, html, DASH_MEASURE_SCRIPT, 'dash', cleanups)) as DashMetrics;
  // The .b span wraps exactly the translated pair; a full-width em dash advances one cell, so
  // any font substitution or kerning collapse shows up as a broken 2em extent.
  assert.ok(
    Math.abs(m.pairExtent - 2 * m.rootFontSize) < 1,
    `an em dash pair must fill two cells (${String(m.pairExtent)}px vs ${String(2 * m.rootFontSize)}px)`,
  );
});

test('リーダー stays a font glyph — no drawn substitute markup', async () => {
  // Leader dots must NOT be drawn in CSS: Chromium's Skia PDF backend quantizes sub-2pt
  // geometry (~0.5pt) and double-blits it, so drawn dots smear in the printed PDF.
  // Correct centred ellipses come from the JP-first default stack (css.ts DEFAULT_FONT_STACK).
  const { html } = await conn().request<RenderFileResult>('jpnov/renderFile', {
    uri: 'file:///e2e/ldr.jpnov',
    text: '　沈黙が……続く。\n',
    settings: PREVIEW_SETTINGS,
  });
  assert.match(html, /……/);
  assert.doesNotMatch(html, /class="ldr/, 'leaders ride the font, never a drawn substitute');
});

/** Same parse-time trick as MEASURE_SCRIPT, for the preview's edge-frame geometry. */
const EDGE_MEASURE_SCRIPT = `<script>
(() => {
  const seg = document.querySelector('.segment');
  const cs = seg ? getComputedStyle(seg, '::before') : null;
  document.documentElement.setAttribute('${MARKER}', JSON.stringify({
    rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
    lineCount: seg ? seg.querySelectorAll('.line').length : 0,
    segWidth: seg ? seg.getBoundingClientRect().width : 0,
    frameWidth: cs ? parseFloat(cs.width) : 0,
    ruleLayers: cs ? cs.backgroundImage.split('linear-gradient').length - 1 : 0,
  }));
})();
</script>`;

interface EdgeMetrics {
  readonly rootFontSize: number;
  readonly lineCount: number;
  readonly segWidth: number;
  readonly frameWidth: number;
  /** Background layers on the frame — edgeRules() emits one per interior column boundary. */
  readonly ruleLayers: number;
}

test('a ［＃改ページ］-shortened preview segment frames and rules a full page at every 行送り', BROWSER_SKIP, async () => {
  assert.ok(browser, 'JPNOV_E2E_REQUIRE_BROWSER=1 but no Chromium-family browser was found');
  for (const linePitch of LINE_PITCHES) {
    const { html } = await conn().request<RenderFileResult>('jpnov/renderFile', {
      uri: 'file:///e2e/edge.jpnov',
      text: CHAPTER_TEXT,
      settings: { ...PREVIEW_SETTINGS, edgeLine: 'red', linePitch },
    });

    const prefix = `edge-${String(linePitch).replace('.', '_')}`;
    const m = JSON.parse(await measurePage(browser, html, EDGE_MEASURE_SCRIPT, prefix, cleanups)) as EdgeMetrics;

    assert.equal(
      m.ruleLayers,
      PREVIEW_SETTINGS.linesPerPage - 1,
      `@${String(linePitch)}: one rule layer per interior column boundary must ride the frame background`,
    );
    assert.ok(
      m.lineCount >= 1 && m.lineCount < PREVIEW_SETTINGS.linesPerPage,
      `@${String(linePitch)}: the corpus must under-fill the page for this test (saw ${String(m.lineCount)} lines)`,
    );
    const fullPage = PREVIEW_SETTINGS.linesPerPage * linePitch * m.rootFontSize;
    assert.ok(
      Math.abs(m.segWidth - fullPage) < 2,
      `@${String(linePitch)}: a short segment must reserve the full page width (${String(m.segWidth)}px vs ${String(fullPage)}px)`,
    );
    // The frame (whose background carries the rules) must span it (−2px of its own borders).
    assert.ok(
      m.frameWidth > 0 && m.segWidth - m.frameWidth < 4,
      `@${String(linePitch)}: the frame must span the reserved width (frame ${String(m.frameWidth)}px, segment ${String(m.segWidth)}px)`,
    );
  }
});
