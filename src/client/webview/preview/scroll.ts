/**
 * The live preview's cursor-follow scroller (runs in the preview panel's browser realm). It parks
 * the paragraph whose `data-line` is the greatest value ≤ the target line at the {@link REVEAL_RATIO}
 * viewport position — synchronously at parse time (so the first paint is already parked, never a
 * frame at the origin), on `reveal` messages (with a {@link REVEAL_EASE} glide), on resize, and
 * re-asserted after load — and persists `{uri, line}` through the webview state API for the
 * window-reload serializer. History scroll restoration is forced to manual so a same-URL html swap
 * can't async-replay the old offset. The uri/line arrive via the host's `__INIT` bootstrap.
 */
import type { PreviewInit } from '../../protocol.ts';

import { api } from './api.ts';

/**
 * Viewport fraction (from the left edge) where the active column's centre parks; vertical-rl reads
 * right-to-left, so >0.5 keeps the larger share of the pane ahead (left) of the cursor line.
 */
const REVEAL_RATIO = 0.6180339887498949;

/** Per-frame fraction of the remaining distance the glide covers (~150ms to settle at 60fps). */
const REVEAL_EASE = 0.3;

const init = window.__INIT as PreviewInit;

// Each html swap is a same-URL navigation: Chromium may async-replay the previous document's scroll
// offset around load unless restoration is manual.
try {
  history.scrollRestoration = 'manual';
} catch {
  // Not supported in this webview runtime — the load-time re-assert below still corrects it.
}

let cur = init.line;

// Persist immediately and OUTSIDE rAF: rAF is suspended in hidden webviews, so a render finishing in
// a background panel would otherwise never reach setState.
function persist(line: number): void {
  api.setState({ uri: init.uri, line });
}
persist(cur);

const reducedMotion = matchMedia('(prefers-reduced-motion:reduce)').matches;
let anim = 0;

// Relative deltas sidestep vertical-rl's negative-scrollLeft origin; the dy term clamps to a no-op
// while the preview stays exact-fill with no vertical overflow.
function dst(t: Element): [number, number] {
  const r = t.getBoundingClientRect();
  return [
    (r.left + r.right) / 2 - window.innerWidth * REVEAL_RATIO,
    r.top + r.height / 2 - window.innerHeight / 2,
  ];
}

function reveal(line: number, glide?: boolean): void {
  cur = line;
  let t: Element | null = null;
  for (const n of document.querySelectorAll('[data-line]')) {
    const l = parseInt(n.getAttribute('data-line') ?? '', 10);
    if (Number.isNaN(l)) {
      continue;
    }
    if (l <= line) {
      t = n;
    } else {
      break;
    }
  }
  cancelAnimationFrame(anim);
  if (t === null) {
    return;
  }
  const target = t;
  if (glide !== true || reducedMotion) {
    const d = dst(target);
    window.scrollBy(d[0], d[1]);
    return;
  }
  // Exponential chase: recomputing the remaining delta every frame keeps it drift-free and
  // retarget-safe; the no-progress check ends the loop when an edge clamps the scroll.
  const step = (): void => {
    const d = dst(target);
    if (Math.abs(d[0]) < 1 && Math.abs(d[1]) < 1) {
      window.scrollBy(d[0], d[1]);
      return;
    }
    const x = window.scrollX;
    const y = window.scrollY;
    window.scrollBy(d[0] * REVEAL_EASE, d[1] * REVEAL_EASE);
    if (window.scrollX === x && window.scrollY === y) {
      return;
    }
    anim = requestAnimationFrame(step);
  };
  step();
}

// Synchronous at parse time (DOM complete before </body>, getBoundingClientRect forces layout): the
// first paint is already parked, never a frame at the origin.
reveal(cur);

window.addEventListener('message', (e: MessageEvent) => {
  const m: unknown = e.data;
  if (typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'reveal') {
    const line = (m as { line?: unknown }).line;
    if (typeof line === 'number') {
      reveal(line, true);
      persist(line);
    }
  }
});

let raf = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    reveal(cur);
  });
});

// Re-assert after load: corrects any load-time scroll mover that slipped past manual restoration.
window.addEventListener('load', () => {
  requestAnimationFrame(() => {
    reveal(cur);
  });
});
