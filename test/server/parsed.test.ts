/**
 * The parse cache: one scan and one resolve per (uri, version), shared by the three editor
 * features, and nothing kept for a closed document.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { createParseCache } from '../../src/server/parsed.ts';
import { shownLines } from '../../src/server/shown.ts';
import { parse } from '../../src/shared/ast/parse.ts';
import { scan } from '../../src/shared/ast/scan.ts';

const URI = 'file:///a.jpnov';
const SRC = '　山田《やまだ》は語［＃「無」に傍点］と言った!?\n［＃こわれ';
const doc = (src: string, version = 1, uri = URI): TextDocument => TextDocument.create(uri, 'jpnov', version, src);

test('one version is scanned and resolved once; the resolve builds on that scan', () => {
  const cache = createParseCache();
  const d = doc(SRC);
  const syntax = cache.syntaxOf(d);
  assert.equal(cache.syntaxOf(d), syntax);
  const ast = cache.astOf(d);
  assert.equal(cache.astOf(d), ast);
  assert.equal(cache.syntaxOf(d), syntax); // resolving replaces nothing
  assert.deepEqual(syntax, scan(SRC));
  assert.deepEqual(ast, parse(SRC));
});

test('the lines as shown are read once per version, over that version\'s resolve', () => {
  const cache = createParseCache();
  const d = doc(SRC);
  const shown = cache.shownOf(d);
  assert.equal(cache.shownOf(d), shown);
  assert.deepEqual(shown, shownLines(cache.astOf(d)));
  TextDocument.update(d, [{ text: '「あ' }], 2);
  assert.notEqual(cache.shownOf(d), shown);
  assert.equal(cache.shownOf(d)[0]?.depthAtEnd, 1);
});

test('an edit is a new version: the document object is the same, its parse is not', () => {
  const cache = createParseCache();
  const d = doc('本文');
  const before = cache.astOf(d);
  TextDocument.update(d, [{ text: '［＃こわれ' }], 2);
  const after = cache.astOf(d);
  assert.notEqual(after, before);
  assert.deepEqual(after.issues.map((i) => i.kind), ['unclosedAnnotation']);
  assert.deepEqual(cache.syntaxOf(d), scan('［＃こわれ'));
});

test('documents are kept apart by uri; a dropped one is parsed afresh', () => {
  const cache = createParseCache();
  const a = doc('あ', 1, 'file:///a.jpnov');
  const b = doc('い', 1, 'file:///b.jpnov');
  const parsedA = cache.astOf(a);
  assert.notEqual(cache.astOf(b), parsedA);
  assert.equal(cache.astOf(a), parsedA);
  cache.drop(a.uri);
  assert.notEqual(cache.astOf(a), parsedA);
  assert.deepEqual(cache.astOf(a), parsedA);
});
