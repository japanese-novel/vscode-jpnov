/**
 * Pure planning half of the rename tracking (import-style reference updates): given the
 * renames of one `onDidRenameFiles` event, compute the exact line edits each `.jpbook`
 * needs so its chapter and cover paths keep pointing at the moved files. vscode-free — the event
 * wiring, the prompt, and the `WorkspaceEdit` live in `tracking.ts`; everything here is
 * unit-testable with plain paths.
 *
 * All paths are ABSOLUTE, POSIX-normalized fs paths (the caller normalizes `Uri.fsPath`).
 * A rename matches a path either exactly (a file rename) or as a directory prefix (a folder
 * rename moves everything under it). Entries count from the book's own folder, `../` allowed,
 * so a moved book rewrites its entries to keep naming the same files, and a book moved along
 * with its chapters needs nothing.
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
 * Computes the edits one `.jpbook` needs for `renames`; `bookPath` is the book's own path AFTER
 * the event (its path before is found back through the renames). Chapter and cover lines are
 * rewritten when the file they named now sits elsewhere relative to the book, duplicates
 * included (a duplicate must keep duplicating whatever it duplicated); blank, metadata, and
 * error/warning lines are never touched. Each edit replaces exactly the path span — a cover
 * line's `- `/`cover: ` marker and any surrounding whitespace survive.
 */
export function planBookEdits(bookPath: string, text: string, renames: readonly FileRename[]): BookEdit[] {
  const inverted = renames.map((r) => ({ oldPath: r.newPath, newPath: r.oldPath }));
  const oldDir = posix.dirname(movedTo(bookPath, inverted) ?? bookPath);
  const newDir = posix.dirname(bookPath);
  const edits: BookEdit[] = [];

  for (const pl of parseJpbook(text).lines) {
    const entry = entryPathOf(pl);
    if (entry === null) {
      continue;
    }
    const oldAbs = posix.resolve(oldDir, entry.value);
    const newAbs = movedTo(oldAbs, renames) ?? oldAbs;
    if (posix.resolve(newDir, entry.value) !== newAbs) {
      const rel = posix.relative(newDir, newAbs);
      edits.push({ line: pl.line, startChar: entry.range.startChar, endChar: entry.range.endChar, newText: rel });
    }
  }
  return edits;
}
