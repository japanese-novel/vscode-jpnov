/**
 * The product's lint and syntax diagnostics for a sample, with the Japanese messages the client
 * shows (looked up in the l10n bundle by the English template, exactly as the extension does),
 * plus the `source.fixAll` action applied through the real code-action builder.
 */
import { CodeActionKind } from 'vscode-languageserver-types';
import type { Diagnostic } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { buildCodeActions } from '../../src/server/lint/codeActions.ts';
import { computeLintFindings } from '../../src/server/lint/engine.ts';
import { syntaxFindings } from '../../src/server/syntax.ts';
import type { Ast } from '../../src/shared/ast/nodes.ts';
import { parse } from '../../src/shared/ast/parse.ts';
import { allSettingKeys } from '../../src/shared/lint/catalog.ts';
import { selectRules } from '../../src/shared/lint/select.ts';
import { renderEnglish, TEMPLATES } from '../../src/shared/messages.ts';
import type { LocalizableMessage, RawLintConfigWire } from '../../src/shared/protocol.ts';
import type { DiagnosticOut, Range } from './contract.ts';
import { ja } from './l10n.ts';
import { readRootText } from './root.ts';

const URI = 'file:///sample.jpnov';

/** A sample as the server holds it: the document and the editor's parse of it. */
export function sampleDocument(src: string): { doc: TextDocument; ast: Ast } {
  return { doc: TextDocument.create(URI, 'jpnov', 1, src), ast: parse(src) };
}

interface Manifest {
  readonly contributes: {
    readonly configuration: readonly { readonly properties: Readonly<Record<string, { readonly default?: unknown }>> }[];
  };
}

/** The shipped `jpnov.lint.*` defaults as the wire map the client sends for untouched settings. */
async function defaultLintConfig(): Promise<RawLintConfigWire> {
  const manifest = JSON.parse(await readRootText('package.json')) as Manifest;
  const defaults = new Map<string, unknown>();
  for (const group of manifest.contributes.configuration) {
    for (const [key, prop] of Object.entries(group.properties)) {
      defaults.set(key, prop.default);
    }
  }
  return Object.fromEntries(allSettingKeys().map((key) => [key, defaults.get(key)]));
}

/** The rule selection for untouched settings; plain data, so one serves every sample. */
const RULES = selectRules(await defaultLintConfig());
/** The English template is the bundle key; the args fill the same `{n}` slots afterwards. */
export function localize(message: LocalizableMessage): { en: string; ja: string } {
  const args = message.args ?? [];
  return { en: renderEnglish(message.code, args), ja: ja(TEMPLATES[message.code], ...args.map(String)) };
}

function toRange(range: Diagnostic['range']): Range {
  return { start: { ...range.start }, end: { ...range.end } };
}

export interface LintResult {
  readonly diagnostics: readonly DiagnosticOut[];
  /** The `source.fixAll` outcome, or null when nothing is fixable. */
  readonly fixAll: { readonly title: { readonly en: string; readonly ja: string }; readonly src: string } | null;
}

export function lintSource(src: string): LintResult {
  const { doc, ast } = sampleDocument(src);
  const findings = computeLintFindings(doc, ast, RULES);
  const out: DiagnosticOut[] = [];
  const push = (diag: Diagnostic, fix?: { range: Range; newText: string }): void => {
    const message = diag.data as LocalizableMessage;
    const base = { code: message.code, range: toRange(diag.range), message: localize(message) };
    out.push(fix === undefined ? base : { ...base, fix });
  };
  for (const finding of findings) {
    push(finding.diagnostic, finding.fix === undefined ? undefined : { range: toRange(finding.fix.range), newText: finding.fix.newText });
  }
  for (const finding of syntaxFindings(doc, ast)) {
    push(finding.diagnostic);
  }
  const whole = { start: { line: 0, character: 0 }, end: doc.positionAt(src.length) };
  const action = buildCodeActions(URI, findings, whole, undefined).find((a) => a.kind === CodeActionKind.SourceFixAll);
  if (action === undefined) {
    return { diagnostics: out, fixAll: null };
  }
  const edits = action.edit?.changes?.[URI] ?? [];
  return {
    diagnostics: out,
    fixAll: { title: { en: action.title, ja: ja(action.title) }, src: TextDocument.applyEdits(doc, [...edits]) },
  };
}
