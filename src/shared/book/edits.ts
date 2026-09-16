/**
 * Pure edit planners for the Books panel's tree-as-form editing: each returns LSP-style
 * range replacements against the CURRENT `.jpbook` text, which the client applies as one
 * `WorkspaceEdit` (text stays the single source of truth — the panel and code mode can
 * never disagree). Metadata is UPSERT-ONLY by design: an existing key is edited in place
 * (its line never moves), an absent key is appended, and nothing here ever deletes or
 * reorders a metadata line — authors who care about metadata layout use code mode. The
 * entry planners take an {@link EntryList} (chapters = body lines, covers = the `- path`
 * items under `cover:`) and never touch the other list.
 */
import {
  COVER_KEY,
  coverPathOf,
  entryPathOf,
  isCover,
  isEntryOf,
  META_KEYS,
  metaKeyOf,
  metaRegionOf,
  parseJpbook,
  type EntryList,
  type JpbookMeta,
  type MetaKey,
  type ParsedLine,
} from './jpbook.ts';

/** One replacement (LSP coordinates; `end` exclusive; insertion = zero-width range). */
export interface TextReplace {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
  readonly newText: string;
}

/** README-style cover item prefix, used when the list has no existing item to mirror. */
const COVER_ITEM_PREFIX = '  - ';

/** The document's newline flavour, so inserted lines never mix EOLs into a CRLF file. */
function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function at(line: number, character: number): { line: number; character: number } {
  return { line, character };
}

/** Single-line values only: a pasted newline would break the line-per-entry grammar. */
function sanitizeValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Appends `text` as new line(s) at the end of the document: onto the trailing blank line when
 * one exists (empty document, or the '' line a final newline leaves after the split), else
 * after the last line's content.
 */
function appendAtEnd(lines: readonly ParsedLine[], eol: string, text: string): TextReplace {
  const last = lines[lines.length - 1];
  if (last === undefined || last.raw === '') {
    const line = last?.line ?? 0;
    return { start: at(line, 0), end: at(line, 0), newText: `${text}${eol}` };
  }
  return { start: at(last.line, last.raw.length), end: at(last.line, last.raw.length), newText: `${eol}${text}` };
}

/** Inserts `text` right after `pl`'s content — safe on the document's last line and in CRLF files. */
function appendAfterLine(pl: ParsedLine, text: string): TextReplace {
  return { start: at(pl.line, pl.raw.length), end: at(pl.line, pl.raw.length), newText: text };
}

/**
 * Sets `key` to `value` (canonical `key: value` form). The FIRST occurrence of the key —
 * the one the parser lets win — is rewritten in place; an absent key is appended at the
 * end of the front matter, and a missing block is created at the very top. Never deletes:
 * writing a default (or empty) value keeps the line.
 */
export function upsertMeta(text: string, key: MetaKey, value: string): TextReplace {
  const parsed = parseJpbook(text);
  const eol = eolOf(text);
  const clean = sanitizeValue(value);
  const entry = clean === '' ? `${key}:` : `${key}: ${clean}`;

  for (const pl of parsed.lines) {
    if (pl.kind === 'meta' && metaKeyOf(pl.value) === key) {
      return { start: at(pl.line, pl.range.startChar), end: at(pl.line, pl.range.endChar), newText: entry };
    }
  }
  return insertMetaBlock(parsed.lines, eol, entry);
}

/** Inserts front-matter line(s) at the end of the block, creating the block when absent. */
function insertMetaBlock(lines: readonly ParsedLine[], eol: string, block: string): TextReplace {
  const region = metaRegionOf(lines);
  if (region === null) {
    // No front matter: create the block above everything (the fence must be the first
    // non-blank line, and line 0 always satisfies that).
    return { start: at(0, 0), end: at(0, 0), newText: `---${eol}${block}${eol}---${eol}` };
  }
  if (region.close !== null) {
    return { start: at(region.close, 0), end: at(region.close, 0), newText: `${block}${eol}` };
  }
  // Unterminated block (an Error state): everything below the fence is already metadata
  // territory, so appending at the end of the document stays inside it.
  return appendAtEnd(lines, eol, block);
}

/** The path an entry line lists (a cover item's marker excluded) — what the panel rows show and dedupe by. */
export function entryKeyOf(pl: ParsedLine): string {
  return entryPathOf(pl)?.value ?? pl.value;
}

/** Paths already in `list` (a cover item's path excludes its marker) — the set GUI adds dedupe against. */
export function listedEntries(lines: readonly ParsedLine[], list: EntryList): Set<string> {
  return new Set(lines.filter(isEntryOf(list)).map(entryKeyOf));
}

/**
 * Appends entries (root-relative paths) to `list`, skipping any already listed there (a GUI
 * add must not manufacture `duplicate` warnings). Chapters go at the end of the document;
 * covers after the open list's last item (its indent and marker mirrored), or as a new
 * `cover:` key at the end of the front matter. Null when nothing is new.
 */
export function appendEntries(text: string, list: EntryList, rels: readonly string[]): TextReplace | null {
  const parsed = parseJpbook(text);
  const eol = eolOf(text);
  const listed = listedEntries(parsed.lines, list);
  const fresh = rels.filter((rel) => !listed.has(rel));
  if (fresh.length === 0) {
    return null;
  }
  if (list === 'chapters') {
    return appendAtEnd(parsed.lines, eol, fresh.join(eol));
  }

  // Only the first bare `cover:` opens a list (a repeat is a muted warning), so every
  // `isCover` line belongs to it.
  const key = parsed.lines.find((pl) => pl.kind === 'cover');
  if (key === undefined) {
    return insertMetaBlock(parsed.lines, eol, [`${COVER_KEY}:`, ...fresh.map((rel) => `${COVER_ITEM_PREFIX}${rel}`)].join(eol));
  }
  const items = parsed.lines.filter(isCover);
  const last = items[items.length - 1];
  const path = last === undefined ? null : coverPathOf(last);
  const prefix = last === undefined || path === null ? COVER_ITEM_PREFIX : last.raw.slice(0, path.range.startChar);
  return appendAfterLine(last ?? key, fresh.map((rel) => `${eol}${prefix}${rel}`).join(''));
}

/** The entry line of `list` at `line`, or null — the guard every mover uses (other lists are null). */
function entryAt(lines: readonly ParsedLine[], list: EntryList, line: number): ParsedLine | null {
  const pl = lines[line];
  return pl !== undefined && isEntryOf(list)(pl) ? pl : null;
}

/** A panel row as it was rendered: its document line and the path written there. */
export interface EntryRef {
  readonly line: number;
  readonly path: string;
}

/**
 * The row's line in the CURRENT text, or null when `line` no longer holds an entry of `list`
 * with that path. Exact only — never re-anchored by path (a file may be listed twice, and a
 * removed row's neighbour slides into its line). Callers pair it with a document-version check.
 */
export function resolveEntry(lines: readonly ParsedLine[], list: EntryList, ref: EntryRef): number | null {
  const pl = entryAt(lines, list, ref.line);
  return pl !== null && entryKeyOf(pl) === ref.path ? ref.line : null;
}

/**
 * Deletes the entry line entirely (the file itself is untouched). The trailing newline
 * goes with it; deleting the document's last line swallows the PRECEDING newline instead,
 * so no blank tail accumulates. A cover list emptied this way keeps its bare `cover:`
 * line. Null when `line` is not an entry of `list`.
 */
export function removeEntry(text: string, list: EntryList, line: number): TextReplace | null {
  const parsed = parseJpbook(text);
  const pl = entryAt(parsed.lines, list, line);
  if (pl === null) {
    return null;
  }
  if (line + 1 < parsed.lines.length) {
    return { start: at(line, 0), end: at(line + 1, 0), newText: '' };
  }
  const prev = parsed.lines[line - 1];
  const startPos = prev === undefined ? at(line, 0) : at(prev.line, prev.raw.length);
  return { start: startPos, end: at(line, pl.raw.length), newText: '' };
}

/**
 * Moves the entry at `fromLine` to sit BEFORE the entry at `beforeLine` (`null` = after the
 * list's last entry). Planned as delete + insert against the ORIGINAL text — the ranges
 * never overlap, so they apply as one `WorkspaceEdit`. Blank lines and metadata stay where
 * they are; only the entry line travels (with its own indent and marker). Null when the
 * move is a no-op or either line is not an entry of `list`.
 */
export function moveEntryTo(
  text: string,
  list: EntryList,
  fromLine: number,
  beforeLine: number | null,
): TextReplace[] | null {
  const parsed = parseJpbook(text);
  const eol = eolOf(text);
  const from = entryAt(parsed.lines, list, fromLine);
  if (from === null) {
    return null;
  }

  const removal = removeEntry(text, list, fromLine);
  if (removal === null) {
    return null;
  }

  const entries = parsed.lines.filter(isEntryOf(list));
  if (beforeLine !== null) {
    const target = entryAt(parsed.lines, list, beforeLine);
    if (target === null || beforeLine === fromLine) {
      return null; // not an entry of this list, or dropping onto itself
    }
    // No-op if `beforeLine` is already the entry immediately after `fromLine`. Blank lines can sit
    // between entries, so compare list ORDER, not raw line adjacency (fromLine + 1).
    const fromIdx = entries.findIndex((pl) => pl.line === fromLine);
    if (entries[fromIdx + 1]?.line === beforeLine) {
      return null;
    }
    return [removal, { start: at(beforeLine, 0), end: at(beforeLine, 0), newText: `${from.raw}${eol}` }];
  }

  const last = entries[entries.length - 1];
  if (last === undefined || last.line === fromLine) {
    return null; // already the last entry
  }
  return [removal, appendAfterLine(last, `${eol}${from.raw}`)];
}

/** The line numbers of `list`'s entries in document order — the panel's row → line mapping. */
export function entryLines(lines: readonly ParsedLine[], list: EntryList): number[] {
  return lines.filter(isEntryOf(list)).map((pl) => pl.line);
}

/** Fixed display order + current values for the panel's metadata rows (absent = undefined). */
export function metaRows(meta: JpbookMeta): { key: MetaKey; value: string | undefined }[] {
  return META_KEYS.map((key) => ({ key, value: meta[key] }));
}
