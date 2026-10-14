/**
 * The hand-written .jpbook grammar against the parser: the list-item markers come from
 * jpbook.ts ITEM_MARKS (on drift it prints the class to paste), and the metadata region
 * runs from the top of the file to the fence parseJpbook reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ITEM_MARKS, parseJpbook } from '../../../src/shared/book/jpbook.ts';
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
const MARKERS = `[${ITEM_MARKS.join('')}]`;

test('the .jpbook item rules accept exactly the parser markers: the path rule, then the name rule, then key-value', () => {
  // A cover path or a name may contain a colon, so the item rules have to win over the generic
  // `key: value` rule; a `.jpnov` item is a path, so the path rule comes before the name rule.
  const body = book.repository['metadata-body']?.patterns ?? [];
  const path = body.findIndex((p) => p.match?.includes('.jpnov') === true);
  const keyValue = body.findIndex((p) => p.match?.includes(':：') === true);
  const name = body.findIndex((p, i) => i !== path && i !== keyValue && p.match?.includes(MARKERS) === true);
  assert.ok(path >= 0, 'cover item rule not found in the metadata body');
  assert.ok(name >= 0, 'name item rule not found in the metadata body');
  assert.ok(keyValue >= 0, 'key-value rule not found in the metadata body');
  assert.ok(path < name && name < keyValue, 'the item rules must precede the key-value rule, the path rule first');
  for (const i of [path, name]) {
    const pattern = body[i]?.match ?? '';
    assert.ok(pattern.includes(MARKERS), `stale marker class in:\n${pattern}\nPASTE:\n${MARKERS}`);
  }
  // The name rule paints what the parser reads as a name, markers and indent as the parser takes
  // them (a `---` is the region's end, which the engine tries before the body's rules).
  const paints = new RegExp(body[name]?.match ?? '(?!)');
  for (const [line, isItem] of [['- 山田　太郎', true], ['　－山田《やまだ》', true], ['-', false], ['title: t', false]] as const) {
    assert.equal(paints.test(line), isItem, line);
  }
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
