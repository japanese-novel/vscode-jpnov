/**
 * The prose-lint driver: turns a document + the active {@link RuleSelection} into
 * {@link Finding}s (a diagnostic plus, when the rule is auto-fixable, a source-mapped fix).
 *
 * ONE synchronous pass: instantiate every enabled `line` rule, feed each {@link LintLine} from the
 * single-walk {@link walkLines} to every instance, flush with `end()`, then run the `raw` rules
 * over the source. Everything here is O(n) in the document — the walker is one pass over the
 * parsed manuscript and no rule does super-linear work per line.
 *
 * Fix materialization is the only place a {@link FixSpec} becomes an LSP range. A `replace` names
 * one SLICE (contiguous source by construction, so a fix can never overwrite elided markup). An
 * insert names a prose UNIT and a side (zero-width; the offset is resolved through the unit's
 * carrier, past a ruby's reading or a closing annotation, and never eats a newline). An `erase`
 * is checked against the AST to hold nothing but typed characters, whole ［＃○字下げ］
 * annotations and the terminators of blank lines. Out-of-slice arithmetic, an insert on a
 * synthetic unit, or an erase over anything else is a programming error and throws.
 *
 * A `raw` rule can restate a prose rule's finding over the same characters (an unencodable
 * character that is ALSO decomposed, invisible, …). The prose rule is the more specific one and
 * often carries a fix, so it keeps that range — the raw finding is dropped where a rule it
 * `yieldsTo` already reports. Other rules sharing a range (字下げ on a first character) say
 * something else and hide nothing.
 */
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { Ast, Span } from '../../shared/ast/nodes.ts';
import { isSelectionEmpty } from '../../shared/lint/select.ts';
import type { ActiveRule, RuleSelection } from '../../shared/lint/select.ts';
import type { LocalizableMessage } from '../../shared/protocol.ts';
import { partitionPoint } from '../../shared/utils/lists.ts';

import { diagnostic, finding } from '../diagnostics.ts';
import type { Finding, Fix } from '../diagnostics.ts';
import { TargetIndex, rangeKey, rangeOf } from '../targets.ts';
import { RULE_IMPL } from './modules.ts';
import type { RuleImpl } from './modules.ts';
import type { FixSpec, LineRule, ProseUnit } from './types.ts';
import { walkLines } from './walker.ts';

const WARNING = DiagnosticSeverity.Warning;

/** The source offset an insert anchored on `unit` resolves to: inside its carrier the neighbour
 *  is where the unit was written; at an edge, and anywhere in an atomic cell (a ruby, a 縦中横),
 *  the carrier's outer extent skips the markup wrapping it. */
function insertOffset(unit: ProseUnit, side: 'before' | 'after'): number {
  const carrier = unit.carrier;
  if (carrier === null) {
    throw new Error(`lint fix anchors an insert on a synthetic unit at ${String(unit.src)}`);
  }
  if (side === 'before') {
    return carrier.kind === 'cell' || unit.src === carrier.src ? carrier.outerStart : unit.src;
  }
  return carrier.kind === 'cell' || unit.end === carrier.end ? carrier.outerEnd : unit.end;
}

function erasesMarkup(span: Span): never {
  throw new Error(`lint fix erases markup: [${String(span.start)}, ${String(span.end)})`);
}

/** Throws unless `span` holds nothing but typed characters, whole ［＃○字下げ］ annotations and the terminators of blank lines. */
function checkErase(span: Span, doc: TextDocument, ast: Ast): void {
  let at = span.start;
  for (let l = doc.positionAt(at).line; at < span.end; l += 1) {
    const line = ast.lines[l];
    if (line === undefined) {
      erasesMarkup(span);
    }
    if (line.syntax.length === 0) {
      at = Math.min(span.end, line.span.end + line.eol.length); // a blank line, its terminator included
      continue;
    }
    for (let i = partitionPoint(line.syntax, (node) => node.span.end > at); at < span.end; i += 1) {
      const node = line.syntax[i];
      if (node === undefined || node.span.start > at) {
        break;
      }
      if (node.kind === 'text') {
        at = Math.min(span.end, node.span.end);
      } else if (node.kind === 'indent' && node.span.start === at && node.span.end <= span.end) {
        at = node.span.end;
      } else {
        erasesMarkup(span);
      }
    }
    if (at < span.end && at >= line.span.end) {
      erasesMarkup(span); // the terminator of a line that holds something
    }
  }
}

/** The source span a {@link FixSpec} edits and the text it writes there (see the module header
 *  for why the three shapes are the only safe ones). */
function fixSpan(spec: FixSpec, doc: TextDocument, ast: Ast): { span: Span; text: string } {
  if ('insert' in spec) {
    const at = insertOffset(spec.insert, spec.side);
    return { span: { start: at, end: at }, text: spec.text };
  }
  if ('erase' in spec) {
    checkErase(spec.erase, doc, ast);
    return { span: spec.erase, text: '' };
  }
  const { slice, start, end } = spec.replace;
  if (start < 0 || end < start || end > slice.text.length) {
    throw new Error(`lint fix out of slice bounds: [${String(start)}, ${String(end)})`);
  }
  return { span: { start: slice.srcStart + start, end: slice.srcStart + end }, text: spec.text };
}

/** Materializes a {@link FixSpec} into source coordinates, with the 対象文字列 it lands inside. */
function materializeFix(spec: FixSpec, doc: TextDocument, ast: Ast, targets: TargetIndex): Fix {
  const { span, text } = fixSpan(spec, doc, ast);
  const range = rangeOf(doc, span);
  return { range, newText: text, within: targets.within(doc, range.start.line, span, text) };
}

/**
 * Computes the prose-lint findings of `doc` under `selection` — synchronously; the all-off
 * default costs nothing (no walk, no scans). `ast` is the editor's parse of its text.
 */
export function computeLintFindings(doc: TextDocument, ast: Ast, selection: RuleSelection): Finding[] {
  if (isSelectionEmpty(selection)) {
    return [];
  }
  const text = doc.getText();
  const targets = new TargetIndex(ast, text);
  const prose: Finding[] = [];
  const instances: LineRule[] = [];
  const rawRules: { readonly rule: ActiveRule; readonly impl: Extract<RuleImpl, { kind: 'raw' }> }[] = [];
  /** `${rule id}\n${range}` of each prose finding, for the raw rules yielding to that rule. */
  const taken = new Set<string>();
  for (const rule of selection) {
    const impl = RULE_IMPL[rule.id];
    if (impl.kind === 'raw') {
      rawRules.push({ rule, impl });
      continue;
    }
    instances.push(
      impl.create({
        options: rule.options,
        ast,
        report(span: Span, extra?: { message?: LocalizableMessage; fix?: FixSpec }): void {
          const range = rangeOf(doc, span);
          const message = extra?.message ?? { code: rule.code };
          const fix = extra?.fix === undefined ? undefined : materializeFix(extra.fix, doc, ast, targets);
          prose.push(finding(diagnostic(range, message, WARNING), fix));
          taken.add(`${rule.id}\n${rangeKey(range)}`);
        },
      }),
    );
  }

  if (instances.length > 0) {
    for (const line of walkLines(ast)) {
      for (const instance of instances) {
        instance.line(line);
      }
    }
    for (const instance of instances) {
      instance.end?.();
    }
  }

  const raw: Finding[] = [];
  for (const { rule, impl } of rawRules) {
    for (const span of impl.scan(text, rule.options)) {
      const range = rangeOf(doc, span);
      const key = rangeKey(range);
      if (impl.yieldsTo.some((id) => taken.has(`${id}\n${key}`))) {
        continue;
      }
      raw.push(finding(diagnostic(range, span.message ?? { code: rule.code }, WARNING), undefined));
    }
  }
  return [...raw, ...prose];
}
