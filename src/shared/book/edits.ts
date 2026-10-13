/**
 * Pure edit planners for the Books panel's tree-as-form editing: each returns LSP-style
 * range replacements against the CURRENT `.jpbook` text, which the client applies as one
 * `WorkspaceEdit` (text stays the single source of truth — the panel and code mode can
 * never disagree). Metadata is edited by KEY, not by line: setting a key leaves ONE line
 * for it (an empty value is written as `key:`), and the lines of every other key stay where
 * they are.
 * The entry planners take an {@link EntryList} (chapters = body lines, covers = the `- path`
 * items under `cover:`) and never touch the other list.
 */
import {
  COVER_KEY,
  coverPathOf,
  entryIdentity,
  entryPathOf,
  FENCE,
  KNOWN_KEYS,
  isCover,
  isEntryOf,
  META_KEYS,
  metaLinesOf,
  metaKeyOf,
  metaLine,
  parseJpbook,
  type EntryList,
  type JpbookMeta,
  type MetaKey,
  type ParsedJpbook,
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
 * Removes the lines `first`..`last` whole. Their newlines go with them; a run that ends the
 * document swallows the PRECEDING newline instead, so no blank tail accumulates.
 */
function deleteRun(lines: readonly ParsedLine[], first: ParsedLine, last: ParsedLine): TextReplace {
  if (last.line + 1 < lines.length) {
    return { start: at(first.line, 0), end: at(last.line + 1, 0), newText: '' };
  }
  const prev = lines[first.line - 1];
  const start = prev === undefined ? at(first.line, 0) : at(prev.line, prev.raw.length);
  return { start, end: at(last.line, last.raw.length), newText: '' };
}

/** Deletes whole lines, each run of neighbours as ONE range: an edit overlapping another is dropped whole. */
function deleteLines(lines: readonly ParsedLine[], doomed: readonly ParsedLine[]): TextReplace[] {
  const runs: { first: ParsedLine; last: ParsedLine }[] = [];
  for (const pl of doomed) {
    const run = runs[runs.length - 1];
    if (run !== undefined && run.last.line + 1 === pl.line) {
      run.last = pl;
    } else {
      runs.push({ first: pl, last: pl });
    }
  }
  return runs.map((run) => deleteRun(lines, run.first, run.last));
}

/**
 * A metadata line written for `key`, whatever its kind: its valid line, a repeat, a rejected
 * value, an empty `title:`, or the key in another case or width. A chapter line never holds a
 * key, so a `header: h` below the fence (an invalid path) stays what it is.
 */
function holdsKey(pl: ParsedLine, key: MetaKey): boolean {
  return metaKeyOf(pl.value)?.normalize('NFKC').toLowerCase() === key.toLowerCase();
}

/**
 * Sets `key` to `value` in canonical `key: value` form (`key:` for an empty value). The key's
 * valid line — else the first line written for it — is rewritten in place and every other line
 * of the key is deleted; a key without a line is inserted at its position.
 */
export function setMeta(text: string, key: MetaKey, value: string): TextReplace[] {
  const parsed = parseJpbook(text);
  const clean = sanitizeValue(value);
  const held = metaLinesOf(parsed).filter((pl) => holdsKey(pl, key));
  const entry = metaLine(key, clean);
  const target = held.find((pl) => pl.kind === 'meta') ?? held[0];
  if (target === undefined) {
    return [insertMeta(parsed, eolOf(text), key, entry)];
  }
  return [
    { start: at(target.line, target.range.startChar), end: at(target.line, target.range.endChar), newText: entry },
    ...deleteLines(parsed.lines, held.filter((pl) => pl !== target)),
  ];
}

/**
 * Inserts a new key line at its {@link KNOWN_KEYS} position: after the nearest earlier
 * key the metadata holds (its line in Error included), else before the nearest later one, else
 * at the end of the metadata. `cover` is the last key, so a bare `cover:` is only ever a LATER
 * key: the insert goes above it, never right under it where it would close the list.
 */
function insertMeta(parsed: ParsedJpbook, eol: string, key: MetaKey, entry: string): TextReplace {
  const keyLines = new Map<string, ParsedLine>();
  for (const pl of metaLinesOf(parsed)) {
    const name = metaKeyOf(pl.value);
    if (name !== null && !keyLines.has(name)) {
      keyLines.set(name, pl);
    }
  }

  const order = KNOWN_KEYS.indexOf(key);
  const held = KNOWN_KEYS.map((k) => keyLines.get(k));
  const earlier = held.slice(0, order).findLast((pl) => pl !== undefined);
  if (earlier !== undefined) {
    return appendAfterLine(earlier, `${eol}${entry}`);
  }
  const later = held.slice(order + 1).find((pl) => pl !== undefined);
  if (later !== undefined) {
    return { start: at(later.line, 0), end: at(later.line, 0), newText: `${entry}${eol}` };
  }
  return insertAtMetaEnd(parsed, eol, entry);
}

/** Inserts metadata line(s) at the end of the metadata: right above the fence, else (no fence:
 *  the whole document is metadata) at the end of the document. */
function insertAtMetaEnd(parsed: ParsedJpbook, eol: string, block: string): TextReplace {
  if (parsed.fence === null) {
    return appendAtEnd(parsed.lines, eol, block);
  }
  return { start: at(parsed.fence, 0), end: at(parsed.fence, 0), newText: `${block}${eol}` };
}

/** The path an entry line lists (a cover item's marker excluded) — what the panel rows show and dedupe by. */
export function entryKeyOf(pl: ParsedLine): string {
  return entryPathOf(pl)?.value ?? pl.value;
}

/** The {@link entryIdentity} of each path already in `list` (a cover item's path excludes its marker) —
 *  the set GUI adds dedupe against, by the same identity. */
export function listedEntries(lines: readonly ParsedLine[], list: EntryList): Set<string> {
  return new Set(lines.filter(isEntryOf(list)).map((pl) => entryIdentity(entryKeyOf(pl))));
}

/**
 * Appends entries (root-relative paths) to `list`, skipping any already listed there (a GUI
 * add must not manufacture `duplicate` warnings). Chapters go at the end of the document,
 * below a `---` added first when none closes the metadata;
 * covers after the open list's last item (its indent and marker mirrored), or as a new
 * `cover:` key at the end of the metadata. Null when nothing is new.
 */
export function appendEntries(text: string, list: EntryList, rels: readonly string[]): TextReplace | null {
  const parsed = parseJpbook(text);
  const eol = eolOf(text);
  const listed = listedEntries(parsed.lines, list);
  const fresh = rels.filter((rel) => !listed.has(entryIdentity(rel)));
  if (fresh.length === 0) {
    return null;
  }
  if (list === 'chapters') {
    // No fence yet: close the metadata first, or the new lines would read as metadata.
    const lines = parsed.fence === null ? [FENCE, ...fresh] : fresh;
    return appendAtEnd(parsed.lines, eol, lines.join(eol));
  }

  // Only the first bare `cover:` opens a list (a repeat is a muted warning), so every
  // `isCover` line belongs to it.
  const key = parsed.lines.find((pl) => pl.kind === 'cover');
  if (key === undefined) {
    return insertAtMetaEnd(parsed, eol, [`${COVER_KEY}:`, ...fresh.map((rel) => `${COVER_ITEM_PREFIX}${rel}`)].join(eol));
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
 * Deletes the entry line entirely (the file itself is untouched), as {@link deleteRun} does.
 * A cover list emptied this way keeps its bare `cover:` line. Null when `line` is not an
 * entry of `list`.
 */
export function removeEntry(text: string, list: EntryList, line: number): TextReplace | null {
  const parsed = parseJpbook(text);
  const pl = entryAt(parsed.lines, list, line);
  return pl === null ? null : deleteRun(parsed.lines, pl, pl);
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
export function metaRows(meta: Partial<JpbookMeta>): { key: MetaKey; value: string | undefined }[] {
  return META_KEYS.map((key) => ({ key, value: meta[key] }));
}
