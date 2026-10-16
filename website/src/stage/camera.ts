/**
 * The camera: how far the window scales toward a region and where it moves so that the region
 * sits in the clip box, without showing anything past the window's edge. Pure geometry in px
 * and fractions; lens.ts measures and applies it.
 */

/** A box: in px for the clip box and the window at rest, in fractions of the window for a region. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export type Frac = Box;

/** A transform about the window's centre: scale, then translate. */
export interface Frame {
  readonly s: number;
  readonly x: number;
  readonly y: number;
}

export const WHOLE: Frac = { x: 0, y: 0, w: 1, h: 1 };
/** The share of the clip box a region fills, and the scale the camera never exceeds. */
export const FIT = 0.8;
export const MAX_SCALE = 2.2;

/** The smallest box holding every one of `fracs`; the whole window for none. */
export function union(fracs: readonly Frac[]): Frac {
  if (fracs.length === 0) {
    return WHOLE;
  }
  const x0 = Math.min(...fracs.map((f) => f.x));
  const y0 = Math.min(...fracs.map((f) => f.y));
  const x1 = Math.max(...fracs.map((f) => f.x + f.w));
  const y1 = Math.max(...fracs.map((f) => f.y + f.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** `f` grown by `dx`, `dy` on every side. */
export function pad(f: Frac, dx: number, dy: number): Frac {
  return { x: f.x - dx, y: f.y - dy, w: f.w + 2 * dx, h: f.h + 2 * dy };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * The translate along one axis: the region's centre goes to the clip box's centre at MAX_SCALE
 * and to the window's own centre at scale 1 (so scale 1 is the identity), linearly between; then
 * the window is kept covering the clip box (scaled wider than it) or inside it (narrower).
 */
function axis(rootStart: number, rootSize: number, winStart: number, winSize: number, centre: number, s: number): number {
  const shift = rootStart + rootSize / 2 - (winStart + winSize / 2);
  const half = Math.abs(s * winSize - rootSize) / 2;
  return clamp((0.5 - centre) * s * winSize + shift * clamp((s - 1) / (MAX_SCALE - 1), 0, 1), shift - half, shift + half);
}

/** Scales the window so `region` fills FIT of the clip box, at most MAX_SCALE, never below 1. */
export function frame(root: Box, win: Box, region: Frac): Frame {
  const s = clamp(Math.min(root.w / (region.w * win.w), root.h / (region.h * win.h)) * FIT, 1, MAX_SCALE);
  return {
    s,
    x: axis(root.x, root.w, win.x, win.w, region.x + region.w / 2, s),
    y: axis(root.y, root.h, win.y, win.h, region.y + region.h / 2, s),
  };
}
