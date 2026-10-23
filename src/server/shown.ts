/**
 * The lines as their reader sees them: per line, the runs of the AST's content in display order,
 * each with where its characters were written, and where the utterances 「…」『…』 open and close.
 * Built once per parse (`shownLines`, kept per document version by parsed.ts) and read by the
 * highlighter over the narration and by the lint walker for its views, so that a character can
 * never be dialogue to one and 地の文 to the other. Markup, a value, a 外字注記 and a broken ［＃
 * are in the text, so neighbours read as shown, but the stretches hold only what was typed as body
 * text: nothing colours or edits the rest through here.
 *
 * Only prose feeds the dialogue stack (dialogue.ts): ［＃「対象」に傍点］ carries its 「対象」 inside
 * an annotation node, and a 「 swallowed by an unclosed ［＃ is a brokenAnnotation, so neither can
 * open an utterance (the Aozora trap). What an annotation shows takes the depth where it sits.
 *
 * Offsets are UTF-16 units, as `TextDocument.positionAt` counts them.
 */
import type { Ast, Chars, Line, Ruby, Span, Tcy } from '../shared/ast/nodes.ts';
import { clusterStarts, isFixedOrigin } from '../shared/ast/span.ts';
import { graphemes } from '../shared/chars.ts';

import { DialogueStack } from './dialogue.ts';
import type { DialogueSegment } from './dialogue.ts';

/** One character shown and the source `[start, end)` it was written at: a composed kana covers its mark, a dropped character the gap it left. */
export interface ClusterSpan extends Span {
  readonly text: string;
}

/** One run of the line as shown: `from` is its offset in the display text, `cell` the ruby or
 *  縦中横 it is part of, `clusters` where each character was written when its source shows
 *  differently (null when each UTF-16 unit sits at `span.start` plus its offset, and for what an
 *  annotation shows: every character of that sits at the annotation). */
export interface ShownRun {
  readonly run: Chars;
  readonly cell: Ruby | Tcy | null;
  readonly from: number;
  readonly clusters: readonly ClusterSpan[] | null;
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
  /** The line of the AST it shows. */
  readonly line: Line;
  readonly text: string;
  readonly runs: readonly ShownRun[];
  /** The typed body text, in display order; a prose character outside every stretch does not exist. */
  readonly prose: readonly Stretch[];
  /** The dialogue segments of the line, `from`/`to` in `text`; a run an annotation shows is one
   *  prose segment at the depth where it sits. They tile the text. */
  readonly segments: readonly DialogueSegment[];
  /** The utterance depth before and after the line: > 0 when it begins, or ends, inside a 台詞 that continues. */
  readonly depthAtStart: number;
  readonly depthAtEnd: number;
}

/** Where each character of `run` was written, when its source shows differently (see {@link ShownRun.clusters}). */
function clusterSpans(run: Chars): ClusterSpan[] | null {
  if (run.starts === undefined || isFixedOrigin(run.origin)) {
    return null;
  }
  const clusters = graphemes(run.text);
  const starts = clusterStarts(run, clusters);
  return clusters.map((text, k) => ({ text, start: starts[k] ?? run.span.start, end: starts[k + 1] ?? run.span.end }));
}

/** Adds the stretch to `prose`, extending the last one when both are unit for unit and flush in the source. */
function stretch(prose: Stretch[], from: number, to: number, src: number, end: number): void {
  const last = prose[prose.length - 1];
  if (last?.end === src && last.to - last.from === last.end - last.src && to - from === end - src) {
    prose[prose.length - 1] = { from: last.from, to, src: last.src, end };
  } else {
    prose.push({ from, to, src, end });
  }
}

/** The line being read: `text` grows as the runs are placed. */
interface Building {
  text: string;
  readonly runs: ShownRun[];
  readonly prose: Stretch[];
  readonly segments: DialogueSegment[];
}

function place(b: Building, run: Chars, cell: Ruby | Tcy | null, dialogue: DialogueStack): void {
  const from = b.text.length;
  const clusters = clusterSpans(run);
  b.runs.push({ run, cell, from, clusters });
  b.text += run.text;
  if (run.origin !== 'prose') {
    if (run.text.length > 0) {
      b.segments.push({ kind: 'prose', from, to: b.text.length, depth: dialogue.depth });
    }
    return;
  }
  for (const seg of dialogue.feed(run.text)) {
    b.segments.push({ kind: seg.kind, from: from + seg.from, to: from + seg.to, depth: seg.depth });
  }
  if (clusters === null) {
    stretch(b.prose, from, b.text.length, run.span.start, run.span.end); // as typed, unit for unit
    return;
  }
  let at = from;
  for (const cluster of clusters) {
    stretch(b.prose, at, at + cluster.text.length, cluster.start, cluster.end);
    at += cluster.text.length;
  }
}

function shownLine(line: Line, dialogue: DialogueStack): ShownLine {
  const depthAtStart = dialogue.depth;
  const b: Building = { text: '', runs: [], prose: [], segments: [] };
  for (const item of line.content) {
    if (item.kind === 'chars') {
      place(b, item, null, dialogue);
    } else if (item.kind !== 'comment') {
      for (const run of item.runs) {
        place(b, run, item, dialogue);
      }
    }
  }
  return { line, text: b.text, runs: b.runs, prose: b.prose, segments: b.segments, depthAtStart, depthAtEnd: dialogue.depth };
}

/** Every line of `ast` as shown, one dialogue stack over the whole manuscript (an utterance may span lines). */
export function shownLines(ast: Ast): readonly ShownLine[] {
  const dialogue = new DialogueStack();
  return ast.lines.map((line) => shownLine(line, dialogue));
}
