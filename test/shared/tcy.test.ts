/**
 * Locks the 縦中横 width measure the layout engine and the syntax diagnostics share: half-width
 * units, a cluster headed by printable ASCII counting one and any other two.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TCY_MAX, tcyWidth } from '../../src/shared/tcy.ts';

test('tcyWidth: half-width clusters count 1, full-width 2, by the cluster head', () => {
  assert.equal(tcyWidth(''), 0);
  assert.equal(tcyWidth('12'), 2);
  assert.equal(tcyWidth('!?'), 2);
  assert.equal(tcyWidth('1868'), 4);
  assert.equal(tcyWidth('１２'), 4);
  assert.equal(tcyWidth('２０年'), 6);
  assert.equal(tcyWidth('12年'), 4);
  assert.equal(tcyWidth('12辻\u{E0100}'), 4); // the variation selector rides its kanji
  assert.equal(tcyWidth('‼'), 2); // a full-width glyph in the 明朝 fonts
  assert.equal(tcyWidth('a b'), 3); // a space is a half-width cluster
});

test('TCY_MAX: the width set small, and the widest not warned about', () => {
  assert.equal(TCY_MAX, 4);
});
