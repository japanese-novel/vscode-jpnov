/**
 * The master timeline: five beats on one scrubbed, pinned ScrollTrigger. Continuous tweens touch
 * only transform and opacity; every layout change is a zero-duration set placed explicitly.
 */
import { gsap } from 'gsap';

import { BEATS } from './beats.ts';
import type { BeatId } from './beats.ts';
import { schedule, snapNearLabels } from './schedule.ts';
import { keystrokes, placeTyping } from './typing.ts';

/** Scroll distance per timeline second, in viewport heights. */
const VH_PER_SECOND = 0.5;
const STEP = 0.065;

function q(root: HTMLElement, key: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-t="${key}"]`);
  if (el === null) {
    throw new Error(`stage: missing [data-t="${key}"]`);
  }
  return el;
}

/** Each beat's caption crossfades in around its label, the previous one out; the first shows from the start. */
function captions(tl: gsap.core.Timeline, root: HTMLElement, labels: readonly { id: BeatId; at: number }[]): void {
  let prev: HTMLElement | undefined;
  for (const l of labels) {
    const cap = q(root, `cap-${l.id}`);
    if (prev !== undefined) {
      tl.to(prev, { autoAlpha: 0, y: -12, duration: 0.2 }, l.at - 0.15);
      tl.fromTo(cap, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.3 }, l.at + 0.05);
    }
    prev = cap;
  }
}

export function buildTimeline(root: HTMLElement): gsap.core.Timeline {
  const { labels, total } = schedule(BEATS);
  const at = (id: BeatId): number => {
    const label = labels.find((l) => l.id === id);
    if (label === undefined) {
      throw new Error(`stage: no beat ${id}`);
    }
    return label.at;
  };
  const win = q(root, 'win');
  const code = q(root, 'code');
  const editor = q(root, 'editor');
  const preview = q(root, 'preview');
  const page = q(root, 'page-wrap');
  const snap = snapNearLabels(labels, total);

  const tl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      trigger: root,
      start: 'top top',
      end: () => `+=${String(Math.round(total * VH_PER_SECOND * 100))}%`,
      pin: true,
      pinSpacing: true,
      anticipatePin: 1,
      scrub: 0.5,
      invalidateOnRefresh: true,
      snap: { snapTo: (value, self) => snap(value, self?.progress ?? value), duration: { min: 0.15, max: 0.5 }, delay: 0.05, ease: 'power1.out' },
      onUpdate: (self) => {
        root.dataset.progress = self.progress.toFixed(3);
      },
    },
  });
  for (const l of labels) {
    tl.addLabel(l.id, l.at);
  }
  tl.set({}, {}, total); // holds the timeline open to the last beat's end
  captions(tl, root, labels);

  // 書く: the author types three lines; Enter indents, 「 un-indents, brackets auto-close.
  let t = at('write');
  const writeSteps = keystrokes(code, 'write');
  let caret = placeTyping(tl, code, writeSteps, t + 0.25, STEP, null);

  // 確かめる: the preview opens beside the editor, then a 傍点 annotation is typed on line 5.
  t = at('check');
  const tip = q(root, 'tip-preview');
  tl.to(tip, { autoAlpha: 1, duration: 0.15 }, t);
  tl.to(tip, { autoAlpha: 0, duration: 0.1 }, t + 0.35);
  tl.set(editor, { width: '58%', flex: '0 0 58%' }, t + 0.35);
  tl.fromTo(preview, { xPercent: 100, autoAlpha: 0 }, { xPercent: 0, autoAlpha: 1, duration: 0.45, ease: 'power2.out' }, t + 0.35);
  tl.set(code, { '--cur': 4 }, t + 1.0);
  const checkSteps = keystrokes(code, 'check');
  caret = placeTyping(tl, code, checkSteps, t + 1.1, STEP, caret);
  tl.to(q(root, 'pv-A'), { autoAlpha: 0, duration: 0.2 }, t + 1.95);
  tl.to(q(root, 'pv-B'), { autoAlpha: 1, duration: 0.2 }, t + 1.95);

  // まとめる: 章を追加… picks 第二章, the row appears at the end and moves up.
  t = at('collect');
  const qp = q(root, 'qp');
  // Percentages of the rows' own height, so a resize or zoom after mount cannot misalign the swap.
  const row2 = q(root, 'row-3');
  const row3 = q(root, 'row-2');
  tl.fromTo(qp, { autoAlpha: 0, y: -6 }, { autoAlpha: 1, y: 0, duration: 0.25 }, t + 0.2);
  tl.set(q(root, 'qp-cb'), { className: 'jp-qi-cb jp-on' }, t + 0.7);
  tl.to(qp, { autoAlpha: 0, y: -6, duration: 0.15 }, t + 1.0);
  tl.set(row2, { display: 'flex' }, t + 1.15);
  tl.fromTo(row2, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 }, t + 1.15);
  tl.to(row2, { yPercent: -100, duration: 0.35, ease: 'power2.inOut' }, t + 1.7);
  tl.to(row3, { yPercent: 100, duration: 0.35, ease: 'power2.inOut' }, t + 1.7);

  // 整える: the warning on line 10, its quick fix, the fixed line and preview.
  t = at('fix');
  tl.set(code, { '--cur': 9 }, t);
  if (caret !== null) {
    tl.set(caret, { '--c': 0 }, t);
  }
  tl.fromTo(q(root, 'hover'), { autoAlpha: 0, y: 4 }, { autoAlpha: 1, y: 0, duration: 0.25 }, t + 0.15);
  tl.to(q(root, 'bulb'), { autoAlpha: 1, duration: 0.15 }, t + 0.45);
  tl.fromTo(q(root, 'menu'), { autoAlpha: 0, y: -4 }, { autoAlpha: 1, y: 0, duration: 0.25 }, t + 0.6);
  tl.set(q(root, 'fix-space'), { display: 'inline' }, t + 1.15);
  tl.set(q(root, 'sq'), { textDecorationLine: 'none' }, t + 1.15);
  tl.set(q(root, 'tab-warn'), { autoAlpha: 0 }, t + 1.15);
  tl.set(q(root, 'warn-1'), { autoAlpha: 0 }, t + 1.15);
  tl.set(q(root, 'warn-0'), { autoAlpha: 1 }, t + 1.15);
  tl.to([q(root, 'hover'), q(root, 'bulb'), q(root, 'menu')], { autoAlpha: 0, duration: 0.15 }, t + 1.15);
  tl.to(q(root, 'pv-B'), { autoAlpha: 0, duration: 0.25 }, t + 1.3);
  tl.to(q(root, 'pv-C'), { autoAlpha: 1, duration: 0.25 }, t + 1.3);

  // 一冊にする: 印刷／PDF 保存 — the window gives way to the printed page.
  t = at('book');
  tl.to(q(root, 'btn-print'), { scale: 0.97, duration: 0.1, yoyo: true, repeat: 1, transformOrigin: '50% 50%' }, t);
  tl.to(win, { scale: 0.96, autoAlpha: 0, duration: 0.65, ease: 'power2.in', transformOrigin: '50% 50%' }, t + 0.25);
  tl.fromTo(page, { autoAlpha: 0, y: 40, scale: 0.98 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.65, ease: 'power3.out', transformOrigin: '50% 50%' }, t + 0.35);
  const second = q(root, 'cap-book').querySelector<HTMLElement>('p + p');
  if (second !== null) {
    tl.fromTo(second, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3 }, t + 1.5);
  }

  return tl;
}
