/**
 * Snapshots what `jpnov/listBooks` / `jpnov/build` take to find their books: the
 * `jpnov.layout.outDir` setting per workspace folder (`scope: resource`, so each folder can
 * override it in its own `.vscode/settings.json`), and the `.jpbook` documents open in the editor
 * that no folder contains, each with the `outDir` VS Code resolves for its uri (user settings
 * when nothing nearer). The raw relative string is forwarded as-is; validation and the silent
 * default fallback are the server's job (`outDirSubpath`).
 */
import * as vscode from 'vscode';

import { PROJECT_DEFAULT } from '#/shared/config/types.ts';
import type { ListBooksParams, OpenBook, ProjectDirs } from '#/shared/protocol.ts';

function outDirFor(scope: vscode.Uri): string {
  return vscode.workspace.getConfiguration('jpnov.layout', scope).get<string>('outDir', PROJECT_DEFAULT.outDir);
}

function buildProjectDirs(): Record<string, ProjectDirs> {
  const map: Record<string, ProjectDirs> = {};
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    map[folder.uri.toString()] = { outDir: outDirFor(folder.uri) };
  }
  return map;
}

/** True for a `.jpbook` document the Books view lists on its own: on disk, and under no workspace folder. */
export function isOpenBook(document: vscode.TextDocument): boolean {
  return document.languageId === 'jpbook' &&
    document.uri.scheme === 'file' &&
    vscode.workspace.getWorkspaceFolder(document.uri) === undefined;
}

export function openBooks(): OpenBook[] {
  return vscode.workspace.textDocuments
    .filter(isOpenBook)
    .map((document) => ({ uri: document.uri.toString(), outDir: outDirFor(document.uri) }));
}

/** The book-finding half of a list or build request. */
export function bookTargets(): ListBooksParams {
  return { projectDirs: buildProjectDirs(), openBooks: openBooks() };
}
