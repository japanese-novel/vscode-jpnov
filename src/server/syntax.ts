/**
 * The always-on syntax diagnostics of an open .jpnov buffer: the AST's structural findings, plus
 * the one judgement made here — a 縦中横 cell holding too much. They publish under every lint
 * configuration, ahead of the lint findings in the same cache, and carry a fix where one is
 * mechanical: an end annotation of the other form than its start is respelled as the AST says;
 * a start that sets again what is in effect, and an end with nothing open (a render no-op), are
 * removed, with the line when a block directive had the line to itself (such a line paints nothing);
 * a 《…》 no ｜ opened and no base precedes is respelled as the 二重山括弧 外字注記, the brackets it
 * already prints as.
 *
 * An unclosed ［＃ is an Error, like an unterminated string literal; everything else is a Warning,
 * the markup being well-formed and the render lenient about it.
 */
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { Ast, Issue, Span } from '../shared/ast/nodes.ts';
import { INDENT_MAX, RUBY_CLOSE, RUBY_OPEN, fullWidthDigits, gaijiAnnotation } from '../shared/ast/notation.ts';
import { paintsNothing } from '../shared/ast/resolve.ts';
import { bySource } from '../shared/ast/span.ts';
import { displayText, graphemeCount } from '../shared/chars.ts';
import type { LocalizableMessage } from '../shared/protocol.ts';

import { diagnostic, finding } from './diagnostics.ts';
import type { Finding, Fix } from './diagnostics.ts';
import { rangeOf } from './targets.ts';

/** Combined cells squish visibly beyond this many characters (measured in headless Chrome). */
export const TCY_MAX = 3;

interface Found {
  readonly span: Span;
  readonly message: LocalizableMessage;
  readonly fix: Fix | undefined;
}

function tooLong(text: string): boolean {
  return graphemeCount(text) > TCY_MAX;
}

/** The message of a 字下げ above {@link INDENT_MAX}: it names the limit in the digits the count is written in. */
export const INDENT_TOO_LARGE: LocalizableMessage = { code: 'syntax.indentTooLarge', args: [fullWidthDigits(INDENT_MAX)] };

function messageOf(issue: Issue): LocalizableMessage {
  switch (issue.kind) {
    case 'unclosedAnnotation':
      return { code: 'syntax.unclosedAnnotation' };
    case 'indentTooLarge':
      return INDENT_TOO_LARGE;
    case 'unterminatedSpan':
      return { code: issue.block ? 'syntax.unterminatedBlock' : 'syntax.unterminatedSpan' };
    case 'danglingSpanEnd':
      return { code: issue.block ? 'syntax.danglingBlockEnd' : 'syntax.danglingSpanEnd' };
    case 'spanAlreadyOpen':
      return { code: 'syntax.spanAlreadyOpen', args: [issue.mark] };
    case 'spanFormMismatch':
      return { code: 'syntax.spanFormMismatch', args: [issue.expected] };
    case 'unterminatedTcy':
      return { code: 'syntax.unterminatedTcy' };
    case 'danglingTcyEnd':
      return { code: 'syntax.danglingTcyEnd' };
    case 'postfixTargetMissing':
      return { code: 'syntax.postfixTargetMissing', args: [issue.target] };
    case 'rubyBaseMissing':
      return { code: 'syntax.rubyBaseMissing', args: [issue.reading] };
    case 'rubyReadingEmpty':
      return { code: 'syntax.rubyReadingEmpty' };
    case 'rubyInTcy':
      return { code: 'syntax.rubyInTcy', args: [issue.reading] };
  }
}

/** `within` is empty throughout: a 「…」 cannot hold markup, so no target contains an annotation. */
function edit(doc: TextDocument, span: Span, newText: string): Fix {
  return { range: rangeOf(doc, span), newText, within: [] };
}

/**
 * The span an annotation that does nothing is removed over: the annotation alone, or its whole
 * line (with one terminator) when a ここから／ここで directive had the line to itself — the line
 * painted nothing, and an empty line left behind would. The AST counts lines as the document does.
 */
function removal(doc: TextDocument, ast: Ast, span: Span): Span {
  const line = ast.lines[doc.positionAt(span.start).line];
  if (line?.syntax.length !== 1 || !paintsNothing(line)) {
    return span;
  }
  const prev = ast.lines[line.index - 1];
  return line.eol === '' && prev !== undefined
    ? { start: prev.span.end, end: line.span.end }
    : { start: line.span.start, end: line.span.end + line.eol.length };
}

/** 《 and 》 as 外字注記: brackets that open no ruby. Both are listed; the fallback only narrows the type. */
const ANGLE_OPEN = gaijiAnnotation(RUBY_OPEN) ?? RUBY_OPEN;
const ANGLE_CLOSE = gaijiAnnotation(RUBY_CLOSE) ?? RUBY_CLOSE;

/** The fix of an issue, where one is mechanical (see the module header). */
function fixOf(issue: Issue, doc: TextDocument, ast: Ast): Fix | undefined {
  switch (issue.kind) {
    case 'spanAlreadyOpen':
      return issue.redundant ? edit(doc, removal(doc, ast, issue.span), '') : undefined;
    case 'danglingSpanEnd':
    case 'danglingTcyEnd':
      return edit(doc, removal(doc, ast, issue.span), '');
    case 'spanFormMismatch':
      return edit(doc, issue.span, issue.expected);
    case 'rubyBaseMissing':
      // A span from a ｜: the author meant ruby, and nothing is offered.
      return issue.marked ? undefined : edit(doc, issue.span, `${ANGLE_OPEN}${issue.reading}${ANGLE_CLOSE}`);
    default:
      return undefined;
  }
}

/**
 * Every 縦中横 holding more than {@link TCY_MAX} characters: a span over what it holds, a
 * postfix over its target, bound or not.
 */
function tcyTooLong(ast: Ast): Found[] {
  const message: LocalizableMessage = { code: 'syntax.tcyTooLong' };
  const out: Found[] = [];
  for (const line of ast.lines) {
    for (const node of line.syntax) {
      const held = node.kind === 'tcySpanStart' ? ast.held.get(node) : undefined;
      if (held !== undefined && tooLong(held.text)) {
        out.push({ span: held.span, message, fix: undefined });
      } else if (node.kind === 'tcyPostfix' && tooLong(displayText(node.target.text))) {
        out.push({ span: node.target.span, message, fix: undefined });
      }
    }
  }
  return out;
}

/** The syntax findings of `doc`, in source order; `ast` is the parse of its text. */
export function syntaxFindings(doc: TextDocument, ast: Ast): Finding[] {
  const found: Found[] = [
    ...ast.issues.map((issue) => ({ span: issue.span, message: messageOf(issue), fix: fixOf(issue, doc, ast) })),
    ...tcyTooLong(ast),
  ];
  return found
    .sort(bySource)
    .map(({ span, message, fix }) =>
      finding(
        diagnostic(
          rangeOf(doc, span),
          message,
          message.code === 'syntax.unclosedAnnotation' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
        ),
        fix,
      ),
    );
}
