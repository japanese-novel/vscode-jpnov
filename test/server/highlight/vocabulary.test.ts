/**
 * The per-book vocabulary store: replacement semantics (an applied listing IS the whole state),
 * a chapter's vocabulary taken from the books that list it (every writing of a name included),
 * recognizer memoization, the ticket that drops an overtaken listing, the generation that moves
 * only with the names and the pages, and the neighbours a book's conflict diagnostics read.
 * Pure in-memory — runs inside plain `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHighlightStore, type ListedBook } from '../../../src/server/highlight/vocabulary.ts';
import { parseJpbook, type ParsedLine } from '../../../src/shared/book/jpbook.ts';
import { metaWith } from '../../shared/book/_fixture.ts';
import { listedBook } from '../helpers.ts';

const DIR = 'file:///ws/a';

/** A book at `dir/fileRel` listing the `chapters` whose lists hold `characters` and `keywords`. */
function book(dir: string, fileRel: string, chapters: readonly string[], characters: readonly string[], keywords: readonly string[] = []): ListedBook {
  const lines = [
    ...(characters.length > 0 ? ['characters:', ...characters.map((c) => `  - ${c}`)] : []),
    ...(keywords.length > 0 ? ['keywords:', ...keywords.map((k) => `  - ${k}`)] : []),
  ].join('\n');
  return listedBook(dir, fileRel, `${metaWith(lines)}${chapters.join('\n')}`);
}

/** The lines of a listed book, as its own conflict check hands them to `othersOf`. */
const linesOf = (b: ListedBook): ParsedLine[] => [...(b.parsed?.lines ?? [])];

type Store = ReturnType<typeof createHighlightStore>;

/** Applies `books` as one fresh listing. */
function listed(store: Store, ...books: ListedBook[]): void {
  store.apply(store.ticket(), books);
}

/** True iff the document's recognizer marks `name` as a character subject in `name + は`. */
function recognizes(store: Store, docUri: string, name: string): boolean {
  return store.recognizerFor(docUri)?.recognize(`${name}は`).some((s) => s.kind === 'character') ?? false;
}

function bolds(store: Store, docUri: string, word: string): boolean {
  return store.recognizerFor(docUri)?.recognize(`その${word}へ`).some((s) => s.kind === 'keyword') ?? false;
}

test('seeding: before any listing there is no vocabulary anywhere', () => {
  const store = createHighlightStore();
  assert.equal(store.recognizerFor(`${DIR}/ch1.jpnov`), undefined);
  assert.deepEqual(store.othersOf(`${DIR}/a.jpbook`, parseJpbook(`${metaWith('')}ch1.jpnov`).lines), []);
});

test('a chapter takes the lists of the book that lists it, and of no other, whatever folder either is in', () => {
  const store = createHighlightStore();
  listed(store, book(DIR, 'a.jpbook', ['ch1.jpnov', '../shared/ch2.jpnov'], ['山田　太郎']), book(DIR, 'b.jpbook', ['ch3.jpnov'], [], ['王都']));
  assert.ok(recognizes(store, `${DIR}/ch1.jpnov`, '太郎'));
  assert.ok(recognizes(store, 'file:///ws/shared/ch2.jpnov', '太郎'), 'a `../` chapter resolves from the book\'s folder');
  assert.ok(!bolds(store, `${DIR}/ch1.jpnov`, '王都'));
  assert.ok(bolds(store, `${DIR}/ch3.jpnov`, '王都'));
  assert.ok(!recognizes(store, `${DIR}/ch3.jpnov`, '太郎'));
  assert.equal(store.recognizerFor(`${DIR}/drafts/new.jpnov`), undefined, 'a chapter in no book, in the same folder, has none');
});

test('a chapter two books list sees both lists, every writing of a name included', () => {
  const store = createHighlightStore();
  listed(store,
    book(DIR, 'vol2/vol2.jpbook', ['../shared.jpnov', 'b.jpnov'], ['山田《やまだ》花子《はなこ》', '王都'], ['聖剣']),
    book(DIR, 'vol1/vol1.jpbook', ['../shared.jpnov'], ['山田　太郎', '山田《やまだ》花子']),
  );
  const doc = `${DIR}/shared.jpnov`;
  for (const name of ['太郎', '山田', '花子', '山田花子', '王都']) {
    assert.ok(recognizes(store, doc, name), name);
  }
  assert.ok(bolds(store, doc, '聖剣'));
  assert.ok(!recognizes(store, doc, '聖剣'), 'a keyword is no subject');
  assert.ok(!recognizes(store, `${DIR}/vol2/b.jpnov`, '太郎'), 'the other chapter of vol2 sees vol2 alone');
});

test('a cover page gets its book\'s vocabulary like a chapter', () => {
  const store = createHighlightStore();
  listed(store, listedBook(DIR, 'a.jpbook', `${metaWith('characters:\n  - 山田　太郎\ncover: front.jpnov')}ch1.jpnov`));
  assert.ok(recognizes(store, `${DIR}/front.jpnov`, '太郎'));
});

test('ruby and ｜ in a name: the parts split at the ruby boundary, the whole base joins', () => {
  const store = createHighlightStore();
  listed(store, book(DIR, 'a.jpbook', ['ch1.jpnov'], ['山田｜花子《はなこ》', '｜John Smith《ジョン・スミス》']));
  const doc = `${DIR}/ch1.jpnov`;
  assert.ok(recognizes(store, doc, '山田'));
  assert.ok(recognizes(store, doc, '花子'));
  assert.ok(recognizes(store, doc, '山田花子'));
  assert.ok(recognizes(store, doc, 'John Smith'));
  assert.ok(!recognizes(store, doc, 'はなこ'), 'a reading is not matched');
});

test('replacement semantics: a book absent from the next listing takes its pages with it', () => {
  const store = createHighlightStore();
  listed(store, book(DIR, 'a.jpbook', ['ch1.jpnov'], ['太郎']), book(DIR, 'b.jpbook', ['ch2.jpnov'], ['王都']));
  assert.ok(recognizes(store, `${DIR}/ch2.jpnov`, '王都'));

  listed(store, book(DIR, 'a.jpbook', ['ch1.jpnov'], ['太郎']));
  assert.equal(store.recognizerFor(`${DIR}/ch2.jpnov`), undefined, 'absent book = no vocabulary for its chapter');
  assert.ok(recognizes(store, `${DIR}/ch1.jpnov`, '太郎'), 'the surviving book is untouched');

  listed(store, book(DIR, 'a.jpbook', ['ch2.jpnov'], ['太郎']));
  assert.equal(store.recognizerFor(`${DIR}/ch1.jpnov`), undefined, 'a chapter dropped from the book loses the vocabulary');
  assert.ok(recognizes(store, `${DIR}/ch2.jpnov`, '太郎'));
});

test('memoization and invalidation: one recognizer per set of listing books, rebuilt by the next listing', () => {
  const store = createHighlightStore();
  listed(store, book(DIR, 'a.jpbook', ['ch1.jpnov', 'ch2.jpnov'], ['太郎']));
  const first = store.recognizerFor(`${DIR}/ch1.jpnov`);
  assert.ok(first);
  assert.equal(store.recognizerFor(`${DIR}/ch2.jpnov`), first, 'the chapters of one book share its recognizer');

  listed(store, book(DIR, 'a.jpbook', ['ch1.jpnov', 'ch2.jpnov'], ['王都']));
  const after = store.recognizerFor(`${DIR}/ch1.jpnov`);
  assert.ok(after);
  assert.notEqual(after, first, 'the recognizer instance was rebuilt');
  assert.ok(recognizes(store, `${DIR}/ch1.jpnov`, '王都'));
  assert.ok(!recognizes(store, `${DIR}/ch1.jpnov`, '太郎'));
  // Books with empty lists leave the fast path in place.
  listed(store, book(DIR, 'a.jpbook', ['ch1.jpnov'], []));
  assert.equal(store.recognizerFor(`${DIR}/ch1.jpnov`), undefined);
});

test('tickets: a listing overtaken by a later one is dropped, the later one stands', () => {
  const store = createHighlightStore();
  const early = store.ticket();
  const late = store.ticket();
  store.apply(late, [book(DIR, 'a.jpbook', ['ch1.jpnov'], ['王都'])]);
  const after = store.generation();
  store.apply(early, [book(DIR, 'a.jpbook', ['ch1.jpnov'], ['太郎'])]);
  assert.equal(store.generation(), after, 'the overtaken listing changed nothing');
  assert.ok(recognizes(store, `${DIR}/ch1.jpnov`, '王都'));
  assert.ok(!recognizes(store, `${DIR}/ch1.jpnov`, '太郎'));
});

test('generation: moves with the names and the pages, not with a listing that found the same ones', () => {
  const store = createHighlightStore();
  assert.equal(store.generation(), 0);
  listed(store);
  assert.equal(store.generation(), 0, 'nothing, again');
  listed(store, book(DIR, 'a.jpbook', ['ch1.jpnov'], ['太郎']));
  assert.equal(store.generation(), 1);
  const rec = store.recognizerFor(`${DIR}/ch1.jpnov`);
  listed(store, book(DIR, 'a.jpbook', ['ch1.jpnov'], ['太郎']));
  assert.equal(store.generation(), 1, 'the same names again (a title edit, say)');
  assert.equal(store.recognizerFor(`${DIR}/ch1.jpnov`), rec, 'and the recognizer stands');
  listed(store, book(DIR, 'a.jpbook', ['ch1.jpnov'], ['山田《やまだ》太郎《たろう》']));
  assert.equal(store.generation(), 2, 'another writing of the same base is a change (the conflicts move)');
  listed(store, book(DIR, 'b.jpbook', ['ch1.jpnov'], ['山田《やまだ》太郎《たろう》']));
  assert.equal(store.generation(), 3, 'the same names in another book is a change (the neighbours move)');
  listed(store, book(DIR, 'b.jpbook', ['ch1.jpnov', 'ch2.jpnov'], ['山田《やまだ》太郎《たろう》']));
  assert.equal(store.generation(), 4, 'a chapter added to the book is a change (it colours now)');
  listed(store, book(DIR, 'b.jpbook', ['ch2.jpnov', 'ch1.jpnov'], ['山田《やまだ》太郎《たろう》']));
  assert.equal(store.generation(), 4, 'the chapters reordered is no change');
  listed(store);
  assert.equal(store.generation(), 5);
});

test('othersOf: the books sharing one of the pages given, in the order listed, the book itself left out whatever its URI form', () => {
  const store = createHighlightStore();
  const mine = book(DIR, 'vol2/vol2.jpbook', ['../shared.jpnov', 'b.jpnov'], ['太郎']);
  const other = book(DIR, 'other.jpbook', ['other.jpnov'], []);
  listed(store,
    book(DIR, 'vol1/vol1.jpbook', ['../shared.jpnov'], []),
    mine,
    book(DIR, 'vol3.jpbook', ['vol2/b.jpnov'], []),
    other,
  );
  assert.deepEqual(store.othersOf(mine.uri, linesOf(mine)).map((b) => b.fileRel), ['vol1/vol1.jpbook', 'vol3.jpbook']);
  assert.deepEqual(store.othersOf(other.uri, linesOf(other)), [], 'a book sharing no page has no neighbour');
  // The lines are the caller's, as its text reads now: an unsaved chapter list finds its neighbours at once.
  assert.deepEqual(store.othersOf(other.uri, parseJpbook(`${metaWith('')}shared.jpnov`).lines).map((b) => b.fileRel), ['vol1/vol1.jpbook', 'vol2/vol2.jpbook']);
  // The editor may hold the name composed where the disk had it decomposed, or encode it.
  const decomposed = book(DIR, 'が.jpbook'.normalize('NFD'), ['shared.jpnov'], []);
  listed(store, decomposed, mine);
  assert.deepEqual(store.othersOf(`${DIR}/${encodeURIComponent('が'.normalize('NFC'))}.jpbook`, linesOf(decomposed)).map((b) => b.fileRel), ['vol2/vol2.jpbook']);
  assert.deepEqual(store.othersOf('file:///elsewhere/x.jpbook', []), []);
});
