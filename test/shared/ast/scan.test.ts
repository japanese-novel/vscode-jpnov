/**
 * The scanner: what each stretch of source becomes in the syntax layer, where it sits, and what
 * an annotation is made of.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GAIJI, INDENT_MAX, VALUE_NAMES, indentAnnotation, valueAnnotation } from '../../../src/shared/ast/notation.ts';
import { parse } from '../../../src/shared/ast/parse.ts';
import { scan } from '../../../src/shared/ast/scan.ts';

import { at, blockIndent, blockOf, contentOf, facts, gaijiOf, issuesOf, kinds, lineShapes, nodeOf, nodesOf, shape } from './_shape.ts';
import { D } from '../_kana.ts';
import { inLinearTime } from '../_timing.ts';

// --------------------------------------------------------------- lines

test('a source always has a last line; an empty one is a line of no nodes', () => {
  assert.deepEqual(scan('').lines, [{ index: 0, span: { start: 0, end: 0 }, eol: '', syntax: [] }]);
  assert.deepEqual(scan('あ\n').lines.map((l) => [l.index, l.span, l.eol, l.syntax.length]), [
    [0, { start: 0, end: 1 }, '\n', 1],
    [1, { start: 2, end: 2 }, '', 0],
  ]);
});

test('a line ends at \\n, \\r\\n or a lone \\r — the line model of the editor', () => {
  const src = 'あ\r\nい\rう\nえ';
  assert.deepEqual(
    scan(src).lines.map((l) => [src.slice(l.span.start, l.span.end), l.eol]),
    [['あ', '\r\n'], ['い', '\r'], ['う', '\n'], ['え', '']],
  );
  // \r\r\n is a lone \r, then a \r\n.
  assert.deepEqual(scan('あ\r\r\nい').lines.map((l) => l.eol), ['\r', '\r\n', '']);
});

test('a node never holds a line break; its text is the source slice of its span', () => {
  const src = '彼は「こんにちは」と\r\n言った［＃メモ］\n';
  for (const node of nodesOf(src)) {
    assert.equal(node.text, src.slice(node.span.start, node.span.end));
    assert.doesNotMatch(node.text, /[\r\n]/);
  }
});

// --------------------------------------------------------------- text and ruby

test('plain text is one text node; 「」 dialogue is ordinary text', () => {
  assert.deepEqual(shape('ただの本文'), ['text ただの本文']);
  assert.deepEqual(kinds('彼は「こんにちは」と言った'), ['text']);
});

test('an explicit ruby is the ｜, the base nodes, the 《reading》', () => {
  const src = '彼は｜走《はし》った';
  assert.deepEqual(shape(src), ['text 彼は', 'rubyMark ｜', 'text 走', 'rubyReading 《はし》', 'text った']);
  const reading = nodeOf(src, 'rubyReading');
  assert.deepEqual([reading.implicit, reading.reading, reading.base], [
    false,
    { span: at(src, 'はし'), text: 'はし' },
    at(src, '｜走'), // from the ｜ up to the 《
  ]);
});

test('a ｜ that gets no reading stays text', () => {
  assert.deepEqual(shape('これは｜です'), ['text これは｜です']);
  assert.deepEqual(shape('終わり｜'), ['text 終わり｜']);
  assert.deepEqual(shape('｜漢字《》'), ['text ｜漢字《》']); // an empty reading
  assert.deepEqual(shape('｜《よみ》'), ['text ｜《よみ》']); // an empty base
});

test('the last ｜ before a 《 wins; an earlier one stays text', () => {
  assert.deepEqual(shape('a｜b｜c《r》'), ['text a｜b', 'rubyMark ｜', 'text c', 'rubyReading 《r》']);
});

test('an implicit ruby carves its base out of the text before it', () => {
  const src = '前置き漢字《かんじ》';
  assert.deepEqual(shape(src), ['text 前置き', 'base 漢字', 'rubyReading 《かんじ》']);
  const reading = nodeOf(src, 'rubyReading');
  assert.deepEqual([reading.implicit, reading.reading.text, reading.base], [true, 'かんじ', at(src, '漢字')]);
  assert.deepEqual(shape('漢字《》です'), ['text 漢字《》です']); // an empty 《》 makes no ruby
});

test('an unmatched 《 stays text; nothing pairs across a line break', () => {
  assert.deepEqual(shape('これは《壊れた'), ['text これは《壊れた']);
  assert.deepEqual(lineShapes('例《。\nルビ》'), [['text 例《。'], ['text ルビ》']]);
  assert.deepEqual(lineShapes('｜語\n《ルビ》'), [['text ｜語'], ['text 《ルビ》']]);
  assert.deepEqual(lineShapes('［＃こわれ\n漢字《かんじ》'), [
    ['brokenAnnotation ［＃こわれ'],
    ['base 漢字', 'rubyReading 《かんじ》'],
  ]);
});

test('an implicit base of any length is found whole, and the text before a 《 is read once', () => {
  for (const base of ['漢'.repeat(63), '漢'.repeat(64), '漢'.repeat(65), '漢'.repeat(500), `${'あ'.repeat(70)}\u3099`, '𠮷'.repeat(40)]) {
    const src = `。${base}《よみ》`;
    assert.deepEqual(shape(src), ['text 。', `base ${base}`, 'rubyReading 《よみ》'], String(base.length));
  }
  // A cluster cut at a stretch's edge never ends the base: 64 code units back lands inside this 𠮷.
  const astral = `。${'漢'.repeat(63)}𠮷${'漢'.repeat(30)}《よみ》`;
  assert.deepEqual(shape(astral).slice(1), [`base ${'漢'.repeat(63)}𠮷${'漢'.repeat(30)}`, 'rubyReading 《よみ》']);
  inLinearTime('a line of readings with no base is read in linear time', () => scan('。《!?》'.repeat(20_000)));
});

/** An explicit base may hold annotations; a ｜ that meets no reading on its line comes out as typed. */
const EXPLICIT_CASES: readonly [string, string[]][] = [
  ['｜山田［＃「山田」に傍点］《やまだ》', ['rubyMark ｜', 'text 山田', 'emphasisPostfix ［＃「山田」に傍点］', 'rubyReading 《やまだ》']],
  ['｜［＃ここに「タイトル」の値を表示］《たいとる》', ['rubyMark ｜', 'valueField ［＃ここに「タイトル」の値を表示］', 'rubyReading 《たいとる》']],
  ['あ｜山田［＃x］太郎《やまだたろう》は', ['text あ', 'rubyMark ｜', 'text 山田', 'comment ［＃x］', 'text 太郎', 'rubyReading 《やまだたろう》', 'text は']],
  ['｜［＃傍点］山田［＃傍点終わり］《やまだ》', ['rubyMark ｜', 'emphasisSpanStart ［＃傍点］', 'text 山田', 'emphasisSpanEnd ［＃傍点終わり］', 'rubyReading 《やまだ》']],
  // No reading on the line, an empty 《》, a later ｜ (last wins), a broken ［＃, or nothing
  // visible before the 《: the ｜ and what followed it come out as typed.
  ['｜山田［＃x］', ['text ｜山田', 'comment ［＃x］']],
  ['｜a［＃x］《》b', ['text ｜a', 'comment ［＃x］', 'text 《》b']],
  ['｜a［＃x］｜b《r》', ['text ｜a', 'comment ［＃x］', 'rubyMark ｜', 'text b', 'rubyReading 《r》']],
  ['｜山田［＃こわれ《やまだ》', ['text ｜山田', 'brokenAnnotation ［＃こわれ《やまだ》']],
  ['｜［＃メモ］《よみ》', ['text ｜', 'comment ［＃メモ］', 'text 《よみ》']],
  // A 縦中横 span edge ends the base: the ｜ turns text on either side of it.
  ['［＃縦中横］｜1［＃縦中横終わり］2《いち》', ['tcySpanStart ［＃縦中横］', 'text ｜1', 'tcySpanEnd ［＃縦中横終わり］', 'base 2', 'rubyReading 《いち》']],
  ['｜［＃縦中横］12［＃縦中横終わり］《じゅうに》', ['text ｜', 'tcySpanStart ［＃縦中横］', 'text 12', 'tcySpanEnd ［＃縦中横終わり］', 'text 《じゅうに》']],
  // A 終わり with no span open, or a start inside one, changes nothing: it is no edge (#147).
  ['｜山田［＃縦中横終わり］太郎《やまだたろう》', ['rubyMark ｜', 'text 山田', 'tcySpanEnd ［＃縦中横終わり］', 'text 太郎', 'rubyReading 《やまだたろう》']],
  ['［＃縦中横］1｜2［＃縦中横］3《さん》［＃縦中横終わり］', ['tcySpanStart ［＃縦中横］', 'text 1', 'rubyMark ｜', 'text 2', 'tcySpanStart ［＃縦中横］', 'text 3', 'rubyReading 《さん》', 'tcySpanEnd ［＃縦中横終わり］']],
];

test('an explicit ruby holds the annotations inside its base; a ｜ without a reading stays typed', () => {
  for (const [src, expected] of EXPLICIT_CASES) {
    assert.deepEqual(shape(src), expected, JSON.stringify(src));
  }
});

// --------------------------------------------------------------- annotations

test('a closed ［＃…］ nothing recognizes is a comment; the FIRST ］ closes it', () => {
  assert.deepEqual(kinds('前［＃メモ］後'), ['text', 'comment', 'text']);
  // The inner is never re-scanned: a ［＃-looking run inside stays inside, the leftover ］ is text.
  const src = '［＃注 ［＃ネスト］あと］';
  assert.deepEqual(shape(src), ['comment ［＃注 ［＃ネスト］', 'text あと］']);
  assert.deepEqual(nodeOf(src, 'comment').inner, { span: at(src, '注 ［＃ネスト'), text: '注 ［＃ネスト' });
  assert.deepEqual(shape('閉じ括弧だけの］行'), ['text 閉じ括弧だけの］行']);
});

test('a 外字注記 is one node from its ※ to its ］, standing for its character', () => {
  for (const [inner, char] of Object.entries(GAIJI)) {
    const src = `前※［＃${inner}］後`;
    assert.deepEqual(shape(src), ['text 前', `gaiji ※［＃${inner}］`, 'text 後'], src);
    assert.equal(nodeOf(src, 'gaiji').char, char, src);
  }
  const mark = gaijiOf('⁉');
  assert.deepEqual(shape(mark), [`gaiji ${mark}`]); // at a line head
  assert.deepEqual(shape(`※${mark}${mark}`), ['text ※', `gaiji ${mark}`, `gaiji ${mark}`]);
  assert.deepEqual(shape(`［＃３字下げ］${mark}`), ['indent ［＃３字下げ］', `gaiji ${mark}`]);
  // The 二重山括弧 are brackets: neither half opens or closes a ruby, alone or as a pair.
  const [open, close] = [gaijiOf('《'), gaijiOf('》')];
  assert.deepEqual(shape(`スキル${open}聖剣${close}`), ['text スキル', `gaiji ${open}`, 'text 聖剣', `gaiji ${close}`]);
  assert.deepEqual(shape(`スキル${open}聖剣》`), ['text スキル', `gaiji ${open}`, 'text 聖剣》']);
  assert.deepEqual(shape(`スキル《聖剣${close}`), ['text スキル《聖剣', `gaiji ${close}`]);
  assert.deepEqual(issuesOf(`スキル${open}聖剣${close}`), []);
});

test('any other ※ is text, and what follows it is what it was', () => {
  const cases: readonly [src: string, shape: string[]][] = [
    ['［＃感嘆符疑問符、1-8-78］', ['comment ［＃感嘆符疑問符、1-8-78］']], // no ※
    ['※　［＃感嘆符疑問符、1-8-78］', ['text ※　', 'comment ［＃感嘆符疑問符、1-8-78］']], // not directly after it
    ['※［＃感嘆符疑問符］', ['text ※', 'comment ［＃感嘆符疑問符］']],
    ['※［＃感嘆符疑問符、1-8-79］', ['text ※', 'comment ［＃感嘆符疑問符、1-8-79］']],
    ['※［＃感嘆符疑問符、１－８－７８］', ['text ※', 'comment ［＃感嘆符疑問符、１－８－７８］']],
    ['※［＃二の字点、1-2-22］', ['text ※', 'comment ［＃二の字点、1-2-22］']], // a 外字注記 the notation does not list
    ['※［＃改ページ］', ['text ※', 'pageBreak ［＃改ページ］']],
    ['※［＃感嘆符疑問符、1-8-78', ['text ※', 'brokenAnnotation ［＃感嘆符疑問符、1-8-78']],
    ['※', ['text ※']],
  ];
  for (const [src, expected] of cases) {
    assert.deepEqual(shape(src), expected, src);
  }
});

test('an unclosed ［＃ is one brokenAnnotation up to its line end', () => {
  assert.deepEqual(shape('これは［＃壊れた'), ['text これは', 'brokenAnnotation ［＃壊れた']);
  assert.deepEqual(lineShapes('壊れ［＃注\n次'), [['text 壊れ', 'brokenAnnotation ［＃注'], ['text 次']]);
  assert.deepEqual(lineShapes('［＃注\n終わり］'), [['brokenAnnotation ［＃注'], ['text 終わり］']]);
  assert.deepEqual(shape('［＃あ［＃い'), ['brokenAnnotation ［＃あ［＃い']);
  assert.deepEqual(lineShapes('［＃\n次'), [['brokenAnnotation ［＃'], ['text 次']]);
  // The terminator is never part of it, whichever it is.
  assert.deepEqual(lineShapes('［＃注\r\n次'), [['brokenAnnotation ［＃注'], ['text 次']]);
  assert.deepEqual(lineShapes('［＃注\r終わり］'), [['brokenAnnotation ［＃注'], ['text 終わり］']]);
});

test('改ページ is a pageBreak', () => {
  assert.deepEqual(shape('前［＃改ページ］後'), ['text 前', 'pageBreak ［＃改ページ］', 'text 後']);
});

/** ［＃○字下げ］ with `digits` as written. */
const indentOf = (digits: string): string => `［＃${digits}字下げ］`;

test('a ［＃○字下げ］ is an indent (full-width digits, up to INDENT_MAX)', () => {
  assert.deepEqual(facts(nodeOf('［＃３字下げ］本文', 'indent')), { kind: 'indent', text: '［＃３字下げ］', amount: 3 });
  assert.equal(nodeOf('　まくら\n［＃２字下げ］次', 'indent').amount, 2); // the head of a later line
  assert.equal(nodeOf(`${indentAnnotation(INDENT_MAX)}x`, 'indent').amount, INDENT_MAX);
  assert.deepEqual(kinds(`${indentAnnotation(INDENT_MAX + 1)}x`), ['comment', 'text']);
  // The value decides, not the number of digits.
  assert.equal(nodeOf(`${indentOf('０'.repeat(400) + '３')}x`, 'indent').amount, 3);
  assert.deepEqual(kinds(`${indentOf('９'.repeat(400))}x`), ['comment', 'text']);
  assert.deepEqual(kinds(`${indentOf('９'.repeat(400) + '3')}x`), ['comment', 'text']); // still not digits
  assert.equal(nodeOf('［＃００３字下げ］x', 'indent').amount, 3);
  assert.equal(nodeOf('［＃０字下げ］x', 'indent').amount, 0);
});

test('a ［＃○字下げ］ is read anywhere on its line; a lone \\r starts a line like any terminator', () => {
  assert.deepEqual(shape('本文［＃３字下げ］'), ['text 本文', 'indent ［＃３字下げ］']);
  assert.deepEqual(kinds('　［＃３字下げ］'), ['text', 'indent']); // after the auto-indent space
  assert.deepEqual(kinds('A\r［＃３字下げ］'), ['text', 'indent']);
  assert.deepEqual(kinds('［＃3字下げ］'), ['comment']); // half-width
  assert.deepEqual(kinds('［＃三字下げ］'), ['comment']); // a kanji numeral
});

test('the block 字下げ pair; the 折り返して form is a comment', () => {
  const src = '［＃ここから２字下げ］\nA\n［＃ここで字下げ終わり］';
  assert.deepEqual(facts(nodeOf(src, 'indentBlockStart')), { kind: 'indentBlockStart', text: '［＃ここから２字下げ］', amount: 2 });
  assert.deepEqual(facts(nodeOf(src, 'indentBlockEnd')), { kind: 'indentBlockEnd', text: '［＃ここで字下げ終わり］' });
  assert.deepEqual(kinds('［＃ここから２字下げ、折り返して３字下げ］'), ['comment']);
  assert.deepEqual(kinds('［＃ここから2字下げ］'), ['comment']); // half-width
  assert.equal(nodeOf(blockIndent(INDENT_MAX), 'indentBlockStart').amount, INDENT_MAX);
  assert.deepEqual(kinds(blockIndent(INDENT_MAX + 1)), ['comment']);
  assert.deepEqual(kinds(blockOf(indentOf('９'.repeat(400)))), ['comment']);
});

test('a decoration span carries its variant, side and channel; the block form its flag', () => {
  assert.deepEqual(facts(nodeOf('a［＃傍点］b\nc［＃傍点終わり］d', 'emphasisSpanStart')), {
    kind: 'emphasisSpanStart', text: '［＃傍点］', variant: '傍点', left: false, channel: 'emph',
  });
  assert.deepEqual(facts(nodeOf('［＃左に波線終わり］', 'emphasisSpanEnd')), {
    kind: 'emphasisSpanEnd', text: '［＃左に波線終わり］', variant: '波線', left: true, channel: 'line',
  });
  assert.deepEqual(facts(nodeOf('［＃ここから太字］', 'emphasisSpanStart')), {
    kind: 'emphasisSpanStart', text: '［＃ここから太字］', variant: '太字', left: false, channel: 'weight', block: true,
  });
  assert.deepEqual(facts(nodeOf('［＃ここで斜体終わり］', 'emphasisSpanEnd')), {
    kind: 'emphasisSpanEnd', text: '［＃ここで斜体終わり］', variant: '斜体', left: false, channel: 'style', block: true,
  });
  // The inline 太字/斜体 carry no block flag.
  assert.deepEqual(facts(nodeOf('あ［＃太字］い［＃太字終わり］', 'emphasisSpanEnd')), {
    kind: 'emphasisSpanEnd', text: '［＃太字終わり］', variant: '太字', left: false, channel: 'weight',
  });
});

test('傍点/傍線 have no block form', () => {
  assert.deepEqual(kinds('［＃ここから傍点］'), ['comment']);
  assert.deepEqual(kinds('［＃ここで傍点終わり］'), ['comment']);
});

test('a decoration postfix carries its target; the connector follows the channel', () => {
  const src = '文［＃「文」に傍線］';
  assert.deepEqual(facts(nodeOf(src, 'emphasisPostfix')), {
    kind: 'emphasisPostfix', text: '［＃「文」に傍線］', target: '文', variant: '傍線', left: false, channel: 'line',
  });
  assert.deepEqual(nodeOf(src, 'emphasisPostfix').target, { span: at(src, '文', 1), text: '文' });
  assert.deepEqual(facts(nodeOf('語［＃「語」の左に傍線］', 'emphasisPostfix')), {
    kind: 'emphasisPostfix', text: '［＃「語」の左に傍線］', target: '語', variant: '傍線', left: true, channel: 'line',
  });
  assert.deepEqual(facts(nodeOf('重要［＃「重要」は太字］', 'emphasisPostfix')), {
    kind: 'emphasisPostfix', text: '［＃「重要」は太字］', target: '重要', variant: '太字', left: false, channel: 'weight',
  });
  assert.deepEqual(kinds('x［＃「x」傍点］'), ['text', 'emphasisPostfix']); // 傍点 without に is accepted
});

test('connector × channel mismatches are comments', () => {
  assert.deepEqual(kinds('x［＃「x」太字］'), ['text', 'comment']); // 太字 needs は
  assert.deepEqual(kinds('x［＃「x」は傍点］'), ['text', 'comment']); // は + 傍点
  assert.deepEqual(kinds('x［＃「x」に太字］'), ['text', 'comment']); // に + 太字
  assert.deepEqual(kinds('x［＃「x」のばつ傍点］'), ['text', 'comment']); // a lone の
  assert.deepEqual(kinds('x［＃「x」の左に太字］'), ['text', 'comment']); // 太字 has no side
  assert.deepEqual(kinds('x［＃「」に傍点］'), ['text', 'comment']); // an empty target
});

test('the left prefix is form-bound — a postfix takes の左に only, a span takes 左に only', () => {
  // The Aozora spec never writes a postfix with bare 左に nor a span with の左に; the wrong
  // spelling is a comment here and in the tmLanguage alike.
  assert.deepEqual(kinds('対象［＃「対象」左に傍線］'), ['text', 'comment']);
  assert.deepEqual(kinds('［＃の左に傍線］'), ['comment']);
  assert.deepEqual(kinds('［＃の左に傍線終わり］'), ['comment']);
  assert.deepEqual(kinds('対象［＃「対象」にの左に傍点］'), ['text', 'comment']); // a connector and a prefix never combine
});

test('左ルビ carries its target and its reading', () => {
  const src = '青空文庫《あおぞらぶんこ》［＃「青空文庫」の左に「aozora bunko」のルビ］';
  assert.deepEqual(kinds(src), ['text', 'rubyReading', 'rubyLeftPostfix']);
  const node = nodeOf(src, 'rubyLeftPostfix');
  assert.deepEqual(facts(node), {
    kind: 'rubyLeftPostfix', text: '［＃「青空文庫」の左に「aozora bunko」のルビ］', target: '青空文庫', reading: 'aozora bunko',
  });
  assert.deepEqual(node.reading, { span: at(src, 'aozora bunko'), text: 'aozora bunko' });
});

test('左ルビ is a comment on every malformed shape', () => {
  assert.deepEqual(kinds('［＃「」の左に「よみ」のルビ］'), ['comment']); // an empty target
  assert.deepEqual(kinds('対象［＃「対象」の左に「」のルビ］'), ['text', 'comment']); // an empty reading
  assert.deepEqual(kinds('対象［＃「対象」の左に「よ「み」のルビ］'), ['text', 'comment']); // a corner inside the reading
  assert.deepEqual(kinds('対象［＃「対象」の左に「よみ」の注記］'), ['text', 'comment']); // the 注記 family
  assert.deepEqual(kinds('対象［＃「対象」の左に「よみ」］'), ['text', 'comment']); // no のルビ tail
  assert.deepEqual(kinds('対象［＃「対象」左に「よみ」のルビ］'), ['text', 'comment']); // bare 左に
  assert.deepEqual(kinds('対象［＃「対象」に「よみ」のルビ］'), ['text', 'comment']); // no right-side form exists
});

test('縦中横: the span pair, and the postfix with its は', () => {
  assert.deepEqual(shape('序［＃縦中横］12［＃縦中横終わり］年'), [
    'text 序', 'tcySpanStart ［＃縦中横］', 'text 12', 'tcySpanEnd ［＃縦中横終わり］', 'text 年',
  ]);
  assert.deepEqual(facts(nodeOf('米機Ｂ29［＃「29」は縦中横］', 'tcyPostfix')), {
    kind: 'tcyPostfix', text: '［＃「29」は縦中横］', target: '29',
  });
  assert.deepEqual(kinds('29［＃「29」に縦中横］'), ['text', 'comment']);
  assert.deepEqual(kinds('29［＃「29」縦中横］'), ['text', 'comment']);
  assert.deepEqual(kinds('A［＃「」は縦中横］'), ['text', 'comment']);
  assert.deepEqual(kinds('［＃ここから縦中横］'), ['comment']); // no block form
  assert.deepEqual(kinds('［＃ここで縦中横終わり］'), ['comment']);
});

test('見出し: the postfix, the inline pair and the block pair carry their level (大 = 1)', () => {
  assert.deepEqual(facts(nodeOf('第一章［＃「第一章」は大見出し］', 'headingPostfix')), {
    kind: 'headingPostfix', text: '［＃「第一章」は大見出し］', target: '第一章', level: 1,
  });
  assert.equal(nodeOf('一［＃「一」は中見出し］', 'headingPostfix').level, 2);
  assert.equal(nodeOf('一［＃「一」は小見出し］', 'headingPostfix').level, 3);
  assert.deepEqual(facts(nodeOf('［＃大見出し］', 'headingSpanStart')), { kind: 'headingSpanStart', text: '［＃大見出し］', level: 1 });
  assert.deepEqual(facts(nodeOf('［＃中見出し終わり］', 'headingSpanEnd')), { kind: 'headingSpanEnd', text: '［＃中見出し終わり］', level: 2 });
  assert.deepEqual(facts(nodeOf('［＃ここから中見出し］', 'headingSpanStart')), {
    kind: 'headingSpanStart', text: '［＃ここから中見出し］', level: 2, block: true,
  });
  assert.deepEqual(facts(nodeOf('［＃ここで小見出し終わり］', 'headingSpanEnd')), {
    kind: 'headingSpanEnd', text: '［＃ここで小見出し終わり］', level: 3, block: true,
  });
});

test('見出し near-miss spellings are comments', () => {
  assert.deepEqual(kinds('一［＃「一」に大見出し］'), ['text', 'comment']);
  assert.deepEqual(kinds('一［＃「一」大見出し］'), ['text', 'comment']);
  assert.deepEqual(kinds('［＃「」は大見出し］'), ['comment']);
  assert.deepEqual(kinds('［＃見出し］'), ['comment']); // no bare 見出し literal
  assert.deepEqual(kinds('［＃大見出し終り］'), ['comment']); // wrong okurigana
  assert.deepEqual(kinds('［＃ここから大見出し終わり］'), ['comment']); // mixed scaffolding
});

test('値の表示 takes ANY non-empty name; an empty pair is a comment', () => {
  for (const name of [...Object.values(VALUE_NAMES), '発行日', '13', 'a」b']) {
    const src = valueAnnotation(name);
    assert.deepEqual(nodesOf(src).map(facts), [{ kind: 'valueField', text: src, name }]);
    assert.deepEqual(nodeOf(src, 'valueField').name.span, at(src, name));
  }
  assert.deepEqual(kinds('［＃ここに「」の値を表示］'), ['comment']);
  assert.deepEqual(kinds('［＃ここに「タイトル」の値］'), ['comment']); // a truncated tail
  assert.deepEqual(kinds('［＃ここにタイトルの値を表示］'), ['comment']); // no corner quotes
  assert.deepEqual(kinds('全［＃ここに「総ページ数」の値を表示］ページ'), ['text', 'valueField', 'text']);
});

test('値の表示 under a function: the name up to the last 」の値を, the function to the final で表示; neither empty', () => {
  for (const format of ['位取り', '命数', '漢数字', 'a」b', '値を', '表示']) {
    for (const name of [...Object.values(VALUE_NAMES), '発行日', '13', 'a」b', 'a」の値をb']) {
      const src = valueAnnotation(name, format);
      assert.deepEqual(nodesOf(src).map(facts), [{ kind: 'valueField', text: src, name, format }], src);
      const field = nodeOf(src, 'valueField');
      assert.deepEqual(field.name.span, at(src, name), src);
      assert.ok(field.format !== undefined, src);
      assert.deepEqual(field.format.span, { start: src.length - 'で表示］'.length - format.length, end: src.length - 'で表示］'.length }, src);
    }
  }
  assert.equal(nodeOf(valueAnnotation('13'), 'valueField').format, undefined);
  assert.deepEqual(kinds('［＃ここに「」の値を命数で表示］'), ['comment']);
  assert.deepEqual(kinds('［＃ここに「13」の値をで表示］'), ['comment']);
  assert.deepEqual(kinds('［＃ここに「13」の値を命数表示］'), ['comment']); // no で
  assert.deepEqual(kinds('［＃ここに「13」命数で表示］'), ['comment']); // no の値を
  assert.deepEqual(kinds('［＃ここに「13」の値を命数で］'), ['comment']); // a truncated tail
  assert.deepEqual(kinds('［＃ここに13の値を命数で表示］'), ['comment']); // no corner quotes
  assert.deepEqual(kinds('全［＃ここに「総ページ数」の値を命数で表示］ページ'), ['text', 'valueField', 'text']);
  assert.deepEqual(
    nodeOf('［＃ここに「総ページ数」の値を命数で表示］', 'valueField').parts.map((p) => [p.role, p.text]),
    [['bracket', '［＃'], ['scaffold', 'ここに'], ['corner', '「'], ['name', '総ページ数'], ['corner', '」'], ['scaffold', 'の値を'], ['keyword', '命数'], ['scaffold', 'で表示'], ['bracket', '］']],
  );
});

test('値の表示: an Object.prototype name is a name like any other, never a lookup hazard', () => {
  // The name comes from the document: a plain object lookup would resolve these through the
  // prototype chain and substitute a function.
  for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const src = valueAnnotation(name);
    assert.equal(nodeOf(src, 'valueField').name.text, name);
    assert.deepEqual(contentOf(src), [[`value ${name}`]]);
    assert.doesNotThrow(() => parse(`［＃縦中横］${src}［＃縦中横終わり］`));
  }
});

// --------------------------------------------------------------- parts

/** The parts of the first annotation of `src`, as `role text`. */
const parts = (src: string): string[] => {
  const node = nodesOf(src).find((n) => 'parts' in n);
  assert.ok(node !== undefined && 'parts' in node);
  for (const part of node.parts) {
    assert.equal(part.text, src.slice(part.span.start, part.span.end));
  }
  // The parts tile the node: each starts where the one before it ended.
  assert.equal(node.parts.map((p) => p.text).join(''), node.text);
  return node.parts.map((p) => `${p.role} ${p.text}`);
};

const PART_CASES: readonly [string, string[]][] = [
  ['［＃改ページ］', ['bracket ［＃', 'keyword 改ページ', 'bracket ］']],
  ['［＃３字下げ］', ['bracket ［＃', 'keyword ３字下げ', 'bracket ］']],
  ['［＃ここから２字下げ］', ['bracket ［＃', 'scaffold ここから', 'keyword ２字下げ', 'bracket ］']],
  ['［＃ここで字下げ終わり］', ['bracket ［＃', 'scaffold ここで', 'keyword 字下げ', 'scaffold 終わり', 'bracket ］']],
  ['［＃傍点］', ['bracket ［＃', 'keyword 傍点', 'bracket ］']],
  ['［＃左に二重傍線終わり］', ['bracket ［＃', 'direction 左に', 'keyword 二重傍線', 'scaffold 終わり', 'bracket ］']],
  ['［＃ここから太字］', ['bracket ［＃', 'scaffold ここから', 'keyword 太字', 'bracket ］']],
  ['［＃ここで斜体終わり］', ['bracket ［＃', 'scaffold ここで', 'keyword 斜体', 'scaffold 終わり', 'bracket ］']],
  ['［＃「語」に傍点］', ['bracket ［＃', 'corner 「', 'target 語', 'corner 」', 'connector に', 'keyword 傍点', 'bracket ］']],
  ['［＃「語」傍点］', ['bracket ［＃', 'corner 「', 'target 語', 'corner 」', 'keyword 傍点', 'bracket ］']],
  ['［＃「語」の左に傍線］', ['bracket ［＃', 'corner 「', 'target 語', 'corner 」', 'direction の左に', 'keyword 傍線', 'bracket ］']],
  ['［＃「語」は太字］', ['bracket ［＃', 'corner 「', 'target 語', 'corner 」', 'connector は', 'keyword 太字', 'bracket ］']],
  ['［＃縦中横］', ['bracket ［＃', 'keyword 縦中横', 'bracket ］']],
  ['［＃縦中横終わり］', ['bracket ［＃', 'keyword 縦中横', 'scaffold 終わり', 'bracket ］']],
  ['［＃「12」は縦中横］', ['bracket ［＃', 'corner 「', 'target 12', 'corner 」', 'connector は', 'keyword 縦中横', 'bracket ］']],
  ['［＃「字」の左に「よみ」のルビ］', [
    'bracket ［＃', 'corner 「', 'target 字', 'corner 」', 'direction の左に', 'corner 「', 'reading よみ', 'corner 」', 'keyword のルビ', 'bracket ］',
  ]],
  ['［＃「序章」は大見出し］', ['bracket ［＃', 'corner 「', 'target 序章', 'corner 」', 'connector は', 'keyword 大見出し', 'bracket ］']],
  ['［＃中見出し］', ['bracket ［＃', 'keyword 中見出し', 'bracket ］']],
  ['［＃ここで小見出し終わり］', ['bracket ［＃', 'scaffold ここで', 'keyword 小見出し', 'scaffold 終わり', 'bracket ］']],
  ['［＃ここに「タイトル」の値を表示］', ['bracket ［＃', 'scaffold ここに', 'corner 「', 'name タイトル', 'corner 」', 'scaffold の値を表示', 'bracket ］']],
  ['［＃メモ］', ['bracket ［＃', 'inner メモ', 'bracket ］']],
  ['※［＃感嘆符疑問符、1-8-78］', ['bracket ※', 'bracket ［＃', 'keyword 感嘆符疑問符、1-8-78', 'bracket ］']],
  ['［＃］', ['bracket ［＃', 'bracket ］']], // an empty part is not listed
  ['漢字《かんじ》', ['bracket 《', 'reading かんじ', 'bracket 》']],
];

test('an annotation is cut into its parts, each with its own span', () => {
  for (const [src, expected] of PART_CASES) {
    assert.deepEqual(parts(src), expected, src);
  }
});

test('the parts keep their offsets wherever the annotation sits', () => {
  const src = '　彼は山田［＃「山田」に傍点］と言った。\n次の行の語［＃「語」の左に「よみ」のルビ］';
  const postfix = nodeOf(src, 'emphasisPostfix');
  assert.deepEqual(postfix.target.span, at(src, '山田', 1));
  assert.deepEqual(postfix.parts.find((p) => p.role === 'keyword')?.span, at(src, '傍点'));
  const left = nodeOf(src, 'rubyLeftPostfix');
  assert.deepEqual(left.target.span, at(src, '語', 1));
  assert.deepEqual(left.reading.span, at(src, 'よみ'));
});

// --------------------------------------------------------------- NFD kana

test('NFD: the syntax layer never composes — a decomposed kana keeps its two units', () => {
  const src = `カ${D}ラス《か${D}らす》`;
  assert.deepEqual(shape(src), [`base カ${D}ラス`, `rubyReading 《か${D}らす》`]);
  assert.equal(nodeOf(src, 'rubyReading').reading.text, `か${D}らす`);
});
