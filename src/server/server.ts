/**
 * Japanese Novel language server (forked Node process, IPC). MUST stay vscode-free — there is
 * no `vscode` module in the forked process; a value-import would crash it. Only
 * `import type` of vscode is permitted (and eslint enforces this for src/server/**).
 *
 * Responsibilities wired here:
 * - `initialize`: seed the lint selection + per-root vocabulary from
 *   `initializationOptions`, reply the negotiated capabilities.
 * - `jpnov/build`, `jpnov/listBooks`, `jpnov/renderFile` request handlers (per-root state
 *   rides each request's `projectDirs`; the vocabulary rides `jpnov/highlightChanged`).
 * - `jpnov/readText` (server -> client): the only request this side sends; manuscript and
 *   manifest text comes back decoded by the client.
 */
import {
  CodeActionKind,
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import type {
  CancellationToken,
  CodeAction,
  CodeActionParams,
  InitializeParams,
  InitializeResult,
  WorkDoneProgressReporter,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { renderPreview } from '#/shared/compiler/preview.ts';
import { resolvePreviewSettings } from '#/shared/config/settings.ts';
import { selectRules } from '#/shared/lint/select.ts';
import type { InitializationOptions } from '#/shared/protocol.ts';
import {
  BuildRequest,
  HighlightChangedNotification,
  LintConfigChangedNotification,
  ListBooksRequest,
  ReadTextRequest,
  RenderFileRequest,
} from '#/shared/protocol.ts';
import type {
  BuildParams,
  BuildResult,
  HighlightChangedParams,
  LintConfigChangedParams,
  ListBooksParams,
  ListBooksResult,
  ReadTextParams,
  ReadTextResult,
  RenderFileParams,
  RenderFileResult,
} from '#/shared/protocol.ts';

import { handleBuild, handleListBooks } from './build.ts';
import { buildCodeActions } from './lint/codeActions.ts';
import { computeLintFindings } from './lint/engine.ts';
import type { LintFinding } from './lint/engine.ts';
import { reportError } from './report.ts';
import { createWorkspaceRoots } from './roots.ts';
import type { ServerContext } from './context.ts';
import { createHighlightStore, handleHighlightChanged } from './highlight/vocabulary.ts';
import { buildSemanticTokens, SEMANTIC_LEGEND } from './semanticTokens.ts';
import { annotationDiagnostics } from './syntax.ts';
import { completeJpbook, diagnoseJpbook, documentLinksForJpbook } from './jpbook.ts';
import { parseJpbook } from '#/shared/book/jpbook.ts';

const connection = createConnection(ProposedFeatures.all);

/** A reply outside the wire shape is a read failure, never a crash. */
function isReadTextResult(value: unknown): value is ReadTextResult {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean';
}

/**
 * One `jpnov/readText` round trip per file, cancelled with the build. An absent token stays out of
 * the call: vscode-jsonrpc takes a trailing `undefined` as a second positional param.
 */
async function readTextOverWire(uri: string, token?: CancellationToken): Promise<ReadTextResult> {
  const params: ReadTextParams = { uri };
  const reply: unknown = token === undefined
    ? await connection.sendRequest(ReadTextRequest, params)
    : await connection.sendRequest(ReadTextRequest, params, token);
  return isReadTextResult(reply) ? reply : { ok: false, reason: 'other', why: 'the client did not answer jpnov/readText' };
}

const context: ServerContext = {
  connection,
  readText: readTextOverWire,
  lintSelection: selectRules({}), // all rules off until the client's snapshot arrives at initialize
  highlight: createHighlightStore(), // empty until the client's snapshot arrives at initialize
  roots: createWorkspaceRoots(), // seeded at initialize; live via workspace/didChangeWorkspaceFolders
};

// Open-document tracker (so semantic-tokens requests have document text to highlight).
const documents = new TextDocuments(TextDocument);
documents.listen(connection);

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const options = params.initializationOptions as InitializationOptions | undefined;
  context.lintSelection = selectRules(options?.lintConfig ?? {});
  // Vocabulary seed: no refresh here — the client is not `initialized` yet, and the first
  // semanticTokens request naturally lands after this.
  context.highlight.apply(options?.highlight);
  // Workspace-folder seed: `.jpbook` entries are root-relative, so the live features need
  // the folder list (change notifications are registered once `initialized`).
  context.roots.replace((params.workspaceFolders ?? []).map((f) => f.uri));

  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
      },
      workspace: {
        workspaceFolders: { supported: true, changeNotifications: true },
      },
      semanticTokensProvider: {
        legend: SEMANTIC_LEGEND,
        full: true,
      },
      // *.jpbook editor features (routed for `jpbook` via the document selector).
      // Trigger on "/" (descend a subdir) AND on every digit: VS Code's quick-suggest does not
      // auto-fire on a leading digit (it reads it as a number literal), so digit-led filenames
      // (e.g. 0001-chapter.jpnov) would otherwise need a manual Ctrl+Space.
      completionProvider: {
        triggerCharacters: ['/', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
      },
      documentLinkProvider: { resolveProvider: false },
      // Auto-fix for the fixable lint rules: per-diagnostic quick-fixes + a source.fixAll bundle
      // (the latter also enables fix-on-save via the user's editor.codeActionsOnSave).
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.SourceFixAll],
      },
      // No executeCommandProvider: this extension drives everything through custom requests.
    },
  };
});

// Workspace folders changed: update the root set the live `.jpbook` features resolve
// against, then refresh the open books (their entries may gain/lose an owning root).
connection.onInitialized(() => {
  // Event registration (a Disposable, intentionally kept for the process lifetime).
  connection.workspace.onDidChangeWorkspaceFolders((e) => {
    context.roots.change(e.added.map((f) => f.uri), e.removed.map((f) => f.uri));
    for (const doc of documents.all()) {
      if (doc.languageId === 'jpbook') {
        scheduleJpbookDiagnostics(doc);
      }
    }
  });
});

// Prose-lint settings changed (jpnov.lint.*): re-resolve the enabled-rule selection from the fresh
// snapshot and re-lint every open .jpnov so toggles take effect immediately. The findings cache is
// keyed by document VERSION, which a settings toggle does NOT bump — so clear it explicitly, or a
// code-action requested in the re-lint debounce window would be served from the stale selection.
connection.onNotification(
  LintConfigChangedNotification,
  (params: LintConfigChangedParams) => {
    context.lintSelection = selectRules(params.lintConfig);
    findingsCache.clear();
    revalidateOpenNovels();
  },
);

// Narration vocabulary changed (jpnov.editor.highlight.*): swap the per-root snapshot and refresh
// semantic tokens so open editors recolour immediately.
connection.onNotification(
  HighlightChangedNotification,
  (params: HighlightChangedParams) => {
    handleHighlightChanged(connection, context.highlight, params);
  },
);

// Build: every root in the request's projectDirs. Progress flows over $/progress via the
// request's work-done reporter (3rd handler arg), tied to the client's workDoneToken.
connection.onRequest(
  BuildRequest,
  (
    params: BuildParams,
    token: CancellationToken,
    workDone?: WorkDoneProgressReporter,
  ): Promise<BuildResult> => handleBuild(context, params, workDone, token),
);

// List books: enumerate every `.jpbook` of every root in the request's projectDirs map and read
// each one through the client for its title (no diagnostics); the wire may omit params, so accept
// the nullable form.
connection.onRequest(
  ListBooksRequest,
  (params: ListBooksParams | undefined): Promise<ListBooksResult> =>
    handleListBooks(context, params ?? { projectDirs: {} }),
);

// Preview: render one file's live buffer to a standalone HTML document. Strings only.
// charsPerLine, 禁則, and display chrome all ride the request's settings snapshot
// (re-resolved here — the wire payload is untrusted).
connection.onRequest(
  RenderFileRequest,
  (params: RenderFileParams): RenderFileResult => {
    const settings = resolvePreviewSettings(params.settings);
    return {
      html: renderPreview(params.text, { ...settings, chrome: settings }),
    };
  },
);

// Semantic tokens: Aozora markup + dialogue colouring (always), plus cast/keyword highlighting when
// the owning root declares any. Fully synchronous — markup and colours emit on the first request.
connection.languages.semanticTokens.on((params) => {
  const doc = documents.get(params.textDocument.uri);
  // Only jpnov documents are highlighted (book files share the selector but stay plain).
  if (doc?.languageId !== 'jpnov') {
    return { data: [] };
  }
  return buildSemanticTokens(doc, context.highlight.recognizerFor(params.textDocument.uri));
});

/** Returns line `n`'s text (no terminator); `position.character` indexes into this. */
function lineAt(doc: TextDocument, line: number): string {
  const text = doc.getText({
    start: { line, character: 0 },
    end: { line, character: Number.MAX_SAFE_INTEGER },
  });
  return text.replace(/\r$/, '');
}

// Autocompletion: metadata keys/values in the front matter, file paths on chapter lines —
// only for book files, delegated to the fs-backed resolver.
connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (doc?.languageId !== 'jpbook') {
    return [];
  }
  return completeJpbook(
    context.roots.rootOf(doc.uri),
    parseJpbook(doc.getText()),
    lineAt(doc, params.position.line),
    params.position,
  );
});

// Cmd+click targets: one link per valid chapter line pointing at the resolved file URI.
connection.onDocumentLinks((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (doc?.languageId !== 'jpbook') {
    return [];
  }
  return documentLinksForJpbook(context.roots.rootOf(doc.uri), parseJpbook(doc.getText()));
});

// Live per-line diagnostics for an open .jpbook (missing/escaping/duplicate paths, metadata
// problems). Debounced per URI and version-guarded so async fs existence checks never publish
// results for stale text.
const jpbookDebounce = new Map<string, ReturnType<typeof setTimeout>>();
const JPBOOK_DEBOUNCE_MS = 250;

function scheduleJpbookDiagnostics(doc: TextDocument): void {
  const uri = doc.uri;
  const scheduledVersion = doc.version;
  clearTimeout(jpbookDebounce.get(uri));
  jpbookDebounce.set(
    uri,
    setTimeout(() => {
      jpbookDebounce.delete(uri);
      const current = documents.get(uri);
      if (current?.languageId !== 'jpbook' || current.version !== scheduledVersion) {
        return;
      }
      void (async () => {
        try {
          const diagnostics = await diagnoseJpbook(context.roots.rootOf(uri), parseJpbook(current.getText()));
          // Re-check after the async fs work: a newer edit (with its own schedule) wins.
          if (documents.get(uri)?.version === scheduledVersion) {
            // LSP send: rejects only on a dead connection (nothing to recover) -> drop the promise.
            void connection.sendDiagnostics({ uri, diagnostics });
          }
        } catch (err) {
          reportError(context, err);
        }
      })();
    }, JPBOOK_DEBOUNCE_MS),
  );
}

// Live prose-lint Warnings for an open .jpnov. The engine (lint/engine.ts) is fully synchronous
// and O(n) in the document — one walker pass plus per-line scans — so a run always reflects the
// text it was scheduled for; only the debounce's own version guard is needed. The short debounce
// keeps typing snappy on long chapters.
const proseDebounce = new Map<string, ReturnType<typeof setTimeout>>();
const PROSE_DEBOUNCE_MS = 300;

// Last published findings per open .jpnov (uri -> {version, findings}); the code-action handler reuses
// them so it never re-lints when the cache is current. Kept in lockstep with what is published.
const findingsCache = new Map<string, { version: number; findings: LintFinding[] }>();

/** Cache the findings and publish their diagnostics (one place keeps cache and diagnostics aligned). */
function publishFindings(uri: string, version: number, findings: LintFinding[]): void {
  findingsCache.set(uri, { version, findings });
  // Syntax Errors (unclosed ［＃) ride the same single publish per URI. Re-derived from the live
  // document (same version as `findings` — the callers' version guards run synchronously before
  // this call) and kept OUT of findingsCache: they carry no fix, so code actions never see them.
  const doc = documents.get(uri);
  const syntax = doc === undefined ? [] : annotationDiagnostics(doc);
  void connection.sendDiagnostics({
    uri,
    diagnostics: [...syntax, ...findings.map((f) => f.diagnostic)],
  });
}

function scheduleProseDiagnostics(doc: TextDocument): void {
  const uri = doc.uri;
  const scheduledVersion = doc.version;
  clearTimeout(proseDebounce.get(uri));
  proseDebounce.set(
    uri,
    setTimeout(() => {
      proseDebounce.delete(uri);
      const current = documents.get(uri);
      if (current?.languageId !== 'jpnov' || current.version !== scheduledVersion) {
        return;
      }
      try {
        publishFindings(
          uri,
          scheduledVersion,
          computeLintFindings(current.getText(), context.lintSelection, current),
        );
      } catch (err) {
        reportError(context, err);
      }
    }, PROSE_DEBOUNCE_MS),
  );
}

// Quick-fix + fix-all code actions for an open .jpnov. Reuse the cached findings when they match the
// document version; otherwise recompute synchronously (e.g. an action requested before the
// debounced lint landed) — the engine is fast enough that no cancellation plumbing is needed.
connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const doc = documents.get(params.textDocument.uri);
  if (doc?.languageId !== 'jpnov') {
    return [];
  }
  const uri = doc.uri;
  const version = doc.version;
  const cached = findingsCache.get(uri);
  if (cached?.version === version) {
    return buildCodeActions(uri, cached.findings, params.range, params.context.only);
  }
  const findings = computeLintFindings(doc.getText(), context.lintSelection, doc);
  findingsCache.set(uri, { version, findings });
  return buildCodeActions(uri, findings, params.range, params.context.only);
});

/** Re-lint every open .jpnov — used when the lint selection changes (no text edit drives it). */
function revalidateOpenNovels(): void {
  for (const doc of documents.all()) {
    if (doc.languageId === 'jpnov') {
      scheduleProseDiagnostics(doc);
    }
  }
}

// onDidChangeContent fires on open AND on every edit, so it covers initial validation too.
documents.onDidChangeContent((e) => {
  if (e.document.languageId === 'jpbook') {
    scheduleJpbookDiagnostics(e.document);
  } else if (e.document.languageId === 'jpnov') {
    scheduleProseDiagnostics(e.document);
  }
});

// Closing a book file drops its (buffer-scoped) diagnostics; a later build republishes if needed.
documents.onDidClose((e) => {
  clearTimeout(jpbookDebounce.get(e.document.uri));
  jpbookDebounce.delete(e.document.uri);
  clearTimeout(proseDebounce.get(e.document.uri));
  proseDebounce.delete(e.document.uri);
  findingsCache.delete(e.document.uri);
  if (e.document.languageId === 'jpbook' || e.document.languageId === 'jpnov') {
    void connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  }
});

connection.listen();
