/**
 * The vscode half of rename tracking: listens to `workspace.onDidRenameFiles` (AFTER the
 * rename — `onWillRenameFiles` participants run under a time budget that forbids prompting),
 * plans the reference updates via the pure `rename.ts`, asks per the
 * `jpnov.editor.updateRefsOnFileMove` setting (`prompt`/`always`/`never`, the TS
 * `updateImportsOnFileMove` triad — the toast's Always/Never buttons persist it globally),
 * and applies ONE `WorkspaceEdit` across every affected `.jpbook`. Edited books are left
 * dirty for the author to save, matching the platform convention.
 *
 * A moved `.jpbook` is a rename like any other: its own entries are rewritten so they keep
 * naming the same files. Renames from outside VS Code (Finder, terminal, git) fire no event;
 * the standing `jpbook.fileNotFound` diagnostics are the net for those.
 */
import * as vscode from 'vscode';

import type { TextReplace } from '#/shared/utils/position.ts';

import { toVsRange } from '../ranges.ts';
import { normalizeFsPath, planBookEdits, type FileRename } from './rename.ts';
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

/** Books the event touches (those under the workspace folders, and the open ones outside them), each with its edits (none = dropped). */
async function planAffectedBooks(
  renames: readonly FileRename[],
): Promise<{ uri: vscode.Uri; edits: readonly TextReplace[] }[]> {
  const found = await vscode.workspace.findFiles('**/*.jpbook', FIND_FILES_EXCLUDE);
  const books = [...found, ...vscode.workspace.textDocuments.filter(isOpenBook).map((d) => d.uri)];
  const affected: { uri: vscode.Uri; edits: readonly TextReplace[] }[] = [];
  for (const uri of books) {
    let doc: vscode.TextDocument;
    try {
      // openTextDocument yields the LIVE buffer when the book is open (dirty edits included).
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      continue; // unreadable (gone mid-event) — nothing to update
    }
    const edits = planBookEdits(normalizeFsPath(uri.fsPath), doc.getText(), renames);
    if (edits.length > 0) {
      affected.push({ uri, edits });
    }
  }
  return affected;
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
  const renames: FileRename[] = e.files
    .filter((f) => f.oldUri.scheme === 'file' && f.newUri.scheme === 'file')
    .map((f) => ({ oldPath: normalizeFsPath(f.oldUri.fsPath), newPath: normalizeFsPath(f.newUri.fsPath) }));
  if (renames.length === 0) {
    return;
  }

  const affected = await planAffectedBooks(renames);
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
