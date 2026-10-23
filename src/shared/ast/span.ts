/**
 * Reading the AST's positions: source order, the runs a content list is made of, and where each
 * character of a run was written.
 */
import { graphemes } from '../chars.ts';
import type { Chars, CharsOrigin, Inline, Span } from './nodes.ts';

/** Whether characters of `origin` are shown by an annotation and have no place of their own. */
export function isFixedOrigin(origin: CharsOrigin): boolean {
  return origin === 'value' || origin === 'indent' || origin === 'gaiji';
}

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
 * `clusters` are the characters, when the caller has them already. The characters an annotation
 * shows ({@link isFixedOrigin}) all sit at the annotation.
 */
export function clusterStarts(run: Chars, clusters: readonly string[] = graphemes(run.text)): number[] {
  let offset = 0;
  return clusters.map((ch, k) => {
    const start = clusterStart(run, k, offset);
    offset += ch.length;
    return start;
  });
}

/** Where the `k`-th character of `run` was written, `offset` being its UTF-16 offset in `run.text`: see {@link clusterStarts}. */
export function clusterStart(run: Chars, k: number, offset: number): number {
  return isFixedOrigin(run.origin) ? run.span.start : run.starts?.[k] ?? run.span.start + offset;
}

/** Source order, the order of every list the AST hands out: by start, then by end. */
export function bySource(a: { readonly span: Span }, b: { readonly span: Span }): number {
  return a.span.start - b.span.start || a.span.end - b.span.end;
}
