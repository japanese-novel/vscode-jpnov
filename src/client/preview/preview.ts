/**
 * The live preview: one client-owned WebviewPanel mirroring the active `.jpnov` editor on its
 * live (dirty) buffer. The SERVER renders (`jpnov/renderFile`); this class decides WHEN to
 * render, follows the editor's top-most cursor, and owns webview security: the server HTML must
 * be hardened (strict CSP `<meta>`, a per-render nonce on the inline `<style>`, the nonce'd
 * bundle: cursor follow + the layout widget) before it is assigned to `webview.html`. The panel
 * survives window reloads through the serializer in extension.ts — `adopt()` must stay
 * synchronous through its first paint and never throw. A lifetime listener follows editor
 * switches and remembers the last `.jpnov` document, so the preview command has something to
 * show even when issued from a non-text editor such as the walkthrough page. The layout widget's
 * preview-only grid overrides live here as well: per panel, never persisted.
 */
import * as vscode from 'vscode';

import type { LanguageClient } from 'vscode-languageclient/node';

import { errorText } from '#/shared/errors.ts';
import { escapeHtml } from '#/shared/compiler/escape.ts';
import { resolvePreviewSettings } from '#/shared/config/settings.ts';
import { CHARS_MAX, CHARS_MIN } from '#/shared/config/types.ts';
import {
  RenderFileRequest,
  type PreviewSettings,
  type RenderFileParams,
  type RenderFileResult,
} from '#/shared/protocol.ts';

import type {
  PreviewInit,
  PreviewLayoutInit,
  PreviewLayoutKey,
  PreviewLayoutLabels,
  RevealMessage,
} from '../protocol.ts';

import { bootScript, cspMeta, makeNonce } from '../nonce.ts';
import { lastPathSegment } from '../paths.ts';
import { buildPreviewSettings } from '../renderConfig.ts';
import { LOADING_CSS, PREVIEW_JS, WIDGET_CSS } from './webviewBundle.generated.ts';

/**
 * Trailing-edge debounce for edit-driven re-renders. Every keystroke otherwise ships the whole
 * buffer to the server and swaps the full webview DOM; 120ms coalesces a typing burst into one
 * render while staying under the ~200ms "feels live" bar. Only the edit path is debounced —
 * open/adopt/editor-switch renders stay immediate.
 */
const RENDER_DEBOUNCE_MS = 120;

/** The grid keys the layout widget adjusts, in widget order. */
const LAYOUT_KEYS: readonly PreviewLayoutKey[] = ['charsPerLine', 'linesPerPage'];

function isLayoutKey(value: unknown): value is PreviewLayoutKey {
  return typeof value === 'string' && (LAYOUT_KEYS as readonly string[]).includes(value);
}

/** A widget override: the preview-only value, and the resolved setting it was set against. */
interface LayoutOverride {
  readonly value: number;
  readonly base: number;
}

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
  /** Pending debounced re-render (see {@link RENDER_DEBOUNCE_MS}) and the widget input it re-focuses; cleared by teardown(). */
  private renderDebounce: ReturnType<typeof setTimeout> | undefined;
  private scheduledFocus: PreviewLayoutKey | undefined;
  /**
   * Preview-only values for charsPerLine / linesPerPage from the layout widget, replacing the
   * settings in every render. Panel-scoped: kept across document switches, dropped by teardown().
   * A render retires one whose setting moved since it was set, or that now equals its setting.
   */
  private readonly layoutOverride = new Map<PreviewLayoutKey, LayoutOverride>();
  /** The last `jpnov.previewAdjusted` value sent, so only a flip costs a setContext round trip. */
  private adjustedContext: boolean | undefined;
  /** The widget's fixed strings, localized once; `hint` is per render. */
  private readonly labels: Omit<PreviewLayoutLabels, 'hint'>;

  private readonly client: LanguageClient;

  constructor(client: LanguageClient) {
    this.client = client;
    this.labels = {
      chars: vscode.l10n.t('chars'),
      lines: vscode.l10n.t('lines'),
      charsPerLine: vscode.l10n.t('Characters per line'),
      linesPerPage: vscode.l10n.t('Lines per page'),
      reset: vscode.l10n.t('Reset Preview Layout to Settings'),
      save: vscode.l10n.t('Save Preview Layout to Settings…'),
      show: vscode.l10n.t('Show Preview Layout Controls'),
    };
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
        // Scripts are enabled but locked to a per-render nonce via CSP; the only script is our
        // own bundle (cursor follow + the layout widget), so no remote/inline-eval script can run.
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

  /** Command handler for `jpnov.preview.resetLayout` (also the widget's reset button): drops every override. */
  resetLayout(): void {
    if (this.layoutOverride.size === 0) {
      return;
    }
    this.cancelScheduledRender(); // a change committed just before the click must not re-open the chip
    this.layoutOverride.clear();
    this.syncContext();
    this.refresh();
  }

  /**
   * Command handler for `jpnov.preview.saveLayout` (also the widget's save button): writes the
   * overridden keys to the user or workspace settings the author picks. The writes' change events
   * re-render, and the render retires each override whose setting now holds its value.
   */
  async saveLayout(): Promise<void> {
    const entries = [...this.layoutOverride]; // a snapshot: the panel may close while the pick is open
    if (entries.length === 0) {
      return;
    }
    this.scheduledFocus = undefined; // a change committed just before the click: rendered, but under the pick
    const config = vscode.workspace.getConfiguration();
    const shadowed = entries.some(([key]) => {
      const scopes = config.inspect<number>(`jpnov.layout.${key}`);
      return scopes?.workspaceValue !== undefined || scopes?.workspaceFolderValue !== undefined;
    });
    const items: (vscode.QuickPickItem & { readonly target: vscode.ConfigurationTarget })[] = [{
      label: vscode.l10n.t('User Settings'),
      description: vscode.l10n.t('Applies to every folder you open'),
      ...(shadowed ? { detail: vscode.l10n.t('A workspace setting already exists and takes precedence') } : {}),
      target: vscode.ConfigurationTarget.Global,
    }];
    if ((vscode.workspace.workspaceFolders ?? []).length > 0) {
      items.push({
        label: vscode.l10n.t('Workspace Settings'),
        description: vscode.l10n.t('Applies to the open folder only'),
        target: vscode.ConfigurationTarget.Workspace,
      });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Select where to save') });
    if (pick === undefined) {
      return;
    }
    for (const [key, { value }] of entries) {
      await config.update(`jpnov.layout.${key}`, value, pick.target);
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

  /** Mirrors "an override is active" into the `jpnov.previewAdjusted` context key (the palette entries' `when`). */
  private syncContext(): void {
    const adjusted = this.layoutOverride.size > 0;
    if (adjusted !== this.adjustedContext) {
      this.adjustedContext = adjusted;
      void vscode.commands.executeCommand('setContext', 'jpnov.previewAdjusted', adjusted);
    }
  }

  private cancelScheduledRender(): void {
    clearTimeout(this.renderDebounce);
    this.renderDebounce = undefined;
    this.scheduledFocus = undefined;
  }

  /**
   * Trailing-edge debounced render of the shown document: a typing burst or a held spinner costs
   * one render. `focus` names the widget input whose change this is, for the render that lands.
   */
  private scheduleRender(focus?: PreviewLayoutKey): void {
    clearTimeout(this.renderDebounce);
    this.scheduledFocus = focus ?? this.scheduledFocus;
    this.renderDebounce = setTimeout(() => {
      this.renderDebounce = undefined;
      const landing = this.scheduledFocus;
      this.scheduledFocus = undefined;
      const doc = this.openPreviewable(this.currentDocUri);
      if (doc !== undefined) {
        void this.renderDocument(doc, undefined, landing);
      }
    }, RENDER_DEBOUNCE_MS);
  }

  /** Handles the layout widget's verbs; the payload is untrusted, so anything malformed is dropped. */
  private onWebviewMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const m = message as { type?: unknown; key?: unknown; value?: unknown };
    if (m.type === 'layout') {
      const { key, value } = m;
      if (isLayoutKey(key) && typeof value === 'number' && Number.isSafeInteger(value) && value >= CHARS_MIN && value <= CHARS_MAX) {
        const base = resolvePreviewSettings(buildPreviewSettings())[key];
        if (value === base) {
          this.layoutOverride.delete(key);
        } else {
          this.layoutOverride.set(key, { value, base });
        }
        this.syncContext();
        this.scheduleRender(key);
      }
    } else if (m.type === 'reset') {
      this.resetLayout();
    } else if (m.type === 'save') {
      // Through the command, so its popup boundary covers the webview path too.
      void vscode.commands.executeCommand('jpnov.preview.saveLayout');
    }
  }

  /**
   * Drops an override whose setting moved since it was set (the settings edit wins) or that now
   * equals its setting, and mirrors the outcome into the context key.
   */
  private retireOverrides(base: PreviewSettings): void {
    for (const [key, override] of this.layoutOverride) {
      if (override.base !== base[key] || override.value === base[key]) {
        this.layoutOverride.delete(key);
      }
    }
    this.syncContext();
  }

  /**
   * The widget's bootstrap for one render: `rendered` is what the document was laid out with (an
   * override may have changed since), `base` the resolved settings behind it.
   */
  private layoutInit(
    base: PreviewSettings,
    rendered: PreviewSettings,
    adjusted: boolean,
    focus: PreviewLayoutKey | undefined,
  ): PreviewLayoutInit {
    const hint = adjusted
      ? vscode.l10n.t('Preview only. The settings are still {0} chars × {1} lines.', String(base.charsPerLine), String(base.linesPerPage))
      : vscode.l10n.t('Characters per line × lines per page. Changes here apply to the preview only.');
    return {
      charsPerLine: rendered.charsPerLine,
      linesPerPage: rendered.linesPerPage,
      adjusted,
      min: CHARS_MIN,
      max: CHARS_MAX,
      ...(focus !== undefined ? { focus } : {}),
      labels: { ...this.labels, hint },
    };
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
      // The layout widget's verbs: preview-only grid overrides, reset, save.
      panel.webview.onDidReceiveMessage((message: unknown) => {
        this.onWebviewMessage(message);
      }),
      // Re-render on every edit to the file currently shown (live dirty buffer); the trailing render
      // reads the document's CURRENT text and re-checks that the panel still shows it.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === this.currentDocUri) {
          this.scheduleRender();
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
  private async renderDocument(
    doc: vscode.TextDocument,
    fallbackLine?: number,
    focus?: PreviewLayoutKey,
  ): Promise<void> {
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
    const snapshot = buildPreviewSettings();
    const base = resolvePreviewSettings(snapshot);
    this.retireOverrides(base);
    // The widget's overrides replace the settings for the preview only; builds read the settings.
    const settings = { ...snapshot };
    for (const [key, override] of this.layoutOverride) {
      settings[key] = override.value;
    }
    const params: RenderFileParams = { uri, text: doc.getText(), settings };
    // Sampled now: what this render lays out is what its widget must show, whatever changes meanwhile.
    const layout = this.layoutInit(base, resolvePreviewSettings(settings), this.layoutOverride.size > 0, focus);

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
    panel.webview.html = this.harden(result.html, panel.webview, activeLine, uri, layout);
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
   * Inject a strict CSP `<meta>`, a nonce on the inline `<style>`, the widget's nonce'd stylesheet
   * and the nonce'd bundle `<script>` (cursor follow + widget) into the server's standalone
   * document, so only those may run inside the webview.
   */
  private harden(
    html: string,
    webview: vscode.Webview,
    activeLine: number,
    docUri: string,
    layout: PreviewLayoutInit,
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
    // The widget's stylesheet after the compiler's own <style> (its selectors are namespaced `jw-`).
    // Replacer functions throughout: a `$` sequence inside the bundle must never act as a pattern.
    out = out.replace(/<\/head>/i, () => `<style nonce="${nonce}">${WIDGET_CSS}</style></head>`);

    // Inject the bundle at the end of <body> (DOM is ready): the `__INIT` bootstrap, then the
    // scroller + widget — see bootScript for the escaping / script-split constraints.
    const init: PreviewInit = { uri: docUri, line: activeLine, layout };
    const script = `${bootScript(nonce, init)}<script nonce="${nonce}">${PREVIEW_JS}</script>`;
    if (/<\/body>/i.test(out)) {
      return out.replace(/<\/body>/i, () => `${script}</body>`);
    }
    return out.replace(/<\/html>/i, () => `${script}</html>`);
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
    this.cancelScheduledRender();
    for (const d of this.panelDisposables) {
      d.dispose();
    }
    this.panelDisposables.length = 0;
    this.panel = undefined;
    this.currentDocUri = undefined;
    this.lastRevealLine = undefined;
    // The overrides live with the panel: the next one starts on the settings.
    this.layoutOverride.clear();
    this.syncContext();
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
