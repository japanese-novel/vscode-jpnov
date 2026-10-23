/**
 * Inline-SVG glyphs for the build buttons (a printer on the primary print button, the EPUB
 * mark on its icon button) — the webview CSP loads no external images, and currentColor
 * keeps them right in every theme. `print` is Fluent UI System Icons' ic_fluent_print_16_regular
 * (MIT, https://github.com/microsoft/fluentui-system-icons; codicons have no printer). `epub` is
 * the mark-only cut of the official logo (https://www.w3.org/publishing/groups/epub-wg/, whose
 * usage guide allows the bare mark), its viewBox the mark's measured bounds. Data only: the
 * website draws the same marks on its reconstructed Books view.
 */
export const GLYPH = {
  print: {
    viewBox: '0 0 16 16',
    d: [
      'M4 3.5C4 2.67157 4.67157 2 5.5 2H10.5C11.3284 2 12 2.67157 12 3.5V4H13C14.1046 4 15 4.89543 15 6V10.5C15 11.3284 14.3284 12 13.5 12H12V12.5C12 13.3284 11.3284 14 10.5 14H5.5C4.67157 14 4 13.3284 4 12.5V12H2.5C1.67157 12 1 11.3284 1 10.5V6C1 4.89543 1.89543 4 3 4H4V3.5ZM4 11V10.5C4 9.67157 4.67157 9 5.5 9H10.5C11.3284 9 12 9.67157 12 10.5V11H13.5C13.7761 11 14 10.7761 14 10.5V6C14 5.44772 13.5523 5 13 5H3C2.44772 5 2 5.44772 2 6V10.5C2 10.7761 2.22386 11 2.5 11H4ZM5 4H11V3.5C11 3.22386 10.7761 3 10.5 3H5.5C5.22386 3 5 3.22386 5 3.5V4ZM5 10.5V12.5C5 12.7761 5.22386 13 5.5 13H10.5C10.7761 13 11 12.7761 11 12.5V10.5C11 10.2239 10.7761 10 10.5 10H5.5C5.22386 10 5 10.2239 5 10.5Z',
    ],
  },
  epub: {
    viewBox: '97.1 135.5 401.2 401.2',
    d: [
      'M297.63,462.07,171.58,336l126-126,42,42-84.05,84,42,42L423.69,252,313.88,142.17a23,23,0,0,0-32.48,0L103.79,319.78a23,23,0,0,0,0,32.48L281.4,529.86a23,23,0,0,0,32.48,0l177.61-177.6a23,23,0,0,0,0-32.48L465.7,294Z',
    ],
  },
} as const;
