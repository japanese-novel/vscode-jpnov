import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectImplicitBase, tokenize } from '../../../src/shared/compiler/tokenizer.ts';

test('detectImplicitBase walks back over a maximal Kanji run', () => {
  assert.deepEqual(detectImplicitBase('前置き漢字'), { base: '漢字', rest: '前置き' });
});

test('detectImplicitBase treats the five spec marks 仝々〆〇ヶ as Kanji', () => {
  assert.deepEqual(detectImplicitBase('人々'), { base: '人々', rest: '' });
  assert.deepEqual(detectImplicitBase('〆切'), { base: '〆切', rest: '' });
  // 三ヶ月: digits class breaks before ヶ月? 三 is kanji, ヶ kanji, 月 kanji => all one run.
  assert.deepEqual(detectImplicitBase('三ヶ月'), { base: '三ヶ月', rest: '' });
  // 〇 (U+3007) is kanji per the spec's 「仝々〆〇ヶ」 list — a numeral like 一〇八 is ONE run.
  assert.deepEqual(detectImplicitBase('一〇八'), { base: '一〇八', rest: '' });
  assert.deepEqual(detectImplicitBase('〇'), { base: '〇', rest: '' });
  // 仝 (U+4EDD) sits inside the CJK unified block — covered by the range, pinned here.
  assert.deepEqual(detectImplicitBase('仝'), { base: '仝', rest: '' });
});

test('〇 ruby forms a whole-run implicit base end-to-end', () => {
  assert.deepEqual(tokenize('一〇八《いちまるはち》'), [
    { kind: 'rubyImplicit', raw: '一〇八《いちまるはち》', base: '一〇八', reading: 'いちまるはち' },
  ]);
  assert.deepEqual(tokenize('〇《まる》'), [
    { kind: 'rubyImplicit', raw: '〇《まる》', base: '〇', reading: 'まる' },
  ]);
});

test('detectImplicitBase includes Hiragana as its own class (pure-hiragana base)', () => {
  assert.deepEqual(detectImplicitBase('あのひと'), { base: 'あのひと', rest: '' });
  // A preceding Kanji is a different class, so it is excluded from a hiragana base.
  assert.deepEqual(detectImplicitBase('彼のひと'), { base: 'のひと', rest: '彼' });
});

test('detectImplicitBase walks back over a Katakana run incl. the ー mark', () => {
  assert.deepEqual(detectImplicitBase('東京タワー'), { base: 'タワー', rest: '東京' });
});

test('detectImplicitBase treats ASCII + fullwidth alnum as one class', () => {
  assert.deepEqual(detectImplicitBase('ABC'), { base: 'ABC', rest: '' });
  assert.deepEqual(detectImplicitBase('Ｗｅｂ'), { base: 'Ｗｅｂ', rest: '' });
  assert.deepEqual(detectImplicitBase('版2024'), { base: '2024', rest: '版' });
});

test('detectImplicitBase stops at a class change', () => {
  // Hiragana then Kanji: only the trailing Kanji run is the base.
  assert.deepEqual(detectImplicitBase('はしる人'), { base: '人', rest: 'はしる' });
});

test('detectImplicitBase stops at space / punctuation / ［ and yields no base', () => {
  assert.deepEqual(detectImplicitBase('漢字 '), { base: '', rest: '漢字 ' });
  assert.deepEqual(detectImplicitBase('漢字、'), { base: '', rest: '漢字、' });
  assert.deepEqual(detectImplicitBase('漢字］'), { base: '', rest: '漢字］' });
  assert.deepEqual(detectImplicitBase(''), { base: '', rest: '' });
});

// --------------------------------------------------------- 欧文 range (Aozora rule, verified)

test('欧文: a half-width space ends the implicit base — multi-word bases require ｜', () => {
  // Aozora: multi-word Latin gets per-word rubies (「アルファベットの句や文にルビが付く場合は、
  // 単語ごとにルビを付けます」); one reading over several words must mark its start with ｜
  // (「複数のアルファベットの単語に、一つのまとまったルビが付く場合には、「｜」を用いて…」).
  assert.deepEqual(tokenize('Buffalo Bill《バッファロー・ビル》'), [
    { kind: 'text', raw: 'Buffalo ', text: 'Buffalo ' },
    { kind: 'rubyImplicit', raw: 'Bill《バッファロー・ビル》', base: 'Bill', reading: 'バッファロー・ビル' },
  ]);
  assert.deepEqual(tokenize('｜Au revoir《さらば》'), [
    { kind: 'rubyStart', raw: '｜' },
    { kind: 'text', raw: 'Au revoir', text: 'Au revoir' },
    { kind: 'rubyEnd', raw: '《さらば》', reading: 'さらば' },
  ]);
});

test('欧文: digits and letters (half- and full-width) form ONE alnum run', () => {
  assert.deepEqual(detectImplicitBase('MP4'), { base: 'MP4', rest: '' });
  assert.deepEqual(tokenize('Ｗｅｂ《ウェブ》')[0], {
    kind: 'rubyImplicit',
    raw: 'Ｗｅｂ《ウェブ》',
    base: 'Ｗｅｂ',
    reading: 'ウェブ',
  });
});

test('片仮名: the 中黒 ・ is a 記号 and ends the run (whole-name rubies require ｜)', () => {
  assert.deepEqual(detectImplicitBase('バッファロー・ビル'), {
    base: 'ビル',
    rest: 'バッファロー・',
  });
});
