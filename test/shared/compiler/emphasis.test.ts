import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveStyle,
  styleRule,
  styleVariantsByChannel,
} from '../../../src/shared/compiler/emphasis.ts';

test('resolveStyle maps all nine dot variants to the emph channel', () => {
  const table: [string, string][] = [
    ['傍点', 'emph-fs'],
    ['白ゴマ傍点', 'emph-os'],
    ['丸傍点', 'emph-fc'],
    ['白丸傍点', 'emph-oc'],
    ['二重丸傍点', 'emph-fd'],
    ['蛇の目傍点', 'emph-od'],
    ['黒三角傍点', 'emph-ft'],
    ['白三角傍点', 'emph-ot'],
    ['ばつ傍点', 'emph-x'],
  ];
  for (const [variant, className] of table) {
    assert.deepEqual(resolveStyle(variant), { channel: 'emph', className }, `variant ${variant}`);
  }
});

test('resolveStyle collapses ×傍点 and ばつ傍点 to the same emph-x class', () => {
  assert.equal(resolveStyle('×傍点')?.className, 'emph-x');
  assert.equal(resolveStyle('ばつ傍点')?.className, 'emph-x');
});

test('resolveStyle maps the five 傍線 styles to the line channel (dec-*)', () => {
  const table: [string, string][] = [
    ['傍線', 'dec-solid'],
    ['二重傍線', 'dec-double'],
    ['鎖線', 'dec-dotted'],
    ['破線', 'dec-dashed'],
    ['波線', 'dec-wavy'],
  ];
  for (const [variant, className] of table) {
    assert.deepEqual(resolveStyle(variant), { channel: 'line', className }, `variant ${variant}`);
  }
  // A 終わり-suffixed name is NOT a bare variant — the tokenizer strips 終わり before asking.
  assert.equal(resolveStyle('波線終わり'), null);
});

test('resolveStyle maps 太字/斜体 to the weight/style channels (b / i)', () => {
  assert.deepEqual(resolveStyle('太字'), { channel: 'weight', className: 'b' });
  assert.deepEqual(resolveStyle('斜体'), { channel: 'style', className: 'i' });
});

test('resolveStyle adds -l form-bound: bare 左に for spans, の左に for postfixes', () => {
  assert.deepEqual(resolveStyle('左に傍点', 'span'), { channel: 'emph', className: 'emph-fs-l' });
  assert.deepEqual(resolveStyle('左に二重丸傍点', 'span'), { channel: 'emph', className: 'emph-fd-l' });
  assert.deepEqual(resolveStyle('左に傍線', 'span'), { channel: 'line', className: 'dec-solid-l' });
  assert.deepEqual(resolveStyle('の左に傍点', 'postfix'), { channel: 'emph', className: 'emph-fs-l' });
  assert.deepEqual(resolveStyle('の左にばつ傍点', 'postfix'), { channel: 'emph', className: 'emph-x-l' });
  assert.deepEqual(resolveStyle('の左に波線', 'postfix'), { channel: 'line', className: 'dec-wavy-l' });
});

test('resolveStyle rejects the cross-form left prefixes and any prefix under none', () => {
  // The Aozora spec fixes the spelling by form: a span never carries の左に, a postfix never
  // carries bare 左に; both degrade to null (→ comment) instead of resolving to -l.
  assert.equal(resolveStyle('の左に傍点', 'span'), null);
  assert.equal(resolveStyle('左に傍点', 'postfix'), null);
  // The default 'none' (block variants; a postfix whose connector was stripped) takes neither —
  // にの左に傍点 dies here: the connector and the direction prefix are mutually exclusive.
  assert.equal(resolveStyle('の左に傍点'), null);
  assert.equal(resolveStyle('左に傍点'), null);
});

test('resolveStyle rejects 左に on 太字/斜体 (no side) and unknown / empty variants', () => {
  assert.equal(resolveStyle('左に太字', 'span'), null);
  assert.equal(resolveStyle('の左に斜体', 'postfix'), null);
  for (const v of ['', 'なぞ傍点', '傍', 'ページ', '左に']) {
    assert.equal(resolveStyle(v, 'span'), null, `unknown ${v} must be null`);
  }
});

test('styleRule yields the full CSS rule; emph-x uses the real × glyph, not ASCII', () => {
  assert.equal(styleRule('emph-fs'), '.emph-fs{text-emphasis-style:filled sesame}');
  // The -l position needs the over|under component: a bare `left` is invalid CSS (the browser
  // drops the whole declaration) — `under left` is the required value.
  assert.equal(
    styleRule('emph-fs-l'),
    '.emph-fs-l{text-emphasis-style:filled sesame;text-emphasis-position:under left}',
  );
  // The slug is 'x' but the emitted CSS value is the full-width × glyph.
  assert.equal(styleRule('emph-x'), ".emph-x{text-emphasis-style:'×'}");
  // Unknown class names yield ''.
  assert.equal(styleRule('emph-nope'), '');
});

test('styleRule pins the vertical-rl underline side explicitly (right default, left for -l)', () => {
  // Chromium draws vertical-rl underlines on the LEFT by default, but the Aozora default 傍線
  // side is the RIGHT (same side as 傍点) — so the base rule must say so explicitly.
  assert.equal(
    styleRule('dec-solid'),
    '.dec-solid{text-decoration-line:underline;text-decoration-style:solid;text-underline-position:right}',
  );
  assert.equal(
    styleRule('dec-solid-l'),
    '.dec-solid-l{text-decoration-line:underline;text-decoration-style:solid;text-underline-position:left}',
  );
  assert.equal(
    styleRule('dec-wavy'),
    '.dec-wavy{text-decoration-line:underline;text-decoration-style:wavy;text-underline-position:right}',
  );
});

test('styleRule owns b / i too (single home of the style CSS); they have no -l variant', () => {
  assert.equal(styleRule('b'), '.b{font-weight:bold}');
  assert.equal(styleRule('i'), '.i{font-style:italic}');
  assert.equal(styleRule('b-l'), '');
  assert.equal(styleRule('i-l'), '');
});

test('no channel class ever declares position/transform (custom-ruby containment invariant)', () => {
  // Channel spans wrap ruby units; the custom left-ruby layout (ruby.lr / ruby.br) absolutely
  // positions its lane (rt>span) against the NEAREST positioned ancestor. A positioned/transformed channel
  // span would capture those annotations — so the rule table must never grow such a property.
  // (text-emphasis-position / text-underline-position are fine; the regex anchors on {/;.)
  const byChannel = styleVariantsByChannel();
  const classNames = new Set<string>();
  for (const v of [...byChannel.weight, ...byChannel.style]) {
    classNames.add(resolveStyle(v, 'none')?.className ?? '');
  }
  for (const v of [...byChannel.emph, ...byChannel.line]) {
    classNames.add(resolveStyle(v, 'none')?.className ?? '');
    classNames.add(resolveStyle(`左に${v}`, 'span')?.className ?? '');
  }
  classNames.delete('');
  assert.ok(classNames.size >= 16, 'expected every channel class (base + -l) to be enumerated');
  for (const cn of classNames) {
    const rule = styleRule(cn);
    assert.notEqual(rule, '', `rule missing for ${cn}`);
    assert.doesNotMatch(rule, /[{;](position|transform):/, `positioned channel class ${cn}`);
  }
});

test('styleVariantsByChannel exposes the full variant table per channel', () => {
  const byChannel = styleVariantsByChannel();
  assert.deepEqual(
    [...byChannel.emph].sort(),
    [
      'ばつ傍点',
      '×傍点',
      '丸傍点',
      '二重丸傍点',
      '傍点',
      '白ゴマ傍点',
      '白丸傍点',
      '白三角傍点',
      '蛇の目傍点',
      '黒三角傍点',
    ].sort(),
  );
  assert.deepEqual([...byChannel.line].sort(), ['傍線', '二重傍線', '波線', '破線', '鎖線'].sort());
  assert.deepEqual(byChannel.weight, ['太字']);
  assert.deepEqual(byChannel.style, ['斜体']);
});
