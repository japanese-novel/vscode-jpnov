/** clampInt rounds first, then holds the bounds. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampInt } from '../../../src/shared/utils/numbers.ts';

test('clampInt rounds, then clamps', () => {
  assert.equal(clampInt(4.4, 1, 10), 4);
  assert.equal(clampInt(4.5, 1, 10), 5);
  assert.equal(clampInt(-3, 1, 10), 1);
  assert.equal(clampInt(99, 1, 10), 10);
});
