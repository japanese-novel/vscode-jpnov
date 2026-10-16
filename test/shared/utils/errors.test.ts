/** errorText reads an Error's message and stringifies anything else. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { errorText } from '../../../src/shared/utils/errors.ts';

test('errorText: the message of an Error, the string of anything else', () => {
  assert.equal(errorText(new Error('boom')), 'boom');
  assert.equal(errorText(42), '42');
});
