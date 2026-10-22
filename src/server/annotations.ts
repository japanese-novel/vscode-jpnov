/**
 * The editor features over one annotation: what the hover says of it, the ranges that light up
 * with it, and the rename of a 対象文字列 together with the body it names. All three read the
 * resolver's tables — what a postfix bound to, which start pairs with which end — and never the
 * source around the node.
 *
 * The hover is a custom request: its lines are message codes the client renders, since the
 * server writes no UI text. The rename and the highlight are the standard LSP requests.
 */
import { DocumentHighlightKind } from 'vscode-languageserver/node';
import type { DocumentHighlight, Range, TextEdit, WorkspaceEdit } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { Ast, PairedNode, PostfixNode, Ruby, Span, SyntaxNode } from '../shared/ast/nodes.ts';
import { TCY, fullWidthDigits, headingLiteralOf, isValueFormat, markOf, spanMark } from '../shared/ast/notation.ts';
import type { Channel } from '../shared/ast/notation.ts';
import { displayText } from '../shared/chars.ts';
import type { HoverResult, LocalizableMessage, Position } from '../shared/protocol.ts';

import { MARKUP, eligibleTargets, isPostfix, rangeOf, syncedTargets, targetEdits } from './targets.ts';
import type { EligibleTarget } from './targets.ts';

const GUIDE = 'https://www.aozora.gr.jp/annotation/';

/** The page of the 青空文庫 guide that describes a decoration of `channel`. */
const EMPHASIS_PAGES: Readonly<Record<Channel, string>> = {
  emph: `${GUIDE}emphasis.html#boten_chuki`,
  line: `${GUIDE}emphasis.html#bosen_chuki`,
  weight: `${GUIDE}emphasis.html#futoji_gothic,shatai_italic`,
  style: `${GUIDE}emphasis.html#futoji_gothic,shatai_italic`,
};

/** The page of the 青空文庫 guide that describes `node`; none for what the guide does not have. */
function linkOf(node: SyntaxNode): string | undefined {
  switch (node.kind) {
    case 'emphasisPostfix':
    case 'emphasisSpanStart':
    case 'emphasisSpanEnd':
      return EMPHASIS_PAGES[node.channel];
    case 'headingPostfix':
    case 'headingSpanStart':
    case 'headingSpanEnd':
      return `${GUIDE}heading.html`;
    case 'tcyPostfix':
    case 'tcySpanStart':
    case 'tcySpanEnd':
      return `${GUIDE}etc.html#tatechu_yoko`;
    case 'rubyLeftPostfix':
    case 'rubyReading':
      return `${GUIDE}etc.html#ruby`;
    case 'indent':
      return `${GUIDE}layout_2.html#ichigyo`;
    case 'indentBlockStart':
    case 'indentBlockEnd':
      return `${GUIDE}layout_2.html#jisage`;
    case 'pageBreak':
      return `${GUIDE}layout_1.html#kaipage`;
    case 'gaiji':
      return `${GUIDE}external_character.html`;
    case 'comment':
      return `${GUIDE}index.html`;
    default:
      return undefined;
  }
}

function isPaired(node: SyntaxNode): node is PairedNode {
  return /^(indentBlock|emphasisSpan|headingSpan|tcySpan)(Start|End)$/.test(node.kind);
}

function syntaxAt(ast: Ast, line: number): readonly SyntaxNode[] {
  return ast.lines[line]?.syntax ?? [];
}

/**
 * The node at `offset` on `line`: what the mouse points at, or — the cursor's reading — the node
 * it just finished: inside or right after markup it is on that markup; where markup starts it is
 * still on the text before it, as a cursor after a word is on the word.
 */
function nodeAt(ast: Ast, line: number, offset: number, cursor: boolean): SyntaxNode | undefined {
  const syntax = syntaxAt(ast, line);
  const pointed = syntax.find((n) => n.span.start <= offset && offset < n.span.end);
  return cursor ? syntax.find((n) => n.span.start < offset && offset <= n.span.end) ?? pointed : pointed;
}

/** Of `items`, those whose body holds `offset`: the ones it falls inside, else the ones it touches the end of. */
function holding<T extends { readonly bound: Span }>(items: readonly T[], offset: number): T[] {
  const inside = items.filter(({ bound }) => bound.start <= offset && offset < bound.end);
  return inside.length > 0 ? inside : items.filter(({ bound }) => bound.start <= offset && offset <= bound.end);
}

/** The code naming a start or end by its form: ここから／ここで, or the inline ［＃…］／［＃…終わり］. */
function formOf(node: PairedNode): LocalizableMessage['code'] {
  const start = node.kind.endsWith('Start');
  const block = node.kind === 'indentBlockStart' || node.kind === 'indentBlockEnd' ||
    (node.kind !== 'tcySpanStart' && node.kind !== 'tcySpanEnd' && node.block !== undefined);
  if (block) {
    return start ? 'hover.blockStart' : 'hover.blockEnd';
  }
  return start ? 'hover.spanStart' : 'hover.spanEnd';
}

/** What `node` is, as the hover's first line; none for a node that is no markup. */
function whatItIs(node: SyntaxNode): LocalizableMessage | undefined {
  switch (node.kind) {
    case 'text':
    case 'rubyMark':
      return undefined;
    case 'rubyReading':
      return { code: 'hover.ruby', args: [displayText(node.reading.text)] };
    case 'brokenAnnotation':
      return { code: 'hover.broken' };
    case 'comment':
      return { code: 'hover.comment' };
    case 'pageBreak':
      return { code: 'hover.pageBreak' };
    case 'indent':
      return { code: 'hover.indent', args: [fullWidthDigits(node.amount)] };
    case 'valueField':
      return node.format !== undefined && isValueFormat(node.format.text)
        ? { code: 'hover.valueFormat', args: [node.name.text, node.format.text] }
        : { code: 'hover.value', args: [node.name.text] };
    case 'gaiji':
      return { code: 'hover.gaiji', args: [node.char] };
    case 'emphasisPostfix':
      return { code: 'hover.postfix', args: [markOf(node)] };
    case 'tcyPostfix':
      return { code: 'hover.postfix', args: [TCY] };
    case 'headingPostfix':
      return { code: 'hover.postfix', args: [headingLiteralOf(node.level)] };
    case 'rubyLeftPostfix':
      return { code: 'hover.rubyLeft', args: [displayText(node.reading.text)] };
    case 'indentBlockStart':
    case 'indentBlockEnd':
    case 'emphasisSpanStart':
    case 'emphasisSpanEnd':
    case 'headingSpanStart':
    case 'headingSpanEnd':
      return { code: formOf(node), args: [spanMark(node)] };
    case 'tcySpanStart':
    case 'tcySpanEnd':
      return { code: formOf(node), args: [TCY] };
  }
}

/** What a start or end relates to: its partner, with the line the partner sits on, or that it has none. */
function pairLine(doc: TextDocument, ast: Ast, node: PairedNode): LocalizableMessage {
  const partner = ast.pairs.get(node);
  const start = node.kind.endsWith('Start');
  if (partner === undefined) {
    const replacer = node.kind === 'indentBlockStart' ? ast.replaced.get(node) : undefined;
    if (replacer !== undefined) {
      return { code: 'hover.replaced', args: [doc.positionAt(replacer.start).line + 1] };
    }
    return { code: start ? 'hover.endMissing' : 'hover.startMissing' };
  }
  const line = doc.positionAt(partner.start).line + 1;
  return { code: start ? 'hover.pairEnd' : 'hover.pairStart', args: [doc.getText(rangeOf(doc, partner)), line] };
}

/** The hover lines of `node`: what it is, then what it relates to. */
function hoverLines(doc: TextDocument, ast: Ast, node: SyntaxNode): LocalizableMessage[] {
  const first = whatItIs(node);
  if (first === undefined) {
    return [];
  }
  if (isPostfix(node)) {
    // What it bound to is the body as shown, which is the target as shown: the resolver matched them.
    return [first, ast.bound.has(node) ? { code: 'hover.target', args: [displayText(node.target.text)] } : { code: 'hover.targetMissing' }];
  }
  if (isPaired(node)) {
    const held = node.kind === 'tcySpanStart' ? ast.held.get(node) : undefined;
    return [first, ...(held === undefined ? [] : [{ code: 'hover.holds', args: [held.text] } as const]), pairLine(doc, ast, node)];
  }
  if (node.kind === 'rubyReading') {
    const ruby = ast.lines[doc.positionAt(node.span.start).line]?.content.find((item): item is Ruby => item.kind === 'ruby' && item.right?.span.start === node.reading.span.start);
    return ruby === undefined ? [first] : [first, { code: 'hover.rubyBase', args: [ruby.base] }]; // no ruby: an empty base, or a 縦中横 took it
  }
  return [first];
}

/** The hover over `position`: the annotation there, or null off one. */
export function hoverAt(doc: TextDocument, ast: Ast, position: Position): HoverResult | null {
  const node = nodeAt(ast, position.line, doc.offsetAt(position), false);
  const lines = node === undefined ? [] : hoverLines(doc, ast, node);
  if (node === undefined || lines.length === 0) {
    return null;
  }
  const link = linkOf(node);
  return { range: rangeOf(doc, node.span), lines, ...(link === undefined ? {} : { link }) };
}

/** The ranges that light up with `position`: an annotation with what it relates to, or the body with the postfixes bound over it. */
export function highlightsAt(doc: TextDocument, ast: Ast, position: Position): DocumentHighlight[] {
  const offset = doc.offsetAt(position);
  const node = nodeAt(ast, position.line, offset, true);
  let spans: Span[];
  if (node !== undefined && isPostfix(node)) {
    const bound = ast.bound.get(node);
    spans = bound === undefined ? [node.span] : [node.target.span, bound];
  } else if (node !== undefined && isPaired(node)) {
    const held = node.kind === 'tcySpanStart' ? ast.held.get(node) : undefined;
    const partner = ast.pairs.get(node);
    spans = [node.span, ...(held === undefined ? [] : [held.span]), ...(partner === undefined ? [] : [partner])];
  } else if (node?.kind === 'rubyReading') {
    spans = [node.span, node.base];
  } else {
    const over: { node: PostfixNode; bound: Span }[] = [];
    for (const candidate of syntaxAt(ast, position.line)) {
      const bound = isPostfix(candidate) ? ast.bound.get(candidate) : undefined;
      if (isPostfix(candidate) && bound !== undefined) {
        over.push({ node: candidate, bound });
      }
    }
    spans = holding(over, offset).flatMap(({ node: postfix, bound }) => [postfix.target.span, bound]);
  }
  const distinct = [...new Map(spans.map((span) => [`${String(span.start)}:${String(span.end)}`, span])).values()];
  return distinct.map((span) => ({ range: rangeOf(doc, span), kind: DocumentHighlightKind.Text }));
}

/** The symbol a rename at `position` is of: the target to rewrite with its body, and the range the editor selects. */
function renameSymbolAt(
  doc: TextDocument,
  ast: Ast,
  position: Position,
  eligible: readonly EligibleTarget[],
): { readonly target: EligibleTarget; readonly shown: Span } | null {
  const offset = doc.offsetAt(position);
  const node = nodeAt(ast, position.line, offset, true);
  if (node !== undefined && isPostfix(node)) {
    const own = eligible.find((target) => target.node === node);
    return own === undefined ? null : { target: own, shown: node.target.span };
  }
  // On the body: the innermost eligible range holding the offset.
  const width = ({ bound }: EligibleTarget): number => bound.end - bound.start;
  const [innermost] = holding(eligible, offset).toSorted((a, b) => width(a) - width(b));
  return innermost === undefined ? null : { target: innermost, shown: innermost.bound };
}

/** What a rename at `position` would rename, or null where there is nothing to. */
export function prepareRenameAt(doc: TextDocument, ast: Ast, position: Position): { range: Range; placeholder: string } | null {
  const symbol = renameSymbolAt(doc, ast, position, eligibleTargets(ast, doc.getText(), position.line));
  return symbol === null ? null : { range: rangeOf(doc, symbol.shown), placeholder: symbol.target.node.target.text };
}

/** The edits of renaming the symbol at `position` to `newName`: the body, and every 「…」 bound over it. */
export function renameAt(doc: TextDocument, ast: Ast, position: Position, newName: string): WorkspaceEdit | null {
  // A name holding a line break or a marker of the notation would break the annotation: refused.
  if (newName === '' || /[\r\n]/.test(newName) || MARKUP.test(newName)) {
    return null;
  }
  const eligible = eligibleTargets(ast, doc.getText(), position.line);
  const symbol = renameSymbolAt(doc, ast, position, eligible);
  if (symbol === null) {
    return null;
  }
  const { bound } = symbol.target;
  const edits: TextEdit[] = [
    { range: rangeOf(doc, bound), newText: newName },
    ...targetEdits(syncedTargets(eligible, doc, bound, newName)),
  ];
  return { changes: { [doc.uri]: edits } };
}
