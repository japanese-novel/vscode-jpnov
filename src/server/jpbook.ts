/**
 * The impure (`node:fs`) half of the `*.jpbook` support: the single place where the pure
 * grammar/naming/completion logic in `#/shared/book/jpbook.ts` meets the filesystem. It
 * provides the three live editor features — diagnostics, completion, and document links —
 * and is also reused by the build (`build.ts`) so a `.jpbook`'s line-level diagnostics are
 * computed by exactly one code path. Callers parse once (`parseJpbook`) and hand the result
 * in, so an event never parses the same text twice.
 *
 * Entries are relative to the book's own directory (`dirUri`, the parent of the document URI),
 * which every function takes explicitly; nothing bounds them. Filesystem access is
 * `file:`-scheme only (the server never touches `vscode.fs`): off `file:` the existence checks
 * and path completion are skipped, and metadata completion (fs-free) works everywhere.
 *
 * vscode-free: only `import type`/value-imports of the language-SERVER package (never the
 * `vscode` module) are used here.
 */
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { CompletionItemKind, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { CompletionItem, Diagnostic, DocumentLink, Range } from 'vscode-languageserver/node';

import { scan } from '#/shared/ast/scan.ts';
import {
  charRange,
  completeEntryLine,
  completeMetaLine,
  COVER_KEY,
  entryPathOf,
  isNameList,
  itemShape,
  metaEndOf,
  NAME_LISTS,
  writtenKeysOf,
  type JpbookCompletion,
  type ParsedJpbook,
  type ParsedLine,
} from '#/shared/book/jpbook.ts';
import { afterSpace } from '#/shared/utils/strings.ts';
import { nameConflicts } from '#/shared/book/names.ts';
import { unencodableChars } from '#/shared/encoding.ts';

import { diagnostic } from './diagnostics.ts';
import { isFileScheme, resolveUri } from './fsUri.ts';
import type { BookNames } from './highlight/vocabulary.ts';
import { INDENT_TOO_LARGE } from './syntax.ts';

/** The on-line span of a parsed line as an LSP {@link Range}. */
function lineRange(pl: ParsedLine): Range {
  return charRange(pl.line, pl.range);
}

/**
 * Warns for each character of a `divider` value that Shift JIS cannot hold. Only `divider` is
 * checked: it is the one metadata value that reaches the built `.txt`, and it repeats at every
 * chapter seam. This is manifest validation like every other `jpbook.*` diagnostic, NOT the
 * `shiftJisSafe` prose rule — that one never sees a `.jpbook`, and a divider is a symbol rather
 * than a character an author mistyped.
 *
 * A 字下げ above the notation's maximum warns too, as it does in a manuscript: the value is not
 * indented by it and the annotation prints as a comment at every seam.
 */
function dividerWarnings(pl: ParsedLine): Diagnostic[] {
  const field = pl.meta;
  if (field?.key !== 'divider') {
    return [];
  }
  const { value, range } = field;
  // Offsets within the value, so each range lands on the character itself.
  const at = (start: number, end: number): Range =>
    charRange(pl.line, { startChar: range.startChar + start, endChar: range.startChar + end });
  return [
    ...unencodableChars(value).map(({ cluster, offset, length }) => diagnostic(
      at(offset, offset + length),
      { code: 'jpbook.dividerNotEncodable', args: [cluster] },
      DiagnosticSeverity.Warning,
    )),
    ...scan(value).issues
      .filter((issue) => issue.kind === 'indentTooLarge')
      .map(({ span }) => diagnostic(at(span.start, span.end), INDENT_TOO_LARGE, DiagnosticSeverity.Warning)),
  ];
}

/** Classifies a `file:` URI on disk; a path that resolves nowhere (null) and any error (incl. ENOENT) are `'missing'`. */
async function statEntry(uri: string | null): Promise<'file' | 'dir' | 'missing'> {
  if (uri === null) {
    return 'missing';
  }
  try {
    const s = await stat(fileURLToPath(uri));
    return s.isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}

/** The Error an entry line earns by {@link statEntry}'s verdict; a present file earns none. */
const EXISTENCE_CODES = { missing: 'jpbook.fileNotFound', dir: 'jpbook.entryIsDirectory' } as const;

/** The existence Error of one entry line, or undefined for a present file. */
async function existenceDiagnostic(uri: string | null, range: Range, value: string): Promise<Diagnostic | undefined> {
  const verdict = await statEntry(uri);
  return verdict === 'file'
    ? undefined
    : diagnostic(range, { code: EXISTENCE_CODES[verdict], args: [value] }, DiagnosticSeverity.Error);
}

async function readDirEntries(dirUri: string): Promise<{ name: string; isDir: boolean }[]> {
  try {
    const dirents = await readdir(fileURLToPath(dirUri), { withFileTypes: true });
    return dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  } catch {
    return [];
  }
}

/**
 * Per-line diagnostics for one parsed `.jpbook`: syntax/metadata errors and warnings (from
 * {@link parseJpbook}'s line kinds), then, on a `file:` book, existence (a missing path or one
 * resolving to a directory is an Error), then the names `others` (the books sharing a page with
 * this one) write differently. Used by both the live editor handler and the build, so the two never
 * disagree. The entries are stat'ed together: a book of fifty chapters waits for one round trip,
 * not fifty.
 */
export async function diagnoseJpbook(dirUri: string, parsed: ParsedJpbook, others: readonly BookNames[]): Promise<Diagnostic[]> {
  const canCheckFs = isFileScheme(dirUri);
  // In line order: a path line holds its slot while its stat runs, and the slot stays empty for a present file.
  const diagnostics: (Diagnostic | undefined)[] = [];
  const checks: Promise<void>[] = [];

  if (parsed.metaError !== null) {
    const { line, range, error } = parsed.metaError;
    diagnostics.push(diagnostic(charRange(line, range), error, DiagnosticSeverity.Error));
  }

  for (const pl of parsed.lines) {
    if (pl.kind === 'meta') {
      diagnostics.push(...dividerWarnings(pl));
      continue;
    }
    if (typeof pl.kind === 'object') {
      const range = lineRange(pl);
      if ('error' in pl.kind) {
        diagnostics.push(diagnostic(range, pl.kind.error, DiagnosticSeverity.Error));
      } else {
        diagnostics.push(diagnostic(range, pl.kind.warning, DiagnosticSeverity.Warning));
      }
      continue;
    }
    // An item's span is its VALUE, so squiggles skip the marker.
    const item = pl.item;
    if (item === undefined) {
      continue;
    }
    const range = charRange(pl.line, item.range);
    if (pl.kind === 'duplicate' || pl.kind === 'coverDuplicate' || pl.kind === 'nameDuplicate') {
      diagnostics.push(
        diagnostic(range, { code: 'jpbook.duplicateEntry', args: [item.value] }, DiagnosticSeverity.Warning),
      );
      continue;
    }
    const entry = entryPathOf(pl);
    if (entry === null || !canCheckFs) {
      continue; // a name is no path; existence unverifiable off `file:` — leave the path un-flagged.
    }
    const slot = diagnostics.push(undefined) - 1;
    checks.push(existenceDiagnostic(resolveUri(dirUri, entry.value), range, entry.value).then((d) => {
      diagnostics[slot] = d;
    }));
  }

  for (const list of NAME_LISTS) {
    const neighbours = others.map((book) => ({ label: book.fileRel, names: book.names[list] }));
    for (const conflict of nameConflicts(parsed.names[list], neighbours)) {
      const item = parsed.lines[conflict.line]?.item;
      if (item !== undefined) {
        diagnostics.push(diagnostic(
          charRange(conflict.line, item.range),
          { code: 'jpbook.nameConflict', args: [conflict.base, conflict.label] },
          DiagnosticSeverity.Warning,
        ));
      }
    }
  }
  await Promise.all(checks);
  return diagnostics.filter((d) => d !== undefined);
}

/**
 * Cmd+click targets: one {@link DocumentLink} per syntactically-valid chapter or cover line
 * (`ok`/`duplicate`/`coverEntry`/`coverDuplicate`), pointing at the file URI resolved from the
 * book's directory; a cover line's link covers just its path portion. Blank, metadata and
 * error/warning lines get no link. No fs access: links resolve as URIs and are cheap, so a
 * not-yet-existing target still links (its squiggle says so).
 */
export function documentLinksForJpbook(dirUri: string, parsed: ParsedJpbook): DocumentLink[] {
  return parsed.lines.flatMap((pl) => {
    const entry = entryPathOf(pl);
    if (entry === null) {
      return [];
    }
    const target = resolveUri(dirUri, entry.value);
    return target === null ? [] : [{ range: charRange(pl.line, entry.range), target }];
  });
}

/** A pure {@link JpbookCompletion} as an LSP {@link CompletionItem} on `line`. */
function toCompletionItem(c: JpbookCompletion, line: number): CompletionItem {
  const kind =
    c.kind === 'folder'
      ? CompletionItemKind.Folder
      : c.kind === 'key'
        ? CompletionItemKind.Property
        : c.kind === 'value'
          ? CompletionItemKind.EnumMember
          : CompletionItemKind.File;
  const item: CompletionItem = {
    label: c.label,
    kind,
    textEdit: {
      range: charRange(line, c.replace),
      newText: c.insertText,
    },
  };
  if (c.kind === 'folder') {
    item.command = { title: 'Suggest', command: 'editor.action.triggerSuggest' };
  }
  return item;
}

/** Path start column on a cover line (a `- ` item or `cover: `), from the cursor prefix; null off-shape. */
function coverPathStart(prefix: string): number | null {
  const indent = afterSpace(prefix);
  const shape = itemShape(prefix.slice(indent), COVER_KEY);
  return shape === null ? null : indent + shape.offset;
}

/**
 * Completions for the cursor on `lineText` at `position`. In the metadata (above the closing
 * `---`, or the whole file while none closes it) it offers the keys not yet written / enum
 * values — pure, fs-free — and, on cover-shaped lines (`- ` items, `cover: `), file paths; a
 * line of a name list (`characters:`, `keywords:`, their items) gets nothing, a name being no
 * path. On chapter lines it lists the directory the current path prefix points into (from the
 * book's directory, `..` included) and hands it to the pure {@link completeEntryLine}; the path
 * branch returns nothing off `file:`, or when the line's path already names an existing file
 * with the cursor at its end (per the "no more suggestions once the line matches" rule). Folder
 * items re-trigger suggestions so the user keeps drilling. The header and fence lines offer
 * nothing, nor does a book whose header no parser reads.
 */
export async function completeJpbook(
  dirUri: string,
  parsed: ParsedJpbook,
  lineText: string,
  position: { line: number; character: number },
): Promise<CompletionItem[]> {
  const current = parsed.lines[position.line];
  const kind = current?.kind;
  if (parsed.lines[0]?.kind !== 'header' || kind === 'header' || kind === 'fence') {
    return []; // a book no parser read, the header, the fence: nothing sensible to offer
  }
  if (current?.list !== undefined && isNameList(current.list)) {
    return []; // a name list's key or item: free text, nothing to propose
  }
  const prefix = lineText.slice(0, position.character);

  // Path completion for the text from `pathStart` on; chapter lines pass 0, cover lines the
  // column after their `- `/`cover: ` marker (returned spans shift back to line columns).
  const completePathAt = async (pathStart: number): Promise<CompletionItem[]> => {
    if (!isFileScheme(dirUri)) {
      return [];
    }

    // Suppress when nothing meaningful follows the cursor and the path already names a file.
    const whole = lineText.slice(pathStart).trim();
    if (whole !== '' && prefix.slice(pathStart).trim() === whole) {
      if ((await statEntry(resolveUri(dirUri, whole))) === 'file') {
        return [];
      }
    }

    const pathSoFar = prefix.slice(afterSpace(prefix, pathStart));
    const lastSlash = pathSoFar.lastIndexOf('/');
    // No directory part lists the book's own directory; `..` its parent.
    const listDirUri = resolveUri(dirUri, pathSoFar.slice(0, lastSlash + 1));
    if (listDirUri === null) {
      return [];
    }

    const entries = await readDirEntries(listDirUri);
    return completeEntryLine(prefix.slice(pathStart), entries).map((c) =>
      toCompletionItem(
        {
          ...c,
          replace: { startChar: c.replace.startChar + pathStart, endChar: c.replace.endChar + pathStart },
        },
        position.line,
      ),
    );
  };

  if (position.line < metaEndOf(parsed)) {
    const pathStart = coverPathStart(prefix);
    if (pathStart !== null) {
      return completePathAt(pathStart);
    }
    return completeMetaLine(prefix, writtenKeysOf(parsed, position.line)).map((c) => toCompletionItem(c, position.line));
  }
  return completePathAt(0);
}
