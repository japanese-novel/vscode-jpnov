/** The array helpers: append over any iterable, partitionPoint on every shape of prefix. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { append, partitionPoint } from '../../../src/shared/utils/lists.ts';

test('append pushes the items of any iterable, in order', () => {
  const into = [0];
  append(into, [1, 2]);
  append(into, new Set([3]));
  append(
    into,
    (function* () {
      yield 4;
    })(),
  );
  append(into, []);
  assert.deepEqual(into, [0, 1, 2, 3, 4]);
});

test('partitionPoint is the first index where the predicate holds', () => {
  const sorted = [1, 3, 3, 5, 8];
  const upperBound = (value: number): number => partitionPoint(sorted, (n) => n > value);
  assert.equal(upperBound(0), 0); // all above
  assert.equal(upperBound(1), 1);
  assert.equal(upperBound(3), 3); // past the duplicates
  assert.equal(upperBound(4), 3);
  assert.equal(upperBound(8), 5); // none above
  assert.equal(partitionPoint([], () => true), 0);
  assert.equal(partitionPoint([], () => false), 0);
});
