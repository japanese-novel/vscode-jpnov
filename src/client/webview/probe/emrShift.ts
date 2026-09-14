/**
 * 傍点 baseline-shift probe, the runtime companion of class.emr.css (mechanism and geometry there);
 * the compiler inlines it through css.ts emrProbe() and the website imports it. Two probe lines,
 * plain and emphasised, are laid out beside a laid-out real line at the page's own font size,
 * because the push depends on the line's formatting context and metrics rounding (Chromium 152
 * pushes the full band only out of flow; a hidden host measures zero). Styling is CSSOM only:
 * the preview webview's CSP strips markup style attributes.
 */

function probeLine(
  host: HTMLElement,
  emphasised: boolean,
): { readonly box: HTMLElement; readonly cell: HTMLElement } {
  const cell = document.createElement('span');
  cell.textContent = '永';
  if (emphasised) {
    cell.style.cssText = '-webkit-text-emphasis:filled sesame;text-emphasis:filled sesame';
  }
  const box = document.createElement('div');
  box.className = 'line';
  box.style.visibility = 'hidden';
  box.appendChild(cell);
  host.appendChild(box);
  return { box, cell };
}

/** The parent of the first laid-out line under `root`, an emphasised one first. */
function measurableHost(root: ParentNode): HTMLElement | null {
  for (const selector of ['.emr', '.line']) {
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      const line = el.closest<HTMLElement>('.line') ?? el;
      if (line.getClientRects().length > 0 && line.parentElement !== null) {
        return line.parentElement;
      }
    }
  }
  return null;
}

/**
 * Pins `--emr-shift` on `target`, in em of its font size, from a measurement beside a laid-out
 * line under `root`; clears it when nothing under `root` is laid out, so the stylesheet's
 * closed-form fallback applies until something is.
 */
export function pinEmrShift(root: ParentNode, target: HTMLElement): void {
  const host = measurableHost(root);
  if (host === null) {
    target.style.removeProperty('--emr-shift');
    return;
  }
  const plain = probeLine(host, false);
  const marked = probeLine(host, true);
  // The two glyphs must sit exactly one pitch apart; the excess is Chromium's baseline push.
  const pitch = plain.box.getBoundingClientRect().width;
  const push = plain.cell.getBoundingClientRect().x - marked.cell.getBoundingClientRect().x - pitch;
  plain.box.remove();
  marked.box.remove();
  if (pitch === 0) {
    target.style.removeProperty('--emr-shift');
    return;
  }
  const em = parseFloat(getComputedStyle(target).fontSize);
  target.style.setProperty('--emr-shift', `${String(Math.max(0, push / em))}em`);
}
