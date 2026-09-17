/**
 * Parity guard for the two message renderers. `renderEnglish` (src/shared/messages.ts, used by the
 * vscode-free server to fill the English Diagnostic.message fallback) and `renderMessage`
 * (src/client/messages.ts, `vscode.l10n.t` whose English literal is the bundle KEY) MUST share
 * byte-identical English templates, or a JA-locale user and the English fallback would diverge.
 *
 * Under the vscode mock, `l10n.t` passes the English source through (substituting {0}/{1}), so
 * `renderMessage` in "English locale" must equal `renderEnglish` for every code + args.
 *
 * Runs in CI via `npm run test:integration`; for direct runs see test/client/README.md.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { FRONT_MATTER_KEYS } from '../../src/shared/book/jpbook.ts';
import { renderEnglish } from '../../src/shared/messages.ts';
import type { MsgCode } from '../../src/shared/protocol.ts';
import { buildVscode, createMockState } from './_vscodeMock.ts';

mock.module('vscode', { namedExports: buildVscode(createMockState()) });

const { renderMessage } = await import('../../src/client/messages.ts');

// Representative args per code. `Record<MsgCode, ...>` forces an entry for EVERY code, so adding a
// new MsgCode without a case here is a COMPILE error — keeping the guard exhaustive.
const ARGS: Record<MsgCode, readonly (string | number)[]> = {
  'book.entryNeedsFileScheme': ['a.jpnov'],
  'book.entryFileNotFound': ['a.jpnov'],
  'book.entryReadFailed': ['a.jpnov', 'EACCES: permission denied'],
  'book.entryNotText': ['a.jpnov'],
  'build.outPathCollision': ['vol1', 'a.jpbook, b.jpbook'],
  'build.failed': ['boom'],
  'jpbook.backslashSeparator': ['sub\\a.jpnov'],
  'jpbook.notJpnov': ['note.md'],
  'jpbook.duplicateEntry': ['a.jpnov'],
  'jpbook.entryIsDirectory': ['adir.jpnov'],
  'jpbook.fileNotFound': ['missing.jpnov'],
  'jpbook.metaNotKeyValue': ['just text'],
  'jpbook.metaUnknownKey': ['publisher', FRONT_MATTER_KEYS.join(', ')],
  'jpbook.metaDuplicateKey': ['title'],
  'jpbook.metaBadEnum': ['footerAlign', 'middle', 'right, left, rightLeft, leftRight, none'],
  'jpbook.metaUnterminated': [],
  'jpbook.coverItemWithoutKey': ['- cover.jpnov'],
  'jpbook.coverNeedsList': ['cover: 表紙.jpnov'],
  'path.empty': [],
  'path.rootDot': [],
  'path.homeRelative': [],
  'path.absolute': [],
  'path.invalid': [],
  'path.escapesRoot': [],
  'syntax.unclosedAnnotation': [],
  'syntax.unterminatedBlock': [],
  'syntax.danglingBlockEnd': [],
  'syntax.unterminatedSpan': [],
  'syntax.danglingSpanEnd': [],
  'syntax.postfixTargetMissing': ['対象'],
  'syntax.unterminatedTcy': [],
  'syntax.danglingTcyEnd': [],
  'syntax.tcyTooLong': [],
  'lint.common.sentenceLength': [],
  'lint.common.maxTen': [],
  'lint.common.maxKanjiRun': [],
  'lint.common.dash': ['―'],
  'lint.common.dash.parity': [],
  'lint.common.ellipsis': [],
  'lint.common.ellipsis.parity': [],
  'lint.common.exclamationSpace': [],
  'lint.common.exclamationRun': [],
  'lint.common.exclamationRun.long': [],
  'lint.common.exclamationRun.single': [],
  'lint.common.arabicDigits': [],
  'lint.common.noTrailingSpace': [],
  'lint.common.blankRun': [],
  'lint.common.noUnmatchedPair': [],
  'lint.common.noHankakuKana': [],
  'lint.common.noNfd': [],
  'lint.common.noZeroWidth': [],
  'lint.common.noControlChar': [],
  'lint.common.shiftJisSafe': ['𠮷', '20BB7'],
  'jpbook.dividerNotEncodable': ['❖'],
  'lint.common.jaNoSpaceBetweenFullWidth': [],
  'lint.common.jaUnnaturalAlphabet': [],
  'lint.common.minusPosition': [],
  'lint.narration.indent': [],
  'lint.narration.endPeriod': [],
  'lint.dialogue.closingPunct': [],
  'lint.dialogue.noIndent': [],
  'lint.ruby.kana': [],
  'server.unexpected': ['boom'],
};

test('renderEnglish and renderMessage share byte-identical English templates', () => {
  for (const code of Object.keys(ARGS) as MsgCode[]) {
    const args = ARGS[code];
    assert.equal(
      renderMessage({ code, args }),
      renderEnglish(code, args),
      `English mismatch for code ${code}`,
    );
  }
});
