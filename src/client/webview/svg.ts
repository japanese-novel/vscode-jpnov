/**
 * Inline SVG glyphs for the webview bundles (both run under a CSP that loads no images): one
 * `<svg>` from a viewBox and its path data, drawn in `currentColor` and hidden from assistive tech.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgGlyph(viewBox: string, paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
