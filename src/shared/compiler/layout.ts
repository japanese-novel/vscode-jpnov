/**
 * The layout engine: `buildRows` turns the AST into rows of units for every output; `paginate` /
 * `pagesToHtml` flow them into the build's page → line DOM skeleton
 * (`<div class="page"><div class="grid"><div class="line">…`), `flowToHtml` into the preview's
 * continuous flow. The build is paginated IN the compiler so printed pages are
 * WYSIWYG and the page furniture (header, footer, line numbers, 原稿用紙 grid) has real
 * elements to hang off. Pure + vscode-free.
 *
 * Line breaking is a simple hard wrap at `charsPerLine` cells (a character = 1 cell,
 * a ruby unit = its TRUE advance — the base char count, or the longest reading's extent in
 * whole cells when that is longer — and is atomic, a 縦中横 cell = ALWAYS 1 cell however many
 * chars it combines, emphasis adds no cells, comments are zero-width). 禁則処理 is selected
 * by the `kinsoku` mode (`none` = bare wrap) and lives in {@link wrapRow}: 分離禁止 binding,
 * ぶら下げ of a trailing 句読点, the space dropped after a line-end 区切り約物, then the leftward
 * 追い出し nudge of the break point.
 * ［＃改ページ］ forces a new page.
 *
 * What the notation MEANS is the AST's call (ast/resolve.ts): this module reads a line's content
 * and state and decides only how they are set on the page.
 */
import type { Ast, HeadingLevel, Inline, Line, Mark, Marks, ValueLookup } from '../ast/nodes.ts';
import { paintsNothing } from '../ast/resolve.ts';
import type { DashMode, KinsokuMode } from '../config/types.ts';
import { graphemeCount, graphemes, headChar } from '../chars.ts';
import { DASH_BY_MODE, DASH_CHARS, DASH_GLYPH } from '../dash.ts';
import type { BuildChrome } from './chrome.ts';
import { markClass } from './emphasis.ts';
import { escapeComment, escapeHtml } from '../utils/escape.ts';
import { cutFurniture, pageFurniture } from './furniture.ts';

/** The strings of a ruby unit: its base and the reading on either side. */
export interface RubyText {
  base: string;
  right?: string | undefined;
  left?: string | undefined;
}

/**
 * One laid-out glyph group: a character (1 cell, one grapheme cluster), a ruby unit (base char
 * count, atomic), or a 縦中横 cell (ALWAYS 1 cell however many half-width chars it combines, atomic).
 */
export interface Unit {
  cells: number;
  html: string;
  /** The displayed text the 禁則 classes read, a cluster classed by its first code point; '' for zero-width units (comments). */
  text: string;
  /**
   * Where the unit was written: its UTF-16 offset in its source line. A value's characters come
   * from their annotation and count as written where it ends, so the annotation belongs to the
   * column before.
   */
  readonly at: number;
  /**
   * Space-separated on-demand stylesheet classes baked inside `html` (tcy / rr / lr / br /
   * rh-N / hang / insep / ru) — not channels (invisible to unitKey); emitLine collects them into
   * `used` so css.ts emits each rule only when actually present (zero dead rules).
   */
  cssClass?: string | undefined;
  /**
   * Structured readings for a ruby unit — the settle pass and the reflow emitter regenerate
   * `html` from this, so the pre-baked html never needs re-parsing.
   */
  ruby?: RubyText | undefined;
  // Four INDEPENDENT presentation channels, named as the AST's Channel; the value is the CSS
  // class of the mark in effect. undefined = that channel off (explicit `| undefined` so
  // snapshots may write the off state under exactOptionalPropertyTypes).
  /** 傍点: `emph-<slug>` / `-l`. */
  emph?: string | undefined;
  /** 傍線: `dec-<slug>` / `-l`. */
  line?: string | undefined;
  /** 太字: `b`. */
  weight?: string | undefined;
  /** 斜体: `i`. */
  style?: string | undefined;
}

/** A source row: a line of units (+ optional 字下げ / 見出し), or a forced page break. */
export type Row =
  | {
    readonly kind: 'line';
    readonly srcLine: number;
    readonly units: Unit[];
    readonly indent?: number;
    readonly heading?: HeadingLevel;
  }
  | { readonly kind: 'pagebreak' };

/** A laid-out display line — one column on the page. `indent` = 字下げ cells (already clamped). */
export interface DisplayLine {
  readonly srcLine: number;
  /**
   * Where the column starts in its source line: 0 for the line's first column, so the annotations
   * at the line head belong to it; else its first real unit's `at`, so an annotation between two
   * columns belongs to the one before it.
   */
  readonly at: number;
  readonly units: readonly Unit[];
  readonly indent?: number;
  /** 見出し level (大=1) — stamped on every wrapped continuation, like `indent`. */
  readonly heading?: HeadingLevel;
  /** ぶら下げ: a hung 句読点 rendered as a zero-cell virtual square past the last cell. */
  readonly hang?: Unit;
}

/** An annotation that took no effect: a zero-width HTML comment of its inner text, as the AST shows it. */
function commentUnit(inner: string, at: number): Unit {
  return { cells: 0, html: `<!--${escapeComment(inner)}-->`, text: '', at };
}

/**
 * JIS ルビ掛け allowance: a reading may hang over adjacent glyphs by half a ruby glyph
 * (0.25em) per side — 2 quarters total — before the box has to grow. Half of JLREQ's kana
 * allowance (https://www.w3.org/TR/jlreq/ §3.3), applied uniformly so hanging over kanji
 * stays unobtrusive.
 */
const RUBY_OVERHANG_QUARTERS = 2;

/** A reading unit that is a rotated half-width run: printable ASCII at its head. */
const HALF_WIDTH_RUN = /^[\x20-\x7e]/;

/**
 * Justification units for a ruby-lane run (a reading or a base): one per CJK glyph (U+3000
 * included — it paints as its own full-width blank), one per half-width run with its U+0020s
 * kept inside — a space must reach the DOM and paint at word-space width. The ONE source
 * {@link readingSpans} paints and {@link rubyCells} measures, so grid and ink cannot drift.
 */
function readingUnits(reading: string): string[] {
  const units: string[] = [];
  let word = '';
  for (const ch of graphemes(reading)) {
    if (HALF_WIDTH_RUN.test(ch)) {
      word += ch; // a rotated half-width run must not split — U+0020 stays inside it
    } else {
      if (word !== '') {
        units.push(word);
        word = '';
      }
      units.push(ch);
    }
  }
  if (word !== '') {
    units.push(word);
  }
  return units;
}

/**
 * A ruby unit's advance in WHOLE cells: max of the base run and each reading at the 0.5em lane
 * size (full-width glyph = 2 quarter-em, half-width ≈ 1, so a rotated Latin reading is not
 * over-counted), minus an optional ルビ掛け `overhang` allowance per reading. Cells, `rh-N`
 * and the lane distribution all derive from this ONE number, so grid and paint never disagree.
 */
function rubyCells(r: RubyText, overhang = 0): number {
  const advance = (s: string | undefined): number => {
    let quarters = 0;
    for (const u of readingUnits(s ?? '')) {
      // Painted width, not source length: CSS collapses a U+0020 run to one space and trims a
      // unit's edges, so counting raw chars would stretch the base under phantom spaces.
      quarters += HALF_WIDTH_RUN.test(u) ? u.replace(/ +/g, ' ').trim().length : 2;
    }
    return Math.ceil(Math.max(0, quarters - overhang) / 4);
  };
  return Math.max(graphemeCount(r.base), advance(r.right), advance(r.left));
}

/** The lane markup for a run: its {@link readingUnits}, HTML-escaped, one `<span>` each. */
function readingSpans(reading: string): string {
  return readingUnits(reading).map((u) => `<span>${escapeHtml(u)}</span>`).join('');
}

/**
 * The HTML for a ruby unit — EVERY ruby renders through the custom lanes (rr/lr/br): Chrome
 * has no working double-sided ruby and native's fractional advance breaks the whole-cell
 * grid. `<ruby>`/`<rt>` stay semantic; the positioned lane is the single `<span>` inside each
 * `<rt>`, because WebKit forces position:static on `<rt>` (WebCore/style/StyleAdjuster.cpp).
 * Base and readings are {@link readingSpans} units; a reading longer than the base adds the
 * on-demand `rh-N` stretch class.
 */
function rubyHtml(r: RubyText, cells: number): string {
  const right = r.right === undefined ? '' : `<rt><span>${readingSpans(r.right)}</span></rt>`;
  const left = r.left === undefined ? '' : `<rt class="rt-l"><span>${readingSpans(r.left)}</span></rt>`;
  return `<ruby class="${rubyLane(r, cells)}">${readingSpans(r.base)}${right}${left}</ruby>`;
}

/**
 * The stylesheet class of a ruby at the DECIDED advance: its side class (rr/lr/br) plus `rh-N`
 * when the box outgrows the base. Shared by {@link rubyHtml}, {@link unitsOf} and the settle
 * pass so class attribute, used-sink and cell accounting never drift apart.
 */
function rubyLane(r: RubyText, cells: number): string {
  const stretch = cells > graphemeCount(r.base) ? ` rh-${String(cells)}` : '';
  const side = r.left === undefined ? 'rr' : r.right === undefined ? 'lr' : 'br';
  return side + stretch;
}

/** The CSS class of a channel's mark; undefined = that channel is off. */
function classOf(mark: Mark | undefined): string | undefined {
  return mark === undefined ? undefined : markClass(mark);
}

/** A unit carrying the four channels of `marks` — one stable hidden class for all real units. */
function mk(cells: number, html: string, text: string, marks: Marks, at: number): Unit {
  return {
    cells,
    html,
    text,
    at,
    emph: classOf(marks.emph),
    line: classOf(marks.line),
    weight: classOf(marks.weight),
    style: classOf(marks.style),
  };
}

/**
 * The units of one content inline. `want` is the configured dash glyph: it is emitted as
 * {@link DASH_GLYPH} while `Unit.text` keeps the source character, so 分離禁止 still classes it
 * — except inside an unclosed ［＃, which prints exactly as typed. 縦中横 and ルビ cells build
 * their own html: a dash inside one stays the source glyph. `lineStart` is the source offset of
 * the item's line: each `at` counts from it.
 */
function unitsOf(item: Inline, want: string | undefined, lineStart: number): Unit[] {
  const at = item.span.start - lineStart;
  switch (item.kind) {
    case 'chars': {
      const translate = item.origin !== 'broken';
      const units: Unit[] = [];
      let offset = item.span.start;
      for (const ch of graphemes(item.text)) {
        const written = item.origin === 'value' ? item.span.end : (item.starts?.[units.length] ?? offset);
        units.push(mk(1, translate && ch === want ? DASH_GLYPH : escapeHtml(ch), ch, item.marks, written - lineStart));
        offset += ch.length;
      }
      return units;
    }
    case 'ruby': {
      const ruby: RubyText = {
        base: item.base,
        ...(item.right === undefined ? {} : { right: item.right }),
        ...(item.left === undefined ? {} : { left: item.left }),
      };
      const cells = rubyCells(ruby); // safe whole-cell advance; the settle pass may tighten
      return [{ ...mk(cells, rubyHtml(ruby, cells), item.base, item.marks, at), ruby, cssClass: rubyLane(ruby, cells) }];
    }
    case 'tcy':
      return [{ ...mk(1, `<span class="tcy">${escapeHtml(item.text)}</span>`, item.text, item.marks, at), cssClass: 'tcy' }];
    case 'comment':
      return [commentUnit(item.inner, at)];
    default: {
      const exhaustive: never = item;
      throw new Error(`unitsOf: unhandled inline ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * JIS ルビ掛け settle pass (row complete): tighten each ruby back toward its on-grid base
 * width when both flow neighbours tolerate the ≤0.25em/side hang — no ruby/傍点/傍線 of
 * their own (shared lanes); a row edge tolerates it too. The centre-anchored lanes render
 * the hang by themselves, so only cells/class/html need re-deriving.
 */
function settleRubyOverhang(units: Unit[]): void {
  const tolerant = (from: number, step: number): boolean => {
    for (let k = from + step; k >= 0 && k < units.length; k += step) {
      const n = units[k];
      if (n === undefined || n.text === '') {
        continue; // zero-width (comments): look past them
      }
      return n.ruby === undefined && n.emph === undefined && n.line === undefined;
    }
    return true; // row edge
  };
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (u?.ruby === undefined) {
      continue;
    }
    const tight = rubyCells(u.ruby, RUBY_OVERHANG_QUARTERS);
    if (tight < u.cells && tolerant(i, -1) && tolerant(i, 1)) {
      u.cells = tight;
      u.cssClass = rubyLane(u.ruby, tight);
      u.html = rubyHtml(u.ruby, tight);
    }
  }
}

/**
 * What a line puts into the flow: its column, a page break after it, both, or nothing. A
 * block-directive line holding no text paints no column; an empty line is a blank column,
 * except the `last`, which is only what follows the final newline.
 */
function rowShape(line: Line, last: boolean): { readonly line: boolean; readonly pagebreak: boolean } {
  const any = line.content.length > 0;
  if (line.pageBreak) {
    return { line: any, pagebreak: true };
  }
  if (paintsNothing(line)) {
    return { line: false, pagebreak: false };
  }
  return { line: any || !last, pagebreak: false };
}

/**
 * The rows (lines + page breaks) of ONE file. `opts.dash` names the configured dash mode;
 * omitted = no translation (structural probes).
 */
export function buildRows(ast: Ast, opts?: { readonly dash?: DashMode | undefined }): Row[] {
  const want = opts?.dash === undefined ? undefined : DASH_BY_MODE[opts.dash];
  const rows: Row[] = [];
  const end = ast.lines.length - 1;
  ast.lines.forEach((line, at) => {
    const shape = rowShape(line, at === end);
    if (shape.line) {
      const units = line.content.flatMap((item) => unitsOf(item, want, line.span.start));
      settleRubyOverhang(units);
      // `heading` is CONDITIONAL: row snapshots deepEqual whole objects, so an absent heading
      // must be an absent KEY, never an explicit undefined.
      rows.push(
        line.heading === undefined
          ? { kind: 'line', srcLine: line.index, units, indent: line.indent }
          : { kind: 'line', srcLine: line.index, units, indent: line.indent, heading: line.heading },
      );
    }
    if (shape.pagebreak) {
      rows.push({ kind: 'pagebreak' });
    }
  });
  return rows;
}

/**
 * Chars forbidden at line END (追い出し: push down to the next line) — 行末禁則.
 * 始め括弧 (cl-01, https://www.w3.org/TR/jlreq/#character_classes).
 */
const KINSOKU_OPEN = new Set('「『（〔［｛〈《【〘〖｟〝');
/** 区切り約物 (cl-04): full-width, half-width, single-codepoint. */
const DIVIDING = '！？!?‼⁇⁈⁉';
const KINSOKU_DIVIDING = new Set(DIVIDING);
/**
 * Chars forbidden at line START (pull the preceding char down) — 行頭禁則, the relaxed tier:
 * 終わり括弧・句読点・区切り約物・中点類・繰り返し記号 (cl-02/04/05/06/07/09,
 * https://www.w3.org/TR/jlreq/#character_classes) = Word 標準 / CSS `line-break: normal`.
 */
const KINSOKU_CLOSE = new Set(
  '」』）〕］｝〉》】〙〗｠〟' + // 終わり括弧
    '、。，．' + // 句読点
    DIVIDING + // 区切り約物
    '・：；' + // 中点類
    '々〻ゝゞヽヾ', // 繰り返し記号
);
/** The strict tier adds 長音 (cl-10) and 小書き仮名 (cl-11) = Word 高レベル / CSS `strict`. */
const KINSOKU_CLOSE_STRICT = new Set(
  'ー' + // 長音
    'ぁぃぅぇぉっゃゅょゎゕゖ' + // 小書き平仮名
    'ァィゥェォッャュョヮヵヶ' + // 小書き片仮名
    [...KINSOKU_CLOSE].join(''),
);

/** The 行頭禁則 set for a tier. */
function closeFor(mode: KinsokuMode): Set<string> {
  return mode === 'strict' ? KINSOKU_CLOSE_STRICT : KINSOKU_CLOSE;
}

/**
 * EVERY character of a real (cells>0) unit is in `set` — so a 縦中横 約物 pair (text "!?") counts
 * whole, while a digit tcy or a ruby base stays free. The cells guard keeps zero-width
 * comments (text '') out of the vacuously-true empty iteration.
 */
function everyCharIn(u: Unit | undefined, set: Set<string>): boolean {
  if (u === undefined || u.cells === 0 || u.text.length === 0) {
    return false;
  }
  for (const c of graphemes(u.text)) {
    if (!set.has(headChar(c))) {
      return false;
    }
  }
  return true;
}

/** A unit of one character: a cell of {@link unitsOf}'s `chars` case, neither 縦中横 nor ルビ nor merged. */
function isCharUnit(u: Unit | undefined): u is Unit {
  return u?.cells === 1 && u.cssClass === undefined && u.ruby === undefined;
}

/**
 * ぶら下げ対象は句読点のみ (JIS X 4051 の慣例; 閉じ括弧・約物は対象外). The hung glyph's ink
 * stays inside the EDGE_INSET reserve past the last cell, clear of the 枠.
 */
const HANGABLE = new Set('、。，．');

/** Where the column that opens at `units[from]` starts: see {@link DisplayLine.at}. */
function columnAt(units: readonly Unit[], from: number): number {
  return from === 0 ? 0 : (units[nextReal(units, from)]?.at ?? 0);
}

/** Index of the first real (cells>0) unit in `units[from..)`, or -1 if none. */
function nextReal(units: readonly Unit[], from: number): number {
  for (let i = from; i < units.length; i += 1) {
    if ((units[i]?.cells ?? 0) > 0) {
      return i;
    }
  }
  return -1;
}

/**
 * A break point may hang `units[i]` iff it is a single 句読点, the line would not then END on
 * an opening bracket, and the next real unit would not open the following line on a 行頭禁則
 * char — those cases fall through to 追い出し. No next unit at all hangs fine.
 */
function canHang(units: readonly Unit[], start: number, i: number, close: Set<string>): boolean {
  const h = units[i];
  if (!isCharUnit(h) || !HANGABLE.has(headChar(h.text))) {
    return false;
  }
  const p = lastReal(units, start, i);
  if (p >= 0 && everyCharIn(units[p], KINSOKU_OPEN)) {
    return false;
  }
  return freeHead(units, i + 1, close);
}

/** A column opening at `units[from]` would not start on a 行頭禁則 char; no real unit left is fine. */
function freeHead(units: readonly Unit[], from: number, close: Set<string>): boolean {
  const n = nextReal(units, from);
  return n < 0 || !everyCharIn(units[n], close);
}

/**
 * `units[i]` is the full-width space a 区切り約物 takes after it. A line that ends on the mark
 * drops the space, and no line starts with it
 * (https://www.w3.org/TR/jlreq/#positioning_of_dividing_punctuation_marks).
 */
function isDividingSpace(units: readonly Unit[], i: number): boolean {
  const u = units[i];
  return u?.text === '　' && u.cssClass === undefined &&
    everyCharIn(units[lastReal(units, 0, i)], KINSOKU_DIVIDING);
}

/** The hung unit: zero cells (outside the budget), its glyph wrapped for the `.hang` rule. */
function makeHangUnit(u: Unit): Unit {
  return {
    cells: 0,
    text: u.text,
    html: `<span class="hang">${u.html}</span>`,
    at: u.at,
    cssClass: 'hang',
    emph: u.emph,
    line: u.line,
    weight: u.weight,
    style: u.style,
  };
}

/** Index of the last real (cells>0) unit in `units[start..before)`, or -1 if none. */
function lastReal(units: readonly Unit[], start: number, before: number): number {
  for (let i = before - 1; i >= start; i -= 1) {
    if ((units[i]?.cells ?? 0) > 0) {
      return i;
    }
  }
  return -1;
}

/**
 * 分離禁止 classes (cl-08, https://www.w3.org/TR/jlreq/#character_classes): adjacent SAME-CLASS
 * chars bind (mixed codepoints included, e.g. —―; the dash class is {@link DASH_CHARS}).
 * Half-width 約物 bind only as an exact pair — two cells, a pair with no 縦中横 annotation
 * (full-width ！？ need no binding: they are 行頭禁則, so the 追い出し cascade already moves a
 * split pair whole).
 */
const INSEP_LEADER = new Set('…‥'); // U+2026 U+2025
const INSEP_BANG = new Set('!?'); // half-width; exactly-2 runs only

/**
 * The 分離禁止 class a unit binds under, or undefined (classed / ruby / multi-char / zero-width).
 * `bang: false` leaves the half-width `!?` class out (the reflow emitter — the reader wraps there).
 */
export function insepClass(u: Unit | undefined, { bang = true }: { bang?: boolean } = {}): Set<string> | undefined {
  if (!isCharUnit(u)) {
    return undefined;
  }
  const head = headChar(u.text);
  if (DASH_CHARS.has(head)) {
    return DASH_CHARS;
  }
  if (INSEP_LEADER.has(head)) {
    return INSEP_LEADER;
  }
  return bang && INSEP_BANG.has(head) ? INSEP_BANG : undefined;
}

/** One atomic unit from `units[start..end)`; channels are `head`'s (the run requires them equal). */
function mergeRun(units: readonly Unit[], head: Unit, start: number, end: number): Unit {
  let cells = 0;
  let text = '';
  let html = '';
  for (let i = start; i < end; i += 1) {
    const u = units[i];
    if (u !== undefined) {
      cells += u.cells;
      text += u.text;
      html += u.html;
    }
  }
  const merged: Unit = { cells, text, html, at: head.at, emph: head.emph, line: head.line, weight: head.weight, style: head.style };
  if (head.cssClass !== undefined) {
    // emitLine's class sink is what emits the rule, so a merged unit must keep the class.
    merged.cssClass = head.cssClass;
  }
  return merged;
}

/**
 * Binds 分離禁止 runs into atomic multi-cell units BEFORE wrapping, so {@link wrapRow} needs no
 * keep-together logic — atomicity rides the existing unit paths (an over-budget run overflows on
 * its own line, like an over-wide ruby). `relaxed` pairs a run from the left (an odd tail stays a
 * free single); `strict` binds the whole run. Returns `units` itself when nothing binds.
 */
function separate(units: readonly Unit[], mode: KinsokuMode): readonly Unit[] {
  let out: Unit[] | undefined; // created on the first bind; units[0..copied) are already in it
  let copied = 0;
  for (let i = 0; i < units.length; i += 1) {
    const head = units[i];
    const cls = insepClass(head);
    if (head === undefined || cls === undefined) {
      continue;
    }
    const key = unitKey(head);
    let end = i + 1;
    while (end < units.length) {
      const next = units[end];
      if (next === undefined || insepClass(next) !== cls || unitKey(next) !== key) {
        break;
      }
      end += 1;
    }
    const len = end - i;
    if (len >= 2 && (cls !== INSEP_BANG || len === 2)) {
      out ??= [];
      for (let j = copied; j < i; j += 1) {
        const u = units[j];
        if (u !== undefined) {
          out.push(u);
        }
      }
      if (mode === 'strict' && cls !== INSEP_BANG) {
        out.push(mergeRun(units, head, i, end));
      } else {
        for (let j = i; j < end; j += 2) {
          const u = units[j];
          if (u !== undefined) {
            out.push(end - j >= 2 ? mergeRun(units, u, j, j + 2) : u);
          }
        }
      }
      copied = end;
    }
    i = end - 1;
  }
  if (out === undefined) {
    return units;
  }
  for (let j = copied; j < units.length; j += 1) {
    const u = units[j];
    if (u !== undefined) {
      out.push(u);
    }
  }
  return out;
}

/**
 * N_eff: a row's 字下げ clamped to `charsPerLine − 1`, so the line keeps ≥1 content cell. The
 * paginated wrap and the EPUB reflow share it.
 */
export function effectiveIndent(indent: number | undefined, charsPerLine: number): number {
  return Math.min(indent ?? 0, charsPerLine - 1);
}

/**
 * Hard-wraps one line row's units into display lines of at most `charsPerLine` cells. A unit
 * is atomic (never split) and an over-wide unit gets its own line. A 字下げ row narrows the
 * budget to `charsPerLine − N_eff` (N_eff = {@link effectiveIndent}) and stamps
 * the SAME N_eff onto every display line — the first AND each wrapped continuation are indented
 * alike, and class / CSS padding / wrap budget all derive from this one value so the column can
 * never overflow. When `kinsoku` is not `none`, 分離禁止 runs are first bound into atomic units
 * (see {@link separate}); at each overflowing break a trailing 句読点 hangs as a zero cell when
 * that alone resolves the boundary (ぶら下げ, see {@link canHang}), the space after a 区切り約物
 * that ends the line is dropped (see {@link isDividingSpace}), and otherwise 禁則処理
 * nudges the break point LEFTWARD so a line never ENDS on an opening bracket (「『【（) nor
 * STARTS with a 行頭禁則 char (」』】）、。！？) or with that space — 追い出し. The walk re-tests the new
 * boundary, so cascades and the resulting reflow fall out naturally; the `> floor` guard keeps
 * a line's first real unit, so no line ever empties and a lone-char row stays as-is. Every
 * boundary test looks through zero-width units to the nearest real one. (禁則 walks unit text
 * only — the indent is CSS padding, not a unit, so the two never interact.)
 */
function wrapRow(
  row: Extract<Row, { kind: 'line' }>,
  charsPerLine: number,
  mode: KinsokuMode,
): DisplayLine[] {
  const { srcLine } = row;
  const units = mode === 'none' ? row.units : separate(row.units, mode);
  const indent = effectiveIndent(row.indent, charsPerLine);
  const budget = charsPerLine - indent;
  // 見出し propagates to every display line (wrapped continuations stay gothic, like indent);
  // conditional for the same absent-key contract the row snapshots rely on.
  const hs: { heading?: HeadingLevel } =
    row.heading === undefined ? {} : { heading: row.heading };
  if (units.length === 0) {
    return [{ srcLine, at: 0, units: [], indent, ...hs }];
  }
  const lines: DisplayLine[] = [];
  let start = 0; // first unit index of the line being built
  let cells = 0;
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (u === undefined) {
      continue;
    }
    if (u.cells > 0 && cells > 0 && cells + u.cells > budget) {
      let brk = i; // break BEFORE units[brk]
      if (mode !== 'none') {
        const close = closeFor(mode);
        const hang = canHang(units, start, i, close);
        if (hang || (isDividingSpace(units, i) && freeHead(units, i + 1, close))) {
          // `u` leaves the flow: a 句読点 hangs off the full column as a zero cell (ぶら下げ),
          // the space after a 区切り約物 is dropped. Trailing zero-width units ride along so
          // they never open a units-less column.
          let ns = i + 1;
          while (ns < units.length && (units[ns]?.cells ?? 0) === 0) {
            ns += 1;
          }
          const kept = [...units.slice(start, i), ...units.slice(i + 1, ns)];
          lines.push({ srcLine, at: columnAt(units, start), units: kept, indent, ...(hang ? { hang: makeHangUnit(u) } : {}), ...hs });
          start = ns;
          cells = 0;
          continue; // u is consumed — it must not count into the next column
        }
        // 追い出し: find the last acceptable break point; the line keeps its first real unit.
        // The walk steps from real unit to real unit: a break anywhere inside a run of
        // zero-width units tests the same pair of neighbours as one before the run.
        const floor = nextReal(units, start) + 1;
        while (
          brk > floor &&
          (everyCharIn(units[nextReal(units, brk)], close) ||
            isDividingSpace(units, nextReal(units, brk)) ||
            everyCharIn(units[lastReal(units, start, brk)], KINSOKU_OPEN))
        ) {
          brk = Math.max(floor, lastReal(units, start, brk));
        }
      }
      lines.push({ srcLine, at: columnAt(units, start), units: units.slice(start, brk), indent, ...hs });
      start = brk;
      cells = 0;
      for (let j = brk; j < i; j += 1) {
        cells += units[j]?.cells ?? 0;
      }
    }
    cells += u.cells;
  }
  if (start < units.length) {
    // A hung or dropped unit can be the row's very last; only a non-empty tail becomes a column.
    lines.push({ srcLine, at: columnAt(units, start), units: units.slice(start), indent, ...hs });
  }
  return lines;
}

/** One cut page: its columns, and whether it opens after an authored ［＃改ページ］ (else the page before merely ran out of lines). */
interface CutPage {
  readonly lines: DisplayLine[];
  readonly forced: boolean;
}

/**
 * The ONE page cutter: flows rows into pages of at most `linesPerPage` lines; a pagebreak row
 * ends the open page. No page is ever empty, so leading, trailing and doubled breaks make none,
 * and a break written exactly where a page fills makes one page end, the authored one. The
 * build keeps the pages ({@link paginate}); the preview keeps the seams too ({@link flowToHtml}).
 */
function cutPages(
  rows: readonly Row[],
  charsPerLine: number,
  linesPerPage: number,
  kinsoku: KinsokuMode,
): CutPage[] {
  const pages: CutPage[] = [];
  let lines: DisplayLine[] = [];
  let forced = false; // how the page being built opened
  const flush = (): void => {
    if (lines.length > 0) {
      pages.push({ lines, forced });
      lines = [];
    }
  };
  for (const row of rows) {
    if (row.kind === 'pagebreak') {
      flush();
      forced = true;
      continue;
    }
    for (const line of wrapRow(row, charsPerLine, kinsoku)) {
      if (lines.length >= linesPerPage) {
        flush();
        forced = false;
      }
      lines.push(line);
    }
  }
  flush();
  return pages;
}

/** Flows rows into pages of at most `linesPerPage` lines; a pagebreak forces a new page. */
export function paginate(
  rows: readonly Row[],
  charsPerLine: number,
  linesPerPage: number,
  kinsoku: KinsokuMode,
): DisplayLine[][] {
  return cutPages(rows, charsPerLine, linesPerPage, kinsoku).map((page) => page.lines);
}

/**
 * The four channels in a FIXED order → a deterministic class attribute that doubles as the
 * adjacent-merge key. '' = no decoration (the common case — no allocation, no `<span>`).
 */
export function unitKey(u: Unit): string {
  if (
    u.emph === undefined &&
    u.line === undefined &&
    u.weight === undefined &&
    u.style === undefined
  ) {
    return '';
  }
  let k = '';
  if (u.emph !== undefined) {
    k = u.emph;
  }
  if (u.line !== undefined) {
    k = k === '' ? u.line : `${k} ${u.line}`;
  }
  if (u.weight !== undefined) {
    k = k === '' ? u.weight : `${k} ${u.weight}`;
  }
  if (u.style !== undefined) {
    k = k === '' ? u.style : `${k} ${u.style}`;
  }
  return k; // e.g. "emph-fs dec-solid-l b"
}

/**
 * On-demand class sink: cssClass (tcy / rr / lr / br / rh-N, baked inside `u.html`) and
 * channel keys both land in `used` so css.ts emits exactly the rules present.
 */
function sinkInto(used: Set<string> | undefined, classes: string | undefined): void {
  if (used && classes !== undefined && classes !== '') {
    for (const c of classes.split(' ')) {
      used.add(c);
    }
  }
}

/**
 * Emits a unit run, merging adjacent units with EQUAL channel sets into one `<span>` — the
 * channel-run merging the paginated build and the reflow (EPUB) output share, so their inline
 * markup can never drift.
 */
export function emitUnits(units: readonly Unit[], used?: Set<string>): string {
  let html = '';
  let open = ''; // '' sentinel (a real key is never '')
  for (const u of units) {
    sinkInto(used, u.cssClass);
    const key = unitKey(u);
    if (key !== open) {
      if (open !== '') {
        html += '</span>';
      }
      open = key;
      if (open !== '') {
        sinkInto(used, open);
        html += `<span class="${open}">`;
      }
    }
    html += u.html;
  }
  if (open !== '') {
    html += '</span>';
  }
  return html;
}

function emitLine(line: DisplayLine, used?: Set<string>, head = ''): string {
  let html = emitUnits(line.units, used);
  if (line.hang !== undefined) {
    // The hung 句読点 lands after the last cell; its channel span cannot join a neighbour's
    // (that span just closed above), so it carries its own.
    sinkInto(used, line.hang.cssClass);
    const hk = unitKey(line.hang);
    if (hk === '') {
      html += line.hang.html;
    } else {
      sinkInto(used, hk);
      html += `<span class="${hk}">${line.hang.html}</span>`;
    }
  }
  const ind = line.indent ?? 0;
  const indentClass = ind > 0 ? ` indent-${String(ind)}` : '';
  if (used && ind > 0) {
    used.add(`indent-${String(ind)}`);
  }
  const headingClass = line.heading === undefined ? '' : ' midashi';
  if (used && line.heading !== undefined) {
    used.add('midashi');
  }
  // Right-side 傍点 anywhere on the line: Chromium pushes the whole line's baseline for the mark
  // band, so the line carries the counter-shift class (class.emr.css measures and pins the amount).
  const rightEmph = (u: Unit): boolean => u.emph !== undefined && !u.emph.endsWith('-l');
  const emrClass =
    line.units.some(rightEmph) || (line.hang !== undefined && rightEmph(line.hang)) ? ' emr' : '';
  if (used && emrClass !== '') {
    used.add('emr');
  }
  // The cursor-follow anchor: the source line, and where a wrapped column starts in it. A glue
  // row (srcLine −1) has none. `head` is out-of-flow line furniture (the preview's number span)
  // emitted before the column content.
  const anchor = line.srcLine < 0
    ? ''
    : ` data-line="${String(line.srcLine)}"${line.at > 0 ? ` data-ch="${String(line.at)}"` : ''}`;
  return `<div class="line${indentClass}${headingClass}${emrClass}"${anchor}>${head}${html}</div>`;
}

/**
 * One output sheet. `cover: true` marks an unnumbered front page: no header, footer or line
 * numbers, and outside the ページ番号／総ページ数 counts. The grid and its reserved
 * bands are unchanged. Only the first two are withheld here — the line number is a CSS
 * counter matching `.page`, so its exemption lives in `build.ln.css`; 罫線/枠 stays on.
 * `values` are the book's ［＃ここに「…」の値を表示］ substitutions for the page furniture.
 */
export interface RenderPage {
  readonly lines: readonly DisplayLine[];
  readonly cover?: true;
  readonly values?: ValueLookup;
}

/**
 * Renders paginated pages into the `<div class="book">…</div>` body fragment, each page
 * carrying its chrome furniture AFTER the lines (so line-adjacency is preserved for
 * anything matching consecutive `.line`s). The lines sit in a `.grid`, the sheet's only
 * vertical-rl box (build.base.css). When a `used` sink is passed, every class emitted is
 * recorded into it so the caller can emit only those rules (on-demand CSS)
 * — the structural `cover` class stays out of the sink. `data-page` is the sequential DOM
 * ordinal over ALL pages; the furniture's page number and the parity of its sides count BODY
 * pages only, so cover sheets never shift where body page 1 lands.
 */
export function pagesToHtml(
  pages: readonly RenderPage[],
  used: Set<string> | undefined,
  chrome: BuildChrome,
): string {
  const totalPage = pages.reduce((n, page) => n + (page.cover === true ? 0 : 1), 0);
  const cut = cutFurniture(chrome);
  let bodyPi = 0;
  const body = pages
    .map((page, di) => {
      const lines = page.lines.map((line) => emitLine(line, used)).join('');
      const furniture = page.cover === true ? '' : pageFurniture(chrome, cut, page.values, bodyPi++, totalPage);
      const cls = page.cover === true ? 'page cover' : 'page';
      return `<div class="${cls}" data-page="${String(di)}"><div class="grid">${lines}</div>${furniture}</div>`;
    })
    .join('');
  return `<div class="book">${body}</div>`;
}

/**
 * Renders ONE file's rows as a CONTINUOUS line flow for the live preview (no real pages), cut
 * by the SAME page cutter the book build uses ({@link cutPages}: wrap, 禁則, page turns), so the
 * preview agrees with the printed page. Pure + vscode-free.
 *
 * - Each page is a `<div class="segment">` block, so the edge-rule 枠 closes per page; no page
 *   is empty, so a leading/trailing/doubled ［＃改ページ］ leaves no empty segment.
 * - A marker lands BETWEEN segments as a direct `.book` child, outside every frame: the
 *   labelled `<div class="pagebreak">` where the author wrote ［＃改ページ］, the label-less
 *   `<div class="pagebreak auto">` where the page merely ran out of lines.
 * - `lineNumbers` opens every column with an out-of-flow `<span class="ln">N</span>` head,
 *   numbered in JS and running through the whole file — a page turn does not restart it.
 * - Every column carries `data-line`, and a wrapped one `data-ch`: where it starts in its source
 *   line, so the cursor-follow scroller parks the column holding the cursor. The build's pages
 *   carry the same.
 * - A `used` sink records every emitted class so the caller emits only those rules.
 */
export function flowToHtml(
  rows: readonly Row[],
  charsPerLine: number,
  linesPerPage: number,
  kinsoku: KinsokuMode,
  used?: Set<string>,
  lineNumbers = false,
): string {
  const parts: string[] = [];
  let lineNo = 0;
  cutPages(rows, charsPerLine, linesPerPage, kinsoku).forEach((page, i) => {
    if (i > 0) {
      parts.push(page.forced
        ? '<div class="pagebreak"><span class="pb-label">改ページ</span></div>'
        : '<div class="pagebreak auto"></div>');
    }
    parts.push('<div class="segment">');
    for (const line of page.lines) {
      lineNo += 1;
      // The number span is absolutely positioned (out of the text flow), so it neither
      // consumes cells nor disturbs the pre-formatted column content it precedes.
      const head = lineNumbers ? `<span class="ln">${String(lineNo)}</span>` : '';
      parts.push(emitLine(line, used, head));
    }
    parts.push('</div>');
  });
  return `<div class="book">${parts.join('')}</div>`;
}
