/**
 * The items of the `characters:` / `keywords:` lists as names: what reads as a name, how it splits
 * into parts (spaces and ruby boundaries), what makes two items one entry, and the conflicts
 * between books. Pure: runs in plain `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nameBase,
  nameConflicts,
  nameIdentity,
  nameSurfaces,
  readName,
  sameWriting,
  type ListedName,
  type NameEntry,
} from '../../../src/shared/book/names.ts';

function name(text: string): ListedName {
  const read = readName(text);
  assert.ok(read.ok, `${text} should read as a name`);
  return read.name;
}

/** `[base, reading]` per part. */
function parts(text: string): (readonly [string, string | null])[] {
  return name(text).parts.map((p) => [p.base, p.reading] as const);
}

test('a name splits at spaces and at every ruby boundary; its text is the base as written', () => {
  const cases: readonly (readonly [string, (readonly [string, string | null])[], string])[] = [
    ['山田　太郎', [['山田', null], ['太郎', null]], '山田　太郎'],
    ['山田 太郎', [['山田', null], ['太郎', null]], '山田 太郎'],
    ['John Smith', [['John', null], ['Smith', null]], 'John Smith'],
    ['山田《やまだ》花子《はなこ》', [['山田', 'やまだ'], ['花子', 'はなこ']], '山田花子'],
    ['山田《やまだ》花子', [['山田', 'やまだ'], ['花子', null]], '山田花子'],
    ['山田｜花子《はなこ》', [['山田', null], ['花子', 'はなこ']], '山田花子'],
    ['｜山田花子《やまだはなこ》', [['山田花子', 'やまだはなこ']], '山田花子'],
    ['山田花子', [['山田花子', null]], '山田花子'],
    // The implicit base is the Scanner's: the maximal run of one character class.
    ['山田太郎《たろう》', [['山田太郎', 'たろう']], '山田太郎'],
    ['王都《おうと》', [['王都', 'おうと']], '王都'],
    ['｜John Smith《ジョン・スミス》', [['John Smith', 'ジョン・スミス']], 'John Smith'],
    ['※', [['※', null]], '※'],
  ];
  for (const [text, expected, plain] of cases) {
    assert.deepEqual(parts(text), expected, text);
    assert.equal(name(text).text, plain, text);
  }
});

test('an item that is no name: an annotation other than ruby, a marker left as text, a reading alone, nothing', () => {
  for (const text of ['山田［＃「山田」に傍点］', '［＃改ページ］', '《やまだ》', '山田《》', '山田《やまだ', '｜山田', '山田》', '山田］', '｜山田［＃太字］《やまだ》', '※［＃二の字点、1-2-22］']) {
    assert.deepEqual(readName(text), { ok: false, error: 'notPlain' }, text);
  }
  for (const text of ['', ' ', '　 　']) {
    assert.deepEqual(readName(text), { ok: false, error: 'empty' }, JSON.stringify(text));
  }
});

test('identity is the base text alone; writings differ by their parts and readings', () => {
  const taro = name('山田　太郎');
  for (const other of ['山田《やまだ》太郎《たろう》', '山田太郎', '山田 太郎', '｜山田太郎《やまだたろう》']) {
    assert.equal(nameIdentity(name(other)), nameIdentity(taro), other);
  }
  assert.equal(nameIdentity(name('John Smith')), nameIdentity(name('JohnSmith')));
  assert.notEqual(nameIdentity(name('山田　花子')), nameIdentity(taro));
  // A decomposed kana and its composed form are one base.
  assert.equal(nameIdentity(name('が'.normalize('NFD'))), nameIdentity(name('が')));

  assert.ok(sameWriting(taro, name('山田 太郎')), 'the kind of space does not matter');
  assert.ok(!sameWriting(taro, name('山田太郎')), 'a split is a writing');
  assert.ok(!sameWriting(taro, name('山田《やまだ》太郎《たろう》')), 'a reading is a writing');
  assert.ok(!sameWriting(name('山田《やまだ》花子《はなこ》'), name('山田《やまだ》花子')));
  assert.equal(nameBase(name('山田《やまだ》花子《はなこ》')), '山田花子');
});

test('the surfaces a character is recognised by: as written, the parts joined, each part', () => {
  assert.deepEqual(nameSurfaces(name('山田　太郎')), ['山田　太郎', '山田太郎', '山田', '太郎']);
  assert.deepEqual(nameSurfaces(name('山田《やまだ》花子《はなこ》')), ['山田花子', '山田花子', '山田', '花子']);
  assert.deepEqual(nameSurfaces(name('John Smith')), ['John Smith', 'JohnSmith', 'John', 'Smith']);
});

function entries(...texts: string[]): NameEntry[] {
  return texts.map((text, line) => ({ line, text, name: name(text), identity: nameIdentity(name(text)) }));
}

test('conflicts: my items another book writes differently, one per such book; the same writing is none', () => {
  const mine = entries('山田　太郎', '山田　花子', '王都');
  const others = [
    { label: 'vol2/vol2.jpbook', names: entries('山田《やまだ》太郎《たろう》', '山田　花子', '王都《おうと》') },
    { label: 'vol3.jpbook', names: entries('山田太郎') },
    { label: 'vol4.jpbook', names: entries('聖剣') },
  ];
  assert.deepEqual(nameConflicts(mine, others), [
    { line: 0, base: '山田太郎', label: 'vol2/vol2.jpbook' },
    { line: 0, base: '山田太郎', label: 'vol3.jpbook' },
    { line: 2, base: '王都', label: 'vol2/vol2.jpbook' },
  ]);
  assert.deepEqual(nameConflicts(mine, []), []);
  assert.deepEqual(nameConflicts([], others), []);
});
