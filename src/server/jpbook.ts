/**
 * The impure (`node:fs`) half of the `*.jpbook` support: the single place where the pure
 * grammar/naming/completion logic in `#/shared/book/jpbook.ts` meets the filesystem. It
 * provides the three live editor features — diagnostics, completion, and document links —
 * and is also reused by the build (`build.ts`) so a `.jpbook`'s line-level diagnostics are
 * computed by exactly one code path. Callers parse once (`parseJpbook`) and hand the result
 * in, so an event never parses the same text twice.
 *
 * Entries are relative to the book's OWNING WORKSPACE FOLDER root (`rootUri`), which every
 * function takes explicitly — the live handlers look it up via `context.roots.rootOf`, the
 * build passes its target root. A null root (a `.jpbook` outside every workspace folder)
 * degrades to syntax/metadata-only: no containment or existence checks, no links, no path
 * completion. Filesystem access is `file:`-scheme only (the server never touches
 * `vscode.fs`); a non-`file:` root degrades the same way existence-wise, and metadata
 * completion (fs-free) works everywhere.
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
  colonIndex,
  completeEntryLine,
  completeMetaLine,
  entryPathOf,
  isCoverMark,
  metaEndOf,
  metaKeyOf,
  writtenKeysOf,
  type JpbookCompletion,
  type JpbookRange,
  type ParsedJpbook,
  type ParsedLine,
} from '#/shared/book/jpbook.ts';
import { resolveContained } from '#/shared/config/validate.ts';
import { unencodableChars } from '#/shared/encoding.ts';

import { diagnostic } from './diagnostics.ts';
import { isFileScheme } from './fsUri.ts';
import { INDENT_TOO_LARGE } from './syntax.ts';

/** A column span on `line` as an LSP {@link Range}. */
function charRange(line: number, span: JpbookRange): Range {
  return {
    start: { line, character: span.startChar },
    end: { line, character: span.endChar },
  };
}

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
  if (metaKeyOf(pl.value) !== 'divider') {
    return [];
  }
  const afterColon = pl.value.slice(colonIndex(pl.value) + 1);
  const value = afterColon.trim();
  // Offset of the trimmed value within the line, so each range lands on the character itself.
  const base = pl.range.startChar + (pl.value.length - afterColon.length) +
    (afterColon.length - afterColon.trimStart().length);
  const at = (start: number, end: number): Range =>
    charRange(pl.line, { startChar: base + start, endChar: base + end });
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

/** Classifies a `file:` URI on disk; any error (incl. ENOENT) is `'missing'`. */
async function statEntry(uri: string): Promise<'file' | 'dir' | 'missing'> {
  try {
    const s = await stat(fileURLToPath(uri));
    return s.isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
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
 * {@link parseJpbook}'s line kinds), then — root permitting — containment/escape rejections
 * (via {@link resolveContained}) and, on a `file:` root, existence (a missing path or one
 * resolving to a directory is an Error). Used by both the live editor handler and the
 * build, so the two never disagree.
 */
export async function diagnoseJpbook(rootUri: string | null, parsed: ParsedJpbook): Promise<Diagnostic[]> {
  const canCheckFs = rootUri !== null && isFileScheme(rootUri);
  const diagnostics: Diagnostic[] = [];

  for (const metaError of parsed.metaErrors) {
    diagnostics.push(diagnostic(charRange(metaError.line, metaError.range), metaError.error, DiagnosticSeverity.Error));
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
    // A cover item's span is its PATH, so squiggles skip the marker.
    const entry = entryPathOf(pl);
    if (entry === null) {
      continue;
    }
    const range = charRange(pl.line, entry.range);
    if (pl.kind === 'duplicate' || pl.kind === 'coverDuplicate') {
      diagnostics.push(
        diagnostic(range, { code: 'jpbook.duplicateEntry', args: [entry.value] }, DiagnosticSeverity.Warning),
      );
      continue;
    }
    if (rootUri === null) {
      continue; // no owning workspace folder — containment/existence unverifiable
    }
    const resolved = resolveContained(rootUri, entry.value);
    if (!resolved.ok) {
      diagnostics.push(diagnostic(range, { code: resolved.code }, DiagnosticSeverity.Error));
      continue;
    }
    if (!canCheckFs) {
      continue; // existence unverifiable off `file:` — leave the path un-flagged.
    }
    const verdict = await statEntry(resolved.abs);
    if (verdict === 'missing') {
      diagnostics.push(
        diagnostic(range, { code: 'jpbook.fileNotFound', args: [entry.value] }, DiagnosticSeverity.Error),
      );
    } else if (verdict === 'dir') {
      diagnostics.push(
        diagnostic(range, { code: 'jpbook.entryIsDirectory', args: [entry.value] }, DiagnosticSeverity.Error),
      );
    }
  }
  return diagnostics;
}

/**
 * Cmd+click targets: one {@link DocumentLink} per syntactically-valid, contained chapter or
 * cover line (`ok`/`duplicate`/`coverEntry`/`coverDuplicate`), pointing at the root-resolved
 * file URI; a cover line's link covers just its path portion. Blank, metadata,
 * error/warning lines — and every line when no root owns the book — get no link. No fs
 * access: links resolve as URIs and are cheap, so a not-yet-existing target still links
 * (its squiggle says so).
 */
export function documentLinksForJpbook(rootUri: string | null, parsed: ParsedJpbook): DocumentLink[] {
  if (rootUri === null) {
    return [];
  }
  return parsed.lines.flatMap((pl) => {
    const entry = entryPathOf(pl);
    if (entry === null) {
      return [];
    }
    const resolved = resolveContained(rootUri, entry.value);
    return resolved.ok ? [{ range: charRange(pl.line, entry.range), target: resolved.abs }] : [];
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
      range: {
        start: { line, character: c.replace.startChar },
        end: { line, character: c.replace.endChar },
      },
      newText: c.insertText,
    },
  };
  if (c.kind === 'folder') {
    item.command = { title: 'Suggest', command: 'editor.action.triggerSuggest' };
  }
  return item;
}

/** Path start column on a `- ` cover item line, from the cursor prefix; null off-shape. */
function coverPathStart(prefix: string): number | null {
  let i = 0;
  while (i < prefix.length && /\s/.test(prefix.charAt(i))) {
    i += 1;
  }
  if (!isCoverMark(prefix.charAt(i))) {
    return null;
  }
  i += 1;
  while (i < prefix.length && /\s/.test(prefix.charAt(i))) {
    i += 1;
  }
  return i;
}

/**
 * Completions for the cursor on `lineText` at `position`. In the metadata (above the closing
 * `---`, or the whole file while none closes it) it offers the keys not yet written / enum
 * values — pure, fs-free, so it works with or without a root — and, on cover-shaped lines
 * (`- ` items, `cover: `), file paths. On chapter lines it lists the directory the current
 * path prefix points into (relative to the OWNING ROOT) and hands it to the pure
 * {@link completeEntryLine}; the path branch returns nothing without a `file:` root, or when
 * the line's path already names an existing file with the cursor at its end (per the "no more
 * suggestions once the line matches" rule). Folder items re-trigger suggestions so the user
 * keeps drilling. The header and fence lines offer nothing, nor does a book whose header no
 * parser reads.
 */
export async function completeJpbook(
  rootUri: string | null,
  parsed: ParsedJpbook,
  lineText: string,
  position: { line: number; character: number },
): Promise<CompletionItem[]> {
  const kind = parsed.lines[position.line]?.kind;
  if (parsed.lines[0]?.kind !== 'header' || kind === 'header' || kind === 'fence') {
    return []; // a book no parser read, the header, the fence: nothing sensible to offer
  }
  const prefix = lineText.slice(0, position.character);

  // Path completion for the text from `pathStart` on; chapter lines pass 0, cover lines the
  // column after their `- `/`cover: ` marker (returned spans shift back to line columns).
  const completePathAt = async (pathStart: number): Promise<CompletionItem[]> => {
    if (rootUri === null || !isFileScheme(rootUri)) {
      return [];
    }

    // Suppress when nothing meaningful follows the cursor and the path already names a file.
    const whole = lineText.slice(pathStart).trim();
    if (whole !== '' && prefix.slice(pathStart).trim() === whole) {
      const resolvedWhole = resolveContained(rootUri, whole);
      if (resolvedWhole.ok && (await statEntry(resolvedWhole.abs)) === 'file') {
        return [];
      }
    }

    const pathSoFar = prefix.slice(pathStart).replace(/^\s+/, '');

    // A leading "/" is an absolute path — never a valid entry — so offer nothing rather than
    // misleadingly listing the workspace folder root.
    if (pathSoFar.startsWith('/')) {
      return [];
    }

    const lastSlash = pathSoFar.lastIndexOf('/');
    const dirPortion = lastSlash >= 0 ? pathSoFar.slice(0, lastSlash) : '';

    let listDirUri: string;
    if (dirPortion === '' || dirPortion === '.') {
      // No directory part, or an explicit "./" — list the workspace folder root itself.
      listDirUri = rootUri;
    } else {
      // The label is irrelevant here — a containment failure just yields no completions.
      const resolvedDir = resolveContained(rootUri, dirPortion);
      if (!resolvedDir.ok) {
        return [];
      }
      listDirUri = resolvedDir.abs;
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
