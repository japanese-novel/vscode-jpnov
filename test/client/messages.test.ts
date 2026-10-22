/**
 * `renderMessage` (the client, through `vscode.l10n.t`) and `renderEnglish` (the server's fallback)
 * fill the one shared template alike: every code, every slot, a missing argument as ''.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { renderEnglish, TEMPLATES } from '../../src/shared/messages.ts';
import type { MsgCode } from '../../src/shared/protocol.ts';
import { buildVscode, createMockState } from './_vscodeMock.ts';

const state = createMockState();
mock.module('vscode', { exports: buildVscode(state) });
const { renderMessage } = await import('../../src/client/messages.ts');

test('renderMessage renders every code as renderEnglish does, under the mock l10n', () => {
  for (const code of Object.keys(TEMPLATES) as MsgCode[]) {
    for (const args of [[], ['A'], ['A', 'B', 'C', 'D']]) {
      assert.equal(renderMessage({ code, args }), renderEnglish(code, args), `${code} ${JSON.stringify(args)}`);
    }
  }
});
