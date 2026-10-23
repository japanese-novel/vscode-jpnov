/**
 * The startup probe: whether one workspace folder looks like a novel project, so
 * `startIfProjectPresent` (extension.ts) can fork the server with no document open. Two
 * signals, cheapest first: a `jpnov.*` setting at the WORKSPACE or FOLDER level — never the
 * user level (a personal preference must not auto-start every window); a root-level `*.jpbook`
 * that is a PLAIN FILE (strict `FileType.File`). Nothing walks the folder: a book that sits only
 * in a subfolder starts the server when the Books view opens, a novel document opens, or a
 * `.jpbook` is created. A false positive only causes a benign start — the server stays the
 * arbiter of what is a book.
 */
import * as vscode from 'vscode';

import { hasJpbookExt } from '#/shared/book/jpbook.ts';

export async function folderIsNovelProject(
  folder: vscode.WorkspaceFolder,
): Promise<boolean> {
  const insp = vscode.workspace
    .getConfiguration(undefined, folder.uri)
    .inspect('jpnov');
  if (insp !== undefined && (insp.workspaceValue !== undefined || insp.workspaceFolderValue !== undefined)) {
    return true;
  }

  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(folder.uri);
  } catch {
    return false; // unreadable root (gone, permission, exotic scheme) -> not a novel root
  }
  return entries.some(([name, type]) => type === vscode.FileType.File && hasJpbookExt(name));
}
