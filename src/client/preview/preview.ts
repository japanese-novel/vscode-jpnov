/**
 * The live preview: one client-owned WebviewPanel mirroring the active `.jpnov` editor on its
 * live (dirty) buffer. The SERVER renders (`jpnov/renderFile`); this class decides WHEN to
 * render, follows the editor's top-most cursor, and owns webview security: the server HTML must
 * be hardened (strict CSP `<meta>`, a per-render nonce on the inline `<style>`, the nonce'd
 * cursor-follow script) before it is assigned to `webview.html`. The panel survives window
 * reloads through the serializer in extension.ts — `adopt()` must stay synchronous through its
 * first paint and never throw. A lifetime listener follows editor switches and remembers the
 * last `.jpnov` document, so the preview command has something to show even when issued from
 * a non-text editor such as the walkthrough page.
 */
import * as vscode from 'vscode';

import type { LanguageClient } from 'vscode-languageclient/node';

import { errorText } from '#/shared/errors.ts';
import { escapeHtml } from '#/shared/compiler/escape.ts';
import {
  RenderFileRequest,
  type RenderFileParams,
  type RenderFileResult,
} from '#/shared/protocol.ts';

import type { PreviewInit, RevealMessage } from '../protocol.ts';

import { bootScript, cspMeta, makeNonce } from '../nonce.ts';
import { lastPathSegment } from '../paths.ts';
import { buildPreviewSettings } from '../renderConfig.ts';
import { LOADING_CSS, SCROLL_JS } from './webviewBundle.generated.ts';

/**
 * Trailing-edge debounce for edit-driven re-renders. Every keystroke otherwise ships the whole
 * buffer to the server and swaps the full webview DOM; 120ms coalesces a typing burst into one
 * render while staying under the ~200ms "feels live" bar. Only the edit path is debounced —
 * open/adopt/editor-switch renders stay immediate.
 */
const RENDER_DEBOUNCE_MS = 120;

export class Preview {
  /** The panel's viewType — the key the window-reload serializer registers under. */
  static readonly viewType = 'jpnov.preview';

  private panel: vscode.WebviewPanel | undefined;
  /** Listeners active only while the panel is open; torn down on dispose. */
  private readonly panelDisposables: vscode.Disposable[] = [];
  /** URI string of the document currently shown, to scope edit/cursor re-renders. */
  private currentDocUri: string | undefined;
  /**
   * The last line baked into a render or posted as a reveal — always for currentDocUri,
   * reset on document switch. A re-render falls back here while the editor is transiently
   * absent from visibleTextEditors, instead of snapping to line 0.
   */
  private lastRevealLine: number | undefined;
  /**
   * Uri of the last `.jpnov` document rendered or made active; open() falls back to it when no
   * previewable editor is active. Resolved through workspace.textDocuments at use time, so a
   * closed document is skipped.
   */
  private lastDocUri: string | undefined;
  /** Lifetime listener behind {@link lastDocUri} and editor-switch re-renders; released by dispose(). */
  private readonly activeEditorListener: vscode.Disposable;
  /**
   * Serializes renders so a slow request can't clobber a newer buffer's output.
   * teardown() bumps it, so an in-flight render can never write to a disposed or
   * replaced panel (every panel transition funnels through teardown()).
   */
  private renderSeq = 0;
  /** Pending edit-driven re-render (see {@link RENDER_DEBOUNCE_MS}); cleared by teardown(). */
  private renderDebounce: ReturnType<typeof setTimeout> | undefined;

  private readonly client: LanguageClient;

  constructor(client: LanguageClient) {
    this.client = client;
    this.lastDocUri = this.previewableEditor(vscode.window.activeTextEditor)?.document.uri.toString();
    // Re-render when the user switches which file is active (a no-op while no panel is open).
    this.activeEditorListener = vscode.window.onDidChangeActiveTextEditor((next) => {
      const editor = this.previewableEditor(next);
      if (editor !== undefined) {
        this.lastDocUri = editor.document.uri.toString();
        void this.renderDocument(editor.document);
      }
    });
  }

  /**
   * Command handler for `jpnov.preview` / `jpnov.previewToSide`: reveal the panel
   * (creating it on first use) and render the active editor's `.jpnov` buffer.
   *
   * `toSide` mirrors VS Code's Markdown preview: when true ("Open Preview to the Side",
   * also the editor-title icon) the panel opens BESIDE the editor and keeps focus on the
   * source; when false ("Open Preview") it opens in the editor's own column and takes focus.
   *
   * Without a previewable active editor (the walkthrough page or the panel itself has focus),
   * a panel that already shows a document is only revealed; a new one shows the last `.jpnov`
   * document, else the neutral shell (#88).
   */
  open(toSide: boolean): void {
    const active = vscode.window.activeTextEditor;
    const editor = this.previewableEditor(active);
    const preserveFocus = toSide;

    let panel = this.panel;
    if (panel === undefined) {
      const column = toSide
        ? vscode.ViewColumn.Beside
        : (active?.viewColumn ?? vscode.ViewColumn.One);
      panel = vscode.window.createWebviewPanel(
        Preview.viewType,
        vscode.l10n.t('Japanese Novel Preview'),
        { viewColumn: column, preserveFocus },
        // Scripts are enabled but locked to a per-render nonce via CSP; the only script
        // is our own cursor-follow scroller (no remote/inline-eval scripts can run).
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.wire(panel);
    } else {
      // No previewable editor to be beside: reveal the panel in its own column.
      // `reveal(undefined)` targets the active group and would move the panel there.
      let column = panel.viewColumn;
      if (editor !== undefined) {
        column = toSide ? vscode.ViewColumn.Beside : (editor.viewColumn ?? vscode.ViewColumn.One);
      }
      panel.reveal(column, preserveFocus);
    }

    if (editor !== undefined) {
      void this.renderDocument(editor.document);
    } else if (this.currentDocUri === undefined) {
      // Nothing shown yet: the last `.jpnov` document, else the neutral shell. A panel that
      // already shows a document keeps it.
      const doc = this.openPreviewable(this.lastDocUri);
      if (doc !== undefined) {
        void this.renderDocument(doc);
      } else {
        panel.webview.html = this.emptyShell(panel.webview);
      }
    }
  }

  /**
   * Serializer entry (see extension.ts): take ownership of a panel the workbench
   * restored from a previous session and re-render it. Synchronous through the first
   * paint and never throws, so revival hands VS Code an already-resolved promise.
   *
   * Content policy is active-editor-first: this preview mirrors the CURRENTLY active
   * editor, and revival can happen long after reload (a restored tab deserializes when
   * it first becomes visible), so the persisted state may be stale. `state.uri` is used
   * only when no previewable editor is active; the persisted `line` scrolls the restored
   * render only when the rendered document is `state.uri` itself.
   */
  adopt(panel: vscode.WebviewPanel, state: unknown): void {
    if (this.panel !== undefined) {
      // A live panel already exists (revival raced the preview command): the incoming panel is redundant.
      panel.dispose();
      return;
    }
    this.wire(panel);
    // Re-assert: without scripts, the cursor-follow scroller and its setState
    // persistence would die silently — and every later reload would degrade further.
    panel.webview.options = { enableScripts: true };

    const { uri, line } = parsePanelState(state);
    const editor = this.previewableEditor(vscode.window.activeTextEditor);
    if (editor !== undefined) {
      // Paint before the async render: the server is cold right after a reload, so the
      // first response can take seconds, and a wedged start must never leave a blank tab.
      panel.webview.html = this.loadingShell(panel.webview);
      const fallbackLine = editor.document.uri.toString() === uri ? line : undefined;
      void this.renderDocument(editor.document, fallbackLine);
    } else if (uri !== undefined) {
      panel.webview.html = this.loadingShell(panel.webview);
      void this.renderRestored(panel, uri, line);
    } else {
      panel.webview.html = this.emptyShell(panel.webview);
    }
  }

  /** Re-renders the shown document with fresh settings (extension.ts calls this on `jpnov.layout.*` edits); a no-op when nothing is shown. */
  refresh(): void {
    const doc = this.openPreviewable(this.currentDocUri);
    if (doc !== undefined) {
      void this.renderDocument(doc);
    }
  }

  dispose(): void {
    this.activeEditorListener.dispose();
    // Capture before teardown(): teardown() nulls `this.panel`, so disposing it must
    // happen against the captured reference (its onDidDispose handler re-enters
    // teardown(), which is idempotent).
    const panel = this.panel;
    this.teardown();
    panel?.dispose();
  }

  /** Only Japanese Novel source documents (jpnov / `.jpnov`) are previewable. */
  private isPreviewable(doc: vscode.TextDocument): boolean {
    return doc.languageId === 'jpnov';
  }

  /** `editor` when it shows a previewable document, else undefined. */
  private previewableEditor(editor: vscode.TextEditor | undefined): vscode.TextEditor | undefined {
    return editor !== undefined && this.isPreviewable(editor.document) ? editor : undefined;
  }

  /** The document for `uri` if it is still open and previewable, else undefined. */
  private openPreviewable(uri: string | undefined): vscode.TextDocument | undefined {
    if (uri === undefined) {
      return undefined;
    }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    return doc !== undefined && this.isPreviewable(doc) ? doc : undefined;
  }

  /** Posts a scroll-to-line message to the live webview (no re-render). */
  private reveal(line: number): void {
    this.lastRevealLine = line;
    const message: RevealMessage = { type: 'reveal', line };
    // Posts to the webview; postMessage never rejects (resolves false if the panel is gone), so void is safe.
    void this.panel?.webview.postMessage(message);
  }

  /**
   * Take ownership of `panel` (freshly created by open() or revived by the serializer):
   * track it, tear down on dispose, and wire the listeners that drive edit re-renders and
   * cursor-follow (editor switches are handled by the constructor's lifetime listener). The
   * dispose hook is attached before anything can await, so an early close cannot leak
   * panelDisposables.
   */
  private wire(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.onDidDispose(() => {
      this.teardown();
    });
    this.panelDisposables.push(
      // Re-render on every edit to the file currently shown (live dirty buffer), debounced so a
      // typing burst costs one render. The trailing call reads the document's CURRENT text
      // (TextDocument is live), and re-checks the panel still shows that document (it may have
      // switched or closed during the delay).
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === this.currentDocUri) {
          clearTimeout(this.renderDebounce);
          this.renderDebounce = setTimeout(() => {
            this.renderDebounce = undefined;
            if (e.document.uri.toString() === this.currentDocUri) {
              void this.renderDocument(e.document);
            }
          }, RENDER_DEBOUNCE_MS);
        }
      }),
      // ...and follow the top-most cursor as it moves (a scroll message, no re-render).
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document.uri.toString() === this.currentDocUri) {
          this.reveal(minCursorLine(e.selections));
        }
      }),
    );
  }

  /** Revival tail for a persisted uri: load the document and render, or fall back to the neutral shell. */
  private async renderRestored(
    panel: vscode.WebviewPanel,
    uri: string,
    line: number | undefined,
  ): Promise<void> {
    let doc: vscode.TextDocument | undefined;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    } catch {
      doc = undefined; // deleted/renamed while the window was closed, or an unloadable scheme
    }
    if (this.panel !== panel) {
      return; // closed or replaced while the document loaded
    }
    if (doc !== undefined && this.isPreviewable(doc)) {
      await this.renderDocument(doc, line);
      return;
    }
    panel.webview.html = this.emptyShell(panel.webview);
  }

  /**
   * Renders `doc` into the panel. Self-catching (a failed request paints a placeholder) and
   * renderSeq-serialized (a stale response never lands), so every call site may fire-and-forget
   * with `void`.
   */
  private async renderDocument(doc: vscode.TextDocument, fallbackLine?: number): Promise<void> {
    const panel = this.panel;
    if (panel === undefined) {
      return;
    }
    const uri = doc.uri.toString();
    if (uri !== this.currentDocUri) {
      this.lastRevealLine = undefined; // the remembered line belongs to the old document
    }
    this.currentDocUri = uri;
    this.lastDocUri = uri;
    panel.title = vscode.l10n.t('{0} — Preview', lastPathSegment(uri));

    const seq = ++this.renderSeq;
    const params: RenderFileParams = {
      uri,
      text: doc.getText(),
      settings: buildPreviewSettings(),
    };

    let result: RenderFileResult;
    try {
      result = await this.client.sendRequest<RenderFileResult>(
        RenderFileRequest,
        params,
      );
    } catch (err) {
      if (seq === this.renderSeq) {
        const message = errorText(err);
        panel.webview.html = this.shell(
          `<p>${vscode.l10n.t('Preview failed. {0}', escapeHtml(message))}</p>`,
          panel.webview,
        );
      }
      return;
    }

    // Drop stale responses: a newer edit already kicked off a later render.
    if (seq !== this.renderSeq) {
      return;
    }
    // Sampled at swap time, after the seq check: pre-await sampling bakes a stale line,
    // and a dropped response must not write lastRevealLine. `fallbackLine` (revived
    // panel state) applies only before any live cursor line is known.
    const activeLine = this.topCursorLine(uri) ?? this.lastRevealLine ?? fallbackLine ?? 0;
    this.lastRevealLine = activeLine;
    panel.webview.html = this.harden(result.html, panel.webview, activeLine, uri);
  }

  /** The top-most (earliest) cursor line among all selections in an editor for `docUri`. */
  private topCursorLine(docUri: string): number | undefined {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.toString() === docUri) {
        return minCursorLine(ed.selections);
      }
    }
    return undefined;
  }

  /**
   * Inject a strict CSP `<meta>`, a nonce on the inline `<style>`, and a nonce'd
   * cursor-follow `<script>` into the server's standalone document so it is safe to host
   * inside a webview. Only the nonced inline style + our own script may run.
   */
  private harden(
    html: string,
    webview: vscode.Webview,
    activeLine: number,
    docUri: string,
  ): string {
    const nonce = makeNonce();
    const meta = cspMeta(nonce, webview, true);

    let out = html;
    // Nonce the compiler's own inline <style>/<script> (the stylesheet and the 傍点 probe):
    // document text is HTML-escaped upstream, so these tags are always the server's own.
    for (const tag of ['style', 'script'] as const) {
      out = out.replace(
        new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi'),
        (_m, attrs: string | undefined) => `<${tag}${attrs ?? ''} nonce="${nonce}">`,
      );
    }

    // If for some reason there is no <head>, fall back to wrapping in our own shell.
    if (!/<head(\s[^>]*)?>/i.test(out)) {
      return this.shell(html, webview);
    }
    out = out.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${meta}`);

    // Inject the scroller at the end of <body> (DOM is ready): the `__INIT` bootstrap, then the
    // bundled scroller — see bootScript for the escaping / script-split constraints.
    const init: PreviewInit = { uri: docUri, line: activeLine };
    const script = `${bootScript(nonce, init)}<script nonce="${nonce}">${SCROLL_JS}</script>`;
    if (/<\/body>/i.test(out)) {
      return out.replace(/<\/body>/i, `${script}</body>`);
    }
    return out.replace(/<\/html>/i, `${script}</html>`);
  }

  /** Minimal hardened standalone document for fallback / placeholder content. */
  private shell(bodyHtml: string, webview: vscode.Webview, extraCss = ''): string {
    const nonce = makeNonce();
    return [
      '<!DOCTYPE html>',
      '<html><head><meta charset="utf-8">',
      cspMeta(nonce, webview, true),
      `<style nonce="${nonce}">body{font-family:sans-serif;padding:1rem;}${extraCss}</style>`,
      `</head><body>${bodyHtml}</body></html>`,
    ].join('');
  }

  /** The neutral empty state: nothing previewable to render (also the failure fallback at revival). */
  private emptyShell(webview: vscode.Webview): string {
    return this.shell(
      `<p>${escapeHtml(vscode.l10n.t('Open a .jpnov file to preview.'))}</p>`,
      webview,
    );
  }

  /** Hardened "Loading preview…" placeholder; the CSS-only spinner + its rationale live in loading.css. */
  private loadingShell(webview: vscode.Webview): string {
    return this.shell(
      `<p class="loading"><span class="spinner"></span>${escapeHtml(vscode.l10n.t('Loading preview…'))}</p>`,
      webview,
      LOADING_CSS,
    );
  }

  private teardown(): void {
    // Invalidate any in-flight render: both html assignments in renderDocument() are
    // seq-guarded, so the bump keeps a slow response from writing to this panel after
    // it is disposed (or, via adopt()'s duplicate guard, replaced).
    this.renderSeq++;
    clearTimeout(this.renderDebounce);
    this.renderDebounce = undefined;
    for (const d of this.panelDisposables) {
      d.dispose();
    }
    this.panelDisposables.length = 0;
    this.panel = undefined;
    this.currentDocUri = undefined;
    this.lastRevealLine = undefined;
  }
}

/** The earliest (smallest-line) active cursor among `selections`; 0 if none. */
function minCursorLine(selections: readonly vscode.Selection[]): number {
  let min = Number.MAX_SAFE_INTEGER;
  for (const sel of selections) {
    if (sel.active.line < min) {
      min = sel.active.line;
    }
  }
  return min === Number.MAX_SAFE_INTEGER ? 0 : min;
}

/**
 * Defensive read of the serializer's persisted webview state: whatever a previous
 * session's injected script last `setState`-ed, or `undefined`, so nothing about its
 * shape can be trusted.
 */
function parsePanelState(state: unknown): {
  uri: string | undefined;
  line: number | undefined;
} {
  if (typeof state !== 'object' || state === null) {
    return { uri: undefined, line: undefined };
  }
  const { uri, line } = state as { uri?: unknown; line?: unknown };
  return {
    uri: typeof uri === 'string' ? uri : undefined,
    line: typeof line === 'number' && Number.isFinite(line) ? line : undefined,
  };
}
