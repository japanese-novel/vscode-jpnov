import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planTyping } from '../../src/stage/typedLine.ts';

test('Enter shows the row with its auto-indent space, then one keystroke per character', () => {
  const chars = Array.from('　花子が、振り返《かえ》った。');
  const plan = planTyping(chars, 0, chars.length, 10, true);
  assert.equal(plan.rowShow, 10);
  assert.equal(plan.phantom, undefined);
  assert.deepEqual(plan.chars[0], { index: 0, k: 10, show: 10 });
  const open = plan.chars.find((c) => chars[c.index] === '《');
  const close = plan.chars.find((c) => chars[c.index] === '》');
  assert.ok(open !== undefined && close !== undefined);
  assert.equal(close.show, open.k, 'the auto-closed 》 appears with 《');
  assert.ok(close.k > open.k, 'typing over 》 is its own later keystroke');
  assert.equal(plan.next, 10 + chars.length);
});

test('a line opened with 「 drops the auto-indent space at that keystroke', () => {
  const chars = Array.from('「行こう」');
  const plan = planTyping(chars, 0, chars.length, 0, true);
  assert.deepEqual(plan.phantom, { show: 0, drop: 1 });
  assert.deepEqual(plan.chars[0], { index: 0, k: 1, show: 1 });
  assert.equal(plan.chars.at(-1)?.show, 1, 'the 」 appears with the 「');
  assert.equal(plan.next, 1 + chars.length);
});

test('a range inside an existing line types without Enter', () => {
  const chars = Array.from('　覚悟［＃「覚悟」に傍点］は、決まっていた。');
  const plan = planTyping(chars, 3, 13, 40, false);
  assert.equal(plan.rowShow, undefined);
  assert.equal(plan.chars.length, 10);
  assert.equal(plan.chars.find((c) => chars[c.index] === '］')?.show, 40);
  assert.equal(plan.next, 50);
});
