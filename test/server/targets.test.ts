/**
 * Keeping a 対象文字列 in step with the body: which postfixes are eligible, which edits reach
 * their 「…」, how several edits on one 「…」 merge — and the lint fixes end to end, as the
 * editor applies them (#134).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../../src/shared/ast/parse.ts';
import type { RawLintConfigWire } from '../../src/shared/protocol.ts';
import { eligibleTargets, syncedTargets, targetEdits } from '../../src/server/targets.ts';
import type { SyncedTarget } from '../../src/server/targets.ts';
import { at, gaijiOf } from '../shared/ast/_shape.ts';
import { applyFixAll, applyLintFixes, openDoc as doc } from './helpers.ts';

/** The 対象文字列 of each eligible postfix of `src`, a one-line manuscript, in source order. */
const eligible = (src: string): string[] => eligibleTargets(parse(src), src, 0).map(({ node }) => node.target.text);

test('a postfix is eligible when its 「…」 is written as the body it bound to', () => {
  assert.deepEqual(eligible('山田［＃「山田」に傍点］'), ['山田']);
  assert.deepEqual(eligible('王都［＃「王都」は大見出し］'), ['王都']);
  assert.deepEqual(eligible('王都［＃「王都」の左に「おうと」のルビ］'), ['王都']);
  assert.deepEqual(eligible('42［＃「42」は縦中横］'), ['42']);
  // A 縦中横 span's content is written as it reads: eligible.
  assert.deepEqual(eligible('［＃縦中横］12［＃縦中横終わり］［＃「12」は太字］'), ['12']);
  // Two postfixes over one text, and one over a wider text.
  assert.deepEqual(eligible('山田さん［＃「山田」に傍点］［＃「山田」は太字］［＃「山田さん」に傍線］'), ['山田', '山田', '山田さん']);
  // The wider one is not written as its body once an annotation sits inside.
  assert.deepEqual(eligible('山田［＃「山田」に傍点］さん［＃「山田さん」は太字］'), ['山田']);
  // Kana decomposed on both sides are written alike.
  assert.deepEqual(eligible('た\u3099め［＃「た\u3099め」に傍点］'), ['た\u3099め']);
});

test('a postfix is not eligible when what it bound to is not written as its 「…」', () => {
  for (const src of [
    '山田《やまだ》さん［＃「山田さん」に傍点］', // a ruby inside
    '｜山田［＃「山田」に傍点］《やまだ》', // bound to the ruby the ｜ makes
    '山田［＃メモ］さん［＃「山田さん」に傍点］', // a comment inside
    '［＃ここに「タイトル」の値を表示］［＃「タイトル」に傍点］', // a value field
    `${gaijiOf('⁉')}［＃「⁉」に傍点］`, // a 外字注記
    '聖\u0007剣［＃「聖剣」に傍点］', // a dropped character
    'た\u3099め［＃「だめ」に傍点］', // composed on one side only
    'だめ［＃「た\u3099め」に傍点］',
    '山田［＃「太郎」に傍点］', // a miss
  ]) {
    assert.deepEqual(eligible(src), [], src);
  }
});

/** The synced targets of editing `span` of `src` to `newText`, as `[target, start, end]`. */
function synced(src: string, span: { start: number; end: number }, newText: string): [string, number, number][] {
  const d = doc(src);
  return syncedTargets(eligibleTargets(parse(src), src, 0), d, span, newText).map((t) => [t.text, t.start, t.end]);
}

test('an edit reaches the 「…」 of every eligible postfix whose body holds it', () => {
  const src = 'なに!?だ［＃「に!?」に傍点］［＃「なに!?だ」は太字］';
  assert.deepEqual(synced(src, at(src, '!?'), '⁉'), [['に!?', 1, 3], ['なに!?だ', 2, 4]]);
  // An insert strictly inside.
  const space = 'なに！と続く［＃「なに！と」に傍点］';
  assert.deepEqual(synced(space, { start: 3, end: 3 }, '　'), [['なに！と', 3, 3]]);
  // A replacement of the whole body.
  assert.deepEqual(synced('山田［＃「山田」に傍点］', at('山田', '山田'), '太郎'), [['山田', 0, 2]]);
});

test('an edit at the edge of the body, across it, or writing markup reaches no 「…」', () => {
  const src = 'なに！と［＃「なに！と」に傍点］';
  assert.deepEqual(synced(src, { start: 0, end: 0 }, '　'), []); // an insert at the start
  assert.deepEqual(synced(src, { start: 4, end: 4 }, '　'), []); // an insert at the end
  const pair = 'なに!?［＃「に!」に傍点］';
  assert.deepEqual(synced(pair, at(pair, '!?'), '⁉'), []); // across the end
  assert.deepEqual(synced(pair, { start: 0, end: 3 }, 'あ'), []); // across the start
  const whole = 'なに!?［＃「なに!?」に傍点］';
  assert.deepEqual(synced(whole, at(whole, '!?'), '!?［＃「!?」は縦中横］'), []); // writes an annotation
});

test('the splices on one 「…」 merge into one edit, and one that would empty it is dropped', () => {
  const range = { start: { line: 0, character: 10 }, end: { line: 0, character: 14 } };
  const target = (start: number, end: number, newText: string): SyncedTarget => ({ range, text: 'なに!?', start, end, newText });
  assert.deepEqual(targetEdits([target(2, 4, '⁉'), target(1, 1, '　')]), [{ range, newText: 'な　に⁉' }]);
  assert.deepEqual(targetEdits([target(0, 4, '')]), []);
  const other = { ...range, start: { line: 1, character: 0 } };
  assert.deepEqual(targetEdits([target(0, 2, 'え'), { ...target(2, 4, '⁉'), range: other }]), [
    { range, newText: 'え!?' },
    { range: other, newText: 'なに⁉' },
  ]);
});

const ON: RawLintConfigWire = {
  'jpnov.lint.common.noHankakuKana': true,
  'jpnov.lint.common.ellipsis': true,
  'jpnov.lint.common.questionExclamationMarks': 'fullWidth',
  'jpnov.lint.common.noNfd': true,
};

test('a lint fix inside what a postfix names rewrites its 「…」 too, and the annotation keeps binding', () => {
  const space: RawLintConfigWire = { 'jpnov.lint.common.exclamationSpace': true };
  assert.equal(applyFixAll('　なに！と続く［＃「なに！と」に傍点］。', space), '　なに！　と続く［＃「なに！　と」に傍点］。');
  assert.equal(applyLintFixes('　なに！と続く［＃「なに！と」に傍点］。', space).out, '　なに！　と続く［＃「なに！　と」に傍点］。');
  // An insert at the end of what the postfix names goes past the annotation: the 「…」 stays.
  assert.equal(applyFixAll('　なに！［＃「なに！」に傍点］と続く。', space), '　なに！［＃「なに！」に傍点］　と続く。');
  for (const [src, out] of [
    ['　はｶﾞだ［＃「ｶﾞ」に傍点］。', '　はガだ［＃「ガ」に傍点］。'],
    ['　沈黙…だ［＃「沈黙…」に傍点］。', '　沈黙……だ［＃「沈黙……」に傍点］。'],
    ['　なに!?［＃「なに!?」に傍点］。', '　なに⁉［＃「なに⁉」に傍点］。'],
    // Two fixes inside one 「…」 land in one edit of it.
    ['　なに!?だ!?［＃「なに!?だ!?」に傍点］。', '　なに⁉だ⁉［＃「なに⁉だ⁉」に傍点］。'],
    // Composition inside the 「…」 gives way to the rewrite, which carries it.
    ['　た\u3099め［＃「た\u3099め」に傍点］。', '　だめ［＃「だめ」に傍点］。'],
  ] as const) {
    assert.equal(applyFixAll(src, ON), out, src);
    assert.equal(applyLintFixes(src, ON).out, out, src);
    assert.deepEqual(parse(out).issues, [], src);
  }
});

test('a fix across the edge of what a postfix names leaves the 「…」 alone, and the miss is reported', () => {
  const src = '　なに!?［＃「に!」に傍点］。';
  const out = applyFixAll(src, ON);
  assert.equal(out, '　なに⁉［＃「に!」に傍点］。');
  assert.deepEqual(parse(out).issues.map((issue) => issue.kind), ['postfixTargetMissing']);
});

test('a quick fix carries the edit of the 「…」 with it', () => {
  const src = '　なに!?［＃「なに!?」に傍点］。';
  const { edits } = applyLintFixes(src, ON);
  const target = at(src, 'なに!?', 1);
  assert.deepEqual(edits.toSorted((a, b) => a.s - b.s), [
    { s: 3, e: 5, t: '⁉' },
    { s: target.start, e: target.end, t: 'なに⁉' },
  ]);
});
