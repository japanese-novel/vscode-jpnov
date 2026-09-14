/**
 * Turns one standalone compiler document (renderPreview / renderBook output) into a fragment that
 * lives inside a page: every root selector moves onto a scope class, the viewport and root-em
 * dependencies become custom properties the embed sets, and print-only rules go. Pure and
 * deterministic; the post-conditions throw rather than let a stray root rule leak into the site.
 */
import { EDGE_INSET } from '../../src/shared/compiler/geometry.ts';
import type { Fragment } from './contract.ts';

export interface PreviewScopeOptions {
  /** A class selector such as `.jp-r-hero`; every emitted selector starts with it. */
  readonly scope: string;
  readonly kind: 'preview';
}

export interface BookScopeOptions {
  readonly scope: string;
  readonly kind: 'book';
  /** Ordinals of the `.page` elements to keep (default: all). */
  readonly keepPages?: readonly number[];
  /** Keep the artifact's own 印刷／PDF 保存 button, as a link to the real artifact at `href` (which prints itself). */
  readonly printButton?: { readonly href: string };
}

export interface PreviewScoped {
  readonly fragment: Fragment;
}

export interface BookScoped extends PreviewScoped {
  /** From the build's `@page` size and root font size. */
  readonly paper: { readonly widthMm: number; readonly heightMm: number; readonly fontMm: number };
  /** Pages kept in `fragment`. */
  readonly pageCount: number;
  /** Body pages of the whole book — the folio's `{totalPage}`. */
  readonly totalPages: number;
}

/** Classes the emitters write that have no on-demand rule of their own (layout structure). */
const STRUCTURAL = new Set(['book', 'segment', 'line', 'page', 'cover', 'hd', 'pn', 'r', 'l', 'ln', 'pagebreak', 'pb-label', 'print', 'rt-l']);

/** One rule block possibly nested one level (an `@media` group of plain rules). */
const MEDIA_PRINT = /@media print\{(?:[^{}]*\{[^{}]*\})*\}/g;
const MEDIA_SCREEN = /@media screen\{((?:[^{}]*\{[^{}]*\})*)\}/g;
const PAGE_RULE = /@page\{size:(\d+(?:\.\d+)?)mm (\d+(?:\.\d+)?)mm;margin:0;\}/;
const ROOT_FONT_MM = /html\{font-size:(\d+(?:\.\d+)?)mm;\}/;
const PRINT_BUTTON = /<button class="print" type="button" onclick="window\.print\(\)">([^<]*)<\/button>/;
const BOOK_OPEN = '<div class="book">';

/** The preview's fit-to-pane formula, rebuilt from the same constant the product derives it from. */
const FIT_FORMULA = `font-size:calc((100vh - 32px) / (var(--cpl) + ${String(2 * EDGE_INSET)}));`;

function between(html: string, open: string, close: string): string {
  const start = html.indexOf(open);
  const end = html.indexOf(close, start + open.length);
  if (start < 0 || end < 0) {
    throw new Error(`scope: ${open}…${close} not found`);
  }
  return html.slice(start + open.length, end);
}

/** Splits the `.book` inner HTML into its `.page` elements (pages never nest). */
function splitPages(book: string): string[] {
  return book.split(/(?=<div class="page[ "])/).filter((s) => s !== '');
}

function prefixSelectors(css: string, scope: string): string {
  if (css.includes('@')) {
    throw new Error(`scope: an at-rule survived the rewrite: ${css.slice(css.indexOf('@'), css.indexOf('@') + 40)}`);
  }
  return css
    .split('}')
    .filter((rule) => rule.trim() !== '')
    .map((rule) => {
      const brace = rule.indexOf('{');
      const selectors = rule.slice(0, brace).split(',').map((s) => s.trim());
      const prefixed = selectors.map((s) => (s.startsWith(scope) ? s : `${scope} ${s}`)).join(',');
      return `${prefixed}${rule.slice(brace)}}`;
    })
    .join('');
}

function baseRule(scope: string, kind: 'preview' | 'book'): string {
  const reset = `${scope},${scope} *,${scope} *::before,${scope} *::after{box-sizing:content-box;}`;
  if (kind === 'preview') {
    // The embed sets --jp-vh (the pane height); the band and the em follow the product's own
    // fit formula, and inline-size (= height under vertical-rl) is the band, padding excluded.
    return `${scope}{display:inline-block;vertical-align:top;position:relative;inline-size:var(--jp-band);` +
      `--jp-band:calc(var(--jp-vh) - 32px);--jp-em:calc(var(--jp-band) / (var(--cpl) + ${String(2 * EDGE_INSET)}));}${reset}`;
  }
  return `${scope}{display:block;position:relative;font-size:var(--jp-em);}${reset}`;
}

/** Drops the print-only rules, capturing the book's paper size and root font size on the way. */
function stripPrintRules(raw: string): { css: string; size: { widthMm: number; heightMm: number } | undefined; fontMm: number | undefined } {
  let size: { widthMm: number; heightMm: number } | undefined;
  let fontMm: number | undefined;
  const css = raw
    .replace(MEDIA_PRINT, '')
    .replace(MEDIA_SCREEN, '$1')
    .replace(PAGE_RULE, (_m, w: string, h: string) => {
      size = { widthMm: Number(w), heightMm: Number(h) };
      return '';
    })
    .replace(ROOT_FONT_MM, (_m, f: string) => {
      fontMm = Number(f);
      return '';
    });
  return { css, size, fontMm };
}

/** The root-relative rewrites every fragment needs, then the scope prefix on every selector. */
function finishCss(css: string, scope: string, kind: 'preview' | 'book'): string {
  const rewritten = css
    .replaceAll('100vh - 32px', 'var(--jp-band)')
    .replace(/(\d*\.?\d+)rem\b/g, 'calc($1 * var(--jp-em))')
    .replace(/(^|\})(html|body|:root)\{/g, `$1${scope}{`)
    .replaceAll('var(--vscode-editor-background,#fff)', 'var(--jp-bg,#fff)')
    .replaceAll('var(--vscode-editorLineNumber-foreground,#888)', 'var(--jp-ln,#888)')
    .replace('.print{position:fixed;', '.print{position:absolute;')
    .replace(`${scope}{background:#e8e8e8;}`, '');
  return baseRule(scope, kind) + prefixSelectors(rewritten, scope);
}

/** The artifact's button becomes a link (or goes), and only the kept pages stay in the body. */
function keepBookPages(body: string, opts: BookScopeOptions): { body: string; pageCount: number; totalPages: number } {
  const href = opts.printButton?.href;
  if (href !== undefined && /["<>&]/.test(href)) {
    throw new Error(`scope: unsafe print href ${href}`);
  }
  const linked = body.replace(PRINT_BUTTON, (_m, label: string) => (href === undefined ? '' : `<a class="print" href="${href}" target="_blank" rel="noopener">${label}</a>`));
  const bookStart = linked.indexOf(BOOK_OPEN);
  const pages = splitPages(linked.slice(bookStart + BOOK_OPEN.length, linked.lastIndexOf('</div>')));
  const kept = (opts.keepPages ?? pages.map((_p, i) => i)).map((i) => {
    const page = pages[i];
    if (page === undefined) {
      throw new Error(`scope: keepPages asks for page ${String(i)} of ${String(pages.length)}`);
    }
    return page;
  });
  return {
    body: `${linked.slice(0, bookStart)}${BOOK_OPEN}${kept.join('')}</div>`,
    pageCount: kept.length,
    totalPages: pages.filter((p) => !p.startsWith('<div class="page cover"')).length,
  };
}

/** The post-conditions: nothing root-relative in the stylesheet, nothing live in the body, no bare class. */
function assertClean(css: string, body: string): void {
  for (const leak of ['html{', 'body{', ':root{', '@page', '@media', '--vscode-', 'position:fixed']) {
    if (css.includes(leak)) {
      throw new Error(`scope: "${leak}" survived in the stylesheet`);
    }
  }
  const unit = /\d(?:rem|vh)\b/.exec(css);
  if (unit !== null) {
    throw new Error(`scope: a root-relative unit survived in the stylesheet: ${css.slice(Math.max(0, unit.index - 30), unit.index + 10)}`);
  }
  for (const leak of ['<script', 'onclick=']) {
    if (body.includes(leak)) {
      throw new Error(`scope: "${leak}" survived in the body`);
    }
  }
  for (const m of body.matchAll(/class="([^"]*)"/g)) {
    for (const token of (m[1] ?? '').split(' ')) {
      if (token !== '' && !STRUCTURAL.has(token) && !/^indent-\d+$/.test(token) && !css.includes(`.${token}`)) {
        throw new Error(`scope: class "${token}" has no rule in the stylesheet`);
      }
    }
  }
}

export function scopeFragment(html: string, opts: PreviewScopeOptions): PreviewScoped;
export function scopeFragment(html: string, opts: BookScopeOptions): BookScoped;
export function scopeFragment(html: string, opts: PreviewScopeOptions | BookScopeOptions): PreviewScoped | BookScoped {
  const { scope } = opts;
  const stripped = stripPrintRules(between(html, '<style>', '</style>'));
  const body = between(html, '<body>', '</body>').replace(/<script>[\s\S]*?<\/script>/g, '');
  if (opts.kind === 'preview') {
    if (!stripped.css.includes(FIT_FORMULA)) {
      throw new Error('scope: the preview fit formula changed; update FIT_FORMULA and the band derivation');
    }
    const css = finishCss(stripped.css.replace(FIT_FORMULA, 'font-size:var(--jp-em);'), scope, 'preview');
    assertClean(css, body);
    return { fragment: { scope, css, body } };
  }
  if (stripped.size === undefined || stripped.fontMm === undefined) {
    throw new Error('scope: the book stylesheet carries no @page size / root font size');
  }
  const css = finishCss(stripped.css, scope, 'book');
  const pages = keepBookPages(body, opts);
  assertClean(css, pages.body);
  return { fragment: { scope, css, body: pages.body }, paper: { ...stripped.size, fontMm: stripped.fontMm }, pageCount: pages.pageCount, totalPages: pages.totalPages };
}
