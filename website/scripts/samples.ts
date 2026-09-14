/** The sample table: which source, which product options, which scoping, per render. */
import type { LayoutSettings } from '../../src/shared/config/types.ts';
import type { BuildChrome, PreviewChrome } from '../../src/shared/compiler/chrome.ts';
import type { PaperOrientation, PaperSize } from '../../src/shared/compiler/geometry.ts';
import { LINKS } from '../src/copy/links.ts';
import type { SampleName } from './contract.ts';
import type { Vocabulary } from './editor.ts';

/** docs/specimens/: the README screenshot specimens, shared so the site shows the same text. */
export const SPECIMENS = ['neko', 'notation', 'kinsoku'] as const;
export type SpecimenName = (typeof SPECIMENS)[number];

/** The stage's cast and coined words (`jpnov.editor.highlight.*` in the sample workspace). */
export const VOCABULARY: Vocabulary = {
  cast: ['山田　太郎', '山田　花子', 'John Smith'],
  keywords: ['王都', '聖剣'],
};

/**
 * The stage's 書式 (`jpnov.layout.charsPerLine` / `linesPerPage`): fewer cells than the 40×34
 * default, so the preview pane and the printed page read at a glance from across a desk.
 */
export const STAGE_LAYOUT: Partial<LayoutSettings> = { charsPerLine: 25, linesPerPage: 25 };

export interface PreviewSample {
  readonly name: SampleName;
  readonly kind: 'preview';
  /** A specimen, or a stage state derived from chapter1.jpnov. */
  readonly source: { readonly specimen: SpecimenName } | { readonly state: 'typing' | 'emphasised' | 'fixed' };
  readonly layout?: Partial<LayoutSettings>;
  readonly chrome?: Partial<PreviewChrome>;
  /** Colour the editor lines and lint the source (the stage samples). */
  readonly vocabulary?: Vocabulary;
}

export interface BookSample {
  readonly name: SampleName;
  readonly kind: 'book';
  /** Either a `.jpbook` in `src/samples/` or a one-file book from a specimen. */
  readonly source: { readonly jpbook: string } | { readonly specimen: SpecimenName; readonly header: string };
  readonly layout?: Partial<LayoutSettings>;
  readonly chrome?: Partial<Pick<BuildChrome, 'lineNumbers' | 'edgeLine'>>;
  readonly paper?: { readonly size: PaperSize; readonly orientation: PaperOrientation };
  readonly keepPages?: readonly number[];
  readonly printButton?: { readonly href: string };
}

export type Sample = PreviewSample | BookSample;

/** The real artifact behind the 印刷／PDF 保存 button; `?p=1` is its own head script, which opens the print dialog on load. */
const PRINT_HREF = `${LINKS.sampleBook}?p=1`;

/** 『吾輩は猫である』 (青空文庫) — the one non-placeholder text; the credit sits beside every use. */
const NEKO_HEADER = '吾輩は猫である';

export const SAMPLES: readonly Sample[] = [
  { name: 'hero', kind: 'book', source: { specimen: 'neko', header: NEKO_HEADER }, keepPages: [0] },
  { name: 'genkoyoshi', kind: 'book', source: { specimen: 'neko', header: NEKO_HEADER }, layout: { linePitch: 2 }, chrome: { lineNumbers: true, edgeLine: 'red' }, keepPages: [0] },
  { name: 'notation', kind: 'preview', source: { specimen: 'notation' }, layout: { charsPerLine: 9, linePitch: 2 }, chrome: { lineNumbers: false } },
  { name: 'kinsokuOff', kind: 'preview', source: { specimen: 'kinsoku' }, layout: { charsPerLine: 20, kinsoku: 'none' }, chrome: { lineNumbers: false } },
  { name: 'kinsokuOn', kind: 'preview', source: { specimen: 'kinsoku' }, layout: { charsPerLine: 20 }, chrome: { lineNumbers: false } },
  { name: 'cover', kind: 'book', source: { jpbook: 'book.jpbook' }, keepPages: [0] },
  { name: 'stageTyping', kind: 'preview', source: { state: 'typing' }, layout: STAGE_LAYOUT, vocabulary: VOCABULARY },
  { name: 'stageEmphasised', kind: 'preview', source: { state: 'emphasised' }, layout: STAGE_LAYOUT, vocabulary: VOCABULARY },
  { name: 'stageFixed', kind: 'preview', source: { state: 'fixed' }, layout: STAGE_LAYOUT, vocabulary: VOCABULARY },
  { name: 'stageBook', kind: 'book', source: { jpbook: 'book.jpbook' }, layout: STAGE_LAYOUT, keepPages: [1], printButton: { href: PRINT_HREF } },
];
