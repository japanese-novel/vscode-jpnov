/**
 * Plans how one editor line is "typed" on the stage, one step per keystroke: Enter starts the row
 * with the auto-indent space (jpnov.editor.autoIndent), an opening bracket auto-closes
 * (jpnov.language-configuration.json) so its closer appears at once and typing over it only moves
 * the caret, and a line opened with 「 loses the auto-indent space. Indices count code points, as
 * the per-character spans do.
 */

const PAIRS: Readonly<Record<string, string>> = {
  '「': '」', '『': '』', '（': '）', '［': '］', '《': '》', '【': '】', '〈': '〉', '〔': '〕',
};

/** The timeline's keystroke groups: beat 1 types three lines, beat 2 an annotation. */
export type TypingRun = 'write' | 'check';

export interface TypedChar {
  /** Character index in the line. */
  readonly index: number;
  /** The keystroke that puts the caret after this character. */
  readonly k: number;
  /** The keystroke at which the character becomes visible (earlier than `k` for an auto-closed closer). */
  readonly show: number;
}

export interface TypedPlan {
  readonly chars: readonly TypedChar[];
  /** Enter's keystroke (the row appears); absent when the line already exists. */
  readonly rowShow?: number;
  /** An auto-indent space that Enter inserts and the opening 「 removes: shown/dropped keystrokes. */
  readonly phantom?: { readonly show: number; readonly drop: number };
  /** The next free keystroke number. */
  readonly next: number;
}

/** One line's typed range on the motion window: its plan and the beat it belongs to. */
export interface TypedSpec {
  readonly plan: TypedPlan;
  readonly run: TypingRun;
}

export function planTyping(chars: readonly string[], from: number, to: number, kStart: number, enter: boolean): TypedPlan {
  const typed: TypedChar[] = [];
  const early = new Map<number, number>();
  let k = kStart;
  let start = from;
  let rowShow: number | undefined;
  let phantom: TypedPlan['phantom'];
  if (enter) {
    rowShow = k;
    if (chars[from] === '　') {
      typed.push({ index: from, k, show: k });
      start = from + 1;
    } else {
      phantom = { show: k, drop: k + 1 };
    }
    k++;
  }
  for (let i = start; i < to; i++) {
    const shownAt = early.get(i);
    typed.push({ index: i, k, show: shownAt ?? k });
    const closer = PAIRS[chars[i] ?? ''];
    if (shownAt === undefined && closer !== undefined) {
      const j = chars.indexOf(closer, i + 1);
      if (j !== -1 && j < to) {
        early.set(j, k);
      }
    }
    k++;
  }
  const plan: { -readonly [K in keyof TypedPlan]: TypedPlan[K] } = { chars: typed, next: k };
  if (rowShow !== undefined) {
    plan.rowShow = rowShow;
  }
  if (phantom !== undefined) {
    plan.phantom = phantom;
  }
  return plan;
}
