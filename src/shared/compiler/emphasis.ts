/**
 * Maps an Aozora style-annotation variant name to its CSS class + presentation channel, and
 * supplies each class's rule for the stylesheet. The compiler emits `<span class="…">`, never an
 * inline `style=` attribute: class rules live inside the nonce'd `<style>`, which the webview CSP
 * allows and inline style attributes cannot. Pure + vscode-free.
 *
 * FOUR ORTHOGONAL presentation channels — one CSS property family each, so all four can sit on
 * one `<span>` together:
 *   emph    傍点     text-emphasis-style     emph-<slug> / emph-<slug>-l
 *   line    傍線     text-decoration-*       dec-<slug>  / dec-<slug>-l
 *   weight  太字     font-weight:bold        b
 *   style   斜体     font-style:italic       i
 *
 * A leading 左に / の左に yields the `-l` (left-side) class, valid ONLY on emph/line — 太字/斜体
 * have no side, so 左に太字 → null. {@link styleVariantsByChannel} feeds the grammar-sync drift
 * test, which keeps the tmLanguage alternations literally equal to this table — regenerate them
 * from that test's failure output, never by hand.
 */

export type Channel = 'emph' | 'line' | 'weight' | 'style';

/** A resolved variant: which presentation channel it drives and the CSS class to emit. */
export interface Style {
  readonly channel: Channel;
  /** CSS class to place on the span, e.g. `emph-fs` / `emph-fs-l` / `dec-wavy` / `b`. */
  readonly className: string;
}

interface StyleEntry {
  /** Variant name(s) selecting this style (ばつ傍点 / ×傍点 share one). */
  readonly variants: readonly string[];
  readonly channel: Channel;
  /** Base class; emph/line append `-l` for the left-side variant. */
  readonly className: string;
  /** text-emphasis-style (emph) / text-decoration-style (line); '' for weight/style. */
  readonly css: string;
}

const STYLES: readonly StyleEntry[] = [
  { variants: ['傍点'], channel: 'emph', className: 'emph-fs', css: 'filled sesame' },
  { variants: ['白ゴマ傍点'], channel: 'emph', className: 'emph-os', css: 'open sesame' },
  { variants: ['丸傍点'], channel: 'emph', className: 'emph-fc', css: 'filled circle' },
  { variants: ['白丸傍点'], channel: 'emph', className: 'emph-oc', css: 'open circle' },
  { variants: ['二重丸傍点'], channel: 'emph', className: 'emph-fd', css: 'filled double-circle' },
  { variants: ['蛇の目傍点'], channel: 'emph', className: 'emph-od', css: 'open double-circle' },
  { variants: ['黒三角傍点'], channel: 'emph', className: 'emph-ft', css: 'filled triangle' },
  { variants: ['白三角傍点'], channel: 'emph', className: 'emph-ot', css: 'open triangle' },
  // The slug `x` abbreviates; the emitted value is the full-width × glyph, never the ASCII letter.
  // The CSS <string> is single-quoted so the value stays well-formed wherever it is emitted.
  { variants: ['ばつ傍点', '×傍点'], channel: 'emph', className: 'emph-x', css: "'×'" },
  { variants: ['傍線'], channel: 'line', className: 'dec-solid', css: 'solid' },
  { variants: ['二重傍線'], channel: 'line', className: 'dec-double', css: 'double' },
  { variants: ['鎖線'], channel: 'line', className: 'dec-dotted', css: 'dotted' },
  { variants: ['破線'], channel: 'line', className: 'dec-dashed', css: 'dashed' },
  { variants: ['波線'], channel: 'line', className: 'dec-wavy', css: 'wavy' },
  { variants: ['太字'], channel: 'weight', className: 'b', css: '' },
  { variants: ['斜体'], channel: 'style', className: 'i', css: '' },
];

/** The left-side prefixes, fixed by form: postfix = の左に, span = bare 左に (semanticTokens.ts reads the same two). */
export const LEFT_LONG = 'の左に';
export const LEFT_SHORT = '左に';

/**
 * Which left prefix a variant may carry — fixed BY FORM in the Aozora spec (postfix = の左に,
 * span = bare 左に; https://www.aozora.gr.jp/annotation/emphasis.html). `'none'` (default)
 * accepts neither: block variants, and a postfix whose に/は connector was already stripped.
 */
export type DirectionForm = 'postfix' | 'span' | 'none';

/** Variant name → its table entry. Built once from {@link STYLES}. */
const VARIANTS: ReadonlyMap<string, StyleEntry> = (() => {
  const m = new Map<string, StyleEntry>();
  for (const s of STYLES) {
    for (const v of s.variants) {
      m.set(v, s);
    }
  }
  return m;
})();

/**
 * Class name → full CSS rule. The ONLY place the style CSS values live.
 * INVARIANT: no channel class may declare `position`/`transform` — a positioned channel span
 * would capture the ruby lanes' absolutely positioned reading spans (`rt>span`; pinned in
 * emphasis.test.ts).
 */
const RULES: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const s of STYLES) {
    const cn = s.className;
    switch (s.channel) {
      case 'emph':
        // `-l`: a bare `left` is INVALID CSS (`[ over | under ] && [ right | left ]?` — the browser
        // drops the whole declaration); `under` is the horizontal fallback, matching JP convention.
        m.set(cn, `.${cn}{text-emphasis-style:${s.css}}`);
        m.set(
          `${cn}-l`,
          `.${cn}-l{text-emphasis-style:${s.css};text-emphasis-position:under left}`,
        );
        break;
      case 'line':
        // `text-underline-position:right` is pinned: Chromium draws vertical-rl underlines on the
        // LEFT by default; `-l` uses `left`.
        m.set(
          cn,
          `.${cn}{text-decoration-line:underline;text-decoration-style:${s.css};text-underline-position:right}`,
        );
        m.set(
          `${cn}-l`,
          `.${cn}-l{text-decoration-line:underline;text-decoration-style:${s.css};text-underline-position:left}`,
        );
        break;
      case 'weight':
        m.set(cn, `.${cn}{font-weight:bold}`); // no -l variant (太字 has no side)
        break;
      case 'style':
        // Relies on the browser synthesising an oblique for JP fonts: never set `font-synthesis:none`.
        m.set(cn, `.${cn}{font-style:italic}`); // no -l variant (斜体 has no side)
        break;
    }
  }
  return m;
})();

/**
 * The CSS class + channel for a style variant, or `null` for an unknown one. `variant` carries NO
 * connector (the tokenizer stripped に/は); the left prefix yields the `-l` class, honoured ONLY
 * for 傍点/傍線 and only in the `form`-bound spelling ({@link DirectionForm}) — a cross-form
 * 左に/の左に finds no VARIANTS entry and degrades naturally.
 */
export function resolveStyle(variant: string, form: DirectionForm = 'none'): Style | null {
  let name = variant;
  let left = false;

  // Exactly one prefix spelling is tried per form (see DirectionForm).
  if (form === 'postfix' && name.startsWith(LEFT_LONG)) {
    name = name.slice(LEFT_LONG.length);
    left = true;
  } else if (form === 'span' && name.startsWith(LEFT_SHORT)) {
    name = name.slice(LEFT_SHORT.length);
    left = true;
  }

  const entry = VARIANTS.get(name);
  if (entry === undefined) {
    return null;
  }
  if (left) {
    if (entry.channel !== 'emph' && entry.channel !== 'line') {
      return null;
    }
    return { channel: entry.channel, className: `${entry.className}-l` };
  }
  return { channel: entry.channel, className: entry.className };
}

/**
 * The full CSS rule for a style class name (emph-* / dec-* incl. `-l`, plus b / i), or '' for an
 * unknown one. The SINGLE home of all text-emphasis / text-decoration / font-* values: css.ts's
 * classRule generates only indent-* itself and forwards every other used class here.
 */
export function styleRule(className: string): string {
  return RULES.get(className) ?? '';
}

/**
 * Recognised variant names per channel — the single source the grammar-sync test derives the
 * tmLanguage alternations from (canonical order: length desc, code-unit asc).
 */
export function styleVariantsByChannel(): Record<Channel, readonly string[]> {
  const out: Record<Channel, string[]> = { emph: [], line: [], weight: [], style: [] };
  for (const s of STYLES) {
    for (const v of s.variants) {
      out[s.channel].push(v);
    }
  }
  return out;
}
