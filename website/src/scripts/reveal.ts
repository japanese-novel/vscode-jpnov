/**
 * Scroll reveals: an element marked data-reveal="up" | "left" | "right" slides in from that side
 * and fades in as it scrolls into view, and slides back out when scrolled back above that point,
 * both on the same ease-out. Gated like the stage (motion allowed, tablet width up); global.css
 * pre-hides the marked elements under the same query so the first paint never flashes them. A
 * failure removes `html.js`, which shows them.
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

export const REVEAL_QUERY = '(prefers-reduced-motion: no-preference) and (min-width: 48rem)';

interface Offset {
  readonly x: number;
  readonly y: number;
}

/** Where each direction starts from, in px. */
const FROM = new Map<string, Offset>([
  ['up', { x: 0, y: 40 }],
  ['left', { x: -40, y: 0 }],
  ['right', { x: 40, y: 0 }],
]);
const HOME: Offset = { x: 0, y: 0 };

function targets(): { el: HTMLElement; out: Offset }[] {
  return [...document.querySelectorAll<HTMLElement>('[data-reveal]')].map((el) => {
    const dir = el.dataset.reveal ?? '';
    const out = FROM.get(dir);
    if (out === undefined) {
      throw new Error(`reveal: data-reveal="${dir}" is not a direction`);
    }
    return { el, out };
  });
}

export function mountReveal(): void {
  try {
    const all = targets();
    if (all.length === 0) {
      return;
    }
    gsap.registerPlugin(ScrollTrigger);
    gsap.matchMedia().add(REVEAL_QUERY, (context) => {
      for (const { el, out } of all) {
        // Added to the context so the query's revert (a narrower viewport) restores the element too.
        const move = (to: Offset, opacity: number): void => {
          context.add(() => {
            gsap.to(el, { ...to, opacity, duration: 0.9, ease: 'power1.out', overwrite: 'auto' });
          });
        };
        gsap.set(el, { ...out, opacity: 0 });
        // clamp(): an element in view when the page opens waits for the first scroll (and is out at the top).
        ScrollTrigger.create({
          trigger: el,
          start: 'clamp(top 80%)',
          onEnter: () => {
            move(HOME, 1);
          },
          onLeaveBack: () => {
            move(out, 0);
          },
        });
      }
    });
  } catch (err: unknown) {
    document.documentElement.classList.remove('js');
    console.error(err);
  }
}
