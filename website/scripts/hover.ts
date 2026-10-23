/**
 * The stage annotation's hover and highlights, from the product's own jpnov/hover and
 * documentHighlight handlers over the editor's parse, with the hover lines localised as the
 * client renders them.
 */
import { highlightsAt, hoverAt } from '../../src/server/annotations.ts';
import type { AnnotationHover } from './contract.ts';
import { localize, sampleDocument } from './lint.ts';

/** Code points before UTF-16 `character` on `line`. */
const column = (line: string, character: number): number => Array.from(line.slice(0, character)).length;

/** The hover over `annotation` on `lineIndex` of `src`, and what lights up with the caret right after it. */
export function annotationHover(src: string, lineIndex: number, annotation: string): AnnotationHover {
  const { doc, ast } = sampleDocument(src);
  const line = src.split('\n')[lineIndex] ?? '';
  const start = line.indexOf(annotation);
  if (start < 0) {
    throw new Error(`hover: line ${String(lineIndex)} does not carry ${annotation}`);
  }
  const hover = hoverAt(doc, ast, { line: lineIndex, character: start + 1 });
  if (hover?.link === undefined) {
    throw new Error('hover: the stage annotation must have a hover with a guide link');
  }
  const highlights = highlightsAt(doc, ast, { line: lineIndex, character: start + annotation.length });
  if (highlights.length !== 2 || highlights.some((h) => h.range.start.line !== lineIndex || h.range.end.line !== lineIndex)) {
    throw new Error(`hover: the caret after the annotation must light up its target and the body, got ${JSON.stringify(highlights)}`);
  }
  return {
    line: lineIndex,
    column: column(line, start),
    lines: hover.lines.map((message) => localize(message)),
    highlights: highlights.map((h) => ({ from: column(line, h.range.start.character), to: column(line, h.range.end.character) })),
  };
}
