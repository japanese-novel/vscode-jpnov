/**
 * 傍点 baseline-shift probe, the runtime companion of class.emr.css (mechanism and geometry there);
 * the compiler inlines it through css.ts emrProbe() and the website imports it. Every `.emr` line
 * is measured in place against a plain column appended to the same parent, because Chromium's
 * push depends on the column before the line and an unpushed glyph's offset carries the engine's
 * metric rounding. Styling goes through the CSSOM: the preview webview's CSP strips markup style
 * attributes.
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
 * How far the line's first glyph sits from the column's block-end edge, in px. Both rects carry
 * the line's current translate, so an earlier pin does not skew a re-measurement.
 */
function glyphOffset(line: HTMLElement): number | null {
  const glyph = referenceGlyph(line);
  const box = line.getBoundingClientRect();
  return glyph === null || box.width === 0 ? null : glyph.x - box.x;
}

/** The classes a probe column shares with the line (all but the shift itself), so it takes the line's font. */
function probeClass(line: HTMLElement): string {
  return [...line.classList].filter((name) => name !== 'emr').join(' ');
}

/** A plain probe column appended to `host`: its glyph offset is the unpushed offset for `className` lines there. */
function appendProbe(host: HTMLElement, className: string): HTMLElement {
  const box = document.createElement('div');
  box.className = className;
  box.style.visibility = 'hidden';
  box.textContent = '永';
  host.appendChild(box);
  return box;
}

/**
 * Pins `--emr-shift` on every `.emr` line under `root`, in em of the line's font size, from the
 * line's own push against the unpushed offset of a probe column beside it; a line with nothing to
 * measure loses its pin and takes the stylesheet's closed-form fallback. The DOM writes bracket
 * the reads, so every measurement shares one layout.
 */
export function pinEmrShift(root: ParentNode): void {
  // One probe column per parent and class set, shared by the lines it stands for.
  const probes = new Map<HTMLElement, Map<string, HTMLElement>>();
  const probeFor = (line: HTMLElement): HTMLElement | null => {
    const host = line.parentElement;
    if (host === null) {
      return null;
    }
    const byClass = probes.get(host) ?? new Map<string, HTMLElement>();
    probes.set(host, byClass);
    const className = probeClass(line);
    const probe = byClass.get(className) ?? appendProbe(host, className);
    byClass.set(className, probe);
    return probe;
  };
  const pairs = [...root.querySelectorAll<HTMLElement>('.emr')].map((line) => ({ line, probe: probeFor(line) }));
  const columns = [...probes.values()].flatMap((byClass) => [...byClass.values()]);
  let measured: { line: HTMLElement; push: number | null; em: number }[];
  try {
    const unpushed = new Map(columns.map((probe) => [probe, glyphOffset(probe)] as const));
    measured = pairs.map(({ line, probe }) => {
      const reference = probe === null ? null : (unpushed.get(probe) ?? null);
      const offset = glyphOffset(line);
      return {
        line,
        push: reference === null || offset === null ? null : reference - offset,
        em: parseFloat(getComputedStyle(line).fontSize),
      };
    });
  } finally {
    for (const probe of columns) {
      probe.remove();
    }
  }
  for (const { line, push, em } of measured) {
    if (push === null) {
      line.style.removeProperty('--emr-shift');
    } else {
      line.style.setProperty('--emr-shift', `${String(Math.max(0, push / em))}em`);
    }
  }
}
