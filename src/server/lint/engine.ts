/**
 * The prose-lint driver: turns a document + the active {@link RuleSelection} into
 * {@link LintFinding}s (a diagnostic plus, when the rule is auto-fixable, a source-mapped fix).
 *
 * ONE synchronous pass: instantiate every enabled `line` rule, feed each {@link LintLine} from the
 * single-walk {@link walkLines} to every instance, flush with `end()`, then run the `raw` rules
 * over the source. Everything here is O(n) in the document — the walker is one tokenize pass and
 * no rule does super-linear work per line (the invariant that lets this stay synchronous; the
 * per-line loop is the natural seam should a yield ever need to come back).
 *
 * Fix materialization is the only place a {@link FixSpec} becomes an LSP range. A `replace` names
 * one PIECE (contiguous source by construction, so a fix can never overwrite elided markup). A
 * `compose` names the offset of one combining 濁点/半濁点; the engine reads the pair from the
 * document and composes it. An insert names a prose UNIT and a side (zero-width; the offset is
 * resolved through the piece's outer extents, past a ruby's reading or a closing annotation, and
 * never eats a newline). An `erase` covers whole blank lines and is checked to hold nothing but
 * line terminators. Out-of-piece arithmetic, a compose that composes nothing, an insert on a
 * synthetic unit, or an erase over content is a programming error and throws.
 *
 * A `raw` rule can restate a prose rule's finding over the same characters (an unencodable
 * character that is ALSO decomposed, invisible, …). The prose rule is the more specific one and
 * often carries a fix, so it keeps that range — same-range raw findings are dropped.
 *
 * Relative imports only (native test loader). The vscode-free invariant holds: nothing here
 * imports `vscode`; `selection` arrives as plain data from `select.ts`.
 */
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import type { Diagnostic, Range } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import { composeKana } from '../../shared/chars.ts';
import { isSelectionEmpty } from '../../shared/lint/select.ts';
import type { ActiveRule, RuleSelection } from '../../shared/lint/select.ts';
import type { LocalizableMessage } from '../../shared/protocol.ts';

import { diagnostic } from '../diagnostics.ts';
import { RULE_IMPL } from './modules.ts';
import type { PreScan } from './prescan.ts';
import type { FixSpec, LineRule, ProseUnit, SrcSpan } from './types.ts';
import { walkLines } from './walker.ts';

/** A single auto-fix edit, already mapped to SOURCE coordinates. */
export interface LintFix {
  readonly range: Range;
  readonly newText: string;
}

/** One lint result: the diagnostic to publish, plus its fix when the rule is auto-fixable. */
export interface LintFinding {
  readonly diagnostic: Diagnostic;
  readonly fix?: LintFix;
}

const WARNING = DiagnosticSeverity.Warning;

/** Pair a diagnostic with an optional fix, omitting `fix` entirely when absent (exactOptional…). */
function finding(diag: Diagnostic, fix: LintFix | undefined): LintFinding {
  return fix !== undefined ? { diagnostic: diag, fix } : { diagnostic: diag };
}

/** A range as a comparable key: two findings over the same characters are the same defect. */
function rangeKey(r: Range): string {
  return [r.start.line, r.start.character, r.end.line, r.end.character].join(':');
}

/** The source offset an insert anchored on `unit` resolves to: inside a piece the neighbour is
 *  source-adjacent; at an edge the piece's outer extent skips the markup wrapping it. */
function insertOffset(unit: ProseUnit, side: 'before' | 'after'): number {
  const piece = unit.piece;
  if (piece === null) {
    throw new Error(`lint fix anchors an insert on a synthetic unit at ${String(unit.src)}`);
  }
  if (side === 'before') {
    return unit.indexInPiece > 0 ? unit.src : piece.outerStart;
  }
  return unit.indexInPiece + 1 < piece.text.length ? unit.src + 1 : piece.outerEnd;
}

/** Materializes a {@link FixSpec} into source coordinates (see the module header for why the four
 *  shapes are the only safe ones). */
function materializeFix(spec: FixSpec, doc: TextDocument): LintFix {
  if ('insert' in spec) {
    const pos = doc.positionAt(insertOffset(spec.insert, spec.side));
    return { range: { start: pos, end: pos }, newText: spec.text };
  }
  if ('erase' in spec) {
    const range = { start: doc.positionAt(spec.erase.start), end: doc.positionAt(spec.erase.end) };
    if (!/^[\r\n]*$/.test(doc.getText(range))) {
      throw new Error(`lint fix erases content: [${String(spec.erase.start)}, ${String(spec.erase.end)})`);
    }
    return { range, newText: '' };
  }
  if ('compose' in spec) {
    const at = spec.compose;
    if (at < 1) {
      throw new Error(`lint fix composes nothing at ${String(at)}`);
    }
    const range = { start: doc.positionAt(at - 1), end: doc.positionAt(at + 1) };
    const pair = doc.getText(range);
    const composed = composeKana(pair);
    if (pair.length !== 2 || composed.length !== 1) {
      throw new Error(`lint fix composes nothing at ${String(at)}`);
    }
    return { range, newText: composed };
  }
  const { piece, start, end } = spec.replace;
  if (start < 0 || end < start || end > piece.text.length) {
    throw new Error(`lint fix out of piece bounds: [${String(start)}, ${String(end)})`);
  }
  return {
    range: {
      start: doc.positionAt(piece.srcStart + start),
      end: doc.positionAt(piece.srcStart + end),
    },
    newText: spec.text,
  };
}

/**
 * Computes prose-lint findings for `text` under `selection` — synchronously; the all-off default
 * costs nothing (no walk, no scans).
 */
export function computeLintFindings(
  text: string,
  selection: RuleSelection,
  doc: TextDocument,
): LintFinding[] {
  if (isSelectionEmpty(selection)) {
    return [];
  }
  const prose: LintFinding[] = [];
  const instances: LineRule[] = [];
  const rawRules: { readonly rule: ActiveRule; readonly scan: PreScan }[] = [];
  for (const rule of selection) {
    const impl = RULE_IMPL[rule.id];
    if (impl.kind === 'raw') {
      rawRules.push({ rule, scan: impl.scan });
      continue;
    }
    instances.push(
      impl.create({
        options: rule.options,
        report(span: SrcSpan, extra?: { message?: LocalizableMessage; fix?: FixSpec }): void {
          const range = { start: doc.positionAt(span.start), end: doc.positionAt(span.end) };
          const message = extra?.message ?? { code: rule.code };
          const fix = extra?.fix === undefined ? undefined : materializeFix(extra.fix, doc);
          prose.push(finding(diagnostic(range, message, WARNING), fix));
        },
      }),
    );
  }

  if (instances.length > 0) {
    for (const line of walkLines(text)) {
      for (const instance of instances) {
        instance.line(line);
      }
    }
    for (const instance of instances) {
      instance.end?.();
    }
  }

  const taken = new Set(prose.map((f) => rangeKey(f.diagnostic.range)));
  const raw: LintFinding[] = [];
  for (const { rule, scan } of rawRules) {
    for (const span of scan(text, rule.options)) {
      const range = { start: doc.positionAt(span.start), end: doc.positionAt(span.end) };
      if (taken.has(rangeKey(range))) {
        continue;
      }
      raw.push(finding(diagnostic(range, span.message ?? { code: rule.code }, WARNING), undefined));
    }
  }
  return [...raw, ...prose];
}
