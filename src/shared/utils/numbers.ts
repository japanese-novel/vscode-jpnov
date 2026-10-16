/** `n` rounded to an integer, then clamped into `[min, max]`. */
export function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}
