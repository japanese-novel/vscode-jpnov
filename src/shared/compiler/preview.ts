import type { Ast } from '../ast/nodes.ts';
import type { LayoutSettings } from '../config/types.ts';
import type { PreviewChrome } from './chrome.ts';
import { emrProbe, stylesheet } from './css.ts';
import { buildRows, flowToHtml } from './layout.ts';

/**
 * Renders one resolved manuscript (the editor's parse, no values) as a full standalone `<html>`
 * document for the preview pane: a CONTINUOUS line flow (no pagination) built by the SAME layout
 * engine the book build uses, so the preview agrees with the printed page. Lines hard-wrap at
 * `charsPerLine` (折り返し), and the stylesheet scales its font so a full charsPerLine-char line
 * fills the pane height; `kinsoku` selects the 禁則処理 tier; ［＃改ページ］ shows as a labelled
 * `<div class="pagebreak">` marker rather than a real page break, and every `linesPerPage`
 * columns a label-less one marks where the build would turn the page (see {@link flowToHtml}).
 * `chrome` drives the line-head numbers (JS-numbered `.ln` spans, continuous through the file)
 * and the CSS-only column edge rules.
 * Each column carries its source line (`data-line`) and, once a line wraps, where in the line
 * the column starts (`data-ch`), so the client can park the column holding the editor cursor.
 *
 * All options are required and pre-resolved (the settings resolver is the only default layer);
 * "off" is the explicit `{ lineNumbers: false, edgeLine: 'none' }`. Pure + vscode-free (the
 * client owns the CSP/nonce + the scroll script when injecting this into a webview).
 */
export function renderPreview(
  ast: Ast,
  opts: LayoutSettings & { chrome: PreviewChrome },
): string {
  // Render the body first so the CSS includes ONLY the classes it used (the sort is
  // lexicographic, deterministic).
  const used = new Set<string>();
  const body = flowToHtml(
    buildRows(ast, { dash: opts.dash }),
    opts.charsPerLine,
    opts.linesPerPage,
    opts.kinsoku,
    used,
    opts.chrome.lineNumbers,
  );
  // charsPerLine also drives the stylesheet's fit-to-viewport font-size (a full line
  // fills the pane height), so it MUST match the wrap width used above.
  const css = stylesheet({
    paginate: false,
    charsPerLine: opts.charsPerLine,
    linePitch: opts.linePitch,
    linesPerPage: opts.linesPerPage,
    fontFamily: opts.fontFamily,
    chrome: opts.chrome,
    usedClasses: [...used].sort(),
  });
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}${emrProbe(used)}</body></html>`;
}
