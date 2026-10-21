/**
 * The process-wide server context. Per-root CONFIG state deliberately does NOT live here:
 * `projectDirs` rides each build/listBooks request, and the vocabulary store keys on the
 * pages the books list.
 *
 * vscode-free: only `import type` of the language-server types is used; the runtime
 * `Connection` is injected by server.ts.
 */
import type { CancellationToken, Connection } from 'vscode-languageserver/node';

import type { RuleSelection } from '#/shared/lint/select.ts';
import type { ReadTextResult } from '#/shared/protocol.ts';

import type { HighlightStore } from './highlight/vocabulary.ts';

/** Text of one `file:` URI as the client decodes it (`jpnov/readText`); tests inject a Node reader. */
export type ReadText = (uri: string, token?: CancellationToken) => Promise<ReadTextResult>;

/**
 * Mutable, process-wide server state threaded through every server module. It is a
 * single object shared by reference, so writes (e.g. a lint-selection swap) are
 * visible everywhere.
 */
export interface ServerContext {
  readonly connection: Connection;
  /** The only way server code obtains manuscript text: the client answers with the text the editor shows. */
  readonly readText: ReadText;
  /** Enabled prose-lint rules, resolved from the client's `jpnov.lint.*` settings snapshot. Workspace-
   *  (not root-) scoped, so it lives on the context rather than per root. */
  lintSelection: RuleSelection;
  /** Narration vocabulary: the `characters:`/`keywords:` and the pages of the books each `jpnov/listBooks` found. */
  readonly highlight: HighlightStore;
}
