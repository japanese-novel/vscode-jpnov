/**
 * Scroll reveals: an element marked data-reveal="up" | "left" | "right" slides in from that side
 * and fades in as its top crosses 80% of the viewport, and slides back out when scrolled back
 * below that line. global.css holds the offsets, the transition and the pre-hide under the same
 * query (REVEAL_QUERY), so the first paint never flashes them; here the class only flips. An
 * element in view when the page opens, or already passed, shows at once.
 */
import { REVEAL_QUERY } from '../styles/tokens.ts';

export function mountReveal(): void {
  const all = [...document.querySelectorAll<HTMLElement>('[data-reveal]')];
  if (all.length === 0) {
    return;
  }
  // The root ends at 80% of the viewport; the rect is viewport-relative, so a non-intersecting
  // element with its top above 0 has been scrolled past, one below it is still to come.
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      e.target.classList.toggle('jp-revealed', e.isIntersecting || e.boundingClientRect.top < 0);
    }
  }, { rootMargin: '0px 0px -20% 0px' });
  const query = matchMedia(REVEAL_QUERY);
  const apply = (): void => {
    if (query.matches) {
      for (const el of all) {
        observer.observe(el);
      }
    } else {
      observer.disconnect();
      for (const el of all) {
        el.classList.remove('jp-revealed');
      }
    }
  };
  apply();
  query.addEventListener('change', apply);
}
