/**
 * Build-time pagination engine: flows a book's token stream into an explicit
 * page → line DOM skeleton (`<div class="page"><div class="grid"><div class="line">…`). Unlike the
 * continuous preview, the build output is paginated IN the compiler so printed pages are
 * WYSIWYG and the page furniture (page numbers, line numbers, 原稿用紙 grid) has real
 * elements to hang off. Pure + vscode-free.
 *
 * Line breaking is a simple hard wrap at `charsPerLine` cells (full-width char = 1 cell,
 * a ruby unit = its TRUE advance — the base char count, or the longest reading's extent in
 * whole cells when that is longer — and is atomic, a 縦中横 cell = ALWAYS 1 cell however many
 * chars it combines, emphasis adds no cells, comments are zero-width). 禁則処理 is selected
 * by the `kinsoku` mode (`none` = bare wrap) and lives in {@link wrapRow}: 分離禁止 binding,
 * ぶら下げ of a trailing 句読点, then the leftward 追い出し nudge of the break point.
 * ［＃改ページ］ forces a new page.
 */
import { DASH_BY_MODE, DASH_CHARS, DASH_GLYPH } from '../chars.ts';
import type { DashMode, KinsokuMode } from '../config/types.ts';
import type { BuildChrome, PageNumberPosition } from './chrome.ts';
import { resolveStyle } from './emphasis.ts';
import { escapeComment, escapeHtml } from './escape.ts';
import { tokenize, VALUE_FIELD_PLACEHOLDERS, type HeadingLevel, type Token, type ValueField } from './tokenizer.ts';

/**
 * One laid-out glyph group: a char (1 cell), a ruby unit (base char count, atomic), or a
 * 縦中横 cell (ALWAYS 1 cell however many half-width chars it combines, atomic).
 */
export interface Unit {
  cells: number;
  html: string;
  /** Plain text for postfix-emphasis matching; '' for zero-width units (comments). */
  text: string;
  /**
   * Space-separated on-demand stylesheet classes baked inside `html` (tcy / rr / lr / br /
   * rh-N) — not channels (invisible to unitKey); emitLine collects them into `used` so css.ts
   * emits each rule only when actually present (zero dead rules).
   */
  cssClass?: string | undefined;
  /**
   * Structured readings for a ruby unit — `html` is regenerated from this when a 左ルビ later
   * attaches a left reading, so the pre-baked html never needs re-parsing.
   */
  ruby?: { base: string; right?: string | undefined; left?: string | undefined } | undefined;
  // Four INDEPENDENT presentation channels. Field name == emphasis.ts Channel, so a resolved
  // style is applied by `unit[style.channel] = style.className`. undefined = that channel off
  // (explicit `| undefined` so snapshots may write the off state under exactOptionalPropertyTypes).
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
  readonly units: readonly Unit[];
  readonly indent?: number;
  /** 見出し level (大=1) — stamped on every wrapped continuation, like `indent`. */
  readonly heading?: HeadingLevel;
  /** ぶら下げ: a hung 句読点 rendered as a zero-cell virtual square past the last cell. */
  readonly hang?: Unit;
}

/**
 * The LAST occurrence of `target` in the units' concatenated text, required to cover WHOLE
 * units — only a match cutting into an atomic ruby/tcy unit is rejected (plain text is
 * per-char), and only the lastIndexOf hit is tested (the spec's forward references sit
 * adjacent to their target). Shared by every corner-target postfix so binding semantics never
 * diverge; returns the inclusive unit-index range, or null (absent / unaligned).
 */
function matchTarget(
  units: readonly Unit[],
  target: string,
): { first: number; last: number } | null {
  let text = '';
  const bounds: { start: number; end: number; index: number }[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (u === undefined || u.text === '') {
      continue;
    }
    bounds.push({ start: text.length, end: text.length + u.text.length, index: i });
    text += u.text;
  }
  const pos = text.lastIndexOf(target);
  if (pos === -1) {
    return null;
  }
  const matchEnd = pos + target.length;
  const first = bounds.find((b) => b.start === pos);
  const last = bounds.find((b) => b.end === matchEnd);
  if (first === undefined || last === undefined) {
    return null; // the match cuts into an atomic unit — not aligned
  }
  return { first: first.index, last: last.index };
}

/** The annotation-degrade comment unit (verbatim inner), shared by every postfix applier. */
function commentUnit(raw: string): Unit {
  return { cells: 0, html: `<!--${escapeComment(raw.slice(2, -1))}-->`, text: '' };
}

/**
 * JIS ルビ掛け allowance: a reading may hang over adjacent glyphs by half a ruby glyph
 * (0.25em) per side — 2 quarters total — before the box has to grow. Half of JLREQ's kana
 * allowance (https://www.w3.org/TR/jlreq/ §3.3), applied uniformly so hanging over kanji
 * stays unobtrusive.
 */
const RUBY_OVERHANG_QUARTERS = 2;

/**
 * Justification units for a ruby-lane run (a reading or a base): one per CJK glyph (U+3000
 * included — it paints as its own full-width blank), one per half-width run with its U+0020s
 * kept inside — a space must reach the DOM and paint at word-space width. The ONE source
 * {@link readingSpans} paints and {@link rubyCells} measures, so grid and ink cannot drift.
 */
function readingUnits(reading: string): string[] {
  const units: string[] = [];
  let word = '';
  for (const ch of reading) {
    if (/[\x20-\x7e]/.test(ch)) {
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
function rubyCells(
  r: { base: string; right?: string | undefined; left?: string | undefined },
  overhang = 0,
): number {
  const advance = (s: string | undefined): number => {
    let quarters = 0;
    for (const u of readingUnits(s ?? '')) {
      // Painted width, not source length: CSS collapses a U+0020 run to one space and trims a
      // unit's edges, so counting raw chars would stretch the base under phantom spaces.
      quarters += /^[\x20-\x7e]/.test(u) ? u.replace(/ +/g, ' ').trim().length : 2;
    }
    return Math.ceil(Math.max(0, quarters - overhang) / 4);
  };
  return Math.max(Array.from(r.base).length, advance(r.right), advance(r.left));
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
function rubyHtml(
  r: { base: string; right?: string | undefined; left?: string | undefined },
  cells: number,
): string {
  const right = r.right === undefined ? '' : `<rt><span>${readingSpans(r.right)}</span></rt>`;
  const left = r.left === undefined ? '' : `<rt class="rt-l"><span>${readingSpans(r.left)}</span></rt>`;
  return `<ruby class="${rubyLane(r, cells)}">${readingSpans(r.base)}${right}${left}</ruby>`;
}

/**
 * The stylesheet class of a ruby at the DECIDED advance: its side class (rr/lr/br) plus `rh-N`
 * when the box outgrows the base. Shared by {@link rubyHtml}, buildRows and
 * {@link applyLeftRuby} so class attribute, used-sink and cell accounting never drift apart.
 */
function rubyLane(
  r: { base: string; right?: string | undefined; left?: string | undefined },
  cells: number,
): string {
  const stretch = cells > Array.from(r.base).length ? ` rh-${String(cells)}` : '';
  const side = r.left === undefined ? 'rr' : r.right === undefined ? 'lr' : 'br';
  return side + stretch;
}

/**
 * A ruby unit's markup for the REFLOW (EPUB) output: NATIVE `<ruby>` in every form — the
 * reading system owns spacing and overhang. A left-side reading rides `ruby.ru`
 * (class.ruby-u.css moves it to the under side); a both-side ruby nests, the HTML double-sided
 * pattern. The paginated lanes cannot serve here: Apple Books neutralizes position:absolute in
 * reflowable EPUB, dropping the absolutely positioned readings into the text flow.
 */
export function reflowRubyHtml(
  r: { base: string; right?: string | undefined; left?: string | undefined },
): string {
  if (r.left === undefined) {
    return `<ruby>${escapeHtml(r.base)}<rt>${escapeHtml(r.right ?? '')}</rt></ruby>`;
  }
  const left = `<rt>${escapeHtml(r.left)}</rt>`;
  if (r.right === undefined) {
    return `<ruby class="ru">${escapeHtml(r.base)}${left}</ruby>`;
  }
  return `<ruby class="ru"><ruby>${escapeHtml(r.base)}<rt>${escapeHtml(r.right)}</rt></ruby>${left}</ruby>`;
}

/**
 * Attaches a LEFT reading to the boundary-aligned last occurrence of `target`: exactly one
 * ruby unit whose base matches → 両側 (the left reading joins it); plain text units only →
 * merged into one left-ruby unit. Anything mixed would silently destroy an inner reading/cell,
 * so it degrades + warns; reading lengths follow the same {@link rubyCells} accounting.
 */
function applyLeftRuby(
  units: Unit[],
  target: string,
  reading: string,
  raw: string,
  miss?: () => void,
): void {
  if (target !== '' && reading !== '') {
    const m = matchTarget(units, target);
    if (m !== null) {
      const real = units.slice(m.first, m.last + 1).filter((u) => u.text !== '');
      const single = real.length === 1 ? real[0] : undefined;
      // `target` is a non-empty string, so a matching chain proves single AND its ruby exist.
      if (single?.ruby?.base === target) {
        single.ruby = { ...single.ruby, left: reading };
        const cells = rubyCells(single.ruby); // safe; the settle pass may tighten at line end
        single.cells = cells; // a long reading stretches the box — the grid follows
        single.html = rubyHtml(single.ruby, cells);
        single.cssClass = rubyLane(single.ruby, cells);
        return;
      }
      if (real.every((u) => u.ruby === undefined && u.cssClass === undefined)) {
        const first = units[m.first];
        const ruby = { base: target, left: reading };
        const cells = rubyCells(ruby);
        const merged: Unit = {
          cells,
          html: rubyHtml(ruby, cells),
          text: target,
          emph: first?.emph,
          line: first?.line,
          weight: first?.weight,
          style: first?.style,
          cssClass: rubyLane(ruby, cells),
          ruby,
        };
        const kept = units.slice(m.first, m.last + 1).filter((u) => u.text === '');
        units.splice(m.first, m.last - m.first + 1, merged, ...kept);
        return;
      }
    }
    miss?.();
  }
  units.push(commentUnit(raw));
}

/**
 * Merges the boundary-aligned last occurrence of `target` into ONE combined upright cell
 * (縦中横): cells is always 1, `text` keeps the run so later postfixes still match, channels
 * are inherited from the first replaced unit, zero-width units re-insert after the cell.
 * Whole-unit coverage of a ruby REPLACES it (手動縦中横 > ルビ); an unresolved target degrades
 * + reports like applyPostfix.
 */
function applyTcyPostfix(units: Unit[], target: string, raw: string, miss?: () => void): void {
  if (target !== '') {
    const m = matchTarget(units, target);
    if (m !== null) {
      const first = units[m.first];
      const merged: Unit = {
        cells: 1,
        html: `<span class="tcy">${escapeHtml(target)}</span>`,
        text: target,
        emph: first?.emph,
        line: first?.line,
        weight: first?.weight,
        style: first?.style,
        cssClass: 'tcy',
      };
      const kept = units.slice(m.first, m.last + 1).filter((u) => u.text === '');
      units.splice(m.first, m.last - m.first + 1, merged, ...kept);
      return;
    }
    miss?.();
  }
  units.push(commentUnit(raw));
}

/**
 * Marks the units covering the LAST occurrence of `target` with `variant`'s style class. The
 * match must ALIGN to unit boundaries ({@link matchTarget}); an unresolved target (absent from
 * the line, or cutting into an atomic ruby/tcy unit) applies nothing, degrades the annotation to
 * a comment and reports through `miss` — the editor's `syntax.postfixTargetMissing` Warning.
 */
function applyPostfix(
  units: Unit[],
  target: string,
  variant: string,
  raw: string,
  miss?: () => void,
): void {
  const style = resolveStyle(variant, 'postfix');
  if (style !== null && target !== '') {
    const m = matchTarget(units, target);
    if (m !== null) {
      for (let i = m.first; i <= m.last; i += 1) {
        const u = units[i];
        if (u !== undefined && u.text !== '') {
          // Same-channel OVERWRITE (an atomic remove+add); other channels stack alongside.
          u[style.channel] = style.className;
        }
      }
      return;
    }
    miss?.();
  }
  // Target unresolved (or unknown variant) => degrade to a comment (verbatim inner).
  units.push(commentUnit(raw));
}

/**
 * Builds the rows (lines + page breaks) for ONE file's token stream. `opts.dash` names the
 * configured dash mode; that glyph is emitted as {@link DASH_GLYPH} while `Unit.text` keeps the
 * source character — omitted = no translation (structural probes, the issue scan). The optional
 * `opts.issues` sink collects the token indices of unresolved corner-target postfixes — the
 * render's own failure list, mapped back to source spans by {@link findPostfixTargetIssues} so
 * the Warnings can never disagree with what was applied. `opts.values` supplies the real
 * ［＃ここに「…」の値を表示］ substitutions (the html build's cover compile); omitted = the
 * fixed placeholders — so `Unit.text` carries the SUBSTITUTED characters for these units.
 */
export function buildRows(
  tokens: readonly Token[],
  opts?: {
    readonly issues?: number[];
    readonly dash?: DashMode;
    readonly values?: Readonly<Record<ValueField, string>>;
  },
): Row[] {
  const issues = opts?.issues;
  const want = opts?.dash === undefined ? undefined : DASH_BY_MODE[opts.dash];
  const rows: Row[] = [];
  let cur: Unit[] = [];
  let srcLine = 0;
  let isPageBreak = false;
  // Four independent decoration channels. Keys == emphasis.ts Channel.
  const active: {
    emph?: string | undefined;
    line?: string | undefined;
    weight?: string | undefined;
    style?: string | undefined;
  } = {};
  // Mirrored by the lint line walker (server/lint/walker.ts); lockstep guarded by walker.test.ts.
  let activeIndent = 0; // block 字下げ in effect, carried ACROSS lines
  let curIndent = 0; // indent for the line under construction (line start = activeIndent)
  let activeHeading: HeadingLevel | undefined; // 見出し span/block in effect, carried ACROSS lines
  let curHeading: HeadingLevel | undefined; // 見出し of the line under construction (line start = activeHeading)
  let lineSuppressed = false; // a block directive token appeared on THIS line

  // Snapshot the four active channels onto a new unit — one stable hidden class for all real units.
  const mk = (cells: number, html: string, text: string): Unit => ({
    cells,
    html,
    text,
    emph: active.emph,
    line: active.line,
    weight: active.weight,
    style: active.style,
  });

  // 縦中横 span accumulator (LINE-local): body text goes into the buffer and flushes as ONE
  // 1-cell combined unit. No nesting — a ruby token contributes its raw literally, other
  // annotations keep their normal handling.
  let tcyBuf: string | null = null;
  const flushTcy = (): void => {
    if (tcyBuf !== null) {
      if (tcyBuf !== '') {
        const u = mk(1, `<span class="tcy">${escapeHtml(tcyBuf)}</span>`, tcyBuf);
        u.cssClass = 'tcy';
        cur.push(u);
      }
      tcyBuf = null;
    }
  };

  // JIS ルビ掛け settle pass (row complete): tighten each ruby back toward its on-grid base
  // width when both flow neighbours tolerate the ≤0.25em/side hang — no ruby/傍点/傍線 of
  // their own (shared lanes); a row edge tolerates it too. The centre-anchored lanes render
  // the hang by themselves, so only cells/class/html need re-deriving.
  const settleRubyOverhang = (): void => {
    const tolerant = (from: number, step: number): boolean => {
      for (let k = from + step; k >= 0 && k < cur.length; k += step) {
        const n = cur[k];
        if (n === undefined || n.text === '') {
          continue; // zero-width (comments): look past them
        }
        return n.ruby === undefined && n.emph === undefined && n.line === undefined;
      }
      return true; // row edge
    };
    for (let i = 0; i < cur.length; i += 1) {
      const u = cur[i];
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
  };

  const endLine = (isFlush: boolean): void => {
    settleRubyOverhang();
    const hasReal = cur.some((u) => u.cells > 0);
    // `heading` is CONDITIONAL: row snapshots deepEqual whole objects, so an absent heading
    // must be an absent KEY, never an explicit undefined.
    const line = (): Row =>
      curHeading === undefined
        ? { kind: 'line', srcLine, units: cur, indent: curIndent }
        : { kind: 'line', srcLine, units: cur, indent: curIndent, heading: curHeading };
    if (isPageBreak) {
      if (cur.length > 0) {
        rows.push(line());
      }
      rows.push({ kind: 'pagebreak' });
    } else if (lineSuppressed && !hasReal) {
      // A block-directive-only line (no real text) paints NO column. A plain comment-only line
      // never sets lineSuppressed, so it still falls through and keeps its blank column.
    } else if (cur.length > 0 || !isFlush) {
      // On a real '\n' an empty line is a genuine blank column (kept); at end-of-input
      // a trailing empty line is just the final newline artifact (dropped).
      rows.push(line());
    }
    cur = [];
    isPageBreak = false;
    lineSuppressed = false;
    curIndent = activeIndent; // next line inherits the block indent (0 if none)
    curHeading = activeHeading; // next line inherits an open 見出し span/block (postfix stays line-local)
  };

  for (let ti = 0; ti < tokens.length; ti += 1) {
    const token = tokens[ti];
    if (token === undefined) {
      continue;
    }
    switch (token.kind) {
      case 'text': {
        const parts = token.text.split('\n');
        for (let idx = 0; idx < parts.length; idx += 1) {
          if (idx > 0) {
            flushTcy(); // an open ［＃縦中横］ auto-closes at its line end (line-local)
            endLine(false);
            srcLine += 1;
          }
          const part = parts[idx] ?? '';
          if (tcyBuf !== null) {
            tcyBuf += part;
          } else {
            for (const ch of part) {
              // The configured dash is emitted as DASH_GLYPH; `text` keeps the source char so
              // postfix targets, 分離禁止 and the lint scanner still match it. 縦中横 and ルビ
              // cells build their own html — a dash inside one stays the source glyph.
              cur.push(mk(1, ch === want ? DASH_GLYPH : escapeHtml(ch), ch));
            }
          }
        }
        break;
      }
      case 'rubyExplicit':
      case 'rubyImplicit': {
        if (tcyBuf !== null) {
          tcyBuf += token.raw; // no nesting inside 縦中横 — the ruby markup stays literal
          break;
        }
        const ruby = { base: token.base, right: token.reading };
        const cells = rubyCells(ruby); // safe whole-cell advance; the settle pass may tighten
        const u = mk(cells, '', token.base);
        u.ruby = ruby;
        u.cssClass = rubyLane(ruby, cells); // rr (+ rh-N); 左ルビ may upgrade to br
        u.html = rubyHtml(u.ruby, cells);
        cur.push(u);
        break;
      }
      case 'rubyLeftPostfix':
        applyLeftRuby(
          cur,
          token.target,
          token.reading,
          token.raw,
          issues === undefined ? undefined : () => issues.push(ti),
        );
        break;
      case 'emphasisPostfix':
        applyPostfix(
          cur,
          token.target,
          token.variant,
          token.raw,
          issues === undefined ? undefined : () => issues.push(ti),
        );
        break;
      case 'tcyPostfix':
        applyTcyPostfix(
          cur,
          token.target,
          token.raw,
          issues === undefined ? undefined : () => issues.push(ti),
        );
        break;
      case 'headingPostfix':
        // Line-level effect: a resolved target marks THIS logical line as a heading. Binding
        // shares {@link matchTarget} so postfix semantics/diagnostics never diverge; a miss
        // degrades + reports exactly like the unit-level appliers.
        if (matchTarget(cur, token.target) !== null) {
          curHeading = token.level;
        } else {
          issues?.push(ti);
          cur.push(commentUnit(token.raw));
        }
        break;
      case 'headingSpanStart':
        // The three levels share ONE slot (they cannot compose on a line): a re-open is a level
        // change. Inline ［＃大見出し］ marks THIS line too; the block form affects SUBSEQUENT
        // lines only (same-line text keeps its pre-block state, like the indent block).
        activeHeading = token.level;
        if (token.block === true) {
          lineSuppressed = true;
        } else {
          curHeading = token.level;
        }
        break;
      case 'headingSpanEnd':
        // Closes whatever heading is open regardless of the level literal (one slot; dangling is
        // a no-op: already undefined). The line carrying the end stays a heading (curHeading keeps).
        activeHeading = undefined;
        if (token.block === true) {
          lineSuppressed = true;
        }
        break;
      case 'tcySpanStart':
        // A redundant start inside an open span is a no-op (already combining).
        tcyBuf ??= '';
        break;
      case 'tcySpanEnd':
        flushTcy(); // dangling (no open span) is a render no-op; the diagnostics warn
        break;
      case 'emphasisSpanStart': {
        const d = resolveStyle(token.variant, 'span');
        if (d !== null) {
          active[d.channel] = d.className; // same-channel overwrite; other channels untouched
        }
        if (token.block === true) {
          lineSuppressed = true; // ［＃ここから太字/斜体］ own-line directive
        }
        break;
      }
      case 'emphasisSpanEnd': {
        const d = resolveStyle(token.variant, 'span');
        if (d !== null) {
          active[d.channel] = undefined; // clear ONLY this channel (lenient within a channel)
        }
        if (token.block === true) {
          lineSuppressed = true;
        }
        break;
      }
      case 'indent':
        // Tokenizer guarantees line-head; applies to THIS logical line only.
        curIndent = token.amount;
        break;
      case 'indentBlockStart':
        // Affects SUBSEQUENT lines; a same-line text keeps the pre-block indent.
        activeIndent = token.amount;
        lineSuppressed = true;
        break;
      case 'indentBlockEnd':
        activeIndent = 0; // dangling end (no open block) is a no-op: already 0
        lineSuppressed = true;
        break;
      case 'comment':
        cur.push(commentUnit(token.raw));
        break;
      case 'brokenAnnotation': {
        // Unclosed ［＃… (swallowed to its line end): visible literal text, so the preview/build
        // never silently drop prose — the editor diagnostic is the error surface. raw never
        // contains a line break, so no endLine handling is needed here.
        if (tcyBuf !== null) {
          tcyBuf += token.raw; // literal text joins the combined cell like any other prose
          break;
        }
        for (const ch of token.raw) {
          cur.push(mk(1, escapeHtml(ch), ch));
        }
        break;
      }
      case 'pageBreak':
        isPageBreak = true;
        break;
      case 'valueField': {
        // Per-char units, so 禁則/分離禁止/dash translation apply as to typed text. Values are
        // never re-tokenized (a 《 or ［＃ in a title stays literal) and carry no line break.
        const substituted = (opts?.values ?? VALUE_FIELD_PLACEHOLDERS)[token.field];
        if (tcyBuf !== null) {
          tcyBuf += substituted;
          break;
        }
        for (const ch of substituted) {
          cur.push(mk(1, ch === want ? DASH_GLYPH : escapeHtml(ch), ch));
        }
        break;
      }
      default: {
        const exhaustive: never = token;
        throw new Error(`buildRows: unhandled token ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  flushTcy(); // an open ［＃縦中横］ at end of input closes with its line
  endLine(true);
  return rows;
}

/** An unresolved corner-target postfix as absolute source offsets, with its target text. */
export interface PostfixTargetIssue {
  readonly start: number;
  readonly end: number;
  readonly target: string;
}

/**
 * Source spans of every corner-target postfix whose target could not be resolved (absent, or
 * not unit-aligned) — derived by RUNNING {@link buildRows} itself, offsets recovered by
 * accumulating `raw.length` like findBrokenAnnotations.
 *
 * A postfix following a ［＃ここに「…」の値を表示］ on its line is skipped: this scan is
 * bookless, so whether the target resolves is unknowable here. One LATER on the line cannot
 * affect an earlier postfix (targets bind to units already built), so those still report.
 */
export function findPostfixTargetIssues(src: string): PostfixTargetIssue[] {
  const tokens = tokenize(src);
  const misses: number[] = [];
  buildRows(tokens, { issues: misses });
  if (misses.length === 0) {
    return [];
  }
  const failed = new Set(misses);
  const out: PostfixTargetIssue[] = [];
  let offset = 0;
  let valueSeen = false; // a value field earlier on THIS line
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t !== undefined) {
      if (
        failed.has(i) &&
        !valueSeen &&
        (t.kind === 'emphasisPostfix' ||
          t.kind === 'tcyPostfix' ||
          t.kind === 'rubyLeftPostfix' ||
          t.kind === 'headingPostfix')
      ) {
        out.push({ start: offset, end: offset + t.raw.length, target: t.target });
      }
      if (t.kind === 'valueField') {
        valueSeen = true;
      } else if (t.kind === 'text' && t.text.includes('\n')) {
        valueSeen = false; // next line starts knowable again
      }
      offset += t.raw.length;
    }
  }
  return out;
}

/**
 * Chars forbidden at line END (追い出し: push down to the next line) — 行末禁則.
 * 始め括弧 (cl-01, https://www.w3.org/TR/jlreq/#character_classes).
 */
const KINSOKU_OPEN = new Set('「『（〔［｛〈《【〘〖｟〝');
/**
 * Chars forbidden at line START (pull the preceding char down) — 行頭禁則, the relaxed tier:
 * 終わり括弧・句読点・区切り約物・中点類・繰り返し記号 (cl-02/04/05/06/07/09,
 * https://www.w3.org/TR/jlreq/#character_classes) = Word 標準 / CSS `line-break: normal`.
 */
const KINSOKU_CLOSE = new Set(
  '」』）〕］｝〉》】〙〗｠〟' + // 終わり括弧
    '、。，．' + // 句読点
    '！？!?‼⁇⁈⁉' + // 区切り約物 (full-width, half-width, single-codepoint)
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
 * EVERY char of a real (cells>0) unit is in `set` — so a 縦中横 約物 pair (text "!?") counts
 * whole, while a digit tcy or a ruby base stays free. The cells guard keeps zero-width
 * comments (text '') out of the vacuously-true empty iteration.
 */
function everyCharIn(u: Unit | undefined, set: Set<string>): boolean {
  if (u === undefined || u.cells === 0 || u.text.length === 0) {
    return false;
  }
  for (const c of u.text) {
    if (!set.has(c)) {
      return false;
    }
  }
  return true;
}

/**
 * ぶら下げ対象は句読点のみ (JIS X 4051 の慣例; 閉じ括弧・約物は対象外). The hung glyph's ink
 * stays inside the EDGE_INSET reserve past the last cell, clear of the 枠.
 */
const HANGABLE = new Set('、。，．');

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
  if (h === undefined || h.cells === 0 || h.text.length !== 1 || !HANGABLE.has(h.text)) {
    return false;
  }
  const p = lastReal(units, start, i);
  if (p >= 0 && everyCharIn(units[p], KINSOKU_OPEN)) {
    return false;
  }
  const n = nextReal(units, i + 1);
  return n < 0 || !everyCharIn(units[n], close);
}

/** The hung unit: zero cells (outside the budget), its glyph wrapped for the `.hang` rule. */
function makeHangUnit(u: Unit): Unit {
  return {
    cells: 0,
    text: u.text,
    html: `<span class="hang">${u.html}</span>`,
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
 * Half-width 約物 bind only as an exact pair — the shape autoTcy targets — and only when it left
 * them as two cells (full-width ！？ need no binding: they are 行頭禁則, so the 追い出し cascade
 * already moves a split pair whole).
 */
export const INSEP_LEADER = new Set('…‥'); // U+2026 U+2025
const INSEP_BANG = new Set('!?'); // half-width; exactly-2 runs only

/**
 * The 分離禁止 class a unit binds under, or undefined (classed / ruby / multi-char / zero-width).
 * `bang: false` leaves the half-width `!?` class out (the reflow emitter — the reader wraps there).
 */
export function insepClass(u: Unit | undefined, { bang = true }: { bang?: boolean } = {}): Set<string> | undefined {
  if (u?.cells !== 1 || u.text.length !== 1 || u.cssClass !== undefined || u.ruby !== undefined) {
    return undefined;
  }
  if (DASH_CHARS.has(u.text)) {
    return DASH_CHARS;
  }
  if (INSEP_LEADER.has(u.text)) {
    return INSEP_LEADER;
  }
  return bang && INSEP_BANG.has(u.text) ? INSEP_BANG : undefined;
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
  const merged: Unit = { cells, text, html, emph: head.emph, line: head.line, weight: head.weight, style: head.style };
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
 * Hard-wraps one line row's units into display lines of at most `charsPerLine` cells. A unit
 * is atomic (never split) and an over-wide unit gets its own line. A 字下げ row narrows the
 * budget to `charsPerLine − N_eff` (N_eff = indent clamped to keep ≥1 content cell) and stamps
 * the SAME N_eff onto every display line — the first AND each wrapped continuation are indented
 * alike, and class / CSS padding / wrap budget all derive from this one value so the column can
 * never overflow. When `kinsoku` is not `none`, 分離禁止 runs are first bound into atomic units
 * (see {@link separate}); at each overflowing break a trailing 句読点 hangs as a zero cell when
 * that alone resolves the boundary (ぶら下げ, see {@link canHang}), and otherwise 禁則処理
 * nudges the break point LEFTWARD so a line never ENDS on an opening bracket (「『【（) nor
 * STARTS with a 行頭禁則 char (」』】）、。！？) — 追い出し. The walk re-tests the new
 * boundary, so cascades and the resulting reflow fall out naturally; the `> start` guard
 * never empties a line, which also leaves a lone-char row as-is. (禁則 walks unit text only —
 * the indent is CSS padding, not a unit, so the two never interact.)
 */
function wrapRow(
  row: Extract<Row, { kind: 'line' }>,
  charsPerLine: number,
  mode: KinsokuMode,
): DisplayLine[] {
  const { srcLine } = row;
  const units = mode === 'none' ? row.units : separate(row.units, mode);
  const indent = Math.min(row.indent ?? 0, charsPerLine - 1); // N_eff: keep >=1 content cell
  const budget = charsPerLine - indent;
  // 見出し propagates to every display line (wrapped continuations stay gothic, like indent);
  // conditional for the same absent-key contract the row snapshots rely on.
  const hs: { heading?: HeadingLevel } =
    row.heading === undefined ? {} : { heading: row.heading };
  if (units.length === 0) {
    return [{ srcLine, units: [], indent, ...hs }];
  }
  const lines: DisplayLine[] = [];
  let start = 0; // first unit index of the line being built
  let cells = 0;
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (u === undefined) {
      continue;
    }
    if (u.cells > 0 && i > start && cells + u.cells > budget) {
      let brk = i; // break BEFORE units[brk]
      if (mode !== 'none') {
        const close = closeFor(mode);
        if (canHang(units, start, i, close)) {
          // ぶら下げ: the 句読点 hangs off the full column as a zero cell. Trailing
          // zero-width units ride along so they never open a units-less column.
          let ns = i + 1;
          while (ns < units.length && (units[ns]?.cells ?? 0) === 0) {
            ns += 1;
          }
          const kept = [...units.slice(start, i), ...units.slice(i + 1, ns)];
          lines.push({ srcLine, units: kept, indent, hang: makeHangUnit(u), ...hs });
          start = ns;
          cells = 0;
          continue; // u is consumed as the hang — it must not count into the next column
        }
        // 追い出し: find the last acceptable break point
        while (
          brk > start + 1 &&
          (everyCharIn(units[brk], close) ||
            everyCharIn(units[lastReal(units, start, brk)], KINSOKU_OPEN))
        ) {
          brk -= 1;
        }
      }
      lines.push({ srcLine, units: units.slice(start, brk), indent, ...hs });
      start = brk;
      cells = 0;
      for (let j = brk; j < i; j += 1) {
        cells += units[j]?.cells ?? 0;
      }
    }
    cells += u.cells;
  }
  if (start < units.length) {
    // A hang can consume the row's very last unit; only a non-empty tail becomes a column.
    lines.push({ srcLine, units: units.slice(start), indent, ...hs });
  }
  return lines;
}

/** Flows rows into pages of at most `linesPerPage` lines; a pagebreak forces a new page. */
export function paginate(
  rows: readonly Row[],
  charsPerLine: number,
  linesPerPage: number,
  kinsoku: KinsokuMode,
): DisplayLine[][] {
  const pages: DisplayLine[][] = [];
  let page: DisplayLine[] = [];

  const flushPage = (): void => {
    if (page.length > 0) {
      pages.push(page);
      page = [];
    }
  };

  for (const row of rows) {
    if (row.kind === 'pagebreak') {
      flushPage();
      continue;
    }
    const lines = wrapRow(row, charsPerLine, kinsoku);
    for (const line of lines) {
      if (page.length >= linesPerPage) {
        pages.push(page);
        page = [];
      }
      page.push(line);
    }
  }
  flushPage();
  return pages;
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

function emitLine(line: DisplayLine, used?: Set<string>, anchor = true, head = ''): string {
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
  // `anchor` lets the continuous preview suppress data-line on a source line's wrapped
  // continuation columns (first-display-line-only); the paginated build keeps the default
  // (anchor=true → every line), so its output is unchanged. `head` is out-of-flow line
  // furniture (the preview's number span) emitted before the column content.
  const dataLine =
    anchor && line.srcLine >= 0 ? ` data-line="${String(line.srcLine)}"` : '';
  return `<div class="line${indentClass}${headingClass}${emrClass}"${dataLine}>${head}${html}</div>`;
}

/** The folio's physical side on page `pi` (0-based), or null for no folio. */
function folioSide(pos: PageNumberPosition, pi: number): 'r' | 'l' | null {
  if (pos === 'none') {
    return null;
  }
  const odd = pi % 2 === 0; // display page = pi + 1, so an even index is an odd page
  switch (pos) {
    case 'rightLeft':
      return odd ? 'r' : 'l';
    case 'leftRight':
      return odd ? 'l' : 'r';
    case 'right':
      return 'r';
    case 'left':
      return 'l';
  }
}

/** One page's absolutely-positioned furniture (header + folio), emitted after its lines. */
function pageFurniture(chrome: BuildChrome, pi: number, totalPage: number): string {
  let out = '';
  if (chrome.header !== '') {
    out += `<div class="hd">${escapeHtml(chrome.header)}</div>`;
  }
  const side = folioSide(chrome.pageNumber, pi);
  if (side !== null) {
    // Escape the author's template FIRST, then substitute the plain-integer counts —
    // `{`/`}` survive escaping, so the placeholders live through it, while any markup in
    // the template is neutralized. Unknown `{foo}` stays literal. A blank template never
    // reaches here (renderBook normalizes it to pageNumber 'none').
    const text = escapeHtml(chrome.pageNumberFormat)
      .replaceAll('{page}', String(pi + 1))
      .replaceAll('{totalPage}', String(totalPage));
    out += `<div class="pn ${side}">${text}</div>`;
  }
  return out;
}

/**
 * One output sheet. `cover: true` marks an unnumbered front page: no header, folio or line
 * numbers, and outside the folio's `{page}`/`{totalPage}` counts. The grid and its reserved
 * bands are unchanged. Only the first two are withheld here — the line number is a CSS
 * counter matching `.page`, so its exemption lives in `build.ln.css`; 罫線/枠 stays on.
 */
export interface RenderPage {
  readonly lines: readonly DisplayLine[];
  readonly cover?: true;
}

/**
 * Renders paginated pages into the `<div class="book">…</div>` body fragment, each page
 * carrying its chrome furniture AFTER the lines (so line-adjacency is preserved for
 * anything matching consecutive `.line`s). The lines sit in a `.grid`, the sheet's only
 * vertical-rl box (build.base.css). When a `used` sink is passed, every emphasis
 * class emitted is recorded into it so the caller can emit only those rules (on-demand CSS)
 * — the structural `cover` class stays out of the sink. `data-page` is the sequential DOM
 * ordinal over ALL pages; the folio number and its {@link folioSide} parity count BODY pages
 * only, so cover sheets never shift where body page 1 lands.
 */
export function pagesToHtml(
  pages: readonly RenderPage[],
  used: Set<string> | undefined,
  chrome: BuildChrome,
): string {
  const totalPage = pages.reduce((n, page) => n + (page.cover === true ? 0 : 1), 0);
  let bodyPi = 0;
  const body = pages
    .map((page, di) => {
      const lines = page.lines.map((line) => emitLine(line, used)).join('');
      const furniture = page.cover === true ? '' : pageFurniture(chrome, bodyPi++, totalPage);
      const cls = page.cover === true ? 'page cover' : 'page';
      return `<div class="${cls}" data-page="${String(di)}"><div class="grid">${lines}</div>${furniture}</div>`;
    })
    .join('');
  return `<div class="book">${body}</div>`;
}

/**
 * Renders ONE file's rows as a CONTINUOUS line flow for the live preview (no pagination),
 * hard-wrapping each row via {@link wrapRow} — the same line-break + 禁則 + ruby/emphasis
 * engine the book build uses, so the preview agrees with the printed page. Pure + vscode-free.
 *
 * - `lineNumbers` opens every column with an out-of-flow `<span class="ln">N</span>` head,
 *   numbered in JS and restarting after each break marker: a counter-reset on a sibling
 *   `.pagebreak` does not reset following siblings in Chromium, so only the build's
 *   ancestor-`.page` CSS counters are reliable — never unify the two.
 * - Columns group into `<div class="segment">` blocks (one per run of lines between breaks,
 *   the build page's preview analogue) so the edge-rule 枠 closes independently on each side
 *   of a break. Segments open lazily on their first line, so a leading/trailing/doubled
 *   ［＃改ページ］ collapses to nothing — mirroring the build's empty-page elision.
 * - The labelled `<div class="pagebreak">` marker lands BETWEEN segments as a direct `.book`
 *   child, outside every frame.
 * - Only the FIRST display line of a source line carries `data-line` (1:1 anchors, so the
 *   cursor-follow scroller lands on the line's head).
 * - A `used` sink records every emitted class so the caller emits only those rules.
 */
export function flowToHtml(
  rows: readonly Row[],
  charsPerLine: number,
  kinsoku: KinsokuMode,
  used?: Set<string>,
  lineNumbers = false,
): string {
  const parts: string[] = [];
  let prevSrcLine = -1;
  let pendingBreak = false;
  let segmentOpen = false;
  let lineNo = 0;
  for (const row of rows) {
    if (row.kind === 'pagebreak') {
      // Defer page breaks: only materialized once a following line exists, so leading /
      // trailing / consecutive ［＃改ページ］ never leave a dangling marker.
      if (segmentOpen) {
        pendingBreak = true;
      }
      continue;
    }
    for (const line of wrapRow(row, charsPerLine, kinsoku)) {
      if (pendingBreak) {
        // The seam: close the segment and drop the marker BETWEEN segments — the shared
        // opener below reopens for this very line, so the marker never sits inside a
        // frame and the numbering restarts with the segment it opens.
        parts.push(
          '</div>',
          '<div class="pagebreak"><span class="pb-label">改ページ</span></div>',
        );
        segmentOpen = false;
        pendingBreak = false;
        lineNo = 0;
      }
      if (!segmentOpen) {
        // Segments open lazily on their first line (never on a break), so an empty
        // segment is structurally impossible.
        parts.push('<div class="segment">');
        segmentOpen = true;
      }
      lineNo += 1;
      const anchor = line.srcLine >= 0 && line.srcLine !== prevSrcLine;
      prevSrcLine = line.srcLine;
      // The number span is absolutely positioned (out of the text flow), so it neither
      // consumes cells nor disturbs the pre-formatted column content it precedes.
      const head = lineNumbers ? `<span class="ln">${String(lineNo)}</span>` : '';
      parts.push(emitLine(line, used, anchor, head));
    }
  }
  if (segmentOpen) {
    parts.push('</div>');
  }
  return `<div class="book">${parts.join('')}</div>`;
}
