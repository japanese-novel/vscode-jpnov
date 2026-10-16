/**
 * Compact projections of the AST for the tests: a node reads as `kind text`, a span is looked up
 * by the text it covers, so an expectation shows the manuscript and never a hand-counted offset.
 */
import assert from 'node:assert/strict';

import type { Ast, Chars, Held, Inline, Issue, PairedNode, PostfixNode, Span, SyntaxNode, ValueLookup } from '../../../src/shared/ast/nodes.ts';
import { ANNOTATION_OPEN, BLOCK_FROM, EMPHASIS_VARIANTS, gaijiAnnotation, indentAnnotation, innerOf, markOf } from '../../../src/shared/ast/notation.ts';
import type { Channel } from '../../../src/shared/ast/notation.ts';
import { parse } from '../../../src/shared/ast/parse.ts';
import { scan } from '../../../src/shared/ast/scan.ts';
import { graphemes } from '../../../src/shared/chars.ts';
import { isRecord } from '../../../src/shared/utils/guards.ts';

/** The variant names of the notation per channel, in table order. */
export function variantsByChannel(): Record<Channel, readonly string[]> {
  const out: Record<Channel, string[]> = { emph: [], line: [], weight: [], style: [] };
  for (const [name, channel] of Object.entries(EMPHASIS_VARIANTS)) {
    out[channel].push(name);
  }
  return out;
}

export { innerOf };

/** `annotation` as a block opener: ［＃…］ as ［＃ここから…］. */
export function blockOf(annotation: string): string {
  return `${ANNOTATION_OPEN}${BLOCK_FROM}${annotation.slice(ANNOTATION_OPEN.length)}`;
}

/** The block opener of a 字下げ of `amount`. */
export function blockIndent(amount: number): string {
  return blockOf(indentAnnotation(amount));
}

/** The 外字注記 of `char`, which must be one the notation lists. */
export function gaijiOf(char: string): string {
  const annotation = gaijiAnnotation(char);
  assert.ok(annotation, `no 外字注記 for ${JSON.stringify(char)}`);
  return annotation;
}

/** Every syntax node of `src`, the lines flattened. */
export function nodesOf(src: string): SyntaxNode[] {
  return scan(src).lines.flatMap((line) => line.syntax);
}

/** The node kinds of `src`, in source order. */
export function kinds(src: string): string[] {
  return nodesOf(src).map((node) => node.kind);
}

function label(node: SyntaxNode): string {
  return `${node.kind === 'text' && node.rubyBase === true ? 'base' : node.kind} ${node.text}`;
}

/** Each node as `kind text`; the base of an implicit ruby reads `base text`. */
export function shape(src: string): string[] {
  return nodesOf(src).map(label);
}

/** {@link shape} per line. */
export function lineShapes(src: string): string[][] {
  return scan(src).lines.map((line) => line.syntax.map(label));
}

/** The `nth` node of `kind` in `src`. */
export function nodeOf<K extends SyntaxNode['kind']>(src: string, kind: K, nth = 0): Extract<SyntaxNode, { kind: K }> {
  const found = nodesOf(src).filter((node): node is Extract<SyntaxNode, { kind: K }> => node.kind === kind)[nth];
  assert.ok(found, `no ${kind} #${String(nth)} in ${JSON.stringify(src)}`);
  return found;
}

/**
 * What a node means, without where it sits: its kind, its text and its own fields, each part
 * field as the text it covers.
 */
export function facts(node: SyntaxNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'span' || key === 'parts' || key === 'base') {
      continue;
    }
    out[key] = isRecord(value) && 'text' in value ? value.text : value;
  }
  return out;
}

/** The span of the `nth` occurrence of `needle` in `src`. */
export function at(src: string, needle: string, nth = 0): Span {
  let start = -1;
  for (let k = 0; k <= nth; k += 1) {
    start = src.indexOf(needle, start + 1);
    assert.notEqual(start, -1, `no ${JSON.stringify(needle)} #${String(nth)} in ${JSON.stringify(src)}`);
  }
  return { start, end: start + needle.length };
}

/** Every syntax node of a resolved manuscript, the lines flattened. */
export function nodesIn(ast: Ast): SyntaxNode[] {
  return ast.lines.flatMap((line) => line.syntax);
}

const isPaired = (node: SyntaxNode): node is PairedNode => /^(indentBlock|emphasisSpan|headingSpan|tcySpan)(Start|End)$/.test(node.kind);
export const isPostfix = (node: SyntaxNode): node is PostfixNode => node.kind.endsWith('Postfix');

/** Each span start and end of `src` with the span of the node it pairs with; null when none. */
export function pairsOf(src: string): [text: string, pair: Span | null][] {
  const ast = parse(src);
  return nodesIn(ast).filter(isPaired).map((node) => [node.text, ast.pairs.get(node) ?? null]);
}

/** What each corner-target postfix of `src` bound to, in source order; null for a miss. */
export function boundOf(src: string): (Span | null)[] {
  const ast = parse(src);
  return nodesIn(ast).filter(isPostfix).map((node) => ast.bound.get(node) ?? null);
}

/** What each ［＃縦中横］ of `src` holds, in source order; null for one that opened no span. */
export function heldOf(src: string, values?: ValueLookup): (Held | null)[] {
  const ast = parse(src, values);
  return nodesIn(ast).flatMap((node) => (node.kind === 'tcySpanStart' ? [ast.held.get(node) ?? null] : []));
}

/** The findings of `src` among `only` (all of them when none is named), in the AST's order. */
export function issuesOf(src: string, ...only: Issue['kind'][]): Issue[] {
  return parse(src).issues.filter((issue) => only.length === 0 || only.includes(issue.kind));
}

function inlineLabel(item: Inline): string {
  const marks = item.kind === 'comment'
    ? ''
    : Object.entries(item.marks).map(([channel, mark]) => ` ${channel}=${markOf(mark)}`).join('');
  switch (item.kind) {
    case 'chars':
      return `${item.origin === 'prose' ? 'chars' : item.origin} ${item.text}${marks}`;
    case 'ruby':
      return `ruby ${item.base}${item.right === undefined ? '' : `《${item.right}》`}${item.left === undefined ? '' : `〈${item.left}〉`}${marks}`;
    case 'tcy':
      return `tcy ${item.text}${marks}`;
    case 'comment':
      return `comment ${item.inner}`;
  }
}

/**
 * The content of `src` per line: `chars text`, `ruby base《right》〈left〉`, `tcy text`,
 * `comment inner`, each followed by its marks as `channel=variant`.
 */
export function contentOf(src: string, values?: ValueLookup): string[][] {
  return parse(src, values).lines.map((line) => line.content.map(inlineLabel));
}

/**
 * Where each character of a run was written: its `starts`, else its span start plus its offset. Not
 * for a value: its characters have no place of their own.
 */
export function charStarts(item: Chars): number[] {
  let offset = 0;
  return graphemes(item.text).map((ch, i) => {
    const start = item.starts?.[i] ?? item.span.start + offset;
    offset += ch.length;
    return start;
  });
}
