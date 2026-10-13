/**
 * The hand-written .jpbook grammar against the parser: the cover-item markers come from
 * jpbook.ts COVER_ITEM_MARKS (on drift it prints the class to paste), and the metadata region
 * runs from the top of the file to the fence parseJpbook reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COVER_ITEM_MARKS, parseJpbook } from '../../../src/shared/book/jpbook.ts';
import { readRepoFile } from '../repo.ts';
import { HEAD } from './_fixture.ts';

interface Rule {
  name?: string;
  match?: string;
  begin?: string;
  end?: string;
  patterns?: Rule[];
  include?: string;
}

const book = JSON.parse(readRepoFile('syntaxes/jpbook.tmLanguage.json')) as {
  patterns: Rule[];
  repository: Record<string, { patterns: Rule[] } | undefined>;
};

const region = book.patterns.find((p) => p.begin !== undefined);
const MARKERS = `[${COVER_ITEM_MARKS.join('')}]`;

test('the .jpbook item rule accepts exactly the parser cover markers, before the key-value rule', () => {
  // A cover path may contain a colon, so the item rule has to win over the generic `key: value` rule.
  const body = book.repository['metadata-body']?.patterns ?? [];
  const item = body.findIndex((p) => p.match?.includes('.jpnov') === true);
  const keyValue = body.findIndex((p) => p.match?.includes(':：') === true);
  assert.ok(item >= 0, 'cover item rule not found in the metadata body');
  assert.ok(keyValue >= 0, 'key-value rule not found in the metadata body');
  assert.ok(item < keyValue, 'the item rule must precede the key-value rule (a path may contain a colon)');
  const pattern = body[item]?.match ?? '';
  assert.ok(pattern.includes(MARKERS), `stale cover-marker class in:\n${pattern}\nPASTE:\n${MARKERS}`);
});

test('the .jpbook metadata region is one rule from the document start over the metadata body', () => {
  assert.ok(region, 'metadata region rule not found');
  assert.equal(book.patterns.filter((p) => p.begin !== undefined).length, 1);
  assert.equal(region.name, 'meta.metadata.jpbook');
  assert.equal(region.begin, '\\A', 'nothing opens the metadata: it starts at the top');
  assert.deepEqual(region.patterns, [{ include: '#metadata-body' }]);
});

test('the .jpbook metadata region ends on exactly the lines the parser reads as the fence', () => {
  assert.ok(region?.end !== undefined);
  const ends = new RegExp(region.end);
  for (const line of ['---', '  ---', '---  ', '　---　', '\t---', '----', '- --', '--', '--- x', 'title: ---']) {
    // Prefixed with a key line so the parser is still in the metadata when it meets `line`.
    const parsed = parseJpbook(`${HEAD}title: t\n${line}`);
    assert.equal(ends.test(line), parsed.fence === 2, JSON.stringify(line));
  }
});
