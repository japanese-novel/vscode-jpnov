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
import type { LocalizableMessage } from '../shared/protocol.ts';

import type { SyncedEdit } from './targets.ts';

/** The `source` field stamped on every diagnostic this server emits. */
const DIAGNOSTIC_SOURCE = 'jpnov';

/** A zero-width range at the document start; file-level diagnostics aren't line-specific. */
const FILE_START_RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
} as const;

/**
 * Builds a `Diagnostic` over an explicit range from a {@link LocalizableMessage}. The English
 * render goes in `.message` (the fallback VS Code shows directly), and the `{code, args}` ride
 * in `.data` so the client's `handleDiagnostics` middleware can replace `.message` with the
 * localized text. Callers never hand-write English — it is single-sourced in `renderEnglish`.
 */
export function diagnostic(
  range: Range,
  message: LocalizableMessage,
  severity: DiagnosticSeverity,
): Diagnostic {
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

/** One finding to publish: its diagnostic, plus its fix when there is one to offer. */
export interface Finding {
  readonly diagnostic: Diagnostic;
  readonly fix?: Fix;
}

/** Pairs a diagnostic with an optional fix, omitting `fix` entirely when absent (exactOptional…). */
export function finding(diag: Diagnostic, fix: Fix | undefined): Finding {
  return fix !== undefined ? { diagnostic: diag, fix } : { diagnostic: diag };
}

/** An Error-severity, document-start ("file level") diagnostic. */
export function fileLevelError(message: LocalizableMessage): Diagnostic {
  return diagnostic(FILE_START_RANGE, message, DiagnosticSeverity.Error);
}
