/**
 * The exhaustive fix-safety guard: NO auto-fix may overwrite the markup between two clean
 * characters (a fix once silently deleted an annotation — a data-loss bug class), and NO insert
 * may land inside a ruby or an annotation span (an inserted 。 once split 山田《やまだ》 — #72). The
 * noNfd and noControlChar fixes are the edits allowed inside markup, each only as its own
 * operation: the markup nodes are compared modulo {@link composeKana}, and for noControlChar
 * modulo the control characters it deletes. The one other edit inside markup is the 対象文字列
 * of a postfix that bound, rewritten with the body it names: that part is masked in the
 * comparison, and the postfix must still bind after the fix — unless an edit deleted the whole
 * body it bound to, which no 「…」 can follow. A corpus whose fix changes what the markup MEANS
 * (a decomposed keyword becoming a real annotation) belongs in engine.test.ts, not here.
 *
 * A fix may WRITE markup of its own (questionExclamationMarks writes the 縦中横 annotation in
 * its `tcy` mode): what it wrote
 * is set aside by where it landed, must read back as the markup it is, and counts as an insert
 * where it sits in the edit. A fix may REMOVE a ［＃○字下げ］ whole with the spaces it shows
 * (noIndent, noTrailingSpace): the one markup a deletion may take, and only those rules.
 *
 * `FIX_CORPUS` is a `Record<CatalogId, …>`, so adding a catalog rule without deciding its entry is
 * a COMPILE error: list at least one corpus that produces a fix, or declare `null` (rule has no
 * fix). An enum rule runs once per value that enables it. For every corpus the guard (a) asserts the plain text yields ≥ 1 fix (a dead corpus would
 * guard nothing), then (b) slips a stand-alone annotation between EVERY adjacent character pair,
 * line ends included, and (c) wraps EVERY single character in a ruby / a span; after every fix is
 * applied, each variant must keep its markup nodes and every insert outside the wedge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isControlChar } from '../../../src/server/lint/prescan.ts';
import type { Span } from '../../../src/shared/ast/nodes.ts';
import { composeKana, displayText } from '../../../src/shared/chars.ts';
import { RULES, settingKey } from '../../../src/shared/lint/catalog.ts';
import type { CatalogId } from '../../../src/shared/lint/catalog.ts';
import type { RawLintConfigWire } from '../../../src/shared/protocol.ts';
import { parse } from '../../../src/shared/ast/parse.ts';
import { boundOf, gaijiOf, isPostfix, nodesIn } from '../../shared/ast/_shape.ts';
import { applyLintFixes } from '../helpers.ts';
import type { LintEdit } from '../helpers.ts';

/** Fix-producing corpora per rule; `null` = the rule never emits a fix. */
const FIX_CORPUS: Record<CatalogId, readonly string[] | null> = {
  sentenceLength: null,
  maxTen: null,
  maxKanjiRun: null,
  dash: ['あ―――い', 'あ—い', 'あ－－い'],
  ellipsis: ['　沈黙…だ。', '　沈黙。。。だ。', '　えっ、、だ。', '　中黒・・・だ。', '　二点‥だ。'],
  exclamationSpace: ['　驚いた！そのまま。', '「なに？と続く」'],
  exclamationRun: ['　なに！？だ。', '「うそ！！」', '　だめだ!と。'],
  questionExclamationMarks: ['　えっ!?次の文。', '「何だと!?」', '　彼は叫んだ!!'],
  arabicDigits: null,
  noTrailingSpace: ['好き　', '　　'],
  blankRun: ['あ。\n\n\nい。'],
  noUnmatchedPair: null,
  noHankakuKana: ['　はｱｲだ。', '　はｶﾞだ。'],
  noNfd: [
    '　か\u3099き。',
    '　山田《やまた\u3099》。',
    '　た\u3099め［＃「た\u3099め」に傍点］。',
    '　聖剣《せいけん》［＃「聖剣」の左に「つるき\u3099」のルビ］。',
  ],
  noZeroWidth: ['　あ\u200bい。'],
  noControlChar: [
    '　あ\u0007い。',
    '　あ\uFFFEい。',
    '　山田《やま\u0007だ》。',
    '　聖剣［＃「聖\u0007剣」に傍点］。',
    '　あ［＃メ\u0007モ］い。',
    '　あ［＃メ\u0085モ］い。',
  ],
  shiftJisSafe: null,
  noHalfWidthSpace: ['　あ いう。', '　なに!? そして。'],
  noStrayLetter: null,
  minusPosition: null,
  indent: ['これは地の文。'],
  endPeriod: ['　これは文'],
  closingPunct: ['「そうだ。」'],
  noIndent: ['　「台詞だ」'],
  kana: null,
};

/** The values that enable `rule`: one, or every value of an enum but `off`. */
function enabling(rule: (typeof RULES)[number]): readonly (boolean | number | string)[] {
  if (rule.kind === 'boolean') {
    return [true];
  }
  if (rule.kind === 'threshold') {
    return [rule.suggested];
  }
  return rule.values.filter((v) => v !== 'off');
}

/** A markup node: what it is, and where it sits; a postfix also as it reads with its 対象文字列 masked. */
interface Markup {
  readonly label: string;
  readonly masked: string;
  readonly postfix: boolean;
  readonly span: Span;
}

/** The rules whose deletion may take a ［＃○字下げ］ with the spaces it shows. */
const ERASES_INDENT: ReadonlySet<CatalogId> = new Set(['noIndent', 'noTrailingSpace']);

/** What a rule's fix may change inside markup: kana composition, unless the rule is listed here. */
const NORMALIZE: Partial<Record<CatalogId, (text: string) => string>> = {
  noControlChar: (text) => Array.from(text).filter((ch) => !isControlChar(ch.codePointAt(0) ?? 0)).join(''),
};

/** The markup of `src`: every node but the text, by kind and source text — modulo `normalize`,
 *  the one edit the rule's fix makes inside markup. A ruby's base is text (a fix may
 *  legitimately rewrite its characters); what kind of ruby its reading closes is markup. */
function markup(src: string, normalize: (text: string) => string): Markup[] {
  return nodesIn(parse(src)).flatMap((node): Markup[] => {
    if (node.kind === 'text') {
      return [];
    }
    const kind = node.kind === 'rubyReading' && node.implicit ? 'rubyReading(implicit)' : node.kind;
    const label = `${kind}:${normalize(node.text)}`;
    if (!isPostfix(node)) {
      return [{ label, masked: label, postfix: false, span: node.span }];
    }
    const masked = `${kind}:${normalize(node.parts.map((part) => (part.role === 'target' ? '〈〉' : part.text)).join(''))}`;
    return [{ label, masked, postfix: true, span: node.span }];
  });
}

/** The labels of `nodes`, the 対象文字列 of the k-th postfix masked when `bound[k]` says it bound
 *  before the fix: a fix rewrites it with the body (that it still binds is asserted apart). */
function labels(nodes: readonly Markup[], bound: readonly (Span | null)[]): string[] {
  let k = 0;
  return nodes.map((node) => {
    if (!node.postfix) {
      return node.label;
    }
    const was = bound[k];
    k += 1;
    return was === null || was === undefined ? node.label : node.masked;
  });
}

/** The edits in the order of the result, each with where its text sits there, as
 *  {@link applyLintFixes} applies them: at one offset the insert lands before the wider edit. */
function landings(edits: readonly LintEdit[]): { edit: LintEdit; span: Span }[] {
  let shift = 0;
  return edits
    .toSorted((a, b) => a.s - b.s || a.e - b.e)
    .map((edit) => {
      const start = edit.s + shift;
      shift += edit.t.length - (edit.e - edit.s);
      return { edit, span: { start, end: start + edit.t.length } };
    });
}

/** A wedge: markup `open`…`close` around `wraps` characters of the corpus (0 = slipped between
 *  two characters). A close spelled from what is wrapped names it, and wraps nothing that shows
 *  as nothing (no 「…」 names that). */
interface Wedge {
  readonly open: string;
  readonly close: string | ((inner: string) => string);
  readonly wraps: number;
}

/** Between two characters: a postfix (its target is never in the corpora), a comment, a
 *  外字注記, a value field and a ruby over one. Around one: a postfix naming it, an explicit ruby,
 *  and the 縦中横 / 傍点 / 丸傍点 / block 太字 spans. */
const WEDGES: readonly Wedge[] = [
  { open: '［＃「z」に傍点］', close: '', wraps: 0 },
  { open: '', close: (inner) => `［＃「${inner}」に傍点］`, wraps: 1 },
  { open: '［＃メモ］', close: '', wraps: 0 },
  { open: '［＃１字下げ］', close: '', wraps: 0 },
  { open: gaijiOf('⁉'), close: '', wraps: 0 },
  { open: '［＃ここに「タイトル」の値を表示］', close: '', wraps: 0 },
  { open: '｜［＃ここに「タイトル」の値を表示］《z》', close: '', wraps: 0 }, // a ruby over a value field alone
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
    if (inner.includes('\n') || (typeof wedge.close === 'function' && displayText(inner) === '')) {
      continue;
    }
    const close = typeof wedge.close === 'string' ? wedge.close : wedge.close(inner);
    const variant = corpus.slice(0, at) + wedge.open + inner + close + corpus.slice(at + wedge.wraps);
    out.push({ variant, start: at, end: at + wedge.open.length + inner.length + close.length });
  }
  return out;
}

for (const rule of RULES) {
  const corpora = FIX_CORPUS[rule.id];
  if (corpora === null) {
    continue;
  }
  for (const value of enabling(rule)) {
    test(`fix safety: ${rule.id} = ${String(value)}`, () => {
      const raw: RawLintConfigWire = { [settingKey(rule)]: value };
      const normalize = NORMALIZE[rule.id] ?? composeKana;
      const shape = (src: string): string[] => markup(src, normalize).map((node) => node.label);
      for (const corpus of corpora) {
        // (a) the corpus is alive: the plain text yields at least one fix
        assert.ok(applyLintFixes(corpus, raw).edits.length >= 1, `dead corpus for ${rule.id}: ${corpus}`);
        // (b)+(c) markup wedged anywhere survives every fix, and no insert lands inside it
        for (const wedge of WEDGES) {
          for (const { variant, start, end } of variants(corpus, wedge)) {
            const { out, edits } = applyLintFixes(variant, raw);
            const label = `${rule.id}: ${variant}`;
            const landed = landings(edits);
            const written = ({ span }: Markup): boolean =>
              landed.some((at) => at.span.start <= span.start && span.end <= at.span.end);
            const bound = boundOf(variant);
            const after = markup(out, normalize);
            const erased = ({ label: what, span }: Markup): boolean =>
              ERASES_INDENT.has(rule.id) && what.startsWith('indent:') && edits.some((ed) => ed.t === '' && ed.s <= span.start && span.end <= ed.e);
            assert.deepEqual(
              labels(after.filter((node) => !written(node)), bound),
              labels(markup(variant, normalize).filter((node) => !erased(node)), bound),
              `${label} — markup changed`,
            );
            // (d) a postfix that bound still binds, unless an edit took the whole body it named:
            // deleted it, or replaced it as part of a wider run (`syncedTargets` follows neither)
            const taken = (b: Span): boolean =>
              edits.some((ed) => ed.s <= b.start && b.end <= ed.e && (ed.t === '' || ed.s < b.start || b.end < ed.e));
            boundOf(out).forEach((later, i) => {
              const earlier = bound[i];
              if (earlier !== null && earlier !== undefined && !taken(earlier)) {
                assert.ok(later !== null, `${label} — postfix #${String(i)} lost its target`);
              }
            });
            assert.deepEqual(
              after.filter(written).map((node) => node.label),
              landed.flatMap(({ edit }) => shape(edit.t)),
              `${label} — what a fix wrote does not read back as the markup it is`,
            );
            for (const ed of edits) {
              // What an edit adds, in source offsets: an insert at its own, written markup where it
              // sits in the edit.
              const adds = ed.s === ed.e ? [ed.s] : markup(ed.t, normalize).map(({ span }) => ed.s + Math.min(span.start, ed.e - ed.s));
              for (const at of adds) {
                assert.ok(at <= start || at >= end, `${label} — insert at ${String(at)} lands inside the wedge`);
              }
            }
          }
        }
      }
    });
  }
}
