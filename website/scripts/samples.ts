/** The sample table: which source, which product options, which scoping, per render. */
import { SPECIMEN_BOOKS, SPECIMEN_PREVIEWS } from '../../scripts/specimens.ts';
import type { SpecimenBook, SpecimenBookName, SpecimenName, SpecimenPreview, SpecimenPreviewName } from '../../scripts/specimens.ts';
import type { LayoutSettings } from '../../src/shared/config/types.ts';
import type { PaperOrientation, PaperSize } from '../../src/shared/compiler/geometry.ts';
import { LINKS } from '../src/copy/links.ts';
import { LATE_CHAPTER } from '../src/stage/strings.ts';
import type { SampleName } from './contract.ts';

/**
 * The stage's 書式 (`jpnov.layout.charsPerLine` / `linesPerPage`): fewer cells than the 40×34
 * default, so the preview pane and the printed page read at a glance from across a desk.
 */
const STAGE_LAYOUT: Partial<LayoutSettings> = { charsPerLine: 25, linesPerPage: 25 };

export interface PreviewSample extends Pick<SpecimenPreview, 'layout' | 'chrome'> {
  readonly name: SampleName;
  readonly kind: 'preview';
  /** A specimen, or a stage state derived from chapter1.jpnov. */
  readonly source: { readonly specimen: SpecimenName } | { readonly state: 'typing' | 'emphasised' | 'fixed' };
  /** The `.jpbook` in `src/samples/` whose `characters:` / `keywords:` colour the editor lines; its presence also lints the source (the stage samples). */
  readonly vocabulary?: string;
}

export interface BookSample extends Pick<SpecimenBook, 'layout' | 'chrome'> {
  readonly name: SampleName;
  readonly kind: 'book';
  /** Either a `.jpbook` in `src/samples/` or a one-file book from a specimen. */
  readonly source: { readonly jpbook: string } | { readonly specimen: SpecimenName; readonly header: string };
  readonly paper?: { readonly size: PaperSize; readonly orientation: PaperOrientation };
  readonly keepPages?: readonly number[];
  readonly printButton?: { readonly href: string };
  /** A chapter the stage adds to the book later: `countsBefore` is the body without it. Must name one of the book's files. */
  readonly pending?: string;
}

export type Sample = PreviewSample | BookSample;

/** The real artifact behind the 印刷／PDF 保存 button; `?p=1` is its own head script, which opens the print dialog on load. */
const PRINT_HREF = `${LINKS.sampleBook}?p=1`;

/** A specimen render as the site shows it: the row shared with the README screenshots, under the sample of the same name, plus the site's own fields. */
function specimenBook(name: SpecimenBookName, site: Pick<BookSample, 'keepPages'>): BookSample {
  const { specimen, header, ...shared }: SpecimenBook = SPECIMEN_BOOKS[name];
  return { name, kind: 'book', source: { specimen, header }, ...shared, ...site };
}

function specimenPreview(name: SpecimenPreviewName): PreviewSample {
  const { specimen, ...shared }: SpecimenPreview = SPECIMEN_PREVIEWS[name];
  return { name, kind: 'preview', source: { specimen }, ...shared };
}

export const SAMPLES: readonly Sample[] = [
  specimenBook('hero', { keepPages: [0] }),
  specimenBook('genkoyoshi', { keepPages: [0] }),
  specimenPreview('notation'),
  specimenPreview('kinsokuOff'),
  specimenPreview('kinsokuOn'),
  { name: 'cover', kind: 'book', source: { jpbook: 'book.jpbook' }, keepPages: [0] },
  { name: 'stageTyping', kind: 'preview', source: { state: 'typing' }, layout: STAGE_LAYOUT, vocabulary: 'book.jpbook' },
  { name: 'stageEmphasised', kind: 'preview', source: { state: 'emphasised' }, layout: STAGE_LAYOUT, vocabulary: 'book.jpbook' },
  { name: 'stageFixed', kind: 'preview', source: { state: 'fixed' }, layout: STAGE_LAYOUT, vocabulary: 'book.jpbook' },
  { name: 'stageBook', kind: 'book', source: { jpbook: 'book.jpbook' }, layout: STAGE_LAYOUT, keepPages: [1], printButton: { href: PRINT_HREF }, pending: LATE_CHAPTER },
];
