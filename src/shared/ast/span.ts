/**
 * Reading the AST's positions: source order, the runs a content list is made of, and where each
 * character of a run was written.
 */
import { graphemes } from '../chars.ts';
import type { Chars, Inline, Span } from './nodes.ts';

/** The runs of `content`, in display order: a ruby's and a 縦中横's as themselves. */
export function runsIn(content: readonly Inline[]): Chars[] {
  const runs: Chars[] = [];
  for (const item of content) {
    if (item.kind === 'chars') {
      runs.push(item);
    } else if (item.kind !== 'comment') {
      runs.push(...item.runs);
    }
  }
  return runs;
}

/**
 * Where each character of `run` was written: its `starts`, else its span start plus its offset.
 * `clusters` are the characters, when the caller has them already. Not for a value: its
 * characters have no place of their own.
 */
export function clusterStarts(run: Chars, clusters: readonly string[] = graphemes(run.text)): number[] {
  let offset = 0;
  return clusters.map((ch, k) => {
    const start = run.starts?.[k] ?? run.span.start + offset;
    offset += ch.length;
    return start;
  });
}

/** Source order, the order of every list the AST hands out: by start, then by end. */
export function bySource(a: { readonly span: Span }, b: { readonly span: Span }): number {
  return a.span.start - b.span.start || a.span.end - b.span.end;
}
