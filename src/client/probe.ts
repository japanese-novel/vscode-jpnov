/**
 * The startup probe: whether one workspace folder looks like a novel project, so
 * `startIfProjectPresent` (extension.ts) can fork the server with no document open. Three
 * signals, cheapest first: a `jpnov.*` setting at the WORKSPACE or FOLDER level — never the
 * user level (a personal preference must not auto-start every window); a root-level `*.jpbook`
 * that is a PLAIN FILE (strict `FileType.File`); a `findFiles` capped at one match, which needs
 * a search provider. A false positive only causes a benign start — the server stays the
 * arbiter of what is a book.
 */
import * as vscode from 'vscode';

import { FIND_FILES_EXCLUDE } from './paths.ts';

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
  if (entries.some(
    ([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.jpbook'),
  )) {
    return true;
  }

  try {
    const nested = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*.jpbook'),
      FIND_FILES_EXCLUDE,
      1,
    );
    return nested.length > 0;
  } catch {
    return false; // no search provider / search failed -> the other start triggers still cover us
  }
}
