/**
 * The dialogue stack: where an utterance 「…」／『…』 starts and ends. One rule, read by the lint
 * walker and the highlighter alike, so that a character can never be dialogue to one and
 * 地の文 to the other.
 *
 * Only prose feeds the stack — the prose runs of the AST's content, as shown, for the lint
 * walker and the highlighter (shown.ts) alike: ［＃「対象」に傍点］ carries its 「対象」 inside an
 * annotation node, and a 「 swallowed by an unclosed ［＃ is a brokenAnnotation, so neither can
 * open an utterance (the Aozora trap). An opener always pushes; a closer pops only when it
 * matches the top; a mismatched closer is ordinary prose. The stack is document-scoped: an
 * utterance may span lines.
 *
 * Offsets are UTF-16 units, as `TextDocument.positionAt` counts them.
 */
import { CORNERS } from '../shared/chars.ts';

/** The closer each opener expects. */
const CLOSER_OF: Record<string, '」' | '』'> = { '「': '」', '『': '』' };

/**
 * One stretch of a prose node: plain prose, an opening corner, or a stack-matched closing
 * corner (a mismatched closer is prose). `depth` is the nesting OUTSIDE the stretch: for prose
 * where it sits, for a corner the utterance the corner belongs to — 0 means the corner opens or
 * closes a top-level utterance and is 地の文.
 */
export interface DialogueSegment {
  readonly kind: 'prose' | 'open' | 'close';
  /** `[from, to)` in the node's text. */
  readonly from: number;
  readonly to: number;
  readonly depth: number;
}

/** The dialogue stack of one document, fed the prose nodes in source order. */
export class DialogueStack {
  /** The closers still expected, innermost last. */
  private readonly stack: ('」' | '』')[] = [];
  /** The scan cursor of `feed`; the stack's own, as its state is. */
  private readonly corners = new RegExp(`[${CORNERS}]`, 'g');

  /** The current nesting depth. */
  get depth(): number {
    return this.stack.length;
  }

  /** Splits a prose node's text into segments, advancing the stack. */
  feed(text: string): DialogueSegment[] {
    const { stack, corners } = this;
    const out: DialogueSegment[] = [];
    let from = 0;
    corners.lastIndex = 0;
    for (let m = corners.exec(text); m !== null; m = corners.exec(text)) {
      const closer = CLOSER_OF[m[0]];
      if (closer === undefined && m[0] !== stack[stack.length - 1]) {
        continue; // a mismatched closer stays in the prose stretch
      }
      if (m.index > from) {
        out.push({ kind: 'prose', from, to: m.index, depth: stack.length });
      }
      if (closer !== undefined) {
        out.push({ kind: 'open', from: m.index, to: m.index + 1, depth: stack.length });
        stack.push(closer);
      } else {
        stack.pop();
        out.push({ kind: 'close', from: m.index, to: m.index + 1, depth: stack.length });
      }
      from = m.index + 1;
    }
    if (from < text.length) {
      out.push({ kind: 'prose', from, to: text.length, depth: stack.length });
    }
    return out;
  }
}
