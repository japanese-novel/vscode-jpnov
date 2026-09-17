/**
 * Client-side renderer for server-origin {@link LocalizableMessage}s (build errors, config-state
 * errors, and — via the diagnostic middleware in `extension.ts` — diagnostics).
 *
 * The English literals passed to `vscode.l10n.t()` here are the l10n bundle KEYS (vscode.l10n uses
 * the English message as the lookup key); Japanese lives in `l10n/bundle.l10n.ja.json`. They MUST
 * match `src/shared/messages.ts` `renderEnglish()` byte-for-byte — a unit test asserts parity.
 */
import * as vscode from 'vscode';

import type { LocalizableMessage } from '#/shared/protocol.ts';

/** Runtime guard for an `LSPAny` (a Diagnostic's `data`, or a custom-payload field). */
export function isLocalizableMessage(value: unknown): value is LocalizableMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

/** Render a server {@link LocalizableMessage} to localized UI text. Exhaustive over `MsgCode`. */
export function renderMessage(msg: LocalizableMessage): string {
  const a = msg.args ?? [];
  const s = (i: number): string => String(a[i] ?? '');
  switch (msg.code) {
    case 'book.entryNeedsFileScheme':
      return vscode.l10n.t('cannot read "{0}": book files require a file:// workspace', s(0));
    case 'book.entryFileNotFound':
      return vscode.l10n.t('cannot read "{0}": file not found', s(0));
    case 'book.entryReadFailed':
      return vscode.l10n.t('cannot read "{0}": {1}', s(0), s(1));
    case 'book.entryNotText':
      return vscode.l10n.t('cannot read "{0}": not a text file', s(0));
    case 'build.outPathCollision':
      return vscode.l10n.t('output path "{0}" is claimed by multiple book files: {1}', s(0), s(1));
    case 'build.failed':
      return vscode.l10n.t('build failed: {0}', s(0));
    case 'jpbook.backslashSeparator':
      return vscode.l10n.t('use "/" as the path separator, not "\\": {0}', s(0));
    case 'jpbook.notJpnov':
      return vscode.l10n.t('book entries must be .jpnov files: {0}', s(0));
    case 'jpbook.duplicateEntry':
      return vscode.l10n.t('duplicate entry "{0}" (already listed above)', s(0));
    case 'jpbook.entryIsDirectory':
      return vscode.l10n.t('"{0}" is a directory, not a .jpnov file', s(0));
    case 'jpbook.fileNotFound':
      return vscode.l10n.t('file not found: {0}', s(0));
    case 'jpbook.metaNotKeyValue':
      return vscode.l10n.t('metadata lines must be "key: value": {0}', s(0));
    case 'jpbook.metaUnknownKey':
      return vscode.l10n.t('unknown metadata key "{0}" (known keys: {1})', s(0), s(1));
    case 'jpbook.metaDuplicateKey':
      return vscode.l10n.t('duplicate metadata key "{0}" (the first value wins)', s(0));
    case 'jpbook.dividerNotEncodable':
      return vscode.l10n.t('"{0}" can become 〓 in the text output; use another divider mark', s(0));
    case 'jpbook.metaBadEnum':
      return vscode.l10n.t('invalid value "{1}" for {0} (allowed: {2})', s(0), s(1), s(2));
    case 'jpbook.metaUnterminated':
      return vscode.l10n.t('unterminated metadata block (missing a closing ---)');
    case 'jpbook.coverItemWithoutKey':
      return vscode.l10n.t(
        'a "- " item needs a bare "cover:" line above it; any other key ends the list: {0}',
        s(0),
      );
    case 'jpbook.coverNeedsList':
      return vscode.l10n.t('write "cover:" alone, then one "- path" line per cover file: {0}', s(0));
    case 'path.empty':
      return vscode.l10n.t('a book entry must not be empty');
    case 'path.rootDot':
      return vscode.l10n.t('a book entry must name a subpath, not the root "."');
    case 'path.homeRelative':
      return vscode.l10n.t('a book entry must not start with "~" (home-relative)');
    case 'path.absolute':
      return vscode.l10n.t('a book entry must be a relative path, not absolute');
    case 'path.invalid':
      return vscode.l10n.t('a book entry is not a valid path');
    case 'path.escapesRoot':
      return vscode.l10n.t('a book entry must not escape the workspace root');
    case 'syntax.unclosedAnnotation':
      return vscode.l10n.t('unterminated ［＃ annotation (missing ］)');
    case 'syntax.unterminatedBlock':
      return vscode.l10n.t('unterminated block annotation (missing ［＃ここで…終わり］)');
    case 'syntax.danglingBlockEnd':
      return vscode.l10n.t('block-end annotation without a matching start');
    case 'syntax.unterminatedSpan':
      return vscode.l10n.t('unterminated start/end annotation (missing ［＃…終わり］)');
    case 'syntax.danglingSpanEnd':
      return vscode.l10n.t('end annotation without a matching start');
    case 'syntax.postfixTargetMissing':
      return vscode.l10n.t('annotation target "{0}" is not on this line, or is not aligned to a character boundary', s(0));
    case 'syntax.unterminatedTcy':
      return vscode.l10n.t('unterminated 縦中横 (missing ［＃縦中横終わり］ before the end of the line)');
    case 'syntax.danglingTcyEnd':
      return vscode.l10n.t('［＃縦中横終わり］ without a matching ［＃縦中横］');
    case 'syntax.tcyTooLong':
      return vscode.l10n.t('縦中横 is too long (keep it to 3 characters or fewer to avoid distortion)');
    // prose lint (kept byte-identical to renderEnglish).
    case 'lint.common.sentenceLength':
      return vscode.l10n.t('this sentence is too long');
    case 'lint.common.maxTen':
      return vscode.l10n.t('too many commas (、) in one sentence');
    case 'lint.common.maxKanjiRun':
      return vscode.l10n.t('too many consecutive kanji');
    case 'lint.common.dash':
      return vscode.l10n.t('use the configured dash character ({0})', s(0));
    case 'lint.common.dash.parity':
      return vscode.l10n.t('use an even number of dashes');
    case 'lint.common.ellipsis':
      return vscode.l10n.t('use the ellipsis (……) here');
    case 'lint.common.ellipsis.parity':
      return vscode.l10n.t('use an even number of ellipsis characters (…)');
    case 'lint.common.exclamationSpace':
      return vscode.l10n.t('put a full-width space after ！ or ？');
    case 'lint.common.exclamationRun':
      return vscode.l10n.t('use the half-width pair !? so it can sit in one square');
    case 'lint.common.exclamationRun.long':
      return vscode.l10n.t('too many ！ or ？ in a row');
    case 'lint.common.exclamationRun.single':
      return vscode.l10n.t('use the full-width mark for a single ！ or ？');
    case 'lint.common.arabicDigits':
      return vscode.l10n.t('too many digits in an Arabic numeral');
    case 'lint.common.noTrailingSpace':
      return vscode.l10n.t('spaces at the end of the line');
    case 'lint.common.blankRun':
      return vscode.l10n.t('more blank lines than the setting allows');
    case 'lint.common.noUnmatchedPair':
      return vscode.l10n.t('unmatched bracket or quote');
    case 'lint.common.noHankakuKana':
      return vscode.l10n.t('half-width kana; use full-width kana');
    case 'lint.common.noNfd':
      return vscode.l10n.t('decomposed (NFD) characters; use composed (NFC) form');
    case 'lint.common.noZeroWidth':
      return vscode.l10n.t('zero-width space');
    case 'lint.common.noControlChar':
      return vscode.l10n.t('invalid control character');
    case 'lint.common.shiftJisSafe':
      return vscode.l10n.t('"{0}" (U+{1}) is missing from Shift JIS (often an old-form or variant character); use another', s(0), s(1));
    case 'lint.common.jaNoSpaceBetweenFullWidth':
      return vscode.l10n.t('space between full-width characters');
    case 'lint.common.jaUnnaturalAlphabet':
      return vscode.l10n.t('a stray letter between Japanese characters');
    case 'lint.common.minusPosition':
      return vscode.l10n.t('a minus sign is allowed only before a number');
    case 'lint.narration.indent':
      return vscode.l10n.t('the line does not start with a full-width space (　)');
    case 'lint.narration.endPeriod':
      return vscode.l10n.t('this sentence does not end with a period (。)');
    case 'lint.dialogue.closingPunct':
      return vscode.l10n.t('a period or comma right before the closing bracket');
    case 'lint.dialogue.noIndent':
      return vscode.l10n.t('a dialogue line starts with a full-width space');
    case 'lint.ruby.kana':
      return vscode.l10n.t('ruby reading should be all hiragana or all katakana');
    case 'server.unexpected':
      return vscode.l10n.t('unexpected error: {0}', s(0));
    default: {
      const exhaustive: never = msg.code;
      throw new Error(`renderMessage: unhandled code ${String(exhaustive)}`);
    }
  }
}
