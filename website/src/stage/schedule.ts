/** Label positions on the master timeline, derived from the beat budgets (gsap-free, testable). */
import type { Beat, BeatId } from './beats.ts';

export interface Label {
  readonly id: BeatId;
  readonly at: number;
  readonly duration: number;
}

export function schedule(beats: readonly Beat[]): { readonly labels: readonly Label[]; readonly total: number } {
  const labels: Label[] = [];
  let at = 0;
  for (const beat of beats) {
    labels.push({ id: beat.id, at, duration: beat.duration });
    at += beat.duration;
  }
  return { labels, total: at };
}

/**
 * ScrollTrigger's snap: the predicted landing progress snaps to a label only when within
 * `near` of it; otherwise the scroll stays where it is (`current`), never where inertia would
 * carry it — a wheel flick or a keyboard jump must not throw the reader across a beat.
 */
export function snapNearLabels(labels: readonly Label[], total: number, near = 0.03): (predicted: number, current: number) => number {
  const points = labels.map((l) => l.at / total);
  return (predicted, current) => {
    for (const p of points) {
      if (Math.abs(predicted - p) < near) {
        return p;
      }
    }
    return current;
  };
}
