/**
 * Pure builder turning {@link Finding}s (syntax and lint alike) into LSP code actions: for each finding
 * overlapping the requested range a quick-fix when it has a fix and, for a lint finding, "open the setting
 * of this rule" (a VS Code command the client runs as is); plus one "fix all" bundling every fixable
 * finding in the document.
 *
 * Titles are English here (the vscode-free server cannot localize); the client's `provideCodeActions`
 * middleware swaps in the localized text — a quick-fix reuses its diagnostic's localized message, the
 * setting action carries its own {@link LocalizableMessage} in `data`, the fix-all is recognized by its
 * `source.fixAll` kind.
 *
 * A fix that lands inside a 対象文字列 brings the edit of that 「…」 with it (`Fix.within`,
 * merged by `mergedEdits`): the quick-fix carries both, and the fix-all rewrites each 「…」 once,
 * from the fixes it kept.
 */
import { CodeActionKind } from 'vscode-languageserver/node';
import type { CodeAction, Position, Range, TextEdit } from 'vscode-languageserver/node';

import { OPEN_SETTINGS_COMMAND } from '../diagnostics.ts';
import type { Finding, Fix, JpnovDiagnostic } from '../diagnostics.ts';
import { renderEnglish } from '../../shared/messages.ts';
import type { LocalizableMessage, ProblemRef } from '../../shared/protocol.ts';
import { comparePositions, compareRanges, rangeKey } from '../../shared/utils/position.ts';
import { mergedEdits, rangesOverlap } from '../targets.ts';

type FixableFinding = Finding & { readonly fix: Fix };

const FIX_ALL_TITLE = 'Fix all auto-fixable problems (Japanese Novel)';

/** Sort edits by position and drop any overlapping an already-kept edit, so the WorkspaceEdit is valid. */
function nonOverlapping<T extends { readonly range: Range }>(edits: readonly T[]): T[] {
  const sorted = [...edits].sort((a, b) => compareRanges(a.range, b.range));
  const out: T[] = [];
  let lastEnd: Position | undefined;
  for (const e of sorted) {
    if (lastEnd === undefined || comparePositions(e.range.start, lastEnd) >= 0) {
      out.push(e);
      lastEnd = e.range.end;
    }
  }
  return out;
}

function quickFix(uri: string, diagnostic: JpnovDiagnostic, fix: Fix): CodeAction {
  // `Diagnostic.message` is typed `string | MarkupContent`; ours is always the English string render.
  // This title is only a fallback — the client middleware localizes it from the diagnostic's data.
  const title = typeof diagnostic.message === 'string' ? diagnostic.message : 'Fix';
  return {
    title,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    isPreferred: true,
    edit: { changes: { [uri]: nonOverlapping(mergedEdits([fix])) } },
  };
}

/**
 * The settings editor filtered to the rule's setting: the same place the diagnostic's code links to.
 * Named after the last segment of the setting key, what the settings editor and the code both show.
 * A `quickfix` so it sits in the lightbulb right under the fix (a kindless action goes to "More
 * actions…"); VS Code's quick-fix is any action offered for a diagnostic, not only an edit.
 */
function openSetting(diagnostic: JpnovDiagnostic, setting: string): CodeAction {
  const message: LocalizableMessage = { code: 'codeAction.openSetting', args: [setting.slice(setting.lastIndexOf('.') + 1)] };
  const title = renderEnglish(message.code, message.args);
  return {
    title,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    data: message,
    command: { title, command: OPEN_SETTINGS_COMMAND, arguments: [setting] },
  };
}

/** A finding's identity on the wire: where it is and what it is. */
function refKey(range: Range, code: string): string {
  return rangeKey(range) + ':' + code;
}

/**
 * The edits of "fix all" over `findings`, and `fixed`, the number of fixes they carry: a 「…」
 * rewrite rides a fix (`Fix.within`) and is not a fix of its own. The 「…」 edits come from the
 * fixes kept, so a 「…」 two fixes land inside is rewritten once. `only` limits the fixes to the
 * findings it names (by place and code); a ref the findings no longer have fixes nothing.
 */
export function fixAllEdits(findings: readonly Finding[], only?: readonly ProblemRef[]): { edits: TextEdit[]; fixed: number } {
  const wanted = only === undefined ? null : new Set(only.map((r) => refKey(r.range, r.code)));
  const kept = nonOverlapping(findings
    .filter((f): f is FixableFinding => f.fix !== undefined && (wanted === null || wanted.has(refKey(f.diagnostic.range, f.diagnostic.data.code))))
    .map((f) => f.fix));
  return { edits: nonOverlapping(mergedEdits(kept)), fixed: kept.length };
}

/** True when the client's `only` filter (empty/undefined = all) admits an action of `kind`. */
function wants(only: readonly string[] | undefined, kind: string): boolean {
  return only === undefined || only.length === 0 || only.some((o) => kind === o || kind.startsWith(`${o}.`));
}

/**
 * Builds the code actions for one request: per finding overlapping `requestedRange` its quick-fix
 * (when fixable) and, below it, "open the setting of this rule" (when a lint finding); plus a single
 * fix-all over every fixable finding in the document. Honors the client's `only` kind filter.
 */
export function buildCodeActions(
  uri: string,
  findings: readonly Finding[],
  requestedRange: Range,
  only: readonly string[] | undefined,
): CodeAction[] {
  const actions: CodeAction[] = [];
  if (wants(only, CodeActionKind.QuickFix)) {
    for (const f of findings) {
      if (!rangesOverlap(f.diagnostic.range, requestedRange)) {
        continue;
      }
      if (f.fix !== undefined) {
        actions.push(quickFix(uri, f.diagnostic, f.fix));
      }
      if (f.setting !== undefined) {
        actions.push(openSetting(f.diagnostic, f.setting));
      }
    }
  }
  if (wants(only, CodeActionKind.SourceFixAll)) {
    const { edits, fixed } = fixAllEdits(findings);
    if (fixed > 0) {
      actions.push({ title: FIX_ALL_TITLE, kind: CodeActionKind.SourceFixAll, edit: { changes: { [uri]: edits } } });
    }
  }
  return actions;
}
