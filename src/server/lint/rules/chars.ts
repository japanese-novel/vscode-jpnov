/**
 * Character-hygiene rules and the ruby-reading kana rule. The hygiene scans run on the prose view
 * (地の文 and セリフ alike; annotation interiors stay the raw shiftJisSafe rule's job), except
 * noNfd and noControlChar, which scan every source slice of the line: a ruby reading, an
 * annotation target or a comment is composed, and loses its control characters, in every output
 * too. Every fix replaces or deletes characters in place.
 */
import { COMBINING_KANA_MARK, composeKana, isCjkIdeograph, isLatinLetter } from '../../../shared/chars.ts';

import { isControlChar, rubyKanaScan } from '../prescan.ts';
import type { PreScan } from '../prescan.ts';
import type { LineRule, LintLine, RuleContext } from '../types.ts';

import { viewScan } from './adapt.ts';

/** The combining marks as a scan over a text, one match per mark reported. */
const COMBINING_KANA_MARKS = new RegExp(COMBINING_KANA_MARK.source, 'g');

/** 半角カナ (U+FF61–FF9F: half-width kana, its punctuation and ﾞﾟ): a run normalizes to the
 *  full-width form; NFKC composes ｶ+ﾞ into ガ in one go. */
const hankakuKanaScan: PreScan = (text) => {
  const out: { start: number; end: number; fix: string }[] = [];
  let i = 0;
  while (i < text.length) {
    const cp = text.charCodeAt(i);
    if (cp < 0xff61 || cp > 0xff9f) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < text.length && text.charCodeAt(i) >= 0xff61 && text.charCodeAt(i) <= 0xff9f) {
      i += 1;
    }
    out.push({ start, end: i, fix: text.slice(start, i).normalize('NFKC') });
  }
  return out;
};

/** Decomposed (NFD) kana anywhere on the line — prose, ruby readings, annotation targets and
 *  keywords alike. The REPORT covers the combining 濁点/半濁点 mark alone (so the raw shiftJisSafe
 *  finding over the same mark de-duplicates against it); the FIX replaces the kana and its mark
 *  by their composition, through the same {@link composeKana} the `.txt` codec runs. A mark that
 *  composes with nothing is flagged without a fix. */
export function nfdRule(ctx: RuleContext): LineRule {
  return {
    line(line: LintLine): void {
      for (const slice of line.source) {
        const { text, srcStart } = slice;
        for (const m of text.matchAll(COMBINING_KANA_MARKS)) {
          const i = m.index;
          const composed = i > 0 ? composeKana(text.slice(i - 1, i + 1)) : '';
          ctx.report(
            { start: srcStart + i, end: srcStart + i + 1 },
            composed.length === 1 ? { fix: { replace: { slice, start: i - 1, end: i + 1 }, text: composed } } : undefined,
          );
        }
      }
    },
  };
}

/** ゼロ幅スペース (U+200B): a run is deleted outright. */
const zeroWidthScan: PreScan = (text) => {
  const out: { start: number; end: number; fix: string }[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) !== '\u200b') {
      i += 1;
      continue;
    }
    const start = i;
    while (i < text.length && text.charAt(i) === '\u200b') {
      i += 1;
    }
    out.push({ start, end: i, fix: '' });
  }
  return out;
};

/** 制御文字 (C0/C1 except \t — terminators never reach a line) and the noncharacters U+FFFE and
 *  U+FFFF, anywhere on the line — prose, ruby readings, annotations and comments alike, since no
 *  output carries the ones `dropUnshown` drops. Each one is deleted; a reading left empty is the
 *  syntax diagnostics' finding (the Scanner already makes no ruby of a ｜ base that shows nothing). */
export function controlCharRule(ctx: RuleContext): LineRule {
  return {
    line(line: LintLine): void {
      for (const slice of line.source) {
        const { text, srcStart } = slice;
        for (let i = 0; i < text.length; i += 1) {
          if (isControlChar(text.charCodeAt(i))) {
            const at = srcStart + i;
            ctx.report({ start: at, end: at + 1 }, { fix: { replace: { slice, start: i, end: i + 1 }, text: '' } });
          }
        }
      }
    },
  };
}

/** Kana or a CJK ideograph, by code unit: a surrogate half is neither. */
const isJa = (unit: number): boolean => (unit >= 0x3040 && unit <= 0x30ff) || isCjkIdeograph(unit);

/** A capital, either width. */
const isUpper = (unit: number): boolean => (unit >= 0x41 && unit <= 0x5a) || (unit >= 0xff21 && unit <= 0xff3a);

/** A letter, either width; NaN (past the text) is none. */
const isAlpha = isLatinLetter;

/** Letters an IME legitimately leaves between Japanese characters (the stock rule's allow list):
 *  the vowels + n in either width, and any capital (Ｘ座標, A案). */
const NATURAL_ALPHA = new Set(['a', 'i', 'u', 'e', 'o', 'n', 'ａ', 'ｉ', 'ｕ', 'ｅ', 'ｏ', 'ｎ']);

/** 不自然なアルファベット: one letter sandwiched between Japanese characters — the shape of an
 *  IME slip (見るr) — unless it is on the allow list or a capital. */
const strayLetterScan: PreScan = (text) => {
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (!isAlpha(unit) || isAlpha(text.charCodeAt(i - 1)) || isAlpha(text.charCodeAt(i + 1))) {
      continue;
    }
    if (isUpper(unit) || NATURAL_ALPHA.has(text.charAt(i))) {
      continue;
    }
    if (isJa(text.charCodeAt(i - 1)) && isJa(text.charCodeAt(i + 1))) {
      out.push({ start: i, end: i + 1 });
    }
  }
  return out;
};

export const hankakuKanaRule = viewScan(hankakuKanaScan, 'prose');
export const zeroWidthRule = viewScan(zeroWidthScan, 'prose');
export const strayLetterRule = viewScan(strayLetterScan, 'prose');

/** ルビの読みの仮名種: each reading shown must be entirely the chosen kana type. A 左ルビ reading is
 *  exempt (it is often Latin); a reading that does not show (a 縦中横 swallowed it, its base shows
 *  nothing) is not a reading. */
export function rubyKanaRule(ctx: RuleContext): LineRule {
  return {
    line(line: LintLine): void {
      for (const item of ctx.ast.lines[line.srcLine]?.content ?? []) {
        if (item.kind === 'ruby' && item.right !== undefined && rubyKanaScan(item.right.text, ctx.options).length > 0) {
          ctx.report(item.right.span);
        }
      }
    },
  };
}
