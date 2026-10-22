/** Enablement / clamping / enum behaviour of selectRules (flat, catalog-ordered selection). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectRules } from '../../../src/shared/lint/select.ts';

test('an empty snapshot (nothing enabled) selects nothing', () => {
  const sel = selectRules({});
  assert.deepEqual(sel, []);
});

test('a boolean rule resolves to options: true under its own code', () => {
  assert.deepEqual(selectRules({ 'jpnov.lint.common.noUnmatchedPair': true }), [
    { id: 'noUnmatchedPair', options: true, code: 'lint.common.noUnmatchedPair', setting: 'jpnov.lint.common.noUnmatchedPair' },
  ]);
});

test('a threshold rule clamps to its catalog bounds', () => {
  assert.deepEqual(selectRules({ 'jpnov.lint.common.maxTen': 999 }), [
    { id: 'maxTen', options: { max: 20 }, code: 'lint.common.maxTen', setting: 'jpnov.lint.common.maxTen' },
  ]);
});

test('a threshold rule enables at 0 when its floor is 0; null stays off', () => {
  assert.deepEqual(selectRules({ 'jpnov.lint.common.blankRun': 0 }), [
    { id: 'blankRun', options: { max: 0 }, code: 'lint.common.blankRun', setting: 'jpnov.lint.common.blankRun' },
  ]);
  assert.deepEqual(selectRules({ 'jpnov.lint.common.blankRun': null }), []);
});

test('a boolean rule enables only on exactly true', () => {
  assert.deepEqual(selectRules({ 'jpnov.lint.common.noUnmatchedPair': false }), []);
  assert.deepEqual(selectRules({ 'jpnov.lint.common.noUnmatchedPair': 1 }), []);
});

test('scoped rules resolve like any other (the scope lives in the code)', () => {
  assert.deepEqual(selectRules({ 'jpnov.lint.narration.indent': true }), [
    { id: 'indent', options: true, code: 'lint.narration.indent', setting: 'jpnov.lint.narration.indent' },
  ]);
  assert.deepEqual(selectRules({ 'jpnov.lint.dialogue.closingPunct': true }), [
    { id: 'closingPunct', options: true, code: 'lint.dialogue.closingPunct', setting: 'jpnov.lint.dialogue.closingPunct' },
  ]);
});

test('the selection keeps catalog order regardless of snapshot key order', () => {
  const sel = selectRules({
    'jpnov.lint.ruby.kana': 'hiragana',
    'jpnov.lint.common.maxTen': 3,
  });
  assert.deepEqual(sel.map((r) => r.id), ['maxTen', 'kana']);
});

test('the ruby enum resolves a mode; off / unknown values stay off', () => {
  assert.deepEqual(selectRules({ 'jpnov.lint.ruby.kana': 'hiragana' }), [
    { id: 'kana', options: { mode: 'hiragana' }, code: 'lint.ruby.kana', setting: 'jpnov.lint.ruby.kana' },
  ]);
  assert.deepEqual(selectRules({ 'jpnov.lint.ruby.kana': 'off' }), []);
  assert.deepEqual(selectRules({ 'jpnov.lint.ruby.kana': 'romaji' }), []);
});

test('the dash enum has no off member, yet the retired "off" spelling still disables', () => {
  assert.deepEqual(selectRules({ 'jpnov.lint.common.dash': 'emDash' }), [
    { id: 'dash', options: { mode: 'emDash' }, code: 'lint.common.dash', setting: 'jpnov.lint.common.dash' },
  ]);
  // A settings.json written before the member was retired: the literal 'off' guard runs ahead
  // of the membership check, so the rule stays off instead of erroring or defaulting on.
  assert.deepEqual(selectRules({ 'jpnov.lint.common.dash': 'off' }), []);
  assert.deepEqual(selectRules({ 'jpnov.lint.common.dash': 'enDash' }), []);
});
