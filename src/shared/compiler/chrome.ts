/**
 * The rendering "chrome" vocabulary (page furniture): line numbers, edge rules, and the page
 * header and footer. Shared by the preview + build renderers, the wire protocol, and the
 * settings resolver. Import-free: the compiler OWNS this vocabulary; `protocol.ts` and
 * `config/settings.ts` import from here (never the other way round — the compiler must not
 * depend on the wire).
 *
 * Every shape below is the RESOLVED form: all fields present, no optionals. The settings
 * resolver fills defaults and clamps, and composeBookChrome fills the build's header and footer
 * from the book, before one of these is constructed; renderer inputs
 * are required, so "off" is always an explicit value (`lineNumbers: false`,
 * `edgeLine: 'none'`, `header: ''`, `footer: ''`).
 */

export const EDGE_LINE_STYLES = ['none', 'text', 'red'] as const;
export type EdgeLineStyle = (typeof EDGE_LINE_STYLES)[number];

/**
 * Header and footer placement (`headerAlign` / `footerAlign`), hand-typed in `.jpbook` front
 * matter, so the members are terse: `right`/`left` pin one side, `rightLeft`/`leftRight` alternate
 * per page starting on the named side, `center` centres. An empty line hides a header or footer.
 */
export const FURNITURE_ALIGNS = [
  'right',
  'left',
  'rightLeft',
  'leftRight',
  'center',
] as const;
export type FurnitureAlign = (typeof FURNITURE_ALIGNS)[number];

export interface PreviewChrome {
  /** Line-head numbers, continuous through the file (the build's restart per page). */
  readonly lineNumbers: boolean;
  /** Inter-column rules; `text` draws in the text colour (currentColor), all rules at 80% alpha. */
  readonly edgeLine: EdgeLineStyle;
}

export interface BuildChrome {
  /** Line-head numbers, restarting at 1 on every page. */
  readonly lineNumbers: boolean;
  /** Inter-column rules + a matching page frame; `text` draws in the text colour (currentColor), all rules at 80% alpha. */
  readonly edgeLine: EdgeLineStyle;
  /** Single-line header at the physical top of every page, filled like `footer`; blank after trim = none (band stays reserved). */
  readonly header: string;
  /** Where the header sits on each page. */
  readonly headerAlign: FurnitureAlign;
  /**
   * Footer line: `.jpnov` notation whose ［＃ここに「…」の値を表示］ fields fill from the book and
   * the page (VALUE_NAMES in ast/notation.ts), in kanji under ［＃ここに「…」の値を命数で表示］
   * (VALUE_FORMATS); everything else prints as typed. Blank after trim = none (band stays
   * reserved).
   */
  readonly footer: string;
  /** Where the footer sits on each page. */
  readonly footerAlign: FurnitureAlign;
}
