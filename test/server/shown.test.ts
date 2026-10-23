/**
 * The lines as shown (shown.ts): the display text of the AST's content, the prose stretches that
 * map it back to the source — across markup, through a ruby base and a 縦中横, with composed kana
 * and dropped characters, and with nothing for what an annotation shows — and the dialogue
 * segments, one stack over the whole manuscript.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shownLines } from '../../src/server/shown.ts';
import type { ShownLine } from '../../src/server/shown.ts';
import { VALUE_NAMES, valueAnnotation } from '../../src/shared/ast/notation.ts';
import { parse } from '../../src/shared/ast/parse.ts';
import { at, gaijiOf } from '../shared/ast/_shape.ts';
import { BEL, D, H } from '../shared/_kana.ts';

/** Line `n` of `src` as shown. */
function shownLine(src: string, n = 0): ShownLine {
  return shownLines(parse(src))[n] ?? assert.fail(`no line ${String(n)}`);
}

/** The first line of `src` as shown: its text, and each prose stretch as `[display, source]`. */
function shown(src: string): { text: string; prose: [string, string][] } {
  const { text, prose } = shownLine(src);
  return { text, prose: prose.map((s) => [text.slice(s.from, s.to), src.slice(s.src, s.end)]) };
}

/** The segments of line `n` of `src`: each as `[kind, display text, depth]`. */
function segments(src: string, n = 0): [string, string, number][] {
  const line = shownLine(src, n);
  return line.segments.map((s) => [s.kind, line.text.slice(s.from, s.to), s.depth]);
}

test('plain text is one stretch, as typed', () => {
  assert.deepEqual(shown('ただの本文'), { text: 'ただの本文', prose: [['ただの本文', 'ただの本文']] });
  assert.deepEqual(shown(''), { text: '', prose: [] });
});

test('markup is elided from the text and cuts the stretches; a word cut by a postfix reads whole', () => {
  assert.deepEqual(shown('新［＃「新」に傍点］帝都'), { text: '新帝都', prose: [['新', '新'], ['帝都', '帝都']] });
  assert.deepEqual(shown('前［＃メモ］後'), { text: '前後', prose: [['前', '前'], ['後', '後']] });
});

test('a ruby base is prose where it was written; its markers and reading are not', () => {
  assert.deepEqual(shown('｜太郎《たろう》は'), { text: '太郎は', prose: [['太郎', '太郎'], ['は', 'は']] });
  assert.deepEqual(shown('太《た》郎は'), { text: '太郎は', prose: [['太', '太'], ['郎は', '郎は']] });
  // An annotation inside a ｜ base cuts the base's stretches like any other.
  assert.deepEqual(shown('｜山［＃「山」に傍点］田《やまだ》'), { text: '山田', prose: [['山', '山'], ['田', '田']] });
});

test('a 縦中横 holds its text as prose; a swallowed reading is gone', () => {
  assert.deepEqual(shown('［＃縦中横］１２［＃縦中横終わり］年'), { text: '１２年', prose: [['１２', '１２'], ['年', '年']] });
  assert.deepEqual(shown('［＃縦中横］１２《じゅうに》［＃縦中横終わり］'), { text: '１２', prose: [['１２', '１２']] });
});

test('what an annotation shows is in the text but in no stretch', () => {
  const value = valueAnnotation(VALUE_NAMES.title);
  assert.deepEqual(shown(`前${value}後`).prose, [['前', '前'], ['後', '後']]);
  assert.equal(shown(`前${value}後`).text, `前${VALUE_NAMES.title}後`);
  assert.deepEqual(shown(`前${gaijiOf('⁉')}後`), { text: '前⁉後', prose: [['前', '前'], ['後', '後']] });
  assert.deepEqual(shown('前［＃３字下げ］後'), { text: '前　　　後', prose: [['前', '前'], ['後', '後']] });
  assert.deepEqual(shown('前［＃壊れた'), { text: '前［＃壊れた', prose: [['前', '前']] });
});

test('a composed kana is a stretch of its own, covering its mark; the rest stays unit for unit', () => {
  const src = `た${D}んほ${H}はい`;
  assert.deepEqual(shown(src), {
    text: 'だんぽはい',
    prose: [['だ', `た${D}`], ['ん', 'ん'], ['ぽ', `ほ${H}`], ['はい', 'はい']],
  });
  assert.deepEqual(shown(`｜か${D}《が》`), { text: 'が', prose: [['が', `か${D}`]] });
});

test('a dropped character leaves the text; the stretch around it covers where it was', () => {
  assert.deepEqual(shown(`あ${BEL}い`), { text: 'あい', prose: [['あ', `あ${BEL}`], ['い', 'い']] });
});

test('an astral character is two units in both', () => {
  const src = '𠮷野は';
  assert.deepEqual(shown(src), { text: src, prose: [[src, src]] });
  assert.deepEqual(shownLine(src).prose, [{ from: 0, to: 4, src: 0, end: 4 }]);
  assert.equal(at(src, 'は').start, 3);
});

test('the runs carry their cell and their clusters; a composed run its clusters, a plain one none', () => {
  const line = shownLine(`あ｜か${D}《が》い`);
  assert.deepEqual(line.runs.map((r) => [r.run.text, r.cell?.kind ?? null, r.from, r.clusters?.map((c) => [c.text, c.start, c.end]) ?? null]), [
    ['あ', null, 0, null],
    ['が', 'ruby', 1, [['が', 2, 4]]],
    ['い', null, 2, null],
  ]);
});

test('segments tile the text: the corners, the prose between, and what an annotation shows at the depth it sits', () => {
  const value = valueAnnotation(VALUE_NAMES.title);
  assert.deepEqual(segments(`地「台${value}詞」文`), [
    ['prose', '地', 0],
    ['open', '「', 0],
    ['prose', '台', 1],
    ['prose', VALUE_NAMES.title, 1],
    ['prose', '詞', 1],
    ['close', '」', 0],
    ['prose', '文', 0],
  ]);
  assert.deepEqual(segments('本当に［＃「当」に傍点］走った。'), [['prose', '本', 0], ['prose', '当', 0], ['prose', 'に', 0], ['prose', '走った。', 0]]); // the Aozora trap: a run per marks
  assert.deepEqual(segments(''), []);
});

test('one stack over the manuscript: an utterance open at a line end continues on the next line', () => {
  const src = '「あ\nい」う\n「』え';
  assert.deepEqual(shownLines(parse(src)).map((l) => [l.depthAtStart, l.depthAtEnd]), [[0, 1], [1, 0], [0, 1]]);
  assert.deepEqual(shownLines(parse(src)).map((l) => l.line.index), [0, 1, 2]);
  assert.deepEqual(segments(src, 1), [['prose', 'い', 1], ['close', '」', 0], ['prose', 'う', 0]]);
  assert.deepEqual(segments(src, 2), [['open', '「', 0], ['prose', '』え', 1]]); // a mismatched closer is prose
});
