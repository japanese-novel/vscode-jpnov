/**
 * Drift guard: the tmLanguage variant alternations + the single-line 字下げ ^-anchor must match
 * the emphasis.ts mapper. Canonical order = length desc, code-unit asc. On drift it prints the
 * exact string to paste into syntaxes/jpnov.tmLanguage.json — the alternation is never
 * hand-edited (see the grammar file's header comment).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { styleVariantsByChannel } from '../../../src/shared/compiler/emphasis.ts';
import { HEADING_LITERALS } from '../../../src/shared/compiler/tokenizer.ts';
import { COVER_ITEM_MARKS } from '../../../src/shared/book/jpbook.ts';

const canonical = (vs: readonly string[]): string =>
  [...new Set(vs)].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0)).join('|');

const grammar = JSON.parse(
  readFileSync(new URL('../../../syntaxes/jpnov.tmLanguage.json', import.meta.url), 'utf8'),
) as { repository: { annotation: { patterns: { match?: string }[] } } };
const matches: string[] = grammar.repository.annotation.patterns
  .map((p) => p.match)
  .filter((m): m is string => typeof m === 'string');

test('tmLanguage dot+line alternation == emphasis.ts variants (canonical order)', () => {
  const { emph, line } = styleVariantsByChannel();
  const needle = canonical([...emph, ...line]);
  const hits = matches.filter((m) => m.includes('傍点')); // span END/START + postfix carry it
  assert.ok(hits.length >= 3, `expected >=3 patterns carrying the dot|line alternation, got ${String(hits.length)}`);
  for (const m of hits) {
    assert.ok(m.includes(needle), `stale dot|line alternation in:\n${m}\nPASTE:\n${needle}`);
  }
});

test('tmLanguage 太字|斜体 alternation == emphasis.ts variants', () => {
  const { weight, style } = styleVariantsByChannel();
  const needle = canonical([...weight, ...style]); // '太字|斜体'
  const hits = matches.filter((m) => m.includes('太字'));
  assert.ok(hits.length >= 3, 'expected block + span + postfix rules for 太字|斜体');
  for (const m of hits) {
    assert.ok(m.includes(needle), `stale 太字|斜体 alternation in:\n${m}\nPASTE:\n${needle}`);
  }
});

test('direction prefixes are form-bound: postfix (に|の左に)?, spans (左に)?', () => {
  // The Aozora spec fixes the left-prefix spelling BY FORM (postfix = の左に, span = bare 左に),
  // and a postfix connector excludes the direction prefix (single alternation). The literals
  // repeat across the grammar, emphasis.ts resolveStyle (form param) and semanticTokens
  // directionLen (form param) — pin the grammar side per form so no layer can drift.
  for (const m of matches.filter((x) => x.includes('傍点'))) {
    if (m.includes('「')) {
      // postfix rule: single connector|direction alternation, no bare 左に anywhere
      assert.ok(m.includes('(に|の左に)?'), `postfix must use (に|の左に)?:\n${m}`);
      assert.ok(!m.includes('|左に)') && !m.includes('(左に'), `postfix must not accept bare 左に:\n${m}`);
    } else {
      // span START/END rules: bare 左に only
      assert.ok(m.includes('(左に)?'), `span must carry (左に)?:\n${m}`);
      assert.ok(!m.includes('の左に'), `span must not accept の左に:\n${m}`);
    }
  }
});

test('縦中横 / 左ルビ fixed-literal rules exist, ordered, form-bound', () => {
  // These annotations are exact literals (not styleVariantsByChannel entries), so the variant
  // drift tests cannot cover them — pin their presence, their END-before-START order and the
  // 左ルビ prefix spelling here instead.
  const tcyEnd = matches.findIndex((m) => m === '(［＃)(縦中横)(終わり)(］)');
  const tcyStart = matches.findIndex((m) => m === '(［＃)(縦中横)(］)');
  const tcyPost = matches.findIndex((m) => m.includes('(は)(縦中横)'));
  const leftRuby = matches.findIndex((m) => m.includes('(のルビ)'));
  const generic = matches.findIndex((m) => m === '(［＃)([^］]*)(］)');
  assert.ok(generic >= 0, 'generic comment rule not found');
  const rules: [string, number][] = [
    ['tcy span END', tcyEnd],
    ['tcy span START', tcyStart],
    ['tcy postfix', tcyPost],
    ['left ruby postfix', leftRuby],
  ];
  for (const [label, i] of rules) {
    assert.ok(i >= 0 && i < generic, `${label} rule must exist before the generic comment rule`);
  }
  assert.ok(tcyEnd < tcyStart, 'tcy span END must precede START (終わり suffix)');
  const lr = matches[leftRuby];
  assert.ok(lr?.includes('(の左に)') === true && !lr.includes('|左に'), 'left ruby takes の左に only');
  assert.ok(lr.includes('(「)([^」]+)(」)(のルビ)'), 'left ruby reading is a non-empty corner pair + のルビ tail');
});

test('見出し postfix fixed-literal rule exists before the generic rule (canonical order)', () => {
  // The three level literals live in tokenizer.ts HEADING_LITERALS; the alternation is
  // derived, never hand-edited (same contract as the emphasis variants).
  const needle = canonical([...HEADING_LITERALS]);
  const rule = `(［＃)(「)([^」]+)(」)(は)(${needle})(］)`;
  const heading = matches.findIndex((m) => m === rule);
  const generic = matches.findIndex((m) => m === '(［＃)([^］]*)(］)');
  assert.ok(generic >= 0, 'generic comment rule not found');
  assert.ok(heading >= 0 && heading < generic, `見出し postfix rule missing/stale/after-generic. PASTE:\n${rule}`);
});

test('見出し span/block fixed-literal rules exist, ordered (END before START), before generic', () => {
  const needle = canonical([...HEADING_LITERALS]);
  const generic = matches.findIndex((m) => m === '(［＃)([^］]*)(］)');
  assert.ok(generic >= 0, 'generic comment rule not found');
  const rules: [string, string][] = [
    ['見出し block END', `(［＃)(ここで)(${needle})(終わり)(］)`],
    ['見出し block START', `(［＃)(ここから)(${needle})(］)`],
    ['見出し span END', `(［＃)(${needle})(終わり)(］)`],
    ['見出し span START', `(［＃)(${needle})(］)`],
  ];
  const at = rules.map(([label, rule]) => {
    const i = matches.findIndex((m) => m === rule);
    assert.ok(i >= 0 && i < generic, `${label} rule missing/stale/after-generic. PASTE:\n${rule}`);
    return i;
  });
  assert.ok((at[0] ?? 0) < (at[1] ?? 0), '見出し block END must precede START (終わり suffix)');
  assert.ok((at[2] ?? 0) < (at[3] ?? 0), '見出し span END must precede START (終わり suffix)');
});

test('value display rule takes any non-empty name up to ］, before the generic rule', () => {
  // The tokenizer accepts any non-empty name (an unknown one renders as itself), so the grammar
  // carries no name list: `[^］]+` is bounded exactly like the tokenizer's inner slice.
  const rule = '(［＃)(ここに「)([^］]+)(」の値を表示)(］)';
  const value = matches.findIndex((m) => m === rule);
  const generic = matches.findIndex((m) => m === '(［＃)([^］]*)(］)');
  assert.ok(generic >= 0, 'generic comment rule not found');
  assert.ok(value >= 0 && value < generic, `value display rule missing/stale/after-generic. PASTE:\n${rule}`);
});

test('the .jpbook item rule accepts exactly the parser cover markers, before the key-value rule', () => {
  // The markers live in jpbook.ts COVER_ITEM_MARKS; the grammar's character class is derived,
  // never hand-edited. Order matters: a cover path may contain a colon, so the item rule has
  // to win over the generic `key: value` rule.
  const book = JSON.parse(
    readFileSync(new URL('../../../syntaxes/jpbook.tmLanguage.json', import.meta.url), 'utf8'),
  ) as { patterns: { patterns?: { match?: string }[] }[] };
  const frontMatter = book.patterns[0]?.patterns ?? [];
  const item = frontMatter.findIndex((p) => p.match?.includes('.jpnov') === true);
  const keyValue = frontMatter.findIndex((p) => p.match?.includes(':：') === true);
  const needle = `[${COVER_ITEM_MARKS.join('')}]`;
  assert.ok(item >= 0, 'cover item rule not found in the front-matter block');
  assert.ok(keyValue >= 0, 'key-value rule not found in the front-matter block');
  assert.ok(item < keyValue, 'the item rule must precede the key-value rule (a path may contain a colon)');
  assert.ok(
    frontMatter[item]?.match?.includes(needle) === true,
    `stale cover-marker class in:\n${frontMatter[item]?.match ?? ''}\nPASTE:\n${needle}`,
  );
});

test('the single-line 字下げ rule is line-head anchored and full-width-only', () => {
  const m = matches.find((x) => x.includes('字下げ') && !x.includes('ここ')); // the non-block indent rule
  assert.ok(m, 'single-line 字下げ rule not found');
  assert.ok(m.startsWith('^'), 'must anchor ^ (a mid-line 字下げ degrades to comment — zero-fight)');
  assert.ok(m.includes('[０-９]') && !m.includes('[0-9'), 'full-width digits only (locked spec)');
});
