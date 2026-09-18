/**
 * Document-level tokenizer for Aozora-Bunko-annotated text. Pure + vscode-free.
 *
 * The only annotation delimiter is the full-width ［＃ ... ］; corner brackets 「」 are
 * dialogue and are never comments. Ruby uses its own delimiters 《 》 with an optional
 * explicit base marker ｜. This is the single entry point that the per-file renderer,
 * the book renderer and the prose lint build on, so it handles cross-line spans (style span
 * start/end and 字下げ block start/end emit independent tokens in stream order; the
 * renderer pairs them).
 *
 * Delimiter pairing is LINE-BOUNDED — ［＃…］ and 《…》 never pair across a line break, so
 * broken markup only ever affects its own source line:
 *   - An unclosed ［＃ (no ］ before the line break) becomes ONE `brokenAnnotation` token
 *     swallowing ［＃ up to the line end — never the '\n', nor the '\r' of a '\r\n'. It is
 *     a compile ERROR: {@link findBrokenAnnotations} hands the exact spans to the editor
 *     diagnostics, while the layout renders the raw as visible literal text.
 *   - An unmatched 《 (no 》 on its line) stays lenient: literal text, no error. A ｜ base is
 *     dropped at a line break, so it never pairs with a later-line 《…》.
 *   - A closed 《…》 with no base before it (line start, after punctuation, a space or an
 *     annotation, or a ｜ with nothing visible before the 《) and an empty 《》 are literal text
 *     too; {@link findRubyIssues} hands those spans to the editor diagnostics as Warnings.
 *   - A standalone ］ or 》 is ordinary text.
 *
 * An explicit ｜ base runs up to the 《 whatever sits inside it — the spec offers a written ｜ as
 * the processing clue for reproducing the ruby (https://www.aozora.gr.jp/annotation/etc.html#ruby),
 * so it overrides the class-run guess; only a 縦中横 span edge ends it, that span being one cell
 * of its own. The explicit ruby is a span — `rubyStart` (the ｜), the base tokens in source
 * order, `rubyEnd` (the reading) — merged into one unit by the layout; the implicit ruby is one
 * atomic `rubyImplicit` token.
 */

import { composeKana, isCjkIdeograph, isCombiningKanaMark } from '../chars.ts';
import { resolveStyle, type Channel } from './emphasis.ts';

type TokenKind =
  | 'text'
  | 'rubyImplicit'
  | 'rubyStart'
  | 'rubyEnd'
  | 'rubyLeftPostfix'
  | 'emphasisPostfix'
  | 'emphasisSpanStart'
  | 'emphasisSpanEnd'
  | 'tcyPostfix'
  | 'tcySpanStart'
  | 'tcySpanEnd'
  | 'headingPostfix'
  | 'headingSpanStart'
  | 'headingSpanEnd'
  | 'comment'
  | 'brokenAnnotation'
  | 'pageBreak'
  | 'indent'
  | 'indentBlockStart'
  | 'indentBlockEnd'
  | 'valueField';

interface TokenBase {
  readonly kind: TokenKind;
  /** Source text this token was produced from (verbatim slice). */
  readonly raw: string;
}

export interface TextToken extends TokenBase {
  readonly kind: 'text';
  readonly text: string;
}

/** An implicit ruby 漢字《かんじ》: the base is the class run before the 《 (see detectImplicitBase). */
export interface RubyImplicitToken extends TokenBase {
  readonly kind: 'rubyImplicit';
  readonly base: string;
  readonly reading: string;
}

/**
 * The ｜ of an explicit ruby: the base tokens follow in source order — text, annotations, a value
 * field (｜山田［＃「山田」に傍点］《やまだ》) — up to the {@link RubyEndToken} on the same line.
 */
export interface RubyStartToken extends TokenBase {
  readonly kind: 'rubyStart';
}

/** The 《reading》 closing a {@link RubyStartToken} base; the layout merges the base into one ruby. */
export interface RubyEndToken extends TokenBase {
  readonly kind: 'rubyEnd';
  readonly reading: string;
}

export interface EmphasisPostfixToken extends TokenBase {
  readonly kind: 'emphasisPostfix';
  readonly target: string;
  readonly variant: string;
}

export interface EmphasisSpanStartToken extends TokenBase {
  readonly kind: 'emphasisSpanStart';
  readonly variant: string;
  /**
   * True iff this came from the BLOCK form ［＃ここから太字/斜体］ (own-line, 太字/斜体 only). The
   * inline form ［＃太字］ leaves it undefined. Drives empty-column suppression, the block-form
   * split colouring (ここから・ここで・終わり demoted to marker, keyword kept on 太字/斜体), and block
   * pairing ({@link findUnpairedSpans}).
   */
  readonly block?: true;
}

export interface EmphasisSpanEndToken extends TokenBase {
  readonly kind: 'emphasisSpanEnd';
  readonly variant: string;
  /** True iff from ［＃ここで太字/斜体終わり］ (block form). See {@link EmphasisSpanStartToken.block}. */
  readonly block?: true;
}

/**
 * 左ルビ postfix ［＃「対象」の左に「よみ」のルビ］ — a reading on the LEFT of the nearest
 * preceding `target` (https://www.aozora.gr.jp/annotation/etc.html#ruby). Pairs with a 《》
 * right reading on the same base for 両側ルビ (the annotation names the BASE only, never the
 * 《》 part); the sibling `…の注記` (ママ) family stays out of scope.
 */
export interface RubyLeftPostfixToken extends TokenBase {
  readonly kind: 'rubyLeftPostfix';
  readonly target: string;
  readonly reading: string;
}

/**
 * 縦中横 postfix ○○［＃「○○」は縦中横］ — sets the nearest preceding `target` upright in ONE
 * square (https://www.aozora.gr.jp/annotation/etc.html#tatechu_yoko). The connector は is
 * REQUIRED, exactly like 太字/斜体.
 */
export interface TcyPostfixToken extends TokenBase {
  readonly kind: 'tcyPostfix';
  readonly target: string;
}

/**
 * 縦中横 span opener ［＃縦中横］ — combines the text up to ［＃縦中横終わり］ or the line end
 * (LINE-local) into one upright cell; no block (ここから) form exists. Content is plain text
 * only: inner annotations degrade as usual, a 《…》 stays literal (no nesting).
 */
export interface TcySpanStartToken extends TokenBase {
  readonly kind: 'tcySpanStart';
}

/** 縦中横 span closer ［＃縦中横終わり］. Dangling (no open span) is a layout no-op. */
export interface TcySpanEndToken extends TokenBase {
  readonly kind: 'tcySpanEnd';
}

/**
 * 通常の見出し postfix ○○［＃「○○」は大見出し］ — marks its own logical line as a heading
 * (https://www.aozora.gr.jp/annotation/heading.html#tsujyo_midashi). The connector は is
 * REQUIRED, exactly like 縦中横; per the spec the target excludes ruby readings, which the
 * layout's base-text matching satisfies. Line-local, unlike the span/block forms below.
 */
export interface HeadingPostfixToken extends TokenBase {
  readonly kind: 'headingPostfix';
  readonly target: string;
  readonly level: HeadingLevel;
}

/**
 * 見出し span opener ［＃大見出し］ — marks every line it touches as a heading (line-level, so
 * the whole column goes gothic) until the matching {@link HeadingSpanEndToken}; like the
 * emphasis spans the state carries ACROSS lines. The three level literals share ONE slot
 * (levels cannot compose on a line), so a re-open is a level change, never nesting.
 */
export interface HeadingSpanStartToken extends TokenBase {
  readonly kind: 'headingSpanStart';
  readonly level: HeadingLevel;
  /**
   * True iff this came from the BLOCK form ［＃ここから大見出し］ (own-line). The inline form
   * ［＃大見出し］ leaves it undefined. Drives empty-column suppression, the block-form split
   * colouring, block pairing ({@link findUnpairedSpans}), and the subsequent-lines-only
   * onset (same-line text keeps its pre-block state, like the indent block).
   */
  readonly block?: true;
}

/** 見出し span closer ［＃大見出し終わり］ — closes the open heading regardless of its level
 *  literal (one slot); dangling (no open span) is a layout no-op. See
 *  {@link HeadingSpanStartToken.block} for the ここで block flavour. */
export interface HeadingSpanEndToken extends TokenBase {
  readonly kind: 'headingSpanEnd';
  readonly level: HeadingLevel;
  readonly block?: true;
}

export interface CommentToken extends TokenBase {
  readonly kind: 'comment';
  /** Inner text of ［＃ ... ］, emitted verbatim into an HTML comment by the renderer. */
  readonly inner: string;
}

/**
 * An unclosed ［＃ (no ］ before its line break), swallowed to the line end. There is no inner —
 * `raw` (＝ ［＃… up to but never including the line break) IS the payload: the layout renders it
 * as visible literal text, and {@link findBrokenAnnotations} surfaces it as a compile error.
 */
export interface BrokenAnnotationToken extends TokenBase {
  readonly kind: 'brokenAnnotation';
}

export interface PageBreakToken extends TokenBase {
  readonly kind: 'pageBreak';
}

/**
 * A single-line indent ［＃○字下げ］ — indents its own logical line by `amount` full-width cells.
 * LINE-HEAD only: the tokenizer emits this only when the ［ opens the line (see `atLineStart` in
 * {@link tokenize}); mid-line it degrades to a {@link CommentToken}, matching the tmLanguage `^`
 * anchor. `amount` is a non-negative int parsed from full-width digits ０-９ (see
 * {@link indentAmount}); the layout clamps it to the line width and treats 0 as no indent.
 */
export interface IndentToken extends TokenBase {
  readonly kind: 'indent';
  readonly amount: number;
}

/**
 * Block indent opener ［＃ここから○字下げ］ — indents every following logical line by `amount`
 * (incl. wrapped continuations) until the matching {@link IndentBlockEndToken}. Not line-head-gated.
 */
export interface IndentBlockStartToken extends TokenBase {
  readonly kind: 'indentBlockStart';
  readonly amount: number;
}

/**
 * Block indent closer ［＃ここで字下げ終わり］. A dangling one (no open block) is a layout no-op;
 * {@link findUnpairedSpans} surfaces it as a Warning.
 */
export interface IndentBlockEndToken extends TokenBase {
  readonly kind: 'indentBlockEnd';
}

/**
 * Value display ［＃ここに「名前」の値を表示］: renders the value the compile supplies for `name`,
 * else the name itself. Only the html build supplies values ({@link VALUE_NAMES}), to cover
 * pages and the page furniture; every other compile is bookless by design (a cover template
 * serves many books). The `.txt` build keeps the annotation verbatim.
 */
export interface ValueFieldToken extends TokenBase {
  readonly kind: 'valueField';
  readonly name: string;
}

export type Token =
  | TextToken
  | RubyImplicitToken
  | RubyStartToken
  | RubyEndToken
  | RubyLeftPostfixToken
  | EmphasisPostfixToken
  | EmphasisSpanStartToken
  | EmphasisSpanEndToken
  | TcyPostfixToken
  | TcySpanStartToken
  | TcySpanEndToken
  | HeadingPostfixToken
  | HeadingSpanStartToken
  | HeadingSpanEndToken
  | CommentToken
  | BrokenAnnotationToken
  | PageBreakToken
  | IndentToken
  | IndentBlockStartToken
  | IndentBlockEndToken
  | ValueFieldToken;

// Full-width annotation/ruby markers (see codepoints in the locked spec).
const OPEN_BRACKET = '［';
const HASH = '＃';
const CLOSE_BRACKET = '］';
const RUBY_OPEN = '《';
const RUBY_CLOSE = '》';
const BASE_MARK = '｜';
const CORNER_OPEN = '「';
const CORNER_CLOSE = '」';
const PAGE_BREAK = '改ページ';
const SPAN_END_SUFFIX = '終わり';
const CONNECTOR_NI = 'に';
const CONNECTOR_HA = 'は';
const BLOCK_FROM = 'ここから';
const BLOCK_TO = 'ここで';
const INDENT_SUFFIX = '字下げ';
const BOLD = '太字';
const ITALIC = '斜体';
const TCY = '縦中横';
const LEFT_RUBY_OPEN = 'の左に「';
const LEFT_RUBY_CLOSE = '」のルビ';
const VALUE_OPEN = 'ここに「';
const VALUE_CLOSE = '」の値を表示';

/** The three 通常の見出し literals; `level` = index + 1 (大=1, 中=2, 小=3). Shared with the
 * tmLanguage heading rule via the grammar-sync test. */
export const HEADING_LITERALS = ['大見出し', '中見出し', '小見出し'] as const;
export type HeadingLevel = 1 | 2 | 3;

/**
 * The names the html build supplies to ［＃ここに「…」の値を表示］: cover pages get the first
 * four, the page furniture (header / footer) all five. Any other name — and every name in a
 * compile that supplies no values — renders as the name itself.
 */
export const VALUE_NAMES = {
  title: 'タイトル',
  author: 'ペンネーム',
  totalPages: '総ページ数',
  sheets: '原稿用紙換算枚数',
  page: 'ページ番号',
} as const;

/** `inner` wrapped as a ［＃…］ annotation — the composer every inverse spelling below shares. */
function annotation(inner: string): string {
  return `${OPEN_BRACKET}${HASH}${inner}${CLOSE_BRACKET}`;
}

/** The value display annotation for `name` — the inverse spelling of the tokenizer's rule. */
export function valueAnnotation(name: string): string {
  return annotation(`${VALUE_OPEN}${name}${VALUE_CLOSE}`);
}

/** True iff `variant` has a ここから／ここで form: 太字/斜体 only. */
function hasBlockForm(variant: string): boolean {
  return variant === BOLD || variant === ITALIC;
}

/** The heading level `s` names, or null when `s` is not one of {@link HEADING_LITERALS}. */
function headingLevelOf(s: string): HeadingLevel | null {
  const idx = (HEADING_LITERALS as readonly string[]).indexOf(s);
  return idx === -1 ? null : ((idx + 1) as HeadingLevel);
}

/** The inverse of {@link headingLevelOf}. */
function headingLiteralOf(level: HeadingLevel): string {
  switch (level) {
    case 1:
      return HEADING_LITERALS[0];
    case 2:
      return HEADING_LITERALS[1];
    case 3:
      return HEADING_LITERALS[2];
  }
}

/**
 * The inverse spelling of {@link indentAmount}: composes ［＃N字下げ］ with FULL-WIDTH digits —
 * the only form this parser and the tmLanguage rule accept.
 */
export function indentAnnotation(amount: number): string {
  const digits = String(amount).replace(/[0-9]/g, (d) =>
    String.fromCharCode(0xff10 + d.charCodeAt(0) - 0x30),
  );
  return annotation(`${digits}${INDENT_SUFFIX}`);
}

/**
 * The indent count in `s` = 「<digits>字下げ」 — FULL-WIDTH digits ０-９ only (locked spec);
 * anything else yields null → the caller degrades to a comment. The count is unbounded here
 * (the layout clamps to the line width, so the grammar's `[０-９]+` can never disagree);
 * leading zeros parse numerically and 0 is a valid amount the layout renders as no indent.
 */
function indentAmount(s: string): number | null {
  if (!s.endsWith(INDENT_SUFFIX)) {
    return null;
  }
  const digits = s.slice(0, s.length - INDENT_SUFFIX.length);
  if (digits.length === 0) {
    return null;
  }
  let n = 0;
  for (let k = 0; k < digits.length; k += 1) {
    const cp = digits.charCodeAt(k);
    if (cp < 0xff10 || cp > 0xff19) {
      return null; // not a full-width digit (半角/漢数字 degrade to comment)
    }
    n = n * 10 + (cp - 0xff10);
  }
  return n;
}

/**
 * Connector matrix, kept literally consistent with tmLanguage rules 9/10 so both layers grey the
 * same inputs (zero-fight):
 *   - 傍点/傍線 (emph/line): connector に is OPTIONAL (grammar `(に|の左に)?`); a bare 「対象」傍点
 *     or a の左に-prefixed one (family=null) is accepted (bare 左に is the span spelling —
 *     resolveStyle('postfix') rejects it before this matrix is consulted).
 *   - 太字/斜体 (weight/style): connector は is REQUIRED (grammar `(は)`, NOT optional); a bare
 *     「対象」太字 (family=null) or a に-paired one → false → comment, matching the grammar.
 *   - Any cross-family pairing (は+傍点, に+太字) → false → comment.
 */
function connectorMatches(family: 'ni' | 'ha' | null, channel: Channel): boolean {
  if (channel === 'weight' || channel === 'style') {
    return family === 'ha'; // 太字/斜体 REQUIRE は
  }
  return family === 'ni' || family === null; // 傍点/傍線: に optional; の左に / bare (family=null) ok
}

/**
 * Classifies the inner text of a ［＃ ... ］ annotation (already extracted, never re-scanned)
 * into the appropriate annotation token. The `raw` is the full bracketed source slice including
 * ［＃ and ］; `atLineStart` is true iff the ［ opened its line (only the single-line 字下げ
 * branch reads it). Recognition is PURELY LITERAL and kept literally identical to the tmLanguage
 * patterns, so the grammar and this lexer never colour a span differently: whether a recognised
 * block actually pairs / an indent actually applies is decided later (layout /
 * {@link findUnpairedSpans}), never by degrading a well-formed directive to a grey comment here.
 */
function classifyAnnotation(inner: string, raw: string, atLineStart: boolean): Token {
  if (inner === PAGE_BREAK) {
    return { kind: 'pageBreak', raw };
  }

  // Value display ［＃ここに「名前」の値を表示］ — any non-empty name (the grammar's `[^］]+`);
  // an empty pair greys out. ここに… collides with no other branch's literals.
  if (
    inner.startsWith(VALUE_OPEN) &&
    inner.endsWith(VALUE_CLOSE) &&
    inner.length > VALUE_OPEN.length + VALUE_CLOSE.length
  ) {
    return { kind: 'valueField', raw, name: inner.slice(VALUE_OPEN.length, inner.length - VALUE_CLOSE.length) };
  }

  // Corner-target postfix ［＃「対象」に傍点／の左に傍線／は太字…］.
  if (inner.startsWith(CORNER_OPEN)) {
    return classifyPostfix(inner, raw);
  }

  // Block END ［＃ここで X終わり］ — BEFORE block-start and the short span-end (its 終わり overlaps).
  if (inner.startsWith(BLOCK_TO) && inner.endsWith(SPAN_END_SUFFIX)) {
    const mid = inner.slice(BLOCK_TO.length, inner.length - SPAN_END_SUFFIX.length);
    if (mid === INDENT_SUFFIX) {
      return { kind: 'indentBlockEnd', raw };
    }
    if (hasBlockForm(mid)) {
      return { kind: 'emphasisSpanEnd', raw, variant: mid, block: true };
    }
    const headingEnd = headingLevelOf(mid);
    if (headingEnd !== null) {
      return { kind: 'headingSpanEnd', raw, level: headingEnd, block: true };
    }
    return { kind: 'comment', raw, inner }; // ここで傍点終わり etc. (傍点/傍線 have no block form)
  }

  // Block START ［＃ここから X］.
  if (inner.startsWith(BLOCK_FROM)) {
    const body = inner.slice(BLOCK_FROM.length);
    const amount = indentAmount(body);
    if (amount !== null) {
      return { kind: 'indentBlockStart', raw, amount };
    }
    if (hasBlockForm(body)) {
      return { kind: 'emphasisSpanStart', raw, variant: body, block: true };
    }
    const headingStart = headingLevelOf(body);
    if (headingStart !== null) {
      return { kind: 'headingSpanStart', raw, level: headingStart, block: true };
    }
    return { kind: 'comment', raw, inner }; // ここから傍点 / ここから…折り返して… → grey
  }

  // Short (inline) span END ［＃傍点終わり／左に傍線終わり／太字終わり］ — the span form's left
  // prefix is bare 左に only. 縦中横終わり must be matched FIRST (not an emphasis variant, it
  // would otherwise fall into this branch's comment degrade).
  if (inner.endsWith(SPAN_END_SUFFIX)) {
    const variant = inner.slice(0, inner.length - SPAN_END_SUFFIX.length);
    if (variant === TCY) {
      return { kind: 'tcySpanEnd', raw };
    }
    if (resolveStyle(variant, 'span') !== null) {
      return { kind: 'emphasisSpanEnd', raw, variant };
    }
    const headingEnd = headingLevelOf(variant);
    if (headingEnd !== null) {
      return { kind: 'headingSpanEnd', raw, level: headingEnd };
    }
    return { kind: 'comment', raw, inner };
  }

  // Single-line indent ［＃○字下げ］ — LINE-HEAD only.
  const amount = indentAmount(inner);
  if (amount !== null) {
    return atLineStart
      ? { kind: 'indent', raw, amount }
      : { kind: 'comment', raw, inner };
  }

  // 縦中横 span START ［＃縦中横］ — an exact literal, no block (ここから) form.
  if (inner === TCY) {
    return { kind: 'tcySpanStart', raw };
  }

  // Short (inline) span START ［＃傍点／左に傍線／太字］ — the span form's left prefix is bare 左に only.
  if (resolveStyle(inner, 'span') !== null) {
    return { kind: 'emphasisSpanStart', raw, variant: inner };
  }

  // 見出し span START ［＃大見出し］ — exact level literals only.
  const headingStart = headingLevelOf(inner);
  if (headingStart !== null) {
    return { kind: 'headingSpanStart', raw, level: headingStart };
  }

  return { kind: 'comment', raw, inner };
}

/**
 * Corner-target postfix. Connector rules: strip a single に / は; の is NOT a connector (の左に
 * is the postfix direction prefix, resolved whole). に→emph/line, は→weight/style; a channel
 * mismatch, an unknown variant, or a connector combined with の左に (mutually exclusive — a
 * stripped に/は resolves the rest form-less) degrades to a comment.
 */
function classifyPostfix(inner: string, raw: string): Token {
  const close = inner.indexOf(CORNER_CLOSE, CORNER_OPEN.length);
  if (close === -1) {
    return { kind: 'comment', raw, inner };
  }
  const target = inner.slice(CORNER_OPEN.length, close);
  let rest = inner.slice(close + CORNER_CLOSE.length);

  // 左ルビ ［＃「対象」の左に「よみ」のルビ］ — before the connector strip (its の is not a
  // connector); the second corner pair + のルビ tail never collides with の左に傍線. An empty
  // or corner-bracketed reading degrades to a comment.
  if (rest.startsWith(LEFT_RUBY_OPEN) && rest.endsWith(LEFT_RUBY_CLOSE)) {
    const reading = rest.slice(LEFT_RUBY_OPEN.length, rest.length - LEFT_RUBY_CLOSE.length);
    if (
      target !== '' &&
      reading !== '' &&
      !reading.includes(CORNER_OPEN) &&
      !reading.includes(CORNER_CLOSE)
    ) {
      return { kind: 'rubyLeftPostfix', raw, target, reading };
    }
    return { kind: 'comment', raw, inner };
  }

  let family: 'ni' | 'ha' | null = null;
  if (rest.startsWith(CONNECTOR_HA)) {
    family = 'ha';
    rest = rest.slice(CONNECTOR_HA.length);
  } else if (rest.startsWith(CONNECTOR_NI)) {
    family = 'ni';
    rest = rest.slice(CONNECTOR_NI.length);
  }
  // 縦中横 postfix ［＃「対象」は縦中横］ — the connector は is REQUIRED (like 太字/斜体):
  // a bare or に-paired 縦中横 degrades to a comment.
  if (rest === TCY) {
    if (family === 'ha' && target !== '') {
      return { kind: 'tcyPostfix', raw, target };
    }
    return { kind: 'comment', raw, inner };
  }
  // 見出し postfix ［＃「対象」は大見出し］ — same は-required contract as 縦中横.
  const headingLevel = headingLevelOf(rest);
  if (headingLevel !== null) {
    if (family === 'ha' && target !== '') {
      return { kind: 'headingPostfix', raw, target, level: headingLevel };
    }
    return { kind: 'comment', raw, inner };
  }
  const style = resolveStyle(rest, family === null ? 'postfix' : 'none');
  if (target !== '' && style !== null && connectorMatches(family, style.channel)) {
    return { kind: 'emphasisPostfix', raw, target, variant: rest };
  }
  return { kind: 'comment', raw, inner };
}

/**
 * Offset just past the last line-content char at/after `from`: the next '\n' (backing off over
 * the '\r' of a '\r\n' terminator) or the end of input. Bounds every delimiter pairing to the
 * current line. The annotation branch slices with it (`from` is past ［＃, so the back-off can
 * never step before the marker); the ruby branch only compares against it.
 */
function endOfLine(src: string, from: number): number {
  const nl = src.indexOf('\n', from);
  const end = nl === -1 ? src.length : nl;
  return src.charAt(end - 1) === '\r' ? end - 1 : end;
}

/**
 * `text` cut at '\n' or '\r\n' (the '\r' dropped with it); a lone '\r' stays literal, as in
 * {@link endOfLine}. Offset consumers walk `text` verbatim instead.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * A 《…》 that made no ruby, as absolute source UTF-16 offsets `[start, end)`: `baseMissing` — a
 * closed reading with no base text before it (from the ｜ when one opened the base);
 * `readingEmpty` — an empty 《》. The render prints the run as typed.
 */
export interface RubyIssue {
  readonly start: number;
  readonly end: number;
  readonly kind: 'baseMissing' | 'readingEmpty';
  /** The reading; empty for `readingEmpty`. */
  readonly reading: string;
}

/**
 * The token stream of `src`. `opts.issues` collects the 《…》 the lenient recovery keeps as literal
 * text (see {@link findRubyIssues}); the stream itself is the same with or without the sink.
 */
export function tokenize(src: string, opts?: { readonly issues?: RubyIssue[] }): Token[] {
  const tokens: Token[] = [];
  const issues = opts?.issues;
  let textBuf = '';
  // The explicit base opened by the latest ｜, held until its 《reading》: the text before the ｜,
  // the ｜'s offset, and the tokens since it (text pieces and annotations); the text after the
  // last of them is still in textBuf.
  let held: { readonly before: string; readonly at: number; readonly tokens: Token[] } | null = null;

  const text = (s: string): Token => ({ kind: 'text', raw: s, text: s });

  const flushText = (): void => {
    if (textBuf !== '') {
      tokens.push(text(textBuf));
      textBuf = '';
    }
  };

  // No reading followed the ｜: it is literal text, and what was held comes out as it was.
  const releaseHeld = (): void => {
    if (held === null) {
      return;
    }
    const lead = held.before + BASE_MARK;
    const [first, ...rest] = held.tokens;
    if (first === undefined) {
      textBuf = lead + textBuf; // nothing between: the ｜ rejoins its text
    } else if (first.kind === 'text') {
      tokens.push(text(lead + first.text), ...rest);
    } else {
      tokens.push(text(lead), ...held.tokens);
    }
    held = null;
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    // charAt returns '' past the end (never undefined); all markers are BMP.
    const ch = src.charAt(i);

    // Annotation opener ［＃.
    if (ch === OPEN_BRACKET && src.charAt(i + 1) === HASH) {
      const lineEnd = endOfLine(src, i + 2);
      const close = src.indexOf(CLOSE_BRACKET, i + 2);
      if (close === -1 || close >= lineEnd) {
        // No ］ before the line break — the broken annotation swallows ［＃ up to (never past)
        // the end of THIS line; findBrokenAnnotations() reports the span as a compile error.
        releaseHeld();
        flushText();
        tokens.push({ kind: 'brokenAnnotation', raw: src.slice(i, lineEnd) });
        i = lineEnd;
        continue;
      }
      // Line-head test for the ［＃○字下げ］ directive: the ［ opens the line at BOF or just past
      // a line break. A lone '\r' counts too — VS Code and LSP both treat it as a line separator,
      // so the tmLanguage `^` matches after it; this must agree or the two layers would colour a
      // ［＃○字下げ］ after a bare '\r' differently. Only classifyAnnotation's single-line indent
      // branch reads it.
      const atLineStart =
        i === 0 || src.charAt(i - 1) === '\n' || src.charAt(i - 1) === '\r';
      const inner = src.slice(i + 2, close);
      const raw = src.slice(i, close + 1);
      const annotation = classifyAnnotation(inner, raw, atLineStart);
      if (annotation.kind === 'tcySpanStart' || annotation.kind === 'tcySpanEnd') {
        releaseHeld(); // a 縦中横 span is one cell of its own: a ｜ base never crosses its edge
      }
      if (held !== null) {
        // Inside a ｜ base the annotation is part of it (｜山田［＃「山田」に傍点］《やまだ》).
        if (textBuf !== '') {
          held.tokens.push(text(textBuf));
          textBuf = '';
        }
        held.tokens.push(annotation);
        i = close + 1;
        continue;
      }
      flushText();
      tokens.push(annotation);
      i = close + 1;
      continue;
    }

    // Explicit ruby base marker ｜: opens a held base. The last ｜ before a 《 wins.
    if (ch === BASE_MARK) {
      releaseHeld();
      held = { before: textBuf, at: i, tokens: [] };
      textBuf = '';
      i += 1;
      continue;
    }

    // Ruby reading 《 ... 》.
    if (ch === RUBY_OPEN) {
      const close = src.indexOf(RUBY_CLOSE, i + 1);
      if (close === -1 || close >= endOfLine(src, i + 1)) {
        // No 》 on this line — literal (a reading never spans lines; lenient, no error).
        textBuf += ch;
        i += 1;
        continue;
      }
      const reading = src.slice(i + 1, close);
      const rubyRaw = src.slice(i, close + 1);

      if (reading === '') {
        // Empty 《》 => literal text, no ruby; a held ｜ turns literal with it.
        issues?.push({ start: i, end: close + 1, kind: 'readingEmpty', reading });
        releaseHeld();
        textBuf += rubyRaw;
        i = close + 1;
        continue;
      }

      if (held !== null) {
        const visible =
          textBuf !== '' || held.tokens.some((t) => t.kind === 'text' || t.kind === 'valueField');
        if (!visible) {
          // Nothing between the ｜ and the 《 that a reading could sit on: no base.
          issues?.push({ start: held.at, end: close + 1, kind: 'baseMissing', reading });
          releaseHeld();
          textBuf += rubyRaw;
          i = close + 1;
          continue;
        }
        // The explicit ruby: the ｜, the base tokens in source order, the reading.
        if (held.before !== '') {
          tokens.push(text(held.before));
        }
        tokens.push({ kind: 'rubyStart', raw: BASE_MARK }, ...held.tokens);
        if (textBuf !== '') {
          tokens.push(text(textBuf));
          textBuf = '';
        }
        tokens.push({ kind: 'rubyEnd', raw: rubyRaw, reading });
        held = null;
        i = close + 1;
        continue;
      }

      // Implicit base: walk back over one character class.
      const { base, rest } = detectImplicitBase(textBuf);
      if (base === '') {
        // No base char precedes => leave 《reading》 as literal text.
        issues?.push({ start: i, end: close + 1, kind: 'baseMissing', reading });
        textBuf += rubyRaw;
        i = close + 1;
        continue;
      }
      if (rest !== '') {
        tokens.push(text(rest));
      }
      tokens.push({ kind: 'rubyImplicit', raw: base + rubyRaw, base, reading });
      textBuf = '';
      i = close + 1;
      continue;
    }

    // Ordinary character (includes 「」 dialogue, newlines, spaces).
    if (ch === '\n') {
      releaseHeld(); // a ｜ base never survives a line break (ruby is line-local)
    }
    textBuf += ch;
    i += 1;
  }

  releaseHeld();
  flushText();
  return tokens;
}

// Broken-annotation spans (compile errors)

/** A broken (unclosed) ［＃ annotation as absolute source UTF-16 offsets `[start, end)`. */
export interface BrokenAnnotation {
  readonly start: number;
  readonly end: number;
}

/**
 * Source spans of every unclosed ［＃, in document order — the single "what is broken" answer the
 * editor diagnostics consume, re-derived from {@link tokenize} itself so it can never disagree
 * with what the renderer shows. Offsets are recovered by accumulating `raw.length` (the
 * concatenation of all raws IS the source), the same convention every token consumer uses.
 */
export function findBrokenAnnotations(src: string): BrokenAnnotation[] {
  const spans: BrokenAnnotation[] = [];
  let offset = 0;
  for (const token of tokenize(src)) {
    if (token.kind === 'brokenAnnotation') {
      spans.push({ start: offset, end: offset + token.raw.length });
    }
    offset += token.raw.length;
  }
  return spans;
}

// Unpaired span directives (Warning diagnostics) and their closers (the .txt seam)

/**
 * The cross-line span slots buildRows keeps — one INDEPENDENT slot per channel, never a stack: a
 * start replaces a still-open same-channel start (last-wins), an end clears its channel whatever
 * its form, channels overlap freely. Block-capable channels first: the `.txt` seam's order.
 */
export type SpanChannel = Channel | 'heading' | 'indent';
const SPAN_CHANNELS: readonly SpanChannel[] = ['indent', 'weight', 'style', 'heading', 'emph', 'line'];

/** A span opener still in effect at the end of input — what a `.txt` seam spells a closer for. */
export type SpanOpener = IndentBlockStartToken | EmphasisSpanStartToken | HeadingSpanStartToken;
type SpanCloser = IndentBlockEndToken | EmphasisSpanEndToken | HeadingSpanEndToken;

/** The channel a span start/end drives; 'span' resolution covers the inline form's bare 左に prefix
 *  (the block form's 太字/斜体 carry none). 縦中横 is line-local: {@link findTcyIssues} owns it. */
function spanChannelOf(token: SpanOpener | SpanCloser): SpanChannel | null {
  switch (token.kind) {
    case 'indentBlockStart':
    case 'indentBlockEnd':
      return 'indent';
    case 'headingSpanStart':
    case 'headingSpanEnd':
      return 'heading';
    case 'emphasisSpanStart':
    case 'emphasisSpanEnd':
      return resolveStyle(token.variant, 'span')?.channel ?? null;
  }
}

/** True iff the annotation is a block form (ここから／ここで); the indent tokens carry no `block` flag. */
function isBlockForm(token: SpanOpener | SpanCloser): boolean {
  return token.kind === 'indentBlockStart' || token.kind === 'indentBlockEnd' || token.block === true;
}

interface OpenSpan {
  readonly token: SpanOpener;
  readonly start: number;
  readonly end: number;
}

/** Walks `src`'s span slots: `onDangling` sees every end with nothing open in its channel; the
 *  return is the openers still in effect at the end of input, in {@link SPAN_CHANNELS} order. */
function walkSpans(
  src: string,
  onDangling?: (token: SpanCloser, start: number, end: number) => void,
): OpenSpan[] {
  const open = new Map<SpanChannel, OpenSpan>();
  let offset = 0;
  for (const token of tokenize(src)) {
    const end = offset + token.raw.length;
    switch (token.kind) {
      case 'indentBlockStart':
      case 'emphasisSpanStart':
      case 'headingSpanStart': {
        const ch = spanChannelOf(token);
        if (ch !== null) {
          open.set(ch, { token, start: offset, end }); // last-wins
        }
        break;
      }
      case 'indentBlockEnd':
      case 'emphasisSpanEnd':
      case 'headingSpanEnd': {
        const ch = spanChannelOf(token);
        if (ch !== null && !open.delete(ch)) {
          onDangling?.(token, offset, end); // nothing was open in this channel
        }
        break;
      }
      default:
        break;
    }
    offset = end;
  }
  return SPAN_CHANNELS.flatMap((ch) => {
    const span = open.get(ch);
    return span === undefined ? [] : [span];
  });
}

/** An unpaired span directive as absolute source offsets; `kind` + `block` (its own form) pick the
 *  message code. */
export interface UnpairedSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: 'unterminated' | 'dangling';
  readonly block: boolean;
}

/**
 * Source spans of every span directive left unpaired — a start open at EOF, an end with nothing
 * open in its channel — in document order, re-derived from {@link tokenize} so the Warnings can
 * never disagree with the render (lenient: EOF auto-close, dangling no-op). The ONLY error surface
 * for spans, a Warning vs the unclosed-［＃ Error of {@link findBrokenAnnotations}; inline and
 * block forms pair alike, `block` only picks the message.
 */
export function findUnpairedSpans(src: string): UnpairedSpan[] {
  const spans: UnpairedSpan[] = [];
  const open = walkSpans(src, (token, start, end) => {
    spans.push({ start, end, kind: 'dangling', block: isBlockForm(token) });
  });
  for (const s of open) {
    spans.push({ start: s.start, end: s.end, kind: 'unterminated', block: isBlockForm(s.token) });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** The span openers still in effect at the end of `src`, in {@link SPAN_CHANNELS} order — what a
 *  `.txt` chapter seam must close ({@link closingAnnotation}). */
export function unterminatedOpeners(src: string): SpanOpener[] {
  return walkSpans(src).map((s) => s.token);
}

/**
 * The annotation that closes `opener`'s channel, the inverse of {@link classifyAnnotation}: the
 * ここで form for the channels that have one (字下げ／太字／斜体／見出し — a block-directive line paints
 * no column), the inline ［＃…終わり］ for 傍点/傍線. `block` says which, for placement.
 */
export function closingAnnotation(opener: SpanOpener): { readonly text: string; readonly block: boolean } {
  switch (opener.kind) {
    case 'indentBlockStart':
      return { text: annotation(`${BLOCK_TO}${INDENT_SUFFIX}${SPAN_END_SUFFIX}`), block: true };
    case 'headingSpanStart':
      return { text: annotation(`${BLOCK_TO}${headingLiteralOf(opener.level)}${SPAN_END_SUFFIX}`), block: true };
    case 'emphasisSpanStart': {
      const block = hasBlockForm(opener.variant);
      return { text: annotation(`${block ? BLOCK_TO : ''}${opener.variant}${SPAN_END_SUFFIX}`), block };
    }
  }
}

// 縦中横 structural issues (Warning diagnostics)

/** A structural 縦中横 problem as absolute source offsets. `kind` picks the message code. */
export interface TcyIssue {
  readonly start: number;
  readonly end: number;
  readonly kind: 'unterminated' | 'dangling' | 'tooLong';
}

/** Combined cells squish visibly beyond this many code points (measured in headless Chrome). */
const TCY_MAX = 3;

/**
 * Source spans of every structural 縦中横 problem, re-derived from {@link tokenize} so the
 * Warnings can never disagree with the (always lenient) render: `unterminated` = no 終わり
 * before the line end (range = the opener), `dangling` = a 終わり with no open span, `tooLong`
 * = content over {@link TCY_MAX} composed code points ({@link composeKana}, as painted; the span
 * form covers its content, the postfix form its annotation). Pairing is LINE-local and the
 * content accounting mirrors buildRows' accumulator exactly.
 */
export function findTcyIssues(src: string): TcyIssue[] {
  const issues: TcyIssue[] = [];
  let open: { start: number; end: number } | null = null; // the ［＃縦中横］ annotation span
  let contentStart = 0;
  let contentEnd = 0;
  let content = ''; // the span's text; composed as one string when counted, like the render's buffer

  const reportTooLong = (): void => {
    if (Array.from(composeKana(content)).length > TCY_MAX) {
      issues.push({ start: contentStart, end: contentEnd, kind: 'tooLong' });
    }
  };
  const closeAsUnterminated = (): void => {
    if (open !== null) {
      issues.push({ start: open.start, end: open.end, kind: 'unterminated' });
      reportTooLong();
      open = null;
    }
  };

  let offset = 0;
  for (const token of tokenize(src)) {
    const end = offset + token.raw.length;
    switch (token.kind) {
      case 'tcySpanStart':
        if (open === null) {
          open = { start: offset, end };
          contentStart = end;
          contentEnd = end;
          content = '';
        }
        break;
      case 'tcySpanEnd':
        if (open !== null) {
          reportTooLong();
          open = null;
        } else {
          issues.push({ start: offset, end, kind: 'dangling' });
        }
        break;
      case 'tcyPostfix':
        if (Array.from(composeKana(token.target)).length > TCY_MAX) {
          issues.push({ start: offset, end, kind: 'tooLong' });
        }
        break;
      case 'text':
        if (open !== null) {
          const parts = splitLines(token.text);
          const part = parts[0] ?? '';
          content += part;
          contentEnd = offset + part.length;
          if (parts.length > 1) {
            closeAsUnterminated(); // the line break auto-closes the span (line-local)
          }
        }
        break;
      case 'rubyImplicit':
      case 'rubyStart':
      case 'rubyEnd':
      case 'brokenAnnotation':
        if (open !== null) {
          content += token.raw;
          contentEnd = end;
        }
        break;
      case 'valueField':
        // Bookless length: the editor compile renders the name; a cover or furniture build
        // may run longer.
        if (open !== null) {
          content += token.name;
          contentEnd = end;
        }
        break;
      default:
        break; // other annotations add no cell content and never contain a line break
    }
    offset = end;
  }
  closeAsUnterminated(); // an open span at EOF closes with its (last) line
  return issues;
}

// Ruby markup that made no ruby (Warning diagnostics)

/**
 * Source spans of every 《…》 that made no ruby, in document order — derived by RUNNING
 * {@link tokenize} itself, so the Warning surface can never disagree with what the render prints.
 */
export function findRubyIssues(src: string): RubyIssue[] {
  const issues: RubyIssue[] = [];
  tokenize(src, { issues });
  return issues;
}

// Implicit ruby-base detection

/**
 * Implicit ruby base (no ｜ marker): the MAXIMAL run of ONE character class — kanji, hiragana,
 * katakana, or alnum of either width — ending at the 《; the last character's class fixes the
 * run and anything else (a class change, whitespace, punctuation, ［) terminates it. A combining
 * 濁点/半濁点 that composes with the kana before it (an NFD が) shares that kana's class.
 */
type CharClass = 'kanji' | 'hiragana' | 'katakana' | 'alnum' | null;

/**
 * Kanji: CJK Unified Ideographs (+ extensions) plus 々〆〇ヶ — the spec treats 「仝々〆〇ヶ」 as
 * kanji for the ｜ rule (仝 U+4EDD already sits in the unified block).
 * https://www.aozora.gr.jp/annotation/etc.html#ruby
 */
function isKanji(cp: number): boolean {
  return isCjkIdeograph(cp) || cp === 0x3005 || cp === 0x3006 || cp === 0x3007 || cp === 0x30f6; // 々〆〇ヶ
}

/** Hiragana block (U+3041..U+3096); the small ヶ is intentionally NOT hiragana. */
export function isHiragana(cp: number): boolean {
  return cp >= 0x3041 && cp <= 0x3096;
}

/** Katakana (U+30A1..U+30FA) plus the prolonged-sound mark ー (U+30FC). */
export function isKatakana(cp: number): boolean {
  // ヶ (U+30F6) is classed as kanji above, so exclude it here.
  if (cp === 0x30f6) {
    return false;
  }
  return (cp >= 0x30a1 && cp <= 0x30fa) || cp === 0x30fc;
}

/** ASCII and full-width Latin letters + digits, as a single class. */
function isAlnum(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) || // 0-9
    (cp >= 0x41 && cp <= 0x5a) || // A-Z
    (cp >= 0x61 && cp <= 0x7a) || // a-z
    (cp >= 0xff10 && cp <= 0xff19) || // ０-９
    (cp >= 0xff21 && cp <= 0xff3a) || // Ａ-Ｚ
    (cp >= 0xff41 && cp <= 0xff5a) // ａ-ｚ
  );
}

/** Class of a single code-point string (`''` and non-base chars => null). */
function classOf(ch: string | undefined): CharClass {
  const cp = ch?.codePointAt(0);
  if (cp === undefined) {
    return null;
  }
  if (isKanji(cp)) {
    return 'kanji';
  }
  if (isHiragana(cp)) {
    return 'hiragana';
  }
  if (isKatakana(cp)) {
    return 'katakana';
  }
  if (isAlnum(cp)) {
    return 'alnum';
  }
  return null;
}

export function detectImplicitBase(textBefore: string): { base: string; rest: string } {
  // Work in code points so astral kanji (SIP) are single units. The slices stay verbatim (the
  // offset consumers count source units): an NFD mark only borrows its kana's class.
  const chars = Array.from(textBefore);
  const classes: CharClass[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? '';
    const prev = classes[i - 1];
    const joins =
      (prev === 'hiragana' || prev === 'katakana') &&
      isCombiningKanaMark(ch.codePointAt(0) ?? 0) &&
      composeKana((chars[i - 1] ?? '') + ch).length === 1;
    classes.push(joins ? prev : classOf(ch));
  }
  const lastClass = classes[classes.length - 1] ?? null;
  if (lastClass === null) {
    // Empty, or a trailing char that is not a ruby-base character (space,
    // punctuation, ］, …): there is no implicit base.
    return { base: '', rest: textBefore };
  }

  let start = chars.length;
  while (start > 0 && classes[start - 1] === lastClass) {
    start -= 1;
  }

  return {
    base: chars.slice(start).join(''),
    rest: chars.slice(0, start).join(''),
  };
}
