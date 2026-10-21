/**
 * The editor features over an annotation (#134): the hover's lines, what lights up with the
 * cursor, and the rename of a 対象文字列 with the body it names. Pure over a document and its
 * parse, as server.ts calls them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { highlightsAt, hoverAt, prepareRenameAt, renameAt } from '../../src/server/annotations.ts';
import { parse } from '../../src/shared/ast/parse.ts';
import { at, gaijiOf } from '../shared/ast/_shape.ts';
import { openDoc as doc } from './helpers.ts';

/** The position of the `nth` occurrence of `needle` in `src`, `into` characters in. */
const posOf = (src: string, needle: string, nth = 0, into = 0): Position => doc(src).positionAt(at(src, needle, nth).start + into);

/** The hover at `needle`: its lines as `code(args)`, the text under its range, and the end of its link. */
function hover(src: string, needle: string, nth = 0, into = 0): { lines: string[]; over: string; link?: string } | null {
  const d = doc(src);
  const result = hoverAt(d, parse(src), posOf(src, needle, nth, into));
  if (result === null) {
    return null;
  }
  const lines = result.lines.map((line) => `${line.code}(${(line.args ?? []).join(', ')})`);
  const link = result.link?.replace('https://www.aozora.gr.jp/annotation/', '');
  return { lines, over: d.getText(result.range), ...(link === undefined ? {} : { link }) };
}

test('the hover of a corner-target postfix: what it sets, and the body it bound to', () => {
  assert.deepEqual(hover('覚悟［＃「覚悟」に傍点］を決めた。', '［＃'), {
    lines: ['hover.postfix(傍点)', 'hover.target(覚悟)'], over: '［＃「覚悟」に傍点］', link: 'emphasis.html#boten_chuki',
  });
  assert.deepEqual(hover('王都［＃「王都」の左に波線］', '波線'), {
    lines: ['hover.postfix(左に波線)', 'hover.target(王都)'], over: '［＃「王都」の左に波線］', link: 'emphasis.html#bosen_chuki',
  });
  assert.deepEqual(hover('王都［＃「王都」は太字］', '太字')?.link, 'emphasis.html#futoji_gothic,shatai_italic');
  assert.deepEqual(hover('王都［＃「王都」は斜体］', '斜体')?.link, 'emphasis.html#futoji_gothic,shatai_italic');
  assert.deepEqual(hover('42［＃「42」は縦中横］', '縦中横'), {
    lines: ['hover.postfix(縦中横)', 'hover.target(42)'], over: '［＃「42」は縦中横］', link: 'etc.html#tatechu_yoko',
  });
  assert.deepEqual(hover('王都［＃「王都」は大見出し］', '大見出し'), {
    lines: ['hover.postfix(大見出し)', 'hover.target(王都)'], over: '［＃「王都」は大見出し］', link: 'heading.html',
  });
  assert.deepEqual(hover('王都［＃「王都」の左に「おうと」のルビ］', 'のルビ'), {
    lines: ['hover.rubyLeft(おうと)', 'hover.target(王都)'], over: '［＃「王都」の左に「おうと」のルビ］', link: 'etc.html#ruby',
  });
  // The body as written: a ruby inside stays a ruby.
  // The body it bound to, as shown: the ruby's base, not its markup.
  assert.deepEqual(hover('山田《やまだ》さん［＃「山田さん」に傍点］', '傍点')?.lines, ['hover.postfix(傍点)', 'hover.target(山田さん)']);
  assert.deepEqual(hover('新［＃「新」に傍点］帝都［＃「新帝都」に傍点］', '傍点', 1)?.lines, ['hover.postfix(傍点)', 'hover.target(新帝都)']);
  assert.deepEqual(hover('山田［＃「太郎」に傍点］', '傍点')?.lines, ['hover.postfix(傍点)', 'hover.targetMissing()']);
});

test('the hover of a start or end: its form, and the annotation it pairs with on its line', () => {
  const src = '［＃傍点］嬉しい［＃傍点終わり］\n［＃ここから太字］\nここぞ\n［＃ここで太字終わり］\n［＃斜体］だけ';
  assert.deepEqual(hover(src, '［＃傍点］'), {
    lines: ['hover.spanStart(傍点)', 'hover.pairEnd(［＃傍点終わり］, 1)'], over: '［＃傍点］', link: 'emphasis.html#boten_chuki',
  });
  assert.deepEqual(hover(src, '［＃傍点終わり］')?.lines, ['hover.spanEnd(傍点)', 'hover.pairStart(［＃傍点］, 1)']);
  assert.deepEqual(hover(src, '［＃ここから太字］')?.lines, ['hover.blockStart(太字)', 'hover.pairEnd(［＃ここで太字終わり］, 4)']);
  assert.deepEqual(hover(src, '［＃ここで太字終わり］')?.lines, ['hover.blockEnd(太字)', 'hover.pairStart(［＃ここから太字］, 2)']);
  assert.deepEqual(hover(src, '［＃斜体］')?.lines, ['hover.spanStart(斜体)', 'hover.endMissing()']);
  assert.deepEqual(hover('［＃左に傍線終わり］', '傍線')?.lines, ['hover.spanEnd(左に傍線)', 'hover.startMissing()']);
  assert.deepEqual(hover('［＃大見出し］王都［＃大見出し終わり］', '王都'), null);
  assert.deepEqual(hover('［＃ここから２字下げ］\n本文\n［＃ここで字下げ終わり］', '２字下げ'), {
    lines: ['hover.blockStart(２字下げ)', 'hover.pairEnd(［＃ここで字下げ終わり］, 3)'], over: '［＃ここから２字下げ］', link: 'layout_2.html#jisage',
  });
  assert.deepEqual(hover('［＃ここから２字下げ］\n本文\n［＃ここで字下げ終わり］', '字下げ終わり')?.lines, ['hover.blockEnd(字下げ)', 'hover.pairStart(［＃ここから２字下げ］, 1)']);
  // A 字下げ start of another count takes the slot (the notation's own form): the start it replaced says so,
  // not that it lacks an end; one of the same count is redundant and replaces nothing.
  const replaced = '［＃ここから２字下げ］\n本文\n［＃ここから３字下げ］\n本文\n［＃ここで字下げ終わり］';
  assert.deepEqual(hover(replaced, '２字下げ')?.lines, ['hover.blockStart(２字下げ)', 'hover.replaced(3)']);
  assert.deepEqual(hover(replaced, '３字下げ')?.lines, ['hover.blockStart(３字下げ)', 'hover.pairEnd(［＃ここで字下げ終わり］, 5)']);
  assert.deepEqual(hover('［＃ここから２字下げ］\n本文\n［＃ここから２字下げ］\n本文', '２字下げ')?.lines, ['hover.blockStart(２字下げ)', 'hover.endMissing()']);
});

test('the hover of a 縦中横 span: what it holds', () => {
  assert.deepEqual(hover('［＃縦中横］12［＃縦中横終わり］時', '［＃縦中横］')?.lines, [
    'hover.spanStart(縦中横)', 'hover.holds(12)', 'hover.pairEnd(［＃縦中横終わり］, 1)',
  ]);
  assert.deepEqual(hover('［＃縦中横］12', '［＃縦中横］')?.lines, ['hover.spanStart(縦中横)', 'hover.holds(12)', 'hover.endMissing()']);
  assert.deepEqual(hover('12［＃縦中横終わり］', '終わり')?.lines, ['hover.spanEnd(縦中横)', 'hover.startMissing()']);
});

test('the hover of the other annotations, and of a ruby', () => {
  assert.deepEqual(hover('［＃２字下げ］本文', '［＃'), { lines: ['hover.indent(２)'], over: '［＃２字下げ］', link: 'layout_2.html#ichigyo' });
  assert.deepEqual(hover('本文［＃２字下げ］', '［＃'), { lines: ['hover.indent(２)'], over: '［＃２字下げ］', link: 'layout_2.html#ichigyo' });
  assert.deepEqual(hover('［＃改ページ］', '改'), { lines: ['hover.pageBreak()'], over: '［＃改ページ］', link: 'layout_1.html#kaipage' });
  assert.deepEqual(hover('［＃ここに「タイトル」の値を表示］', 'タイトル'), { lines: ['hover.value(タイトル)'], over: '［＃ここに「タイトル」の値を表示］' });
  assert.deepEqual(hover(`なに${gaijiOf('⁉')}`, '※'), { lines: ['hover.gaiji(⁉)'], over: gaijiOf('⁉'), link: 'external_character.html' });
  assert.deepEqual(hover('あ［＃メモ］い', 'メモ'), { lines: ['hover.comment()'], over: '［＃メモ］', link: 'index.html' });
  assert.deepEqual(hover('あ［＃メモ', 'メモ'), { lines: ['hover.broken()'], over: '［＃メモ' });
  assert.deepEqual(hover('山田《やまだ》', 'やまだ'), { lines: ['hover.ruby(やまだ)', 'hover.rubyBase(山田)'], over: '《やまだ》', link: 'etc.html#ruby' });
  assert.deepEqual(hover('｜お茶の間《おちゃのま》', 'おちゃのま')?.lines, ['hover.ruby(おちゃのま)', 'hover.rubyBase(お茶の間)']);
  assert.deepEqual(hover('｜山［＃「山」に傍点］田《やまだ》', 'やまだ')?.lines, ['hover.ruby(やまだ)', 'hover.rubyBase(山田)']);
  // A reading a 縦中横 took: no ruby, so no base line.
  assert.deepEqual(hover('［＃縦中横］１２《じゅうに》［＃縦中横終わり］', 'じゅうに')?.lines, ['hover.ruby(じゅうに)']);
  assert.equal(hover('山田《やまだ》', '山田'), null);
  assert.equal(hover('本文だけ', '本文'), null);
});

/** The ranges lit at `needle`, as the text under each. */
function lit(src: string, needle: string, nth = 0, into = 0): string[] {
  const d = doc(src);
  return highlightsAt(d, parse(src), posOf(src, needle, nth, into)).map((h) => d.getText(h.range));
}

test('what lights up: an annotation with what it relates to, the body with the postfixes over it', () => {
  const src = '山田さん［＃「山田」に傍点］［＃「山田さん」は太字］と［＃傍線］王都［＃傍線終わり］。';
  assert.deepEqual(lit(src, '傍点'), ['山田', '山田']); // the 「…」, then the body
  assert.deepEqual(lit(src, '太字'), ['山田さん', '山田さん']);
  assert.deepEqual(lit(src, '山田'), ['山田', '山田', '山田さん', '山田さん']);
  assert.deepEqual(lit(src, 'さん'), ['山田さん', '山田さん']);
  assert.deepEqual(lit(src, '［＃傍線］'), []); // the cursor before the start is on the text before it
  assert.deepEqual(lit(src, '［＃傍線］', 0, 1), ['［＃傍線］', '［＃傍線終わり］']);
  assert.deepEqual(lit(src, '傍線終わり'), ['［＃傍線終わり］', '［＃傍線］']);
  assert.deepEqual(lit(src, '王都'), ['［＃傍線］', '［＃傍線終わり］']); // the cursor right after the start
  assert.deepEqual(lit(src, '王都', 0, 1), []);
  assert.deepEqual(lit('山田［＃「太郎」に傍点］', '傍点'), ['［＃「太郎」に傍点］']);
  assert.deepEqual(lit('［＃斜体］だけ', '斜体'), ['［＃斜体］']);
  assert.deepEqual(lit('［＃縦中横］12［＃縦中横終わり］', '［＃縦中横］'), ['［＃縦中横］', '12', '［＃縦中横終わり］']);
  assert.deepEqual(lit('山田《やまだ》', 'やまだ'), ['《やまだ》', '山田']);
});

/** What a rename at `needle` prepares: the text the editor selects and the placeholder. */
function prepare(src: string, needle: string, nth = 0, into = 0): [string, string] | null {
  const d = doc(src);
  const result = prepareRenameAt(d, parse(src), posOf(src, needle, nth, into));
  return result === null ? null : [d.getText(result.range), result.placeholder];
}

/** The source after renaming the symbol at `needle` to `newName`; null when nothing is renamed. */
function renamed(src: string, needle: string, newName: string, nth = 0, into = 0): string | null {
  const d = doc(src);
  const edit = renameAt(d, parse(src), posOf(src, needle, nth, into), newName);
  return edit === null ? null : TextDocument.applyEdits(d, edit.changes?.[d.uri] ?? []);
}

test('a rename on the annotation or on the body rewrites both, every 「…」 over that body with them', () => {
  const src = '　山田さん［＃「山田」に傍点］［＃「山田」は太字］［＃「山田さん」に傍線］が来た。';
  assert.deepEqual(prepare(src, '傍点'), ['山田', '山田']);
  assert.deepEqual(prepare(src, '「山田」', 1, 1), ['山田', '山田']);
  assert.deepEqual(prepare(src, '山田'), ['山田', '山田']); // the innermost body range
  assert.deepEqual(prepare(src, 'さん'), ['山田さん', '山田さん']);
  assert.deepEqual(prepare(src, 'さん', 0, 2), ['山田さん', '山田さん']); // touching the end
  const out = '　太郎さん［＃「太郎」に傍点］［＃「太郎」は太字］［＃「太郎さん」に傍線］が来た。';
  assert.equal(renamed(src, '傍点', '太郎'), out);
  assert.equal(renamed(src, '山田', '太郎'), out);
  assert.equal(renamed(src, '太字', '太郎'), out);
  assert.equal(renamed(src, 'さん', '花子だ'), '　花子だ［＃「山田」に傍点］［＃「山田」は太字］［＃「花子だ」に傍線］が来た。');
  assert.deepEqual(parse(out).issues, []);
});

test('nothing is renamed where the 「…」 is not written as the body, or off both', () => {
  for (const [src, needle] of [
    ['山田《やまだ》さん［＃「山田さん」に傍点］', '傍点'],
    ['山田《やまだ》さん［＃「山田さん」に傍点］', 'さん'],
    ['｜山田［＃「山田」に傍点］《やまだ》', '傍点'],
    ['山田［＃「太郎」に傍点］', '傍点'],
    ['山田［＃「太郎」に傍点］', '山田'],
    ['［＃傍点］山田［＃傍点終わり］', '山田'],
    ['山田［＃「山田」に傍点］をと', 'と'], // on text it does not name
  ] as const) {
    assert.equal(prepare(src, needle), null, `${src} at ${needle}`);
    assert.equal(renamed(src, needle, '太郎'), null, `${src} at ${needle}`);
  }
  assert.deepEqual(prepare('山田［＃「山田」に傍点］', '］'), ['山田', '山田']);
  assert.deepEqual(prepare('山田［＃「山田」に傍点］', '］', 0, 1), ['山田', '山田']); // the cursor after the annotation
  for (const bad of ['', '太\n郎', '太「郎', '太《郎》', '｜太郎', '太［郎']) {
    assert.equal(renamed('山田［＃「山田」に傍点］', '傍点', bad), null, JSON.stringify(bad));
  }
});
