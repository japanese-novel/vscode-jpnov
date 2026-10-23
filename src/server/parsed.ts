/**
 * The parse of each open manuscript, kept per (uri, version): the highlighter, the syntax
 * diagnostics, the prose lint, the annotation features and the preview of one edit share one
 * scan and one resolve, and the highlighter and the lint one reading of the lines as shown
 * (shown.ts). This is the editor's compile: no values.
 */
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { Ast, Syntax } from '../shared/ast/nodes.ts';
import { resolve } from '../shared/ast/resolve.ts';
import { scan } from '../shared/ast/scan.ts';

import { shownLines } from './shown.ts';
import type { ShownLine } from './shown.ts';

export interface ParseCache {
  /** The syntax layer of `doc` at its current version. */
  syntaxOf(doc: TextDocument): Syntax;
  /** The resolved manuscript of `doc` at its current version. */
  astOf(doc: TextDocument): Ast;
  /** The lines of `doc` as shown, with their dialogue, at its current version. */
  shownOf(doc: TextDocument): readonly ShownLine[];
  /** Forgets a closed document. */
  drop(uri: string): void;
}

interface Entry {
  readonly version: number;
  readonly syntax: Syntax;
  ast?: Ast;
  shown?: readonly ShownLine[];
}

export function createParseCache(): ParseCache {
  // Keyed by uri and checked by version: the document manager updates one object in place.
  const entries = new Map<string, Entry>();
  const entryOf = (doc: TextDocument): Entry => {
    const hit = entries.get(doc.uri);
    if (hit?.version === doc.version) {
      return hit;
    }
    const fresh: Entry = { version: doc.version, syntax: scan(doc.getText()) };
    entries.set(doc.uri, fresh);
    return fresh;
  };
  const astOf = (entry: Entry): Ast => (entry.ast ??= resolve(entry.syntax));
  return {
    syntaxOf: (doc) => entryOf(doc).syntax,
    astOf: (doc) => astOf(entryOf(doc)),
    shownOf(doc) {
      const entry = entryOf(doc);
      return (entry.shown ??= shownLines(astOf(entry)));
    },
    drop(uri) {
      entries.delete(uri);
    },
  };
}
