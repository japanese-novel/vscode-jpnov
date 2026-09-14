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
import { annotationDiagnostics } from '../../src/server/syntax.ts';
import { allSettingKeys } from '../../src/shared/lint/catalog.ts';
import { selectRules } from '../../src/shared/lint/select.ts';
import { lintWireValue } from '../../src/shared/lint/wire.ts';
import { renderEnglish } from '../../src/shared/messages.ts';
import type { LocalizableMessage, RawLintConfigWire } from '../../src/shared/protocol.ts';
import type { DiagnosticOut, Range } from './contract.ts';
import { readRootText } from './root.ts';

const URI = 'file:///sample.jpnov';

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
  const config: Record<string, boolean | number | string> = {};
  for (const key of allSettingKeys()) {
    const value = lintWireValue(defaults.get(key));
    if (value !== undefined) {
      config[key] = value;
    }
  }
  return config;
}

/** The rule selection for untouched settings; plain data, so one serves every sample. */
const RULES = selectRules(await defaultLintConfig());
const BUNDLE = JSON.parse(await readRootText('l10n/bundle.l10n.ja.json')) as Readonly<Record<string, string>>;
const PLACEHOLDERS = ['{0}', '{1}', '{2}'];

/** The English template is the bundle key; the args fill the same `{n}` slots afterwards. */
export function localize(message: LocalizableMessage): { en: string; ja: string } {
  const args = message.args ?? [];
  const key = renderEnglish(message.code, PLACEHOLDERS);
  const template = BUNDLE[key];
  if (template === undefined) {
    throw new Error(`lint: no Japanese text for "${key}"`);
  }
  return {
    en: renderEnglish(message.code, args),
    ja: template.replace(/\{(\d)\}/g, (_m, i: string) => String(args[Number(i)] ?? '')),
  };
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
  const doc = TextDocument.create(URI, 'jpnov', 1, src);
  const findings = computeLintFindings(src, RULES, doc);
  const out: DiagnosticOut[] = [];
  const push = (diag: Diagnostic, fix?: { range: Range; newText: string }): void => {
    const message = diag.data as LocalizableMessage;
    const base = { code: message.code, range: toRange(diag.range), message: localize(message) };
    out.push(fix === undefined ? base : { ...base, fix });
  };
  for (const finding of findings) {
    push(finding.diagnostic, finding.fix === undefined ? undefined : { range: toRange(finding.fix.range), newText: finding.fix.newText });
  }
  for (const diag of annotationDiagnostics(doc)) {
    push(diag);
  }
  const whole = { start: { line: 0, character: 0 }, end: doc.positionAt(src.length) };
  const action = buildCodeActions(URI, findings, whole, undefined).find((a) => a.kind === CodeActionKind.SourceFixAll);
  if (action === undefined) {
    return { diagnostics: out, fixAll: null };
  }
  const edits = action.edit?.changes?.[URI] ?? [];
  const ja = BUNDLE[action.title];
  if (ja === undefined) {
    throw new Error(`lint: no Japanese text for "${action.title}"`);
  }
  return {
    diagnostics: out,
    fixAll: { title: { en: action.title, ja }, src: TextDocument.applyEdits(doc, [...edits]) },
  };
}
