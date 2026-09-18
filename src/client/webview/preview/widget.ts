/**
 * The preview's layout widget (runs in the preview panel's browser realm): a one-line summary
 * (chars per line × lines per page) that opens its inputs when clicked, posts each change to the
 * host as a preview-only override, and folds again when focus leaves it. While adjusted it is
 * framed yellow and gains reset and save buttons. The host swaps the whole document per render, so
 * the chip is rebuilt from `__INIT`; `layout.focus` names the input to re-focus when its own change
 * caused the render.
 */
import type { PreviewInit, PreviewLayoutKey, PreviewOutbound } from '../../protocol.ts';

import { svgGlyph } from '../svg.ts';
import { api } from './api.ts';

const layout = (window.__INIT as PreviewInit).layout;
const L = layout.labels;

/** How long a swapped-in document waits for the workbench to hand focus back before it folds the chip. */
const FOCUS_WINDOW_MS = 1000;

/**
 * Inline codicon paths (https://github.com/microsoft/vscode-codicons, CC BY 4.0): the preview
 * loads no assets, and a linked icon font would be re-requested on every render.
 */
const GLYPH: Record<'reset' | 'save', string> = {
  reset: 'M3.00098 2.5C3.00098 2.22386 3.22483 2 3.50098 2C3.77712 2 4.00098 2.22386 4.00098 2.5V6.34262L7.17202 3.17157C8.73412 1.60948 11.2668 1.60948 12.8289 3.17157C14.391 4.73367 14.391 7.26633 12.8289 8.82843L7.80375 13.8536C7.60849 14.0488 7.2919 14.0488 7.09664 13.8536C6.90138 13.6583 6.90138 13.3417 7.09664 13.1464L12.1218 8.12132C13.2933 6.94975 13.2933 5.05025 12.1218 3.87868C10.9502 2.70711 9.0507 2.70711 7.87913 3.87868L4.75781 7H8.50098C8.77712 7 9.00098 7.22386 9.00098 7.5C9.00098 7.77614 8.77712 8 8.50098 8H3.60098C3.26961 8 3.00098 7.73137 3.00098 7.4V2.5Z',
  save: 'M14.414 3.207L12.793 1.586C12.421 1.213 11.905 1 11.379 1H3C1.897 1 1 1.897 1 3V13C1 14.103 1.897 15 3 15H13C14.103 15 15 14.103 15 13V4.621C15 4.095 14.787 3.579 14.414 3.207ZM9 2V3.5C9 3.776 8.776 4 8.5 4H6.5C6.224 4 6 3.776 6 3.5V2H9ZM5 14V9.5C5 9.224 5.224 9 5.5 9H10.5C10.776 9 11 9.224 11 9.5V14H5ZM14 13C14 13.551 13.551 14 13 14H12V9.5C12 8.673 11.327 8 10.5 8H5.5C4.673 8 4 8.673 4 9.5V14H3C2.449 14 2 13.551 2 13V3C2 2.449 2.449 2 3 2H5V3.5C5 4.327 5.673 5 6.5 5H8.5C9.327 5 10 4.327 10 3.5V2H11.379C11.642 2 11.9 2.107 12.086 2.293L13.707 3.914C13.893 4.1 14 4.358 14 4.621V13Z',
};
function post(m: PreviewOutbound): void {
  api.postMessage(m);
}

/** A typed or stepped value, rounded and clamped to the input's bounds; NaN (cleared, non-numeric) → null. */
function clamp(n: number): number | null {
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.min(layout.max, Math.max(layout.min, Math.round(n)));
}

/** One grid input with its unit; commits on `change` (spinner, arrow keys, blur) and on Enter; Escape abandons the edit. */
function field(key: PreviewLayoutKey, unit: string, name: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(layout.min);
  input.max = String(layout.max);
  input.step = '1';
  input.value = String(layout[key]);
  input.setAttribute('aria-label', name);
  let current = layout[key];
  const commit = (): void => {
    const value = clamp(input.valueAsNumber);
    if (value === null) {
      input.value = String(current);
      return;
    }
    input.value = String(value);
    if (value !== current) {
      current = value;
      post({ type: 'layout', key, value });
      refreshSummary();
    }
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) {
      return; // an IME confirming digits, not a command
    }
    if (e.key === 'Enter') {
      commit();
    } else if (e.key === 'Escape') {
      input.value = String(current); // the blur's own change event then has nothing to commit
      input.blur();
    }
  });
  // The chip floats over text the author scrolls; a wheel over the focused input would step it instead.
  input.addEventListener('wheel', (e) => {
    if (document.activeElement === input) {
      e.preventDefault();
    }
  }, { passive: false });
  const label = document.createElement('label');
  label.className = 'jw-field';
  label.append(input, unit);
  return { label, input };
}

function iconButton(name: keyof typeof GLYPH, title: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jw-btn';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.append(svgGlyph('0 0 16 16', [GLYPH[name]]));
  button.addEventListener('click', () => {
    post({ type: name });
  });
  return button;
}

const chip = document.createElement('div');
chip.className = 'jw jw-collapsed';
chip.setAttribute('role', 'group');
chip.setAttribute('aria-label', L.hint);
chip.title = L.hint;
if (layout.adjusted) {
  chip.setAttribute('data-adjusted', '');
}
const cpl = field('charsPerLine', L.chars, L.charsPerLine);
const lpp = field('linesPerPage', L.lines, L.linesPerPage);
const times = document.createElement('span');
times.className = 'jw-x';
times.textContent = '×';

function expand(): void {
  chip.classList.remove('jw-collapsed');
}
function collapse(): void {
  chip.classList.add('jw-collapsed');
}

/** The folded chip's one line (the committed values); clicking opens the controls on the chars input. */
const summary = document.createElement('button');
summary.type = 'button';
summary.className = 'jw-summary';
/** Rewrites the folded line from the inputs (after a commit, so it shows what was set). */
function refreshSummary(): void {
  summary.textContent = `${cpl.input.value} ${L.chars} × ${lpp.input.value} ${L.lines}`;
}
refreshSummary();
summary.title = L.show;
summary.addEventListener('click', () => {
  expand();
  // Focused before the summary hides, so the summary's blur lands inside the chip (no fold).
  cpl.input.focus({ preventScroll: true });
});

// The chip hangs off the right edge, so the buttons go on the left: the inputs keep their place
// when the buttons appear and disappear.
chip.append(summary);
if (layout.adjusted) {
  chip.append(iconButton('reset', L.reset), iconButton('save', L.save));
}
chip.append(cpl.label, times, lpp.label);
// A press on the chip's own text or padding must not blur the focused input (which would fold it);
// the inputs and buttons keep their native focus behaviour.
chip.addEventListener('mousedown', (e) => {
  if (!(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
  }
});
// Focus leaving the chip (to the preview text, the editor, anywhere) folds it.
chip.addEventListener('focusout', (e) => {
  const to = e.relatedTarget;
  if (!(to instanceof Node) || !chip.contains(to)) {
    collapse();
  }
});
document.body.append(chip);

/**
 * The render came from `input`'s own change: open the chip at once and re-focus the input. The
 * workbench refocuses the new document only if the webview held focus before the swap (a window
 * `focus` after load), so wait for that instead of pulling focus from the editor; fold if it never comes.
 */
function restoreFocus(input: HTMLInputElement): void {
  expand();
  const grab = (): void => {
    input.focus({ preventScroll: true });
  };
  if (document.hasFocus()) {
    grab();
    return;
  }
  const settle = (): void => {
    window.removeEventListener('focus', grab);
    if (!chip.contains(document.activeElement)) {
      collapse();
    }
  };
  window.addEventListener('focus', grab, { once: true });
  window.addEventListener('mousedown', (e) => {
    if (!(e.target instanceof Node) || !chip.contains(e.target)) {
      settle();
    }
  }, { once: true, capture: true });
  setTimeout(settle, FOCUS_WINDOW_MS);
}

if (layout.focus !== undefined) {
  restoreFocus(layout.focus === 'charsPerLine' ? cpl.input : lpp.input);
}
