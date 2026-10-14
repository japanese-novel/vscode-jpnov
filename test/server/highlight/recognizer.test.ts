/**
 * The narration recognizer: the subject/keyword match rules over the surfaces a cast expands to
 * (`nameSurfaces`, tested in test/shared/book/names.test.ts). Pure + sync, so these run directly on
 * Node's native loader (no #/ value imports, no dictionary).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRecognizer, type Recognizer } from '../../../src/server/highlight/recognizer.ts';
import { cast } from './tokens.ts';

/** `kind:surface@start` for each span, sorted by start — compact, order-independent assertions. */
const spans = (r: Recognizer, text: string): string[] =>
  [...r.recognize(text)]
    .sort((a, b) => a.start - b.start)
    .map((s) => `${s.kind}:${text.slice(s.start, s.start + s.len)}@${String(s.start)}`);

test('a name + subject particle highlights as a character; the particle is excluded', () => {
  const r = createRecognizer(cast('山田　太郎'), []);
  assert.deepEqual(spans(r, '太郎は走った'), ['character:太郎は@0']);
  assert.deepEqual(spans(r, '山田太郎が来た'), ['character:山田太郎が@0']);
});

test('an honorific between the name and particle is highlighted together with the name', () => {
  const r = createRecognizer(cast('山田　太郎'), []);
  assert.deepEqual(spans(r, '山田先生が頷いた'), ['character:山田先生が@0']);
  assert.deepEqual(spans(r, '太郎ちゃんは笑った'), ['character:太郎ちゃんは@0']);
});

test('a name with no subject particle (の / を) is not highlighted', () => {
  const r = createRecognizer(cast('山田　太郎'), []);
  assert.deepEqual(spans(r, '太郎の本'), []);
  assert.deepEqual(spans(r, '太郎を見た'), []);
});

test('built-in pronouns are recognised, gated by a subject particle', () => {
  const r = createRecognizer([], ['無関係']); // pronouns are built in, independent of characters
  assert.deepEqual(spans(r, '私は彼女が'), ['character:私は@0', 'character:彼女が@2']);
  assert.deepEqual(spans(r, '私の本'), []); // bare pronoun → nothing
});

test('keywords match exactly and are bolded', () => {
  const r = createRecognizer([], ['聖剣', '王都']);
  assert.deepEqual(spans(r, '聖剣を抜く'), ['keyword:聖剣@0']);
});

test('a surface in both lists: subject form → character, bare → keyword', () => {
  const r = createRecognizer(cast('王都'), ['王都']);
  assert.deepEqual(spans(r, '王都は強い'), ['character:王都は@0']); // subject wins
  assert.deepEqual(spans(r, '古の王都の力'), ['keyword:王都@2']); // bare → keyword
});
