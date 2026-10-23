/**
 * The server's single source for LSP `Diagnostic` construction: one `source: 'jpnov'`
 * constructor plus a file-level (zero-width, doc-start) error helper, so every diagnostic
 * carries an identical `source` and shape — and the {@link Finding} the syntax diagnostics and
 * the lint both publish: a diagnostic with its fix, when one is mechanical.
 *
 * Imports `vscode-languageserver/node`, the shared message renderer and wire types, and a type of
 * `targets.ts`; owns no state and loads no other server module, so it stays a leaf.
 */
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import type { Diagnostic, Range } from 'vscode-languageserver/node';

import { renderEnglish } from '../shared/messages.ts';
import type { LocalizableMessage, Problem } from '../shared/protocol.ts';

import type { SyncedEdit } from './targets.ts';

/** The `source` field stamped on every diagnostic this server emits. */
export const DIAGNOSTIC_SOURCE = 'jpnov';

/** A zero-width range at the document start; file-level diagnostics aren't line-specific. */
const FILE_START_RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
} as const;

/** A diagnostic of this server: its `data` is always the message it was built from. */
export type JpnovDiagnostic = Omit<Diagnostic, 'data'> & { readonly data: LocalizableMessage };

/** The VS Code command that opens the settings editor filtered to the setting key it is given. */
export const OPEN_SETTINGS_COMMAND = 'workbench.action.openSettings';

/** The link behind a lint diagnostic's code in the Problems panel: the settings editor, filtered to the rule's setting. */
function settingLink(settingKey: string): string {
  return `command:${OPEN_SETTINGS_COMMAND}?${encodeURIComponent(JSON.stringify(settingKey))}`;
}

/**
 * Builds a `Diagnostic` over an explicit range from a {@link LocalizableMessage}. The English
 * render goes in `.message` (the fallback VS Code shows directly), and the `{code, args}` ride
 * in `.data` so the client's `handleDiagnostics` middleware can replace `.message` with the
 * localized text. Callers never hand-write English — it is single-sourced in `renderEnglish`.
 */
export function diagnostic(range: Range, message: LocalizableMessage, severity: DiagnosticSeverity): JpnovDiagnostic {
  return {
    range,
    severity,
    source: DIAGNOSTIC_SOURCE,
    // `code` shows in the Problems panel and lets users filter by it; same id as `.data.code`.
    code: message.code,
    message: renderEnglish(message.code, message.args),
    data: message,
  };
}

/** A single auto-fix edit in SOURCE coordinates: a {@link SyncedEdit}, applied with the 「…」 edits it carries. */
export type Fix = SyncedEdit;

/**
 * One finding to publish: its diagnostic, plus its fix when there is one to offer, and for a lint
 * finding the setting key of its rule (the code action "open the setting of this rule").
 */
export interface Finding {
  readonly diagnostic: JpnovDiagnostic;
  readonly fix?: Fix;
  readonly setting?: string;
}

/**
 * Pairs a diagnostic with an optional fix and setting, omitting each when absent (exactOptional…).
 * The setting is where it enters: a lint finding's diagnostic links its code to the rule's setting
 * (the Problems panel opens command links); a syntax or `.jpbook` one has none.
 */
export function finding(diag: JpnovDiagnostic, fix: Fix | undefined, setting?: string): Finding {
  return {
    diagnostic: setting === undefined ? diag : { ...diag, codeDescription: { href: settingLink(setting) } },
    ...(fix !== undefined ? { fix } : {}),
    ...(setting !== undefined ? { setting } : {}),
  };
}

/** A finding as the Books view lists it: the diagnostic's place, severity and message, and whether a fix is on offer. */
export function problemOf(f: Finding): Problem {
  return {
    range: f.diagnostic.range,
    severity: f.diagnostic.severity === DiagnosticSeverity.Error ? 'error' : 'warning',
    message: f.diagnostic.data,
    fixable: f.fix !== undefined,
  };
}

/** An Error-severity, document-start ("file level") diagnostic. */
export function fileLevelError(message: LocalizableMessage): JpnovDiagnostic {
  return diagnostic(FILE_START_RANGE, message, DiagnosticSeverity.Error);
}
