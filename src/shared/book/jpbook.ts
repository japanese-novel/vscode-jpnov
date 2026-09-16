/**
 * Pure, vscode-free parsing of the per-book `*.jpbook` manifest, plus the output-name
 * derivation, per-book chrome composition, and the fs-free completion logic.
 *
 * Chapter and cover paths are relative to the book's OWNING WORKSPACE FOLDER root, so moving
 * the `.jpbook` itself never invalidates them. The `.jpbook`'s OWN name and location imply the
 * output path (mirroring the source tree): `volume01/index.jpbook` and `volume01.jpbook` both
 * build `volume01`, `part1/vol2.jpbook` builds `part1/vol2`. Metadata never affects the output
 * path.
 *
 * Syntax, naming and completion decisions only — never the filesystem: an `'ok'` line means
 * "a backslash-free relative `.jpnov` path"; the server (`src/server/jpbook.ts`) resolves it
 * through {@link resolveContained} and stats it before trusting it.
 */
import type { BuildChrome, FooterAlign } from '../compiler/chrome.ts';
import { FOOTER_ALIGNS } from '../compiler/chrome.ts';
import { indentAnnotation, tokenize } from '../compiler/tokenizer.ts';
import { BUILD_CHROME_DEFAULT } from '../config/settings.ts';
import type { LocalizableMessage } from '../protocol.ts';

/** A column span within a single document line (`endChar` exclusive). */
export interface JpbookRange {
  readonly startChar: number;
  readonly endChar: number;
}

/**
 * Classification of one source line:
 * - `'blank'`     — empty or whitespace-only; skipped (no diagnostic, no link, not built).
 * - `'fence'`     — a front-matter `---` delimiter.
 * - `'meta'`      — a recognized, valid `key: value` front-matter line.
 * - `'ok'`        — a syntactically valid `.jpnov` path (existence/containment unverified).
 * - `'duplicate'` — a valid path that repeats an earlier `'ok'` line; a Warning, not built.
 * - `'cover'`     — a bare `cover:` key line, opening the cover list.
 * - `'coverEntry'` — a `- ` cover path; a front page in the html build ({@link coverPathOf}).
 * - `'coverDuplicate'` — a cover path repeating an earlier one; a Warning, not built.
 * - `{ error }`   — a syntax problem (e.g. backslash, non-`.jpnov`, key-less metadata) to
 *                  surface as an Error. Its value is a {@link LocalizableMessage}.
 * - `{ warning }` — a tolerated metadata problem (unknown/duplicate key, bad enum value);
 *                  the line is ignored and the book still builds.
 */
export type JpbookLineKind =
  | 'blank'
  | 'fence'
  | 'meta'
  | 'ok'
  | 'duplicate'
  | 'cover'
  | 'coverEntry'
  | 'coverDuplicate'
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
}

/** A chapter entry line — `duplicate` still counts (it renders, moves, and dedupes like `ok`). */
function isChapter(pl: ParsedLine): boolean {
  return pl.kind === 'ok' || pl.kind === 'duplicate';
}

/** A cover path line — `coverDuplicate` counts too (it links and rename-tracks). */
export function isCover(pl: ParsedLine): boolean {
  return pl.kind === 'coverEntry' || pl.kind === 'coverDuplicate';
}

/** The two editable entry lists of a book — the panel's sections and the `list` its verbs carry. */
const ENTRY_LISTS = ['chapters', 'covers'] as const;
export type EntryList = (typeof ENTRY_LISTS)[number];

/** The line predicate of one list: chapters = ok|duplicate, covers = coverEntry|coverDuplicate. */
export function isEntryOf(list: EntryList): (pl: ParsedLine) => boolean {
  return list === 'chapters' ? isChapter : isCover;
}

/** Narrows an untrusted value (a webview message field) to a list name. */
export function isEntryList(v: unknown): v is EntryList {
  return typeof v === 'string' && (ENTRY_LISTS as readonly string[]).includes(v);
}

/**
 * The recognized single-valued front-matter keys; the page-furniture keys are shared
 * VERBATIM with {@link BuildChrome}'s field names. Adding a key: extend {@link JpbookMeta},
 * handle it in the parser's key switch and — when it feeds the render — in
 * {@link composeBookChrome} for page furniture, or at the assembly seam
 * (`renderBook`/`concatBookText`) for BODY content like `divider`, which is never chrome.
 */
export const META_KEYS = ['title', 'author', 'header', 'footer', 'footerAlign', 'divider'] as const;
export type MetaKey = (typeof META_KEYS)[number];

/** The list-valued front-page key — parsed as line kinds, never a {@link JpbookMeta} field. */
export const COVER_KEY = 'cover';

/** Cover list-item markers; the `.jpbook` grammar derives its class from this (grammar-sync). */
export const COVER_ITEM_MARKS = ['-', '－'] as const;

/** True iff `ch` opens a cover list item. The ONE marker test — the completion router runs it
 *  at the cursor's path start, the parser at the head of a trimmed line. */
export function isCoverMark(ch: string): boolean {
  return (COVER_ITEM_MARKS as readonly string[]).includes(ch);
}

/** Every recognized key (unknown-key message + key completion). `cover` stays out of
 *  {@link META_KEYS}: the panel's meta rows and `upsertMeta` are single-line only. */
export const FRONT_MATTER_KEYS = [...META_KEYS, COVER_KEY] as const;

/** The key portion of a front-matter line's trimmed content, or null when key-less. */
export function metaKeyOf(value: string): string | null {
  const sep = colonIndex(value);
  const key = sep < 0 ? '' : value.slice(0, sep).trim();
  return key === '' ? null : key;
}

/** The path portion of an ITEM line's TRIMMED value and its offset within it; null otherwise. */
function coverShape(value: string): { readonly path: string; readonly offset: number } | null {
  if (!isCoverMark(value.charAt(0))) {
    return null;
  }
  let offset = 1;
  while (offset < value.length && isEdgeWhitespace(value.charAt(offset))) {
    offset += 1;
  }
  return { path: value.slice(offset), offset };
}

/**
 * A cover item's path and its absolute column span — the ONE slicing rule diagnostics,
 * document links and rename tracking share. Keyed on the line's KIND, never its shape: a
 * fence is item-shaped too (`---` slices to `--`).
 */
export function coverPathOf(pl: ParsedLine): { readonly value: string; readonly range: JpbookRange } | null {
  if (!isCover(pl)) {
    return null;
  }
  const shape = coverShape(pl.value);
  if (shape === null || shape.path === '') {
    return null;
  }
  const startChar = pl.range.startChar + shape.offset;
  return { value: shape.path, range: { startChar, endChar: startChar + shape.path.length } };
}

/** The path + span a chapter or cover line points at; null for every other line. */
export function entryPathOf(pl: ParsedLine): { readonly value: string; readonly range: JpbookRange } | null {
  return isChapter(pl) ? { value: pl.value, range: pl.range } : coverPathOf(pl);
}

/**
 * Parsed front-matter values, field names = file keys. All optional — an absent key falls
 * back at composition time ({@link composeBookChrome} for the page furniture; `title` has
 * no fallback, it is display metadata only and never affects the output path).
 */
export interface JpbookMeta {
  readonly title?: string;
  /** ペンネーム — display metadata (the EPUB package's dc:creator); never affects the output path. */
  readonly author?: string;
  /** Header line, filled like `footer`; absent = none. */
  readonly header?: string;
  /**
   * Footer line: `.jpnov` notation whose ［＃ここに「…」の値を表示］ fields fill from the book and
   * the page ({@link BuildChrome.footer}); absent = the product default, '' = no footer.
   */
  readonly footer?: string;
  /** Footer placement; absent = the product default. */
  readonly footerAlign?: FooterAlign;
  /**
   * Chapter-divider line inserted between chapters that do not open with a 見出し. A line of
   * `.jpnov` notation: a bare mark is centred at build time; a ［＃○字下げ］ prefix positions
   * it instead ({@link parseDividerValue}). Absent/empty = no divider.
   */
  readonly divider?: string;
}

export interface ParsedJpbook {
  readonly lines: readonly ParsedLine[];
  readonly meta: JpbookMeta;
}

/** ECMAScript whitespace (incl. the full-width ideographic space U+3000) trims line edges. */
function isEdgeWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/** The `key: value` separator: the first ASCII or full-width colon (IME slips are common). */
export function colonIndex(value: string): number {
  const half = value.indexOf(':');
  const full = value.indexOf('：');
  if (half < 0) {
    return full;
  }
  return full < 0 ? half : Math.min(half, full);
}

const FENCE = '---';

/**
 * Parses raw `.jpbook` text into one {@link ParsedLine} per source line plus the collected
 * {@link JpbookMeta}. CRLF-safe; blank lines are skipped everywhere; interior whitespace is
 * preserved (a filename may contain spaces). Front matter opens ONLY on the first non-blank
 * line; inside it, duplicate keys keep the FIRST value, and an unclosed block turns the
 * opening fence into an Error (the remaining lines still parse as metadata). A `cover` list
 * survives blank lines and closes at any other metadata line or the fence. Chapter and cover
 * paths must be backslash-free `.jpnov`; later exact repeats are `'duplicate'`/
 * `'coverDuplicate'`, the two lists deduping independently. Never throws.
 */
export function parseJpbook(text: string): ParsedJpbook {
  const seen = new Set<string>();
  const seenCovers = new Set<string>();
  const lines: ParsedLine[] = [];
  const meta: { -readonly [K in keyof JpbookMeta]: JpbookMeta[K] } = {};

  // 'start' until the first non-blank line; 'meta' inside an open front-matter block.
  let state: 'start' | 'meta' | 'body' = 'start';
  let openFence = -1;
  let coverKeySeen = false;
  // 'muted' = a DUPLICATE bare `cover:`: its items warn instead of collecting, so a whole
  // second list cannot cascade into orphan-item Errors.
  let coverList: 'open' | 'muted' | null = null;

  // Rejections quote the WHOLE line: a sliced marker can leave a fence-lookalike (`----`).
  const coverPathKind = (path: string, line: string): JpbookLineKind => {
    if (path.includes('\\')) {
      return { error: { code: 'jpbook.backslashSeparator', args: [line] } };
    }
    if (!path.endsWith('.jpnov')) {
      return { error: { code: 'jpbook.notJpnov', args: [line] } };
    }
    if (seenCovers.has(path)) {
      return 'coverDuplicate';
    }
    seenCovers.add(path);
    return 'coverEntry';
  };

  const coverItemKind = (value: string): JpbookLineKind => {
    if (coverList === null) {
      return { error: { code: 'jpbook.coverItemWithoutKey', args: [value] } };
    }
    if (coverList === 'muted') {
      return { warning: { code: 'jpbook.metaDuplicateKey', args: [COVER_KEY] } };
    }
    return coverPathKind(coverShape(value)?.path ?? '', value);
  };

  const metaKind = (value: string): JpbookLineKind => {
    coverList = null; // any key/value (or broken) metadata line ends an open cover list
    const key = metaKeyOf(value);
    if (key === null) {
      return { error: { code: 'jpbook.metaNotKeyValue', args: [value] } };
    }
    if (key === COVER_KEY) {
      // List-only: the grammar paints any `key: value` as a string and VS Code withholds
      // completion inside strings, so cover paths live on `- ` lines, like chapters.
      if (value.slice(colonIndex(value) + 1).trim() !== '') {
        return { error: { code: 'jpbook.coverNeedsList', args: [value] } };
      }
      if (coverKeySeen) {
        coverList = 'muted';
        return { warning: { code: 'jpbook.metaDuplicateKey', args: [key] } };
      }
      coverKeySeen = true;
      coverList = 'open';
      return 'cover';
    }
    if (!(META_KEYS as readonly string[]).includes(key)) {
      return { warning: { code: 'jpbook.metaUnknownKey', args: [key, FRONT_MATTER_KEYS.join(', ')] } };
    }
    const metaKey = key as MetaKey;
    if (meta[metaKey] !== undefined) {
      return { warning: { code: 'jpbook.metaDuplicateKey', args: [key] } };
    }
    // metaKeyOf returned a key, so the line has a colon: colonIndex is non-negative here.
    const val = value.slice(colonIndex(value) + 1).trim();
    if (metaKey === 'footerAlign') {
      if (!(FOOTER_ALIGNS as readonly string[]).includes(val)) {
        return {
          warning: { code: 'jpbook.metaBadEnum', args: [key, val, FOOTER_ALIGNS.join(', ')] },
        };
      }
      meta.footerAlign = val as FooterAlign;
    } else {
      meta[metaKey] = val;
    }
    return 'meta';
  };

  const bodyKind = (value: string): JpbookLineKind => {
    if (value.includes('\\')) {
      return { error: { code: 'jpbook.backslashSeparator', args: [value] } };
    }
    if (!value.endsWith('.jpnov')) {
      return { error: { code: 'jpbook.notJpnov', args: [value] } };
    }
    if (seen.has(value)) {
      return 'duplicate';
    }
    seen.add(value);
    return 'ok';
  };

  const rawLines = text.split('\n');
  for (let line = 0; line < rawLines.length; line += 1) {
    const rawLine = rawLines[line] ?? '';
    const content = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    let start = 0;
    while (start < content.length && isEdgeWhitespace(content.charAt(start))) {
      start += 1;
    }
    let end = content.length;
    while (end > start && isEdgeWhitespace(content.charAt(end - 1))) {
      end -= 1;
    }
    const value = content.slice(start, end);

    if (value === '') {
      lines.push({ line, range: { startChar: 0, endChar: 0 }, raw: content, value: '', kind: 'blank' });
      continue;
    }

    const range = { startChar: start, endChar: end };
    let kind: JpbookLineKind;
    if (state === 'start' && value === FENCE) {
      state = 'meta';
      openFence = line;
      kind = 'fence';
    } else if (state === 'meta') {
      if (value === FENCE) {
        state = 'body';
        kind = 'fence';
      } else if (isCoverMark(value.charAt(0))) {
        kind = coverItemKind(value);
      } else {
        kind = metaKind(value);
      }
    } else {
      state = 'body';
      kind = bodyKind(value);
    }
    lines.push({ line, range, raw: content, value, kind });
  }

  if (state === 'meta') {
    const fence = lines[openFence];
    if (fence !== undefined) {
      lines[openFence] = { ...fence, kind: { error: { code: 'jpbook.metaUnterminated', args: [] } } };
    }
  }

  return { lines, meta };
}

/**
 * The front-matter region of a parse as fence line numbers — `close` is `null` when the
 * block is unterminated (it then extends to EOF) — or `null` when no block opens. Lines
 * strictly BETWEEN the fences are metadata territory; the completion router keys off this.
 */
export function metaRegionOf(
  lines: readonly ParsedLine[],
): { readonly open: number; readonly close: number | null } | null {
  const first = lines.find((pl) => pl.kind !== 'blank');
  if (first === undefined) {
    return null;
  }
  if (typeof first.kind === 'object' && 'error' in first.kind && first.kind.error.code === 'jpbook.metaUnterminated') {
    return { open: first.line, close: null };
  }
  if (first.kind !== 'fence') {
    return null;
  }
  const close = lines.find((pl) => pl.kind === 'fence' && pl.line > first.line);
  return { open: first.line, close: close?.line ?? null };
}

/**
 * Composes one book's resolved {@link BuildChrome}: the proofing chrome (line numbers /
 * edge rules) comes from the workspace SETTINGS base, the page furniture (header / footer)
 * from the book's OWN front matter, defaults filling any absent key. This is the single
 * seam where "how I proof" (settings) meets "what this book is" (`.jpbook`).
 */
export function composeBookChrome(
  base: Pick<BuildChrome, 'lineNumbers' | 'edgeLine'>,
  meta: JpbookMeta,
): BuildChrome {
  return {
    lineNumbers: base.lineNumbers,
    edgeLine: base.edgeLine,
    footerAlign: meta.footerAlign ?? BUILD_CHROME_DEFAULT.footerAlign,
    footer: meta.footer ?? BUILD_CHROME_DEFAULT.footer,
    header: meta.header ?? BUILD_CHROME_DEFAULT.header,
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
 * Splits a `divider` front-matter value into mark + position: a leading ［＃○字下げ］ (the
 * tokenizer's own classification, so the GUI and the render can never disagree) yields its
 * amount, a bare value yields `indent: null` = centred at build time. Flush-head is
 * deliberately not expressible — it exists in neither the print nor the web convention.
 */
export function parseDividerValue(value: string): DividerValue {
  const first = tokenize(value)[0];
  if (first?.kind === 'indent') {
    return { mark: value.slice(first.raw.length), indent: first.amount };
  }
  return { mark: value, indent: null };
}

/** The inverse of {@link parseDividerValue}; the 字下げ spelling comes from the tokenizer. */
export function composeDividerValue(mark: string, indent: number | null): string {
  return indent === null ? mark : indentAnnotation(indent) + mark;
}

/**
 * Derives the output RELATIVE PATH (stem, no extension) for a `.jpbook`, mirroring the
 * tree under the workspace folder root (POSIX `/`; backslashes tolerated as separators). The build
 * appends the format extension to it. Strips `.jpbook`; a basename of `index` collapses to its parent
 * directory when one exists (so `vol1/index.jpbook` and `vol1.jpbook` agree on `vol1`);
 * remaining segments join with `/`. A root-level `index.jpbook` has no parent, so it keeps
 * `index`.
 *
 * Two distinct book files that collide on this path are a BUILD-level error (detected by the
 * caller via the output-path map).
 */
export function jpbookOutRel(jpbookRel: string): string {
  const segments = jpbookRel.split(/[\\/]+/).filter((seg) => seg !== '' && seg !== '.');
  const last = (segments.pop() ?? '').replace(/\.jpbook$/i, '');
  if (!(last === 'index' && segments.length > 0)) {
    segments.push(last);
  }
  return segments.join('/');
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
        (entry.isDir || lower.endsWith('.jpnov')) &&
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
 * Computes completions for a FRONT-MATTER line: metadata keys while the cursor is before
 * any colon (inserted as `key: `), and value proposals after it — the enum members for
 * `footerAlign`, the preset marks for `divider`. Both filter by case-insensitive prefix.
 * Pure and fs-free.
 */
export function completeMetaLine(linePrefix: string): JpbookCompletion[] {
  let keyStart = 0;
  while (keyStart < linePrefix.length && isEdgeWhitespace(linePrefix.charAt(keyStart))) {
    keyStart += 1;
  }
  const sep = colonIndex(linePrefix);

  if (sep < 0) {
    const typed = linePrefix.slice(keyStart).toLowerCase();
    const replace = { startChar: keyStart, endChar: linePrefix.length };
    return FRONT_MATTER_KEYS.filter((k) => k.toLowerCase().startsWith(typed)).map((k) => ({
      label: k,
      insertText: `${k}: `,
      kind: 'key',
      replace,
    }));
  }

  const key = linePrefix.slice(keyStart, sep).trim();
  const values: readonly string[] | null =
    key === 'footerAlign' ? FOOTER_ALIGNS : key === 'divider' ? DIVIDER_PRESETS : null;
  if (values === null) {
    return [];
  }
  let valStart = sep + 1;
  while (valStart < linePrefix.length && isEdgeWhitespace(linePrefix.charAt(valStart))) {
    valStart += 1;
  }
  const typed = linePrefix.slice(valStart).toLowerCase();
  const replace = { startChar: valStart, endChar: linePrefix.length };
  return values.filter((v) => v.toLowerCase().startsWith(typed)).map((v) => ({
    label: v,
    insertText: v,
    kind: 'value',
    replace,
  }));
}
