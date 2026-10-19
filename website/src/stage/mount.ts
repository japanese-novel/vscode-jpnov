/**
 * Mounts the stage: registers ScrollTrigger, runs the 傍点 probe on each of its refreshes (load,
 * fonts ready, resize), and builds the pinned timeline only where motion and a wide viewport
 * apply (the CSS shows the static sequence otherwise).
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

import { pinEmrShift } from '../../../src/client/webview/probe/emrShift.ts';
import { buildTimeline } from './timeline.ts';

const MOTION_QUERY = '(prefers-reduced-motion: no-preference) and (min-width: 56.25rem)';

export function mountStage(): void {
  const root = document.querySelector<HTMLElement>('[data-motion]');
  if (root === null) {
    return;
  }
  gsap.registerPlugin(ScrollTrigger);
  // A refresh first renders every scrubbed timeline at its start, so the window carries no
  // camera transform when the probe measures; the event fires with no triggers too.
  ScrollTrigger.addEventListener('revert', () => {
    pinEmrShift(document);
  });
  const mm = gsap.matchMedia();
  mm.add(MOTION_QUERY, () => {
    pinEmrShift(root);
    const tl = buildTimeline(root);
    return () => {
      tl.scrollTrigger?.kill();
      tl.kill();
    };
  });
  void document.fonts.ready.then(() => {
    ScrollTrigger.refresh();
  });
}
