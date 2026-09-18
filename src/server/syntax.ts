/**
 * Always-on structural (syntax) diagnostics for an open .jpnov buffer — the editor surface of the
 * compiler's lenient recovery, in two tiers mirroring the damage:
 *   - Lexically broken (an unclosed ［＃, swallowed to its line end and rendered as literal text
 *     by the layout) is an ERROR, like an unterminated string literal in a programming language.
 *   - Structurally unpaired spans (a start — inline ［＃太字］ or block ［＃ここから…］ — open at EOF,
 *     or an end with nothing open in its channel) are WARNINGS: every bracket is well-formed and
 *     the render stays lenient (EOF auto-close / dangling no-op), the pairing is just incomplete.
 * A lone 《 / ］ / 》 is NOT an error (the tokenizer keeps them literal); a closed 《…》 with no
 * base text before it, or an empty 《》, is a WARNING (it prints as typed).
 *
 * Unconditional by design: unlike the prose lint (selection-gated Warnings through the lint
 * engine), these publish under every lint configuration, including all-off. The findings stay
 * OUT of the lint findings cache — there is no quick fix to offer.
 *
 * Relative imports only (native test loader; see test/server/lint/syntaxDiagnostics.test.ts).
 */
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import type { Diagnostic } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import { findPostfixTargetIssues } from '../shared/compiler/layout.ts';
import {
  findBrokenAnnotations,
  findRubyIssues,
  findTcyIssues,
  findUnpairedSpans,
} from '../shared/compiler/tokenizer.ts';
import type { LocalizableMessage } from '../shared/protocol.ts';

import { diagnostic } from './diagnostics.ts';

// findUnpairedSpans / findTcyIssues return a STRUCTURAL kind, not a protocol code — the
// tokenizer stays message-code-free. The kind→MsgCode mappings live here, server-side; the span
// table is keyed by the annotation's own form.
const SPAN_WARNING_CODE = {
  block: { unterminated: 'syntax.unterminatedBlock', dangling: 'syntax.danglingBlockEnd' },
  inline: { unterminated: 'syntax.unterminatedSpan', dangling: 'syntax.danglingSpanEnd' },
} as const;

const TCY_WARNING_CODE = {
  unterminated: 'syntax.unterminatedTcy',
  dangling: 'syntax.danglingTcyEnd',
  tooLong: 'syntax.tcyTooLong',
} as const;

/**
 * One Error per unclosed ［＃, then Warnings: unpaired spans, structural 縦中横 issues,
 * corner-target postfixes whose target is absent or not unit-aligned (derived by running the
 * layout itself, so the Warning surface always matches the render), and ruby markup that made
 * no ruby.
 */
export function annotationDiagnostics(doc: TextDocument): Diagnostic[] {
  const text = doc.getText();
  // One diagnostic over each span, its message derived from the span.
  const over = <S extends { readonly start: number; readonly end: number }>(
    spans: readonly S[],
    severity: DiagnosticSeverity,
    message: (span: S) => LocalizableMessage,
  ): Diagnostic[] =>
    spans.map((span) =>
      diagnostic(
        { start: doc.positionAt(span.start), end: doc.positionAt(span.end) },
        message(span),
        severity,
      ),
    );
  const { Error, Warning } = DiagnosticSeverity;
  return [
    ...over(findBrokenAnnotations(text), Error, () => ({ code: 'syntax.unclosedAnnotation' })),
    ...over(findUnpairedSpans(text), Warning, (span) => ({
      code: SPAN_WARNING_CODE[span.block ? 'block' : 'inline'][span.kind],
    })),
    ...over(findTcyIssues(text), Warning, (span) => ({ code: TCY_WARNING_CODE[span.kind] })),
    ...over(findPostfixTargetIssues(text), Warning, (span) => ({
      code: 'syntax.postfixTargetMissing',
      args: [span.target],
    })),
    ...over(findRubyIssues(text), Warning, (span) =>
      span.kind === 'baseMissing'
        ? { code: 'syntax.rubyBaseMissing', args: [span.reading] }
        : { code: 'syntax.rubyReadingEmpty' },
    ),
  ];
}
