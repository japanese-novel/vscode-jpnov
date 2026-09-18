/**
 * Locks the `.txt` codec. The Shift JIS table is derived from the runtime's own decoder, so the
 * digest is the drift alarm — if a future ICU changes the legacy index, an author's bytes change
 * silently and this fails first. A count alone would not catch it — two tables can agree on size
 * and disagree on bytes — so the assertions below pin every decision the builder makes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  encodeTxt,
  isShiftJisEncodable,
  TXT_ENCODINGS,
  TXT_ENCODING_DEFAULT,
  unencodableChars,
  type TxtEncoding,
} from '../../src/shared/encoding.ts';

/** The bytes one string encodes to, as lower-case hex — the shape every assertion reads in. */
function hex(text: string, encoding: TxtEncoding = 'shiftJis'): string {
  return [...encodeTxt(text, encoding).bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Every encodable code point, in order, canonicalized as `cp:bytes`. */
function tableEntries(): string[] {
  const out: string[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) {
      continue; // lone surrogates are not code points a manuscript can hold
    }
    if (isShiftJisEncodable(cp)) {
      out.push(`${cp.toString(16)}:${hex(String.fromCodePoint(cp)).replaceAll(' ', '')}`);
    }
  }
  return out;
}

test('the Shift JIS table is byte-for-byte what it was when this shipped', () => {
  const entries = tableEntries();
  assert.equal(entries.length, 7527);
  assert.equal(
    createHash('sha256').update(entries.join('\n')).digest('hex'),
    'e39e70de58bddf46afea3efb42109924b2d26a9a2247eea5464632b809390487',
  );
});

test('a JIS-side spelling encodes to the same cell as its CP932 partner', () => {
  // The decoder reports only the Microsoft spelling of each shared JIS X 0208 cell, so without the
  // alias overlay every left-hand character below would become 〓 — including the em dash that
  // `jpnov.lint.common.dash` offers.
  const pairs: readonly (readonly [string, string])[] = [
    ['—', '―'], ['〜', '～'], ['‖', '∥'], ['−', '－'], ['¢', '￠'], ['£', '￡'], ['¬', '￢'],
  ];
  for (const [jis, ms] of pairs) {
    assert.equal(hex(jis), hex(ms), `${jis} and ${ms} share a cell`);
  }
  assert.equal(hex('—'), '81 5c');
  assert.equal(hex('〜'), '81 60');
});

test('duplicated kanji take the IBM cell, not the NEC-selected one', () => {
  // Dropping index pointers 8272..8835 is what puts these in the 0xFA-0xFC block; skip it and they
  // encode to 0xED/0xEE, which Windows and Word read as a different character.
  assert.equal(hex('髙'), 'fb fc');
  assert.equal(hex('﨑'), 'fa b1');
  assert.equal(hex('ⅰ'), 'fa 40');
  // NEC row 13 is a legitimate CP932 block and must survive that exclusion.
  assert.equal(hex('①'), '87 40');
});

test("ASCII is identity, so the decoder's control-byte rotation stays out of the table", () => {
  assert.equal(hex('abc\r\n'), '61 62 63 0d 0a');
  assert.equal(hex('\x7f'), '7f');
  assert.equal(hex('\x1c'), '1c');
  assert.equal(hex('\x1a'), '1a');
  // The two encoder-only specials sit on bytes ASCII would otherwise claim.
  assert.equal(hex('¥'), '5c');
  assert.equal(hex('‾'), '7e');
});

test('Japanese prose encodes to its expected cells', () => {
  assert.equal(hex('あ'), '82 a0');
  assert.equal(hex('。'), '81 42');
  assert.equal(hex('〓'), '81 ac');
  assert.equal(hex('ｱ'), 'b1'); // half-width katakana is one byte
  assert.equal(hex('─'), '84 9f'); // the boxDrawing dash
});

test('an unencodable character becomes one 〓 and is counted', () => {
  for (const ch of ['𠮷', '😀', 'é']) {
    const result = encodeTxt(ch, 'shiftJis');
    assert.equal(hex(ch), '81 ac', `${ch} -> 〓`);
    // Astral characters are two UTF-16 units but ONE code point, so they cost exactly one 〓.
    assert.equal(result.substitutions, 1);
  }
  assert.equal(encodeTxt('あ😀い😀', 'shiftJis').substitutions, 2);
  assert.equal(encodeTxt('あいう', 'shiftJis').substitutions, 0);
});

test('characters with no Shift JIS cell stay unencodable', () => {
  // A best-fit table added later would silently change an author's text; these guard against one.
  for (const ch of ['¦', '–', '‑', '∣', '¯', '𠮷', '😀']) {
    assert.equal(isShiftJisEncodable(ch.codePointAt(0) ?? 0), false, ch);
  }
  for (const ch of ['あ', '髙', '①', '—', '〜', '−', 'A']) {
    assert.equal(isShiftJisEncodable(ch.codePointAt(0) ?? 0), true, ch);
  }
});

test('UTF-8 passes everything through, with the BOM only when asked', () => {
  assert.equal(hex('あ😀', 'utf8'), 'e3 81 82 f0 9f 98 80');
  assert.equal(hex('あ😀', 'utf8Bom'), 'ef bb bf e3 81 82 f0 9f 98 80');
  assert.equal(encodeTxt('😀', 'utf8').substitutions, 0);
  assert.equal(encodeTxt('😀', 'utf8Bom').substitutions, 0);
});

test('the default encoding is a member of the enum', () => {
  assert.ok(TXT_ENCODINGS.includes(TXT_ENCODING_DEFAULT));
  assert.equal(TXT_ENCODING_DEFAULT, 'shiftJis');
});

test('one written character costs one 〓, however many code points it took', () => {
  // A fixed-width vertical grid gives each written character one square, so a cluster that cannot
  // be written at all must not expand into several 〓 and shove the rest of the line along.
  const clusters: readonly (readonly [string, string])[] = [
    ['emoji presentation', '\u2764\uFE0F'],
    ['skin tone', '\u{1F44D}\u{1F3FD}'],
    ['flag', '\u{1F1EF}\u{1F1F5}'],
    ['ZWJ family', '\u{1F468}\u200D\u{1F469}\u200D\u{1F466}'],
  ];
  for (const [name, s] of clusters) {
    const result = encodeTxt(s, 'shiftJis');
    assert.equal(hex(s), '81 ac', name);
    assert.equal(result.substitutions, 1, name);
  }
});

test('whatever of a cluster can be written is written', () => {
  // 辻 is representable and its variation selector is not, so the kanji survives and only the
  // glyph-variant request is dropped — 〓 would cost a square AND lose the character.
  assert.equal(hex('\u8FBB\u{E0100}'), '92 d2');
  assert.equal(encodeTxt('\u8FBB\u{E0100}', 'shiftJis').substitutions, 0);
  // A combining mark nothing composes with goes the same way: the base is written, uncounted, and
  // the noNfd / shiftJisSafe lints are what report it.
  const leftovers: readonly (readonly [string, string, string])[] = [
    ['あ + dakuten', '\u3042\u3099', '82 a0'],
    ['が + a second dakuten', '\u304C\u3099', '82 aa'],
    ['か + two dakuten', '\u304B\u3099\u3099', '82 aa'],
    ['か + dakuten + acute', '\u304B\u3099\u0301', '82 aa'],
    ['half-width ｶ + dakuten', '\uFF76\u3099', 'b6'],
  ];
  for (const [name, s, bytes] of leftovers) {
    assert.equal(hex(s), bytes, name);
    assert.equal(encodeTxt(s, 'shiftJis').substitutions, 0, name);
  }
  // A mark with nothing before it is a cluster of its own, and it has no cell.
  assert.equal(hex('\u3099'), '81 ac');
  assert.equal(hex('\r\n\u3099'), '0d 0a 81 ac');
  assert.equal(encodeTxt('\r\n\u3099', 'shiftJis').substitutions, 1);
});

test('a decomposed kana is composed before it is encoded', () => {
  // か + U+3099 is one written character, が (issue #83).
  assert.equal(hex('\u304B\u3099'), '82 aa');
  assert.equal(encodeTxt('\u304B\u3099', 'shiftJis').substitutions, 0);
  assert.equal(hex('\u306F\u309A'), '82 cf'); // は + combining handakuten -> ぱ
  assert.equal(hex('\u30A6\u3099'), '83 94'); // ウ + combining dakuten -> ヴ
  assert.equal(hex('\u309D\u3099'), '81 55'); // ゝ -> ゞ
  assert.equal(hex('\u30FD\u3099'), '81 53'); // ヽ -> ヾ
  assert.equal(hex('\u3042\u304B\u3099\u304D'), hex('あがき'));
  // UTF-8 holds the decomposed form as it came.
  assert.equal(hex('\u304B\u3099', 'utf8'), 'e3 81 8b e3 82 99');
});

test('a composite Shift JIS lacks costs one 〓 and is counted', () => {
  // ゔ and ヷヸヹヺ exist only in JIS X 0213, so the composite has no cell and the cluster is one 〓.
  for (const base of ['\u3046', '\u30EF', '\u30F0', '\u30F1', '\u30F2']) {
    const s = `${base}\u3099`;
    assert.equal(hex(s), '81 ac', s);
    assert.equal(encodeTxt(s, 'shiftJis').substitutions, 1, s);
  }
  assert.equal(encodeTxt('\u3042\u3099\u3046\u3099', 'shiftJis').substitutions, 1);
});

test('only kana compose — the text is never NFC-normalized', () => {
  // 神 U+FA19 is a compatibility ideograph with its own IBM-extension cell; NFC folds it into
  // 神 U+795E, a different cell, which would rewrite a personal name on the way to disk.
  assert.equal(hex('\uFA19'), 'fb 7e');
  assert.notEqual(hex('\uFA19'), hex('\u795E'));
  assert.deepEqual(unencodableChars('\uFA19'), []);
});

test('a cluster is reported once, quoting the whole character', () => {
  const [heart] = unencodableChars('\u2764\uFE0F');
  assert.ok(heart);
  assert.equal(heart.cluster, '\u2764\uFE0F'); // what the author sees
  assert.equal(heart.cp, 0x2764); // the code point the range lands on
  assert.equal(heart.length, 1);
  assert.equal(unencodableChars('\u{1F468}\u200D\u{1F469}\u200D\u{1F466}').length, 1);
  // The kanji is fine; the cluster is still reported, because its variant selection is lost.
  const [tsuji] = unencodableChars('\u8FBB\u{E0100}');
  assert.ok(tsuji);
  assert.equal(tsuji.cluster, '\u8FBB\u{E0100}');
  assert.equal(tsuji.cp, 0xe0100);
  assert.equal(tsuji.offset, 1); // the selector, not the kanji
  assert.deepEqual(unencodableChars('\u3042\u3044\u3046'), []);
});

test('the scanner composes kana the same way, so lint and build agree', () => {
  assert.deepEqual(unencodableChars('\u304B\u3099'), []); // か + U+3099 is written as が
  // う + U+3099 composes to ゔ, which has no cell: reported on the RAW mark, the same range the
  // noNfd rule reports, so the engine can de-duplicate the two.
  const [u] = unencodableChars('\u3046\u3099');
  assert.ok(u);
  assert.deepEqual(u, { cluster: '\u3046\u3099', cp: 0x3099, offset: 1, length: 1 });
  const [astral] = unencodableChars('\u{20BB7}\u3099');
  assert.ok(astral);
  assert.equal(astral.cp, 0x20bb7);
  assert.equal(astral.offset, 0);
  assert.equal(astral.length, 2);
  const [lone] = unencodableChars('\u3099\u304B');
  assert.ok(lone);
  assert.equal(lone.offset, 0);
});
