/**
 * Integration test for `jpnov.preview.pickFont`: a 明朝 family from the list, a typed CSS font
 * list, or the default again, written to `jpnov.layout.fontFamily` in the settings the author
 * picks; a dismissal at any step writes nothing.
 *
 * Runs in CI via `npm run test:integration`; for direct runs see test/client/README.md.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildVscode, ConfigurationTarget, createMockState, resetMockState, Uri } from './_vscodeMock.ts';

const state = createMockState();
mock.module('vscode', { exports: buildVscode(state) });

const { pickFont } = await import('../../src/client/preview/font.ts');

const KEY = 'jpnov.layout.fontFamily';

beforeEach(() => {
  resetMockState(state);
});

/** What the font pick listed: label and the value it resolves to; a family's row shows its list as the description. */
function rows(): [string, string | null | undefined][] {
  const items = state.quickPickCalls[0]?.items as { label: string; description?: string; value?: string | null }[] | undefined;
  assert.ok(items, 'the font pick opened');
  for (const i of items) {
    assert.equal(i.description, typeof i.value === 'string' ? i.value : i.description, i.label);
  }
  return items.map((i) => [i.label, i.value]);
}

test('a family from the list is written as its font list, to the picked settings', async () => {
  state.quickPickQueue.push({ value: '"Yu Mincho", "YuMincho", serif' }, { target: ConfigurationTarget.Global });
  await pickFont();

  assert.deepEqual(rows(), [
    ['Hiragino Mincho', '"Hiragino Mincho ProN", serif'],
    ['Yu Mincho', '"Yu Mincho", "YuMincho", serif'],
    ['Noto Serif JP', '"Noto Serif JP", "Noto Serif CJK JP", serif'],
    ['BIZ UDMincho', '"BIZ UDMincho", serif'],
    ['Custom font…', undefined],
    ['Restore default', null],
  ]);
  assert.equal((state.quickPickCalls[0]?.items as { description?: string }[])[5]?.description, 'The default Mincho stack');
  assert.deepEqual(state.quickPickCalls[0]?.options, { title: 'Body font', placeHolder: 'Select the body font' });
  assert.deepEqual(state.quickPickCalls[1]?.options, { placeHolder: 'Select where to save' });
  assert.deepEqual(state.inputBoxCalls, []);
  assert.deepEqual(state.configUpdates, [{ key: KEY, value: '"Yu Mincho", "YuMincho", serif', target: ConfigurationTarget.Global }]);
});

test('a custom list is typed over the current value, refused unless the sheet would take it, and written trimmed', async () => {
  state.workspaceFolders = [{ uri: Uri.parse('file:///proj'), name: 'proj', index: 0 }];
  state.config[KEY] = 'serif';
  state.quickPickQueue.push({ label: 'Custom font…' }, { target: ConfigurationTarget.Workspace });
  state.inputBoxQueue.push('  "BIZ UDMincho", serif  ');
  await pickFont();

  const box = state.inputBoxCalls[0]?.options;
  assert.ok(box, 'the custom list is typed into an input box');
  assert.equal(box.value, 'serif');
  assert.equal(box.placeHolder, '"Yu Mincho", serif');
  const validate = box.validateInput;
  assert.ok(validate);
  const refused = 'Enter a CSS font-family list, for example: "Yu Mincho", serif';
  assert.equal(await validate(''), refused);
  assert.equal(await validate('serif;}'), refused);
  assert.equal(await validate('"Yu Mincho'), refused);
  assert.equal(await validate('"Yu Mincho", serif'), null);
  const targets = state.quickPickCalls[1]?.items as { label: string }[];
  assert.deepEqual(targets.map((i) => i.label), ['User Settings', 'Workspace Settings']);
  assert.deepEqual(state.configUpdates, [{ key: KEY, value: '"BIZ UDMincho", serif', target: ConfigurationTarget.Workspace }]);
});

test('"Restore default" removes the key from every scope that holds it, with no target to pick', async () => {
  state.inspectResults.set(`|${KEY}`, { workspaceValue: '"Yu Mincho", serif', globalValue: 'serif' });
  state.quickPickQueue.push({ value: null });
  await pickFont();
  assert.equal(state.quickPickCalls.length, 1, 'no target pick');
  assert.deepEqual(state.configUpdates, [
    { key: KEY, value: undefined, target: ConfigurationTarget.Workspace },
    { key: KEY, value: undefined, target: ConfigurationTarget.Global },
  ]);

  // Written nowhere: nothing to remove.
  resetMockState(state);
  state.quickPickQueue.push({ value: null });
  await pickFont();
  assert.deepEqual(state.configUpdates, []);
});

test('a dismissal at any step writes nothing', async () => {
  state.quickPickQueue.push(undefined);
  await pickFont();

  state.quickPickQueue.push({ label: 'Custom font…' });
  state.inputBoxQueue.push(undefined);
  await pickFont();

  state.quickPickQueue.push({ value: '"BIZ UDMincho", serif' }, undefined);
  await pickFont();

  assert.equal(state.quickPickCalls.length, 4);
  assert.deepEqual(state.configUpdates, []);
});
