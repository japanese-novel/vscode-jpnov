/**
 * Pure edit planners for the Books view's editing: each returns LSP-style
 * range replacements against the CURRENT `.jpbook` text, which the client applies as one
 * `WorkspaceEdit` (text stays the single source of truth — the panel and code mode can
 * never disagree). Metadata is edited by KEY, not by line: setting a key leaves ONE line
 * for it (an empty value is written as `key:`), and the lines of every other key stay where
 * they are.
 * The entry planners take an {@link EntryList} (chapters = body lines; covers, characters and
 * keywords = the `- item` lines under their key, the key's own value included) and never touch
 * another list.
 */
import {
  charRange,
  FENCE,
  KNOWN_KEYS,
  identityOf,
  inlineKeyOf,
  isEntryOf,
  listKeyOf,
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
import type { Position, TextReplace } from '../utils/position.ts';

/** README-style list item prefix, used when the list has no existing item to mirror. */
const ITEM_PREFIX = '  - ';

/** The document's newline flavour, so inserted lines never mix EOLs into a CRLF file. */
function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function at(line: number, character: number): Position {
  return { line, character };
}

const replace = (start: Position, end: Position, newText: string): TextReplace => ({ range: { start, end }, newText });
/** A zero-width replace: `newText` goes in at (`line`, `character`). */
const insert = (line: number, character: number, newText: string): TextReplace => replace(at(line, character), at(line, character), newText);

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
    return insert(line, 0, `${text}${eol}`);
  }
  return insert(last.line, last.raw.length, `${eol}${text}`);
}

/** Inserts `text` right after `pl`'s content — safe on the document's last line and in CRLF files. */
function appendAfterLine(pl: ParsedLine, text: string): TextReplace {
  return insert(pl.line, pl.raw.length, text);
}

/**
 * Removes the lines `first`..`last` whole. Their newlines go with them; a run that ends the
 * document swallows the PRECEDING newline instead, so no blank tail accumulates.
 */
function deleteRun(lines: readonly ParsedLine[], first: ParsedLine, last: ParsedLine): TextReplace {
  if (last.line + 1 < lines.length) {
    return replace(at(first.line, 0), at(last.line + 1, 0), '');
  }
  const prev = lines[first.line - 1];
  const start = prev === undefined ? at(first.line, 0) : at(prev.line, prev.raw.length);
  return replace(start, at(last.line, last.raw.length), '');
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

/** Every metadata line written for `key`, in document order. */
function linesOfKey(parsed: ParsedJpbook, key: MetaKey): ParsedLine[] {
  return metaLinesOf(parsed).filter((pl) => holdsKey(pl, key));
}

/**
 * Sets `key` to `value` in canonical `key: value` form (`key:` for an empty value). The key's
 * valid line — else the first line written for it — is rewritten in place and every other line
 * of the key is deleted; a key without a line is inserted at its position.
 */
export function setMeta(text: string, key: MetaKey, value: string): TextReplace[] {
  const parsed = parseJpbook(text);
  const clean = sanitizeValue(value);
  const held = linesOfKey(parsed, key);
  const entry = metaLine(key, clean);
  const target = held.find((pl) => pl.kind === 'meta') ?? held[0];
  if (target === undefined) {
    return [insertMeta(parsed, eolOf(text), key, entry)];
  }
  return [
    { range: charRange(target.line, target.range), newText: entry },
    ...deleteLines(parsed.lines, held.filter((pl) => pl !== target)),
  ];
}

/**
 * Deletes every line written for `key` (its valid line, a repeat, a line in Error), so the key
 * goes back to unwritten: its default applies. Empty when no line holds it.
 */
export function removeMeta(text: string, key: MetaKey): TextReplace[] {
  const parsed = parseJpbook(text);
  return deleteLines(parsed.lines, linesOfKey(parsed, key));
}

/**
 * Inserts a new key line at its {@link KNOWN_KEYS} position: after the nearest earlier
 * key the metadata holds (its line in Error included), else before the nearest later one, else
 * at the end of the metadata. The list keys come last, so a list's key line is only ever a LATER
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
    return insert(later.line, 0, `${entry}${eol}`);
  }
  return insertAtMetaEnd(parsed, eol, entry);
}

/** Inserts metadata line(s) at the end of the metadata: right above the fence, else (no fence:
 *  the whole document is metadata) at the end of the document. */
function insertAtMetaEnd(parsed: ParsedJpbook, eol: string, block: string): TextReplace {
  if (parsed.fence === null) {
    return appendAtEnd(parsed.lines, eol, block);
  }
  return insert(parsed.fence, 0, `${block}${eol}`);
}

/** The value an entry line lists (an item's marker excluded) — what the panel rows show and dedupe by. */
export function entryKeyOf(pl: ParsedLine): string {
  return pl.item?.value ?? pl.value;
}

/** The identity of each entry already in `list` — the set GUI adds dedupe against, by {@link identityOf}. */
export function listedEntries(lines: readonly ParsedLine[], list: EntryList): Set<string> {
  return new Set(lines.filter(isEntryOf(list)).map((pl) => pl.item?.identity ?? pl.value));
}

/**
 * Appends entries (paths from the book's folder, or names) to `list`, skipping any already
 * listed there (a GUI add must not manufacture duplicate warnings). Chapters go at the end of the
 * document, below a `---` added first when none closes the metadata; the items of a keyed list
 * after its last item (the indent and marker of the last `- ` item mirrored), or as a new key at
 * the end of the metadata. Null when nothing is new.
 */
export function appendEntries(text: string, list: EntryList, values: readonly string[]): TextReplace | null {
  const parsed = parseJpbook(text);
  const eol = eolOf(text);
  const listed = listedEntries(parsed.lines, list);
  const fresh = values.filter((value) => !listed.has(identityOf(list, value)));
  if (fresh.length === 0) {
    return null;
  }
  if (list === 'chapters') {
    // No fence yet: close the metadata first, or the new lines would read as metadata.
    const lines = parsed.fence === null ? [FENCE, ...fresh] : fresh;
    return appendAtEnd(parsed.lines, eol, lines.join(eol));
  }

  // Only the first line of a key opens its list (a repeat is a muted warning), so every entry
  // line of the list belongs to it.
  const keyName = listKeyOf(list);
  const key = metaLinesOf(parsed).find((pl) => metaKeyOf(pl.value) === keyName);
  if (key === undefined) {
    return insertAtMetaEnd(parsed, eol, [metaLine(keyName, ''), ...fresh.map((value) => `${ITEM_PREFIX}${value}`)].join(eol));
  }
  const items = parsed.lines.filter(isEntryOf(list));
  const last = items[items.length - 1];
  return appendAfterLine(last ?? key, fresh.map((value) => `${eol}${itemPrefix(last)}${value}`).join(''));
}

/** What precedes a `- ` item's value on its line (indent and marker); the README-style prefix off an item. */
function itemPrefix(item: ParsedLine | undefined): string {
  if (item?.item === undefined || inlineKeyOf(item) !== null) {
    return ITEM_PREFIX;
  }
  return item.raw.slice(0, item.item.range.startChar);
}

/** An entry as a `- ` item line: an inline `key: value` becomes `  - value`, an item travels as written. */
function asItem(pl: ParsedLine): string {
  return inlineKeyOf(pl) !== null ? `${ITEM_PREFIX}${entryKeyOf(pl)}` : pl.raw;
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
 * Deletes the entry line entirely (the file itself is untouched), as {@link deleteRun} does;
 * an inline `key: value` keeps its key and loses its value, so the list stays open. Null
 * when `line` is not an entry of `list`.
 */
export function removeEntry(text: string, list: EntryList, line: number): TextReplace | null {
  const parsed = parseJpbook(text);
  const pl = entryAt(parsed.lines, list, line);
  if (pl === null) {
    return null;
  }
  const inlineKey = inlineKeyOf(pl);
  if (inlineKey !== null) {
    return { range: charRange(pl.line, pl.range), newText: metaLine(inlineKey, '') };
  }
  return deleteRun(parsed.lines, pl, pl);
}

/**
 * Rewrites the entry's value in place (its marker, indent or key kept), as the panel's input box
 * sets a name. Null when `line` is not an entry of `list`, or the value is empty once sanitized.
 */
export function replaceEntry(text: string, list: EntryList, line: number, value: string): TextReplace | null {
  const parsed = parseJpbook(text);
  const pl = entryAt(parsed.lines, list, line);
  const clean = sanitizeValue(value);
  if (pl?.item === undefined || clean === '') {
    return null;
  }
  return { range: charRange(pl.line, pl.item.range), newText: clean };
}

/**
 * Moves the entry at `fromLine` to sit BEFORE the entry at `beforeLine` (`null` = after the
 * list's last entry). Planned as delete + insert against the ORIGINAL text — the ranges
 * never overlap, so they apply as one `WorkspaceEdit`. Blank lines and metadata stay where
 * they are; only the entry line travels (with its own indent and marker; an inline
 * `key: value` travels as a `- ` item, and moving an entry before it turns it into one under
 * the bare key). Null when the move is a no-op or either line is not an entry of `list`.
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
    const inlineKey = inlineKeyOf(target);
    if (inlineKey !== null) {
      const block = [metaLine(inlineKey, ''), asItem(from), asItem(target)].join(eol);
      return [removal, { range: charRange(target.line, target.range), newText: block }];
    }
    return [removal, insert(beforeLine, 0, `${asItem(from)}${eol}`)];
  }

  const last = entries[entries.length - 1];
  if (last === undefined || last.line === fromLine) {
    return null; // already the last entry
  }
  return [removal, appendAfterLine(last, `${eol}${asItem(from)}`)];
}

/** The line numbers of `list`'s entries in document order — the panel's row → line mapping. */
export function entryLines(lines: readonly ParsedLine[], list: EntryList): number[] {
  return lines.filter(isEntryOf(list)).map((pl) => pl.line);
}

/** Fixed display order + the values written for the panel's metadata rows (unwritten = undefined: the default applies). */
export function metaRows(meta: Partial<JpbookMeta>): { key: MetaKey; value: string | undefined }[] {
  return META_KEYS.map((key) => ({ key, value: meta[key] }));
}
