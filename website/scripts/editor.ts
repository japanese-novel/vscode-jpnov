/**
 * Editor colouring for the stage: the product's own semantic tokens decoded into per-line runs,
 * so the reconstructed editor paints what VS Code paints for the same source and cast.
 */
import { TextDocument } from 'vscode-languageserver-textdocument';

import { createRecognizer } from '../../src/server/highlight/recognizer.ts';
import { buildSemanticTokens, SEMANTIC_LEGEND } from '../../src/server/semanticTokens.ts';
import type { EditorLine, EditorToken, TokenKind } from './contract.ts';

export interface Vocabulary {
  readonly cast: readonly string[];
  readonly keywords: readonly string[];
}

/** LSP token type → contract kind (the legend is the product's; see semanticTokens.ts HIGHLIGHTS). */
const KIND_OF: Readonly<Record<string, TokenKind>> = {
  comment: 'marker',
  keyword: 'directive',
  variable: 'character',
  operator: 'keyword',
};

interface Span {
  readonly line: number;
  readonly start: number;
  readonly len: number;
  readonly kind: TokenKind;
}

/** Decodes the LSP delta-encoded 5-tuples into absolute spans (in document order, as the encoding requires). */
function decode(data: readonly number[]): Span[] {
  const spans: Span[] = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i] ?? 0;
    const deltaStart = data[i + 1] ?? 0;
    const len = data[i + 2] ?? 0;
    const type = SEMANTIC_LEGEND.tokenTypes[data[i + 3] ?? -1];
    line += deltaLine;
    char = deltaLine === 0 ? char + deltaStart : deltaStart;
    const kind = type === undefined ? undefined : KIND_OF[type];
    if (kind === undefined) {
      throw new Error(`editor: unknown semantic token type ${String(type)}`);
    }
    spans.push({ line, start: char, len, kind });
  }
  return spans;
}

export function colourLines(src: string, vocab: Vocabulary): EditorLine[] {
  const doc = TextDocument.create('file:///sample.jpnov', 'jpnov', 1, src);
  const spans = new Map<number, Span[]>();
  for (const span of decode(buildSemanticTokens(doc, createRecognizer(vocab.cast, vocab.keywords)).data)) {
    const line = spans.get(span.line);
    if (line === undefined) {
      spans.set(span.line, [span]);
    } else {
      line.push(span);
    }
  }
  const lines = src.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines.map((text, lineNo): EditorLine => {
    const runs: EditorToken[] = [];
    let at = 0;
    for (const span of spans.get(lineNo) ?? []) {
      if (span.start > at) {
        runs.push({ text: text.slice(at, span.start), kind: 'text' });
      }
      runs.push({ text: text.slice(span.start, span.start + span.len), kind: span.kind });
      at = span.start + span.len;
    }
    if (at < text.length) {
      runs.push({ text: text.slice(at), kind: 'text' });
    }
    return mergeRuns(runs);
  });
}

/** Adjacent runs of one kind (the highlighter emits `《たろう` and `》` separately) become one. */
function mergeRuns(runs: readonly EditorToken[]): EditorLine {
  const out: EditorToken[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last?.kind === run.kind) {
      out[out.length - 1] = { text: last.text + run.text, kind: run.kind };
    } else {
      out.push(run);
    }
  }
  return out;
}
