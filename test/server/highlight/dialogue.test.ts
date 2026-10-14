/**
 * Dialogue handling in buildSemanticTokens: the 「」『』 stack (nesting, whole-span masking, lenient
 * recovery) and the regression that annotation-internal 「対象」 (［＃「本」に傍点］) never touches it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRecognizer } from '../../../src/server/highlight/recognizer.ts';
import { tokenTypeIndex } from '../../../src/server/semanticTokens.ts';
import { at, buildSemanticTokens, covers, decode, doc, cast } from './tokens.ts';

const MARKER = tokenTypeIndex('marker');
const CHARACTER = tokenTypeIndex('character');
const KEYWORD = tokenTypeIndex('keyword');

// 太郎 / 王都 are cast; 王都 is also a keyword.
const rec = createRecognizer(cast('山田　太郎', '王都'), ['王都']);

test('nested 「…『…』…」: the whole outer span is dialogue; only narration after the close is scanned', () => {
  const text = '「しかも『それをいう？』と、王都さんは話しました」太郎は言った';
  const toks = decode(buildSemanticTokens(doc(text), rec).data);

  // Every corner bracket — outer and inner — is a comment-coloured marker.
  for (let i = 0; i < text.length; i++) {
    if ('「」『』'.includes(text.charAt(i))) {
      assert.equal(at(toks, 0, i)?.type, MARKER, `bracket at ${String(i)} is a marker`);
    }
  }
  // 王都さんは sits inside the OUTER quote (after the inner 』), so it must NOT highlight...
  assert.ok(!covers(toks, text.indexOf('王都さん'), CHARACTER), '王都 inside dialogue is not a character');
  // ...while 太郎は AFTER the matching 」 is narration and highlights (only 太郎, not the は).
  const taro = text.indexOf('太郎は言った');
  assert.equal(at(toks, 0, taro)?.type, CHARACTER);
  assert.equal(at(toks, 0, taro)?.len, 3);
});

test('annotation-internal 「対象」 does not corrupt the dialogue stack', () => {
  // The 「」 inside ［＃…に傍点］ is markup, not dialogue — so 太郎は after it stays a narration subject.
  const text = '［＃「本」に傍点］太郎は';
  const toks = decode(buildSemanticTokens(doc(text), rec).data);
  assert.equal(at(toks, 0, text.indexOf('太郎は'))?.type, CHARACTER);
});

test('dialogue content keeps the body colour even for a configured surface', () => {
  const toks = decode(buildSemanticTokens(doc('「王都は強い」'), rec).data);
  assert.ok(!covers(toks, '「'.length, CHARACTER)); // 王都 not a character inside the quote
  assert.ok(!toks.some((t) => t.type === KEYWORD)); // and not bolded as a keyword either
});

test('an unclosed corner bracket does not throw; the opener is still a marker', () => {
  const toks = decode(buildSemanticTokens(doc('「未完のセリフ'), rec).data);
  assert.equal(at(toks, 0, 0)?.type, MARKER);
});

test('a 「 swallowed by an unclosed ［＃ never opens dialogue', () => {
  // ［＃「未 is one brokenAnnotation; the 「 inside it must not push the stack, so 太郎は on the
  // next line is narration and highlights as a subject.
  const toks = decode(buildSemanticTokens(doc('［＃「未\n太郎は'), rec).data);
  assert.equal(at(toks, 1, 0)?.type, CHARACTER);
  assert.equal(at(toks, 1, 0)?.len, 3);
});
