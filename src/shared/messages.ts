/**
 * The English message templates for every {@link MsgCode}, single-sourced and vscode-free.
 *
 * The forked server (no `vscode.l10n`) uses {@link renderEnglish} to fill the English
 * `Diagnostic.message` FALLBACK and to give thrown {@link LocalizedError}s a readable message.
 * The CLIENT does NOT use this file — it localizes via `vscode.l10n.t()` in
 * `src/client/messages.ts`, whose English literals MUST match these byte-for-byte (a unit test
 * asserts parity across every code). Keep the two in lockstep when adding a code.
 *
 * Imports only the wire types; never `vscode` (this stays a dependency-free leaf the server can use).
 */
import type { LocalizableMessage, MsgCode } from './protocol.ts';

/** Render a code + positional args to its English string. */
export function renderEnglish(code: MsgCode, args: readonly (string | number)[] = []): string {
  const a = (i: number): string => String(args[i] ?? '');
  switch (code) {
    case 'book.entryNeedsFileScheme':
      return `cannot read "${a(0)}": book files require a file:// workspace`;
    case 'book.entryFileNotFound':
      return `cannot read "${a(0)}": file not found`;
    case 'book.entryReadFailed':
      return `cannot read "${a(0)}": ${a(1)}`;
    case 'book.entryNotText':
      return `cannot read "${a(0)}": not a text file`;
    case 'build.outPathCollision':
      return `output path "${a(0)}" is claimed by multiple book files: ${a(1)}`;
    case 'build.failed':
      return `build failed: ${a(0)}`;
    case 'jpbook.backslashSeparator':
      return `use "/" as the path separator, not "\\": ${a(0)}`;
    case 'jpbook.notJpnov':
      return `book entries must be .jpnov files: ${a(0)}`;
    case 'jpbook.duplicateEntry':
      return `duplicate entry "${a(0)}" (already listed above)`;
    case 'jpbook.entryIsDirectory':
      return `"${a(0)}" is a directory, not a .jpnov file`;
    case 'jpbook.fileNotFound':
      return `file not found: ${a(0)}`;
    case 'jpbook.metaNotKeyValue':
      return `metadata lines must be "key: value": ${a(0)}`;
    case 'jpbook.metaUnknownKey':
      return `unknown metadata key "${a(0)}" (known keys: ${a(1)})`;
    case 'jpbook.metaDuplicateKey':
      return `duplicate metadata key "${a(0)}" (the first value wins)`;
    case 'jpbook.dividerNotEncodable':
      return `"${a(0)}" can become 〓 in the text output; use another divider mark`;
    case 'jpbook.metaBadEnum':
      return `invalid value "${a(1)}" for ${a(0)} (allowed: ${a(2)})`;
    case 'jpbook.metaUnterminated':
      return 'unterminated metadata block (missing a closing ---)';
    case 'jpbook.coverItemWithoutKey':
      return `a "- " item needs a bare "cover:" line above it; any other key ends the list: ${a(0)}`;
    case 'jpbook.coverNeedsList':
      return `write "cover:" alone, then one "- path" line per cover file: ${a(0)}`;
    case 'path.empty':
      return 'a book entry must not be empty';
    case 'path.rootDot':
      return 'a book entry must name a subpath, not the root "."';
    case 'path.homeRelative':
      return 'a book entry must not start with "~" (home-relative)';
    case 'path.absolute':
      return 'a book entry must be a relative path, not absolute';
    case 'path.invalid':
      return 'a book entry is not a valid path';
    case 'path.escapesRoot':
      return 'a book entry must not escape the workspace root';
    case 'syntax.unclosedAnnotation':
      return 'unterminated ［＃ annotation (missing ］)';
    case 'syntax.unterminatedBlock':
      return 'unterminated block annotation (missing ［＃ここで…終わり］)';
    case 'syntax.danglingBlockEnd':
      return 'block-end annotation without a matching start';
    case 'syntax.unterminatedSpan':
      return 'unterminated start/end annotation (missing ［＃…終わり］)';
    case 'syntax.danglingSpanEnd':
      return 'end annotation without a matching start';
    case 'syntax.postfixTargetMissing':
      return `annotation target "${a(0)}" is not on this line, or is not aligned to a character boundary`;
    case 'syntax.unterminatedTcy':
      return 'unterminated 縦中横 (missing ［＃縦中横終わり］ before the end of the line)';
    case 'syntax.danglingTcyEnd':
      return '［＃縦中横終わり］ without a matching ［＃縦中横］';
    case 'syntax.tcyTooLong':
      return '縦中横 is too long (keep it to 3 characters or fewer to avoid distortion)';
    case 'syntax.rubyBaseMissing':
      return `ruby reading 《${a(0)}》 has no base text before it (it prints as typed)`;
    case 'syntax.rubyReadingEmpty':
      return 'empty ruby reading 《》 (it prints as typed)';
    // prose lint (one code per (scope, rule); see lint/catalog.ts).
    // `common` rules run on both 地の文 + セリフ under one code; JA lives in bundle.l10n.ja.json.
    case 'lint.common.sentenceLength':
      return 'this sentence is too long';
    case 'lint.common.maxTen':
      return 'too many commas (、) in one sentence';
    case 'lint.common.maxKanjiRun':
      return 'too many consecutive kanji';
    case 'lint.common.dash':
      return `use the configured dash character (${a(0)})`;
    case 'lint.common.dash.parity':
      return 'use an even number of dashes';
    case 'lint.common.ellipsis':
      return 'use the ellipsis (……) here';
    case 'lint.common.ellipsis.parity':
      return 'use an even number of ellipsis characters (…)';
    case 'lint.common.exclamationSpace':
      return 'put a full-width space after ！ or ？';
    case 'lint.common.exclamationRun':
      return 'use the half-width pair !? so it can sit in one square';
    case 'lint.common.exclamationRun.long':
      return 'too many ！ or ？ in a row';
    case 'lint.common.exclamationRun.single':
      return 'use the full-width mark for a single ！ or ？';
    case 'lint.common.arabicDigits':
      return 'too many digits in an Arabic numeral';
    case 'lint.common.noTrailingSpace':
      return 'spaces at the end of the line';
    case 'lint.common.blankRun':
      return 'more blank lines than the setting allows';
    case 'lint.common.noUnmatchedPair':
      return 'unmatched bracket or quote';
    case 'lint.common.noHankakuKana':
      return 'half-width kana; use full-width kana';
    case 'lint.common.noNfd':
      return 'decomposed (NFD) characters; use composed (NFC) form';
    case 'lint.common.noZeroWidth':
      return 'zero-width space';
    case 'lint.common.noControlChar':
      return 'invalid control character';
    case 'lint.common.shiftJisSafe':
      return `"${a(0)}" (U+${a(1)}) is missing from Shift JIS (often an old-form or variant character); use another`;
    case 'lint.common.jaNoSpaceBetweenFullWidth':
      return 'space between full-width characters';
    case 'lint.common.jaUnnaturalAlphabet':
      return 'a stray letter between Japanese characters';
    case 'lint.common.minusPosition':
      return 'a minus sign is allowed only before a number';
    case 'lint.narration.indent':
      return 'the line does not start with a full-width space (　)';
    case 'lint.narration.endPeriod':
      return 'this sentence does not end with a period (。)';
    case 'lint.dialogue.closingPunct':
      return 'a period or comma right before the closing bracket';
    case 'lint.dialogue.noIndent':
      return 'a dialogue line starts with a full-width space';
    case 'lint.ruby.kana':
      return 'ruby reading should be all hiragana or all katakana';
    case 'server.unexpected':
      return `unexpected error: ${a(0)}`;
    default: {
      const exhaustive: never = code;
      throw new Error(`renderEnglish: unhandled code ${String(exhaustive)}`);
    }
  }
}

/**
 * An Error that carries a {@link LocalizableMessage}. Server code throws it instead of a plain
 * `Error(text)`; the catch site reads `.localized` to push a code (diagnostic / build error /
 * config-state) instead of a raw string. The `Error.message` is the English render, so stack
 * traces and logs stay readable.
 */
export class LocalizedError extends Error {
  readonly localized: LocalizableMessage;

  constructor(localized: LocalizableMessage) {
    super(renderEnglish(localized.code, localized.args));
    this.localized = localized;
  }
}
