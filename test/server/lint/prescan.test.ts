/**
 * Edge-case unit tests for the pure pre-scanners (the end-to-end behaviour is covered by
 * kernel.test.ts; here we pin the tricky boundaries directly on the functions).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dashScan,
  halfWidthSpaceScan,
  minusPositionScan,
  rubyKanaScan,
} from '../../../src/server/lint/prescan.ts';
import type { PreScan } from '../../../src/server/lint/prescan.ts';
import type { ActiveRule } from '../../../src/shared/lint/select.ts';

/** The substrings a scanner flags within `text` (boolean rules pass `true`; enums pass `{ mode }`). */
const flagged = (scan: PreScan, text: string, options: ActiveRule['options'] = true): string[] =>
  scan(text, options).map((s) => text.slice(s.start, s.end));

test('rubyKana hiragana mode: katakana / mixed / non-kana readings fail (ー stays neutral)', () => {
  assert.deepEqual(flagged(rubyKanaScan, 'らーめん', { mode: 'hiragana' }), []);
  assert.deepEqual(flagged(rubyKanaScan, 'カード', { mode: 'hiragana' }), ['カード']);
  assert.deepEqual(flagged(rubyKanaScan, 'かード', { mode: 'hiragana' }), ['かード']);
  assert.deepEqual(flagged(rubyKanaScan, 'abc', { mode: 'hiragana' }), ['abc']);
});

test('rubyKana katakana mode: hiragana readings fail (ー stays neutral)', () => {
  assert.deepEqual(flagged(rubyKanaScan, 'カード', { mode: 'katakana' }), []);
  assert.deepEqual(flagged(rubyKanaScan, 'らーめん', { mode: 'katakana' }), ['らーめん']);
  assert.deepEqual(flagged(rubyKanaScan, 'たろう', { mode: 'katakana' }), ['たろう']);
});

const BAR = { mode: 'horizontalBar' } as const; // the shipped default: ― U+2015

const PARITY = { code: 'lint.common.dash.parity' };
const CHAR = { code: 'lint.common.dash', args: ['―'] };

test('dash: a run of the chosen glyph passes only at an even length', () => {
  assert.deepEqual(flagged(dashScan, '彼は――と', BAR), []);
  assert.deepEqual(flagged(dashScan, '彼は――――と', BAR), []); // longer even runs are the author's
  assert.deepEqual(dashScan('彼は―と', BAR), [{ start: 2, end: 3, fix: '――', message: PARITY }]);
  assert.deepEqual(dashScan('彼は―――と', BAR), [
    { start: 2, end: 5, fix: '――――', message: PARITY },
  ]);
});

test('dash: any other dash glyph is rewritten to the chosen one, length preserved', () => {
  assert.deepEqual(dashScan('彼は——と', BAR), [{ start: 2, end: 4, fix: '――', message: CHAR }]);
  assert.deepEqual(dashScan('彼は──と', BAR), [{ start: 2, end: 4, fix: '――', message: CHAR }]);
  assert.deepEqual(dashScan('彼は—―と', BAR), [{ start: 2, end: 4, fix: '――', message: CHAR }]);
  assert.deepEqual(dashScan('あ―い―う', BAR), [
    { start: 1, end: 2, fix: '――', message: PARITY },
    { start: 3, end: 4, fix: '――', message: PARITY },
  ]);
  // wrong glyph AND odd: the character message wins
  assert.deepEqual(dashScan('彼は—――と', BAR), [{ start: 2, end: 5, fix: '――――', message: CHAR }]);
});

test('dash: a doubled look-alike is a dash, a lone one is a sign; ー is never a dash', () => {
  assert.deepEqual(dashScan('彼は－－と', BAR), [{ start: 2, end: 4, fix: '――', message: CHAR }]);
  assert.deepEqual(dashScan('彼は––と', BAR), [{ start: 2, end: 4, fix: '――', message: CHAR }]);
  // a lone look-alike is a minus sign, a range, or minusPosition's stray — not a dash
  assert.deepEqual(flagged(dashScan, '気温は－5度', BAR), []);
  assert.deepEqual(flagged(dashScan, '１–２', BAR), []);
  // the prolonged sound mark is prose, however long the run
  assert.deepEqual(flagged(dashScan, '「あーーーー！」', BAR), []);
});

test('dash: each mode judges by its own glyph; an unset mode checks nothing', () => {
  assert.deepEqual(flagged(dashScan, '彼は——と', { mode: 'emDash' }), []);
  assert.deepEqual(flagged(dashScan, '彼は──と', { mode: 'boxDrawing' }), []);
  assert.deepEqual(dashScan('彼は――と', { mode: 'emDash' }), [
    { start: 2, end: 4, fix: '——', message: { code: 'lint.common.dash', args: ['—'] } },
  ]);
  // 'off' never reaches a scanner (select.ts drops it), but an unknown mode must stay silent too
  assert.deepEqual(flagged(dashScan, '彼は―と', { mode: 'off' }), []);
  assert.deepEqual(flagged(dashScan, '彼は―と', true), []);
});

test('halfWidthSpace: a half-width space between full-width chars is fixed to 　 (run collapses)', () => {
  assert.deepEqual(halfWidthSpaceScan('あ いう', true), [{ start: 1, end: 2, fix: '　' }]);
  assert.deepEqual(halfWidthSpaceScan('あ  い', true), [{ start: 1, end: 3, fix: '　' }]); // run -> one
  assert.deepEqual(flagged(halfWidthSpaceScan, 'A B'), []); // ASCII neighbours -> not flagged
  assert.deepEqual(flagged(halfWidthSpaceScan, 'あ B'), []); // mixed -> not flagged
});

test('halfWidthSpace: a half-width ！？ run ends Japanese prose, so the space after it is flagged', () => {
  assert.deepEqual(halfWidthSpaceScan('なに!? そして', true), [{ start: 4, end: 5, fix: '　' }]);
  assert.deepEqual(flagged(halfWidthSpaceScan, 'なに!!! そして'), [' ']);
  assert.deepEqual(flagged(halfWidthSpaceScan, 'なに! そして'), []); // a lone mark is Western
  assert.deepEqual(flagged(halfWidthSpaceScan, 'なに!? John'), []); // the right side still decides
  assert.deepEqual(flagged(halfWidthSpaceScan, 'あ !?だ'), []); // before a pair: not the issue
});

test('minusPosition: only a minus immediately before a digit is allowed', () => {
  assert.deepEqual(flagged(minusPositionScan, '気温は－5度'), []); // － before 5
  assert.deepEqual(flagged(minusPositionScan, '気温は－５度'), []); // full-width digit
  assert.deepEqual(flagged(minusPositionScan, 'ダッシュ－だ'), ['－']); // not before a digit
  assert.deepEqual(flagged(minusPositionScan, '末尾-'), ['-']); // at end of string
});
