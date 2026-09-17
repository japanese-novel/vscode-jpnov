/**
 * The client side of `jpnov/readText`: an open document's live buffer (unsaved edits included,
 * #87), else the disk decoded with the encoding VS Code picks for the uri, and every failure as
 * a wire result.
 *
 * Runs in CI via `npm run test:integration`; for direct runs see test/client/README.md.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { encodeTxt } from '../../src/shared/encoding.ts';
import type { ReadTextFailure } from '../../src/shared/protocol.ts';
import { buildVscode, createMockState, doc, FileType, resetMockState } from './_vscodeMock.ts';

const state = createMockState();
mock.module('vscode', { namedExports: buildVscode(state) });

const { readText } = await import('../../src/client/book/readText.ts');

beforeEach(() => {
  resetMockState(state);
});

const URI = 'file:///ws/src/a.jpnov';
const TEXT = '　山田　太郎は王都へ向かった。';

/** Puts `bytes` on the mock disk at `URI`. */
function seed(bytes: Uint8Array): void {
  state.fsEntries.set(URI, FileType.File);
  state.fsBytes.set(URI, bytes);
}

test('a closed file decodes with the encoding VS Code picks for its uri', async () => {
  seed(encodeTxt(TEXT, 'shiftJis').bytes);
  state.guessedEncoding.set(URI, 'shiftjis');

  assert.deepEqual(await readText({ uri: URI }), { ok: true, text: TEXT });
  assert.deepEqual(state.decodeCalls, [{ uri: URI }]);
});

test('an open document answers with its live text, unsaved edits included, and never reads the disk', async () => {
  // Nothing on the mock disk: a disk read would come back `notFound`.
  state.textDocuments.push(doc(URI, 'jpnov', TEXT, 'shiftjis'));

  assert.deepEqual(await readText({ uri: URI }), { ok: true, text: TEXT });
  assert.deepEqual(state.decodeCalls, []);
});

test('an open document is found across Unicode normalization of its path', async () => {
  const nfc = 'file:///ws/src/ガイド.jpnov'; // the entry as typed into the .jpbook
  state.textDocuments.push(doc(nfc.normalize('NFD'), 'jpnov', TEXT)); // opened by its on-disk (NFD) name

  assert.deepEqual(await readText({ uri: nfc }), { ok: true, text: TEXT });
});

const FAILURES: readonly [string, () => void, ReadTextFailure, string][] = [
  ['a missing file', () => undefined, 'notFound', 'a.jpnov'],
  ['an unreadable file', () => {
    seed(new Uint8Array());
    state.fsReadErrors.set(URI, 'NoPermissions');
  }, 'other', 'NoPermissions'],
  ['binary content', () => {
    seed(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]));
  }, 'notText', 'binary'],
];

for (const [label, arrange, reason, why] of FAILURES) {
  test(`${label} is a "${reason}" result, never a throw`, async () => {
    arrange();

    const result = await readText({ uri: URI });
    assert.ok(!result.ok);
    assert.equal(result.reason, reason);
    assert.ok(result.why.includes(why), result.why);
  });
}
