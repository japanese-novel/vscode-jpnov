import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VALUE_NAMES } from '../../../src/shared/ast/notation.ts';
import { bookTemplate, COVER_TEMPLATE, normalizeFileInput } from '../../../src/shared/book/create.ts';
import { checkJpbook, HEADER, META_DEFAULTS, META_KEYS, parseJpbook } from '../../../src/shared/book/jpbook.ts';
import { nodesOf } from '../ast/_shape.ts';
import { readRepoFile } from '../repo.ts';

test('normalizeFileInput appends the suffix and normalizes separators', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['my-chapter', 'my-chapter.jpnov'],
    ['my-chapter.jpnov', 'my-chapter.jpnov'],
    ['src/my-chapter', 'src/my-chapter.jpnov'],
    ['src\\my-chapter', 'src/my-chapter.jpnov'],
    ['src//my-chapter', 'src/my-chapter.jpnov'],
    ['./src/./my-chapter/', 'src/my-chapter.jpnov'],
    ['第一章', '第一章.jpnov'],
    // The suffix counts in any letter case and stays as typed (the parser takes it the same way).
    ['x.JPNOV', 'x.JPNOV'],
    ['x.Jpnov', 'x.Jpnov'],
    ['  src/ch  ', 'src/ch.jpnov'],
  ];
  for (const [raw, rel] of cases) {
    assert.deepEqual(normalizeFileInput(raw, '.jpnov'), { ok: true, rel }, raw);
  }
});

test('normalizeFileInput handles the .jpbook suffix the same way', () => {
  assert.deepEqual(normalizeFileInput('作品名', '.jpbook'), { ok: true, rel: '作品名.jpbook' });
  assert.deepEqual(normalizeFileInput('books\\vol1.jpbook', '.jpbook'), { ok: true, rel: 'books/vol1.jpbook' });
  assert.deepEqual(normalizeFileInput('.jpbook', '.jpbook'), { ok: false, error: 'empty' });
});

test('normalizeFileInput normalizes decomposed input to NFC', () => {
  assert.deepEqual(normalizeFileInput('か\u3099', '.jpnov'), { ok: true, rel: 'が.jpnov' });
});

test('normalizeFileInput rejects unusable paths with a typed code', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['.jpnov', 'empty'],
    ['src/.jpnov', 'empty'],
    ['./', 'empty'],
    ['/abs/ch', 'absolute'],
    ['C:\\ch', 'absolute'],
    ['\\\\server\\ch', 'absolute'],
    ['~/ch', 'absolute'],
    ['file:ch', 'absolute'],
    ['..', 'empty'],
    ['../', 'empty'],
    ['a\u0000b', 'badName'],
    ['src/a*b', 'badName'],
    ['.hidden/ch', 'badName'],
    ['src/ch.', 'badName'],
    ['sp ace /ch', 'badName'],
  ];
  for (const [raw, error] of cases) {
    assert.deepEqual(normalizeFileInput(raw, '.jpnov'), { ok: false, error }, raw === '' ? '(empty)' : raw);
  }
});

test('COVER_TEMPLATE is the README sample, verbatim, in both languages', () => {
  for (const file of ['README.md', 'README.en.md']) {
    assert.ok(readRepoFile(file).includes(COVER_TEMPLATE.trimEnd()), file);
  }
});

test('COVER_TEMPLATE shows values the notation names', () => {
  // Any other name prints as itself and raises no diagnostic: only this catches a renamed value.
  const shown = nodesOf(COVER_TEMPLATE).flatMap((node) => (node.kind === 'valueField' ? [node.name.text] : []));
  assert.deepEqual(shown, [VALUE_NAMES.title, VALUE_NAMES.author, VALUE_NAMES.totalPages, VALUE_NAMES.sheets]);
});

test('bookTemplate writes every key at its default, titled after the file, and builds as written', () => {
  const parsed = parseJpbook(bookTemplate('作品名'));
  assert.equal(parsed.fence, parsed.lines.length - 2);
  assert.deepEqual(checkJpbook(parsed), { ok: true, meta: { title: '作品名', ...META_DEFAULTS } });
  // Written out, the template reads exactly as a book of its title alone would.
  assert.deepEqual(parsed.meta, { title: '作品名', ...META_DEFAULTS });
  assert.deepEqual(parsed.lines.slice(0, -1).map((l) => l.kind), ['header', ...META_KEYS.map(() => 'meta'), 'fence']);
  assert.equal(parsed.lines[0]?.value, HEADER);
  assert.ok(bookTemplate('x').endsWith('\n'));
});

test('bookTemplate is the README sample, verbatim, in both languages', () => {
  for (const file of ['README.md', 'README.en.md']) {
    assert.ok(readRepoFile(file).includes(bookTemplate('作品名').trimEnd()), file);
  }
});
