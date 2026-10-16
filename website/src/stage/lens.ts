/**
 * The camera on the DOM. Regions are measured as fractions of the window's layout box through
 * the offsetParent chain: transforms do not reach offsets, so neither the preview's slide nor
 * the camera's own scale skews a re-measure (and no measured element may centre itself with a
 * transform). The frame is read when a move's tween starts and again on every ScrollTrigger
 * refresh (invalidateOnRefresh).
 */
import { gsap } from 'gsap';

import { WHOLE, frame, pad, union } from './camera.ts';
import type { Box, Frac } from './camera.ts';

export type Region = () => Frac;

/** `el`'s layout box as fractions of `win`, or null when `el` is not laid out (display: none). */
function fracOf(win: HTMLElement, el: HTMLElement): Frac | null {
  let x = 0;
  let y = 0;
  let node: Element | null = el;
  while (node instanceof HTMLElement && node !== win) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent;
  }
  if (node !== win) {
    return null;
  }
  return { x: x / win.offsetWidth, y: y / win.offsetHeight, w: el.offsetWidth / win.offsetWidth, h: el.offsetHeight / win.offsetHeight };
}

/** The box around the laid-out elements of `els`; the whole window when none is. */
export function region(win: HTMLElement, els: readonly HTMLElement[]): Frac {
  return union(els.map((el) => fracOf(win, el)).filter((f): f is Frac => f !== null));
}

/**
 * Editor `rows` from the first one down, as wide as the gutter plus their longest text in the
 * code font with one character of air: the characters still to be typed are display: none, so
 * the text is counted, not measured. The whole window when the first row is not laid out.
 */
export function rowsRegion(win: HTMLElement, rows: readonly HTMLElement[]): Frac {
  const first = rows[0];
  const f = first === undefined ? null : fracOf(win, first);
  const gutter = first?.querySelector<HTMLElement>('.jp-g');
  if (first === undefined || f === null || gutter == null) {
    return WHOLE;
  }
  const chars = Math.max(...rows.map((row) => Array.from(row.querySelector('.jp-t')?.textContent ?? '').length));
  const em = parseFloat(getComputedStyle(first).fontSize);
  return { x: f.x, y: f.y, w: (gutter.offsetWidth + (chars + 1) * em) / win.offsetWidth, h: f.h * rows.length };
}

/** `el`'s box grown by `ems` of its own font size on every side; the whole window when it is not laid out. */
export function around(win: HTMLElement, el: HTMLElement, ems: number): Frac {
  const f = fracOf(win, el);
  if (f === null) {
    return WHOLE;
  }
  const em = parseFloat(getComputedStyle(el).fontSize) * ems;
  return pad(f, em / win.offsetWidth, em / win.offsetHeight);
}

function box(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** The window's box with its current camera transform undone. */
function restBox(win: HTMLElement): Box {
  const r = win.getBoundingClientRect();
  const s = Number(gsap.getProperty(win, 'scale'));
  const w = r.width / s;
  const h = r.height / s;
  return {
    x: r.left + r.width / 2 - Number(gsap.getProperty(win, 'x')) - w / 2,
    y: r.top + r.height / 2 - Number(gsap.getProperty(win, 'y')) - h / 2,
    w,
    h,
  };
}

/** The camera of `win` inside the clip box `root`, placing its moves on `tl`. */
export function camera(tl: gsap.core.Timeline, root: HTMLElement, win: HTMLElement): { to: (region: Region, at: number, duration: number) => void; back: (at: number, duration?: number) => void } {
  const to = (region: Region, at: number, duration: number): void => {
    const f = (): ReturnType<typeof frame> => frame(box(root), restBox(win), region());
    tl.to(win, { scale: () => f().s, x: () => f().x, y: () => f().y, duration, ease: 'power2.inOut' }, at);
  };
  return {
    to,
    back: (at, duration = 0.35) => {
      to(() => WHOLE, at, duration);
    },
  };
}
