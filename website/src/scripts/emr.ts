/**
 * The 傍点 probe where the stage does not run it: GSAP loads only under the motion query, and the
 * mounted stage pins on every ScrollTrigger refresh. On a narrow or reduced-motion viewport (and
 * when the stage's chunk does not arrive) this pins on load, when the fonts settle, and when the
 * width changes: the embeds take their em from the width, so a height-only resize (a phone's URL
 * bar) moves nothing. A section under content-visibility: auto is laid out by the probe's geometry
 * reads, so its lines are measured here too.
 */
import { pinEmrShift } from '../../../src/client/webview/probe/emrShift.ts';

export interface Emr {
  /** Measures and pins every `.emr` line now. */
  readonly pin: () => void;
  /** Ends the fonts and resize passes (and the frame one of them has queued). */
  readonly stop: () => void;
}

export function mountEmr(): Emr {
  const passes = new AbortController();
  let width = window.innerWidth;
  let frame: number | null = null;
  const pin = (): void => {
    frame = null;
    pinEmrShift(document);
  };
  const schedule = (): void => {
    if (!passes.signal.aborted) {
      frame ??= requestAnimationFrame(pin);
    }
  };
  pin();
  // That pin forced layout, which starts any webfont the text needs; settled fonts need no second pass.
  if (document.fonts.status !== 'loaded') {
    void document.fonts.ready.then(schedule);
  }
  window.addEventListener('resize', () => {
    if (window.innerWidth !== width) {
      width = window.innerWidth;
      schedule();
    }
  }, { signal: passes.signal });
  return {
    pin,
    stop: () => {
      passes.abort();
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    },
  };
}
