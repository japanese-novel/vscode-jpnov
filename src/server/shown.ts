/**
 * A line as its reader sees it: the runs of the AST's content in display order, each with where
 * its characters were written. Read by the highlighter over the narration (`shownLine`) and by the
 * lint walker for its views. Markup, a value, a 外字注記 and a broken ［＃ are in the text, so
 * neighbours read as shown, but the highlighter's stretches hold only what was typed as body
 * text: nothing colours or edits the rest through here.
 *
 * Offsets are UTF-16 units, as `TextDocument.positionAt` counts them.
 */
import type { Chars, Line, Ruby, Span, Tcy } from '../shared/ast/nodes.ts';
import { clusterStarts } from '../shared/ast/span.ts';
import { graphemes } from '../shared/chars.ts';

/** One run of the line as shown: `from` is its offset in the display text, `cell` the ruby or 縦中横 it is part of. */
export interface ShownRun {
  readonly run: Chars;
  readonly cell: Ruby | Tcy | null;
  readonly from: number;
}

/** The runs of `line` in display order; a comment shows nothing and has none. */
export function shownRuns(line: Line): ShownRun[] {
  const out: ShownRun[] = [];
  let from = 0;
  for (const item of line.content) {
    if (item.kind === 'comment') {
      continue;
    }
    if (item.kind === 'chars') {
      out.push({ run: item, cell: null, from });
      from += item.text.length;
      continue;
    }
    for (const run of item.runs) {
      out.push({ run, cell: item, from });
      from += run.text.length;
    }
  }
  return out;
}

/** One character shown and the source `[start, end)` it was written at: a composed kana covers its mark, a dropped character the gap it left. */
export interface ClusterSpan extends Span {
  readonly text: string;
}

/**
 * Where each character of `run` was written, when its source shows differently; null when each
 * UTF-16 unit of the run sits at `span.start` plus its offset.
 */
export function clusterSpans(run: Chars): ClusterSpan[] | null {
  if (run.starts === undefined) {
    return null;
  }
  const clusters = graphemes(run.text);
  const starts = clusterStarts(run, clusters);
  return clusters.map((text, k) => ({ text, start: starts[k] ?? run.span.start, end: starts[k + 1] ?? run.span.end }));
}

/**
 * Display `[from, to)` was written at `[src, end)`, one unit per unit — except a stretch of one
 * character whose source was longer (a kana composed from its mark, a dropped character inside),
 * which `end` covers whole.
 */
export interface Stretch {
  readonly from: number;
  readonly to: number;
  readonly src: number;
  readonly end: number;
}

export interface ShownLine {
  readonly text: string;
  /** In display order; a prose character outside every stretch does not exist. */
  readonly prose: readonly Stretch[];
}

export function shownLine(line: Line): ShownLine {
  let text = '';
  const prose: Stretch[] = [];
  const stretch = (from: number, to: number, src: number, end: number): void => {
    const last = prose[prose.length - 1];
    if (last?.end === src && last.to - last.from === last.end - last.src && to - from === end - src) {
      prose[prose.length - 1] = { from: last.from, to, src: last.src, end };
    } else {
      prose.push({ from, to, src, end });
    }
  };
  for (const { run, from } of shownRuns(line)) {
    text += run.text;
    if (run.origin !== 'prose') {
      continue;
    }
    const clusters = clusterSpans(run);
    if (clusters === null) {
      stretch(from, from + run.text.length, run.span.start, run.span.end); // as typed, unit for unit
      continue;
    }
    let at = from;
    for (const cluster of clusters) {
      stretch(at, at + cluster.text.length, cluster.start, cluster.end);
      at += cluster.text.length;
    }
  }
  return { text, prose };
}
