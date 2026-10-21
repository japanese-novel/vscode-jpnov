/** Pure-builder tests for buildCodeActions (quick-fix overlap, only-filter, fix-all bundling). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CodeActionKind } from 'vscode-languageserver/node';
import type { CodeAction, Range, TextEdit } from 'vscode-languageserver/node';

import { problemOf, type Finding } from '../../../src/server/diagnostics.ts';
import { buildCodeActions, fixAllEdits } from '../../../src/server/lint/codeActions.ts';
import type { SyncedTarget } from '../../../src/server/targets.ts';
import { inLinearTime } from '../../shared/_timing.ts';

const URI = 'file:///x.jpnov';

function range(l1: number, c1: number, l2: number, c2: number): Range {
  return { start: { line: l1, character: c1 }, end: { line: l2, character: c2 } };
}

function finding(r: Range, code: string, fixNewText?: string, within: SyncedTarget[] = []): Finding {
  const diagnostic = { range: r, message: `msg:${code}`, severity: 2, source: 'jpnov', data: { code } } as Finding['diagnostic'];
  return fixNewText === undefined ? { diagnostic } : { diagnostic, fix: { range: r, newText: fixNewText, within } };
}

function editsOf(action: CodeAction): TextEdit[] {
  return action.edit?.changes?.[URI] ?? [];
}

function kinds(actions: readonly CodeAction[]): (string | undefined)[] {
  return actions.map((a) => a.kind);
}

test('a fixable finding yields a quick-fix (with edit + diagnostic) and a fix-all', () => {
  const f = finding(range(0, 1, 0, 2), 'lint.narration.noHankakuKana', 'ア');
  const actions = buildCodeActions(URI, [f], range(0, 1, 0, 1), undefined);
  assert.deepEqual(kinds(actions), [CodeActionKind.QuickFix, CodeActionKind.SourceFixAll]);
  const quickFix = actions[0];
  assert.ok(quickFix);
  assert.deepEqual(quickFix.diagnostics, [f.diagnostic]);
  assert.deepEqual(editsOf(quickFix), [{ range: range(0, 1, 0, 2), newText: 'ア' }]);
});

test('non-fixable findings produce no actions at all', () => {
  const f = finding(range(0, 0, 0, 1), 'lint.narration.maxTen'); // no fix
  assert.deepEqual(buildCodeActions(URI, [f], range(0, 0, 0, 1), undefined), []);
});

test('quick-fix is only offered for findings overlapping the requested range', () => {
  const f = finding(range(0, 1, 0, 2), 'lint.narration.noHankakuKana', 'ア');
  const actions = buildCodeActions(URI, [f], range(5, 0, 5, 0), undefined); // far from the finding
  assert.deepEqual(kinds(actions), [CodeActionKind.SourceFixAll]); // fix-all still offered, no quick-fix
});

test('the only-filter selects quick-fix vs fix-all', () => {
  const f = finding(range(0, 1, 0, 2), 'lint.narration.noHankakuKana', 'ア');
  assert.deepEqual(
    kinds(buildCodeActions(URI, [f], range(0, 1, 0, 1), [CodeActionKind.SourceFixAll])),
    [CodeActionKind.SourceFixAll],
  );
  assert.deepEqual(
    kinds(buildCodeActions(URI, [f], range(0, 1, 0, 1), [CodeActionKind.QuickFix])),
    [CodeActionKind.QuickFix],
  );
});

test('fix-all keeps the edits that only touch: an insert before a replaced range and one after it', () => {
  const before = finding(range(0, 2, 0, 2), 'lint.narration.indent', '　');
  const pair = finding(range(0, 2, 0, 4), 'lint.common.questionExclamationMarks.tcy', '!?［＃「!?」は縦中横］');
  const after = finding(range(0, 4, 0, 4), 'lint.common.exclamationSpace', '　');
  const all = buildCodeActions(URI, [after, pair, before], range(0, 0, 0, 10), [CodeActionKind.SourceFixAll]);
  assert.deepEqual(all.flatMap(editsOf), [
    { range: range(0, 2, 0, 2), newText: '　' },
    { range: range(0, 2, 0, 4), newText: '!?［＃「!?」は縦中横］' },
    { range: range(0, 4, 0, 4), newText: '　' },
  ]);
});

test('fix-all bundles every fixable edit and drops overlaps', () => {
  const a = finding(range(0, 1, 0, 2), 'lint.narration.noHankakuKana', 'ア');
  const b = finding(range(0, 5, 0, 6), 'lint.narration.noNfd', 'が');
  const overlap = finding(range(0, 1, 0, 2), 'lint.dialogue.noHankakuKana', 'イ'); // same range as a -> dropped
  const all = buildCodeActions(URI, [a, b, overlap], range(0, 0, 0, 10), [CodeActionKind.SourceFixAll]);
  assert.equal(all.length, 1);
  const fixAll = all[0];
  assert.ok(fixAll);
  assert.deepEqual(editsOf(fixAll), [
    { range: range(0, 1, 0, 2), newText: 'ア' },
    { range: range(0, 5, 0, 6), newText: 'が' },
  ]);
});

// なに!?だ!?［＃「なに!?だ!?」に傍点］: the 「…」 sits at 12..18, each pair is 2..4 and 5..7 of it.
const TARGET = range(0, 12, 0, 18);
const within = (start: number, end: number, newText: string): SyncedTarget => ({ range: TARGET, text: 'なに!?だ!?', start, end, newText });

test('fixAllEdits: the fix-all edits, and `fixed` counts the fixes kept, not the 「…」 rewrites nor the overlaps dropped', () => {
  const a = finding(range(0, 3, 0, 5), 'lint.common.questionExclamationMarks', '⁉', [within(2, 4, '⁉')]);
  const b = finding(range(0, 6, 0, 8), 'lint.common.questionExclamationMarks', '⁉', [within(5, 7, '⁉')]);
  const overlap = finding(range(0, 3, 0, 5), 'lint.dialogue.noHankakuKana', 'イ');
  const unfixable = finding(range(0, 0, 0, 1), 'lint.narration.indent');
  const findings = [unfixable, overlap, b, a];
  const { edits, fixed } = fixAllEdits(findings);
  assert.equal(fixed, 2);
  // Two fixes inside one 「…」: three edits, the 「…」 rewritten once.
  assert.equal(edits.length, 3);
  const [action] = buildCodeActions(URI, findings, range(0, 0, 0, 0), [CodeActionKind.SourceFixAll]);
  assert.ok(action);
  assert.deepEqual(edits, editsOf(action));
  assert.deepEqual(fixAllEdits([unfixable]), { edits: [], fixed: 0 });
});

test('fixAllEdits with `only` fixes the problems named by place and code: a ref the findings lack fixes nothing, an empty list fixes nothing', () => {
  const a = finding(range(0, 3, 0, 5), 'lint.common.questionExclamationMarks', '⁉');
  const b = finding(range(0, 6, 0, 8), 'lint.common.noHankakuKana', 'イ');
  const findings = [a, b];
  assert.deepEqual(fixAllEdits(findings, [{ range: range(0, 6, 0, 8), code: 'lint.common.noHankakuKana' }]), {
    edits: [{ range: range(0, 6, 0, 8), newText: 'イ' }],
    fixed: 1,
  });
  // The same place under another code, and the right code at another place: neither names a finding.
  assert.deepEqual(fixAllEdits(findings, [
    { range: range(0, 6, 0, 8), code: 'lint.common.questionExclamationMarks' },
    { range: range(0, 3, 0, 4), code: 'lint.common.questionExclamationMarks' },
  ]), { edits: [], fixed: 0 });
  assert.deepEqual(fixAllEdits(findings, []), { edits: [], fixed: 0 });
  assert.equal(fixAllEdits(findings).fixed, 2);
});

test('problemOf lists a finding as the Books view shows it: place, severity, message, and whether a fix is on offer', () => {
  const fixable = finding(range(0, 3, 0, 5), 'lint.common.questionExclamationMarks', '⁉');
  const plain = finding(range(1, 0, 1, 1), 'lint.narration.indent');
  assert.deepEqual(problemOf(fixable), {
    range: range(0, 3, 0, 5), severity: 'warning', message: { code: 'lint.common.questionExclamationMarks' }, fixable: true,
  });
  assert.deepEqual(problemOf(plain), { range: range(1, 0, 1, 1), severity: 'warning', message: { code: 'lint.narration.indent' }, fixable: false });
  const error = { ...plain, diagnostic: { ...plain.diagnostic, severity: 1 } } as Finding;
  assert.equal(problemOf(error).severity, 'error');
});

test('a quick-fix carries the edit of the 「…」 its fix lands inside', () => {
  const f = finding(range(0, 3, 0, 5), 'lint.common.questionExclamationMarks', '⁉', [within(2, 4, '⁉')]);
  const [quickFix] = buildCodeActions(URI, [f], range(0, 3, 0, 3), [CodeActionKind.QuickFix]);
  assert.ok(quickFix);
  assert.deepEqual(editsOf(quickFix), [
    { range: range(0, 3, 0, 5), newText: '⁉' },
    { range: TARGET, newText: 'なに⁉だ!?' },
  ]);
});

test('fix-all over thousands of 「…」 takes linear time (issue #182)', () => {
  // Line k: `なに!?［＃「なに!?」に傍点］` with its 「…」 at 7..11; a pair fix inside the text and a
  // composition fix inside the 「…」 that gives way.
  const n = 8000;
  const findings: Finding[] = [];
  for (let k = 0; k < n; k += 1) {
    const target = range(k, 7, k, 11);
    const w: SyncedTarget = { range: target, text: 'なに!?', start: 2, end: 4, newText: '⁉' };
    findings.push(finding(range(k, 2, k, 4), 'lint.common.questionExclamationMarks', '⁉', [w]));
    findings.push(finding(range(k, 8, k, 9), 'lint.common.noNfd', 'に'));
  }
  const [fixAll] = inLinearTime('fix-all', () => buildCodeActions(URI, findings, range(0, 0, 0, 0), [CodeActionKind.SourceFixAll]));
  assert.ok(fixAll);
  const edits = editsOf(fixAll);
  assert.equal(edits.length, 2 * n);
  assert.deepEqual(edits.slice(0, 2), [
    { range: range(0, 2, 0, 4), newText: '⁉' },
    { range: range(0, 7, 0, 11), newText: 'なに⁉' },
  ]);
});

test('fix-all rewrites a 「…」 once from every fix it kept, and a fix inside that 「…」 gives way', () => {
  const first = finding(range(0, 3, 0, 5), 'lint.common.questionExclamationMarks', '⁉', [within(2, 4, '⁉')]);
  const second = finding(range(0, 6, 0, 8), 'lint.common.questionExclamationMarks', '⁉', [within(5, 7, '⁉')]);
  const dropped = finding(range(0, 3, 0, 5), 'lint.common.exclamationRun', '！？', [within(2, 4, '！？')]); // overlaps `first`
  const inside = finding(range(0, 14, 0, 16), 'lint.common.noNfd', 'ab'); // inside the 「…」
  const [fixAll] = buildCodeActions(URI, [inside, second, first, dropped], range(0, 0, 0, 30), [CodeActionKind.SourceFixAll]);
  assert.ok(fixAll);
  assert.deepEqual(editsOf(fixAll), [
    { range: range(0, 3, 0, 5), newText: '⁉' },
    { range: range(0, 6, 0, 8), newText: '⁉' },
    { range: TARGET, newText: 'なに⁉だ⁉' },
  ]);
});
