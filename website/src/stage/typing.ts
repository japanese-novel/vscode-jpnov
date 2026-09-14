/**
 * Places the typing keystrokes on the timeline from the DOM's `data-k` / `data-show` /
 * `data-drop` markers (stage/typedLine.ts wrote them): one zero-duration set per keystroke, so
 * scrubbing backwards is exact. The caret is `.ch::after`, driven by the `--c` custom property.
 */
import type { gsap } from 'gsap';

import type { TypingRun } from './typedLine.ts';

export interface Keystroke {
  readonly k: number;
  readonly show: readonly HTMLElement[];
  readonly drop: readonly HTMLElement[];
  readonly caret: HTMLElement | null;
  readonly row: HTMLElement | null;
}

function num(el: Element, name: string): number | null {
  const v = el.getAttribute(name);
  return v === null ? null : Number(v);
}

/** The keystrokes of one run (`data-run`), in order. */
export function keystrokes(code: HTMLElement, run: TypingRun): Keystroke[] {
  const byK = new Map<number, { show: HTMLElement[]; drop: HTMLElement[]; caret: HTMLElement | null; row: HTMLElement | null }>();
  const at = (k: number): NonNullable<ReturnType<typeof byK.get>> => {
    let entry = byK.get(k);
    if (entry === undefined) {
      entry = { show: [], drop: [], caret: null, row: null };
      byK.set(k, entry);
    }
    return entry;
  };
  for (const el of code.querySelectorAll<HTMLElement>(`[data-run="${run}"]`)) {
    const show = num(el, 'data-show');
    const k = num(el, 'data-k');
    const drop = num(el, 'data-drop');
    if (show !== null) {
      const entry = at(show);
      entry.show.push(el);
      if (el.classList.contains('ln')) {
        entry.row = el;
      }
    }
    if (k !== null && el.classList.contains('ch')) {
      at(k).caret = el;
    }
    if (drop !== null) {
      at(drop).drop.push(el);
    }
  }
  return [...byK.entries()].sort((a, b) => a[0] - b[0]).map(([k, e]) => ({ k, ...e }));
}

/** Schedules `steps` from `start`, one every `step` seconds; returns the caret left at the end. */
export function placeTyping(tl: gsap.core.Timeline, code: HTMLElement, steps: readonly Keystroke[], start: number, step: number, caretFrom: HTMLElement | null): HTMLElement | null {
  let caret = caretFrom;
  steps.forEach((s, i) => {
    const t = start + i * step;
    for (const el of s.show) {
      tl.set(el, { display: el.classList.contains('ln') ? 'flex' : 'inline' }, t);
    }
    for (const el of s.drop) {
      tl.set(el, { display: 'none' }, t);
    }
    if (s.row !== null) {
      tl.set(code, { '--cur': Number(s.row.dataset.line ?? '1') - 1 }, t);
    }
    if (s.caret !== null) {
      if (caret !== null) {
        tl.set(caret, { '--c': 0 }, t);
      }
      tl.set(s.caret, { '--c': 1 }, t);
      caret = s.caret;
    }
  });
  return caret;
}
