/**
 * Locks the kana composition the `.txt` codec and the noNfd fix share: it must agree with NFC on
 * every kana + combining mark pair and touch nothing else (神 U+FA19 must survive).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeKana } from '../../src/shared/chars.ts';

const MARKS = ['\u3099', '\u309A'] as const;

test('every kana + combining mark pair composes exactly as NFC does', () => {
  let composed = 0;
  for (let cp = 0x3041; cp <= 0x30ff; cp++) {
    for (const mark of MARKS) {
      const pair = String.fromCodePoint(cp) + mark;
      const nfc = pair.normalize('NFC');
      assert.equal(composeKana(pair), nfc, `U+${cp.toString(16)} + U+${mark.codePointAt(0)?.toString(16) ?? ''}`);
      if (nfc !== pair) {
        composed += 1;
      }
    }
  }
  // 20 voiced + 5 semi-voiced in each script, ゔ ゞ, ヴ ヾ, and ヷヸヹヺ.
  assert.equal(composed, 58);
});

test('nothing else is touched', () => {
  const untouched = [
    '',
    'あいう',
    '\u3042\u3099', // あ: no composite exists
    'e\u0301', // Latin NFD is out of scope
    '\uFA19', // 神, a compatibility ideograph NFC would fold into U+795E
    '\uFF76\u3099', // half-width ｶ: no composite
    '\u31F0\u3099', // small ㇰ: no composite
    '\u{1B001}\u3099', // Kana Supplement: no composite
    '\u304C\u3099', // が + a second mark
    '\u3099', // a mark with nothing before it
    '\u3099\u304B',
    '\uDCB7\u3099', // a lone surrogate before the mark, as nfdRule's two-unit slice can hand over
    '\uD842\u3099',
    '\u{20BB7}\u3099', // an astral base
    '\u304B\uFE00\u3099', // a selector between base and mark
    '\u304B\u0301\u3099', // NFC would reorder the marks first; adjacent pairs only here
    '\u0301\u3099',
  ];
  for (const s of untouched) {
    assert.equal(composeKana(s), s, JSON.stringify(s));
  }
});

test('composes in context, by code point, one pair at a time', () => {
  assert.equal(composeKana('\u3042\u304B\u3099\u304D'), 'あがき');
  assert.equal(composeKana('\u{20BB7}\u304B\u3099'), '\u{20BB7}が'); // the astral character stays whole
  assert.equal(composeKana('\u304B\u3099\u3099'), 'が\u3099');
  assert.equal(composeKana('\u306F\u3099\u309A'), 'ば\u309A');
  assert.equal(composeKana('\u304B\u3099\u0301'), 'が\u0301');
});
