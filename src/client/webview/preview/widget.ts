/**
 * The preview's layout widget (runs in the preview panel's browser realm): a one-line summary
 * (chars per line × lines per page) that opens its inputs when clicked, posts each change to the
 * host as a preview-only override, and folds again when focus leaves it. While adjusted it is
 * framed yellow and gains reset and save buttons. The host swaps the whole document per render, so
 * the chip is rebuilt from `__INIT`; `layout.focus` names the input to re-focus when its own change
 * caused the render. A font button beside the summary stays visible either way: it opens the
 * host's font picker, which writes the settings.
 */
import type { PreviewInit, PreviewLayoutKey, PreviewOutbound } from '../../protocol.ts';
import { clampInt } from '../../../shared/utils/numbers.ts';

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
const GLYPH: Record<'reset' | 'save' | 'font', string> = {
  reset: 'M3.00098 2.5C3.00098 2.22386 3.22483 2 3.50098 2C3.77712 2 4.00098 2.22386 4.00098 2.5V6.34262L7.17202 3.17157C8.73412 1.60948 11.2668 1.60948 12.8289 3.17157C14.391 4.73367 14.391 7.26633 12.8289 8.82843L7.80375 13.8536C7.60849 14.0488 7.2919 14.0488 7.09664 13.8536C6.90138 13.6583 6.90138 13.3417 7.09664 13.1464L12.1218 8.12132C13.2933 6.94975 13.2933 5.05025 12.1218 3.87868C10.9502 2.70711 9.0507 2.70711 7.87913 3.87868L4.75781 7H8.50098C8.77712 7 9.00098 7.22386 9.00098 7.5C9.00098 7.77614 8.77712 8 8.50098 8H3.60098C3.26961 8 3.00098 7.73137 3.00098 7.4V2.5Z',
  font: 'M10.9699 2.32913C10.8981 2.13153 10.7103 2 10.5 2C10.2898 2 10.102 2.13153 10.0301 2.32913L6.46834 12.124L6.13267 11.3184C6.12991 11.3113 6.12699 11.3043 6.12391 11.2974L4.46155 7.30769C4.38391 7.12137 4.20186 7 4.00001 7C3.79816 7 3.6161 7.12137 3.53847 7.30769L1.8761 11.2974C1.87303 11.3043 1.87011 11.3113 1.86735 11.3184L1.03847 13.3077C0.932261 13.5626 1.0528 13.8553 1.3077 13.9615C1.5626 14.0677 1.85534 13.9472 1.96155 13.6923L2.66667 12H5.33334L6.03776 13.6906C6.03897 13.6935 6.04021 13.6965 6.04148 13.6994C6.06887 13.7624 6.10777 13.817 6.15467 13.8618C6.20148 13.9065 6.25776 13.9428 6.32193 13.9672C6.33406 13.9718 6.34638 13.976 6.35885 13.9797C6.46237 14.0102 6.56886 14.0056 6.66467 13.9721C6.67641 13.968 6.688 13.9635 6.69939 13.9585C6.76233 13.9312 6.81686 13.8924 6.86155 13.8456C6.90638 13.7987 6.94275 13.7423 6.96722 13.6781C6.96834 13.6751 6.96944 13.6722 6.9705 13.6692L8.30477 10H12.6952L14.0301 13.6709C14.1245 13.9304 14.4114 14.0643 14.6709 13.9699C14.9304 13.8755 15.0643 13.5886 14.9699 13.3291L10.9699 2.32913ZM10.5 3.96309L12.3316 9H8.6684L10.5 3.96309ZM4.00001 8.8L4.91668 11H3.08334L4.00001 8.8Z',
  save: 'M14.414 3.207L12.793 1.586C12.421 1.213 11.905 1 11.379 1H3C1.897 1 1 1.897 1 3V13C1 14.103 1.897 15 3 15H13C14.103 15 15 14.103 15 13V4.621C15 4.095 14.787 3.579 14.414 3.207ZM9 2V3.5C9 3.776 8.776 4 8.5 4H6.5C6.224 4 6 3.776 6 3.5V2H9ZM5 14V9.5C5 9.224 5.224 9 5.5 9H10.5C10.776 9 11 9.224 11 9.5V14H5ZM14 13C14 13.551 13.551 14 13 14H12V9.5C12 8.673 11.327 8 10.5 8H5.5C4.673 8 4 8.673 4 9.5V14H3C2.449 14 2 13.551 2 13V3C2 2.449 2.449 2 3 2H5V3.5C5 4.327 5.673 5 6.5 5H8.5C9.327 5 10 4.327 10 3.5V2H11.379C11.642 2 11.9 2.107 12.086 2.293L13.707 3.914C13.893 4.1 14 4.358 14 4.621V13Z',
};
function post(m: PreviewOutbound): void {
  api.postMessage(m);
}

/** A typed or stepped value, rounded and clamped to the input's bounds; NaN (cleared, non-numeric) → null. */
function clamp(n: number): number | null {
  return Number.isFinite(n) ? clampInt(n, layout.min, layout.max) : null;
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

// The foldable controls share one wrapper. The chip hangs off the right edge, so the reset / save
// buttons go on the left: the inputs keep their place when the buttons appear and disappear. The
// font button, shown folded or open, keeps the right end either way.
const controls = document.createElement('div');
controls.className = 'jw-controls';
if (layout.adjusted) {
  controls.append(iconButton('reset', L.reset), iconButton('save', L.save));
}
controls.append(cpl.label, times, lpp.label);
chip.append(summary, controls, iconButton('font', L.font));
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
