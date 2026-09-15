/**
 * Mounts the stage: registers ScrollTrigger, runs the 傍点 probes once fonts are ready, and
 * builds the pinned timeline only where motion and a wide viewport apply (the CSS shows the
 * static sequence otherwise). A failure removes `html.js`, which also reveals the static sequence.
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

import { probeAll } from '../scripts/emrProbe.ts';
import { buildTimeline } from './timeline.ts';

export const MOTION_QUERY = '(prefers-reduced-motion: no-preference) and (min-width: 56.25rem)';

export function mountStage(): void {
  const root = document.querySelector<HTMLElement>('[data-motion]');
  if (root === null) {
    return;
  }
  try {
    gsap.registerPlugin(ScrollTrigger);
    const mm = gsap.matchMedia();
    mm.add(MOTION_QUERY, () => {
      probeAll(root);
      const tl = buildTimeline(root);
      return () => {
        tl.scrollTrigger?.kill();
        tl.kill();
      };
    });
    void document.fonts.ready.then(() => {
      probeAll();
      ScrollTrigger.refresh();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        probeAll();
      }, 200);
    });
  } catch (err: unknown) {
    document.documentElement.classList.remove('jp-js');
    console.error(err);
  }
}
