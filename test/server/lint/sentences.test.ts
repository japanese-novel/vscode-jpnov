/**
 * Sentence segmentation tests — the boundary definition sentenceLength and maxTen share.
 * Views are built through the real walker so the index alignment is the one rules see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CLOSERS, SENTENCE_MARKS, TERMINATORS, splitSentences } from '../../../src/server/lint/sentences.ts';
import { walkLines } from '../../../src/server/lint/walker.ts';
import type { ProseView } from '../../../src/server/lint/types.ts';
import { parse } from '../../../src/shared/ast/parse.ts';

function narrationOf(src: string): ProseView {
  const [line] = [...walkLines(parse(src))];
  if (line === undefined) {
    throw new Error('no line');
  }
  return line.narration();
}

function sentencesOf(src: string): string[] {
  const view = narrationOf(src);
  return splitSentences(view).map((s) => view.text.slice(s.start, s.end));
}

test('。 ends a sentence; the terminator stays inside', () => {
  assert.deepEqual(sentencesOf('一つ目。二つ目。'), ['一つ目。', '二つ目。']);
});

test('a terminator run (！？) is one ending; closers right after are absorbed', () => {
  assert.deepEqual(sentencesOf('なんだと！？次だ。'), ['なんだと！？', '次だ。']);
  assert.deepEqual(sentencesOf('なんだと⁉次だ‼まだ⁇ある⁈'), ['なんだと⁉', '次だ‼', 'まだ⁇', 'ある⁈']);
  assert.deepEqual(sentencesOf('「〇」だ。'), ['「〇」だ。']);
});

test('a line without a terminator is one sentence to the end', () => {
  assert.deepEqual(sentencesOf('終わらない文'), ['終わらない文']);
});

test('inter-sentence whitespace is skipped, not counted', () => {
  assert.deepEqual(sentencesOf('先だ。　後だ。'), ['先だ。', '後だ。']);
});

test('… and dashes do not terminate', () => {
  assert.deepEqual(sentencesOf('間……続く。'), ['間……続く。']);
  assert.deepEqual(sentencesOf('間――続く。'), ['間――続く。']);
});

test("the dialogue view's separator is a hard boundary", () => {
  const [line] = [...walkLines(parse('「先」「後」'))];
  const view = line?.dialogue();
  assert.ok(view);
  assert.deepEqual(splitSentences(view).map((s) => view.text.slice(s.start, s.end)), ['先', '後']);
});

test('an empty view has no sentences', () => {
  assert.deepEqual(sentencesOf(''), []);
});

test('whitespace is outside every sentence: leading, between, and trailing (where the split ends)', () => {
  assert.deepEqual(sentencesOf('あ。　'), ['あ。']);
  assert.deepEqual(splitSentences(narrationOf('　あ。')), [{ start: 1, end: 3 }]);
  assert.deepEqual(sentencesOf('。　」'), ['。', '」']);
  assert.deepEqual(sentencesOf('！」。'), ['！」', '。']);
  assert.deepEqual(sentencesOf('」」」'), ['」」」']);
  assert.deepEqual(sentencesOf('……。'), ['……。']);
  assert.deepEqual(sentencesOf('　　'), []);
});

test('every mark, terminator and closer is one UTF-16 unit, as the classes without the u flag assume', () => {
  for (const ch of [...SENTENCE_MARKS, ...TERMINATORS, ...CLOSERS]) {
    assert.equal(ch.length, 1, ch);
  }
});
