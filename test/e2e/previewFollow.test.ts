/**
 * E2E for the preview's cursor follow (#133): a real `renderPreview` page runs the REAL preview
 * bundle in a headless Chromium against a stub `acquireVsCodeApi`. The bootstrap parks its cursor
 * at parse time; the probe then posts `reveal` messages, a reduced-motion stub making each park
 * immediate, and reports the column nearest the reveal position after each. Skips without a
 * discoverable browser unless `JPNOV_E2E_REQUIRE_BROWSER=1` (CI).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { PREVIEW_JS } from '../../src/client/preview/webviewBundle.generated.ts';
import type { PreviewInit } from '../../src/client/protocol.ts';
import { parse } from '../../src/shared/ast/parse.ts';
import { renderPreview } from '../../src/shared/compiler/preview.ts';
import { resolvePreviewSettings } from '../../src/shared/config/settings.ts';
import { CHARS_MAX, CHARS_MIN } from '../../src/shared/config/types.ts';

import { MARKER, measurePage } from './_headless.ts';
import { BROWSER_SKIP, browser, cleanups, removeCleanups } from './_setup.ts';

after(removeCleanups);

/** Characters per column: with 禁則 off, each chunk below fills exactly one column. */
const CPL = 16;

/** The chunk that opens a column of its paragraph, and where in its line it starts. */
interface Chunk {
  readonly head: string;
  readonly at: number;
}

/**
 * A paragraph of 24 one-column chunks, each a run of its own kana (`base` + n). After chunk 8 sits a
 * postfix annotation naming its last two characters; chunk 16 ends in a two-cell ruby.
 */
function paragraph(base: number): { text: string; chunks: Chunk[] } {
  let text = '';
  const chunks: Chunk[] = [];
  for (let n = 0; n < 24; n += 1) {
    const head = String.fromCodePoint(base + n);
    chunks.push({ head, at: text.length });
    text += n === 16 ? `${head.repeat(CPL - 2)}｜聖剣《せいけん》` : head.repeat(CPL);
    if (n === 8) {
      text += `［＃「${head.repeat(2)}」に傍点］`;
    }
  }
  return { text, chunks };
}

const A = paragraph(0x3042); // あ…
const B = paragraph(0x30a2); // ア…
/** Line 0 is paragraph A, lines 1–2 paint no column, line 3 is paragraph B. */
const SOURCE = `${A.text}\n［＃ここから２字下げ］\n［＃ここで字下げ終わり］\n${B.text}`;

/** The page as the host serves it: the rendered preview, the stubs and `__INIT`, the real bundle. */
function page(init: PreviewInit): string {
  const settings = resolvePreviewSettings({
    charsPerLine: CPL,
    linesPerPage: 34,
    linePitch: 2,
    fontFamily: '',
    kinsoku: 'none',
    dash: 'horizontalBar',
    lineNumbers: false,
    edgeLine: 'none',
  });
  const stubs = [
    '<script>window.__state = null;',
    'window.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => undefined, setState: (s) => { window.__state = s; } });',
    // Reduced motion: a `reveal` message parks at once instead of gliding frame by frame.
    'const media = window.matchMedia.bind(window);',
    'window.matchMedia = (q) => (q.includes("prefers-reduced-motion") ? { matches: true, media: q } : media(q));',
    `window.__INIT = ${JSON.stringify(init).replace(/</g, '\\u003c')};</script>`,
    `<script>${PREVIEW_JS}</script>`,
  ].join('');
  return renderPreview(parse(SOURCE), { ...settings, chrome: settings }).replace('</body>', () => `${stubs}</body>`);
}

/**
 * The parse-time probe: after the bootstrap park and after each `reveal` it posts, the column whose
 * centre is nearest the reveal position (the golden section from the left, scroll.ts), and how far
 * off it is; last, what the scroller persisted. A step's `uri` defaults to the page's own document.
 */
function probe(steps: readonly (readonly [name: string, line: number, character: number, uri?: string])[]): string {
  return `<script>
(() => {
  const x = () => window.innerWidth * (3 - Math.sqrt(5)) / 2;
  const parked = (name) => {
    let best = null;
    let off = Infinity;
    for (const el of document.querySelectorAll('.line')) {
      const r = el.getBoundingClientRect();
      const d = (r.left + r.right) / 2 - x();
      if (Math.abs(d) < Math.abs(off)) {
        best = el;
        off = d;
      }
    }
    return { name, line: best.getAttribute('data-line'), ch: best.getAttribute('data-ch'), head: best.textContent[0], off: Math.round(off * 100) / 100 };
  };
  const report = [parked('init')];
  for (const [name, line, character, uri] of ${JSON.stringify(steps)}) {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'reveal', uri: uri ?? window.__INIT.uri, line, character } }));
    report.push(parked(name));
  }
  document.documentElement.setAttribute('${MARKER}', JSON.stringify({ report, state: window.__state }));
})();
</script>`;
}

interface Parked {
  readonly name: string;
  readonly line: string | null;
  readonly ch: string | null;
  readonly head: string;
  readonly off: number;
}

/** The chunk the park should land on, as the probe reports it. */
function expected(name: string, line: number, chunk: Chunk): Omit<Parked, 'off'> {
  return { name, line: String(line), ch: chunk.at === 0 ? null : String(chunk.at), head: chunk.head };
}

test('the preview parks the column holding the cursor, at the reveal position', BROWSER_SKIP, async () => {
  assert.ok(browser, 'JPNOV_E2E_REQUIRE_BROWSER=1 but no Chromium-family browser was found');
  const chunk = (p: { chunks: Chunk[] }, n: number): Chunk => {
    const c = p.chunks[n];
    assert.ok(c);
    return c;
  };
  const annotation = chunk(A, 8).at + CPL + 3; // inside the postfix after chunk 8
  const reading = A.text.indexOf('せ') + 1; // inside the ruby reading of chunk 16
  const init: PreviewInit = {
    uri: 'file:///ws/a.jpnov',
    line: 0,
    character: chunk(A, 12).at + 5,
    layout: {
      charsPerLine: CPL,
      linesPerPage: 34,
      adjusted: false,
      min: CHARS_MIN,
      max: CHARS_MAX,
      labels: { chars: '字', lines: '行', charsPerLine: 'CPL', linesPerPage: 'LPP', hint: 'HINT', reset: 'RESET', save: 'SAVE', font: 'FONT', show: 'SHOW' },
    },
  };
  const steps = [
    ['annotation', 0, annotation],
    ['reading', 0, reading],
    ['directive', 1, 3],
    ['column head', 3, chunk(B, 10).at],
    // A reveal for another document (its render still in flight, #157): no park, no persist.
    ['other document', 0, chunk(A, 12).at, 'file:///ws/b.jpnov'],
  ] as const;
  const out = await measurePage(browser, page(init), probe(steps), 'follow', cleanups);
  const { report, state } = JSON.parse(out) as { report: Parked[]; state: unknown };

  for (const parked of report) {
    assert.ok(Math.abs(parked.off) < 1, `${parked.name}: parked ${String(parked.off)}px off the reveal position`);
  }
  assert.deepEqual(report.map(({ name, line, ch, head }) => ({ name, line, ch, head })), [
    expected('init', 0, chunk(A, 12)),
    expected('annotation', 0, chunk(A, 8)), // the column holding the text before the annotation
    expected('reading', 0, chunk(A, 16)), // the ruby's column
    expected('directive', 0, chunk(A, 23)), // a line with no column: the previous line's last
    expected('column head', 3, chunk(B, 10)),
    expected('other document', 3, chunk(B, 10)),
  ]);
  assert.deepEqual(state, { uri: 'file:///ws/a.jpnov', line: 3, character: chunk(B, 10).at });
});
