/**
 * The notation's spellings: the markers, the keywords, the decoration variants and the value
 * names, with the spellers that compose an annotation from its meaning.
 *
 * A leaf: it imports types only. Pure + vscode-free.
 */
import type { HeadingLevel, Mark, SpanChannel, SpanCloserNode, SpanOpenerNode, ValueLookup } from './nodes.ts';

// Full-width annotation and ruby markers (https://www.aozora.gr.jp/annotation/etc.html).
export const ANNOTATION_OPEN = '［＃';
export const ANNOTATION_CLOSE = '］';
export const RUBY_OPEN = '《';
export const RUBY_CLOSE = '》';
export const BASE_MARK = '｜';
export const CORNER_OPEN = '「';
export const CORNER_CLOSE = '」';

export const PAGE_BREAK = '改ページ';
export const SPAN_END = '終わり';
export const CONNECTOR_NI = 'に';
export const CONNECTOR_HA = 'は';
export const BLOCK_FROM = 'ここから';
export const BLOCK_TO = 'ここで';
export const INDENT = '字下げ';
export const TCY = '縦中横';
export const LEFT_RUBY = 'のルビ';
export const VALUE_HERE = 'ここに';
export const VALUE_SHOW = 'の値を表示';

/** The left-side prefixes, fixed by form: a postfix says の左に, a span says 左に
 *  (https://www.aozora.gr.jp/annotation/emphasis.html). */
export const LEFT_LONG = 'の左に';
export const LEFT_SHORT = '左に';

/** The four decoration channels; they are independent, so all four can sit on one character. */
export const CHANNELS = ['emph', 'line', 'weight', 'style'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Every decoration variant and the channel it drives; ばつ傍点 and ×傍点 are one style. */
export const EMPHASIS_VARIANTS = {
  傍点: 'emph',
  白ゴマ傍点: 'emph',
  丸傍点: 'emph',
  白丸傍点: 'emph',
  二重丸傍点: 'emph',
  蛇の目傍点: 'emph',
  黒三角傍点: 'emph',
  白三角傍点: 'emph',
  ばつ傍点: 'emph',
  '×傍点': 'emph',
  傍線: 'line',
  二重傍線: 'line',
  鎖線: 'line',
  破線: 'line',
  波線: 'line',
  太字: 'weight',
  斜体: 'style',
} as const satisfies Record<string, Channel>;

export type EmphasisVariant = keyof typeof EMPHASIS_VARIANTS;

/** Which left prefix a variant may carry; `none` takes neither (a block form, or a postfix whose
 *  に/は was already taken). */
export type DirectionForm = 'postfix' | 'span' | 'none';

/** A variant spelling resolved: its mark (the table key, the side) and its channel. */
export interface VariantStyle extends Mark {
  readonly channel: Channel;
  /** UTF-16 length of the left prefix in the spelling; 0 without one. */
  readonly prefix: number;
}

function isVariant(name: string): name is EmphasisVariant {
  return Object.hasOwn(EMPHASIS_VARIANTS, name);
}

/**
 * The style a variant spelling names under `form`, or null. The left side exists for 傍点/傍線
 * only, and only in the form's own prefix spelling.
 */
export function variantStyle(spelling: string, form: DirectionForm = 'none'): VariantStyle | null {
  const prefix = form === 'postfix' ? LEFT_LONG : form === 'span' ? LEFT_SHORT : null;
  const left = prefix !== null && spelling.startsWith(prefix);
  const name = left ? spelling.slice(prefix.length) : spelling;
  if (!isVariant(name)) {
    return null;
  }
  if (left && !hasLeftSide(name)) {
    return null;
  }
  return { variant: name, left, channel: EMPHASIS_VARIANTS[name], prefix: left ? prefix.length : 0 };
}

/** True iff `variant` may sit on the left side: 傍点 and 傍線. */
export function hasLeftSide(variant: string): boolean {
  return isVariant(variant) && (EMPHASIS_VARIANTS[variant] === 'emph' || EMPHASIS_VARIANTS[variant] === 'line');
}

/** True iff `variant` has a ここから／ここで form: 太字 and 斜体 only. */
export function hasBlockForm(variant: string): boolean {
  return isVariant(variant) && (EMPHASIS_VARIANTS[variant] === 'weight' || EMPHASIS_VARIANTS[variant] === 'style');
}

/** The slot a span start or end drives: its decoration channel, the heading, or the block indent. */
export function spanChannel(node: SpanOpenerNode | SpanCloserNode): SpanChannel {
  switch (node.kind) {
    case 'indentBlockStart':
    case 'indentBlockEnd':
      return 'indent';
    case 'headingSpanStart':
    case 'headingSpanEnd':
      return 'heading';
    case 'emphasisSpanStart':
    case 'emphasisSpanEnd':
      return node.channel;
  }
}

/** The mark a decoration spells: its variant, with 左に before a left-side one. */
export function markOf(node: { readonly variant: string; readonly left: boolean }): string {
  return `${node.left ? LEFT_SHORT : ''}${node.variant}`;
}

/** What a span start or end names, as its keyword: ２字下げ (字下げ for the end), 太字, 左に傍線, 大見出し. */
export function spanMark(node: SpanOpenerNode | SpanCloserNode): string {
  switch (node.kind) {
    case 'indentBlockStart':
      return `${fullWidthDigits(node.amount)}${INDENT}`;
    case 'indentBlockEnd':
      return INDENT;
    case 'headingSpanStart':
    case 'headingSpanEnd':
      return headingLiteralOf(node.level);
    case 'emphasisSpanStart':
    case 'emphasisSpanEnd':
      return markOf(node);
  }
}

/** The three 見出し literals; level = index + 1 (https://www.aozora.gr.jp/annotation/heading.html). */
export const HEADING_LITERALS = ['大見出し', '中見出し', '小見出し'] as const;

/** The heading level `s` names, or null. */
export function headingLevelOf(s: string): HeadingLevel | null {
  const idx = (HEADING_LITERALS as readonly string[]).indexOf(s);
  return idx === -1 ? null : ((idx + 1) as HeadingLevel);
}

/** The inverse of {@link headingLevelOf}. */
export function headingLiteralOf(level: HeadingLevel): string {
  switch (level) {
    case 1:
      return HEADING_LITERALS[0];
    case 2:
      return HEADING_LITERALS[1];
    case 3:
      return HEADING_LITERALS[2];
  }
}

/** The value names the notation defines for ［＃ここに「…」の値を表示］. */
export const VALUE_NAMES = {
  title: 'タイトル',
  author: 'ペンネーム',
  totalPages: '総ページ数',
  sheets: '原稿用紙換算枚数',
  page: 'ページ番号',
} as const;

/** The default of each name of {@link VALUE_NAMES}: a text value reads as its name, a count as 0. */
export const VALUE_DEFAULTS = {
  title: VALUE_NAMES.title,
  author: VALUE_NAMES.author,
  totalPages: '0',
  sheets: '0',
  page: '0',
} as const satisfies Record<keyof typeof VALUE_NAMES, string>;

// A Map, not an object: the name comes from the document, where `toString` would hit
// Object.prototype.
const DEFAULT_BY_NAME: ReadonlyMap<string, string> = new Map(
  (Object.keys(VALUE_NAMES) as (keyof typeof VALUE_NAMES)[]).map((key) => [VALUE_NAMES[key], VALUE_DEFAULTS[key]]),
);

/**
 * The text ［＃ここに「name」の値を表示］ shows: the value `values` holds for `name`, else the
 * name's default, else — a name outside {@link VALUE_NAMES} — the name itself.
 */
export function valueOf(name: string, values: ValueLookup | undefined): string {
  return values?.get(name) ?? DEFAULT_BY_NAME.get(name) ?? name;
}

/** `inner` wrapped as a ［＃…］ annotation. */
export function annotation(inner: string): string {
  return `${ANNOTATION_OPEN}${inner}${ANNOTATION_CLOSE}`;
}

/** What a closed ［＃…］ holds between its brackets, verbatim: the inverse of {@link annotation}. */
export function innerOf(annotation: string): string {
  return annotation.slice(ANNOTATION_OPEN.length, annotation.length - ANNOTATION_CLOSE.length);
}

/** The end annotation of `mark`: ［＃ここでmark終わり］ in the block form, ［＃mark終わり］ in the inline one. */
export function endAnnotation(mark: string, block: boolean): string {
  return annotation(`${block ? BLOCK_TO : ''}${mark}${SPAN_END}`);
}

/** The value display annotation for `name`. */
export function valueAnnotation(name: string): string {
  return annotation(`${VALUE_HERE}${CORNER_OPEN}${name}${CORNER_CLOSE}${VALUE_SHOW}`);
}

/** The 縦中横 annotation naming `target`, written after it
 *  (https://www.aozora.gr.jp/annotation/etc.html#tatechu_yoko). */
export function tcyAnnotation(target: string): string {
  return annotation(`${CORNER_OPEN}${target}${CORNER_CLOSE}${CONNECTOR_HA}${TCY}`);
}

/** The mark a 外字注記 follows: the two together are one character
 *  (https://www.aozora.gr.jp/annotation/external_character.html). */
export const GAIJI_MARK = '※';

/** The 外字注記 that are read, by what the annotation holds, each with its character
 *  (https://www.aozora.gr.jp/gaiji_chuki/sonota.html). A 《 or 》 written this way is a bracket:
 *  only a typed one opens or closes a ruby. */
export const GAIJI = {
  '感嘆符二つ、1-8-75': '‼',
  '疑問符二つ、1-8-76': '⁇',
  '疑問符感嘆符、1-8-77': '⁈',
  '感嘆符疑問符、1-8-78': '⁉',
  '逆感嘆符、1-9-3': '¡',
  '逆疑問符、1-9-22': '¿',
  '始め二重山括弧、1-1-52': '《',
  '終わり二重山括弧、1-1-53': '》',
} as const;

// Maps, not the object: both keys come from the document.
const CHAR_BY_GAIJI: ReadonlyMap<string, string> = new Map(Object.entries(GAIJI));
const GAIJI_BY_CHAR: ReadonlyMap<string, string> = new Map(Object.entries(GAIJI).map(([inner, char]) => [char, inner]));

/** The character the 外字注記 holding `inner` stands for; undefined when it is not one of {@link GAIJI}. */
export function gaijiChar(inner: string): string | undefined {
  return CHAR_BY_GAIJI.get(inner);
}

/** The 外字注記 of `char`, its ※ included; undefined when {@link GAIJI} has none. */
export function gaijiAnnotation(char: string): string | undefined {
  const inner = GAIJI_BY_CHAR.get(char);
  return inner === undefined ? undefined : `${GAIJI_MARK}${annotation(inner)}`;
}

/** The largest 字下げ that is read; an annotation naming more is a comment. */
export const INDENT_MAX = 99;

/** `n` in full-width digits ０-９, the digits a 字下げ count is written in. */
export function fullWidthDigits(n: number): string {
  return String(n).replace(/[0-9]/g, (d) =>
    String.fromCharCode(0xff10 + d.charCodeAt(0) - 0x30),
  );
}

/** ［＃N字下げ］, its digits full-width: the only form that is read, for N up to {@link INDENT_MAX}. */
export function indentAnnotation(amount: number): string {
  return annotation(`${fullWidthDigits(amount)}${INDENT}`);
}

/**
 * The indent count of `s` = 「<digits>字下げ」, full-width digits ０-９ only; null otherwise. A
 * count above {@link INDENT_MAX} is 'tooLarge' whatever its length; leading zeros do not count.
 */
export function indentAmount(s: string): number | 'tooLarge' | null {
  if (!s.endsWith(INDENT)) {
    return null;
  }
  const digits = s.slice(0, s.length - INDENT.length);
  if (digits.length === 0) {
    return null;
  }
  let n = 0;
  for (let k = 0; k < digits.length; k += 1) {
    const cp = digits.charCodeAt(k);
    if (cp < 0xff10 || cp > 0xff19) {
      return null;
    }
    n = Math.min(n * 10 + (cp - 0xff10), INDENT_MAX + 1);
  }
  return n > INDENT_MAX ? 'tooLarge' : n;
}

export type ClosingAnnotations =
  | { readonly block: string; readonly inline?: string }
  | { readonly block?: undefined; readonly inline: string };

/**
 * The annotations that end `opener`'s span, in the forms its channel has: `block` the ここで form
 * (字下げ／太字／斜体／見出し), `inline` the ［＃…終わり］ one (every channel but the block 字下げ).
 */
export function closingAnnotations(opener: SpanOpenerNode): ClosingAnnotations {
  const spell = (name: string): { readonly block: string; readonly inline: string } => ({
    block: endAnnotation(name, true),
    inline: endAnnotation(name, false),
  });
  switch (opener.kind) {
    case 'indentBlockStart':
      return { block: spell(INDENT).block };
    case 'headingSpanStart':
      return spell(headingLiteralOf(opener.level));
    case 'emphasisSpanStart': {
      const forms = spell(markOf(opener));
      return hasBlockForm(opener.variant) ? forms : { inline: forms.inline };
    }
  }
}
