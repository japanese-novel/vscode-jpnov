/**
 * Extension entry (host side) — the ONLY tree permitted to value-import `vscode`. It forks the
 * language server over IPC and owns the host-side UI (Books panel, live preview), every file
 * write, and every read of a file's contents: the server lists directories by itself and asks
 * here for the text.
 *
 * Activation is two-phase because `onStartupFinished` activates this extension in EVERY window:
 *   Phase 1 `activate()`  — synchronous registrations only (commands, serializer, lazy-start
 *     listeners); no LanguageClient, no fork, no fs beyond one root readDirectory per folder.
 *   Phase 2 `ensureStarted()` — single-flight; constructs the client + UI singletons and forks
 *     the server on the FIRST real demand (a jpnov/jpbook document, a jpnov command, a restored
 *     preview panel, or a probe hit on a workspace folder).
 */
import * as vscode from 'vscode';

import {
  LanguageClient,
  PrepareRenameRequest,
  State,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';

import {
  LintConfigChangedNotification,
  ReadTextRequest,
  ServerErrorNotification,
  type LintConfigChangedParams,
  type ReadTextParams,
  type ReadTextResult,
  type ServerErrorParams,
} from '#/shared/protocol.ts';
import { errorText } from '#/shared/errors.ts';

import { createFile, registerBookCommands } from './book/manage.ts';
import { BooksViewProvider } from './book/view.ts';
import { command } from './commands.ts';
import { registerAutoIndent } from './editor/autoIndent.ts';
import { registerWordCommands } from './editor/wordCommands.ts';
import { registerAnnotationHover } from './hover.ts';
import { buildLintSnapshot } from './lintConfig.ts';
import { folderIsNovelProject } from './probe.ts';
import { isLocalizableMessage, renderMessage } from './messages.ts';
import { documentSync } from './documentSync.ts';
import { Preview } from './preview/preview.ts';
import { registerRenameTracking } from './book/tracking.ts';
import { readText } from './book/readText.ts';

let client: LanguageClient | undefined;
let preview: Preview | undefined;
let booksView: BooksViewProvider | undefined;
let extCtx: vscode.ExtensionContext | undefined;
/** Phase-2 latch: `ensureStarted()` is single-flight and never un-runs until deactivate. */
let started = false;

/** Pre-start `*.jpbook` creation watcher; retired by the first ensureStarted(). */
let coldStartWatcher: vscode.FileSystemWatcher | undefined;

/** Documents that justify starting the language server. */
function isNovelDoc(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'jpnov' || doc.languageId === 'jpbook';
}

/**
 * Starts the server iff some folder looks like a novel project. The per-folder decision
 * (workspace/folder-level `jpnov.*` settings, or project filenames in the folder root)
 * lives in `probe.ts`; this loop just short-circuits once anything started us.
 */
async function startIfProjectPresent(
  folders: readonly vscode.WorkspaceFolder[],
): Promise<void> {
  for (const folder of folders) {
    if (started) {
      return; // another trigger won while we awaited
    }
    if (await folderIsNovelProject(folder)) {
      ensureStarted();
      return;
    }
  }
}

/**
 * Sends the current `jpnov.lint.*` snapshot. Only while the client is Running: the send rejects
 * once it has stopped.
 */
function pushLint(): void {
  const params: LintConfigChangedParams = { lintConfig: buildLintSnapshot() };
  void client?.sendNotification(LintConfigChangedNotification, params);
}

/**
 * Phase 2: construct the LanguageClient + UI singletons and start the server.
 * Idempotent and synchronous through construction, so `preview`/`booksView` exist the
 * instant any caller returns; `client.start()` is fire-and-forget — vscode-languageclient
 * queues requests issued after `start()` until the initialize handshake completes, so
 * callers never await this.
 */
function ensureStarted(): void {
  if (started || extCtx === undefined) {
    return;
  }
  started = true;
  // Retire the pre-start watcher (BooksView's own takes over); its second dispose via
  // context.subscriptions at deactivate is a no-op.
  coldStartWatcher?.dispose();
  coldStartWatcher = undefined;
  // Reveal the Books panel (gated on `jpnov.active`); its empty state shows the welcome guide.
  // Never un-set for the session, like the `started` latch above.
  void vscode.commands.executeCommand('setContext', 'jpnov.active', true);
  const context = extCtx;

  // Run the bundled server as a forked Node process over IPC. We deliberately do NOT set
  // `runtime`: letting vscode-languageclient `fork` the module runs it in the host's Node
  // (Electron with ELECTRON_RUN_AS_NODE handled internally). Setting `runtime:
  // process.execPath` would instead *spawn* the Electron binary as an app, so the server
  // never starts and the IPC connection closes during `initialize`.
  const serverModule = context.asAbsolutePath('dist/server/server.js');
  const serverOptions: ServerOptions = {
    module: serverModule,
    transport: TransportKind.ipc,
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { language: 'jpnov' },
      { language: 'jpbook' },
    ],
    initializationOptions: {
      lintConfig: buildLintSnapshot(),
    },
    middleware: {
      // A document request waits for its document's open (see documentSync.ts).
      ...documentSync(),
      // Server diagnostics carry English in `.message` (the fallback VS Code shows) and the
      // localizable `{code,args}` in `.data`. Replace `.message` with the localized render when
      // data is present; otherwise leave the English fallback untouched.
      handleDiagnostics(uri, diagnostics, next) {
        for (const d of diagnostics) {
          const data = (d as vscode.Diagnostic & { data?: unknown }).data;
          if (isLocalizableMessage(data)) {
            d.message = renderMessage(data);
          }
        }
        next(uri, diagnostics);
      },
      // Lint code actions come from the vscode-free server with English titles. Localize them:
      // the fix-all bundle is recognized by its source.fixAll kind; a quick-fix reuses the localized
      // message of its diagnostic (the same data the diagnostic middleware above renders).
      async provideCodeActions(document, range, context, token, next) {
        const actions = await next(document, range, context, token);
        if (!actions) {
          return actions;
        }
        for (const action of actions) {
          if (!(action instanceof vscode.CodeAction)) {
            continue; // Command-shaped actions carry no localizable title
          }
          if (action.kind !== undefined && vscode.CodeActionKind.SourceFixAll.contains(action.kind)) {
            action.title = vscode.l10n.t('Fix all auto-fixable problems (Japanese Novel)');
            continue;
          }
          const diag = action.diagnostics?.[0] as (vscode.Diagnostic & { data?: unknown }) | undefined;
          if (isLocalizableMessage(diag?.data)) {
            action.title = renderMessage(diag.data);
          }
        }
        return actions;
      },
      // Off a 対象文字列 the server answers null, which vscode-languageclient turns into an
      // English sentence of its own; ask the server here and say instead what can be renamed.
      async prepareRename(document, position, token) {
        const c = client;
        if (c === undefined) {
          return null;
        }
        const params = c.code2ProtocolConverter.asTextDocumentPositionParams(document, position);
        const result = await c.sendRequest(PrepareRenameRequest.type, params, token);
        if (result !== null && 'placeholder' in result) {
          return { range: c.protocol2CodeConverter.asRange(result.range), placeholder: result.placeholder };
        }
        throw new Error(vscode.l10n.t("Only an annotation's target text and the body it names can be renamed."));
      },
    },
  };

  client = new LanguageClient(
    'jpnov',
    vscode.l10n.t('Japanese Novel Language Server'),
    serverOptions,
    clientOptions,
  );

  preview = new Preview(client);
  booksView = new BooksViewProvider(client, context.extensionUri);

  // Dispose UI singletons on deactivate (order: stop the client separately in deactivate()).
  // Rename tracking registers here too — novel workspaces only, like everything phase-2.
  context.subscriptions.push(preview, booksView, registerRenameTracking(), registerAnnotationHover(client));

  // Push jpnov.lint.* changes so the server re-lints open files live; re-render the preview
  // when any jpnov.layout.* setting changes (the txt/outDir members only feed
  // on-demand builds, but the extra refresh is idempotent and settings edits are rare);
  // re-enumerate books when the out dir moves. Gated on Running: the state listener below
  // re-sends the lint snapshot and re-lists the books when the server next comes up, and the
  // preview/books re-read their snapshots on the next request anyway.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (client?.state !== State.Running) {
        return;
      }
      if (e.affectsConfiguration('jpnov.lint')) {
        pushLint();
      }
      if (e.affectsConfiguration('jpnov.layout') || e.affectsConfiguration('jpnov.lint.common.dash')) {
        // The dash choice is the one lint key the render snapshot also carries.
        preview?.refresh();
      }
      if (e.affectsConfiguration('jpnov.layout.outDir')) {
        // A moved outDir changes which books exist (it is excluded from discovery) and where
        // output lands: re-list
        // (refresh() self-catches and is refreshSeq-serialized, so the dropped promise is safe).
        void booksView?.refresh();
      }
    }),
  );

  // Server-reported unexpected errors: the vscode-free server emits a LocalizableMessage; render
  // it to localized text and surface it as a popup. showErrorMessage never rejects, so void it.
  context.subscriptions.push(
    client.onNotification(ServerErrorNotification, (params: ServerErrorParams) => {
      void vscode.window.showErrorMessage(renderMessage(params.message));
    }),
  );

  // The server never reads manuscript files; book/readText.ts answers with the text the editor shows.
  // Registered before start(): vscode-languageclient parks the handler until the connection exists.
  context.subscriptions.push(
    client.onRequest(ReadTextRequest, (params: ReadTextParams): Promise<ReadTextResult> => readText(params)),
  );

  // Folder add/remove while running: re-enumerate the books (the listing also replaces the
  // server's per-root vocabulary, so a removed root's names go with it). Gated on Running like
  // the settings pushes above; a change inside the startup window is covered by the state
  // listener below.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (client?.state !== State.Running) {
        return;
      }
      void booksView?.refresh();
    }),
  );

  // The server holds the snapshot `initializationOptions` carried when the client was built,
  // and the Running-gated listeners above skip a change that arrives while it is starting. So
  // send it again each time it comes up, and list the books (nothing else fills the panel on a
  // cold start, and the listing is what gives the server the books' names): after the first
  // start, and after the restart vscode-languageclient makes when the server process dies.
  context.subscriptions.push(
    client.onDidChangeState((e) => {
      if (e.newState === State.Running) {
        pushLint();
        void booksView?.refresh();
      }
    }),
  );

  // Start the client (and the server process). start() is called exactly once (single-flight
  // latch above), so a hard startup failure surfaces exactly one popup.
  client.start().catch(
    (err: unknown) => {
      const message = errorText(err);
      // Terminal popup inside the rejection branch; showErrorMessage never rejects so void is safe.
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Japanese Novel: couldn't start the language server. {0}", message),
      );
    },
  );
}

function serverCommand(id: string, run: (...args: unknown[]) => Promise<void> | void): vscode.Disposable {
  return command(id, (...args: unknown[]) => {
    ensureStarted();
    return run(...args);
  });
}

export function activate(context: vscode.ExtensionContext): void {
  extCtx = context;

  // Revive the preview panel the workbench restored from the previous session (window
  // reload); without a registered serializer the restored tab would stay blank forever.
  // Registered eagerly: `onWebviewPanel` activation can precede every other trigger.
  // ensureStarted() runs synchronously first, so `preview` exists and its adopt() paints
  // the loading shell immediately — the first render then queues behind client.start().
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(Preview.viewType, {
      deserializeWebviewPanel: (panel: vscode.WebviewPanel, state: unknown) => {
        ensureStarted();
        preview?.adopt(panel, state);
        // adopt() is synchronous through its first paint and never throws; returning
        // already-resolved keeps VS Code's revival pipeline unblocked (a rejection
        // would surface an "error restoring view" page instead).
        return Promise.resolve();
      },
    }),
  );

  // Commands. Every server-dependent body goes through ensureStarted() (via serverCommand), so
  // any command is a start trigger. The Books panel's build and selection actions are webview
  // messages handled in view.ts, not commands.
  context.subscriptions.push(
    serverCommand('jpbook.refresh', () => booksView?.refresh(true)),
    serverCommand('jpbook.createFile', () => createFile(booksView)),
    serverCommand('jpnov.preview', () => preview?.open(false)),
    serverCommand('jpnov.previewToSide', () => preview?.open(true)),
    // The preview's layout widget verbs (plain: an override exists only once the preview has
    // rendered, and `preview?.` covers the pre-start case). The palette lists them while adjusted.
    command('jpnov.preview.resetLayout', () => preview?.resetLayout()),
    command('jpnov.preview.saveLayout', () => preview?.saveLayout()),
    // Plain command (no server needed): the Books panel's welcome views link here. The id
    // is resolved at runtime so the walkthrough opens under any publisher, including the
    // Extension Development Host's `undefined_publisher`.
    command('jpnov.openGuide', () => {
      void vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        `${context.extension.id}#jpnov.gettingStarted`,
      );
    }),
    // The Books panel's form editing (plain: dispatched by view.ts, never from the palette).
    ...registerBookCommands(),
  );

  // Editor behavior (自動字下げ and the word commands): server-free, so it registers in Phase 1.
  context.subscriptions.push(registerAutoIndent(), registerWordCommands());

  // Lazy-start triggers. The listener covers documents opened AFTER activation; the
  // synchronous scan below covers the one that caused an onLanguage activation (it was
  // open before this listener existed, so the listener alone would miss it). A language-
  // mode change is covered too: VS Code reopens the document (close + open events).
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (!started && isNovelDoc(doc)) {
        ensureStarted();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      // Only the not-yet-started case lives here; once started, the Running-gated listener
      // registered in ensureStarted() refreshes the books.
      if (!started) {
        void startIfProjectPresent(e.added);
      }
    }),
  );

  // Pre-start self-heal: a `*.jpbook` created while we are dormant (git checkout, OS
  // copy, terminal) opens no document, so the listeners above never fire. The watcher
  // cannot tell files from directories — a folder named `x.jpbook` causes a benign
  // start; server-side discovery stays the arbiter.
  coldStartWatcher = vscode.workspace.createFileSystemWatcher('**/*.jpbook');
  context.subscriptions.push(
    coldStartWatcher,
    coldStartWatcher.onDidCreate(() => { ensureStarted(); }),
  );

  if (vscode.workspace.textDocuments.some(isNovelDoc)) {
    ensureStarted();
  } else {
    // Novel workspace with no novel editor open (the onStartupFinished case): probe the
    // folder roots and self-populate the Books view shortly after startup.
    // Not awaited — activate() must return immediately; the probe is internally
    // started-guarded, so racing another trigger is harmless.
    void startIfProjectPresent(vscode.workspace.workspaceFolders ?? []);
  }
}

export function deactivate(): Thenable<void> | undefined {
  // The disposables (preview, books panel) are torn down by the extension host via
  // context.subscriptions; we only need to stop the client, which shuts down the forked
  // server process.
  const stopping = client?.stop();
  client = undefined;
  preview = undefined;
  booksView = undefined;
  coldStartWatcher = undefined;
  extCtx = undefined;
  started = false;
  return stopping;
}
