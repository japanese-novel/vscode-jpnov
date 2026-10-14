/**
 * The generated grammar colours what the semantic tokens colour: over the corpus, each line gets
 * the same runs of colour from the grammar, run through vscode-textmate over Oniguruma as VS Code
 * runs it, and from buildSemanticTokens. The grammar keeps no state, so the known differences stay out of the
 * corpus: a 《reading》 with no base (the scanner reports it, and the corpus drops such a line)
 * and the dialogue corners outside an annotation, which it greys and the semantic layer leaves
 * as text — over-paint the semantic layer cannot undo, accepted for these two. A ｜ it greys only where the scanner makes it a ruby mark, by looking ahead on the
 * line; where it cannot know (a 縦中横 annotation inside the base: an edge or not depending on
 * what came before) it leaves the ｜ default, since the semantic layer can add a colour over the
 * grammar's but never take one away.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Both ship one bundled CommonJS file whose named exports Node cannot detect: the default import is the module.
import onig from 'vscode-oniguruma';
import vsctm from 'vscode-textmate';
import type { IGrammar } from 'vscode-textmate';

import { generateGrammar } from '../../../scripts/gen-grammar.ts';
import { SEMANTIC_LEGEND } from '../../../src/server/semanticTokens.ts';
import {
  BLOCK_FROM,
  BLOCK_TO,
  CONNECTOR_HA,
  CONNECTOR_NI,
  EMPHASIS_VARIANTS,
  GAIJI,
  HEADING_LITERALS,
  INDENT,
  INDENT_MAX,
  LEFT_LONG,
  LEFT_RUBY,
  LEFT_SHORT,
  PAGE_BREAK,
  SPAN_END,
  TCY,
  VALUE_NAMES,
  annotation,
  indentAnnotation,
  valueAnnotation,
} from '../../../src/shared/ast/notation.ts';
import { scan } from '../../../src/shared/ast/scan.ts';
import { blockOf, gaijiOf, innerOf, nodesOf } from '../../shared/ast/_shape.ts';
import { inLinearTime } from '../../shared/_timing.ts';

import { buildSemanticTokens, decode, doc } from './tokens.ts';

/** A run of one colour: its text and the LSP token type, null for the default colour. */
type Run = [text: string, colour: string | null];

/** The generated grammar loaded as VS Code loads it: vscode-textmate over the Oniguruma it ships. */
async function loadGrammar(): Promise<IGrammar> {
  await onig.loadWASM(await readFile(fileURLToPath(import.meta.resolve('vscode-oniguruma/release/onig.wasm'))));
  const raw = generateGrammar();
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (sources) => new onig.OnigScanner(sources), createOnigString: (str) => new onig.OnigString(str) }),
    loadGrammar: () => Promise.resolve(vsctm.parseRawGrammar(JSON.stringify(raw), 'jpnov.tmLanguage.json')),
  });
  const grammar = await registry.loadGrammar(raw.scopeName);
  assert.ok(grammar, 'the grammar loads');
  return grammar;
}

const grammar = await loadGrammar();

/** `runs` with the empty ones dropped and the neighbours of one colour joined. */
function joined(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const [text, colour] of runs) {
    const last = out[out.length - 1];
    if (text === '') {
      continue;
    }
    if (last?.[1] === colour) {
      last[0] += text;
    } else {
      out.push([text, colour]);
    }
  }
  return out;
}

/** What the grammar paints: the innermost scope of each token; the root scope alone is the default colour. */
function painted(line: string): Run[] {
  const runs: Run[] = [];
  for (const token of grammar.tokenizeLine(line, vsctm.INITIAL).tokens) {
    const scope = token.scopes.length > 1 ? token.scopes[token.scopes.length - 1] : undefined;
    const colour = scope === undefined ? null : (scope.split('.')[0] ?? null);
    runs.push([line.slice(token.startIndex, token.endIndex), colour]);
  }
  return joined(runs);
}

/** What the semantic tokens paint, the gaps between tokens in the default colour. */
function tokens(line: string): Run[] {
  const runs: Run[] = [];
  let pos = 0;
  for (const tok of decode(buildSemanticTokens(doc(line), undefined).data)) {
    runs.push([line.slice(pos, tok.char), null], [line.slice(tok.char, tok.char + tok.len), SEMANTIC_LEGEND.tokenTypes[tok.type] ?? null]);
    pos = tok.char + tok.len;
  }
  runs.push([line.slice(pos), null]);
  return joined(runs);
}

const postfix = (rest: string): string => annotation(`「対象」${rest}`);

/** Every command word in every form, read or not: each with each left side and each connector. */
function forms(): string[] {
  const out: string[] = [];
  const words = [...Object.keys(EMPHASIS_VARIANTS), ...HEADING_LITERALS, TCY, INDENT, PAGE_BREAK, innerOf(indentAnnotation(3)), 'ママ'];
  for (const word of words) {
    for (const left of ['', LEFT_SHORT, LEFT_LONG]) {
      out.push(annotation(`${left}${word}`), annotation(`${left}${word}${SPAN_END}`), annotation(`${BLOCK_FROM}${left}${word}`), annotation(`${BLOCK_TO}${left}${word}${SPAN_END}`));
      for (const connector of ['', CONNECTOR_NI, CONNECTOR_HA, 'の', CONNECTOR_NI + LEFT_LONG]) {
        out.push(postfix(`${connector}${left}${word}`));
      }
    }
  }
  return out;
}

/** 字下げ counts around the maximum, with leading zeros, and the spellings that are not read. */
function indents(): string[] {
  const out: string[] = [];
  for (let n = 0; n <= INDENT_MAX + 20; n += 1) {
    for (const zeros of ['', '０', '０００']) {
      const single = annotation(`${zeros}${innerOf(indentAnnotation(n))}`);
      out.push(single, blockOf(single));
    }
  }
  out.push(annotation(`${'０'.repeat(400)}${INDENT}`), annotation(`${'９'.repeat(400)}${INDENT}`), annotation(`3${INDENT}`), blockOf(annotation(`${innerOf(indentAnnotation(3))}、折り返して${innerOf(indentAnnotation(2))}`)));
  return out;
}

const EDGES: readonly string[] = [
  ...Object.values(VALUE_NAMES).map(valueAnnotation),
  valueAnnotation('作品名'),
  valueAnnotation(''),
  valueAnnotation('a」b'),
  postfix(`${LEFT_LONG}「よみ」${LEFT_RUBY}`),
  postfix(`${LEFT_LONG}「」${LEFT_RUBY}`),
  postfix(`${LEFT_LONG}「よ「み」${LEFT_RUBY}`),
  postfix(`${LEFT_LONG}「よ」み」${LEFT_RUBY}`),
  postfix(LEFT_RUBY),
  postfix(`${CONNECTOR_NI}「よみ」${LEFT_RUBY}`),
  annotation(`「」${CONNECTOR_NI}傍点`),
  annotation(`「対「象」${CONNECTOR_NI}傍点`),
  annotation(`${PAGE_BREAK}${SPAN_END}`),
  annotation(`${BLOCK_FROM}${PAGE_BREAK}`),
  annotation(''),
  ...Object.entries(GAIJI).flatMap(([inner, char]) => [gaijiOf(char), annotation(inner)]),
  `※${annotation('外字、1-1-1')}`,
];

const UNCLOSED: readonly string[] = ['［＃', '［＃改ページ', `［＃${innerOf(postfix('に傍点'))}`, '本文［＃３字下げ', '［＃改ページ］［＃'];

const RUBY_LINES: readonly string[] = [
  '山《［＃改ページ］》', '山《a《b》', '｜山田《やまだ》', '山田《やまだ》', '｜山田［＃「山田」に傍点］《やまだ》',
  // A ｜ that is text: no reading on its line, a later ｜ (the last wins), an empty 《》, an unclosed
  // ［＃ in between, a 《 that never closes. A ｜ that is a mark: a 《 or a lone ［ inside the base, a
  // value field or a ※ as the only visible thing before the 《.
  'これは｜です', '｜a［＃x］｜b《r》', '｜a［＃x］《》b', '｜山田［＃こわれ《やまだ》', '｜山田《やまだ',
  '｜山田《やま《だ》', '｜山田》《やまだ》', '｜［山田《やまだ》', `｜${valueAnnotation(VALUE_NAMES.title)}《たいとる》`, '｜※《よみ》',
  // Inside a 縦中横 the ｜ and the 《reading》 are markup still (the resolver drops them).
  '［＃縦中横］｜山田《やまだ》［＃縦中横終わり］',
];

/** True where the grammar cannot decide a ｜: a 縦中横 annotation sits inside its base. */
function blind(line: string): boolean {
  let inBase = false;
  for (const node of nodesOf(line)) {
    if (node.kind === 'rubyMark') {
      inBase = true;
    } else if (node.kind === 'rubyReading') {
      inBase = false;
    } else if (inBase && (node.kind === 'tcySpanStart' || node.kind === 'tcySpanEnd')) {
      return true;
    }
  }
  return false;
}

/** Each annotation alone, inside prose and inside an explicit ruby base, less the lines whose reading lost its base. */
const lines: readonly string[] = [
  ...[...forms(), ...indents(), ...EDGES].flatMap((a) => [a, `本文${a}本文`, `｜山田${a}《やまだ》`]),
  ...UNCLOSED,
  ...RUBY_LINES,
].filter((line) => !scan(line).issues.some((issue) => issue.kind === 'rubyBaseMissing'));
const corpus = lines.filter((line) => !blind(line));
const blindLines = lines.filter(blind);

/** The colour of each character of `line` under `runs`. */
function perChar(line: string, runs: readonly Run[]): (string | null)[] {
  const out = runs.flatMap(([text, colour]) => Array.from({ length: text.length }, () => colour));
  assert.equal(out.length, line.length, line);
  return out;
}

test('the grammar paints every line of the corpus as the semantic tokens do', () => {
  assert.ok(corpus.length > 1000, `corpus of ${String(corpus.length)} lines`);
  for (const line of corpus) {
    assert.deepEqual(painted(line), tokens(line), line);
  }
});

test('the lookahead of a ｜ costs the line once, however long the base it reads and however many ｜ it meets', () => {
  // The one shape that grows with the square of the line, `｜a［＃` repeated, is the annotation
  // rules' own (an unclosed ［＃ is read to the line end at every ｜); the lookahead doubles it,
  // and VS Code stops colouring lines past 20k characters.
  for (const [name, line] of [
    ['one ｜, a 200k base, no 《', `｜${'あ'.repeat(200_000)}`],
    ['100k ｜ each with a base, one 《 that never closes', `${'｜あ'.repeat(100_000)}《`],
    ['1k ｜ in a row, a 200k base, a reading', `${'｜'.repeat(1000)}${'あ'.repeat(200_000)}《よみ》`],
    ['one ｜ holding 50k annotations, a reading', `｜あ${'［＃x］'.repeat(50_000)}《よみ》`],
  ] as const) {
    assert.ok(inLinearTime(name, () => painted(line)).length > 0, name);
  }
});

test('where the grammar cannot decide a ｜ it paints no more than the semantic tokens do', () => {
  assert.ok(blindLines.length > 0);
  for (const line of blindLines) {
    const grammar = perChar(line, painted(line));
    const semantic = perChar(line, tokens(line));
    for (const [i, colour] of grammar.entries()) {
      assert.ok(colour === null || colour === semantic[i], `${line} at ${String(i)}: ${String(colour)} vs ${String(semantic[i])}`);
    }
  }
});
