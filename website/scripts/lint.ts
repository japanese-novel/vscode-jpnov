/**
 * The product's lint and syntax diagnostics for a sample, with the Japanese messages the client
 * shows (looked up in the l10n bundle by the English template, exactly as the extension does),
 * plus the `source.fixAll` action applied through the real code-action builder.
 */
import { CodeActionKind } from 'vscode-languageserver-types';
import type { Diagnostic } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { DIAGNOSTIC_SOURCE } from '../../src/server/diagnostics.ts';
import { buildCodeActions } from '../../src/server/lint/codeActions.ts';
import { computeLintFindings } from '../../src/server/lint/engine.ts';
import { syntaxFindings } from '../../src/server/syntax.ts';
import type { Ast } from '../../src/shared/ast/nodes.ts';
import { parse } from '../../src/shared/ast/parse.ts';
import { shippedLintConfig } from '../../src/shared/lint/catalog.ts';
import { selectRules } from '../../src/shared/lint/select.ts';
import { TEMPLATES } from '../../src/shared/messages.ts';
import type { LocalizableMessage } from '../../src/shared/protocol.ts';
import type { DiagnosticOut, Range } from './contract.ts';
import { ja } from './l10n.ts';

const URI = 'file:///sample.jpnov';

/** A sample as the server holds it: the document and the editor's parse of it. */
export function sampleDocument(src: string): { doc: TextDocument; ast: Ast } {
  return { doc: TextDocument.create(URI, 'jpnov', 1, src), ast: parse(src) };
}

/** The rule selection for untouched settings; plain data, so one serves every sample. */
const RULES = selectRules(shippedLintConfig());

/** The Japanese the client shows: the English template is the bundle key; the args fill the same `{n}` slots afterwards. */
export function localize(message: LocalizableMessage): string {
  return ja(TEMPLATES[message.code], ...(message.args ?? []).map(String));
}

function toRange(range: Diagnostic['range']): Range {
  return { start: { ...range.start }, end: { ...range.end } };
}

/** A diagnostic as VS Code lists it: the message, then the product's `source` and the code. */
function toOut(diag: Diagnostic): DiagnosticOut {
  const message = diag.data as LocalizableMessage;
  return { source: DIAGNOSTIC_SOURCE, code: message.code, range: toRange(diag.range), message: localize(message) };
}

export interface LintResult {
  readonly diagnostics: readonly DiagnosticOut[];
  /** The source after the `source.fixAll` action, or null when nothing is fixable. */
  readonly fixAll: string | null;
}

export function lintSource(src: string): LintResult {
  const { doc, ast } = sampleDocument(src);
  const findings = computeLintFindings(doc, ast, RULES);
  const diagnostics = [...findings, ...syntaxFindings(doc, ast)].map((finding) => toOut(finding.diagnostic));
  const whole = { start: { line: 0, character: 0 }, end: doc.positionAt(src.length) };
  const action = buildCodeActions(URI, findings, whole, undefined).find((a) => a.kind === CodeActionKind.SourceFixAll);
  if (action === undefined) {
    return { diagnostics, fixAll: null };
  }
  return { diagnostics, fixAll: TextDocument.applyEdits(doc, [...(action.edit?.changes?.[URI] ?? [])]) };
}
