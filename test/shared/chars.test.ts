/**
 * Locks the kana composition the `.txt` codec and the noNfd fix share: it must agree with NFC on
 * every kana + combining mark pair and touch nothing else (神 U+FA19 must survive). And the display
 * strings: which characters no output carries, held to the XML 1.0 Char production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMBINING_KANA_MARKS,
  SINGLETONS,
  composeKana,
  composedChars,
  displayChars,
  displayText,
  dropUnshown,
  graphemeCount,
  graphemes,
  headChar,
  isClusterBoundary,
  isCombiningKanaMark,
} from '../../src/shared/chars.ts';
import { BEL, CLUSTERS, D, TSUJI } from './_kana.ts';
import { isXmlChar } from './xml.ts';

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

test('isCombiningKanaMark: the two combining marks only — not the spacing or half-width forms', () => {
  assert.ok(isCombiningKanaMark(0x3099) && isCombiningKanaMark(0x309a));
  for (const cp of [0x309b, 0x309c, 0xff9e, 0xff9f, 0x0301, 0x3098, 0x304b]) {
    assert.equal(isCombiningKanaMark(cp), false, cp.toString(16));
  }
  assert.deepEqual(`か${MARKS[0]}き${MARKS[1]}`.match(COMBINING_KANA_MARKS), [...MARKS]);
});

test('graphemeCount is the length of graphemes, on both of its paths', () => {
  for (const text of ['', 'あいう', '王都、聖剣。', ...CLUSTERS, CLUSTERS.join(''), `あ${CLUSTERS.join('い')}う`]) {
    assert.equal(graphemeCount(text), graphemes(text).length, text);
  }
});

// --------------------------------------------------------------- display strings

test('exactly the units XML cannot carry are dropped; a surrogate is left to its pair', () => {
  let dropped = 0;
  for (let unit = 0; unit <= 0xffff; unit++) {
    const ch = String.fromCharCode(unit);
    const kept = isXmlChar(unit) || (unit >= 0xd800 && unit <= 0xdfff);
    const label = `U+${unit.toString(16)}`;
    assert.equal(displayText(ch), kept ? ch : '', label);
    assert.equal(dropUnshown(`a${ch}b`), kept ? `a${ch}b` : 'ab', label);
    assert.deepEqual(displayChars(ch), kept ? [{ text: ch, start: 0, end: 1 }] : [], label);
    dropped += kept ? 0 : 1;
  }
  assert.ok(dropped > 0);
  for (const kept of ['\t\n\r', '\u007F', '\u0085', '\u200B', '\uFFFD', '\u{20BB7}', '\u{10FFFF}']) {
    assert.equal(displayText(kept), kept, JSON.stringify(kept));
    assert.equal(dropUnshown(kept), kept, JSON.stringify(kept));
  }
});

test('displayText drops first, then composes; dropUnshown composes nothing', () => {
  assert.equal(displayText(`王${BEL}都`), '王都');
  assert.equal(displayText(`\u304B${BEL}\u3099`), 'が'); // the pair meets once the character between is gone
  assert.equal(displayText(`${BEL}\u304B\u3099\uFFFE\uFFFF`), 'が');
  assert.equal(dropUnshown(`\u304B${BEL}\u3099`), '\u304B\u3099');
  assert.equal(dropUnshown('\u304B\u3099'), '\u304B\u3099');
});

test('displayText is idempotent, and is what displayChars spells', () => {
  const samples = ['', '王都', BEL, `王${BEL}都`, `\u304B${BEL}\u3099`, `\u304B\u3099${BEL}\u3099`, `${BEL}\u3099\u304B`, `\u{20BB7}${BEL}\uFFFE\u{20BB7}`, '\uD842\u0007\uDFB7'];
  for (const s of samples) {
    const shown = displayText(s);
    assert.equal(displayText(shown), shown, JSON.stringify(s));
    assert.equal(displayChars(s).map((ch) => ch.text).join(''), shown, JSON.stringify(s));
  }
});

test('displayChars: a dropped character belongs to no range, unless a composed kana spans it', () => {
  assert.deepEqual(displayChars(`あ${BEL}い`), [{ text: 'あ', start: 0, end: 1 }, { text: 'い', start: 2, end: 3 }]);
  assert.deepEqual(displayChars(`${BEL}\u{20BB7}${BEL}`), [{ text: '\u{20BB7}', start: 1, end: 3 }]);
  assert.deepEqual(displayChars(`\u304B${BEL}\u3099`), [{ text: 'が', start: 0, end: 3 }]);
});

test('displayChars: a surrogate pair split by a dropped character is one entry, like its code point', () => {
  const src = '\uD842\u0007\uDFB7x';
  const chars = displayChars(src);
  assert.deepEqual(chars.map((ch) => ch.text), Array.from(displayText(src)));
  assert.deepEqual(chars, [{ text: '\u{20BB7}', start: 0, end: 3 }, { text: 'x', start: 3, end: 4 }]);
});

test('the kana composition itself drops nothing', () => {
  for (const s of [BEL, `王${BEL}都`, `\u304B${BEL}\u3099`, '\uFFFE\uFFFF']) {
    assert.equal(composeKana(s), s, JSON.stringify(s));
    assert.equal(composedChars(s).map((ch) => ch.text).join(''), s, JSON.stringify(s));
  }
});

// --------------------------------------------------------------- grapheme clusters (#158)

test('graphemes: one cluster per written character, as the segmenter cuts them', () => {
  const clusters = [...CLUSTERS, '\u{20BB7}'];
  assert.deepEqual(graphemes(clusters.join('')), clusters);
  assert.deepEqual(graphemes('か\u309B'), ['か', '\u309B']); // the spacing 濁点 is a character of its own
  assert.deepEqual(graphemes(`か${D}`), [`か${D}`]); // composition is not this function's job
  assert.deepEqual(graphemes(''), []);
  assert.deepEqual(graphemes('　吾輩は猫である。'), Array.from('　吾輩は猫である。'));
});

test('graphemes: no code point of the fast path ever joins a cluster', () => {
  const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  for (let cp = 0; cp <= 0xffff; cp += 1) {
    const ch = String.fromCodePoint(cp);
    if (SINGLETONS.test(ch)) {
      assert.equal(Array.from(segmenter.segment(`${ch}a${ch}${ch}`)).length, 4, `U+${cp.toString(16)}`);
    }
  }
});

test('isClusterBoundary: between clusters only, never inside one nor at the ends', () => {
  const text = `あ${CLUSTERS.join('')}い`;
  const cuts = new Set<number>();
  let at = 0;
  for (const cluster of graphemes(text)) {
    cuts.add(at);
    at += cluster.length;
  }
  for (let i = 0; i <= text.length; i += 1) {
    assert.equal(isClusterBoundary(text, i), i > 0 && i < text.length && cuts.has(i), `at ${String(i)}`);
  }
  // The singleton fast path gives the same answer as the segmenter does on a long run.
  const long = `${'い'.repeat(100_000)}${TSUJI}${'い'.repeat(10)}`;
  assert.equal(isClusterBoundary(long, 50_000), true);
  assert.equal(isClusterBoundary(long, 100_000), true);
  assert.equal(isClusterBoundary(long, 100_001), false);
  assert.equal(isClusterBoundary(long, 100_002), false);
  assert.equal(isClusterBoundary(long, 100_003), true);
});

test('displayChars: one entry per cluster, composed, with its range in the source', () => {
  const src = `か${D}${CLUSTERS[0]}${BEL}い`;
  assert.deepEqual(displayChars(src), [
    { text: 'が', start: 0, end: 2 },
    { text: CLUSTERS[0], start: 2, end: 5 },
    { text: 'い', start: 6, end: 7 },
  ]);
  assert.deepEqual(displayChars(CLUSTERS.join('')).map((ch) => ch.text), [...CLUSTERS]);
});

test('headChar: the first code point, astral or not', () => {
  assert.equal(headChar(CLUSTERS[0]), '辻');
  assert.equal(headChar('\u{20BB7}\u{E0100}'), '\u{20BB7}');
  assert.equal(headChar('a'), 'a');
});
