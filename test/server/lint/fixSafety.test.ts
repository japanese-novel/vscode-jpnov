/**
 * The exhaustive fix-safety guard: NO auto-fix may overwrite the markup between two clean
 * characters (a fix once silently deleted an annotation — a data-loss bug class), and NO insert
 * may land inside a ruby or an annotation span (an inserted 。 once split 山田《やまだ》 — #72).
 *
 * `FIX_CORPUS` is a `Record<CatalogId, …>`, so adding a catalog rule without deciding its entry is
 * a COMPILE error: list at least one corpus that produces a fix, or declare `null` (rule has no
 * fix). For every corpus the guard (a) asserts the plain text yields ≥ 1 fix (a dead corpus would
 * guard nothing), then (b) slips a stand-alone annotation between EVERY adjacent character pair,
 * line ends included, and (c) wraps EVERY single character in a ruby / a span; after every fix is
 * applied, each variant must keep its markup token stream and every insert outside the wedge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize } from '../../../src/shared/compiler/tokenizer.ts';
import { RULES, settingKey } from '../../../src/shared/lint/catalog.ts';
import type { CatalogId } from '../../../src/shared/lint/catalog.ts';
import type { RawLintConfigWire } from '../../../src/shared/protocol.ts';
import { applyLintFixes } from '../helpers.ts';

/** Fix-producing corpora per rule; `null` = the rule never emits a fix. */
const FIX_CORPUS: Record<CatalogId, readonly string[] | null> = {
  sentenceLength: null,
  maxTen: null,
  maxKanjiRun: null,
  dash: ['あ―――い', 'あ—い'],
  ellipsis: ['　沈黙…だ。', '　沈黙。。。だ。', '　えっ、、だ。', '　中黒・・・だ。', '　二点‥だ。'],
  exclamationSpace: ['　驚いた！そのまま。', '「なに？と続く」'],
  exclamationRun: ['　なに！？だ。', '「うそ！！」', '　だめだ!と。'],
  arabicDigits: null,
  noTrailingSpace: ['好き　', '　　'],
  blankRun: ['あ。\n\n\nい。'],
  noUnmatchedPair: null,
  noHankakuKana: ['　はｱｲだ。', '　はｶﾞだ。'],
  noNfd: ['　か\u3099き。'],
  noZeroWidth: ['　あ\u200bい。'],
  noControlChar: ['　あ\u0007い。'],
  shiftJisSafe: null,
  jaNoSpaceBetweenFullWidth: ['　あ いう。'],
  jaUnnaturalAlphabet: null,
  minusPosition: null,
  indent: ['これは地の文。'],
  endPeriod: ['　これは文'],
  closingPunct: ['「そうだ。」'],
  noIndent: ['　「台詞だ」'],
  kana: null,
};

/** The enabling snapshot for one rule. */
function enable(id: CatalogId): RawLintConfigWire {
  const rule = RULES.find((r) => r.id === id);
  if (rule === undefined) {
    throw new Error(`no catalog rule ${id}`);
  }
  if (rule.kind === 'boolean') {
    return { [settingKey(rule)]: true };
  }
  if (rule.kind === 'threshold') {
    return { [settingKey(rule)]: rule.suggested };
  }
  const value = rule.values.find((v) => v !== 'off') ?? '';
  return { [settingKey(rule)]: value };
}

/** The markup token stream: every non-text token by kind and raw text, a ruby by kind and reading
 *  (a fix may legitimately rewrite characters of its base). */
function shape(src: string): string[] {
  return tokenize(src).flatMap((t) => {
    if (t.kind === 'text') {
      return [];
    }
    return [t.kind === 'rubyImplicit' ? `${t.kind}:${t.reading}` : `${t.kind}:${t.raw}`];
  });
}

/** A wedge: markup `open`…`close` around `wraps` characters of the corpus (0 = slipped between
 *  two characters). */
interface Wedge {
  readonly open: string;
  readonly close: string;
  readonly wraps: number;
}

/** Between two characters: a postfix (its target is never in the corpora) and a comment. Around
 *  one: an explicit ruby, and the 縦中横 / 傍点 / 丸傍点 / block 太字 spans. */
const WEDGES: readonly Wedge[] = [
  { open: '［＃「z」に傍点］', close: '', wraps: 0 },
  { open: '［＃メモ］', close: '', wraps: 0 },
  { open: '｜', close: '《z》', wraps: 1 },
  { open: '｜', close: '［＃メモ］《z》', wraps: 1 }, // a ｜ base holding an annotation
  { open: '｜［＃メモ］', close: '《z》', wraps: 1 },
  { open: '［＃縦中横］', close: '［＃縦中横終わり］', wraps: 1 },
  { open: '［＃傍点］', close: '［＃傍点終わり］', wraps: 1 },
  { open: '［＃丸傍点］', close: '［＃丸傍点終わり］', wraps: 1 },
  { open: '［＃ここから太字］', close: '［＃ここで太字終わり］', wraps: 1 },
];

/** Every variant of `corpus` under `wedge`, each with the wedge's own `[start, end)`. A wrapper is
 *  line-local, so a line terminator is never wrapped. */
function variants(corpus: string, wedge: Wedge): { variant: string; start: number; end: number }[] {
  const out: { variant: string; start: number; end: number }[] = [];
  for (let at = 0; at + wedge.wraps <= corpus.length; at += 1) {
    const inner = corpus.slice(at, at + wedge.wraps);
    if (inner.includes('\n')) {
      continue;
    }
    const variant = corpus.slice(0, at) + wedge.open + inner + wedge.close + corpus.slice(at + wedge.wraps);
    out.push({ variant, start: at, end: at + wedge.open.length + inner.length + wedge.close.length });
  }
  return out;
}

for (const rule of RULES) {
  const corpora = FIX_CORPUS[rule.id];
  if (corpora === null) {
    continue;
  }
  test(`fix safety: ${rule.id}`, () => {
    const raw = enable(rule.id);
    for (const corpus of corpora) {
      // (a) the corpus is alive: the plain text yields at least one fix
      assert.ok(applyLintFixes(corpus, raw).edits.length >= 1, `dead corpus for ${rule.id}: ${corpus}`);
      // (b)+(c) markup wedged anywhere survives every fix, and no insert lands inside it
      for (const wedge of WEDGES) {
        for (const { variant, start, end } of variants(corpus, wedge)) {
          const { out, edits } = applyLintFixes(variant, raw);
          const label = `${rule.id}: ${variant}`;
          assert.deepEqual(shape(out), shape(variant), `${label} — markup tokens changed`);
          for (const ed of edits) {
            if (ed.s === ed.e) {
              assert.ok(ed.s <= start || ed.s >= end, `${label} — insert at ${String(ed.s)} lands inside the wedge`);
            }
          }
        }
      }
    }
  });
}
