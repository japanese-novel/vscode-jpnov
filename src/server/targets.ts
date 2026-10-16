/**
 * Keeping a 対象文字列 in step with the body it names: when an edit lands inside what a
 * corner-target postfix bound to, the 「…」 of that postfix takes the same edit, so the
 * annotation keeps binding. The lint fixes and the rename both go through here, so the two
 * never disagree on what is rewritten.
 *
 * A postfix is ELIGIBLE when it bound and its 「…」 is written exactly as the body it bound to.
 * The resolver binds on display text, so the two can differ — a ruby or a comment inside the
 * range, a value field, a 外字注記, a dropped character, kana composed on one side only — and
 * then a splice of the 「…」 would guess; those postfixes are left alone, and a stale target is
 * `syntax.postfixTargetMissing`'s to report.
 *
 * Relative imports only (native test loader); vscode-free.
 */
import type { Range, TextEdit } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { Ast, PostfixNode, Span, SyntaxNode } from '../shared/ast/nodes.ts';
import { partitionPoint } from '../shared/utils/lists.ts';
import { comparePositions } from '../shared/utils/position.ts';

/** A postfix whose 「…」 can be rewritten with the body: `bound` reads as `node.target.text`. */
export interface EligibleTarget {
  readonly node: PostfixNode;
  readonly bound: Span;
}

/** One 「…」 an edit lands inside, and the edit as it falls within the target's text. */
export interface SyncedTarget {
  /** The 「…」 interior. */
  readonly range: Range;
  /** The target as written. */
  readonly text: string;
  /** Half-open `[start, end)` of `text` the edit replaces; equal for an insert. */
  readonly start: number;
  readonly end: number;
  readonly newText: string;
}

/** An edit with the 対象文字列 it lands inside (none, as a rule); a lint fix is one. */
export interface SyncedEdit {
  readonly range: Range;
  readonly newText: string;
  readonly within: readonly SyncedTarget[];
}

/** The markers of the notation: text holding one writes markup, which a 「…」 cannot hold. */
export const MARKUP = /[［］「」《》｜]/;

export function isPostfix(node: SyntaxNode): node is PostfixNode {
  return node.kind === 'emphasisPostfix' || node.kind === 'tcyPostfix' || node.kind === 'headingPostfix' || node.kind === 'rubyLeftPostfix';
}

export function rangeOf(doc: TextDocument, span: Span): Range {
  return { start: doc.positionAt(span.start), end: doc.positionAt(span.end) };
}

/** A range as a comparable key: two edits over the same characters are of the same thing. */
export function rangeKey(r: Range): string {
  return [r.start.line, r.start.character, r.end.line, r.end.character].join(':');
}

const byStart = (a: { readonly range: Range }, b: { readonly range: Range }): number =>
  comparePositions(a.range.start, b.range.start);

/** True iff the ranges share a character or touch. */
export function rangesOverlap(a: Range, b: Range): boolean {
  return comparePositions(a.start, b.end) <= 0 && comparePositions(b.start, a.end) <= 0;
}

/**
 * The eligible postfixes of line `line` of `ast`, `text` being the source it was parsed from. A
 * postfix binds within its line alone, so the line holds every target an edit on it can reach.
 */
export function eligibleTargets(ast: Ast, text: string, line: number): EligibleTarget[] {
  const out: EligibleTarget[] = [];
  for (const node of ast.lines[line]?.syntax ?? []) {
    const bound = isPostfix(node) ? ast.bound.get(node) : undefined;
    if (
      isPostfix(node) && bound !== undefined &&
      bound.end - bound.start === node.target.text.length && text.startsWith(node.target.text, bound.start)
    ) {
      out.push({ node, bound });
    }
  }
  return out;
}

/**
 * The targets an edit of `span` to `newText` lands inside: a replacement within the bound range,
 * an insert strictly inside it (one at its edge is outside the 「…」). An edit that writes markup
 * reaches no target: what it writes becomes a cell of its own, and the postfix still binds.
 */
export function syncedTargets(
  eligible: readonly EligibleTarget[],
  doc: TextDocument,
  span: Span,
  newText: string,
): SyncedTarget[] {
  if (MARKUP.test(newText)) {
    return [];
  }
  const insert = span.start === span.end;
  const out: SyncedTarget[] = [];
  for (const { node, bound } of eligible) {
    const inside = insert
      ? bound.start < span.start && span.start < bound.end
      : bound.start <= span.start && span.end <= bound.end;
    if (inside) {
      out.push({
        range: rangeOf(doc, node.target.span),
        text: node.target.text,
        start: span.start - bound.start,
        end: span.end - bound.start,
        newText,
      });
    }
  }
  return out;
}

interface LineIndex {
  /** The eligible targets of the line, by the start of what they bound to. */
  readonly targets: readonly EligibleTarget[];
  /** `targets[i].bound.start`, for the binary search. */
  readonly starts: readonly number[];
  /** The widest bound of the line: a target reaches no edit starting further after its start. */
  readonly reach: number;
}

/**
 * The eligible targets of a document, found once per line and looked up by where an edit lands:
 * a lint pass asks once per fix, and a line may hold thousands of either.
 */
export class TargetIndex {
  private readonly ast: Ast;
  private readonly text: string;
  private readonly lines = new Map<number, LineIndex>();

  constructor(ast: Ast, text: string) {
    this.ast = ast;
    this.text = text;
  }

  private lineAt(line: number): LineIndex {
    let entry = this.lines.get(line);
    if (entry === undefined) {
      const targets = eligibleTargets(this.ast, this.text, line).sort((a, b) => a.bound.start - b.bound.start);
      const reach = targets.reduce((max, { bound }) => Math.max(max, bound.end - bound.start), 0);
      entry = { targets, starts: targets.map(({ bound }) => bound.start), reach };
      this.lines.set(line, entry);
    }
    return entry;
  }

  /** The targets of `line` an edit of `span` to `newText` lands inside ({@link syncedTargets}). */
  within(doc: TextDocument, line: number, span: Span, newText: string): SyncedTarget[] {
    const { targets, starts, reach } = this.lineAt(line);
    const from = partitionPoint(starts, (start) => start >= span.start - reach);
    const to = partitionPoint(starts, (start) => start > span.start);
    return syncedTargets(targets.slice(from, to), doc, span, newText);
  }
}

/**
 * One edit per 「…」 of `within`: the splices on one target applied together, from the last to
 * the first. A target that would come out empty is left alone — ［＃「」…］ is a comment, so the
 * postfix had better miss and be reported.
 */
export function targetEdits(within: readonly SyncedTarget[]): TextEdit[] {
  const out: TextEdit[] = [];
  for (const group of Map.groupBy(within, (target) => rangeKey(target.range)).values()) {
    const [first] = group;
    if (first === undefined) {
      continue;
    }
    const text = group
      .toSorted((a, b) => b.start - a.start || b.end - a.end)
      .reduce((acc, { start, end, newText }) => acc.slice(0, start) + newText + acc.slice(end), first.text);
    if (text !== '') {
      out.push({ range: first.range, newText: text });
    }
  }
  return out;
}

/**
 * The edits of `edits` with each 対象文字列 they land inside rewritten once: the target edits,
 * then the edits overlapping none of them. An edit inside such a 「…」 (a kana composed there)
 * gives way: the rewrite carries it.
 */
export function mergedEdits(edits: readonly SyncedEdit[]): TextEdit[] {
  const targets = targetEdits(edits.flatMap((edit) => edit.within)).sort(byStart);
  // Each target range is one postfix's own 「…」, so the targets are disjoint and by start they
  // are by end too: one walk over the edits in order meets each target once.
  const own: TextEdit[] = [];
  let t = 0;
  for (const edit of edits.toSorted(byStart)) {
    let target = targets[t];
    while (target !== undefined && comparePositions(target.range.end, edit.range.start) < 0) {
      t += 1;
      target = targets[t];
    }
    if (target === undefined || !rangesOverlap(target.range, edit.range)) {
      own.push({ range: edit.range, newText: edit.newText });
    }
  }
  return [...targets, ...own];
}
