/**
 * The process-wide server context. Per-root CONFIG state deliberately does NOT live here:
 * `projectDirs` rides each build/listBooks request, and the vocabulary store carries its
 * own root keys.
 *
 * vscode-free: only `import type` of the language-server types is used; the runtime
 * `Connection` is injected by server.ts.
 */
import type { CancellationToken, Connection } from 'vscode-languageserver/node';

import type { RuleSelection } from '#/shared/lint/select.ts';
import type { ReadTextResult } from '#/shared/protocol.ts';

import type { HighlightStore } from './highlight/vocabulary.ts';
import type { WorkspaceRoots } from './roots.ts';

/** Text of one `file:` URI as the client decodes it (`jpnov/readText`); tests inject a Node reader. */
export type ReadText = (uri: string, token?: CancellationToken) => Promise<ReadTextResult>;

/**
 * Mutable, process-wide server state threaded through every server module. It is a
 * single object shared by reference, so writes (e.g. a lint-selection swap) are
 * visible everywhere.
 */
export interface ServerContext {
  readonly connection: Connection;
  /** The only way server code obtains manuscript text: the client reads the disk and decodes as the editor would. */
  readonly readText: ReadText;
  /** Enabled prose-lint rules, resolved from the client's `jpnov.lint.*` settings snapshot. Workspace-
   *  (not root-) scoped, so it lives on the context rather than per root. */
  lintSelection: RuleSelection;
  /** Per-root narration vocabulary (characters/keywords), fed by the client's `jpnov.editor.highlight.*` pushes. */
  readonly highlight: HighlightStore;
  /** Workspace folders (standard LSP), for root-relative `.jpbook` entry resolution. */
  readonly roots: WorkspaceRoots;
}
