import type { Ast, Line, SpanChannel, ValueLookup } from '../ast/nodes.ts';
import { VALUE_NAMES, closingAnnotations, indentAnnotation, spanChannel } from '../ast/notation.ts';
import { parse } from '../ast/parse.ts';
import { printLine } from '../ast/print.ts';
import { dropUnshown } from '../chars.ts';
import { escapeHtml } from '../utils/escape.ts';
import type { DashMode, KinsokuMode, LinePitch } from '../config/types.ts';
import type { BuildChrome } from './chrome.ts';
import { emrProbe, stylesheet } from './css.ts';
import type { PaperOrientation, PaperSize } from './geometry.ts';
import { buildRows, paginate, pagesToHtml, type DisplayLine, type RenderPage, type Row } from './layout.ts';

/** 400字詰め原稿用紙 (20 字 × 20 行): the grid ［＃ここに「原稿用紙換算枚数」の値を表示］
 *  re-flows the body on. Tests derive from this, never write 20. */
export const MANUSCRIPT_SHEET = { charsPerLine: 20, linesPerPage: 20 } as const;

export interface BookInput {
  readonly files: readonly { readonly name: string; readonly src: string }[];
  /**
   * Chapter divider from the book's front matter ('' / absent = none) — a line of `.jpnov`
   * notation inserted between chapters by {@link chapterGlue}. Explicit `| undefined` so the
   * server can assign `meta.divider` verbatim under exactOptionalPropertyTypes.
   */
  readonly divider?: string | undefined;
  /**
   * タイトル／ペンネーム for ［＃ここに「…」の値を表示］ on cover pages and in the page furniture,
   * decided by the caller (the build passes the book's `title:`, never empty); absent = ''.
   * The counts (総ページ数, 原稿用紙換算枚数, ページ番号) derive from the render itself.
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

/** True iff a 見出し opens on this line (block or inline form). */
function opensHeading(line: Line): boolean {
  return line.syntax.some((node) => node.kind === 'headingSpanStart');
}

/** Only comments and white space: nothing of the line shows (a lone directive has no content at all). */
function blankContent(line: Line): boolean {
  return line.content.every((item) => item.kind === 'comment' || (item.kind === 'chars' && item.text.trim() === ''));
}

/** A line that shows nothing at a chapter edge: no ［＃改ページ］, no 見出し on or opened by it, blank content. */
function showsNothing(line: Line): boolean {
  return !line.pageBreak && line.heading === undefined && !opensHeading(line) && blankContent(line);
}

/** The first (or last) line of a chapter that shows something; null when none does. */
function edgeLine(ast: Ast, edge: 'first' | 'last'): Line | null {
  const shows = (line: Line): boolean => !showsNothing(line);
  return (edge === 'first' ? ast.lines.find(shows) : ast.lines.findLast(shows)) ?? null;
}

/** True iff the chapter opens with a 見出し: its first shown line is a heading, or paints nothing
 *  and opens one (a leading ［＃ここから２字下げ］ or comment line is passed over). */
function opensWithHeading(ast: Ast): boolean {
  const line = edgeLine(ast, 'first');
  return line !== null && (line.heading !== undefined || (!line.pageBreak && opensHeading(line)));
}

/** True iff the chapter's junction side reaches a ［＃改ページ］ before (first) / after (last) content. */
function pageBreakAt(ast: Ast, edge: 'first' | 'last'): boolean {
  const line = edgeLine(ast, edge);
  return line !== null && line.pageBreak && (edge === 'last' || blankContent(line));
}

/**
 * The divider LINE as it appears in the output: a bare mark gains a centring ［＃N字下げ］
 * prefix, N = `floor((charsPerLine − cells) / 2)` with cells measured by the layout itself
 * (a ruby/縦中横-bearing mark centres on its true advance); a value already carrying a
 * ［＃○字下げ］ prefix passes through verbatim, and N = 0 emits the bare mark — never a
 * ［＃０字下げ］. The annotation spelling keeps the offset out of the `.txt` prose while the
 * HTML side renders the same string through the indent machinery as padding. `charsPerLine`
 * null = no centring, the bare mark as written.
 */
function dividerLine(divider: string, charsPerLine: number | null): string {
  const ast = parse(divider);
  if (charsPerLine === null || ast.lines[0]?.syntax[0]?.kind === 'indent') {
    return divider;
  }
  let cells = 0;
  for (const row of buildRows(ast)) {
    if (row.kind === 'line') {
      for (const u of row.units) {
        cells += u.cells;
      }
    }
  }
  const pad = Math.max(0, Math.floor((charsPerLine - cells) / 2));
  return pad > 0 ? indentAnnotation(pad) + divider : divider;
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
export function chapterGlue(prev: Ast, next: Ast, divider: string, charsPerLine: number | null): string {
  if (
    divider !== '' &&
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

/** One junction's glue as rows; srcLine −1 = synthetic (emitLine emits no anchor). */
function glueRows(glue: string, dash: DashMode): Row[] {
  return buildRows(parse(glue), { dash }).map((row) =>
    row.kind === 'line' ? { ...row, srcLine: -1 } : row,
  );
}

/**
 * Renders one or more books into a full, PAGINATED `<html>` document: {@link paginate} flows
 * each book's text into the `.book > .page > .line` skeleton sized by `charsPerLine` x
 * `linesPerPage`; `chrome` adds the page furniture. Each book concatenates its `files[]` with
 * {@link chapterGlue} between chapters and starts on a fresh page. Cover files render BEFORE
 * the body as unnumbered, furniture-free pages and compile AFTER the bodies are paginated, so
 * ［＃ここに「総ページ数」の値を表示］ shows the body page count — the same count the footer's
 * 総ページ数 reports — and ［＃ここに「原稿用紙換算枚数」の値を表示］ the same bodies re-flowed
 * on {@link MANUSCRIPT_SHEET}, computed only when a cover or the page furniture asks for it.
 * The header and footer fill from the same values plus the page's own ページ番号. All options
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
}): string {
  // Every chapter is parsed and laid into rows ONCE; a flow differs only in the glue, whose
  // divider centres on the flow's own line width.
  const chapters = opts.books.map((book) =>
    book.files.map((file) => {
      const ast = parse(file.src);
      return { ast, rows: buildRows(ast, { dash: opts.dash }) };
    }),
  );
  const bodyRowsOf = (bi: number, charsPerLine: number | null): Row[] => {
    const divider = opts.books[bi]?.divider ?? '';
    return (chapters[bi] ?? []).flatMap(({ ast, rows }, ci, all): Row[] => {
      const prev = all[ci - 1];
      const glue = prev === undefined
        ? []
        : glueRows(chapterGlue(prev.ast, ast, divider, charsPerLine), opts.dash);
      return [...glue, ...rows];
    });
  };

  // Bodies paginate FIRST — covers need the count. Per book is output-identical to one run
  // with a pagebreak row at each seam: paginate flushes only non-empty pages.
  const bodies = opts.books.map((book, bi) => ({
    book,
    pages: paginate(bodyRowsOf(bi, opts.charsPerLine), opts.charsPerLine, opts.linesPerPage, opts.kinsoku),
  }));
  const totalBody = bodies.reduce((n, b) => n + b.pages.length, 0);

  // 原稿用紙換算枚数: the bodies re-flowed on MANUSCRIPT_SHEET, the divider uncentred — computed
  // on the first cover (or the furniture) that asks, once per render.
  let sheets: number | undefined;
  const totalSheets = (): number => {
    sheets ??= opts.books.reduce((n, _book, bi) => {
      const rows = bodyRowsOf(bi, null);
      return n + paginate(rows, MANUSCRIPT_SHEET.charsPerLine, MANUSCRIPT_SHEET.linesPerPage, opts.kinsoku).length;
    }, 0);
    return sheets;
  };

  // One book's ［＃ここに「…」の値を表示］ substitutions, four of the five VALUE_NAMES: a cover's
  // values, and the base of the furniture's (which adds the page's own numbers).
  const valuesOf = (book: BookInput): ValueLookup => {
    const fixed = new Map<string, string>([
      [VALUE_NAMES.title, book.title ?? ''],
      [VALUE_NAMES.author, book.author ?? ''],
      [VALUE_NAMES.totalPages, String(totalBody)],
    ]);
    return { get: (name) => (name === VALUE_NAMES.sheets ? String(totalSheets()) : fixed.get(name)) };
  };

  const coverPagesOf = (book: BookInput, values: ValueLookup): DisplayLine[][] => {
    const rows = (book.cover?.files ?? []).flatMap((file, i): Row[] => {
      const ast = parse(file.src, values);
      const r = buildRows(ast, { dash: opts.dash });
      return i > 0 ? [{ kind: 'pagebreak' }, ...r] : r; // each cover file starts on a fresh page
    });
    return paginate(rows, opts.charsPerLine, opts.linesPerPage, opts.kinsoku);
  };

  const pages = bodies.flatMap(({ book, pages: bodyPages }): RenderPage[] => {
    const values = valuesOf(book);
    return [
      ...coverPagesOf(book, values).map((lines): RenderPage => ({ lines, cover: true })),
      ...bodyPages.map((lines): RenderPage => ({ lines, values })),
    ];
  });

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
export function concatBookText(book: BookInput, charsPerLine: number): string {
  const chapters = book.files.map((file) => {
    const ast = parse(file.src);
    return { ast, text: chapterText(ast) };
  });
  const eol = chapters.some(({ ast }) => ast.lines.some((line) => line.eol === '\r\n')) ? '\r\n' : '\n';
  const divider = dropUnshown(book.divider ?? '');
  const joined = chapters.reduce((acc, { ast, text }, i) => {
    const prev = chapters[i - 1];
    if (prev === undefined) {
      return text;
    }
    return `${acc}\n${seamClosers(prev.ast)}${chapterGlue(prev.ast, ast, divider, charsPerLine)}${text}`;
  }, '');
  return eol === '\n' ? joined : joined.replace(/\n/g, eol);
}
