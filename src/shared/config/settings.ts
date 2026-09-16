/**
 * Resolves the wire settings payload (`jpnov.layout/preview/paper.*`) into fully-clamped,
 * enum-checked {@link PreviewSettings} / {@link HtmlSettings}. This is the SINGLE home of
 * the product defaults ({@link LAYOUT_DEFAULT} + the chrome/paper default tables); the
 * config-codegen test locks the package.json `default`s to these constants.
 *
 * The input types are the full wire shapes (the client always sends every field), but the
 * helpers take `unknown` on purpose: an IPC payload is untrusted at runtime, and a
 * hand-edited settings.json can carry out-of-range numbers or bogus enum strings —
 * anything invalid coerces to its default. This is validation, not a compatibility layer.
 * Pure + vscode-free.
 */
import type { EdgeLineStyle, FooterAlign } from '../compiler/chrome.ts';
import { EDGE_LINE_STYLES } from '../compiler/chrome.ts';
import type { PaperOrientation, PaperSize } from '../compiler/geometry.ts';
import { PAPER_ORIENTATIONS, PAPER_SIZES } from '../compiler/geometry.ts';
import { VALUE_NAMES, valueAnnotation } from '../compiler/tokenizer.ts';
import type { HtmlSettings, PreviewSettings } from '../protocol.ts';
import type { LayoutSettings } from './types.ts';
import { AUTO_TCY_MODES, CHARS_MAX, CHARS_MIN, DASH_MODES, KINSOKU_MODES, LAYOUT_DEFAULT, LINE_PITCHES } from './types.ts';

export const PREVIEW_CHROME_DEFAULT = {
  lineNumbers: true,
  edgeLine: 'none',
} as const satisfies { lineNumbers: boolean; edgeLine: EdgeLineStyle };

/**
 * Defaults for the `jpnov.layout.paper.size`/`.orientation` settings: the physical output
 * paper — a device concern, never page furniture or book identity.
 */
export const BUILD_PAPER_DEFAULT = {
  paperSize: 'a4',
  paperOrientation: 'auto',
} as const satisfies { paperSize: PaperSize; paperOrientation: PaperOrientation };

/**
 * `lineNumbers`/`edgeLine` default the `jpnov.layout.paper.*` settings; the page-furniture fields
 * (`footerAlign`/`footer`/`header`) are NOT settings — they default a `.jpbook`'s front
 * matter when it omits the key (see `composeBookChrome`).
 */
export const BUILD_CHROME_DEFAULT = {
  lineNumbers: false,
  edgeLine: 'none',
  footerAlign: 'right',
  footer: `${valueAnnotation(VALUE_NAMES.page)} / ${valueAnnotation(VALUE_NAMES.totalPages)}`,
  header: '',
} as const satisfies {
  lineNumbers: boolean;
  edgeLine: EdgeLineStyle;
  footerAlign: FooterAlign;
  footer: string;
  header: string;
};

/** A safe integer clamped to [{@link CHARS_MIN}..{@link CHARS_MAX}]; anything else → `fallback`. */
function clampChars(value: unknown, fallback: number): number {
  if (!Number.isSafeInteger(value)) {
    return fallback;
  }
  const n = value as number;
  return n < CHARS_MIN ? CHARS_MIN : n > CHARS_MAX ? CHARS_MAX : n;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Any string passes (css.ts sanitizes at emission); anything else → `fallback`. */
function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** `value` when it is a member of `allowed`, else `fallback`. */
function enumOr<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (typeof value === 'string' || typeof value === 'number') &&
      (allowed as readonly (string | number)[]).includes(value)
    ? (value as T)
    : fallback;
}

/** The shared `jpnov.layout.*` slice, resolved once for both wire snapshots. */
function resolveLayout(s: LayoutSettings): LayoutSettings {
  return {
    charsPerLine: clampChars(s.charsPerLine, LAYOUT_DEFAULT.charsPerLine),
    linesPerPage: clampChars(s.linesPerPage, LAYOUT_DEFAULT.linesPerPage),
    linePitch: enumOr(s.linePitch, LINE_PITCHES, LAYOUT_DEFAULT.linePitch),
    fontFamily: stringOr(s.fontFamily, LAYOUT_DEFAULT.fontFamily),
    kinsoku: enumOr(s.kinsoku, KINSOKU_MODES, LAYOUT_DEFAULT.kinsoku),
    autoTcy: enumOr(s.autoTcy, AUTO_TCY_MODES, LAYOUT_DEFAULT.autoTcy),
    dash: enumOr(s.dash, DASH_MODES, LAYOUT_DEFAULT.dash),
  };
}

export function resolvePreviewSettings(s: PreviewSettings): PreviewSettings {
  return {
    ...resolveLayout(s),
    lineNumbers: boolOr(s.lineNumbers, PREVIEW_CHROME_DEFAULT.lineNumbers),
    edgeLine: enumOr(s.edgeLine, EDGE_LINE_STYLES, PREVIEW_CHROME_DEFAULT.edgeLine),
  };
}

export function resolveHtmlSettings(s: HtmlSettings): HtmlSettings {
  return {
    ...resolveLayout(s),
    lineNumbers: boolOr(s.lineNumbers, BUILD_CHROME_DEFAULT.lineNumbers),
    edgeLine: enumOr(s.edgeLine, EDGE_LINE_STYLES, BUILD_CHROME_DEFAULT.edgeLine),
    paperSize: enumOr(s.paperSize, PAPER_SIZES, BUILD_PAPER_DEFAULT.paperSize),
    paperOrientation: enumOr(s.paperOrientation, PAPER_ORIENTATIONS, BUILD_PAPER_DEFAULT.paperOrientation),
  };
}
