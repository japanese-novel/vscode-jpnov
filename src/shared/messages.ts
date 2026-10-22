/**
 * The English message templates for every {@link MsgCode}, single-sourced and vscode-free. A
 * template is the l10n bundle key (`vscode.l10n.t` looks the English string up): the client passes
 * it to `vscode.l10n.t` with the args, the server fills it with {@link renderEnglish}.
 *
 * Imports only the wire types; never `vscode` (this stays a dependency-free leaf the server can use).
 */
import type { LocalizableMessage, MsgCode } from './protocol.ts';

/** The English template of each code; `{n}` is the n-th positional argument. */
export const TEMPLATES: Readonly<Record<MsgCode, string>> = {
  'book.entryFileNotFound': 'cannot read "{0}": file not found',
  'book.entryReadFailed': 'cannot read "{0}": {1}',
  'book.entryNotText': 'cannot read "{0}": not a text file',
  'book.entryNoReply': 'cannot read "{0}": the editor did not answer',
  'build.outPathCollision': 'output path "{0}" is claimed by multiple book files: {1}',
  'build.failed': 'build failed: {0}',
  'jpbook.backslashSeparator': 'use "/" as the path separator, not "\\": {0}',
  'jpbook.notJpnov': 'book entries must be .jpnov files: {0}',
  'jpbook.duplicateEntry': 'duplicate entry "{0}" (already listed above)',
  'jpbook.entryIsDirectory': '"{0}" is a directory, not a .jpnov file',
  'jpbook.fileNotFound': 'file not found: {0}',
  'jpbook.metaNotKeyValue': 'metadata lines must be "key: value": {0}',
  'jpbook.metaUnknownKey': 'unknown metadata key "{0}" (known keys: {1})',
  'jpbook.metaDuplicateKey': 'duplicate metadata key "{0}" (the first value wins)',
  'jpbook.dividerNotEncodable': '"{0}" can become 〓 in the text output; use another divider mark',
  'jpbook.metaBadEnum': 'invalid value "{1}" for {0} (allowed: {2})',
  'jpbook.metaUnterminated': 'unterminated metadata block (missing a closing ---)',
  'jpbook.headerMissing': 'the first line must be "{0}"',
  'jpbook.versionUnsupported': 'unsupported .jpbook version "{0}" (this extension reads {1})',
  'jpbook.metaEmptyValue': '{0} needs a value',
  'jpbook.itemWithoutKey': 'a "- " item needs a "cover:", "characters:" or "keywords:" line above it; any other key ends the list: {0}',
  'jpbook.nameEmpty': 'an empty item (nothing to recognise); it is ignored',
  'jpbook.nameNotPlain': 'a name is text and ruby only, no annotation and no 「」『』; this item is ignored: {0}',
  'jpbook.nameConflict': '"{0}" is also listed in {1}, written differently (ruby or split)',
  'syntax.unclosedAnnotation': 'unterminated ［＃ annotation (missing ］)',
  'syntax.unterminatedBlock': 'unterminated block annotation (missing ［＃ここで…終わり］)',
  'syntax.danglingBlockEnd': 'block-end annotation without a matching start',
  'syntax.unterminatedSpan': 'unterminated start/end annotation (missing ［＃…終わり］)',
  'syntax.danglingSpanEnd': 'end annotation without a matching start',
  'syntax.spanAlreadyOpen': 'start annotation while {0} is already in effect',
  'syntax.spanFormMismatch': 'end annotation does not match the form of its start (write {0})',
  'syntax.postfixTargetMissing': 'annotation target "{0}" is not on this line, or is not aligned to a character boundary',
  'syntax.unterminatedTcy': 'unterminated 縦中横 (missing ［＃縦中横終わり］ before the end of the line)',
  'syntax.danglingTcyEnd': '［＃縦中横終わり］ without a matching ［＃縦中横］',
  'syntax.tcyTooLong': '縦中横 is too long (keep it to 3 characters or fewer to avoid distortion)',
  'syntax.rubyBaseMissing': 'ruby reading 《{0}》 has no base text before it (it prints as typed; for brackets, write the 二重山括弧 外字注記)',
  'syntax.rubyReadingEmpty': 'empty ruby reading 《》 (it prints as typed)',
  'syntax.rubyInTcy': 'ruby reading {0} is lost to a 縦中横 (a 縦中横 takes no ruby: only its base text prints)',
  'syntax.indentTooLarge': '字下げ is too large (keep it to {0} or less for it to take effect)',
  'syntax.valueFormatUnknown': 'Unknown function "{0}" (the value prints as it is)',
  // hover (the lines of a jpnov/hover reply; see protocol.ts).
  'hover.postfix': '{0} (forward reference)',
  'hover.rubyLeft': 'Left ruby: {0} (forward reference)',
  'hover.spanStart': '{0} start (start/end form)',
  'hover.spanEnd': '{0} end (start/end form)',
  'hover.blockStart': '{0} start (block form)',
  'hover.blockEnd': '{0} end (block form)',
  'hover.indent': 'Indent by {0} ({0} full-width spaces here)',
  'hover.pageBreak': 'Page break',
  'hover.value': "Shows the value of \"{0}\" (the build fills in the book's value)",
  'hover.valueFormat': "Shows the value of \"{0}\" as {1} (the build fills in the book's value)",
  'hover.gaiji': 'External character: {0}',
  'hover.comment': 'Unrecognized annotation (not in the output)',
  'hover.broken': 'Unclosed annotation (prints as typed)',
  'hover.ruby': 'Ruby: {0}',
  'hover.rubyBase': 'Base: {0}',
  'hover.target': 'Target: {0}',
  'hover.targetMissing': 'Target not found',
  'hover.pairEnd': 'Ends at {0} (line {1})',
  'hover.pairStart': 'Starts at {0} (line {1})',
  'hover.endMissing': 'No end annotation',
  'hover.replaced': 'Replaced by the 字下げ on line {0}',
  'hover.startMissing': 'No start annotation',
  'hover.holds': 'Holds: {0}',
  // prose lint (one code per (scope, rule); see lint/catalog.ts); `common` rules run on both 地の文 and セリフ under one code.
  'lint.common.sentenceLength': 'this sentence is too long',
  'lint.common.maxTen': 'too many commas (、) in one sentence',
  'lint.common.maxKanjiRun': 'too many consecutive kanji',
  'lint.common.dash': 'use the configured dash character ({0})',
  'lint.common.dash.parity': 'use an even number of dashes',
  'lint.common.ellipsis': 'use the ellipsis (……) here',
  'lint.common.ellipsis.parity': 'use an even number of ellipsis characters (…)',
  'lint.common.exclamationSpace': 'put a full-width space after ！ or ？',
  'lint.common.exclamationRun': 'use the half-width pair !? so it can sit in one square',
  'lint.common.exclamationRun.long': 'too many ！ or ？ in a row',
  'lint.common.exclamationRun.single': 'use the full-width mark for a single ！ or ？',
  'lint.common.questionExclamationMarks': 'replace {0} with {1} so it sits in one square',
  'lint.common.questionExclamationMarks.tcy': 'add the 縦中横 annotation so {0} sits in one square',
  'lint.common.questionExclamationMarks.cut': 'annotation target "{0}" takes only one mark of "{1}" (the pair stays on its side)',
  'lint.common.arabicDigits': 'too many digits in an Arabic numeral',
  'lint.common.noTrailingSpace': 'spaces at the end of the line',
  'lint.common.blankRun': 'more blank lines than the setting allows',
  'lint.common.noUnmatchedPair': 'unmatched bracket or quote',
  'lint.common.noHankakuKana': 'half-width kana; use full-width kana',
  'lint.common.noNfd': 'decomposed (NFD) characters; use composed (NFC) form',
  'lint.common.noZeroWidth': 'zero-width space',
  'lint.common.noControlChar': 'invalid control character',
  'lint.common.shiftJisSafe': '"{0}" (U+{1}) is missing from Shift JIS (often an old-form or variant character); use another',
  'lint.common.noHalfWidthSpace': 'space between full-width characters',
  'lint.common.noStrayLetter': 'a stray letter between Japanese characters',
  'lint.common.minusPosition': 'a minus sign is allowed only before a number',
  'lint.narration.indent': 'the line does not start with a full-width space (　)',
  'lint.narration.endPeriod': 'this sentence does not end with a period (。)',
  'lint.dialogue.closingPunct': 'a period or comma right before the closing bracket',
  'lint.dialogue.noIndent': 'a dialogue line starts with a full-width space',
  'lint.ruby.kana': 'ruby reading should be all hiragana or all katakana',
  'codeAction.openSetting': 'Open the "{0}" setting',
  'server.unexpected': 'unexpected error: {0}',
};

/** A template's `{n}` slot: one digit, as `vscode.l10n.t` reads it. */
const SLOT = /\{(\d)\}/g;

/** `template` with every `{n}` slot filled from `args`; a missing argument renders as ''. */
export function fillSlots(template: string, args: readonly (string | number)[]): string {
  return template.replace(SLOT, (_, i: string) => String(args[Number(i)] ?? ''));
}

/** How many slots each template has (the highest `{n}` plus one), counted once. */
export const SLOT_COUNTS: Readonly<Record<MsgCode, number>> = Object.fromEntries(
  Object.entries(TEMPLATES).map(([code, template]) => [code, Math.max(0, ...[...template.matchAll(SLOT)].map((m) => Number(m[1]) + 1))]),
) as Record<MsgCode, number>;

/** Render a code + positional args to its English string; a missing argument renders as ''. */
export function renderEnglish(code: MsgCode, args: readonly (string | number)[] = []): string {
  return fillSlots(TEMPLATES[code], args);
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
