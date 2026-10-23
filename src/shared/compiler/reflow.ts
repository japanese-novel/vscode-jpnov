/**
 * The REFLOW emitter: `Row[]` → XHTML body segments for the EPUB output. The reading system
 * owns line breaking, pagination and page chrome, so everything the paginated build decides
 * downstream of {@link buildRows} (wrapping, 禁則, ぶら下げ, page furniture) is absent here —
 * one logical source line becomes one `<p>` (or `<hN>`), and ［＃改ページ］ becomes a segment
 * boundary the container turns into a spine-level file split. 字下げ is the one layout value
 * carried over: it is capped at `charsPerLine − 1`, like the paginated build.
 *
 * Inline markup differences against the paginated build:
 * - ruby is native `<ruby>` in every form ({@link reflowRubyHtml} — the reader owns spacing;
 *   left/both-side readings ride `ruby-position`, not the paginated absolute lanes);
 * - 分離禁止 runs (——/……) are bound by an `.insep` nowrap span instead of atomic units.
 *
 * Pure + vscode-free.
 */
import type { DashMode } from '../config/types.ts';
import { DASH_BY_MODE, DASH_GLYPH } from '../dash.ts';
import { escapeHtml } from '../utils/escape.ts';
import {
  effectiveIndent,
  emitUnits,
  insepClass,
  insepRunEnd,
  mergeRun,
  type Row,
  type RubyText,
  type Unit,
  UnitPatcher,
} from './layout.ts';

/** `text`, or null when it is empty or all whitespace. */
export function nonBlank(text: string): string | null {
  return text.trim() === '' ? null : text;
}

/** One spine-level piece of a chapter: its body markup and its first 見出し that is not blank
 *  (nav label), without the spaces at its ends. */
export interface ReflowSegment {
  readonly body: string;
  readonly heading: string | null;
}

/**
 * A ruby unit's markup for the reflow output: NATIVE `<ruby>` in every form — the reading system
 * owns spacing and overhang. A left-side reading rides `ruby.ru` (class.ruby-u.css moves it to
 * the under side); a both-side ruby nests, the HTML double-sided pattern. The paginated lanes
 * cannot serve here: Apple Books neutralizes position:absolute in reflowable EPUB, dropping the
 * absolutely positioned readings into the text flow.
 */
function reflowRubyHtml(r: RubyText): string {
  if (r.left === undefined) {
    return `<ruby>${escapeHtml(r.base)}<rt>${escapeHtml(r.right?.text ?? '')}</rt></ruby>`;
  }
  const left = `<rt>${escapeHtml(r.left.text)}</rt>`;
  if (r.right === undefined) {
    return `<ruby class="ru">${escapeHtml(r.base)}${left}</ruby>`;
  }
  return `<ruby class="ru"><ruby>${escapeHtml(r.base)}<rt>${escapeHtml(r.right.text)}</rt></ruby>${left}</ruby>`;
}

/**
 * A row's units for the reflow output, in one pass: each maximal same-class, same-channel 分離禁止
 * run (length ≥ 2) bound into ONE `.insep` nowrap unit, each ruby unit's markup regenerated (native
 * in every form; `ru` marks a left/both-side unit for class.ruby-u.css). Returns `units` itself when
 * nothing changes — most rows. The engine's atomic-unit binding is a wrap-time concern; here the
 * reading system wraps, and CSS `line-break` does not reliably bind these pairs. Held regardless of
 * the kinsoku mode — a split —— is broken ink, not a looser tier.
 */
function reflowUnits(units: readonly Unit[]): readonly Unit[] {
  const patch = new UnitPatcher(units);
  for (let i = 0; i < units.length;) {
    const head = units[i];
    if (head === undefined) {
      i += 1;
      continue;
    }
    const cls = insepClass(head, false);
    const end = cls === undefined ? i + 1 : insepRunEnd(units, head, i, cls, false);
    if (end - i >= 2) {
      // The run html joins member html (each one escaped glyph; a dash unit's is the translated
      // em dash) — rebuilding it from `text` would smuggle the source glyphs back in.
      const merged = mergeRun(units, head, i, end);
      patch.replace(i, end, { ...merged, html: `<span class="insep">${merged.html}</span>`, cssClass: 'insep' });
    } else if (head.ruby !== undefined) {
      patch.replace(i, end, { ...head, html: reflowRubyHtml(head.ruby), cssClass: head.ruby.left === undefined ? undefined : 'ru' });
    }
    i = end;
  }
  return patch.done();
}

/**
 * Emits the segments of one chapter. Splits at `pagebreak` rows; leading/trailing/consecutive
 * breaks collapse (no empty segment — as the preview's cutPages makes no empty page). A line
 * row becomes `<p>` — or `<hN>` for a 見出し row (大=1→h1; one hN PER ROW: a block-form
 * heading spans rows, but Row carries no form, and merging could fuse two adjacent independent
 * headings). A row with no real cells (blank or comment-only line) gets a `<br/>` inside its
 * `<p>` or `<hN>` so the blank column survives reader margin handling. `charsPerLine` caps the 字下げ
 * ({@link effectiveIndent}). `used` is the on-demand class sink.
 * `dash` translates the configured dash inside nav labels too — the body units arrive already
 * translated from {@link buildRows}.
 */
export function reflowSegments(
  rows: readonly Row[],
  charsPerLine: number,
  used: Set<string>,
  dash: DashMode,
): ReflowSegment[] {
  const want = DASH_BY_MODE[dash];
  const segments: ReflowSegment[] = [];
  let body = '';
  let heading: string | null = null;

  const close = (): void => {
    if (body !== '') {
      segments.push({ body, heading });
      body = '';
      heading = null;
    }
  };

  for (const row of rows) {
    if (row.kind === 'pagebreak') {
      close();
      continue;
    }
    const indent = effectiveIndent(row.indent, charsPerLine);
    const classAttr = indent > 0 ? ` class="indent-${String(indent)}"` : '';
    if (indent > 0) {
      used.add(`indent-${String(indent)}`);
    }
    const inner = emitUnits(reflowUnits(row.units), used).html;
    if (row.heading !== undefined && heading === null) {
      // The label is a nav entry, where the spaces of a ［＃○字下げ］ or a typed indent have no
      // place: the row's text trimmed. The <hN> keeps them, as the paginated page shows them.
      const raw = row.units.map((u) => u.text).join('').trim();
      const text = raw.replaceAll(want, DASH_GLYPH);
      heading = nonBlank(text);
    }
    const tag = row.heading === undefined ? 'p' : `h${String(row.heading)}`;
    const br = row.units.every((u) => u.cells === 0) ? '<br/>' : '';
    body += `<${tag}${classAttr}>${inner}${br}</${tag}>`;
  }
  close();
  return segments;
}

/**
 * Wraps one segment body as a complete EPUB 3 content document (XHTML). The XML declaration
 * carries the encoding (no `<meta charset>`), and the shared stylesheet is a `<link>` — the
 * container serves it as its own member so every chapter shares one file.
 */
export function reflowDocument(title: string, body: string, cssHref: string): string {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<!DOCTYPE html>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" lang="ja">' +
    `<head><title>${escapeHtml(title)}</title>` +
    `<link rel="stylesheet" type="text/css" href="${escapeHtml(cssHref)}"/></head>` +
    `<body>${body}</body></html>`;
}
