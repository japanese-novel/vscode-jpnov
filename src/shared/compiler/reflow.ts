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
  reflowRubyHtml,
  unitKey,
  type Row,
  type Unit,
} from './layout.ts';

/** `text`, or null when it is empty or all whitespace. */
export function nonBlank(text: string): string | null {
  return text.trim() === '' ? null : text;
}

/** One spine-level piece of a chapter: its body markup and its first 見出し that is not blank
 *  (nav label). */
export interface ReflowSegment {
  readonly body: string;
  readonly heading: string | null;
}

/**
 * Rewrites one unit for the reflow output: ruby markup is regenerated (native in every form;
 * `ru` marks a left/both-side unit for class.ruby-u.css).
 */
function reflowUnit(u: Unit): Unit {
  if (u.ruby !== undefined) {
    return { ...u, html: reflowRubyHtml(u.ruby), cssClass: u.ruby.left === undefined ? undefined : 'ru' };
  }
  return u;
}

/**
 * Binds each maximal same-class, same-channel 分離禁止 run (length ≥ 2) into ONE `.insep`
 * nowrap unit. The engine's atomic-unit binding is a wrap-time concern; here the reading
 * system wraps, and CSS `line-break` does not reliably bind these pairs. Held regardless of
 * the kinsoku mode — a split —— is broken ink, not a looser tier.
 */
function bindInsepRuns(units: readonly Unit[]): Unit[] {
  const out: Unit[] = [];
  let i = 0;
  while (i < units.length) {
    const head = units[i];
    if (head === undefined) {
      i += 1;
      continue;
    }
    const cls = insepClass(head, { bang: false });
    let end = i + 1;
    if (cls !== undefined) {
      while (end < units.length) {
        const next = units[end];
        if (next === undefined || insepClass(next, { bang: false }) !== cls || unitKey(next) !== unitKey(head)) {
          break;
        }
        end += 1;
      }
    }
    if (end - i >= 2) {
      // Channels spread from `head` — the run requires them equal, like the engine's mergeRun.
      // The run html joins member html (each one escaped glyph; a dash unit's is the translated
      // em dash) — rebuilding it from `text` would smuggle the source glyphs back in.
      const members = units.slice(i, end);
      out.push({
        ...head,
        cells: end - i,
        html: `<span class="insep">${members.map((u) => u.html).join('')}</span>`,
        text: members.map((u) => u.text).join(''),
        cssClass: 'insep',
      });
    } else {
      out.push(head);
    }
    i = end;
  }
  return out;
}

/**
 * Emits the segments of one chapter. Splits at `pagebreak` rows; leading/trailing/consecutive
 * breaks collapse (no empty segment — mirroring flowToHtml's lazily-opened segments). A line
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
  dash?: DashMode,
): ReflowSegment[] {
  const want = dash === undefined ? undefined : DASH_BY_MODE[dash];
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
    const inner = emitUnits(bindInsepRuns(row.units.map(reflowUnit)), used);
    if (row.heading !== undefined && heading === null) {
      const raw = row.units.map((u) => u.text).join('');
      const text = want === undefined ? raw : raw.replaceAll(want, DASH_GLYPH);
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
