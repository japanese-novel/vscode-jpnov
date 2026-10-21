/**
 * A line as its reader sees it: the display text of the AST's content, and the stretches of it
 * that were typed as body text with where they were written. Read by the highlighter over the
 * narration; the lint's views are the next reader. Markup, a value, a 外字注記 and a broken ［＃
 * are in the text, so neighbours read as shown, but in no stretch: nothing colours or edits them
 * through here.
 *
 * Offsets are UTF-16 units, as `TextDocument.positionAt` counts them.
 */
import type { Line } from '../shared/ast/nodes.ts';
import { clusterStarts, runsIn } from '../shared/ast/span.ts';
import { graphemes } from '../shared/chars.ts';

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
  for (const run of runsIn(line.content)) {
    const from = text.length;
    text += run.text;
    if (run.origin !== 'prose') {
      continue;
    }
    if (run.starts === undefined) {
      stretch(from, from + run.text.length, run.span.start, run.span.end); // as typed, unit for unit
      continue;
    }
    let at = from;
    const clusters = graphemes(run.text);
    const starts = clusterStarts(run, clusters);
    for (const [k, ch] of clusters.entries()) {
      const src = starts[k] ?? run.span.start;
      stretch(at, at + ch.length, src, starts[k + 1] ?? run.span.end);
      at += ch.length;
    }
  }
  return { text, prose };
}
