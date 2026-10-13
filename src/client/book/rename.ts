/**
 * Pure planning half of the rename tracking (import-style reference updates): given the
 * renames of one `onDidRenameFiles` event, compute the exact line edits each `.jpbook`
 * needs so its chapter paths keep pointing at the moved files. vscode-free — the event
 * wiring, the prompt, and the `WorkspaceEdit` live in `tracking.ts`; everything here is
 * unit-testable with plain paths.
 *
 * All paths are ABSOLUTE, POSIX-normalized fs paths (the caller normalizes `Uri.fsPath`).
 * A rename matches an entry either exactly (a file rename) or as a directory prefix (a
 * folder rename moves everything under it). Entries are relative to the book's OWNING
 * WORKSPACE FOLDER root — so moving a `.jpbook` itself never needs an update, and only a
 * target leaving the workspace folder is unrepresentable (reported, never rewritten into
 * a broken path).
 */
import { posix } from 'node:path';

import { entryPathOf, parseJpbook } from '../../shared/book/jpbook.ts';

/** One rename from the event, as normalized absolute paths. */
export interface FileRename {
  readonly oldPath: string;
  readonly newPath: string;
}

/** A single-line replacement (LSP-style 0-based line, [startChar, endChar) span). */
export interface BookEdit {
  readonly line: number;
  readonly startChar: number;
  readonly endChar: number;
  readonly newText: string;
}

export interface BookEditPlan {
  readonly edits: readonly BookEdit[];
  /** Entry values whose new location left the workspace folder (not rewritten). */
  readonly unrepresentable: readonly string[];
}

/** Backslashes → `/` (Windows `fsPath`); POSIX paths pass through unchanged. */
export function normalizeFsPath(p: string): string {
  return p.split('\\').join('/');
}

/** The moved target of `abs` under `renames`, or null when no rename touches it. */
function movedTo(abs: string, renames: readonly FileRename[]): string | null {
  for (const r of renames) {
    if (abs === r.oldPath) {
      return r.newPath;
    }
    if (abs.startsWith(`${r.oldPath}/`)) {
      return r.newPath + abs.slice(r.oldPath.length);
    }
  }
  return null;
}

/**
 * Computes the edits one `.jpbook` needs for `renames`, entries resolved against
 * `rootPath` (its owning workspace folder). Chapter and cover lines are rewritten,
 * duplicates included (a duplicate must keep duplicating whatever it duplicated); blank,
 * metadata, and error/warning lines are never touched. Each edit replaces exactly the
 * path span — a cover line's `- `/`cover: ` marker and any surrounding whitespace survive.
 */
export function planBookEdits(
  rootPath: string,
  text: string,
  renames: readonly FileRename[],
): BookEditPlan {
  const edits: BookEdit[] = [];
  const unrepresentable: string[] = [];

  for (const pl of parseJpbook(text).lines) {
    const entry = entryPathOf(pl);
    if (entry === null) {
      continue;
    }
    const abs = posix.normalize(posix.join(rootPath, entry.value));
    const target = movedTo(abs, renames);
    if (target === null) {
      continue;
    }
    const rel = posix.relative(rootPath, target);
    if (rel === '' || rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) {
      unrepresentable.push(entry.value);
      continue;
    }
    if (rel !== entry.value) {
      edits.push({ line: pl.line, startChar: entry.range.startChar, endChar: entry.range.endChar, newText: rel });
    }
  }
  return { edits, unrepresentable };
}
