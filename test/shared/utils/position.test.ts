/** Positions order by line, then by character. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { comparePositions } from '../../../src/shared/utils/position.ts';

test('comparePositions: line first, then character', () => {
  const at = { line: 2, character: 5 };
  assert.equal(comparePositions(at, { line: 2, character: 5 }), 0);
  assert.ok(comparePositions(at, { line: 2, character: 9 }) < 0);
  assert.ok(comparePositions(at, { line: 2, character: 1 }) > 0);
  assert.ok(comparePositions(at, { line: 3, character: 0 }) < 0);
  assert.ok(comparePositions(at, { line: 1, character: 99 }) > 0);
});
