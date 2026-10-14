/**
 * The per-root vocabulary store: replacement semantics (an applied listing IS the whole state),
 * the union of a root's books deduped by the name's identity, longest-prefix routing with
 * empty-root shadowing, recognizer memoization, the ticket that drops an overtaken listing, the
 * generation that moves only with the names, and the neighbours a book's conflict diagnostics
 * read. Pure in-memory — runs inside plain `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHighlightStore, type BookNames, type RootNames } from '../../../src/server/highlight/vocabulary.ts';
import { metaWith } from '../../shared/book/_fixture.ts';
import { bookNames } from '../helpers.ts';

const ROOT_A = 'file:///ws/a';
const ROOT_B = 'file:///ws/b';

/** A book under `root` whose lists hold `characters` and `keywords`. */
function book(root: string, fileRel: string, characters: readonly string[], keywords: readonly string[] = []): BookNames {
  const lines = [
    ...(characters.length > 0 ? ['characters:', ...characters.map((c) => `  - ${c}`)] : []),
    ...(keywords.length > 0 ? ['keywords:', ...keywords.map((k) => `  - ${k}`)] : []),
  ].join('\n');
  return bookNames(root, fileRel, `${metaWith(lines)}a.jpnov`);
}

function root(rootUri: string, ...books: BookNames[]): RootNames {
  return { rootUri, books };
}

type Store = ReturnType<typeof createHighlightStore>;

/** Applies `roots` as one fresh listing. */
function listed(store: Store, ...roots: RootNames[]): void {
  store.apply(store.ticket(), roots);
}

/** True iff the root's recognizer marks `name` as a character subject in `name + は`. */
function recognizes(store: Store, docUri: string, name: string): boolean {
  return store.recognizerFor(docUri)?.recognize(`${name}は`).some((s) => s.kind === 'character') ?? false;
}

function bolds(store: Store, docUri: string, word: string): boolean {
  return store.recognizerFor(docUri)?.recognize(`その${word}へ`).some((s) => s.kind === 'keyword') ?? false;
}

test('seeding: before any listing there is no vocabulary anywhere', () => {
  const store = createHighlightStore();
  assert.equal(store.recognizerFor(`${ROOT_A}/ch1.jpnov`), undefined);
  assert.deepEqual(store.othersOf(`${ROOT_A}/a.jpbook`), []);
});

test('per-root isolation: each root recognizes only its own books\' cast', () => {
  const store = createHighlightStore();
  listed(store, root(ROOT_A, book(ROOT_A, 'a.jpbook', ['山田　太郎'])), root(ROOT_B, book(ROOT_B, 'b.jpbook', [], ['王都'])));
  assert.ok(recognizes(store, `${ROOT_A}/ch1.jpnov`, '太郎'));
  assert.ok(!bolds(store, `${ROOT_A}/ch1.jpnov`, '王都'));
  assert.ok(bolds(store, `${ROOT_B}/ch1.jpnov`, '王都'));
  assert.ok(!recognizes(store, `${ROOT_B}/ch1.jpnov`, '太郎'));
});

test('the union: every book of the root counts, whichever book a chapter is in; a repeated base once', () => {
  const store = createHighlightStore();
  listed(store, root(ROOT_A,
    book(ROOT_A, 'vol2/vol2.jpbook', ['山田《やまだ》花子《はなこ》', '王都'], ['聖剣']),
    book(ROOT_A, 'vol1/vol1.jpbook', ['山田　太郎', '山田《やまだ》花子']),
  ));
  const doc = `${ROOT_A}/drafts/new.jpnov`; // in no book at all
  for (const name of ['太郎', '山田', '花子', '山田花子', '王都']) {
    assert.ok(recognizes(store, doc, name), name);
  }
  assert.ok(bolds(store, doc, '聖剣'));
  assert.ok(!recognizes(store, doc, '聖剣'), 'a keyword is no subject');
});

test('ruby and ｜ in a name: the parts split at the ruby boundary, the whole base joins', () => {
  const store = createHighlightStore();
  listed(store, root(ROOT_A, book(ROOT_A, 'a.jpbook', ['山田｜花子《はなこ》', '｜John Smith《ジョン・スミス》'])));
  const doc = `${ROOT_A}/ch1.jpnov`;
  assert.ok(recognizes(store, doc, '山田'));
  assert.ok(recognizes(store, doc, '花子'));
  assert.ok(recognizes(store, doc, '山田花子'));
  assert.ok(recognizes(store, doc, 'John Smith'));
  assert.ok(!recognizes(store, doc, 'はなこ'), 'a reading is not matched');
});

test('replacement semantics: a root absent from the next listing is cleared, an empty root shadows its parent', () => {
  const store = createHighlightStore();
  listed(store, root(ROOT_A, book(ROOT_A, 'a.jpbook', ['太郎'])), root(ROOT_B, book(ROOT_B, 'b.jpbook', ['王都'])));
  assert.ok(recognizes(store, `${ROOT_B}/ch1.jpnov`, '王都'));

  listed(store, root(ROOT_A, book(ROOT_A, 'a.jpbook', ['太郎'])));
  assert.equal(store.recognizerFor(`${ROOT_B}/ch1.jpnov`), undefined, 'absent root = no vocabulary');
  assert.ok(recognizes(store, `${ROOT_A}/ch1.jpnov`, '太郎'), 'the surviving root is untouched');

  listed(store, root('file:///ws', book('file:///ws', 'a.jpbook', ['太郎'])), root('file:///ws/sub'), root('file:///ws/deep/', book('file:///ws/deep', 'd.jpbook', ['王都'])));
  assert.ok(recognizes(store, 'file:///ws/ch1.jpnov', '太郎'), 'parent doc uses the parent vocab');
  assert.ok(recognizes(store, 'file:///ws/deep/ch1.jpnov', '王都'), 'deepest matching root wins, a trailing slash aside');
  assert.equal(store.recognizerFor('file:///ws/sub/ch1.jpnov'), undefined, 'the child\'s empty vocabulary shadows the parent\'s');
});

test('memoization and invalidation: one recognizer per entry, rebuilt by the next listing', () => {
  const store = createHighlightStore();
  listed(store, root(ROOT_A, book(ROOT_A, 'a.jpbook', ['太郎'])));
  const first = store.recognizerFor(`${ROOT_A}/ch1.jpnov`);
  assert.ok(first);
  assert.equal(store.recognizerFor(`${ROOT_A}/ch2.jpnov`), first);

  listed(store, root(ROOT_A, book(ROOT_A, 'a.jpbook', ['王都'])));
  const after = store.recognizerFor(`${ROOT_A}/ch1.jpnov`);
  assert.ok(after);
  assert.notEqual(after, first, 'the recognizer instance was rebuilt');
  assert.ok(recognizes(store, `${ROOT_A}/ch1.jpnov`, '王都'));
  assert.ok(!recognizes(store, `${ROOT_A}/ch1.jpnov`, '太郎'));
  // Books with empty lists leave the fast path in place.
  listed(store, root(ROOT_A, book(ROOT_A, 'a.jpbook', [])));
  assert.equal(store.recognizerFor(`${ROOT_A}/ch1.jpnov`), undefined);
});

test('tickets: a listing overtaken by a later one is dropped, the later one stands', () => {
  const store = createHighlightStore();
  const early = store.ticket();
  const late = store.ticket();
  store.apply(late, [root(ROOT_A, book(ROOT_A, 'a.jpbook', ['王都']))]);
  const after = store.generation();
  store.apply(early, [root(ROOT_A, book(ROOT_A, 'a.jpbook', ['太郎']))]);
  assert.equal(store.generation(), after, 'the overtaken listing changed nothing');
  assert.ok(recognizes(store, `${ROOT_A}/ch1.jpnov`, '王都'));
  assert.ok(!recognizes(store, `${ROOT_A}/ch1.jpnov`, '太郎'));
});

test('generation: moves with the names, not with a listing that found the same ones (or none at all)', () => {
  const store = createHighlightStore();
  assert.equal(store.generation(), 0);
  listed(store, root(ROOT_A));
  assert.equal(store.generation(), 1, 'a root appeared (an empty one shadows its parent)');
  listed(store, root(ROOT_A));
  assert.equal(store.generation(), 1, 'the same again');
  listed(store, root(ROOT_A, book(ROOT_A, 'a.jpbook', ['太郎'])));
  assert.equal(store.generation(), 2);
  const rec = store.recognizerFor(`${ROOT_A}/ch1.jpnov`);
  listed(store, root(ROOT_A, book(ROOT_A, 'a.jpbook', ['太郎'])));
  assert.equal(store.generation(), 2, 'the same names again (a title edit, say)');
  assert.equal(store.recognizerFor(`${ROOT_A}/ch1.jpnov`), rec, 'and the recognizer stands');
  listed(store, root(ROOT_A, book(ROOT_A, 'a.jpbook', ['山田《やまだ》太郎《たろう》'])));
  assert.equal(store.generation(), 3, 'another writing of the same base is a change (the conflicts move)');
  listed(store, root(ROOT_A, book(ROOT_A, 'b.jpbook', ['山田《やまだ》太郎《たろう》'])));
  assert.equal(store.generation(), 4, 'the same names in another book is a change (the neighbours move)');
  listed(store);
  assert.equal(store.generation(), 5);
});

test('othersOf: the other books of the root in the order listed, the book itself left out whatever its URI form', () => {
  const store = createHighlightStore();
  const mine = book(ROOT_A, 'vol2/vol2.jpbook', ['太郎']);
  listed(store, root(ROOT_A, book(ROOT_A, 'vol1/vol1.jpbook', []), mine, book(ROOT_A, 'vol3.jpbook', [])), root(ROOT_B, book(ROOT_B, 'b.jpbook', [])));
  assert.deepEqual(store.othersOf(mine.uri).map((b) => b.fileRel), ['vol1/vol1.jpbook', 'vol3.jpbook']);
  // The editor may hold the name composed where the disk had it decomposed, or encode it.
  const decomposed = book(ROOT_A, 'が.jpbook'.normalize('NFD'), []);
  listed(store, root(ROOT_A, decomposed, mine));
  assert.deepEqual(store.othersOf(`${ROOT_A}/${encodeURIComponent('が'.normalize('NFC'))}.jpbook`).map((b) => b.fileRel), ['vol2/vol2.jpbook']);
  assert.deepEqual(store.othersOf('file:///elsewhere/x.jpbook'), []);
});
