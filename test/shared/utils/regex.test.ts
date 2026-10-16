/** The regex source builders: a character table makes a class, a literal matches itself. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { charClass, escapeRegExp } from '../../../src/shared/utils/regex.ts';

test('charClass escapes the class metacharacters, so any table of characters makes a class', () => {
  const re = new RegExp(`[${charClass(['a', '-', ']', '\\', '^', '。'])}]`, 'g');
  assert.deepEqual('xa-]\\^。z'.match(re), ['a', '-', ']', '\\', '^', '。']);
});

test('escapeRegExp makes a literal match itself and nothing else', () => {
  const literal = '［＃.*+?^${}()|[]\\「」';
  const re = new RegExp(`^${escapeRegExp(literal)}$`);
  assert.ok(re.test(literal));
  assert.equal(re.test(`${literal}x`), false);
  assert.equal(new RegExp(escapeRegExp('a.b')).test('axb'), false);
});
