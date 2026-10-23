/** HTML text and comment escaping. */

const UNSAFE = /[&<>"]/;

/**
 * Escapes the four characters that are unsafe in HTML text/attribute contexts:
 * `&`, `<`, `>`, and `"`. (`&` is replaced first so the entities it introduces are
 * not double-escaped.) Most calls hold none of the four: the layout escapes per character.
 */
export function escapeHtml(s: string): string {
  // One code unit above `>` (U+003E) is none of the four (U+0022, U+0026, U+003C, U+003E): the layout's per-character case, no regex.
  if (s.length === 1 && s.charCodeAt(0) > 0x3e) {
    return s;
  }
  if (!UNSAFE.test(s)) {
    return s;
  }
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Neutralizes a string for safe inclusion inside an HTML/XML comment body
 * (`<!-- ... -->`). Every `-` directly followed by another is broken with a space
 * (lookahead, so `----` cannot reconstitute a `--` the way a pairwise replace does),
 * a trailing `-` is padded (XML forbids a comment ending in `-`), and a stray `>` is
 * defused. The text is otherwise left verbatim (comments are not HTML-escaped).
 */
export function escapeComment(s: string): string {
  return s
    .replace(/-(?=-)/g, '- ')
    .replace(/-$/, '- ')
    .replace(/>/g, '&gt;');
}
