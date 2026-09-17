/**
 * 傍点 baseline-shift probe, the runtime companion of class.emr.css (mechanism and geometry there);
 * the compiler inlines it through css.ts emrProbe() and the website imports it. Every `.emr` line
 * is measured in place, because Chromium's push depends on the column before the line. The pin
 * goes through the CSSOM: the preview webview's CSP strips markup style attributes.
 */

/** Text off the glyph lattice: line-number heads, ruby readings, and 縦中横 runs (half-width rects). */
const OFF_LATTICE = '.ln, rt, .tcy';

/** The rect of the line's first on-lattice glyph, or null for a line without one. */
function referenceGlyph(line: HTMLElement): DOMRect | null {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, {
    acceptNode: (node: Node): number => {
      if (node.parentElement?.closest(OFF_LATTICE) !== null) {
        return NodeFilter.FILTER_REJECT;
      }
      return node instanceof Text && node.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const text = walker.nextNode();
  if (text === null) {
    return null;
  }
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 1);
  return range.getBoundingClientRect();
}

/**
 * The line's baseline push in px: how far its first glyph sits block-endward of the column's
 * centre, where the half-leading places an unpushed glyph. Both rects carry the line's current
 * translate, so an earlier pin does not skew a re-measurement.
 */
function linePush(line: HTMLElement): number | null {
  const glyph = referenceGlyph(line);
  const box = line.getBoundingClientRect();
  if (glyph === null || box.width === 0) {
    return null;
  }
  return (box.width - glyph.width) / 2 - (glyph.x - box.x);
}

/**
 * Pins `--emr-shift` on every `.emr` line under `root`, in em of the line's font size, from the
 * line's own push; a line with nothing to measure loses its pin and takes the stylesheet's
 * closed-form fallback. Every line is measured before any is pinned.
 */
export function pinEmrShift(root: ParentNode): void {
  const lines = [...root.querySelectorAll<HTMLElement>('.emr')].map((line) => ({ line, push: linePush(line) }));
  for (const { line, push } of lines) {
    if (push === null) {
      line.style.removeProperty('--emr-shift');
      continue;
    }
    const em = parseFloat(getComputedStyle(line).fontSize);
    line.style.setProperty('--emr-shift', `${String(Math.max(0, push / em))}em`);
  }
}
