/**
 * The narration recognizer: the subject/keyword match rules over the surfaces a cast expands to
 * (`nameSurfaces`, tested in test/shared/book/names.test.ts). Pure + sync, so these run directly on
 * Node's native loader (no #/ value imports, no dictionary).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HONORIFICS, PARTICLES, createRecognizer, type Recognizer } from '../../../src/server/highlight/recognizer.ts';
import { fullWidthDigits } from '../../../src/shared/ast/notation.ts';
import { prng } from '../../shared/ast/_fuzz.ts';
import { inLinearTime } from '../../shared/_timing.ts';
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

test('nothing is built in: an unlisted subject never highlights', () => {
  const r = createRecognizer([], ['無関係']);
  assert.deepEqual(spans(r, '私は彼女が'), []);
});

test('a listed word directly after a kanji is not matched', () => {
  const r = createRecognizer(cast('山田　太郎'), ['王都']);
  assert.deepEqual(spans(r, '小山田は'), []); // 山田 inside a longer kanji word
  assert.deepEqual(spans(r, 'お山田は'), ['character:山田は@1']); // after a kana it is a name
  assert.deepEqual(spans(r, '新王都へ'), []); // keywords follow the same rule
  assert.deepEqual(spans(r, '々太郎は'), []); // 々 counts as a kanji
  assert.deepEqual(spans(r, '𠮷太郎は'), []); // an astral kanji (a surrogate pair) too
  assert.deepEqual(spans(r, '王都山田は'), ['keyword:王都@0']); // and the guard holds after a match
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

/** `n` names and keywords the size of a large cast: 人物０００…, 用語０００… (every one unique). */
function vocabulary(n: number): { surfaces: string[]; keywords: string[] } {
  const wide = (i: number): string => fullWidthDigits(i).padStart(3, '０');
  return {
    surfaces: Array.from({ length: n }, (_, i) => `人物${wide(i)}`),
    keywords: Array.from({ length: n }, (_, i) => `用語${wide(i)}`),
  };
}

/** Text in which every position may start a name, a keyword or nothing: the letters
 *  of the vocabulary with particles and honorifics mixed in, from a fixed seed. */
function prose(length: number, seed: number): string {
  const letters = Array.from('人物用語０１２３４５６７８９はがのさん先生彼女私俺、。');
  const r = prng(seed);
  return Array.from({ length }, () => r.pick(letters)).join('');
}

test('the matcher scales with the text, not with the text times the vocabulary (#183)', () => {
  // Trying every entry at every position took 3.5 s here; the index, 0.2 s (every name shares its first unit).
  const { surfaces, keywords } = vocabulary(1000);
  const r = createRecognizer(surfaces, keywords);
  const text = prose(200_000, 7);
  const lines = Array.from({ length: text.length / 100 }, (_, i) => text.slice(i * 100, i * 100 + 100));
  const spans = inLinearTime('1000 names + 1000 keywords over 200k characters', () => lines.flatMap((l) => r.recognize(l)));
  assert.ok(spans.length > 0);
});

/** The rule as written out: at each position the longest entry that starts there, tried one by
 *  one — what the first-character index must reproduce span for span. */
function naive(surfaces: readonly string[], keywords: readonly string[]): Recognizer {
  const longest = (xs: readonly string[]): readonly string[] => [...new Set(xs)].sort((a, b) => b.length - a.length);
  const subjects = longest(surfaces);
  const honorifics = longest(HONORIFICS);
  const keys = longest(keywords);
  const at = (list: readonly string[], text: string, pos: number): string => list.find((s) => text.startsWith(s, pos)) ?? '';
  const afterKanji = (text: string, pos: number): boolean => /[\p{Script=Han}ヶ]$/u.test(text.slice(0, pos));
  return {
    recognize(text) {
      const out: { start: number; len: number; kind: 'character' | 'keyword' }[] = [];
      for (let i = 0; i < text.length;) {
        const name = afterKanji(text, i) ? '' : at(subjects, text, i);
        const after = i + name.length + (name === '' ? 0 : at(honorifics, text, i + name.length).length);
        const particle = name === '' ? '' : at(PARTICLES, text, after);
        const key = particle === '' && !afterKanji(text, i) ? at(keys, text, i) : '';
        if (particle !== '') {
          out.push({ start: i, len: after - i + particle.length, kind: 'character' });
          i = after + particle.length;
        } else if (key !== '') {
          out.push({ start: i, len: key.length, kind: 'keyword' });
          i += key.length;
        } else {
          i += 1;
        }
      }
      return out;
    },
  };
}

test('every match the index returns is what trying every entry at every position returns', () => {
  const { surfaces, keywords } = vocabulary(12);
  const cast12 = [...surfaces, ...cast('山田　太郎', '人物')];
  const keys12 = [...keywords, '人物０'];
  const indexed = createRecognizer(cast12, keys12);
  const reference = naive(cast12, keys12);
  for (let seed = 1; seed <= 40; seed += 1) {
    const text = prose(400, seed);
    assert.deepEqual([...indexed.recognize(text)], [...reference.recognize(text)], text);
  }
});
