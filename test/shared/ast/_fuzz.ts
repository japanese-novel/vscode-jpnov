/**
 * A deterministic manuscript generator for the property tests: prose, punctuation, dialogue,
 * every ruby form with its degenerate spellings, every annotation with its near misses, broken
 * ［＃, 外字注記, decomposed kana, astral and invisible characters, in LF, CRLF or mixed lines. Sample
 * names are the generic placeholders only.
 *
 * `JPNOV_FUZZ_SEED` / `JPNOV_FUZZ_COUNT` override the run for a local soak.
 */
import { GAIJI, GAIJI_MARK, HEADING_LITERALS, INDENT_MAX, VALUE_NAMES, indentAnnotation } from '../../../src/shared/ast/notation.ts';
import { D, H } from '../_kana.ts';

import { blockOf, gaijiOf, variantsByChannel } from './_shape.ts';

// The notation's own tables, in table order: a variant added there is generated here.
const { emph: EMPH, line: LINE, weight, style } = variantsByChannel();
const WEIGHT = [...weight, ...style];
const HEADINGS = HEADING_LITERALS;
const VALUES = [...Object.values(VALUE_NAMES), '発行日', '13', 'toString'];
const DIGITS = ['０', '１', '２', '３', '００３', '１０'];

const WORDS = [
  '王都', '聖剣', '山田', '太郎', '花子', '作品名', 'ペンネーム', '本文', '序章', '彼', '私', '漢字', '語', '時々', '〆切', '一〇八',
  'あ', 'か', 'が', 'と', 'は', 'です', 'ため', 'ア', 'ガラス', 'ー', 'ヶ', 'a', 'Z', 'John Smith', '12', '1234', 'Ａ', '１２',
  `か${D}`, `た${D}め`, `は${H}`, `あ${D}`, D, '𠮷', '辻\u{E0100}', '​', '\u0007', 'ｶﾞ',
  '。', '、', '・', '—', '―', '——', '…', '……', '!', '?', '!!', '!?', '?!', '!!!', '！？', '（', '）', '　', ' ', '＊',
  // Each 外字注記 whole, its character typed as it is, and a ※ that may meet any annotation.
  ...Object.values(GAIJI).flatMap((char) => [gaijiOf(char), char]), GAIJI_MARK,
];
const READINGS = ['やまだ', 'たろう', 'おうと', 'ヤマダ', 'よみ', 'r', `か${D}らす`, 'い ち', 'ながいよみがなです', ''];
const TOO_LARGE = indentAnnotation(INDENT_MAX + 1);
const NEAR_MISSES = [
  '［＃メモ］', '［＃］', '［＃改丁］', '［＃ここから罫囲み］', '［＃「」に傍点］', '［＃「語」は傍点］', '［＃「語」に太字］',
  '［＃「語」にの左に傍点］', '［＃ここから傍点］', '［＃の左に傍点］', '［＃3字下げ］', '［＃ここに「」の値を表示］',
  '［＃「語」の左に「」のルビ］', '［＃見出し］', `［＃５字下け${D}］`, '［＃縦中横 ］',
  TOO_LARGE, blockOf(TOO_LARGE),
  ...Object.keys(GAIJI).map((inner) => `［＃${inner}］`), '［＃感嘆符疑問符］', '［＃感嘆符疑問符、1-8-79］',
];
const BROKEN = ['［＃', '［＃こわれ', '［＃「未', '［＃あ［＃い'];
const DEGENERATE = ['｜', '｜｜', '｜《よみ》', '《》', '｜漢字《》', '《よみ》', '。《よみ》', '《a《b》', '》《ab》', '《', '》', 'a｜b｜c《r》', '。《!?》'];

/** mulberry32: `next()` in [0, 1). */
export function prng(seed: number): { int(n: number): number; pick<T>(xs: readonly T[]): T; chance(p: number): boolean } {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n) => Math.floor(next() * n),
    pick: (xs) => xs[Math.floor(next() * xs.length)] as (typeof xs)[number],
    chance: (p) => next() < p,
  };
}

function manuscript(seed: number): string {
  const r = prng(seed);
  const words = (max: number): string => Array.from({ length: 1 + r.int(max) }, () => r.pick(WORDS)).join('');
  const variant = (): string => r.pick(r.chance(0.5) ? EMPH : r.chance(0.6) ? LINE : WEIGHT);

  /** A target for a postfix: mostly a slice of the text before it. */
  const target = (before: string): string => {
    const chars = Array.from(before.replace(/［＃[^］]*］|《[^》]*》|｜/g, ''));
    if (chars.length === 0 || r.chance(0.15)) {
      return r.pick(['無', '別文', '聖']);
    }
    const len = 1 + r.int(Math.min(4, chars.length));
    const start = r.chance(0.7) ? chars.length - len : r.int(chars.length - len + 1);
    return chars.slice(start, start + len).join('');
  };

  const annotation = (before: string): string => {
    const t = target(before);
    switch (r.int(14)) {
      case 0:
        return `［＃「${t}」${r.pick(['に', 'に', '', 'の左に'])}${r.pick(r.chance(0.6) ? EMPH : LINE)}］`;
      case 1:
        return `［＃「${t}」は${r.pick([...WEIGHT, '縦中横', ...HEADINGS])}］`;
      case 2:
        return `［＃「${t}」の左に「${r.pick(READINGS)}」のルビ］`;
      case 3:
        return `［＃${r.chance(0.2) ? '左に' : ''}${variant()}］`;
      case 4:
        return `［＃${r.chance(0.2) ? '左に' : ''}${variant()}終わり］`;
      case 5:
        return r.pick(['［＃縦中横］', '［＃縦中横］', '［＃縦中横終わり］']);
      case 6:
        return r.pick([`［＃${r.pick(HEADINGS)}］`, `［＃${r.pick(HEADINGS)}終わり］`]);
      case 7:
        return `［＃${r.pick(DIGITS)}字下げ］`;
      case 8:
        return '［＃改ページ］';
      case 9:
        return `［＃ここに「${r.pick(VALUES)}」の値を表示］`;
      case 10:
        return r.pick(BROKEN);
      default:
        return r.pick(NEAR_MISSES);
    }
  };

  const ruby = (before: string): string => {
    switch (r.int(4)) {
      case 0:
        return `${r.pick(WORDS)}《${r.pick(READINGS)}》`;
      case 1:
        return `｜${words(3)}${r.chance(0.4) ? annotation(before) : ''}${r.chance(0.3) ? words(2) : ''}《${r.pick(READINGS)}》`;
      default:
        return r.pick(DEGENERATE);
    }
  };

  const line = (): string => {
    const k = r.int(20);
    if (k < 2) {
      return '';
    }
    if (k < 5) {
      return r.pick([
        `［＃ここから${r.pick(DIGITS)}字下げ］`, '［＃ここで字下げ終わり］', `［＃ここから${r.pick(WEIGHT)}］`, `［＃ここで${r.pick(WEIGHT)}終わり］`,
        `［＃ここから${r.pick(HEADINGS)}］`, `［＃ここで${r.pick(HEADINGS)}終わり］`, '［＃改ページ］',
      ]);
    }
    let s = k < 8 ? `［＃${r.pick(DIGITS)}字下げ］` : k < 14 ? '　' : '';
    const n = 1 + r.int(r.chance(0.8) ? 8 : 30);
    for (let i = 0; i < n; i += 1) {
      const f = r.int(10);
      s += f < 5 ? words(4) : f < 6 ? `「${words(4)}${r.chance(0.8) ? '」' : ''}` : f < 8 ? ruby(s) : annotation(s);
    }
    return s;
  };

  const lines = 1 + r.int(r.chance(0.7) ? 5 : 30);
  const style = r.int(3); // LF, CRLF, mixed
  let src = '';
  for (let i = 0; i < lines; i += 1) {
    src += line();
    if (i < lines - 1 || r.chance(0.6)) {
      src += style === 0 ? '\n' : style === 1 ? '\r\n' : r.chance(0.5) ? '\n' : '\r\n';
    }
  }
  return src.replace(/\r(?!\n)/g, ''); // a lone CR is a case of its own (see `withLoneCr`)
}

/** `count` manuscripts, the same ones on every run. */
export function manuscripts(count = Number(process.env.JPNOV_FUZZ_COUNT ?? 300)): string[] {
  const seed = Number(process.env.JPNOV_FUZZ_SEED ?? 126);
  return Array.from({ length: count }, (_, i) => manuscript((seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0));
}

/** `src` with every line terminator replaced by `eol`. */
export function withEol(src: string, eol: '\n' | '\r\n' | '\r'): string {
  return src.replace(/\r\n|\n|\r/g, eol);
}
