/**
 * The scanner: source text → the syntax layer, line by line. Every pairing is bounded by its
 * line, so broken markup affects that line alone:
 *   - an unclosed ［＃ is one `brokenAnnotation` up to the line end, and is reported;
 *   - a 字下げ above the notation's maximum is a comment, and is reported;
 *   - a closed 《…》 with no base before it, and an empty 《》, stay text and are reported;
 *   - an unmatched 《, a ｜ that gets no reading and a lone ］ or 》 are text.
 *
 * A 外字注記 is read where its annotation directly follows its ※, spelled as the notation lists it
 * (https://www.aozora.gr.jp/annotation/external_character.html); any other ※ is text.
 *
 * An explicit ｜ base runs up to its 《 whatever sits inside it
 * (https://www.aozora.gr.jp/annotation/etc.html#ruby); only the edge of a 縦中横 span ends it. A
 * ［＃縦中横終わり］ with no span open, or a ［＃縦中横］ inside one, changes nothing and is no edge.
 *
 * Pure + vscode-free.
 */
import { graphemes, isHiragana, isKanji, isKatakana, isUnshown } from '../chars.ts';

import { classifyAnnotation, gaijiNode } from './classify.ts';
import { append } from '../utils/lists.ts';
import type { Eol, RubyReadingNode, ScanIssue, Span, Syntax, SyntaxLine, SyntaxNode, TextNode } from './nodes.ts';
import { ANNOTATION_CLOSE, ANNOTATION_OPEN, BASE_MARK, GAIJI_MARK, RUBY_CLOSE, RUBY_OPEN, gaijiChar } from './notation.ts';
import { Cutter } from './parts.ts';

// The delimiters as UTF-16 units: the loop compares numbers, so a kana or a kanji allocates no string.
// Each is one unit, which the search for a closer counts on.
const ANNOTATION_OPEN_UNIT = ANNOTATION_OPEN.charCodeAt(0);
const ANNOTATION_CLOSE_UNIT = ANNOTATION_CLOSE.charCodeAt(0);
const BASE_MARK_UNIT = BASE_MARK.charCodeAt(0);
const RUBY_OPEN_UNIT = RUBY_OPEN.charCodeAt(0);
const RUBY_CLOSE_UNIT = RUBY_CLOSE.charCodeAt(0);

// Implicit ruby-base detection

type CharClass = 'kanji' | 'hiragana' | 'katakana' | 'alnum' | null;

/** ASCII and full-width Latin letters + digits, as a single class. */
function isAlnum(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) ||
    (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a) ||
    (cp >= 0xff10 && cp <= 0xff19) ||
    (cp >= 0xff21 && cp <= 0xff3a) ||
    (cp >= 0xff41 && cp <= 0xff5a)
  );
}

function classOf(cp: number): CharClass {
  if (isKanji(cp)) {
    return 'kanji';
  }
  if (isHiragana(cp)) {
    return 'hiragana';
  }
  if (isKatakana(cp)) {
    return 'katakana';
  }
  return isAlnum(cp) ? 'alnum' : null;
}

/**
 * Where the implicit ruby base ending at `end` starts, looking no further back than `floor`:
 * the MAXIMAL run of ONE character class — kanji, hiragana, katakana, or alnum of either width.
 * A character is a grapheme cluster, classed by its first code point (an NFD が, a kanji with its
 * variation selector). The last character fixes the class; anything else ends the run. `end`
 * itself means no base.
 */
function implicitBaseStart(src: string, floor: number, end: number): number {
  const classOfHead = (cluster: string): CharClass => classOf(cluster.codePointAt(0) ?? 0);
  // Read back in stretches, each twice the last: a base is short, the text before it may not be
  // (a line of readings with no base would read its whole head at every 《). The first cluster
  // of a stretch may be cut: the walk is trusted only where it ends before it.
  let want = 64;
  for (;;) {
    const from = Math.max(floor, end - want);
    const clusters = graphemes(src.slice(from, end)).reverse();
    const cls = classOfHead(clusters[0] ?? '');
    if (cls === null) {
      return end;
    }
    let start = end;
    let k = 0;
    while (k < clusters.length && classOfHead(clusters[k] ?? '') === cls) {
      start -= clusters[k]?.length ?? 0;
      k += 1;
    }
    if (from === floor || k < clusters.length - 1) {
      return start;
    }
    want *= 2;
  }
}

// Lines

/** The lines of `src` as `[start, end)` content ranges with their terminators. */
function splitSource(src: string): { start: number; end: number; eol: Eol }[] {
  const lines: { start: number; end: number; eol: Eol }[] = [];
  let start = 0;
  for (let i = 0; i < src.length; i += 1) {
    const c = src.charCodeAt(i);
    if (c === 0x0a) {
      lines.push({ start, end: i, eol: '\n' });
      start = i + 1;
    } else if (c === 0x0d) {
      const crlf = src.charCodeAt(i + 1) === 0x0a;
      lines.push({ start, end: i, eol: crlf ? '\r\n' : '\r' });
      i += crlf ? 1 : 0;
      start = i + 1;
    }
  }
  lines.push({ start, end: src.length, eol: '' });
  return lines;
}

/** Whether [start, end) of `src` holds a character an output can carry ({@link isUnshown}). */
function hasShown(src: string, start: number, end: number): boolean {
  for (let k = start; k < end; k += 1) {
    if (!isUnshown(src.charCodeAt(k))) {
      return true;
    }
  }
  return false;
}

/** The explicit base a ｜ opened, until its 《reading》: where the text before the ｜ starts, the
 *  ｜ itself, and the nodes met since (the text after the last of them is still pending). */
interface OpenBase {
  readonly beforeStart: number;
  readonly at: number;
  readonly nodes: SyntaxNode[];
}

function scanLine(src: string, from: number, to: number, issues: ScanIssue[]): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];
  let runStart = from; // the pending text run is [runStart, i)
  let held: OpenBase | null = null;

  /** Where the one-unit closer `unit` first occurs in `[at, to)`, or -1: every delimiter search stays inside the line. */
  const find = (unit: number, at: number): number => {
    for (let k = at; k < to; k += 1) {
      if (src.charCodeAt(k) === unit) {
        return k;
      }
    }
    return -1;
  };

  const text = (start: number, end: number): TextNode => ({ kind: 'text', span: { start, end }, text: src.slice(start, end) });

  /** Emits the pending run up to `end` into `into`. */
  const flush = (into: SyntaxNode[], end: number): void => {
    if (end > runStart) {
      into.push(text(runStart, end));
    }
    runStart = end;
  };

  /** No reading followed the ｜: it is text, and what was held comes out as it was. */
  const release = (): void => {
    if (held === null) {
      return;
    }
    const first = held.nodes[0];
    if (first === undefined) {
      runStart = held.beforeStart; // nothing between: the ｜ rejoins its text
    } else if (first.kind === 'text') {
      nodes.push(text(held.beforeStart, first.span.end));
      append(nodes, held.nodes.slice(1));
    } else {
      nodes.push(text(held.beforeStart, held.at + BASE_MARK.length));
      append(nodes, held.nodes);
    }
    held = null;
  };

  let readingsEnded = false; // no 》 from here to the line end: a later 《 has none to find
  let tcyOpen = false; // a 縦中横 span closes with its line, so the scanner can follow it
  let i = from;
  while (i < to) {
    const unit = src.charCodeAt(i);

    if (unit === ANNOTATION_OPEN_UNIT && src.startsWith(ANNOTATION_OPEN, i)) {
      const close = find(ANNOTATION_CLOSE_UNIT, i + ANNOTATION_OPEN.length);
      if (close === -1) {
        release();
        flush(nodes, i);
        nodes.push({ kind: 'brokenAnnotation', span: { start: i, end: to }, text: src.slice(i, to) });
        issues.push({ kind: 'unclosedAnnotation', span: { start: i, end: to } });
        runStart = to;
        i = to;
        continue;
      }
      const end = close + ANNOTATION_CLOSE.length;
      // A 外字注記 takes the ※ the pending text ends with.
      const marked = i > runStart && src.startsWith(GAIJI_MARK, i - GAIJI_MARK.length);
      const char = marked ? gaijiChar(src.slice(i + ANNOTATION_OPEN.length, close)) : undefined;
      const annotation = char === undefined
        ? classifyAnnotation(src, i, end, issues)
        : gaijiNode(src, i - GAIJI_MARK.length, end, char);
      if (annotation.kind === (tcyOpen ? 'tcySpanEnd' : 'tcySpanStart')) {
        release(); // a 縦中横 span is one cell of its own: a ｜ base never crosses its edge
        tcyOpen = !tcyOpen;
      }
      // Inside a ｜ base the annotation is part of it (｜山田［＃「山田」に傍点］《やまだ》).
      const into = held === null ? nodes : held.nodes;
      flush(into, annotation.span.start);
      into.push(annotation);
      runStart = end;
      i = end;
      continue;
    }

    if (unit === BASE_MARK_UNIT) {
      release(); // the last ｜ before a 《 wins
      held = { beforeStart: runStart, at: i, nodes: [] };
      runStart = i + BASE_MARK.length;
      i = runStart;
      continue;
    }

    if (unit === RUBY_OPEN_UNIT && !readingsEnded) {
      const close = find(RUBY_CLOSE_UNIT, i + RUBY_OPEN.length);
      if (close === -1) {
        readingsEnded = true;
        i += RUBY_OPEN.length; // no 》 on this line: text
        continue;
      }
      const end = close + RUBY_CLOSE.length;
      const reading = src.slice(i + RUBY_OPEN.length, close);

      if (reading === '') {
        issues.push({ kind: 'rubyReadingEmpty', span: { start: i, end } });
        release();
        i = end;
        continue;
      }

      const readingNode = (implicit: boolean, base: Span): RubyReadingNode => {
        const cut = new Cutter(src, i);
        cut.take('bracket', RUBY_OPEN.length);
        const part = cut.take('reading', reading.length);
        cut.take('bracket', RUBY_CLOSE.length);
        return { kind: 'rubyReading', span: { start: i, end }, text: src.slice(i, end), parts: cut.parts, reading: part, implicit, base };
      };

      if (held !== null) {
        // Text counts once the characters no output can carry are dropped: a base of control
        // characters alone would print as its markup.
        const visible = hasShown(src, runStart, i) ||
          held.nodes.some((n) => (n.kind === 'text' ? hasShown(src, n.span.start, n.span.end) : n.kind === 'valueField' || n.kind === 'gaiji'));
        if (!visible) {
          // Nothing between the ｜ and the 《 that a reading could sit on: no base.
          issues.push({ kind: 'rubyBaseMissing', span: { start: held.at, end }, reading, marked: true });
          release();
          i = end;
          continue;
        }
        const markEnd = held.at + BASE_MARK.length;
        if (held.at > held.beforeStart) {
          nodes.push(text(held.beforeStart, held.at));
        }
        nodes.push({ kind: 'rubyMark', span: { start: held.at, end: markEnd }, text: BASE_MARK });
        append(nodes, held.nodes);
        flush(nodes, i);
        nodes.push(readingNode(false, { start: held.at, end: i }));
        held = null;
        runStart = end;
        i = end;
        continue;
      }

      const baseStart = implicitBaseStart(src, runStart, i);
      if (baseStart === i) {
        issues.push({ kind: 'rubyBaseMissing', span: { start: i, end }, reading, marked: false });
        i = end;
        continue;
      }
      flush(nodes, baseStart);
      nodes.push({ ...text(baseStart, i), rubyBase: true }, readingNode(true, { start: baseStart, end: i }));
      runStart = end;
      i = end;
      continue;
    }

    i += 1;
  }

  release();
  flush(nodes, to);
  return nodes;
}

/** The syntax layer of `src`. */
export function scan(src: string): Syntax {
  const issues: ScanIssue[] = [];
  const lines: SyntaxLine[] = splitSource(src).map(({ start, end, eol }, index) => ({
    index,
    span: { start, end },
    eol,
    syntax: scanLine(src, start, end, issues),
  }));
  return { lines, issues };
}
