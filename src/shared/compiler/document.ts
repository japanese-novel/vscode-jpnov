import type { Ast, Line, SpanChannel, ValueLookup } from '../ast/nodes.ts';
import { VALUE_NAMES, closingAnnotations, composeDividerValue, indentAnnotation, spanChannel, type DividerValue } from '../ast/notation.ts';
import { parse } from '../ast/parse.ts';
import { printLine } from '../ast/print.ts';
import { dropUnshown, graphemeCount } from '../chars.ts';
import { escapeHtml } from '../utils/escape.ts';
import type { DashMode, KinsokuMode, LayoutSettings, LinePitch } from '../config/types.ts';
import type { BuildChrome } from './chrome.ts';
import { emrProbe, stylesheet } from './css.ts';
import type { PaperOrientation, PaperSize } from './geometry.ts';
import { buildRows, paginate, pagesToHtml, type DisplayLine, type RenderPage, type Row, type Unit, type WrapMemo } from './layout.ts';

/** 400字詰め原稿用紙 (20 字 × 20 行): the grid ［＃ここに「原稿用紙換算枚数」の値を表示］
 *  re-flows the body on. Tests derive from this, never write 20. */
export const MANUSCRIPT_SHEET = { charsPerLine: 20, linesPerPage: 20 } as const;

export interface BookInput {
  readonly files: readonly { readonly name: string; readonly src: string }[];
  /**
   * Chapter divider from the book's front matter, split into its mark and position by
   * `parseDividerValue` (absent or an empty mark = none): a line of `.jpnov` notation inserted
   * between chapters by {@link chapterGlue}.
   */
  readonly divider?: DividerValue | undefined;
  /**
   * タイトル／ペンネーム for ［＃ここに「…」の値を表示］ in the chapters, on cover pages and in the
   * page furniture, decided by the caller (the build passes the book's `title:`, never empty);
   * absent = ''. The counts (総ページ数, 原稿用紙換算枚数, ページ番号) derive from the render itself,
   * so they reach only the cover pages and the furniture; a chapter prints their defaults.
   */
  readonly title?: string | undefined;
  readonly author?: string | undefined;
  /**
   * The `cover` sources, rendered by the html build as unnumbered front pages (txt and EPUB
   * never see them). Absent/empty = no cover pages.
   */
  readonly cover?: {
    readonly files: readonly { readonly name: string; readonly src: string }[];
  } | undefined;
}

/** A book with its title decided: an EPUB must carry one (dc:title). */
export type TitledBook = BookInput & { readonly title: string };

/** Only comments and white space: nothing of the line shows (a lone directive has no content at all). */
function blankContent(line: Line): boolean {
  return line.content.every((item) => item.kind === 'comment' || (item.kind === 'chars' && item.text.trim() === ''));
}

/** A line that shows nothing at a chapter edge: no ［＃改ページ］, no 見出し, blank content. */
function showsNothing(line: Line): boolean {
  return !line.pageBreak && line.heading === undefined && blankContent(line);
}

/** The first (or last) line of a chapter that shows something; null when none does. */
function edgeLine(ast: Ast, edge: 'first' | 'last'): Line | null {
  const shows = (line: Line): boolean => !showsNothing(line);
  return (edge === 'first' ? ast.lines.find(shows) : ast.lines.findLast(shows)) ?? null;
}

/** True iff the chapter opens with a 見出し: its first shown line is a heading (a leading
 *  ［＃ここから２字下げ］, block opener or comment line is passed over). */
function opensWithHeading(ast: Ast): boolean {
  const line = edgeLine(ast, 'first');
  return line?.heading !== undefined;
}

/** True iff the chapter's junction side reaches a ［＃改ページ］ before (first) / after (last) content. */
function pageBreakAt(ast: Ast, edge: 'first' | 'last'): boolean {
  const line = edgeLine(ast, edge);
  return line !== null && line.pageBreak && (edge === 'last' || blankContent(line));
}

/** `measure` summed over every unit of the line rows. */
function sumUnits(rows: readonly Row[], measure: (u: Unit) => number): number {
  let n = 0;
  for (const row of rows) {
    if (row.kind === 'line') {
      for (const u of row.units) {
        n += measure(u);
      }
    }
  }
  return n;
}

/**
 * The divider LINE as it appears in the output: a bare mark gains a centring ［＃N字下げ］
 * prefix, N = `floor((charsPerLine − cells) / 2)` with cells measured by the layout itself
 * (a ruby/縦中横-bearing mark centres on its true advance); a value with its own 字下げ is
 * composed as written, and N = 0 emits the bare mark — never a ［＃０字下げ］. The annotation
 * spelling keeps the offset out of the `.txt` prose while the HTML side shows the same string as
 * N full-width spaces. `charsPerLine` null = no centring, the bare mark as written.
 */
function dividerLine(divider: DividerValue, charsPerLine: number | null): string {
  if (charsPerLine === null || divider.indent !== null) {
    return composeDividerValue(divider);
  }
  const cells = sumUnits(buildRows(parse(divider.mark)), (u) => u.cells);
  const pad = Math.max(0, Math.floor((charsPerLine - cells) / 2));
  return pad > 0 ? indentAnnotation(pad) + divider.mark : divider.mark;
}

/**
 * The junction "glue" between two adjacent chapters, as ONE shared string: the `.txt` build
 * joins newline-stripped chapter sources with `'\n' + seamClosers(prev) + glue`, and the HTML
 * build inserts the glue's rows between the files' row batches — the leading `'\n'` (it
 * terminates the previous chapter's last line, which the HTML side has already emitted) and
 * the closers belong to the txt seam only, so the two outputs stay faithful duals.
 *
 * One blank line ALWAYS separates chapters. The divider line plus one more blank follows
 * only when a divider is configured AND the next chapter does not open with a 見出し (the
 * heading IS the separator — heading and divider are mutually exclusive) AND the junction
 * does not abut a ［＃改ページ］ on either side (the page break separates by itself; a
 * divider dangling at a page seam serves nothing — the blank line still applies).
 *
 * Chapter edges are read LITERALLY: author blank lines are preserved and stack with the
 * glue.
 *
 * `charsPerLine` is the width a bare divider centres on; null = no centring, the bare mark at
 * the line head (the 原稿用紙換算枚数 count).
 */
export function chapterGlue(prev: Ast, next: Ast, divider: DividerValue | undefined, charsPerLine: number | null): string {
  if (
    divider !== undefined &&
    divider.mark !== '' &&
    !opensWithHeading(next) &&
    !pageBreakAt(prev, 'last') &&
    !pageBreakAt(next, 'first')
  ) {
    return `\n${dividerLine(divider, charsPerLine)}\n\n`;
  }
  return '\n';
}

/** The order a seam writes its closers in: the channels with a ここで form first. */
const SEAM_ORDER: readonly SpanChannel[] = ['indent', 'weight', 'style', 'heading', 'emph', 'line'];

/**
 * The closers a `.txt` seam appends for the spans the previous chapter leaves open — the
 * per-file state reset the HTML build gets from parsing each file on its own, spelled out.
 * A span closes in the ここで form wherever its channel has one, whichever form opened it.
 * Row-neutral by placement: the ここで-form closers share one line of their own (a
 * block-directive-only line paints no column); the inline 傍点/傍線 closers head the seam's blank
 * line the glue supplies (zero-width annotations keep it blank, and the ここで line has already
 * cleared the 字下げ/見出し it would inherit). Not the previous line's end, where an open
 * ［＃縦中横］ would flush unstyled and a broken ［＃… would swallow them. '' when nothing is
 * open; the last chapter takes none.
 */
function seamClosers(ast: Ast): string {
  const closers = ast.openAtEnd
    .toSorted((a, b) => SEAM_ORDER.indexOf(spanChannel(a)) - SEAM_ORDER.indexOf(spanChannel(b)))
    .map((opener) => {
      const forms = closingAnnotations(opener);
      return forms.block === undefined ? { text: forms.inline, block: false } : { text: forms.block, block: true };
    });
  const line = (block: boolean): string =>
    closers.filter((c) => c.block === block).map((c) => c.text).join('');
  const blockLine = line(true);
  return `${blockLine === '' ? '' : `${blockLine}\n`}${line(false)}`;
}

/**
 * The 印刷／PDF 保存 button, baked into every BUILD artifact (never the preview or the
 * EPUB): the file prints itself from whatever browser opens it — the extension's Print action
 * only opens the file. Screen-only fixed UI; build.print.css owns the geometry and the
 * @media print removal, so it cannot affect the paper. First in `<body>` = first (and only)
 * tab stop.
 */
const PRINT_BUTTON = '<button class="print" type="button" onclick="window.print()">印刷／PDF 保存</button>';

/**
 * Head script: `?p=1` on the document URL opens the print dialog once the page loads. No
 * shipped surface can send the query — OS browser hand-offs strip file:// queries and
 * fragments (macOS LaunchServices; Windows ShellExecute and GNOME gio can even fail on
 * them) — so this fires only on browser-internal navigations: an address-bar `?p=1`, a
 * bookmark, a local link. The website's sample 印刷 link (`website/scripts/samples.ts`) is one.
 */
const PRINT_AUTORUN =
  '<script>if(new URLSearchParams(location.search).get(\'p\')===\'1\')addEventListener(\'load\',()=>{window.print();});</script>';

/** `rows` with `patch` on every line row (a page break takes none). */
function stampLines(rows: readonly Row[], patch: Partial<Pick<Extract<Row, { kind: 'line' }>, 'srcLine' | 'chapter'>>): Row[] {
  return rows.map((row) => (row.kind === 'line' ? { ...row, ...patch } : row));
}

/** One junction's glue as rows: srcLine −1 = synthetic (emitLine emits no anchor), `chapter` = the one it closes. */
function glueRows(glue: string, dash: DashMode, chapter: number): Row[] {
  return stampLines(buildRows(parse(glue), { dash }), { srcLine: -1, chapter });
}

/** The pairs the book itself supplies to ［＃ここに「…」の値を表示］: タイトル／ペンネーム, absent = ''. */
function bookPairs(book: BookInput): [string, string][] {
  return [[VALUE_NAMES.title, book.title ?? ''], [VALUE_NAMES.author, book.author ?? '']];
}

/** One chapter as every output takes it: its AST, resolved with the values a chapter gets. */
export interface Chapter {
  readonly ast: Ast;
  /**
   * The chapter's ［＃ここに「…」の値を表示］ substitutions: {@link bookPairs} and its 見出し番号, its
   * number in the 目次 from 1. The counts are not here: they come from laying the chapters out,
   * so a chapter prints their defaults.
   */
  readonly values: ValueLookup;
}

/** A chapter laid into rows: its rows, each stamped with the chapter's index, and its 文字数 ({@link BookCounts.chars}). */
export interface LaidChapter extends Chapter {
  readonly rows: Row[];
  readonly chars: number;
}

/** The chapter at `index` of `book` parsed with its own values: the one place a chapter is parsed. */
function parseChapter(book: BookInput, src: string, index: number): Chapter {
  const values: ValueLookup = new Map([...bookPairs(book), [VALUE_NAMES.heading, String(index + 1)]]);
  return { ast: parse(src, values), values };
}

/** `chapter` laid into rows for `dash`; the one place a chapter's rows are built. */
function layChapter(chapter: Chapter, index: number, dash: DashMode): LaidChapter {
  const rows = stampLines(buildRows(chapter.ast, { dash }), { chapter: index });
  return { ...chapter, rows, chars: sumUnits(rows, (u) => graphemeCount(u.text)) };
}

/** A kept chapter: the one at its position, with the text and values it was parsed from, and its rows for one dash. */
export interface ChapterEntry {
  readonly src: string;
  readonly title: string;
  readonly author: string;
  readonly chapter: Chapter;
  laid: { readonly dash: DashMode; readonly chapter: LaidChapter } | undefined;
}

/**
 * The last book's chapters parsed and laid out, kept between two runs over the same text: the
 * Books view counts a book on every pause in a chapter and a build follows the count, so a chapter
 * whose text and values have not changed is neither parsed nor laid out again. Holds one book:
 * {@link chapterAsts} keeps the entries of its own book only. {@link createChapterCache} makes one.
 */
export interface ChapterCache {
  /** By position: the index is a value of the AST (見出し番号), so a chapter that moves is parsed again, and two chapters of one text keep their own entries. */
  entries: ChapterEntry[];
  /** The columns the kept rows have already been wrapped into, by width and 禁則. */
  readonly wraps: WrapMemo;
}

export function createChapterCache(): ChapterCache {
  return { entries: [], wraps: new Map() };
}

/** The entries of `book` in `cache`, each kept from the last run where its text and values agree, else parsed anew. */
function chapterEntries(book: BookInput, cache: ChapterCache): ChapterEntry[] {
  const title = book.title ?? '';
  const author = book.author ?? '';
  cache.entries = book.files.map(({ src }, index): ChapterEntry => {
    const kept = cache.entries[index];
    return kept?.src === src && kept.title === title && kept.author === author
      ? kept
      : { src, title, author, chapter: parseChapter(book, src, index), laid: undefined };
  });
  return cache.entries;
}

/** The chapters of `book`, each parsed with its own values; `cache` keeps them between runs (none given = parsed now). */
export function chapterAsts(book: BookInput, cache = createChapterCache()): Chapter[] {
  return chapterEntries(book, cache).map((entry) => entry.chapter);
}

/** The chapters of `book` laid into rows for `dash`; `cache` keeps them between runs (none given = laid now). */
export function laidChapters(book: BookInput, dash: DashMode, cache = createChapterCache()): LaidChapter[] {
  return chapterEntries(book, cache).map((entry, index) => {
    if (entry.laid?.dash !== dash) {
      entry.laid = { dash, chapter: layChapter(entry.chapter, index, dash) };
    }
    return entry.laid.chapter;
  });
}

/** A chapter of a body flow with the glue before it ({@link chapterGlue}); the first has none. */
interface FlowPart {
  readonly seam: Row[];
  readonly chapter: LaidChapter;
}

/**
 * One book's body flow on one line width: its laid chapters, each with the glue before it. A flow
 * differs only in the glue, whose divider centres on the flow's own line width (`null` = the
 * divider stays at the line head, as 原稿用紙換算枚数 counts it).
 */
function bodyFlow(book: BookInput, chapters: readonly LaidChapter[], dash: DashMode, charsPerLine: number | null): FlowPart[] {
  return chapters.map((chapter, ci): FlowPart => {
    const prev = chapters[ci - 1];
    return { seam: prev === undefined ? [] : glueRows(chapterGlue(prev.ast, chapter.ast, book.divider, charsPerLine), dash, ci - 1), chapter };
  });
}

/** The rows of one body flow, in order. */
function flowRows(parts: readonly FlowPart[]): Row[] {
  return parts.flatMap(({ seam, chapter }) => [...seam, ...chapter.rows]);
}

/** 原稿用紙換算枚数 of one body flow: its rows re-flowed on {@link MANUSCRIPT_SHEET}. */
function sheetCount(rows: readonly Row[], kinsoku: KinsokuMode, memo?: WrapMemo): number {
  return paginate(rows, MANUSCRIPT_SHEET.charsPerLine, MANUSCRIPT_SHEET.linesPerPage, kinsoku, memo).length;
}

/** The three figures of a book's body the Books view shows beside the title. */
export interface BookCounts {
  /** 本文のページ数 on the configured grid: the 総ページ数 the cover and the footer print. */
  readonly pages: number;
  /** 原稿用紙換算枚数: the body on {@link MANUSCRIPT_SHEET}. */
  readonly sheets: number;
  /** 文字数: the characters a reader sees — ruby readings and annotations excluded, spaces
   *  included (not the ones centring a divider), a 縦中横 run its own length, a blank line none. */
  readonly chars: number;
}

/**
 * The body of one book counted as {@link renderBook} lays it out: same rows, same glue, same
 * 禁則, so the figures agree with the cover's values. The cover files are never read — they are
 * not the body. `cache` keeps the chapters and their wrapped columns between two counts. Pure +
 * vscode-free.
 */
export function bookCounts(
  book: BookInput,
  opts: Pick<LayoutSettings, 'charsPerLine' | 'linesPerPage' | 'kinsoku' | 'dash'>,
  cache?: ChapterCache,
): BookCounts {
  const chapters = laidChapters(book, opts.dash, cache);
  // The null-width flow serves both the sheets and the characters: a divider mark counts, its
  // centring spaces (absent at this width) do not.
  const plain = bodyFlow(book, chapters, opts.dash, null);
  return {
    pages: paginate(flowRows(bodyFlow(book, chapters, opts.dash, opts.charsPerLine)), opts.charsPerLine, opts.linesPerPage, opts.kinsoku, cache?.wraps).length,
    sheets: sheetCount(flowRows(plain), opts.kinsoku, cache?.wraps),
    chars: plain.reduce((n, { seam, chapter }) => n + chapter.chars + sumUnits(seam, (u) => graphemeCount(u.text)), 0),
  };
}

/**
 * Renders one or more books into a full, PAGINATED `<html>` document: {@link paginate} flows
 * each book's text into the `.book > .page > .line` skeleton sized by `charsPerLine` x
 * `linesPerPage`; `chrome` adds the page furniture. Each book concatenates its `files[]` with
 * {@link chapterGlue} between chapters and starts on a fresh page. Cover files render BEFORE
 * the body as unnumbered, furniture-free pages and compile AFTER the bodies are paginated, so
 * ［＃ここに「総ページ数」の値を表示］ shows the body page count — the same count the footer's
 * 総ページ数 reports and {@link bookCounts} gives the Books view — and
 * ［＃ここに「原稿用紙換算枚数」の値を表示］ the same bodies re-flowed on {@link MANUSCRIPT_SHEET},
 * computed only when a cover or the page furniture asks for it.
 * The header and footer fill from the same values plus the page's own ページ番号 and the 見出し番号
 * of its chapter, the last one begun on or before it (a running head takes the last subhead on
 * its page). All options
 * are required and pre-resolved (the settings resolver is the only default layer). Pure +
 * vscode-free.
 */
export function renderBook(opts: {
  books: readonly BookInput[];
  charsPerLine: number;
  linesPerPage: number;
  linePitch: LinePitch;
  kinsoku: KinsokuMode;
  dash: DashMode;
  paperSize: PaperSize;
  paperOrientation: PaperOrientation;
  /** Resolved `jpnov.layout.fontFamily`; '' = the built-in stack (css.ts DEFAULT_FONT_STACK). */
  fontFamily: string;
  chrome: BuildChrome;
  /** Keeps the chapters between runs (a count, then a build, of the same book). */
  cache?: ChapterCache | undefined;
}): string {
  // Bodies paginate FIRST — covers need the count. Per book is output-identical to one run
  // with a pagebreak row at each seam: paginate flushes only non-empty pages.
  const bodies = opts.books.map((book) => {
    const chapters = laidChapters(book, opts.dash, opts.cache);
    const flow = (charsPerLine: number | null): Row[] => flowRows(bodyFlow(book, chapters, opts.dash, charsPerLine));
    return { book, flow, pages: paginate(flow(opts.charsPerLine), opts.charsPerLine, opts.linesPerPage, opts.kinsoku, opts.cache?.wraps) };
  });
  const totalBody = bodies.reduce((n, b) => n + b.pages.length, 0);

  // 原稿用紙換算枚数: the bodies re-flowed on MANUSCRIPT_SHEET, the divider uncentred — computed
  // on the first cover (or the furniture) that asks, once per render.
  let sheets: number | undefined;
  const totalSheets = (): number => {
    sheets ??= bodies.reduce((n, b) => n + sheetCount(b.flow(null), opts.kinsoku, opts.cache?.wraps), 0);
    return sheets;
  };

  // One book's ［＃ここに「…」の値を表示］ substitutions outside the chapters: a cover's values,
  // and the base of the furniture's (which adds the page's own numbers). 見出し番号 is a
  // chapter's own (chapterAsts): a cover prints its default, a body page its chapter's.
  const valuesOf = (book: BookInput, chapter?: number): ValueLookup => {
    const fixed = new Map<string, string>([...bookPairs(book), [VALUE_NAMES.totalPages, String(totalBody)]]);
    if (chapter !== undefined) {
      fixed.set(VALUE_NAMES.heading, String(chapter + 1));
    }
    return { get: (name) => (name === VALUE_NAMES.sheets ? String(totalSheets()) : fixed.get(name)) };
  };
  // Body lines all carry a chapter (bodyFlow); no page is empty (paginate).
  const chapterOf = (lines: readonly DisplayLine[]): number => Math.max(...lines.map((line) => line.chapter ?? 0));

  const coverPagesOf = (book: BookInput, values: ValueLookup): DisplayLine[][] => {
    const rows = (book.cover?.files ?? []).flatMap((file, i): Row[] => {
      const ast = parse(file.src, values);
      const r = buildRows(ast, { dash: opts.dash });
      return i > 0 ? [{ kind: 'pagebreak' }, ...r] : r; // each cover file starts on a fresh page
    });
    return paginate(rows, opts.charsPerLine, opts.linesPerPage, opts.kinsoku);
  };

  const pages = bodies.flatMap(({ book, pages: bodyPages }): RenderPage[] => [
    ...coverPagesOf(book, valuesOf(book)).map((lines): RenderPage => ({ lines, cover: true })),
    ...bodyPages.map((lines): RenderPage => ({ lines, values: valuesOf(book, chapterOf(lines)) })),
  ]);

  // Blank-furniture normalization (single source): a header or footer blank after trim folds to
  // '', the one test both the `.hd`/`.ft` element and its CSS fragment key off, so the two always
  // agree. Only this check trims — a rendered line keeps the author's literal spaces.
  const unblank = (line: string): string => (line.trim() === '' ? '' : line);
  const chrome: BuildChrome = {
    ...opts.chrome,
    header: unblank(opts.chrome.header),
    footer: unblank(opts.chrome.footer),
  };

  // Emit the body first so the CSS carries ONLY the classes used (on-demand).
  // [...used].sort() is lexicographic by class name (deterministic), not spec order.
  const used = new Set<string>();
  const body = pagesToHtml(pages, used, chrome);
  const css = stylesheet({
    paginate: true,
    charsPerLine: opts.charsPerLine,
    linesPerPage: opts.linesPerPage,
    linePitch: opts.linePitch,
    paperSize: opts.paperSize,
    paperOrientation: opts.paperOrientation,
    fontFamily: opts.fontFamily,
    chrome,
    usedClasses: [...used].sort(),
  });

  // The document title names the book: the browser's tab, and the name and Title a PDF saved from it get.
  const title = escapeHtml(opts.books[0]?.title ?? '');
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title><style>${css}</style>${PRINT_AUTORUN}</head><body>${PRINT_BUTTON}${body}${emrProbe(used)}</body></html>`;
}

/**
 * A chapter as the `.txt` takes it, before the book's line ending is chosen: its lines printed
 * back from the AST and ended by '\n' whatever ended them in the source, without the characters
 * no output can carry, less the final newline.
 */
function chapterText(ast: Ast): string {
  return dropUnshown(ast.lines.map(printLine).join('\n')).replace(/\n$/, '');
}

/**
 * Concatenates a book's `files[]` into ONE plain-text document, the dual of {@link renderBook}:
 * each file is printed back from its AST and loses its single trailing newline, then files join
 * with `'\n' + seamClosers(prev) + chapterGlue(...)` (the `'\n'` ends the previous chapter's last
 * line; the closers end the spans it left open; the glue parses into exactly the rows the HTML
 * build inserts at that seam). The characters no output can carry are removed from each
 * chapter and from the divider. The output takes the manuscript's line endings: CRLF throughout
 * when any chapter file is CRLF, else LF; a lone `\r` ends a line like the others and has no say
 * in that choice. An empty book -> ""; a divider that itself opens a span (`［＃太字］＊`) leaks
 * into the next chapter. Pure + vscode-free.
 */
export function concatBookText(book: BookInput, charsPerLine: number, cache?: ChapterCache): string {
  // The same AST as the HTML build's: the seam reads the chapter edges from it, and a value may
  // be what shows there. The text printed is the nodes, so no value reaches it.
  const chapters = chapterAsts(book, cache).map(({ ast }) => ({ ast, text: chapterText(ast) }));
  const eol = chapters.some(({ ast }) => ast.lines.some((line) => line.eol === '\r\n')) ? '\r\n' : '\n';
  const divider = book.divider === undefined ? undefined : { ...book.divider, mark: dropUnshown(book.divider.mark) };
  const joined = chapters.reduce((acc, { ast, text }, i) => {
    const prev = chapters[i - 1];
    if (prev === undefined) {
      return text;
    }
    return `${acc}\n${seamClosers(prev.ast)}${chapterGlue(prev.ast, ast, divider, charsPerLine)}${text}`;
  }, '');
  return eol === '\n' ? joined : joined.replace(/\n/g, eol);
}
