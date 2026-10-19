/**
 * Sentence segmentation over one line's {@link ProseView} — the engine-level boundary definition
 * shared by every sentence-based rule (sentenceLength, maxTen), so their reported positions can
 * never drift apart.
 *
 * A sentence ends at a run of terminators 。！？ (half-width !? and ‼⁇⁈⁉ included),
 * absorbing any closing brackets right after it, or at the end of the view (a line IS a paragraph;
 * nothing continues across a line break). The '\n' separator unit of a dialogue view is a hard
 * boundary. Leading whitespace is not part of a sentence; … and dashes do not terminate (a
 * trailing …… simply leaves the sentence open until the line ends).
 */
import { charClass } from '../../shared/utils/regex.ts';

import type { ProseView } from './types.ts';

/** Half-open `[start, end)` index range into the view this sentence covers. */
interface SentenceSpan {
  readonly start: number;
  readonly end: number;
}

/** The ！？ marks that end a sentence: either width, and the characters that hold two of them. */
export const SENTENCE_MARKS = new Set(['！', '？', '!', '?', '‼', '⁇', '⁈', '⁉']);
/** What ends a sentence. Exported with {@link SENTENCE_MARKS} so format.ts derives its sets from
 *  the same marks. */
export const TERMINATORS = new Set(['。', ...SENTENCE_MARKS]);
/** Closers absorbed into the sentence right after its terminator run (〜。」 stays one sentence).
 *  Exported as THE closing-bracket set of the rule layer — format.ts derives its line-end and
 *  after-！？ sets from it, so the three closer sets can never drift apart again. */
export const CLOSERS = new Set(['」', '』', '）', ')', '】', '〉', '》', '］', '”', '’']);
const WHITESPACE = new Set([' ', '　', '\t', '\n']);

/** One sentence after any whitespace: the body up to a terminator or '\n', the terminator run, the
 *  closers. Every member is one UTF-16 unit, so without the `u` flag the classes step like `charAt`. */
const SENTENCE = new RegExp(
  `[${charClass(WHITESPACE)}]*([^\n${charClass(TERMINATORS)}]*[${charClass(TERMINATORS)}]*[${charClass(CLOSERS)}]*)`,
  'y',
);

export function splitSentences(view: ProseView): readonly SentenceSpan[] {
  const text = view.text;
  const out: SentenceSpan[] = [];
  SENTENCE.lastIndex = 0;
  while (SENTENCE.lastIndex < text.length) {
    const sentence = SENTENCE.exec(text)?.[1];
    // Only trailing whitespace leaves the sentence empty, and an empty match never advances.
    if (sentence === undefined || sentence.length === 0) {
      break;
    }
    out.push({ start: SENTENCE.lastIndex - sentence.length, end: SENTENCE.lastIndex });
  }
  return out;
}
