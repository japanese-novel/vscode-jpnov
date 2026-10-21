/**
 * Shared scaffolding for the highlight semantic-token tests: build a jpnov document, decode the
 * LSP delta-encoded token stream into absolute tuples, and query it by position. (Not a `*.test.ts`
 * file, so the runner imports it as a helper rather than executing it.)
 */
import type { SemanticTokens } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import type { Recognizer } from '../../../src/server/highlight/recognizer.ts';
import { buildSemanticTokens as tokensOf } from '../../../src/server/semanticTokens.ts';
import { parse } from '../../../src/shared/ast/parse.ts';
import { nameSurfaces, readName } from '../../../src/shared/book/names.ts';

/** The surfaces a recognizer gets for these listed names (as the vocabulary store expands them). */
export function cast(...names: readonly string[]): string[] {
  return names.flatMap((text) => {
    const read = readName(text);
    return read.ok ? nameSurfaces(read.name) : [];
  });
}

export interface Tok {
  line: number;
  char: number;
  len: number;
  type: number;
}

export const doc = (text: string): TextDocument =>
  TextDocument.create('file:///t.txt', 'jpnov', 1, text);

/** The semantic tokens of `document`, from the parse of its text. */
export const buildSemanticTokens = (document: TextDocument, recognizer: Recognizer | undefined): SemanticTokens =>
  tokensOf(parse(document.getText()), recognizer);

/** Decode the LSP delta-encoded token array into absolute tuples. */
export function decode(data: readonly number[]): Tok[] {
  const out: Tok[] = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const dl = data[i] ?? 0;
    const dc = data[i + 1] ?? 0;
    line += dl;
    char = dl === 0 ? char + dc : dc;
    out.push({ line, char, len: data[i + 2] ?? 0, type: data[i + 3] ?? 0 });
  }
  return out;
}

/** The token starting exactly at (line, char), if any. */
export const at = (toks: Tok[], line: number, char: number): Tok | undefined =>
  toks.find((t) => t.line === line && t.char === char);

/** Whether any token of `type` covers code unit `char` on line 0. */
export const covers = (toks: Tok[], char: number, type: number): boolean =>
  toks.some((t) => t.line === 0 && t.char <= char && t.char + t.len > char && t.type === type);
