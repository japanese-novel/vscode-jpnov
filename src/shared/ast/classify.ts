/**
 * Classifies one closed ［＃…］ into its annotation node, with the span of every part inside it.
 * Recognition is literal and identical to the tmLanguage patterns: whether a span pairs, a
 * postfix binds or an indent applies is the resolver's call.
 *
 * Pure + vscode-free.
 */
import type { AnnotationNode, GaijiNode, Part, RolePart, ScanIssue } from './nodes.ts';
import {
  ANNOTATION_CLOSE,
  ANNOTATION_OPEN,
  BLOCK_FROM,
  BLOCK_TO,
  CONNECTOR_HA,
  CONNECTOR_NI,
  CORNER_CLOSE,
  CORNER_OPEN,
  GAIJI_MARK,
  INDENT,
  LEFT_LONG,
  LEFT_RUBY,
  PAGE_BREAK,
  SPAN_END,
  TCY,
  VALUE_HERE,
  VALUE_SHOW,
  hasBlockForm,
  headingLevelOf,
  indentAmount,
  variantStyle,
} from './notation.ts';
import type { Channel, VariantStyle } from './notation.ts';
import { Cutter } from './parts.ts';

/**
 * The connector a postfix of `channel` takes: 傍点/傍線 take に or none (「対象」傍点, and
 * の左に in its place), 太字/斜体 require は. Any other pairing is a comment.
 */
function connectorMatches(family: 'ni' | 'ha' | null, channel: Channel): boolean {
  if (channel === 'weight' || channel === 'style') {
    return family === 'ha';
  }
  return family === 'ni' || family === null;
}

/** The decoration fields a styled node carries: the style without its spelling. */
function styled({ variant, left, channel }: VariantStyle): Omit<VariantStyle, 'prefix'> {
  return { variant, left, channel };
}

/** The style a ここから／ここで form names: a variant that has a block form, or null. */
function blockStyle(name: string): VariantStyle | null {
  return hasBlockForm(name) ? variantStyle(name) : null;
}

/** The 外字注記 at `[start, end)` of `src`, from its ※ to its ］, standing for `char`. */
export function gaijiNode(src: string, start: number, end: number, char: string): GaijiNode {
  const cut = new Cutter(src, start);
  cut.take('bracket', GAIJI_MARK.length);
  cut.take('bracket', ANNOTATION_OPEN.length);
  cut.take('keyword', end - start - GAIJI_MARK.length - ANNOTATION_OPEN.length - ANNOTATION_CLOSE.length);
  cut.take('bracket', ANNOTATION_CLOSE.length);
  return { kind: 'gaiji', span: { start, end }, text: src.slice(start, end), parts: cut.parts, char };
}

/**
 * The annotation at `[start, end)` of `src` (`［＃` … `］` inclusive). A 字下げ above the
 * notation's maximum is a comment, and is reported to `issues`.
 */
export function classifyAnnotation(src: string, start: number, end: number, issues: ScanIssue[]): AnnotationNode {
  const span = { start, end };
  const text = src.slice(start, end);
  const inner = src.slice(start + ANNOTATION_OPEN.length, end - ANNOTATION_CLOSE.length);

  // A form is recognized before anything of it is cut, so whatever falls through is cut whole.
  const cut = new Cutter(src, start);
  cut.take('bracket', ANNOTATION_OPEN.length);
  /** Closes the node: the rest of the inner must already be cut. */
  const close = (): readonly RolePart[] => {
    cut.take('bracket', ANNOTATION_CLOSE.length);
    return cut.parts;
  };
  /** Anything unrecognized: the whole inner as one part. */
  const comment = (): AnnotationNode => {
    const part = cut.take('inner', inner.length);
    return { kind: 'comment', span, text, parts: close(), inner: part };
  };
  /** The indent count `s` spells; one above the maximum is reported and is none. */
  const indentOf = (s: string): number | null => {
    const amount = indentAmount(s);
    if (amount === 'tooLarge') {
      issues.push({ kind: 'indentTooLarge', span });
      return null;
    }
    return amount;
  };

  if (inner === PAGE_BREAK) {
    cut.take('keyword', PAGE_BREAK.length);
    return { kind: 'pageBreak', span, text, parts: close() };
  }

  // Value display ［＃ここに「名前」の値を表示］ — any non-empty name up to the closing scaffold.
  const valueOpen = VALUE_HERE + CORNER_OPEN;
  const valueClose = CORNER_CLOSE + VALUE_SHOW;
  if (inner.startsWith(valueOpen) && inner.endsWith(valueClose) && inner.length > valueOpen.length + valueClose.length) {
    cut.take('scaffold', VALUE_HERE.length);
    cut.take('corner', CORNER_OPEN.length);
    const name = cut.take('name', inner.length - valueOpen.length - valueClose.length);
    cut.take('corner', CORNER_CLOSE.length);
    cut.take('scaffold', VALUE_SHOW.length);
    return { kind: 'valueField', span, text, parts: close(), name };
  }

  // Corner-target postfix ［＃「対象」…］; the target is never empty.
  if (inner.startsWith(CORNER_OPEN)) {
    const cornerClose = inner.indexOf(CORNER_CLOSE, CORNER_OPEN.length);
    if (cornerClose === -1 || cornerClose === CORNER_OPEN.length) {
      return comment();
    }
    let rest = inner.slice(cornerClose + CORNER_CLOSE.length);

    // A single に / は is the connector; の is none (の左に is the direction prefix, taken whole).
    let family: 'ni' | 'ha' | null = null;
    /** Cuts 「対象」 with the connector after it, and returns the target. */
    const head = (): Part => {
      cut.take('corner', CORNER_OPEN.length);
      const target = cut.take('target', cornerClose - CORNER_OPEN.length);
      cut.take('corner', CORNER_CLOSE.length);
      if (family !== null) {
        cut.take('connector', (family === 'ha' ? CONNECTOR_HA : CONNECTOR_NI).length);
      }
      return target;
    };

    // 左ルビ ［＃「対象」の左に「よみ」のルビ］ — before the connector strip (its の is no connector).
    const leftOpen = LEFT_LONG + CORNER_OPEN;
    const leftClose = CORNER_CLOSE + LEFT_RUBY;
    if (rest.startsWith(leftOpen) && rest.endsWith(leftClose)) {
      const length = rest.length - leftOpen.length - leftClose.length;
      const written = rest.slice(leftOpen.length, leftOpen.length + length);
      if (written === '' || written.includes(CORNER_OPEN) || written.includes(CORNER_CLOSE)) {
        return comment();
      }
      const target = head();
      cut.take('direction', LEFT_LONG.length);
      cut.take('corner', CORNER_OPEN.length);
      const reading = cut.take('reading', length);
      cut.take('corner', CORNER_CLOSE.length);
      cut.take('keyword', LEFT_RUBY.length);
      return { kind: 'rubyLeftPostfix', span, text, parts: close(), target, reading };
    }

    if (rest.startsWith(CONNECTOR_HA)) {
      family = 'ha';
      rest = rest.slice(CONNECTOR_HA.length);
    } else if (rest.startsWith(CONNECTOR_NI)) {
      family = 'ni';
      rest = rest.slice(CONNECTOR_NI.length);
    }
    if (rest === TCY) {
      if (family !== 'ha') {
        return comment();
      }
      const target = head();
      cut.take('keyword', TCY.length);
      return { kind: 'tcyPostfix', span, text, parts: close(), target };
    }
    const level = headingLevelOf(rest);
    if (level !== null) {
      if (family !== 'ha') {
        return comment();
      }
      const target = head();
      cut.take('keyword', rest.length);
      return { kind: 'headingPostfix', span, text, parts: close(), target, level };
    }
    const style = variantStyle(rest, family === null ? 'postfix' : 'none');
    if (style === null || !connectorMatches(family, style.channel)) {
      return comment();
    }
    const target = head();
    cut.take('direction', style.prefix);
    cut.take('keyword', rest.length - style.prefix);
    return { kind: 'emphasisPostfix', span, text, parts: close(), target, ...styled(style) };
  }

  // Block END ［＃ここで X終わり］ — before the block start and the inline span end.
  if (inner.startsWith(BLOCK_TO) && inner.endsWith(SPAN_END)) {
    const mid = inner.slice(BLOCK_TO.length, inner.length - SPAN_END.length);
    const parts = (): readonly RolePart[] => {
      cut.take('scaffold', BLOCK_TO.length);
      cut.take('keyword', mid.length);
      cut.take('scaffold', SPAN_END.length);
      return close();
    };
    if (mid === INDENT) {
      return { kind: 'indentBlockEnd', span, text, parts: parts() };
    }
    const style = blockStyle(mid);
    if (style !== null) {
      return { kind: 'emphasisSpanEnd', span, text, parts: parts(), ...styled(style), block: true };
    }
    const level = headingLevelOf(mid);
    if (level !== null) {
      return { kind: 'headingSpanEnd', span, text, parts: parts(), level, block: true };
    }
    return comment(); // ここで傍点終わり: 傍点/傍線 have no block form
  }

  // Block START ［＃ここから X］.
  if (inner.startsWith(BLOCK_FROM)) {
    const body = inner.slice(BLOCK_FROM.length);
    const parts = (): readonly RolePart[] => {
      cut.take('scaffold', BLOCK_FROM.length);
      cut.take('keyword', body.length);
      return close();
    };
    const amount = indentOf(body);
    if (amount !== null) {
      return { kind: 'indentBlockStart', span, text, parts: parts(), amount };
    }
    const style = blockStyle(body);
    if (style !== null) {
      return { kind: 'emphasisSpanStart', span, text, parts: parts(), ...styled(style), block: true };
    }
    const level = headingLevelOf(body);
    if (level !== null) {
      return { kind: 'headingSpanStart', span, text, parts: parts(), level, block: true };
    }
    return comment(); // ここから傍点 / ここから…折り返して…
  }

  // Inline span END ［＃傍点終わり／左に傍線終わり／太字終わり／縦中横終わり／大見出し終わり］.
  if (inner.endsWith(SPAN_END)) {
    const name = inner.slice(0, inner.length - SPAN_END.length);
    if (name === TCY) {
      cut.take('keyword', TCY.length);
      cut.take('scaffold', SPAN_END.length);
      return { kind: 'tcySpanEnd', span, text, parts: close() };
    }
    const style = variantStyle(name, 'span');
    if (style !== null) {
      cut.take('direction', style.prefix);
      cut.take('keyword', name.length - style.prefix);
      cut.take('scaffold', SPAN_END.length);
      return { kind: 'emphasisSpanEnd', span, text, parts: close(), ...styled(style) };
    }
    const level = headingLevelOf(name);
    if (level !== null) {
      cut.take('keyword', name.length);
      cut.take('scaffold', SPAN_END.length);
      return { kind: 'headingSpanEnd', span, text, parts: close(), level };
    }
    return comment();
  }

  // Single-line ［＃○字下げ］: N full-width spaces where it stands (the resolver emits them).
  const amount = indentOf(inner);
  if (amount !== null) {
    cut.take('keyword', inner.length);
    return { kind: 'indent', span, text, parts: close(), amount };
  }

  if (inner === TCY) {
    cut.take('keyword', TCY.length);
    return { kind: 'tcySpanStart', span, text, parts: close() };
  }

  const style = variantStyle(inner, 'span');
  if (style !== null) {
    cut.take('direction', style.prefix);
    cut.take('keyword', inner.length - style.prefix);
    return { kind: 'emphasisSpanStart', span, text, parts: close(), ...styled(style) };
  }

  const level = headingLevelOf(inner);
  if (level !== null) {
    cut.take('keyword', inner.length);
    return { kind: 'headingSpanStart', span, text, parts: close(), level };
  }

  return comment();
}
