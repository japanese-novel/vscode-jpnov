/** Plain string helpers. */

/** The index of the first character from `from` that is not ECMAScript whitespace (the full-width
 *  space U+3000 included); `text.length` when none follows. */
export function afterSpace(text: string, from = 0): number {
  return text.length - text.slice(from).trimStart().length;
}
