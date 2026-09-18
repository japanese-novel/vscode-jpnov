/**
 * The unified highlighter: one semantic-token stream covering Aozora markup + narration (cast names
 * and coined keywords) with standard LSP types. A ruby BASE flows into recognition (a name stays a
 * name while ｜《》 + 読み stay markup), correct UTF-16 offsets across markup and astral characters,
 * markup + dialogue emitted without a recognizer, and multi-line spans split per line.
 *
 * Token types are referenced by KIND via tokenTypeIndex(...) — never a hard-coded number — so the
 * tests survive reordering or adding HIGHLIGHTS rows.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRecognizer } from '../../../src/server/highlight/recognizer.ts';
import {
  buildSemanticTokens,
  tokenTypeIndex,
} from '../../../src/server/semanticTokens.ts';
import { VALUE_NAMES, valueAnnotation } from '../../../src/shared/compiler/tokenizer.ts';
import { at, covers, decode, doc } from './tokens.ts';

// A small project: 山田 太郎 as cast, 聖剣 as a coined keyword.
const rec = createRecognizer(['山田　太郎'], ['聖剣']);

const MARKER = tokenTypeIndex('marker');
const CHARACTER = tokenTypeIndex('character');
const KEYWORD = tokenTypeIndex('keyword');

test('legend is the distinct LSP types in first-seen order', () => {
  // Distinct kinds get distinct indices.
  assert.notEqual(tokenTypeIndex('character'), tokenTypeIndex('keyword'));
  assert.notEqual(tokenTypeIndex('character'), tokenTypeIndex('direction')); // variable != comment
  assert.notEqual(tokenTypeIndex('marker'), tokenTypeIndex('directive')); // comment != keyword
});

// ----------------------------------------------------------------------- narration

test('a narration subject 太郎は -> character; the は particle is not coloured', () => {
  const toks = decode(buildSemanticTokens(doc('太郎は走った'), rec).data);
  assert.deepEqual(at(toks, 0, 0), { line: 0, char: 0, len: 3, type: CHARACTER }); // 太郎は
});

test('a coined keyword is bolded', () => {
  const toks = decode(buildSemanticTokens(doc('聖剣を抜いた'), rec).data);
  assert.deepEqual(at(toks, 0, 0), { line: 0, char: 0, len: 2, type: KEYWORD }); // 聖剣
});

// ----------------------------------------------------------------------- dialogue

test('dialogue 「」 are markers; their content keeps the body colour', () => {
  // 「(0) 太(1) 郎(2) は(3) 」(4) — 太郎は would be a subject in narration, but is masked here.
  const toks = decode(buildSemanticTokens(doc('「太郎は」'), rec).data);
  assert.equal(at(toks, 0, 0)?.type, MARKER); // 「
  assert.equal(at(toks, 0, 4)?.type, MARKER); // 」
  assert.ok(!covers(toks, 1, CHARACTER));
});

// ----------------------------------------------------------------------- ruby

test('ruby base flows into recognition; ｜《》 are markers, the reading is not coloured', () => {
  // ｜(0) 太(1) 郎(2) 《(3) た(4) ろ(5) う(6) 》(7) は(8)
  const toks = decode(buildSemanticTokens(doc('｜太郎《たろう》は'), rec).data);
  assert.equal(at(toks, 0, 1)?.type, CHARACTER); // 太郎 base recognised
  assert.equal(at(toks, 0, 1)?.len, 2);
  assert.equal(at(toks, 0, 0)?.type, MARKER); // ｜
  assert.equal(at(toks, 0, 3)?.type, MARKER); // 《
  assert.equal(at(toks, 0, 7)?.type, MARKER); // 》
  assert.ok(!covers(toks, 4, CHARACTER)); // み (reading) not recognised
});

test('a recognised span splits across a ruby reading hole', () => {
  // 太(0) 《(1) た(2) 》(3) 郎(4) は(5): the name 太郎 spans the base + the post-reading 郎.
  const toks = decode(buildSemanticTokens(doc('太《た》郎は'), rec).data);
  assert.equal(at(toks, 0, 0)?.type, CHARACTER); // 太
  assert.equal(at(toks, 0, 4)?.type, CHARACTER); // 郎, across the 《た》 hole
  assert.ok(!covers(toks, 2, CHARACTER)); // the reading た is not coloured
});

// ----------------------------------------------------------------------- markup (unchanged)

test('［＃改ページ］: brackets marker, 改ページ directive', () => {
  const toks = decode(buildSemanticTokens(doc('［＃改ページ］'), rec).data);
  assert.deepEqual(at(toks, 0, 0), { line: 0, char: 0, len: 2, type: MARKER }); // ［＃
  assert.deepEqual(at(toks, 0, 2), { line: 0, char: 2, len: 4, type: tokenTypeIndex('directive') }); // 改ページ
  assert.deepEqual(at(toks, 0, 6), { line: 0, char: 6, len: 1, type: MARKER }); // ］
});

test('［＃ここに「…」の値を表示］: the name is a directive, known to the build or not; the scaffolding demotes', () => {
  for (const name of [...Object.values(VALUE_NAMES), '発行日', '13']) {
    const src = valueAnnotation(name);
    const toks = decode(buildSemanticTokens(doc(src), rec).data);
    const open = '［＃'.length;
    const scaffold = 'ここに「'.length;
    const tail = '」の値を表示'.length;
    assert.deepEqual(at(toks, 0, 0), { line: 0, char: 0, len: open, type: MARKER }, name);
    assert.deepEqual(at(toks, 0, open), { line: 0, char: open, len: scaffold, type: MARKER }, name);
    assert.deepEqual(
      at(toks, 0, open + scaffold),
      { line: 0, char: open + scaffold, len: name.length, type: tokenTypeIndex('directive') },
      name,
    );
    assert.deepEqual(
      at(toks, 0, open + scaffold + name.length),
      { line: 0, char: open + scaffold + name.length, len: tail, type: MARKER },
      name,
    );
    assert.deepEqual(
      at(toks, 0, src.length - 1),
      { line: 0, char: src.length - 1, len: 1, type: MARKER },
      name,
    );
    // The keyword must stop at the field name — never spill onto the closing corner.
    assert.ok(!covers(toks, open + scaffold + name.length, tokenTypeIndex('directive')), name);
  }
  // An empty pair is no value display: one greyed span, exactly like any mistyped annotation.
  const empty = decode(buildSemanticTokens(doc('［＃ここに「」の値を表示］'), rec).data);
  assert.ok(!empty.some((t) => t.type === tokenTypeIndex('directive')));
});

test('emphasis span: variant -> directive, 左に -> direction', () => {
  const left = decode(buildSemanticTokens(doc('［＃左に傍点］'), rec).data);
  assert.deepEqual(at(left, 0, 2), { line: 0, char: 2, len: 2, type: tokenTypeIndex('direction') }); // 左に
  assert.deepEqual(at(left, 0, 4), { line: 0, char: 4, len: 2, type: tokenTypeIndex('directive') }); // 傍点
});

test('emphasis postfix: 「対象」 target keeps default colour; variant is a directive', () => {
  // ［＃(0,1) 「(2) 本(3) 」(4) に(5) 傍点(6,7) ］(8)
  const toks = decode(buildSemanticTokens(doc('［＃「本」に傍点］'), rec).data);
  assert.ok(toks.some((t) => t.type === tokenTypeIndex('directive'))); // 傍点
  assert.equal(at(toks, 0, 2)?.type, MARKER); // 「
  assert.equal(at(toks, 0, 4)?.type, MARKER); // 」
  assert.ok(!toks.some((t) => t.char <= 3 && t.char + t.len > 3)); // 本 uncovered
});

test('markup and dialogue are emitted without a recognizer (undefined)', () => {
  const toks = decode(buildSemanticTokens(doc('「猫」｜字《じ》'), undefined).data);
  assert.ok(toks.some((t) => t.type === MARKER)); // dialogue + ruby markers present
  assert.ok(!toks.some((t) => t.type === CHARACTER || t.type === KEYWORD)); // nothing recognised
});

test('an unclosed ［＃ (its ］ on a later line) is greyed on its own line ONLY', () => {
  // Line-bounded pairing: ［＃ab is a brokenAnnotation (marker to line end); "cd］" is plain text.
  const toks = decode(buildSemanticTokens(doc('［＃ab\ncd］'), rec).data);
  assert.deepEqual(at(toks, 0, 0), { line: 0, char: 0, len: 4, type: MARKER }); // ［＃ab
  assert.ok(!toks.some((t) => t.line === 1), 'the later line has no token (lone ］ is text)');
});

test('a broken ［＃ is greyed to its line end; the next line is recognized normally', () => {
  const toks = decode(buildSemanticTokens(doc('本［＃こわれ\n太郎は走った'), rec).data);
  assert.deepEqual(at(toks, 0, 1), { line: 0, char: 1, len: 5, type: MARKER }); // ［＃こわれ
  assert.deepEqual(at(toks, 1, 0), { line: 1, char: 0, len: 3, type: CHARACTER }); // 太郎は
});

test('offsets stay within bounds across an astral character (𠮷)', () => {
  const text = '𠮷「あ」'; // 𠮷 = 2 UTF-16 units; the 「」 markers must land at the right offsets
  const toks = decode(buildSemanticTokens(doc(text), rec).data);
  assert.ok(toks.length > 0);
  for (const t of toks) {
    assert.ok(t.char + t.len <= text.length, `in bounds: ${JSON.stringify(t)}`);
  }
  assert.equal(at(toks, 0, 2)?.type, MARKER); // 「 sits just after the astral char
});

test('punctuation-only body yields no tokens', () => {
  assert.deepEqual(buildSemanticTokens(doc('、。'), rec).data, []);
});

// ----------------------------------------------------------------------- 字下げ / block markup

test('a line-head ［＃３字下げ］: whole inner is one directive', () => {
  const toks = decode(buildSemanticTokens(doc('［＃３字下げ］'), rec).data);
  assert.deepEqual(at(toks, 0, 0), { line: 0, char: 0, len: 2, type: MARKER }); // ［＃
  assert.deepEqual(at(toks, 0, 2), { line: 0, char: 2, len: 4, type: tokenTypeIndex('directive') }); // ３字下げ
  assert.deepEqual(at(toks, 0, 6), { line: 0, char: 6, len: 1, type: MARKER }); // ］
});

test('a mid-line ［＃３字下げ］ greys whole (comment in both layers, no directive)', () => {
  const toks = decode(buildSemanticTokens(doc('本［＃３字下げ］'), rec).data);
  assert.deepEqual(at(toks, 0, 1), { line: 0, char: 1, len: 7, type: MARKER }); // whole annotation
  assert.ok(!toks.some((t) => t.type === tokenTypeIndex('directive')));
});

test('block 字下げ start/end: ここから/ここで/終わり are markers, only ○字下げ is a directive', () => {
  // ［＃(0,1) ここから(2..5) ２字下げ(6..9) ］(10)
  const start = decode(buildSemanticTokens(doc('［＃ここから２字下げ］'), rec).data);
  assert.deepEqual(at(start, 0, 0), { line: 0, char: 0, len: 2, type: MARKER }); // ［＃
  assert.deepEqual(at(start, 0, 2), { line: 0, char: 2, len: 4, type: MARKER }); // ここから
  assert.deepEqual(at(start, 0, 6), { line: 0, char: 6, len: 4, type: tokenTypeIndex('directive') }); // ２字下げ (digit stays with keyword)
  assert.deepEqual(at(start, 0, 10), { line: 0, char: 10, len: 1, type: MARKER }); // ］
  // ［＃(0,1) ここで(2..4) 字下げ(5..7) 終わり(8..10) ］(11)
  const end = decode(buildSemanticTokens(doc('［＃ここで字下げ終わり］'), rec).data);
  assert.deepEqual(at(end, 0, 2), { line: 0, char: 2, len: 3, type: MARKER }); // ここで
  assert.deepEqual(at(end, 0, 5), { line: 0, char: 5, len: 3, type: tokenTypeIndex('directive') }); // 字下げ
  assert.deepEqual(at(end, 0, 8), { line: 0, char: 8, len: 3, type: MARKER }); // 終わり
  assert.deepEqual(at(end, 0, 11), { line: 0, char: 11, len: 1, type: MARKER }); // ］
});

test('block 太字/斜体 (block:true spans): ここから/ここで/終わり are markers, only 太字/斜体 is a directive', () => {
  // ［＃(0,1) ここから(2..5) 太字(6,7) ］(8)
  const start = decode(buildSemanticTokens(doc('［＃ここから太字］'), rec).data);
  assert.deepEqual(at(start, 0, 0), { line: 0, char: 0, len: 2, type: MARKER }); // ［＃
  assert.deepEqual(at(start, 0, 2), { line: 0, char: 2, len: 4, type: MARKER }); // ここから
  assert.deepEqual(at(start, 0, 6), { line: 0, char: 6, len: 2, type: tokenTypeIndex('directive') }); // 太字
  assert.deepEqual(at(start, 0, 8), { line: 0, char: 8, len: 1, type: MARKER }); // ］
  // ［＃(0,1) ここで(2..4) 斜体(5,6) 終わり(7..9) ］(10)
  const end = decode(buildSemanticTokens(doc('［＃ここで斜体終わり］'), rec).data);
  assert.deepEqual(at(end, 0, 2), { line: 0, char: 2, len: 3, type: MARKER }); // ここで
  assert.deepEqual(at(end, 0, 5), { line: 0, char: 5, len: 2, type: tokenTypeIndex('directive') }); // 斜体
  assert.deepEqual(at(end, 0, 7), { line: 0, char: 7, len: 3, type: MARKER }); // 終わり
  assert.deepEqual(at(end, 0, 10), { line: 0, char: 10, len: 1, type: MARKER }); // ］
});

test('inline 太字 span END: 太字 is a directive, 終わり is demoted to a marker', () => {
  // ［＃(0,1) 太字(2,3) 終わり(4..6) ］(7)
  const toks = decode(buildSemanticTokens(doc('［＃太字終わり］'), rec).data);
  assert.deepEqual(at(toks, 0, 0), { line: 0, char: 0, len: 2, type: MARKER }); // ［＃
  assert.deepEqual(at(toks, 0, 2), { line: 0, char: 2, len: 2, type: tokenTypeIndex('directive') }); // 太字
  assert.deepEqual(at(toks, 0, 4), { line: 0, char: 4, len: 3, type: MARKER }); // 終わり
  assert.deepEqual(at(toks, 0, 7), { line: 0, char: 7, len: 1, type: MARKER }); // ］
});

test('inline 傍点 span END: 傍点 is a directive, 終わり is demoted to a marker', () => {
  // ［＃(0,1) 傍点(2,3) 終わり(4..6) ］(7)
  const toks = decode(buildSemanticTokens(doc('［＃傍点終わり］'), rec).data);
  assert.deepEqual(at(toks, 0, 0), { line: 0, char: 0, len: 2, type: MARKER }); // ［＃
  assert.deepEqual(at(toks, 0, 2), { line: 0, char: 2, len: 2, type: tokenTypeIndex('directive') }); // 傍点
  assert.deepEqual(at(toks, 0, 4), { line: 0, char: 4, len: 3, type: MARKER }); // 終わり
  assert.deepEqual(at(toks, 0, 7), { line: 0, char: 7, len: 1, type: MARKER }); // ］
});

test('太字 postfix: は is a marker, 太字 a directive, the target uncovered', () => {
  // ［＃(0,1) 「(2) 本(3) 」(4) は(5) 太字(6,7) ］(8)
  const toks = decode(buildSemanticTokens(doc('［＃「本」は太字］'), rec).data);
  assert.deepEqual(at(toks, 0, 5), { line: 0, char: 5, len: 1, type: MARKER }); // は
  assert.deepEqual(at(toks, 0, 6), { line: 0, char: 6, len: 2, type: tokenTypeIndex('directive') }); // 太字
  assert.ok(!toks.some((t) => t.char <= 3 && t.char + t.len > 3)); // 本 uncovered
});

test('傍線 postfix with の左に: direction prefix + 傍線 directive (form-bound)', () => {
  // 語(0) ［＃(1,2) 「(3) 語(4) 」(5) の左に(6..8) 傍線(9,10) ］(11)
  const toks = decode(buildSemanticTokens(doc('語［＃「語」の左に傍線］'), rec).data);
  assert.deepEqual(at(toks, 0, 6), { line: 0, char: 6, len: 3, type: tokenTypeIndex('direction') });
  assert.deepEqual(at(toks, 0, 9), { line: 0, char: 9, len: 2, type: tokenTypeIndex('directive') });
});

test('a の左に SPAN greys whole (the span form takes bare 左に only)', () => {
  // The wrong-form spelling is a comment token in both layers: ONE whole-annotation marker span,
  // no directive keyword inside. (direction shares the marker colour, so length pins it.)
  const toks = decode(buildSemanticTokens(doc('［＃の左に傍線］'), rec).data);
  assert.deepEqual(toks, [{ line: 0, char: 0, len: 8, type: MARKER }]);
});

test('縦中横 span START/END: 縦中横 is a directive, 終わり demotes to a marker', () => {
  // ［＃(0,1) 縦中横(2..4) ］(5)
  const start = decode(buildSemanticTokens(doc('［＃縦中横］'), rec).data);
  assert.deepEqual(at(start, 0, 2), { line: 0, char: 2, len: 3, type: tokenTypeIndex('directive') });
  // ［＃(0,1) 縦中横(2..4) 終わり(5..7) ］(8)
  const end = decode(buildSemanticTokens(doc('［＃縦中横終わり］'), rec).data);
  assert.deepEqual(at(end, 0, 2), { line: 0, char: 2, len: 3, type: tokenTypeIndex('directive') });
  assert.deepEqual(at(end, 0, 5), { line: 0, char: 5, len: 3, type: MARKER }); // 終わり
});

test('縦中横 postfix: は is a marker, 縦中横 a directive, the target uncovered', () => {
  // 29(0,1) ［＃(2,3) 「(4) 29(5,6) 」(7) は(8) 縦中横(9..11) ］(12)
  const toks = decode(buildSemanticTokens(doc('29［＃「29」は縦中横］'), rec).data);
  assert.deepEqual(at(toks, 0, 8), { line: 0, char: 8, len: 1, type: MARKER }); // は
  assert.deepEqual(at(toks, 0, 9), { line: 0, char: 9, len: 3, type: tokenTypeIndex('directive') }); // 縦中横
  assert.ok(!toks.some((t) => t.char <= 5 && t.char + t.len > 5)); // 29 uncovered
});

test('見出し postfix: は is a marker, the level literal a directive, the target uncovered', () => {
  // 序章(0,1) ［＃(2,3) 「(4) 序章(5,6) 」(7) は(8) 大見出し(9..12) ］(13)
  const toks = decode(buildSemanticTokens(doc('序章［＃「序章」は大見出し］'), rec).data);
  assert.deepEqual(at(toks, 0, 8), { line: 0, char: 8, len: 1, type: MARKER }); // は
  assert.deepEqual(at(toks, 0, 9), { line: 0, char: 9, len: 4, type: tokenTypeIndex('directive') }); // 大見出し
  assert.ok(!toks.some((t) => t.char <= 5 && t.char + t.len > 5)); // 序章 target uncovered
});

test('見出し span START/END: the level literal is a directive, 終わり demotes to a marker', () => {
  // ［＃(0,1) 大見出し(2..5) ］(6)
  const start = decode(buildSemanticTokens(doc('［＃大見出し］'), rec).data);
  assert.deepEqual(at(start, 0, 2), { line: 0, char: 2, len: 4, type: tokenTypeIndex('directive') });
  // ［＃(0,1) 大見出し(2..5) 終わり(6..8) ］(9)
  const end = decode(buildSemanticTokens(doc('［＃大見出し終わり］'), rec).data);
  assert.deepEqual(at(end, 0, 2), { line: 0, char: 2, len: 4, type: tokenTypeIndex('directive') });
  assert.deepEqual(at(end, 0, 6), { line: 0, char: 6, len: 3, type: MARKER }); // 終わり
});

test('見出し block START/END: ここから/ここで/終わり are markers, the level literal a directive', () => {
  // ［＃(0,1) ここから(2..5) 中見出し(6..9) ］(10)
  const start = decode(buildSemanticTokens(doc('［＃ここから中見出し］'), rec).data);
  assert.deepEqual(at(start, 0, 2), { line: 0, char: 2, len: 4, type: MARKER }); // ここから
  assert.deepEqual(at(start, 0, 6), { line: 0, char: 6, len: 4, type: tokenTypeIndex('directive') });
  // ［＃(0,1) ここで(2..4) 小見出し(5..8) 終わり(9..11) ］(12)
  const end = decode(buildSemanticTokens(doc('［＃ここで小見出し終わり］'), rec).data);
  assert.deepEqual(at(end, 0, 2), { line: 0, char: 2, len: 3, type: MARKER }); // ここで
  assert.deepEqual(at(end, 0, 5), { line: 0, char: 5, len: 4, type: tokenTypeIndex('directive') });
  assert.deepEqual(at(end, 0, 9), { line: 0, char: 9, len: 3, type: MARKER }); // 終わり
});

test('左ルビ postfix: 対象 default, の左に direction, reading greyed whole, のルビ directive', () => {
  // 字(0) ［＃(1,2) 「(3) 字(4) 」(5) の左に(6..8) 「(9) よみ(10,11) 」(12) のルビ(13..15) ］(16)
  const toks = decode(buildSemanticTokens(doc('字［＃「字」の左に「よみ」のルビ］'), rec).data);
  assert.deepEqual(at(toks, 0, 6), { line: 0, char: 6, len: 3, type: tokenTypeIndex('direction') }); // の左に
  assert.deepEqual(at(toks, 0, 9), { line: 0, char: 9, len: 4, type: MARKER }); // 「よみ」 like a 《》 reading
  assert.deepEqual(at(toks, 0, 13), { line: 0, char: 13, len: 3, type: tokenTypeIndex('directive') }); // のルビ
  assert.ok(!toks.some((t) => t.char <= 4 && t.char + t.len > 4)); // the 対象 字 keeps default
});

test('unrecognised forms grey whole: 折り返して indent and half-width digits', () => {
  const hang = decode(
    buildSemanticTokens(doc('［＃ここから２字下げ、折り返して３字下げ］'), rec).data,
  );
  assert.deepEqual(at(hang, 0, 0), { line: 0, char: 0, len: 21, type: MARKER });
  assert.ok(!hang.some((t) => t.type === tokenTypeIndex('directive')));
  const half = decode(buildSemanticTokens(doc('［＃ここから2字下げ］'), rec).data);
  assert.deepEqual(at(half, 0, 0), { line: 0, char: 0, len: 11, type: MARKER });
});

test('a multi-line block keeps its body lines free of markup colouring', () => {
  const toks = decode(
    buildSemanticTokens(doc('［＃ここから太字］\n本文\n［＃ここで太字終わり］'), rec).data,
  );
  assert.deepEqual(at(toks, 0, 2), { line: 0, char: 2, len: 4, type: MARKER }); // ここから
  assert.deepEqual(at(toks, 0, 6), { line: 0, char: 6, len: 2, type: tokenTypeIndex('directive') }); // 太字
  assert.deepEqual(at(toks, 2, 2), { line: 2, char: 2, len: 3, type: MARKER }); // ここで
  assert.deepEqual(at(toks, 2, 5), { line: 2, char: 5, len: 2, type: tokenTypeIndex('directive') }); // 太字
  assert.deepEqual(at(toks, 2, 7), { line: 2, char: 7, len: 3, type: MARKER }); // 終わり
  assert.ok(!toks.some((t) => t.line === 1)); // 本文 stays default body colour
});

test('a ｜ base holding an annotation: ｜, the annotation and 《》 are markers; the base is body text', () => {
  // ｜(0) 山(1) 田(2) ［(3) ＃(4) x(5) ］(6) 太(7) 郎(8) 《(9) た(10) ろ(11) う(12) 》(13) は(14)
  // The comment ends a recognition run exactly as it does outside a ruby, so the subject
  // 太郎は after it is what the recogniser sees.
  const toks = decode(buildSemanticTokens(doc('｜山田［＃x］太郎《たろう》は'), rec).data);
  assert.equal(at(toks, 0, 0)?.type, MARKER); // ｜
  assert.equal(at(toks, 0, 0)?.len, 1);
  assert.equal(at(toks, 0, 3)?.type, MARKER); // ［＃x］ (comment, whole)
  assert.equal(at(toks, 0, 3)?.len, 4);
  assert.equal(at(toks, 0, 7)?.type, CHARACTER); // 太郎, base text after the comment
  assert.equal(at(toks, 0, 7)?.len, 2);
  assert.equal(at(toks, 0, 9)?.type, MARKER); // 《たろう
  assert.equal(at(toks, 0, 9)?.len, 4);
  assert.equal(at(toks, 0, 13)?.type, MARKER); // 》
  assert.ok(!covers(toks, 10, CHARACTER)); // the reading is not recognised
});
