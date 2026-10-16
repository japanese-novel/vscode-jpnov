/** isRecord admits what has readable properties and nothing else. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isRecord } from '../../../src/shared/utils/guards.ts';

test('isRecord: objects and arrays, never null or a primitive', () => {
  for (const yes of [{}, { a: 1 }, [], new Date(), new Error('x')]) {
    assert.ok(isRecord(yes));
  }
  for (const no of [null, undefined, 0, 1, '', 'a', true, Symbol('s'), 1n, () => undefined]) {
    assert.equal(isRecord(no), false, String(no));
  }
  const value: unknown = { ok: true };
  if (isRecord(value)) {
    assert.equal(value.ok, true); // readable without a cast
    assert.equal(value.missing, undefined);
  }
});
