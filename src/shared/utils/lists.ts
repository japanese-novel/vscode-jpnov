/** Array helpers. */

/**
 * Appends `items` to `into` one by one: a spread call takes every item as an argument, and the
 * call stack bounds their number.
 */
export function append<T>(into: T[], items: Iterable<T>): void {
  for (const item of items) {
    into.push(item);
  }
}

/** The first index of `sorted` at which `isAbove` holds: false on a prefix, true on the suffix. */
export function partitionPoint<T>(sorted: readonly T[], isAbove: (item: T) => boolean): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const item = sorted[mid];
    if (item === undefined || isAbove(item)) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}
