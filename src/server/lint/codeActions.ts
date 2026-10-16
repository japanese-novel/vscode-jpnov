/**
 * Pure builder turning {@link Finding}s (syntax and lint alike) into LSP code actions: a quick-fix per fixable finding
 * overlapping the requested range, plus one "fix all" bundling every fixable finding in the document.
 *
 * Titles are English here (the vscode-free server cannot localize); the client's `provideCodeActions`
 * middleware swaps in the localized text — a quick-fix reuses its diagnostic's localized message, the
 * fix-all is recognized by its `source.fixAll` kind.
 *
 * A fix that lands inside a 対象文字列 brings the edit of that 「…」 with it (`Fix.within`,
 * merged by `mergedEdits`): the quick-fix carries both, and the fix-all rewrites each 「…」 once,
 * from the fixes it kept. Relative imports (native test loader).
 */
import { CodeActionKind } from 'vscode-languageserver/node';
import type { CodeAction, Position, Range } from 'vscode-languageserver/node';

import type { Finding, Fix } from '../diagnostics.ts';
import { comparePositions } from '../../shared/utils/position.ts';
import { mergedEdits, rangesOverlap } from '../targets.ts';

type FixableFinding = Finding & { readonly fix: Fix };

const FIX_ALL_TITLE = 'Fix all auto-fixable problems (Japanese Novel)';

/** Sort edits by position and drop any overlapping an already-kept edit, so the WorkspaceEdit is valid. */
function nonOverlapping<T extends { readonly range: Range }>(edits: readonly T[]): T[] {
  const sorted = [...edits].sort(
    (a, b) =>
      comparePositions(a.range.start, b.range.start) || comparePositions(a.range.end, b.range.end),
  );
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

function quickFix(uri: string, f: FixableFinding): CodeAction {
  // `Diagnostic.message` is typed `string | MarkupContent`; ours is always the English string render.
  // This title is only a fallback — the client middleware localizes it from the diagnostic's data.
  const title = typeof f.diagnostic.message === 'string' ? f.diagnostic.message : 'Fix';
  return {
    title,
    kind: CodeActionKind.QuickFix,
    diagnostics: [f.diagnostic],
    isPreferred: true,
    edit: { changes: { [uri]: nonOverlapping(mergedEdits([f.fix])) } },
  };
}

function fixAll(uri: string, fixable: readonly FixableFinding[]): CodeAction {
  // The 「…」 edits come from the fixes kept, so a 「…」 two fixes land inside is rewritten once.
  const edits = nonOverlapping(mergedEdits(nonOverlapping(fixable.map((f) => f.fix))));
  return {
    title: FIX_ALL_TITLE,
    kind: CodeActionKind.SourceFixAll,
    edit: { changes: { [uri]: edits } },
  };
}

/** True when the client's `only` filter (empty/undefined = all) admits an action of `kind`. */
function wants(only: readonly string[] | undefined, kind: string): boolean {
  return only === undefined || only.length === 0 || only.some((o) => kind === o || kind.startsWith(`${o}.`));
}

/**
 * Builds the code actions for one request: a quick-fix per fixable finding overlapping
 * `requestedRange`, plus a single fix-all over every fixable finding in the document. Honors the
 * client's `only` kind filter. Returns `[]` when nothing is fixable.
 */
export function buildCodeActions(
  uri: string,
  findings: readonly Finding[],
  requestedRange: Range,
  only: readonly string[] | undefined,
): CodeAction[] {
  const fixable = findings.filter((f): f is FixableFinding => f.fix !== undefined);
  if (fixable.length === 0) {
    return [];
  }
  const actions: CodeAction[] = [];
  if (wants(only, CodeActionKind.QuickFix)) {
    for (const f of fixable) {
      if (rangesOverlap(f.diagnostic.range, requestedRange)) {
        actions.push(quickFix(uri, f));
      }
    }
  }
  if (wants(only, CodeActionKind.SourceFixAll)) {
    actions.push(fixAll(uri, fixable));
  }
  return actions;
}
