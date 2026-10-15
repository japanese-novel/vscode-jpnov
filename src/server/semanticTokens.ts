/**
 * Unified highlighter: one semantic-token stream colours BOTH Aozora markup and the author's
 * narration (cast names + coined keywords) from the Scanner's nodes plus the recognizer
 * over the reconstructed body-text runs. A ruby BASE is body text and flows into its run (only the
 * ｜《》 markers and the reading are holes), so okurigana-split ruby (立《た》ち) still recognises.
 *
 * Dialogue 「」『』 is tracked by the STACK of dialogue.ts (shared with the lint walker) as body
 * text is appended — NEVER by scanning the raw source: ［＃「対象」に傍点］ reuses 「」 as an
 * emphasis-target delimiter, which a raw scan would miscount. The stack lives at document scope
 * (Aozora dialogue may span lines); dialogue content is masked from the recognizer.
 *
 * Colouring is driven by TWO tables: {@link HIGHLIGHTS} (the DISTINCT lsp values form the legend
 * and the protocol indices derive from it — reference kinds by name via {@link tokenTypeIndex},
 * never a hard-coded index) and {@link PART_HIGHLIGHT} (what each part of an annotation reads as).
 */
import type { SemanticTokens, SemanticTokensLegend } from 'vscode-languageserver/node';
import { SemanticTokensBuilder } from 'vscode-languageserver/node';

import type { PartRole, RolePart, Syntax, SyntaxNode } from '../shared/ast/nodes.ts';

import { DialogueStack } from './dialogue.ts';
import type { Recognizer } from './highlight/recognizer.ts';

/**
 * Single source of truth. Each row = one highlight kind and the LSP token type a theme colours it
 * as. Several kinds may share one lsp (marker and direction both read as comment); the legend is the
 * DISTINCT lsp set and kind→index maps through it, so those kinds collapse onto one colour by design.
 * Add a row to introduce a new highlight — nothing else changes.
 *
 * The recognizer's span kinds ('character' / 'keyword') ARE rows here, so its output flows in with no
 * remapping; removing either row would make that assignment fail to type-check.
 */
const HIGHLIGHTS = [
  { kind: 'marker', lsp: 'comment' }, // ｜ 《 》 ［＃ ］ + ここから・ここで・終わり scaffolding + 「」『』 dialogue delimiters (greyed)
  { kind: 'directive', lsp: 'keyword' }, // style variant names / 改ページ / ○字下げ (command word only; ここから・ここで・終わり demote to marker)
  { kind: 'direction', lsp: 'comment' }, // の?左に
  { kind: 'character', lsp: 'variable' }, // a cast member recognised as a narration subject (prominent)
  { kind: 'keyword', lsp: 'operator' }, // a coined keyword — bold, default colour
] as const;

export type TokenType = (typeof HIGHLIGHTS)[number]['kind'];

/** Distinct LSP token types, first-seen order — the legend the client receives. */
const LSP_TYPES = [...new Set(HIGHLIGHTS.map((h) => h.lsp))];

export const SEMANTIC_LEGEND: SemanticTokensLegend = {
  tokenTypes: LSP_TYPES,
  tokenModifiers: [],
};

/** Highlight kind -> its index in the deduped legend, via its lsp (many kinds may share one). */
const TYPE_INDEX = new Map<TokenType, number>(
  HIGHLIGHTS.map((h) => [h.kind, LSP_TYPES.indexOf(h.lsp)]),
);

/**
 * The legend index for a highlight kind. Multiple kinds may share an index (kinds mapping to the
 * same lsp are coloured identically); reference a kind by name through this — never a hard-coded
 * number — so reordering or adding {@link HIGHLIGHTS} rows cannot silently break them.
 */
export function tokenTypeIndex(kind: TokenType): number {
  return TYPE_INDEX.get(kind) ?? -1;
}

/**
 * What each part of an annotation reads as. The command word is the directive; the brackets, the
 * scaffolding around it and a reading grey out; a 対象文字列 keeps the default colour.
 */
const PART_HIGHLIGHT: Record<PartRole, TokenType | null> = {
  bracket: 'marker',
  scaffold: 'marker',
  connector: 'marker',
  corner: 'marker',
  direction: 'direction',
  keyword: 'directive',
  name: 'directive',
  target: null,
  reading: 'marker',
  inner: 'marker',
};

/** The highlight a part of `role` is coloured as; null for one that keeps the default colour. */
export function partHighlight(role: PartRole): (typeof HIGHLIGHTS)[number] | null {
  const kind = PART_HIGHLIGHT[role];
  return HIGHLIGHTS.find((h) => h.kind === kind) ?? null;
}

/**
 * Runs of adjacent parts that are ONE token: a quoted reading with its corners, a reading with
 * its opening 《, and the value display's ここに「 … 」の値を表示 scaffolding.
 */
const JOINED: Partial<Record<SyntaxNode['kind'], readonly (readonly PartRole[])[]>> = {
  rubyReading: [['bracket', 'reading']],
  rubyLeftPostfix: [['corner', 'reading', 'corner']],
  valueField: [['scaffold', 'corner'], ['corner', 'scaffold']],
};

interface TokenSpan {
  readonly start: number; // source UTF-16 offset
  readonly len: number;
  readonly type: TokenType;
}

/** A range `[from, to)` of the run. */
interface RunRange {
  readonly from: number;
  to: number;
}

/** A stretch of the run that is contiguous in the source, where it starts at `src`. */
interface Stretch extends RunRange {
  readonly src: number;
}

/** How many parts from `at` on form one joined token of `kind`; 1 when none does. */
function joinedAt(kind: SyntaxNode['kind'], parts: readonly RolePart[], at: number): number {
  for (const roles of JOINED[kind] ?? []) {
    if (roles.every((role, k) => parts[at + k]?.role === role)) {
      return roles.length;
    }
  }
  return 1;
}

/** Index of the first of `ranges` (ascending, disjoint) ending past `at`. */
function firstPast(ranges: readonly RunRange[], at: number): number {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((ranges[mid]?.to ?? 0) <= at) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export function buildSemanticTokens(syntax: Syntax, recognizer: Recognizer | undefined): SemanticTokens {
  const builder = new SemanticTokensBuilder();

  // The tokens of the line being read: no token crosses a line.
  let spans: TokenSpan[] = [];

  // The body-text run a recognizer reads: its text, the source stretches it was joined from (a
  // ruby's markers and reading are holes), and its ranges inside dialogue, which are not coloured.
  let runText = '';
  let stretches: Stretch[] = [];
  let spoken: RunRange[] = [];
  let spokenFrom = -1; // where the open dialogue range starts in the run; -1 in narration

  // Document-scoped so it persists across run flushes (a 「…」 may span lines); driven ONLY from
  // body text in appendBody (never from raw src — see file header).
  const dialogue = new DialogueStack();

  const mark = (start: number, len: number, type: TokenType): void => {
    if (len > 0) {
      spans.push({ start, len, type });
    }
  };

  const flushRun = (): void => {
    if (recognizer === undefined) {
      return;
    }
    if (runText !== '') {
      if (spokenFrom !== -1) {
        spoken.push({ from: spokenFrom, to: runText.length });
      }
      for (const sp of recognizer.recognize(runText)) {
        const inside = spoken[firstPast(spoken, sp.start)];
        if (inside !== undefined && inside.from <= sp.start) {
          continue; // inside dialogue — body text keeps its default colour
        }
        // One token per stretch that is contiguous in the SOURCE (a hole appears where a ruby
        // reading/markers sat between a base and its okurigana).
        const end = sp.start + sp.len;
        for (let k = firstPast(stretches, sp.start); k < stretches.length; k += 1) {
          const stretch = stretches[k];
          if (stretch === undefined || stretch.from >= end) {
            break;
          }
          const from = Math.max(sp.start, stretch.from);
          spans.push({ start: stretch.src + (from - stretch.from), len: Math.min(end, stretch.to) - from, type: sp.kind });
        }
      }
    }
    runText = '';
    stretches = [];
    spoken = [];
    spokenFrom = dialogue.depth > 0 ? 0 : -1;
  };

  /** Append body text [srcStart, …) to the current run, tracking dialogue. */
  const appendBody = (text: string, srcStart: number): void => {
    const base = runText.length;
    for (const seg of dialogue.feed(text)) {
      if (seg.kind === 'prose') {
        continue; // prose, a mismatched closer included, keeps its default colour
      }
      mark(srcStart + seg.from, 1, 'marker'); // 「 『 and a matching 」 』
      if (seg.depth > 0) {
        continue; // nested: the outer utterance's range is what masks
      }
      if (seg.kind === 'open') {
        spokenFrom = base + seg.from; // the opening corner is inside
      } else {
        if (recognizer !== undefined) {
          spoken.push({ from: spokenFrom, to: base + seg.from }); // the closing corner is outside
        }
        spokenFrom = -1;
      }
    }
    if (recognizer === undefined) {
      return; // nothing reads the run
    }
    const last = stretches[stretches.length - 1];
    if (last !== undefined && last.src + (last.to - last.from) === srcStart) {
      last.to += text.length;
    } else {
      stretches.push({ from: base, to: base + text.length, src: srcStart });
    }
    runText += text;
  };

  /** One token per part — or per joined run of parts — of an annotation. */
  const markParts = (node: SyntaxNode, parts: readonly RolePart[]): void => {
    for (let at = 0; at < parts.length;) {
      const first = parts[at];
      const n = joinedAt(node.kind, parts, at);
      const last = parts[at + n - 1];
      at += n;
      const type = first === undefined ? null : PART_HIGHLIGHT[first.role];
      if (first !== undefined && last !== undefined && type !== null) {
        mark(first.span.start, last.span.end - first.span.start, type);
      }
    }
  };

  for (const line of syntax.lines) {
    for (const node of line.syntax) {
      switch (node.kind) {
        case 'text':
          appendBody(node.text, node.span.start); // a ruby base too: it flows into the recognized run
          break;
        case 'rubyMark':
          mark(node.span.start, node.text.length, 'marker'); // the base nodes follow as themselves
          break;
        case 'rubyReading':
          markParts(node, node.parts);
          break;
        case 'comment':
        case 'brokenAnnotation':
          // Greyed whole. The text never enters appendBody, so a swallowed 「 cannot corrupt the
          // dialogue stack.
          flushRun();
          mark(node.span.start, node.text.length, 'marker');
          break;
        default:
          flushRun();
          markParts(node, node.parts);
          break;
      }
    }
    flushRun(); // the line break itself is not body

    // Emit in source order (markup + recognized spans interleave), at the line's own position.
    spans.sort((a, b) => a.start - b.start);
    for (const span of spans) {
      builder.push(line.index, span.start - line.span.start, span.len, tokenTypeIndex(span.type), 0);
    }
    spans = [];
  }
  return builder.build();
}
