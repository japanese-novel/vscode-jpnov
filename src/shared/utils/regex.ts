/** Regular-expression source builders. */

/** `chars` as the body of a regex character class, the class metacharacters escaped. */
export function charClass(chars: Iterable<string>): string {
  return [...chars].map((c) => c.replace(/[\\\]^-]/g, '\\$&')).join('');
}

/** `s` as regex source matching itself: every metacharacter escaped. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
