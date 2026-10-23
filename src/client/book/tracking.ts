/**
 * The vscode half of rename tracking: listens to `workspace.onDidRenameFiles` (AFTER the
 * rename — `onWillRenameFiles` participants run under a time budget that forbids prompting),
 * plans the reference updates via the pure `rename.ts`, asks per the
 * `jpnov.editor.updateRefsOnFileMove` setting (`prompt`/`always`/`never`, the TS
 * `updateImportsOnFileMove` triad — the toast's Always/Never buttons persist it globally),
 * and applies ONE `WorkspaceEdit` across every affected `.jpbook`. Edited books are left
 * dirty for the author to save, matching the platform convention.
 *
 * The sweep over the workspace's books costs a walk, so it waits for a rename that can move
 * an entry of another book: a `.jpnov` by name, or a folder (what it holds moved with it). A
 * moved book changes its own entries alone, so its rename plans that book only, and an image's
 * rename nothing. Each book is read without opening it (`readText`: the live buffer when it is
 * open, else the disk), so no `didOpen` reaches the server for a book nobody opened.
 *
 * A moved `.jpbook` is a rename like any other: its own entries are rewritten so they keep
 * naming the same files. Renames from outside VS Code (Finder, terminal, git) fire no event;
 * the standing `jpbook.fileNotFound` diagnostics are the net for those.
 */
import * as vscode from 'vscode';

import { hasJpbookExt, hasJpnovExt } from '#/shared/book/jpbook.ts';
import type { TextReplace } from '#/shared/utils/position.ts';

import { toVsRange } from '../ranges.ts';
import { normalizeFsPath, planBookEdits, type FileRename } from './rename.ts';
import { readText } from './readText.ts';
import { FIND_FILES_EXCLUDE } from '../paths.ts';
import { isOpenBook } from '../projectConfig.ts';

const SETTING = 'jpnov.editor.updateRefsOnFileMove';

type Mode = 'prompt' | 'always' | 'never';

function currentMode(): Mode {
  const v = vscode.workspace.getConfiguration().get<string>(SETTING, 'prompt');
  return v === 'always' || v === 'never' ? v : 'prompt';
}

function persistMode(value: Mode): Thenable<void> {
  return vscode.workspace.getConfiguration().update(SETTING, value, vscode.ConfigurationTarget.Global);
}

/** Whether `uri` is a folder now; a failed stat (gone again already) is not one. */
async function isFolder(uri: vscode.Uri): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

/** Every book in reach: those under the workspace folders, and the open ones outside them. */
async function workspaceBooks(): Promise<vscode.Uri[]> {
  const found = await vscode.workspace.findFiles('**/*.jpbook', FIND_FILES_EXCLUDE);
  return [...found, ...vscode.workspace.textDocuments.filter(isOpenBook).map((d) => d.uri)];
}

/** The books of `books` the renames touch, each with its edits (none = dropped). */
async function planAffectedBooks(
  books: readonly vscode.Uri[],
  renames: readonly FileRename[],
): Promise<{ uri: vscode.Uri; edits: readonly TextReplace[] }[]> {
  const planned = await Promise.all(books.map(async (uri) => {
    const read = await readText({ uri: uri.toString() });
    // Unreadable (gone mid-event): nothing to update.
    return { uri, edits: read.ok ? planBookEdits(normalizeFsPath(uri.fsPath), read.text, renames) : [] };
  }));
  return planned.filter((book) => book.edits.length > 0);
}

/** The prompt-mode toast; resolves to whether the update should proceed. */
async function askUser(bookCount: number): Promise<boolean> {
  const update = vscode.l10n.t('Update');
  const always = vscode.l10n.t('Always Update');
  const never = vscode.l10n.t('Never Update');
  const message = vscode.l10n.t(
    'Japanese Novel: files were renamed or moved — update the paths in {0} book file(s)?',
    String(bookCount),
  );
  const pick = await vscode.window.showInformationMessage(message, update, always, never);
  if (pick === always) {
    await persistMode('always');
    return true;
  }
  if (pick === never) {
    await persistMode('never');
    return false;
  }
  return pick === update; // dismissed -> skip this once, keep asking next time
}

async function handleRenames(e: vscode.FileRenameEvent): Promise<void> {
  if (currentMode() === 'never') {
    return;
  }
  const files = e.files.filter((f) => f.oldUri.scheme === 'file' && f.newUri.scheme === 'file');
  if (files.length === 0) {
    return;
  }
  // An entry is a `.jpnov`, so only a `.jpnov` or a folder can move one of another book; the
  // folder stat runs when no name decides it, all the renames at once. Otherwise the moved books
  // themselves are the only ones to plan.
  const sweep = files.some((f) => hasJpnovExt(f.oldUri.path)) || (await Promise.all(files.map((f) => isFolder(f.newUri)))).includes(true);
  const books = sweep ? await workspaceBooks() : files.filter((f) => hasJpbookExt(f.newUri.path)).map((f) => f.newUri);
  const renames: FileRename[] = files.map((f) => ({ oldPath: normalizeFsPath(f.oldUri.fsPath), newPath: normalizeFsPath(f.newUri.fsPath) }));

  const affected = await planAffectedBooks(books, renames);
  if (affected.length === 0) {
    return;
  }
  const proceed = currentMode() === 'always' || (await askUser(affected.length));
  if (!proceed) {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  for (const { uri, edits } of affected) {
    for (const ed of edits) {
      edit.replace(uri, toVsRange(ed.range), ed.newText);
    }
  }
  await vscode.workspace.applyEdit(edit);
}

/** Registers the tracker; called once from `ensureStarted()` (novel workspaces only). */
export function registerRenameTracking(): vscode.Disposable {
  return vscode.workspace.onDidRenameFiles((e) => {
    // Fire-and-forget: a tracker failure must never surface as an unhandled rejection.
    handleRenames(e).catch(() => undefined);
  });
}
