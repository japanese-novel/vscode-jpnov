/**
 * EPUB 3 container assembly: one book → the member files of an OCF container (reflowable,
 * vertical-rl, right-to-left spine); the zip step is `ocf.ts`. Spec:
 * https://www.w3.org/TR/epub-33/. Chapters map to spine files 1:1 (＃改ページ splits again
 * within a chapter); there is NO inter-chapter glue — every chapter junction is a page seam,
 * where the divider is suppressed by the same rule `chapterGlue` applies at ［＃改ページ］.
 *
 * `epubMembers` is pure and deterministic given `modified` (the injected build timestamp):
 * the identifier derives from `outRel`, the book's output stem (its file name, or its path
 * from the workspace folder under the default outDir), so rebuilding a book keeps its identity
 * and readers treat it as an update, not a new book.
 * Pure + vscode-free.
 */
import { createHash } from 'node:crypto';

import { VALUE_FORMATS, VALUE_NAMES, valueOf } from '../ast/notation.ts';
import { displayText } from '../chars.ts';
import type { DashMode, KinsokuMode } from '../config/types.ts';
import { reflowStylesheet } from './css.ts';
import { chapterAsts, type TitledBook } from './document.ts';
import { escapeHtml } from '../utils/escape.ts';
import { buildRows } from './layout.ts';
import { nonBlank, reflowDocument, reflowSegments } from './reflow.ts';

/** One text member of an EPUB container: its path inside the archive + full content. */
export interface EpubMember {
  readonly name: string;
  readonly content: string;
}

/**
 * `urn:uuid:` identity derived from the book's output stem: sha-256 of a fixed seed, first
 * 16 bytes, with the version nibble stamped 8 (RFC 9562 UUIDv8 — custom algorithm) and the
 * 10xx variant. Deterministic, so every rebuild is the SAME publication to a reading system.
 */
function bookIdentifier(outRel: string): string {
  const digest = createHash('sha256').update(`jpnov:${outRel}`).digest();
  const b = Uint8Array.from(digest.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const parts = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)];
  return `urn:uuid:${parts.join('-')}`;
}

/** `s` as the package shows it, or null when nothing of it would show. Metadata never passes
 *  the AST, so the characters XML cannot carry are dropped here. */
function shown(s: string): string | null {
  return nonBlank(displayText(s));
}

/** The manifest id and file stem of the chapter at `index`: `ch001` onward. */
const spineStem = (index: number): string => `ch${String(index + 1).padStart(3, '0')}`;

const CONTAINER_XML =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
  '<rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>' +
  '</container>';

/** One spine-level content document, in spine order. */
interface SpineDoc {
  /** Manifest id and file stem — `ch001` for a chapter's first file, `ch001-2` onward for its splits. */
  readonly id: string;
  /** Href relative to the OPF/nav location (`OEBPS/`). */
  readonly href: string;
  readonly title: string;
  readonly body: string;
}

export function epubMembers(opts: {
  /** Its `title` and `author` are the package's dc:title and dc:creator. A blank title takes the
   *  first nav label; a blank author leaves dc:creator out. */
  readonly book: TitledBook;
  /** The book's output stem (the `.jpbook` basename, no extension) — identity for dc:identifier. */
  readonly outRel: string;
  readonly kinsoku: KinsokuMode;
  readonly dash: DashMode;
  /** Caps the 字下げ, as in the paginated build. */
  readonly charsPerLine: number;
  /** Build timestamp for `dcterms:modified`, CCYY-MM-DDThh:mm:ssZ — injected (the determinism seam). */
  readonly modified: string;
}): EpubMember[] {
  const used = new Set<string>();
  // One entry per non-empty chapter: its spine docs plus its one nav row (an empty chapter
  // source contributes neither). reflowSegments feeds the shared `used` class sink, so
  // chapters must be processed in file order. A chapter with no 見出し is labelled by its
  // 見出し番号 in 命数 (一, 二, …), the number its ［＃ここに「見出し番号」の値を表示］ shows.
  const chapters = chapterAsts(opts.book).flatMap(({ ast, values }, index) => {
    const rows = buildRows(ast, { dash: opts.dash });
    const segments = reflowSegments(rows, opts.charsPerLine, used, opts.dash);
    if (segments.length === 0) {
      return [];
    }
    const stem = spineStem(index);
    const label = segments.find((s) => s.heading !== null)?.heading ?? valueOf(VALUE_NAMES.heading, values, VALUE_FORMATS.named);
    const chapterDocs = segments.map((seg, si): SpineDoc => {
      const id = si === 0 ? stem : `${stem}-${String(si + 1)}`;
      return { id, href: `text/${id}.xhtml`, title: seg.heading ?? label, body: seg.body };
    });
    return [{ docs: chapterDocs, nav: { href: `text/${stem}.xhtml`, label } }];
  });
  const first = spineStem(0);
  const title = shown(opts.book.title) ?? chapters[0]?.nav.label ?? first;
  const href = `text/${first}.xhtml`;
  // A book whose chapters are all empty still needs a non-empty spine to be an EPUB at all.
  const effective = chapters.length > 0
    ? chapters
    : [{
        docs: [{ id: first, href, title, body: '<p><br/></p>' }],
        nav: { href, label: title },
      }];
  const docs = effective.flatMap((c) => c.docs);

  const author = shown(opts.book.author ?? '');
  const creator = author === null ? '' : `<dc:creator>${escapeHtml(author)}</dc:creator>`;
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="styles.css" media-type="text/css"/>',
    ...docs.map((d) => `<item id="${d.id}" href="${d.href}" media-type="application/xhtml+xml"/>`),
  ].join('');
  const spine = docs.map((d) => `<itemref idref="${d.id}"/>`).join('');
  const opf =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="ja">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:identifier id="pub-id">${bookIdentifier(opts.outRel)}</dc:identifier>` +
    `<dc:title>${escapeHtml(title)}</dc:title>` +
    '<dc:language>ja</dc:language>' +
    creator +
    `<meta property="dcterms:modified">${escapeHtml(opts.modified)}</meta>` +
    '</metadata>' +
    `<manifest>${manifest}</manifest>` +
    // 右開き: right-to-left page progression is what makes a vertical-rl book turn correctly.
    `<spine page-progression-direction="rtl">${spine}</spine>` +
    '</package>';

  const navList = effective
    .map((c) => `<li><a href="${c.nav.href}">${escapeHtml(c.nav.label)}</a></li>`)
    .join('');
  const nav =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<!DOCTYPE html>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja" lang="ja">' +
    '<head><title>目次</title></head>' +
    `<body><nav epub:type="toc"><h1>目次</h1><ol>${navList}</ol></nav></body></html>`;

  return [
    { name: 'META-INF/container.xml', content: CONTAINER_XML },
    { name: 'OEBPS/package.opf', content: opf },
    { name: 'OEBPS/nav.xhtml', content: nav },
    { name: 'OEBPS/styles.css', content: reflowStylesheet(opts.kinsoku, [...used].sort()) },
    ...docs.map((d) => ({
      name: `OEBPS/${d.href}`,
      content: reflowDocument(d.title, d.body, '../styles.css'),
    })),
  ];
}
