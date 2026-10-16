import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FIT, MAX_SCALE, WHOLE, frame, pad, union } from '../../src/stage/camera.ts';
import type { Box, Frac } from '../../src/stage/camera.ts';

const root: Box = { x: 0, y: 0, w: 1280, h: 620 };
/** The window beside its captions: right of the stage's centre, height-limited. */
const win: Box = { x: 358, y: 42, w: 858, h: 536 };

function covers(s: number, x: number, y: number): void {
  const w = s * win.w;
  const h = s * win.h;
  const left = win.x + win.w / 2 + x - w / 2;
  const top = win.y + win.h / 2 + y - h / 2;
  assert.ok(left <= root.x + 1e-9 && left + w >= root.x + root.w - 1e-9, `x: ${String(left)}..${String(left + w)}`);
  assert.ok(top <= root.y + 1e-9 && top + h >= root.y + root.h - 1e-9, `y: ${String(top)}..${String(top + h)}`);
}

test('the whole window is the identity, wherever the window sits in the clip box', () => {
  assert.deepEqual(frame(root, win, WHOLE), { s: 1, x: 0, y: 0 });
  assert.deepEqual(frame(root, { x: 0, y: 0, w: 1280, h: 800 }, WHOLE), { s: 1, x: 0, y: 0 });
});

test('a centred region scales to fit and stays put', () => {
  const region: Frac = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const f = frame(root, win, region);
  // height-limited: 620 / (0.5 * 536) * FIT
  assert.ok(Math.abs(f.s - (620 / 268) * FIT) < 1e-9);
  // the region's centre is the window's centre; only the clamp moves the window, to cover the root
  covers(f.s, f.x, f.y);
});

test('a region centred in the window lands on the clip box centre once zoomed', () => {
  const f = frame(root, win, { x: 0.25, y: 0.05, w: 0.5, h: 0.2 });
  assert.ok(f.s > 2);
  assert.equal(f.x, root.x + root.w / 2 - (win.x + win.w / 2));
  covers(f.s, f.x, f.y);
});

test('max caps the scale and the scale never drops below 1', () => {
  assert.equal(frame(root, win, { x: 0.4, y: 0.4, w: 0.05, h: 0.05 }).s, MAX_SCALE);
  assert.equal(frame(root, win, pad(WHOLE, 0.5, 0.5)).s, 1);
});

test('a region at the window edge, scaled past the clip box, keeps the box covered', () => {
  const sidebar: Frac = { x: 0.05, y: 0.3, w: 0.26, h: 0.35 };
  const f = frame(root, win, sidebar);
  assert.ok(f.s > 1);
  assert.ok(f.s * win.w > root.w, 'scaled wider than the root');
  covers(f.s, f.x, f.y);
  // the unclamped move would pull the window right by s * (0.5 - centre) * w; the clamp shortens it
  assert.ok(f.x < f.s * (0.5 - (sidebar.x + sidebar.w / 2)) * win.w);
});

test('a window that stays narrower than the clip box keeps inside it', () => {
  const small: Box = { x: 700, y: 100, w: 400, h: 250 };
  const f = frame(root, small, { x: 0.0, y: 0.4, w: 0.9, h: 0.2 });
  const w = f.s * small.w;
  const left = small.x + small.w / 2 + f.x - w / 2;
  assert.ok(f.s * small.w < root.w);
  assert.ok(left >= root.x - 1e-9 && left + w <= root.x + root.w + 1e-9, String(left));
});

test('union and pad', () => {
  assert.deepEqual(union([]), WHOLE);
  assert.deepEqual(
    union([
      { x: 0.1, y: 0.5, w: 0.25, h: 0.25 },
      { x: 0.25, y: 0.25, w: 0.25, h: 0.25 },
    ]),
    { x: 0.1, y: 0.25, w: 0.4, h: 0.5 },
  );
  assert.deepEqual(pad({ x: 0.25, y: 0.25, w: 0.25, h: 0.25 }, 0.125, 0.25), { x: 0.125, y: 0, w: 0.5, h: 0.75 });
});
