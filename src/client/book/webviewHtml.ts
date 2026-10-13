/**
 * The Books panel's WebviewView document: a strict-CSP, nonce'd static shell. The provider
 * ({@link ./view.ts}) sets this html ONCE on resolve, then pushes JSON `state` / `detail` messages
 * that the bundled client renderer ({@link ../webview/book/main.ts} → {@link BOOKS_JS}) turns into DOM.
 * This module owns only the shell: the hardening pieces (nonce, CSP `<meta>`, `__INIT`
 * bootstrap) come from {@link ../nonce.ts}, shared with the preview; the codicon stylesheet is
 * linked from the extension's `media/` via `asWebviewUri`.
 */
import * as vscode from 'vscode';

import type { BooksInit, Labels } from '../protocol.ts';

import { bootScript, cspMeta, makeNonce } from '../nonce.ts';
import { BOOKS_CSS, BOOKS_JS } from './webviewBundle.generated.ts';

/**
 * Localized UI strings baked into the `__INIT` bootstrap. Keys mirror the {@link Labels} contract
 * one-to-one. (buildEpub is the icon button's tooltip + accessible name — a full sentence;
 * print/buildTxt stay button texts.)
 */
function labels(): Labels {
  return {
    loading: vscode.l10n.t('Loading…'),
    loadingHint: vscode.l10n.t("If the books don't appear, press Refresh Books in the title bar."),
    selectAll: vscode.l10n.t('Select all'),
    deselectAll: vscode.l10n.t('Deselect all'),
    selectBook: vscode.l10n.t('Include in build'),
    print: vscode.l10n.t('Print / Save as PDF'),
    buildTxt: vscode.l10n.t('TXT'),
    buildEpub: vscode.l10n.t('Build to EPUB'),
    revealOutput: vscode.l10n.t('Open the output folder after building'),
    back: vscode.l10n.t('Back'),
    books: vscode.l10n.t('Books'),
    chapters: vscode.l10n.t('Chapters'),
    bookInfo: vscode.l10n.t('Book Info'),
    addChapters: vscode.l10n.t('Add chapters…'),
    moveUp: vscode.l10n.t('Move up'),
    moveDown: vscode.l10n.t('Move down'),
    remove: vscode.l10n.t('Remove from book'),
    missing: vscode.l10n.t('File not found'),
    noChapters: vscode.l10n.t('No chapters yet — add one.'),
    covers: vscode.l10n.t('Cover pages'),
    addCovers: vscode.l10n.t('Add cover pages…'),
    noCovers: vscode.l10n.t('Pages before the body — for a submission cover sheet or a synopsis.'),
    noBooksTitle: vscode.l10n.t('No books yet.'),
    noBooksBody: vscode.l10n.t('A .jpbook collects your chapters into one book.'),
    noFolderHint: vscode.l10n.t("A folder is optional, but recommended: open your novel's folder and its books are listed here automatically; without one, a book is listed while its .jpbook is open in the editor."),
    createBook: vscode.l10n.t('Create a Book…'),
    openGuide: vscode.l10n.t('Open the Guide'),
  };
}

/**
 * The full static webview document. Content is rendered client-side from pushed messages: the
 * `__INIT` bootstrap seeds the localized strings, then the bundled renderer runs — see
 * {@link bootScript} for the escaping / script-split constraints.
 */
export function booksHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = makeNonce();
  const codiconHref = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codicon', 'codicon.css'));
  const init: BooksInit = { labels: labels() };
  return [
    '<!DOCTYPE html>',
    `<html lang="${vscode.env.language || 'en'}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    cspMeta(nonce, webview),
    `<link href="${codiconHref.toString()}" rel="stylesheet">`,
    `<style nonce="${nonce}">${BOOKS_CSS}</style>`,
    '</head><body>',
    '<div id="app"></div>',
    bootScript(nonce, init),
    `<script nonce="${nonce}">${BOOKS_JS}</script>`,
    '</body></html>',
  ].join('');
}
