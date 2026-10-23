/**
 * The specimen renders in docs/specimens/, as the README screenshots (scripts/screenshots.ts) and
 * the website (website/scripts/samples.ts) show them: one table per render kind of the settings
 * each render differs in from the product defaults, so the two never drift. The credit for the
 * 青空文庫 text is in docs/specimens/README.md and beside every use.
 */
import type { BuildChrome, PreviewChrome } from '../src/shared/compiler/chrome.ts';
import type { LayoutSettings } from '../src/shared/config/types.ts';

export const SPECIMENS = ['neko', 'notation', 'kinsoku'] as const;
export type SpecimenName = (typeof SPECIMENS)[number];

/** 『吾輩は猫である』 (青空文庫) — the one non-placeholder text. */
const NEKO_HEADER = '吾輩は猫である';

export interface SpecimenBook {
  readonly specimen: SpecimenName;
  readonly header: string;
  readonly layout?: Partial<LayoutSettings>;
  readonly chrome?: Partial<Pick<BuildChrome, 'lineNumbers' | 'edgeLine'>>;
}

export interface SpecimenPreview {
  readonly specimen: SpecimenName;
  readonly layout?: Partial<LayoutSettings>;
  readonly chrome?: Partial<PreviewChrome>;
}

export const SPECIMEN_BOOKS = {
  hero: { specimen: 'neko', header: NEKO_HEADER },
  // 罫線あり — 既定の行送り 1.5 では罫線がルビを横切る
  genkoyoshi: { specimen: 'neko', header: NEKO_HEADER, layout: { linePitch: 2 }, chrome: { lineNumbers: true, edgeLine: 'red' } },
} as const satisfies Record<string, SpecimenBook>;

export const SPECIMEN_PREVIEWS = {
  // 見本に左ルビがある — 既定の行送り 1.5 では隣の行に重なる
  notation: { specimen: 'notation', layout: { charsPerLine: 9, linePitch: 2 }, chrome: { lineNumbers: false } },
  kinsokuOff: { specimen: 'kinsoku', layout: { charsPerLine: 20, kinsoku: 'none' }, chrome: { lineNumbers: false } },
  kinsokuOn: { specimen: 'kinsoku', layout: { charsPerLine: 20 }, chrome: { lineNumbers: false } },
} as const satisfies Record<string, SpecimenPreview>;

export type SpecimenBookName = keyof typeof SPECIMEN_BOOKS;
export type SpecimenPreviewName = keyof typeof SPECIMEN_PREVIEWS;
