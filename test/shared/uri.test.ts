/**
 * Pins the percent-encoding the server uses for the names it appends to client-supplied URIs.
 * The table is VS Code's (`Uri.toString()`): a drift here would silently break the string
 * identity between a server-enumerated book and the client's `Uri.joinPath` of the same file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { encodePathSegment, encodeRelPath } from '../../src/shared/uri.ts';

test('encodePathSegment escapes everything outside RFC 3986 unreserved, with uppercase hex', () => {
  // VS Code's own table (gen-delims, sub-delims, space), then whatever encodeURIComponent escapes.
  assert.equal(encodePathSegment(":/?#[]@!$&'()*+,;= "), '%3A%2F%3F%23%5B%5D%40%21%24%26%27%28%29%2A%2B%2C%3B%3D%20');
  assert.equal(encodePathSegment('%"<>\\^`{|}\t'), '%25%22%3C%3E%5C%5E%60%7B%7C%7D%09');
  assert.equal(encodePathSegment('AZaz09-._~'), 'AZaz09-._~');
  assert.equal(encodePathSegment('あ'), '%E3%81%82');
});

test('the encoding round-trips through fileURLToPath for the names the issue hit, and worse', () => {
  const names = [
    '進捗100%.jpbook',
    '第1巻#改稿.jpnov',
    'a?b.jpnov',
    'sub dir(1)+x.jpnov',
    'ガイド.jpnov'.normalize('NFD'),
    '😀.jpnov',
    '100%25already.jpnov',
  ];
  for (const name of names) {
    // POSIX rules on every platform: the unit suite also runs on Windows, where a drive letter is required.
    assert.equal(fileURLToPath(`file:///root/${encodePathSegment(name)}`, { windows: false }), `/root/${name}`, name);
  }
});

test('encodeRelPath encodes per segment, keeping the separators and the dot segments', () => {
  assert.equal(encodeRelPath('第1巻/../sub#1/./50%.jpnov'), '%E7%AC%AC1%E5%B7%BB/../sub%231/./50%25.jpnov');
});

test('a lone surrogate is an encoding error, not a silent substitution', () => {
  assert.throws(() => encodePathSegment('\uD800x'), URIError);
});
