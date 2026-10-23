/**
 * The stage's entry, without GSAP: the motion window's timeline (mount.ts, which carries GSAP)
 * loads only where the motion query matches, and the 傍点 probe runs from scripts/emr.ts wherever
 * that module does not own it. A chunk that does not arrive puts the page back to its no-JS look
 * (the static sequence) and measures the 傍点 that now show.
 */
import { mountEmr } from '../scripts/emr.ts';
import type { Emr } from '../scripts/emr.ts';
import { MOTION_QUERY } from '../styles/tokens.ts';

export function mountStage(): void {
  const motion = matchMedia(MOTION_QUERY);
  // On a motion viewport nothing visible carries 傍点 before the chunk lands, so it pins first.
  let emr: Emr | null = motion.matches ? null : mountEmr();
  const load = (): void => {
    void import('./mount.ts').then((m) => m.runStage, () => null).then((runStage) => {
      if (runStage === null) {
        document.documentElement.classList.remove('jp-js');
        if (emr === null) {
          emr = mountEmr();
        } else {
          emr.pin();
        }
        return;
      }
      emr?.stop();
      runStage();
    });
  };
  if (motion.matches) {
    load();
  } else {
    motion.addEventListener('change', load, { once: true });
  }
}
