/**
 * Format rules — 原稿作法 checks over line shape. Each rule is one `(ctx) => LineRule` factory;
 * line-form exemptions (見出し, directive-only, blank, multi-line utterance, ornament/list lines)
 * come from the walker's flags and the helpers below.
 *
 * Relative imports only (native test loader); vscode-free.
 */
import { DASH_CHARS } from '../../../shared/chars.ts';

import { CLOSERS } from '../sentences.ts';
import type { LineRule, LintLine, ProseView, RuleContext } from '../types.ts';

import { maxOf, viewFix, viewSpan } from './adapt.ts';

/** Characters allowed to open a paragraph besides the 字下げ space. */
const LEADING_CHARS = '　「『（【〈';

/** Line-end characters that close 地の文: the real sentence enders plus EVERY closing bracket
 *  (a line ending on 】 or 〉 — a status line — ended as an inset, exactly like 」). Derived from
 *  the shared {@link CLOSERS} so the closer sets cannot drift. Deliberately WITHOUT … and the
 *  dashes — they trail a sentence but do not end it, so 「彼は黙った……」 in narration still
 *  wants its 。 (the fix appends one right after the run). */
const LINE_TERMINALS = new Set(['。', '！', '？', '!', '?', ...CLOSERS]);

/** What may follow a ！？ run without a full-width space: the closers (the quote ends), their
 *  ASCII/bracket kin, and a trailing …/dash run (！……、！―― set solid in practice). */
const AFTER_MARKS = new Set([
  '　', ...CLOSERS, '"', "'", ']', '〕', '｝', '}', '＞', '>', '…', '‥', ...DASH_CHARS,
]);

const EXCLAMATIONS = new Set(['！', '？', '!', '?']);
const FULL_TO_HALF: Record<string, string> = { '！': '!', '？': '?' };
const HALF_TO_FULL: Record<string, string> = { '!': '！', '?': '？' };

/** Skips a line no format rule should look at. */
function exempt(line: LintLine): boolean {
  return line.blank || line.directiveOnly || line.heading !== undefined;
}

/** True for a space-like unit (either width) — never a paragraph's first "real" character. */
function isSpace(ch: string): boolean {
  return ch === '　' || ch === ' ' || ch === '\t';
}

/** Any character that makes a line PROSE: kana, kanji, or alphanumerics of either width. */
const WORD_CHAR = /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}A-Za-z0-9Ａ-Ｚａ-ｚ０-９]/u;

/** A line of nothing but leaders/dashes (whitespace allowed) is a PAUSE — prose, not ornament:
 *  a silence paragraph reads as a sentence, so the strict convention gives it its 字下げ and 。
 *  (…… is not a sentence ender), exactly like any other narration line. */
const PAUSE_ONLY = new RegExp(`^[ \\t　…‥${[...DASH_CHARS].join('')}]+$`);

/** True for a hand-written ORNAMENT line — a scene break like ＊ or ◇＊◇ — which takes neither a
 *  字下げ nor a 句点 by convention. A pause line (…… / ―― only) is deliberately NOT one. */
function isDecoration(view: ProseView): boolean {
  return view.text !== '' && !WORD_CHAR.test(view.text) && !PAUSE_ONLY.test(view.text);
}

/** True for a bullet line (・ポーション×３ — a status-screen list): inset material, not a
 *  paragraph of 地の文, so it takes neither the 字下げ nor the 句点. */
function isListLine(view: ProseView): boolean {
  let k = 0;
  while (k < view.text.length && isSpace(view.text.charAt(k))) {
    k += 1;
  }
  return view.text.charAt(k) === '・';
}

/** 行頭字下げ: a 地の文 line must open with 　 / an opening bracket, or carry a ［＃字下げ］. The
 *  fix inserts the 　 before the first prose unit's markup (a ｜, a ［＃縦中横］) and after a
 *  line-head ［＃０字下げ］, which must stay at the head. */
export function indentRule(ctx: RuleContext): LineRule {
  return {
    line(line: LintLine): void {
      if (exempt(line) || line.indent >= 1) {
        return;
      }
      const v = line.prose();
      const first = v.units[0];
      // A continuation line of a multi-line utterance starts inside the quote — not a paragraph.
      if (first === undefined || first.depth > 0 || LEADING_CHARS.includes(v.text.charAt(0))) {
        return;
      }
      if (isDecoration(v) || isListLine(v)) {
        return;
      }
      ctx.report(viewSpan(v, 0, 1), { fix: { insert: first, side: 'before', text: '　' } });
    },
  };
}

/** 地の文は句点で終わる: the line's last prose character must be a terminal (or the line ends
 *  inside a multi-line utterance). The fix inserts 。 after that character and the markup wrapping
 *  it (a ruby's reading, ［＃…終わり］); it only adds, so a trailing 、 stays. */
export function endPeriodRule(ctx: RuleContext): LineRule {
  return {
    line(line: LintLine): void {
      if (exempt(line) || line.openDepthAtEnd > 0) {
        return;
      }
      const v = line.prose();
      if (isDecoration(v) || isListLine(v)) {
        return;
      }
      let k = v.text.length - 1;
      while (k >= 0 && isSpace(v.text.charAt(k))) {
        k -= 1;
      }
      if (k < 0 || LINE_TERMINALS.has(v.text.charAt(k))) {
        return;
      }
      const unit = v.units[k];
      if (unit === undefined) {
        return;
      }
      ctx.report(viewSpan(v, k, k + 1), { fix: { insert: unit, side: 'after', text: '。' } });
    },
  };
}

/** 台詞末の句読点禁止: a 。、 run right before the closing 」/』 of its utterance. */
export function closingPunctRule(ctx: RuleContext): LineRule {
  return {
    line(line: LintLine): void {
      const v = line.prose();
      let i = 0;
      while (i < v.text.length) {
        const ch = v.text.charAt(i);
        if ((ch !== '。' && ch !== '、') || (v.units[i]?.depth ?? 0) === 0) {
          i += 1;
          continue;
        }
        const a = i;
        while (i < v.text.length && (v.text.charAt(i) === '。' || v.text.charAt(i) === '、')) {
          i += 1;
        }
        const closer = v.text.charAt(i);
        const runDepth = v.units[a]?.depth ?? 0;
        // The closer sits one level shallower than the interior it closes; a dangling closer
        // (walker keeps it at the same depth) is noUnmatchedPair's finding, not ours.
        if ((closer === '」' || closer === '』') && (v.units[i]?.depth ?? 0) < runDepth) {
          const fix = viewFix(v, a, i, '');
          ctx.report(viewSpan(v, a, i), fix === undefined ? undefined : { fix });
        }
      }
    },
  };
}

/** Feeds every maximal ！？!? run of the view to `visit` as `[a, b)` plus whether any mark in it
 *  is full-width. */
function eachMarkRun(
  view: ProseView,
  visit: (a: number, b: number, anyFull: boolean) => void,
): void {
  let i = 0;
  while (i < view.text.length) {
    if (!EXCLAMATIONS.has(view.text.charAt(i))) {
      i += 1;
      continue;
    }
    const a = i;
    let anyFull = false;
    while (i < view.text.length && EXCLAMATIONS.has(view.text.charAt(i))) {
      anyFull ||= view.text.charAt(i) === '！' || view.text.charAt(i) === '？';
      i += 1;
    }
    visit(a, i, anyFull);
  }
}

/** ！？の直後は全角スペース: report the run's last mark when prose continues without one; after a
 *  half-width space (or a tab) the report carries no fix. */
export function exclamationSpaceRule(ctx: RuleContext): LineRule {
  return {
    line(line: LintLine): void {
      const v = line.prose();
      eachMarkRun(v, (a, b, anyFull) => {
        if (!anyFull && b - a < 2) {
          return; // a lone half-width mark is not the sentence-ender form
        }
        const next = v.text.charAt(b);
        if (b >= v.text.length || AFTER_MARKS.has(next)) {
          return;
        }
        const last = v.units[b - 1];
        if (last === undefined) {
          return;
        }
        if (isSpace(next)) {
          ctx.report(viewSpan(v, b - 1, b));
          return;
        }
        ctx.report(viewSpan(v, b - 1, b), { fix: { insert: last, side: 'after', text: '　' } });
      });
    },
  };
}

/** ！？の幅と連続: one mark is full-width; a double with a full-width mark should be the
 *  half-width pair (縦中横 via autoTcy); three or more is its own finding (`.long` — no pair can
 *  set that in one cell). A lone half-width mark lies on its side in vertical text (`.single`). */
export function exclamationRunRule(ctx: RuleContext): LineRule {
  return {
    line(line: LintLine): void {
      const v = line.prose();
      eachMarkRun(v, (a, b, anyFull) => {
        const len = b - a;
        if (len >= 3) {
          ctx.report(viewSpan(v, a, b), { message: { code: 'lint.common.exclamationRun.long' } });
        } else if (len === 2 && anyFull) {
          const half = v.text
            .slice(a, b)
            .replace(/[！？]/g, (m) => FULL_TO_HALF[m] ?? m);
          const fix = viewFix(v, a, b, half);
          ctx.report(viewSpan(v, a, b), {
            message: { code: 'lint.common.exclamationRun' },
            ...(fix === undefined ? {} : { fix }),
          });
        } else if (len === 1 && !anyFull) {
          const fix = viewFix(v, a, b, HALF_TO_FULL[v.text.charAt(a)] ?? v.text.charAt(a));
          ctx.report(viewSpan(v, a, b), {
            message: { code: 'lint.common.exclamationRun.single' },
            ...(fix === undefined ? {} : { fix }),
          });
        }
      });
    },
  };
}

/** 三点リーダー: an odd … run (`.parity`, fix doubles the run's last leader in place) and the
 *  surrogate runs 。。/、、/・・ (fix replaces the run with ……). */
export function ellipsisRule(ctx: RuleContext): LineRule {
  const flagRun = (v: ProseView, a: number, b: number): void => {
    const fix = viewFix(v, a, b, '……');
    ctx.report(viewSpan(v, a, b), fix === undefined ? undefined : { fix });
  };
  return {
    line(line: LintLine): void {
      const v = line.prose();
      let i = 0;
      while (i < v.text.length) {
        const ch = v.text.charAt(i);
        if (ch === '…' || ch === '‥') {
          const a = i;
          while (i < v.text.length && v.text.charAt(i) === ch) {
            i += 1;
          }
          if ((i - a) % 2 === 1) {
            const fix = viewFix(v, i - 1, i, ch + ch);
            ctx.report(viewSpan(v, a, i), {
              message: { code: 'lint.common.ellipsis.parity' },
              ...(fix === undefined ? {} : { fix }),
            });
          }
          continue;
        }
        if (ch === '。' || ch === '、' || ch === '・') {
          const a = i;
          while (i < v.text.length && v.text.charAt(i) === ch) {
            i += 1;
          }
          if (i - a >= 2) {
            flagRun(v, a, i);
          }
          continue;
        }
        i += 1;
      }
    },
  };
}

/** 行末スペース: the space run (either width, or a tab) right before the line break; the fix
 *  deletes exactly that. A line ending in markup has no trailing prose, so a bare ［＃字下げ］
 *  line is never flagged. */
export function trailingSpaceRule(ctx: RuleContext): LineRule {
  return {
    line(line: LintLine): void {
      const piece = line.pieces[line.pieces.length - 1];
      if (piece === undefined || piece.srcStart + piece.text.length !== line.srcEnd) {
        return;
      }
      let k = piece.text.length;
      while (k > 0 && isSpace(piece.text.charAt(k - 1))) {
        k -= 1;
      }
      if (k === piece.text.length) {
        return;
      }
      ctx.report(
        { start: piece.srcStart + k, end: line.srcEnd },
        { fix: { replace: { piece, start: k, end: piece.text.length }, text: '' } },
      );
    },
  };
}

/** 連続空行: more than `max` blank lines in a row are one finding, and the fix erases the first
 *  `count − max` (whole lines, terminators included). Any line with a token ends the run. A blank
 *  last line is the EOF tail, not a blank line: it bounds the run and is never erased. */
export function blankRunRule(ctx: RuleContext): LineRule {
  const max = maxOf(ctx);
  const starts: number[] = [];
  const flush = (after: number): void => {
    const first = starts[0];
    const excess = starts.length - max;
    if (first !== undefined && excess > 0) {
      const span = { start: first, end: starts[excess] ?? after };
      ctx.report(span, { fix: { erase: span } });
    }
    starts.length = 0;
  };
  return {
    line(line: LintLine): void {
      if (line.blank) {
        starts.push(line.srcStart);
      } else {
        flush(line.srcStart);
      }
    },
    end(): void {
      const tail = starts.pop();
      if (tail !== undefined) {
        flush(tail);
      }
    },
  };
}

/** 台詞行頭の字下げ禁止: literal leading whitespace right before a 「/『 opener. An annotation
 *  ［＃字下げ］ on a dialogue line is the author's explicit call and is left alone. */
export function noIndentRule(ctx: RuleContext): LineRule {
  return {
    line(line: LintLine): void {
      if (line.blank || line.directiveOnly) {
        return;
      }
      const v = line.prose();
      let k = 0;
      while (k < v.text.length && isSpace(v.text.charAt(k))) {
        k += 1;
      }
      const ch = v.text.charAt(k);
      if (k === 0 || (ch !== '「' && ch !== '『') || (v.units[k]?.depth ?? 1) !== 0) {
        return;
      }
      const fix = viewFix(v, 0, k, '');
      ctx.report(viewSpan(v, 0, k), fix === undefined ? undefined : { fix });
    },
  };
}
