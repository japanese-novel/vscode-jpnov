/**
 * Pure, vscode-free parsing of the per-book `*.jpbook` manifest, plus per-book chrome
 * composition and the fs-free completion logic.
 *
 * A `.jpbook` opens with its header line ({@link HEADER}: the format and its version), then its
 * metadata — the seven `key: value` lines of {@link META_KEYS} (`title` required, the rest at
 * {@link META_DEFAULTS} when unwritten), plus the optional lists `cover:`, `characters:` and
 * `keywords:` — closes it with a `---` line, and continues with one chapter path per line.
 *
 * Chapter and cover paths are relative to the DIRECTORY OF THE `.jpbook`, as an `import` is to
 * its module: `a.jpnov`, `./a.jpnov`, `../drafts/a.jpnov`, and nothing bounds them. The
 * `.jpbook`'s own name is the output name (`vol1.jpbook` builds `vol1`); metadata never affects
 * it.
 *
 * Syntax and completion decisions only — never the filesystem: an `'ok'` line means "a
 * backslash-free `.jpnov` path"; the server (`src/server/jpbook.ts`) resolves it from the
 * book's directory and stats it before trusting it.
 */
import type { BuildChrome, FurnitureAlign } from '../compiler/chrome.ts';
import { FURNITURE_ALIGNS } from '../compiler/chrome.ts';
import { indentAnnotation, VALUE_NAMES, valueAnnotation } from '../ast/notation.ts';
import { scan } from '../ast/scan.ts';
import { displayText } from '../chars.ts';
import type { LocalizableMessage } from '../protocol.ts';
import { pathSegments } from '../utils/uri.ts';
import { nameIdentity, readName, type ListedName, type NameEntry } from './names.ts';

/** A column span within a single document line (`endChar` exclusive). */
export interface JpbookRange {
  readonly startChar: number;
  readonly endChar: number;
}

/**
 * Classification of one source line:
 * - `'blank'`     — empty or whitespace-only; skipped (no diagnostic, no link, not built).
 * - `'header'`    — the first line, {@link HEADER}, naming a version this extension reads.
 * - `'unread'`    — a line below a header no parser reads (the header line holds the error);
 *                  nothing is said about it.
 * - `'fence'`     — the `---` line that closes the metadata.
 * - `'meta'`      — a recognized, valid `key: value` metadata line.
 * - `'ok'`        — a syntactically valid `.jpnov` path (existence unverified).
 * - `'duplicate'` — a valid path that repeats an earlier `'ok'` line; a Warning, not built.
 * - `'cover'`     — a bare `cover:` key line, opening the cover list.
 * - `'coverEntry'` — a cover path: a `- ` item, or the `cover: path` key line, which opens the
 *                  list and is its first item; a front page in the html build ({@link entryPathOf}).
 * - `'coverDuplicate'` — a cover path repeating an earlier one; a Warning, not built.
 * - `'names'`     — a bare `characters:` or `keywords:` key line, opening that list.
 * - `'name'`      — a valid item of a name list ({@link ParsedJpbook.names} holds what it reads as):
 *                  a `- ` item, or the `characters: name` key line, the list's first item.
 * - `'nameDuplicate'` — a name whose base repeats an earlier item's; a Warning, ignored.
 * - `{ error }`   — a syntax problem (e.g. backslash, non-`.jpnov`, key-less metadata, an empty
 *                  `title`, a bad alignment) to surface as an Error; a book with any such line is not built
 *                  ({@link checkJpbook}). Its value is a {@link LocalizableMessage}.
 * - `{ warning }` — a tolerated metadata problem (unknown/duplicate key, an item that is no name);
 *                  the line is ignored and the book still builds.
 */
export type JpbookLineKind =
  | 'blank'
  | 'header'
  | 'unread'
  | 'fence'
  | 'meta'
  | 'ok'
  | 'duplicate'
  | 'cover'
  | 'coverEntry'
  | 'coverDuplicate'
  | 'names'
  | 'name'
  | 'nameDuplicate'
  | { readonly error: LocalizableMessage }
  | { readonly warning: LocalizableMessage };

export interface ParsedLine {
  /** 0-based line number within the document (LSP line coordinate). */
  readonly line: number;
  /** Span of the trimmed content; zero-width (`{0,0}`) for blank lines. */
  readonly range: JpbookRange;
  /** The line text with any trailing `\r` removed (no line terminator). */
  readonly raw: string;
  /** The trimmed content (empty for blank lines). */
  readonly value: string;
  readonly kind: JpbookLineKind;
  /**
   * The list the line belongs to, whatever its kind: a chapter line below the fence, a list's key
   * line, or an item under it (one in Error or Warning included, so the editor knows what the
   * line was meant to be). Absent off every list.
   */
  readonly list?: EntryList;
  /** The entry the line lists, as the parser read it; present exactly when the line IS an entry of its list. */
  readonly item?: ItemValue;
  /** The metadata value the line sets, as the parser read it; present exactly on a `'meta'` line. */
  readonly meta?: MetaValue;
}

/** A metadata line's key and value, with the value's absolute column span (the slicing rule of {@link ItemValue}). */
export interface MetaValue {
  readonly key: MetaKey;
  readonly value: string;
  readonly range: JpbookRange;
}

/**
 * An entry's value (a path, a name) and its absolute column span — the ONE slicing rule
 * diagnostics, document links, rename tracking and the panel share: the whole trimmed line of a
 * chapter, the text past the marker (or the key's colon) of a list item. `identity` is what the
 * list dedupes by ({@link identityOf}); a name carries what it reads as.
 */
export interface ItemValue {
  readonly value: string;
  readonly range: JpbookRange;
  readonly identity: string;
  readonly name?: ListedName;
}

/** The lists whose items are names, written under the key of the same name. */
export const NAME_LISTS = ['characters', 'keywords'] as const;
export type NameList = (typeof NAME_LISTS)[number];

export function isNameList(list: EntryList): list is NameList {
  return (NAME_LISTS as readonly string[]).includes(list);
}

/** The editable entry lists of a book — the panel's sections and the `list` its verbs carry. */
const ENTRY_LISTS = ['chapters', 'covers', ...NAME_LISTS] as const;
export type EntryList = (typeof ENTRY_LISTS)[number];

/** The lists written under a key in the metadata; the chapters follow the fence instead. */
export type KeyedList = Exclude<EntryList, 'chapters'>;

/** The lists whose items are paths to `.jpnov` files. */
export type FileList = 'chapters' | 'covers';

/** The line predicate of one list: an entry line that belongs to it (a repeat counts — it
 *  renders, moves, and dedupes like the first; a rejected item does not). */
export function isEntryOf(list: EntryList): (pl: ParsedLine) => boolean {
  return (pl) => pl.list === list && pl.item !== undefined;
}

/** Narrows an untrusted value (a webview message field) to a list name. */
export function isEntryList(v: unknown): v is EntryList {
  return typeof v === 'string' && (ENTRY_LISTS as readonly string[]).includes(v);
}

/**
 * The recognized single-valued metadata keys (`title` required, the others at their
 * {@link META_DEFAULTS} when unwritten); the page-furniture keys are
 * shared VERBATIM with {@link BuildChrome}'s field names. Adding a key: extend {@link JpbookMeta},
 * {@link META_DEFAULTS} (the book template, `create.ts`, writes them), the parser's value checks
 * (`isEmptiable`, `isAlignKey`) and — when it feeds the render — {@link composeBookChrome} for page
 * furniture, or the assembly seam (`renderBook`/`concatBookText`) for BODY content like `divider`,
 * which is never chrome.
 */
export const META_KEYS = ['title', 'author', 'header', 'headerAlign', 'footer', 'footerAlign', 'divider'] as const;
export type MetaKey = (typeof META_KEYS)[number];

/**
 * The value of each key but `title` when no line writes it: what a book created from the panel
 * starts with, and what 「既定に戻す」 returns a key to by deleting its line. A footer of page
 * numbers, a centred header, a right-hand footer; nothing else. These are data of the book
 * format, not settings: the preview, which renders a bare chapter, never sees them.
 */
export const META_DEFAULTS = {
  author: '',
  header: '',
  headerAlign: 'center',
  footer: `${valueAnnotation(VALUE_NAMES.page)} / ${valueAnnotation(VALUE_NAMES.totalPages)}`,
  footerAlign: 'right',
  divider: '',
} as const satisfies Omit<JpbookMeta, 'title'>;

/**
 * The header every book file opens with: the format, then the version it is written in,
 * the way an HTTP request line names its protocol (`jpbook/1`). It is the FIRST line, a BOM
 * apart: {@link parseJpbook} reads it alone, takes the parser of that version from
 * {@link PARSERS}, and reports a version it has none for without reading further. Not a
 * `key: value` line, so no reader takes it for a key that could sit anywhere.
 */
const HEADER_PREFIX = 'jpbook/';
export const JPBOOK_VERSION = '1';
export const HEADER = `${HEADER_PREFIX}${JPBOOK_VERSION}`;

/** The keys whose value is one of {@link FURNITURE_ALIGNS}: the parser checks it, completion and the panel offer it. */
export function isAlignKey(key: string): key is 'headerAlign' | 'footerAlign' {
  return key === 'headerAlign' || key === 'footerAlign';
}

/** The keys an empty value suits: no author, a hidden header or footer, no divider. The others
 *  (`title`, the alignments) refuse an empty line: an Error on it. */
function isEmptiable(key: MetaKey): key is Exclude<MetaKey, 'title' | 'headerAlign' | 'footerAlign'> {
  return key !== 'title' && !isAlignKey(key);
}

/** The list-valued front-page key — parsed as line kinds, never a {@link JpbookMeta} field. */
export const COVER_KEY = 'cover';

/** The key each keyed list is written under: the front pages, then the name lists (each under the key of its name). */
const KEY_OF_LIST: Readonly<Record<KeyedList, string>> = { covers: COVER_KEY, characters: 'characters', keywords: 'keywords' };

/** The list-valued keys, in writing order. */
const LIST_KEYS: readonly string[] = Object.values(KEY_OF_LIST);

export function listKeyOf(list: KeyedList): string {
  return KEY_OF_LIST[list];
}

/** The list a key opens, or null for a single-valued or unknown key. */
function listOfKey(key: string): KeyedList | null {
  return (Object.keys(KEY_OF_LIST) as KeyedList[]).find((list) => KEY_OF_LIST[list] === key) ?? null;
}

/** List-item markers; the `.jpbook` grammar derives its class from this (grammar-sync). */
export const ITEM_MARKS = ['-', '－'] as const;

/** True iff `ch` opens a list item. */
function isItemMark(ch: string): boolean {
  return (ITEM_MARKS as readonly string[]).includes(ch);
}

/** Every recognized key in writing order (unknown-key message, key completion, key insertion).
 *  The list keys stay out of {@link META_KEYS}: the panel's meta rows and `setMeta` edit the
 *  book's own metadata, one line per key. They come LAST, so a meta line is never inserted right
 *  under a list's key line, where it would close the list. */
export const KNOWN_KEYS = [...META_KEYS, ...LIST_KEYS] as const;

/** The line that closes the metadata; the chapters follow it. */
export const FENCE = '---';

/** A metadata line as the panel and the template write it: `key: value`, or `key:` when empty. */
export function metaLine(key: string, value: string): string {
  return value === '' ? `${key}:` : `${key}: ${value}`;
}

/** The key portion of a metadata line's trimmed content, or null when key-less. */
export function metaKeyOf(value: string): string | null {
  const sep = colonIndex(value);
  const key = sep < 0 ? '' : value.slice(0, sep).trim();
  return key === '' ? null : key;
}

/** The item portion of a trimmed line and its offset within it, past the marker and the whitespace after it. */
export interface ItemShape {
  readonly item: string;
  readonly offset: number;
}

/**
 * The item portion of a line's TRIMMED value: after a `- ` marker, else after the colon of `key`
 * (a list's first item or a metadata value alike); null off both shapes. Marker first, as the
 * parser dispatches.
 */
export function itemShape(value: string, key: string): ItemShape | null {
  const sep = isItemMark(value.charAt(0)) ? 1 : metaKeyOf(value) === key ? colonIndex(value) + 1 : -1;
  return sep < 0 ? null : itemAfter(value, sep);
}

/** The item portion of a trimmed line from `sep` (just past its marker or colon), skipping the
 *  whitespace there: the ONE place that slices a value past its separator. */
function itemAfter(value: string, sep: number): ItemShape {
  let offset = sep;
  while (offset < value.length && isEdgeWhitespace(value.charAt(offset))) {
    offset += 1;
  }
  return { item: value.slice(offset), offset };
}

/** The key of a `key: item` line — the key line that is also its list's first item; null for a `- ` item or a non-entry. */
export function inlineKeyOf(pl: ParsedLine): string | null {
  if (pl.item === undefined || pl.list === undefined || pl.list === 'chapters') {
    return null;
  }
  const key = listKeyOf(pl.list);
  return metaKeyOf(pl.value) === key ? key : null;
}

/** The path a chapter or cover line points at; null for every other line (a name is no path). */
export function entryPathOf(pl: ParsedLine): ItemValue | null {
  return pl.list === 'chapters' || pl.list === 'covers' ? pl.item ?? null : null;
}

/** What makes two values of `list` one entry: a path's {@link entryIdentity}, a name's base
 *  ({@link nameIdentity}; a value that is no name is its own). The parser records it on each
 *  entry ({@link ItemValue.identity}); this is for a value not yet listed. */
export function identityOf(list: EntryList, value: string): string {
  if (!isNameList(list)) {
    return entryIdentity(value);
  }
  const read = readName(value);
  return read.ok ? nameIdentity(read.name) : value;
}

/**
 * A book's metadata, field names = file keys. Every key is present: a parse holds the keys its
 * valid lines wrote ({@link ParsedJpbook.meta} is partial), and {@link checkJpbook} hands the
 * build the complete set — the unwritten keys at {@link META_DEFAULTS} — or the error that stands
 * in its way. `title` is display metadata only and never affects the output path.
 */
export interface JpbookMeta {
  /** Never empty: the EPUB's dc:title and the panel's label (an empty line is an Error). */
  readonly title: string;
  /** ペンネーム — display metadata (the EPUB package's dc:creator); '' = no author. */
  readonly author: string;
  /** Header line, filled like `footer`; '' = no header (the default). */
  readonly header: string;
  readonly headerAlign: FurnitureAlign;
  /**
   * Footer line: `.jpnov` notation whose ［＃ここに「…」の値を表示］ fields fill from the book and
   * the page ({@link BuildChrome.footer}); '' = no footer; unwritten = the page numbers.
   */
  readonly footer: string;
  readonly footerAlign: FurnitureAlign;
  /**
   * Chapter-divider line inserted between chapters that do not open with a 見出し. A line of
   * `.jpnov` notation: a bare mark is centred at build time; a ［＃○字下げ］ prefix positions
   * it instead ({@link parseDividerValue}). '' = no divider.
   */
  readonly divider: string;
}

/** An error about the metadata as a whole, placed on the line its diagnostic marks. */
export interface MetaError {
  readonly line: number;
  readonly range: JpbookRange;
  readonly error: LocalizableMessage;
}

export interface ParsedJpbook {
  /** One per source line; line 0 is the header (`'header'` when a parser read the book). */
  readonly lines: readonly ParsedLine[];
  /**
   * The values the valid key lines hold, as written: a key no line wrote is absent (its default
   * applies, {@link checkJpbook} fills it; an unwritten `title` is an error in
   * {@link metaErrors}), as is a key whose line is in Error.
   */
  readonly meta: Partial<JpbookMeta>;
  /**
   * The `---` line that closes the metadata; null when none does, and the whole file is then
   * metadata ({@link metaEndOf}). Lines before it are metadata, lines after it chapters.
   */
  readonly fence: number | null;
  /**
   * The errors of the metadata as a whole, in document order: no closing fence (marked on the
   * first non-blank line below the header, else on the header; reported alone), else a `title`
   * no line wrote, marked on the fence. Empty below a header no parser reads: that line reports
   * itself.
   */
  readonly metaErrors: readonly MetaError[];
  /** {@link namesOf} the lines: the valid items of each name list, repeats left out. */
  readonly names: Readonly<Record<NameList, readonly NameEntry[]>>;
}

/** The valid items of each name list in document order, repeats left out (an unwritten list is empty). */
export function namesOf(lines: readonly ParsedLine[]): Readonly<Record<NameList, readonly NameEntry[]>> {
  const entry = (pl: ParsedLine): NameEntry | null =>
    pl.kind === 'name' && pl.item?.name !== undefined ? { line: pl.line, text: pl.item.value, name: pl.item.name, identity: pl.item.identity } : null;
  return {
    characters: lines.filter((pl) => pl.list === 'characters').map(entry).filter((e) => e !== null),
    keywords: lines.filter((pl) => pl.list === 'keywords').map(entry).filter((e) => e !== null),
  };
}

/** No names at all: what a book no parser reads, or one without the lists, holds. */
export const NO_NAMES = namesOf([]);

/** The line the metadata ends before: its closing fence, else the end of the file. */
export function metaEndOf(parsed: ParsedJpbook): number {
  return parsed.fence ?? parsed.lines.length;
}

/** The metadata lines: the header down to the fence, exclusive (the whole file while none closes it). */
export function metaLinesOf(parsed: ParsedJpbook): readonly ParsedLine[] {
  return parsed.lines.slice(0, metaEndOf(parsed));
}

/** ECMAScript whitespace (incl. the full-width ideographic space U+3000) trims line edges. */
function isEdgeWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/** The `key: value` separator: the first ASCII or full-width colon (IME slips are common). */
function colonIndex(value: string): number {
  const half = value.indexOf(':');
  const full = value.indexOf('：');
  if (half < 0) {
    return full;
  }
  return full < 0 ? half : Math.min(half, full);
}

/** True iff `name` carries the manuscript extension, in any letter case. */
function hasJpnovExt(name: string): boolean {
  return /\.jpnov$/i.test(name);
}

/** A book file's name (or path) without `.jpbook` (any letter case): the base of its output name and its label when it has no title. */
export function jpbookStem(name: string): string {
  return name.replace(/\.jpbook$/i, '');
}

/**
 * The identity of an entry path: `./` and empty segments dropped, `..` folded, NFC.
 * `./a.jpnov`, `a.jpnov` and `x/../a.jpnov` name one file, so they are one entry; the value as
 * written stays what the line shows and the build reads.
 */
export function entryIdentity(path: string): string {
  return pathSegments(path.normalize('NFC')).join('/');
}

/** A source line with its `\r` dropped, trimmed to its content and the content's span. */
function lineOf(line: number, content: string): Omit<ParsedLine, 'kind'> {
  let start = 0;
  while (start < content.length && isEdgeWhitespace(content.charAt(start))) {
    start += 1;
  }
  let end = content.length;
  while (end > start && isEdgeWhitespace(content.charAt(end - 1))) {
    end -= 1;
  }
  const value = content.slice(start, end);
  return { line, range: value === '' ? { startChar: 0, endChar: 0 } : { startChar: start, endChar: end }, raw: content, value };
}

/** The lines below the header, as one version's parser reads them. */
type BodyParser = (header: ParsedLine, contents: readonly string[]) => ParsedJpbook;

/** The parser of each format version this extension reads, by the version the header names. */
const PARSERS: ReadonlyMap<string, BodyParser> = new Map([[JPBOOK_VERSION, parseBody1]]);

/**
 * Parses raw `.jpbook` text into one {@link ParsedLine} per source line plus the collected
 * metadata. The first line must be the {@link HEADER} (a BOM before it is tolerated, nothing
 * else): a first line that is no header, or that names a version without a parser, is the one
 * Error reported, and every line below it is `'unread'`. CRLF-safe; blank lines are skipped
 * everywhere; interior whitespace is preserved (a filename may contain spaces). Every line
 * above the first `---` is metadata, and a line there without a key is an Error. Duplicate
 * keys keep the FIRST line (one in Error included: an empty `title:` or a bad alignment takes
 * its key and reports itself). A key no line writes is absent from `meta`; `title` alone is
 * then an Error. A list opens at the first line of its key (`cover:`,
 * `characters:`, `keywords:`; a value on it is the list's first item), survives blank lines and
 * closes at any other metadata line or the fence. Chapter and cover paths must be
 * backslash-free `.jpnov` (any letter case); later repeats of a path (by {@link entryIdentity})
 * are `'duplicate'`/`'coverDuplicate'`. A name is text and ruby (`readName`); a later repeat of
 * its base (by `nameIdentity`) is `'nameDuplicate'`. Every list dedupes on its own. Never throws.
 */
export function parseJpbook(text: string): ParsedJpbook {
  const contents = text.split('\n').map((raw) => (raw.endsWith('\r') ? raw.slice(0, -1) : raw));
  const first = contents[0] ?? '';
  const bom = first.startsWith('\uFEFF') ? 1 : 0;
  const header = (kind: JpbookLineKind): ParsedLine =>
    ({ line: 0, range: { startChar: bom, endChar: first.length }, raw: first, value: first.slice(bom), kind });
  const unread = (error: LocalizableMessage): ParsedJpbook => ({
    lines: [
      header({ error }),
      ...contents.slice(1).map((content, i) => {
        const pl = lineOf(i + 1, content);
        return { ...pl, kind: pl.value === '' ? 'blank' : 'unread' } as const;
      }),
    ],
    meta: {},
    fence: null,
    metaErrors: [],
    names: NO_NAMES,
  });

  const value = first.slice(bom);
  if (!value.startsWith(HEADER_PREFIX)) {
    return unread({ code: 'jpbook.headerMissing', args: [HEADER] });
  }
  const version = value.slice(HEADER_PREFIX.length);
  const parseBody = PARSERS.get(version);
  if (parseBody === undefined) {
    return unread({ code: 'jpbook.versionUnsupported', args: [version, JPBOOK_VERSION] });
  }
  return parseBody(header('header'), contents);
}

/** Version 1: `key: value` metadata and the lists above the `---`, chapter paths below. */
function parseBody1(header: ParsedLine, contents: readonly string[]): ParsedJpbook {
  /** What a line was read as: its kind, the list it belongs to, the entry it lists. */
  type Classified = Pick<ParsedLine, 'kind' | 'list' | 'item' | 'meta'>;

  // What each list has listed so far, by identity: a path's for the file lists, a base's for the names.
  const seen: Record<EntryList, Set<string>> = { chapters: new Set(), covers: new Set(), characters: new Set(), keywords: new Set() };
  /** Records `identity` for `list`; true when it was there already. */
  const repeated = (list: EntryList, identity: string): boolean => {
    if (seen[list].has(identity)) {
      return true;
    }
    seen[list].add(identity);
    return false;
  };
  // Keys a line already took, a line in Error included.
  const takenKeys = new Set<MetaKey>();
  const listKeysSeen = new Set<string>();
  const meta: { -readonly [K in keyof JpbookMeta]?: JpbookMeta[K] } = {};

  let state: 'meta' | 'body' = 'meta';
  // The list the `- ` items belong to right now; null outside every list. Muted = under a
  // DUPLICATE key: its items warn instead of collecting, so a whole second list cannot cascade
  // into orphan-item Errors.
  let openList: { readonly list: KeyedList; readonly muted: boolean } | null = null;

  /** A source line before it is classified. */
  type Line = Omit<ParsedLine, 'kind'>;

  /** The item's column span on its line. */
  const spanOf = (pl: Line, shape: ItemShape): JpbookRange => {
    const startChar = pl.range.startChar + shape.offset;
    return { startChar, endChar: startChar + shape.item.length };
  };

  // Rejections quote the WHOLE line: a sliced marker can leave a fence-lookalike (`----`).
  const pathItem = (list: FileList, pl: Line, shape: ItemShape): Classified => {
    if (shape.item.includes('\\')) {
      return { kind: { error: { code: 'jpbook.backslashSeparator', args: [pl.value] } }, list };
    }
    if (!hasJpnovExt(shape.item)) {
      return { kind: { error: { code: 'jpbook.notJpnov', args: [pl.value] } }, list };
    }
    const identity = entryIdentity(shape.item);
    const dup = repeated(list, identity);
    const kind = list === 'chapters' ? (dup ? 'duplicate' : 'ok') : (dup ? 'coverDuplicate' : 'coverEntry');
    return { kind, list, item: { value: shape.item, range: spanOf(pl, shape), identity } };
  };

  const nameItem = (list: NameList, pl: Line, shape: ItemShape): Classified => {
    const read = readName(shape.item);
    if (!read.ok) {
      const warning: LocalizableMessage = read.error === 'empty'
        ? { code: 'jpbook.nameEmpty', args: [] }
        : { code: 'jpbook.nameNotPlain', args: [shape.item] };
      return { kind: { warning }, list };
    }
    const identity = nameIdentity(read.name);
    const kind = repeated(list, identity) ? 'nameDuplicate' : 'name';
    return { kind, list, item: { value: shape.item, range: spanOf(pl, shape), identity, name: read.name } };
  };

  const keyedItem = (list: KeyedList, pl: Line, shape: ItemShape): Classified =>
    list === 'covers' ? pathItem(list, pl, shape) : nameItem(list, pl, shape);

  /** A `- ` line: an item of the open list. Its shape always exists (the line opens with a marker). */
  const markerLine = (pl: Line): Classified => {
    if (openList === null) {
      return { kind: { error: { code: 'jpbook.itemWithoutKey', args: [pl.value] } } };
    }
    const key = listKeyOf(openList.list);
    if (openList.muted) {
      return { kind: { warning: { code: 'jpbook.metaDuplicateKey', args: [key] } }, list: openList.list };
    }
    return keyedItem(openList.list, pl, itemShape(pl.value, key) ?? { item: '', offset: 0 });
  };

  const metaLine = (pl: Line): Classified => {
    openList = null; // any key/value (or broken) metadata line ends an open list
    const { value } = pl;
    const key = metaKeyOf(value);
    if (key === null) {
      return { kind: { error: { code: 'jpbook.metaNotKeyValue', args: [value] } } };
    }
    const list = listOfKey(key);
    if (list !== null) {
      if (listKeysSeen.has(key)) {
        openList = { list, muted: true };
        return { kind: { warning: { code: 'jpbook.metaDuplicateKey', args: [key] } }, list };
      }
      listKeysSeen.add(key);
      openList = { list, muted: false };
      // A value on the key line is the list's first item; a bad one still opens the list.
      const shape = itemAfter(value, colonIndex(value) + 1);
      if (shape.item === '') {
        return { kind: list === 'covers' ? 'cover' : 'names', list };
      }
      return keyedItem(list, pl, shape);
    }
    if (!(META_KEYS as readonly string[]).includes(key)) {
      return { kind: { warning: { code: 'jpbook.metaUnknownKey', args: [key, KNOWN_KEYS.join(', ')] } } };
    }
    const metaKey = key as MetaKey;
    if (takenKeys.has(metaKey)) {
      return { kind: { warning: { code: 'jpbook.metaDuplicateKey', args: [key] } } };
    }
    takenKeys.add(metaKey);
    const shape = itemAfter(value, colonIndex(value) + 1);
    const val = shape.item;
    // Blank once the characters no output can carry are dropped.
    if (!isEmptiable(metaKey) && displayText(val).trim() === '') {
      return { kind: { error: emptyValue(metaKey) } };
    }
    if (isAlignKey(metaKey)) {
      if (!(FURNITURE_ALIGNS as readonly string[]).includes(val)) {
        return { kind: { error: { code: 'jpbook.metaBadEnum', args: [key, val, FURNITURE_ALIGNS.join(', ')] } } };
      }
      meta[metaKey] = val as FurnitureAlign;
    } else {
      meta[metaKey] = val;
    }
    return { kind: 'meta', meta: { key: metaKey, value: val, range: spanOf(pl, shape) } };
  };

  const lines: ParsedLine[] = [header];
  let fence: ParsedLine | null = null;
  // The first non-blank line below the header: where a missing fence is marked (else the header).
  let firstContent: ParsedLine | null = null;
  for (let line = 1; line < contents.length; line += 1) {
    const pl = lineOf(line, contents[line] ?? '');
    const { value } = pl;
    if (value === '') {
      lines.push({ ...pl, kind: 'blank' });
      continue;
    }

    let read: Classified;
    if (state === 'body') {
      read = pathItem('chapters', pl, { item: value, offset: 0 });
    } else if (value === FENCE) {
      state = 'body';
      read = { kind: 'fence' };
    } else if (isItemMark(value.charAt(0))) {
      read = markerLine(pl);
    } else {
      read = metaLine(pl);
    }
    const parsed: ParsedLine = { ...pl, ...read };
    lines.push(parsed);
    firstContent ??= parsed;
    if (parsed.kind === 'fence') {
      fence ??= parsed;
    }
  }

  const metaErrors: MetaError[] = [];
  const at = (pl: ParsedLine, error: LocalizableMessage): void => {
    metaErrors.push({ line: pl.line, range: pl.range, error });
  };
  if (fence === null) {
    at(firstContent ?? header, { code: 'jpbook.metaUnterminated', args: [] });
  } else if (!takenKeys.has('title')) {
    at(fence, emptyValue('title'));
  }
  return { lines, meta, fence: fence?.line ?? null, metaErrors, names: namesOf(lines) };
}

/** The Error a key that refuses an empty value reports: written empty, or (`title`) not written at all. */
function emptyValue(key: MetaKey): LocalizableMessage {
  return { code: 'jpbook.metaEmptyValue', args: [key] };
}

/** The keys written in the metadata (any kind of line), `line` excluded — what key completion leaves out. */
export function writtenKeysOf(parsed: ParsedJpbook, exceptLine = -1): Set<string> {
  const written = new Set<string>();
  for (const pl of metaLinesOf(parsed)) {
    const key = pl.line === exceptLine ? null : metaKeyOf(pl.value);
    if (key !== null) {
      written.add(key);
    }
  }
  return written;
}

/** What a book parse amounts to: its complete metadata, or the one error that stops the build. */
export type JpbookVerdict =
  | { readonly ok: true; readonly meta: JpbookMeta }
  | { readonly ok: false; readonly error: LocalizableMessage };

/**
 * The build's gate: the first error in document order — an `{ error }` line's, or the
 * metadata's own ({@link ParsedJpbook.metaErrors}), which wins a tie — else the complete
 * metadata, the unwritten keys at {@link META_DEFAULTS}. Warnings and duplicates never count.
 */
export function checkJpbook(parsed: ParsedJpbook): JpbookVerdict {
  const metaError = parsed.metaErrors[0];
  for (const pl of parsed.lines) {
    if (metaError !== undefined && metaError.line <= pl.line) {
      return { ok: false, error: metaError.error };
    }
    if (typeof pl.kind === 'object' && 'error' in pl.kind) {
      return { ok: false, error: pl.kind.error };
    }
  }
  if (metaError !== undefined) {
    return { ok: false, error: metaError.error };
  }
  // Complete: a key still absent is unwritten (a line in Error or an unwritten title is reported above).
  return { ok: true, meta: { ...META_DEFAULTS, ...parsed.meta } as JpbookMeta };
}

/**
 * Composes one book's resolved {@link BuildChrome}: the proofing chrome (line numbers /
 * edge rules) comes from the workspace SETTINGS base, the page furniture (header / footer)
 * from the book's OWN metadata, as written. This is the single seam where "how I proof"
 * (settings) meets "what this book is" (`.jpbook`).
 */
export function composeBookChrome(
  base: Pick<BuildChrome, 'lineNumbers' | 'edgeLine'>,
  meta: Pick<JpbookMeta, 'header' | 'headerAlign' | 'footer' | 'footerAlign'>,
): BuildChrome {
  return {
    lineNumbers: base.lineNumbers,
    edgeLine: base.edgeLine,
    header: meta.header,
    headerAlign: meta.headerAlign,
    footer: meta.footer,
    footerAlign: meta.footerAlign,
  };
}

/** Suggested divider marks — the GUI QuickPick and the value completion share this list. */
export const DIVIDER_PRESETS = ['＊', '＊　＊　＊', '◇'] as const;

/** A `divider` VALUE split into its mark and position (`indent: null` = 天地中央揃え). */
export interface DividerValue {
  readonly mark: string;
  readonly indent: number | null;
}

/**
 * Splits a `divider` value into mark + position: a leading ［＃○字下げ］ (the
 * scanner's own classification, so the GUI and the render can never disagree) yields its
 * amount, a bare value yields `indent: null` = centred at build time. Flush-head is
 * deliberately not expressible — it exists in neither the print nor the web convention.
 * A 字下げ above INDENT_MAX is not an indent: it stays in the mark, and the `.jpbook` diagnostics
 * warn about it.
 */
export function parseDividerValue(value: string): DividerValue {
  const first = scan(value).lines[0]?.syntax[0];
  if (first?.kind === 'indent') {
    return { mark: value.slice(first.span.end), indent: first.amount };
  }
  return { mark: value, indent: null };
}

/**
 * The inverse of {@link parseDividerValue} for an `indent` up to INDENT_MAX; the 字下げ spelling
 * comes from the notation.
 */
export function composeDividerValue(mark: string, indent: number | null): string {
  return indent === null ? mark : indentAnnotation(indent) + mark;
}

/** A directory entry handed to {@link completeEntryLine} (the caller does the `readdir`). */
export interface CompletionEntry {
  readonly name: string;
  readonly isDir: boolean;
}

/** One completion proposal: `replace` is the segment span on the line to overwrite. */
export interface JpbookCompletion {
  readonly label: string;
  readonly insertText: string;
  readonly kind: 'file' | 'folder' | 'key' | 'value';
  readonly replace: JpbookRange;
}

/**
 * Computes file-path completions for a CHAPTER line, given `linePrefix` (line start up to
 * the cursor) and `entries` — the already-listed directory the caller resolved from the
 * prefix's directory portion. Pure and fs-free.
 *
 * Offers `.jpnov` files and subdirectories (the latter inserted with a trailing `/` to keep
 * drilling) whose name case-insensitively starts with the current segment (text after the
 * last `/`). Dotfiles and `.jpbook` files are hidden; on-disk casing is inserted; results
 * are capped. The "suppress when the whole line already names a file" rule is the CALLER's
 * concern (it needs fs) — not handled here.
 */
export function completeEntryLine(
  linePrefix: string,
  entries: readonly CompletionEntry[],
  cap = 500,
): JpbookCompletion[] {
  let pathStart = 0;
  while (pathStart < linePrefix.length && isEdgeWhitespace(linePrefix.charAt(pathStart))) {
    pathStart += 1;
  }
  const lastSlash = linePrefix.lastIndexOf('/');
  const segStart = lastSlash >= pathStart ? lastSlash + 1 : pathStart;
  const seg = linePrefix.slice(segStart).toLowerCase();
  const replace = { startChar: segStart, endChar: linePrefix.length };

  return entries
    .filter((entry) => {
      const lower = entry.name.toLowerCase();
      return !entry.name.startsWith('.') &&
        !lower.endsWith('.jpbook') &&
        (entry.isDir || hasJpnovExt(entry.name)) &&
        lower.startsWith(seg);
    })
    .slice(0, cap)
    .map((entry) => ({
      label: entry.name,
      insertText: entry.isDir ? `${entry.name}/` : entry.name,
      kind: entry.isDir ? 'folder' : 'file',
      replace,
    }));
}

/**
 * Computes completions for a METADATA line: the keys not in `written` while the cursor is
 * before any colon (inserted as `key: `), and value proposals after it — the enum members for
 * `headerAlign` and `footerAlign`, the preset marks for `divider`. Both filter by
 * case-insensitive prefix. Pure and fs-free.
 */
export function completeMetaLine(linePrefix: string, written: ReadonlySet<string> = new Set()): JpbookCompletion[] {
  let keyStart = 0;
  while (keyStart < linePrefix.length && isEdgeWhitespace(linePrefix.charAt(keyStart))) {
    keyStart += 1;
  }
  const sep = colonIndex(linePrefix);

  if (sep < 0) {
    const typed = linePrefix.slice(keyStart).toLowerCase();
    const replace = { startChar: keyStart, endChar: linePrefix.length };
    return KNOWN_KEYS.filter((k) => !written.has(k) && k.toLowerCase().startsWith(typed)).map((k) => ({
      label: k,
      insertText: `${k}: `,
      kind: 'key',
      replace,
    }));
  }

  const key = linePrefix.slice(keyStart, sep).trim();
  const values: readonly string[] | null =
    isAlignKey(key) ? FURNITURE_ALIGNS : key === 'divider' ? DIVIDER_PRESETS : null;
  if (values === null) {
    return [];
  }
  const shape = itemAfter(linePrefix, sep + 1);
  const typed = shape.item.toLowerCase();
  const replace = { startChar: shape.offset, endChar: linePrefix.length };
  return values.filter((v) => v.toLowerCase().startsWith(typed)).map((v) => ({
    label: v,
    insertText: v,
    kind: 'value',
    replace,
  }));
}
