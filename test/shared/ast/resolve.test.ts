/**
 * The resolver: what a line paints (its content, in paint order, as display strings with their
 * marks) and the state it is set in. What the layout makes of it is layout.test.ts's subject.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VALUE_DEFAULTS, VALUE_NAMES, valueAnnotation } from '../../../src/shared/ast/notation.ts';
import { parse } from '../../../src/shared/ast/parse.ts';
import { printSource } from '../../../src/shared/ast/print.ts';
import { scan } from '../../../src/shared/ast/scan.ts';

import { clusterStarts } from '../../../src/shared/ast/span.ts';
import { at, boundOf, contentOf, gaijiOf, heldOf, issuesOf } from './_shape.ts';
import { BEL, D, UNSHOWN } from '../_kana.ts';
import { inLinearTime } from '../_timing.ts';

/** The content of a one-line source. */
const content = (src: string, values?: ReadonlyMap<string, string>): string[] => contentOf(src, values)[0] ?? [];

// --------------------------------------------------------------- content

test('plain text is one run; an annotation that takes no effect is a comment', () => {
  assert.deepEqual(content('ただの本文'), ['chars ただの本文']);
  assert.deepEqual(content('前［＃メモ］後'), ['chars 前', 'comment メモ', 'chars 後']);
  assert.deepEqual(content(''), []);
});

test('a ruby is one inline over its base, implicit or explicit', () => {
  assert.deepEqual(content('前置き漢字《かんじ》'), ['chars 前置き', 'ruby 漢字《かんじ》']);
  assert.deepEqual(content('彼は｜走《はし》った'), ['chars 彼は', 'ruby 走《はし》', 'chars った']);
  // A comment inside the base splits the text, not the ruby; it follows the ruby.
  assert.deepEqual(content('｜山田［＃x］太郎《やまだたろう》'), ['ruby 山田太郎《やまだたろう》', 'comment x']);
  // A dangling ［＃縦中横終わり］ does nothing, inside a base too (#147).
  assert.deepEqual(content('｜山田［＃縦中横終わり］太郎《やまだたろう》'), ['ruby 山田太郎《やまだたろう》']);
});

test('a span marks what it covers, across lines, one slot per channel', () => {
  assert.deepEqual(contentOf('a［＃傍点］b\nc［＃傍点終わり］d'), [
    ['chars a', 'chars b emph=傍点'],
    ['chars c emph=傍点', 'chars d'],
  ]);
  // Channels overlap freely; a same-channel start replaces the one in effect.
  assert.deepEqual(content('［＃傍点］あ［＃太字］い［＃傍点終わり］う［＃太字終わり］え'), [
    'chars あ emph=傍点',
    'chars い emph=傍点 weight=太字',
    'chars う weight=太字',
    'chars え',
  ]);
  assert.deepEqual(content('［＃傍点］あ［＃左に丸傍点］い'), ['chars あ emph=傍点', 'chars い emph=左に丸傍点']);
});

test('a postfix marks the LAST occurrence of its target, cutting the run around it', () => {
  assert.deepEqual(content('これは山田です［＃「山田」に傍点］'), ['chars これは', 'chars 山田 emph=傍点', 'chars です']);
  assert.deepEqual(content('山田と山田［＃「山田」は太字］'), ['chars 山田と', 'chars 山田 weight=太字']);
  // Whole cells only: a ruby inside the target takes the mark as one.
  assert.deepEqual(content('彼は山田《やまだ》さん［＃「山田さん」の左に傍線］'), [
    'chars 彼は',
    'ruby 山田《やまだ》 line=左に傍線',
    'chars さん line=左に傍線',
  ]);
  // A later postfix stacks on another channel and overwrites on its own.
  assert.deepEqual(content('語［＃「語」に傍点］［＃「語」は太字］［＃「語」に丸傍点］'), ['chars 語 emph=丸傍点 weight=太字']);
});

test('a postfix finds its target however far back on the line it sits', () => {
  // The line is read back from its end in growing stretches, and a target may straddle two.
  for (const gap of [0, 1, 61, 62, 63, 64, 65, 126, 127, 128, 129, 1000]) {
    const far = `聖剣${'あ'.repeat(gap)}［＃「聖剣」に傍点］`;
    assert.deepEqual(boundOf(far), [at(far, '聖剣')], `gap ${String(gap)}`);
    const twice = `聖剣と${'あ'.repeat(gap)}聖剣${'い'.repeat(gap)}［＃「聖剣」に傍点］`;
    assert.deepEqual(boundOf(twice), [at(twice, '聖剣', 1)], `gap ${String(gap)}, the last of two`);
    assert.deepEqual(boundOf(`王都${'あ'.repeat(gap)}［＃「聖剣」に傍点］`), [null], `gap ${String(gap)}, absent`);
  }
});

test('a later postfix for the same target sees what was written since the earlier one', () => {
  // The search for a target resumes where the last one for it left off; what it found before
  // stands until a newer occurrence is written. Each case lists what the postfixes bind, in order.
  // `at(src, '聖剣', n)`: the n-th occurrence counting the ones inside the 「…」 too.
  const newer = '聖剣あ［＃「聖剣」に傍点］聖剣い［＃「聖剣」に傍点］';
  assert.deepEqual(boundOf(newer), [at(newer, '聖剣'), at(newer, '聖剣', 2)]);
  const later = '［＃「聖剣」に傍点］聖剣［＃「聖剣」に傍点］';
  assert.deepEqual(boundOf(later), [null, at(later, '聖剣', 1)]);
  const straddle = '聖［＃「聖剣」に傍点］剣［＃「聖剣」に傍点］';
  assert.deepEqual(boundOf(straddle), [null, { start: 0, end: at(straddle, '剣', 1).end }]);
  const ruby = '［＃「聖剣」に傍点］｜聖剣《せいけん》［＃「聖剣」に傍点］';
  assert.deepEqual(boundOf(ruby), [null, { start: ruby.indexOf('｜'), end: ruby.indexOf('》') + 1 }]);
  const twice = `あ${'漢《かん》'.repeat(100)}［＃「あ」に傍点］［＃「あ」は太字］`; // a kanji base: あ stays a cell of its own
  assert.deepEqual(boundOf(twice), [at(twice, 'あ'), at(twice, 'あ')]);
  assert.deepEqual(content(twice)[0], 'chars あ emph=傍点 weight=太字');
  const across = 'い［＃「あ」に傍点］｜漢《かん》い［＃「あ」に傍点］';
  assert.deepEqual(boundOf(across), [null, null]);
});

test('a line of any number of postfixes resolves in linear time', () => {
  // Each shape read the line back to its start once per postfix before (#182).
  const far = `あ${'漢《かん》'.repeat(20_000)}`;
  const cuts = Array.from({ length: 1000 }, (_, j) => `［＃「${'い'.repeat(j + 1)}あ」に傍点］`).join('');
  for (const [name, src] of [
    ['misses', 'い［＃「あ」に傍点］'.repeat(20_000)],
    ['misses after a ｜…《》 each', '｜漢《かん》い［＃「あ」に傍点］'.repeat(10_000)],
    ['far hits', `${far}${'［＃「あ」に傍点］'.repeat(2000)}`],
    ['cuts of one long run', `${'い'.repeat(100_000)}あ${cuts}`],
  ] as const) {
    assert.equal(inLinearTime(name, () => parse(src)).lines.length, 1, name);
  }
});

test('a postfix that misses takes no effect and stays as a comment', () => {
  assert.deepEqual(content('別の文［＃「無」に傍点］'), ['chars 別の文', 'comment 「無」に傍点']);
  // 字 cuts into the ruby 漢字: a miss.
  assert.deepEqual(content('漢字《かんじ》［＃「字」に傍点］'), ['ruby 漢字《かんじ》', 'comment 「字」に傍点']);
  // A target on the previous line is out of reach.
  assert.deepEqual(contentOf('対象\n［＃「対象」に傍点］'), [['chars 対象'], ['comment 「対象」に傍点']]);
});

test('縦中横: the span and the postfix both make one cell', () => {
  assert.deepEqual(content('序［＃縦中横］12［＃縦中横終わり］年'), ['chars 序', 'tcy 12', 'chars 年']);
  assert.deepEqual(content('米機Ｂ29［＃「29」は縦中横］'), ['chars 米機Ｂ', 'tcy 29']);
  assert.deepEqual(content('［＃縦中横］12'), ['tcy 12']); // the line end closes it
  assert.deepEqual(content('［＃縦中横］［＃縦中横終わり］'), []); // nothing inside, nothing painted
  // No nesting: a broken ［＃ joins the cell as typed; a ruby loses its markup and keeps its base.
  assert.deepEqual(content('［＃縦中横］1［＃こわれ'), ['tcy 1［＃こわれ']);
  assert.deepEqual(content('［＃縦中横］漢《かん》［＃縦中横終わり］'), ['tcy 漢']);
  assert.deepEqual(content('［＃縦中横］｜山田《やまだ》［＃縦中横終わり］'), ['tcy 山田']);
  assert.deepEqual(content('［＃縦中横］｜山田［＃x］太郎《やまだたろう》［＃縦中横終わり］'), ['comment x', 'tcy 山田太郎']);
  // A ｜ the span edge cut off is text and stays in the cell; the reading after it has no base.
  assert.deepEqual(content('［＃縦中横］｜山田［＃縦中横終わり］《やまだ》'), ['tcy ｜山田', 'chars 《やまだ》']);
  // A comment inside the span comes before the cell; one inside a postfix target after it.
  assert.deepEqual(content('［＃縦中横］1［＃x］2［＃縦中横終わり］'), ['comment x', 'tcy 12']);
  assert.deepEqual(content('1［＃x］2［＃「12」は縦中横］'), ['tcy 12', 'comment x']);
  // The cell takes the marks in effect where it closes.
  assert.deepEqual(content('［＃縦中横］1［＃太字］2［＃縦中横終わり］'), ['tcy 12 weight=太字']);
  // A 縦中横 over a whole ruby replaces it.
  assert.deepEqual(content('12《じゅうに》［＃「12」は縦中横］'), ['tcy 12']);
});

test('左ルビ: over text it makes a ruby, over a ruby it joins it; anything mixed is a miss', () => {
  assert.deepEqual(content('青空文庫［＃「青空文庫」の左に「あおぞらぶんこ」のルビ］'), ['ruby 青空文庫〈あおぞらぶんこ〉']);
  assert.deepEqual(content('青空文庫《あおぞらぶんこ》［＃「青空文庫」の左に「aozora bunko」のルビ］'), [
    'ruby 青空文庫《あおぞらぶんこ》〈aozora bunko〉',
  ]);
  const mixed = '漢字《かんじ》の本［＃「漢字の本」の左に「よみ」のルビ］';
  assert.deepEqual(content(mixed), ['ruby 漢字《かんじ》', 'chars の本', 'comment 「漢字の本」の左に「よみ」のルビ']);
  const onTcy = '12［＃「12」は縦中横］［＃「12」の左に「じゅうに」のルビ］';
  assert.deepEqual(content(onTcy), ['tcy 12', 'comment 「12」の左に「じゅうに」のルビ']);
});

test('a postfix inside a ｜ base binds once the base is one ruby, as if written after it', () => {
  const same = (inside: string, after: string): void => {
    assert.deepEqual(content(inside), content(after), inside);
  };
  same('｜山田［＃「山田」に傍点］《やまだ》', '山田《やまだ》［＃「山田」に傍点］');
  same('｜12［＃「12」は縦中横］《じゅうに》', '12《じゅうに》［＃「12」は縦中横］');
  same('｜山田［＃「山田」の左に「やまだ」のルビ］《ヤマダ》', '山田《ヤマダ》［＃「山田」の左に「やまだ」のルビ］');
  same('｜山田太郎［＃「山田」に傍点］《やまだたろう》', '山田太郎《やまだたろう》［＃「山田」に傍点］'); // a miss either way
  // The comments of the base come first, then the postfixes that missed.
  assert.deepEqual(content('｜山［＃「無」に傍点］［＃x］田《やまだ》'), ['ruby 山田《やまだ》', 'comment x', 'comment 「無」に傍点']);
  // A span closed inside the base marks the whole ruby; the state at the 《 wins a channel.
  assert.deepEqual(content('｜［＃傍点］山田［＃傍点終わり］《やまだ》'), ['ruby 山田《やまだ》 emph=傍点']);
  assert.deepEqual(content('｜［＃傍点］山［＃丸傍点］田［＃丸傍点終わり］《やまだ》'), ['ruby 山田《やまだ》 emph=傍点']);
});

test('a broken ［＃ is content as typed', () => {
  assert.deepEqual(content('これは［＃壊れた'), ['chars これは', 'broken ［＃壊れた']);
});

// --------------------------------------------------------------- values

const REAL: ReadonlyMap<string, string> = new Map([
  [VALUE_NAMES.title, '作品名'],
  [VALUE_NAMES.author, 'ペンネーム'],
  [VALUE_NAMES.totalPages, '215'],
]);

test('a value field shows its value, its default without one; an empty value shows nothing', () => {
  const field = valueAnnotation(VALUE_NAMES.title);
  assert.deepEqual(content(field), [`value ${VALUE_DEFAULTS.title}`]);
  assert.deepEqual(content(valueAnnotation(VALUE_NAMES.totalPages)), [`value ${VALUE_DEFAULTS.totalPages}`]);
  assert.deepEqual(content(field, REAL), ['value 作品名']);
  assert.deepEqual(content(valueAnnotation(VALUE_NAMES.page), REAL), [`value ${VALUE_DEFAULTS.page}`]);
  assert.deepEqual(content(valueAnnotation('発行日'), REAL), ['value 発行日']);
  assert.deepEqual(content(field, new Map([[VALUE_NAMES.title, '']])), []);
});

test('a postfix binds to the value as substituted', () => {
  const src = `${valueAnnotation(VALUE_NAMES.title)}［＃「作品名」に傍点］`;
  assert.deepEqual(content(src, REAL), ['value 作品名 emph=傍点']);
  assert.deepEqual(content(src), ['value タイトル', 'comment 「作品名」に傍点']);
});

test('a value joins a 縦中横 cell and a ｜ base; an empty base prints its markup as typed', () => {
  const pages = `全［＃縦中横］${valueAnnotation(VALUE_NAMES.totalPages)}［＃縦中横終わり］ページ`;
  assert.deepEqual(content(pages, REAL), ['chars 全', 'tcy 215', 'chars ページ']);
  const ruby = `｜${valueAnnotation(VALUE_NAMES.title)}《たいとる》`;
  assert.deepEqual(content(ruby, REAL), ['ruby 作品名《たいとる》']);
  assert.deepEqual(content(ruby), ['ruby タイトル《たいとる》']);
  assert.deepEqual(content(ruby, new Map([[VALUE_NAMES.title, '']])), ['markup ｜', 'markup 《たいとる》']);
});

// --------------------------------------------------------------- display strings

test('a 外字注記 is the character it stands for: a cell of its own, named by a target as that character', () => {
  const mark = gaijiOf('⁉');
  assert.deepEqual(content(`なに${mark}と`), ['chars なに', 'gaiji ⁉', 'chars と']);
  assert.deepEqual(content(`［＃傍点］${mark}［＃傍点終わり］`), ['gaiji ⁉ emph=傍点']);
  assert.deepEqual(content(`［＃縦中横］${mark}${gaijiOf('‼')}［＃縦中横終わり］`), ['tcy ⁉‼']);
  assert.deepEqual(content(`スキル${gaijiOf('《')}聖剣${gaijiOf('》')}`), ['chars スキル', 'gaiji 《', 'chars 聖剣', 'gaiji 》']);
  assert.deepEqual(content(`なに${mark}［＃「に⁉」に傍点］`), ['chars な', 'chars に emph=傍点', 'gaiji ⁉ emph=傍点']);
  assert.deepEqual(content(`なに${mark}［＃「に⁉」は縦中横］`), ['chars な', 'tcy に⁉']);
  assert.deepEqual(content(`なに${mark}［＃「なに⁉」の左に「よみ」のルビ］`), ['ruby なに⁉〈よみ〉']);
  assert.deepEqual(content(`なに${mark}［＃「なに⁉」は大見出し］`), ['chars なに', 'gaiji ⁉']);
  assert.deepEqual(issuesOf(`なに${mark}［＃「に⁉」に傍点］${mark}［＃「⁉」は縦中横］`), []);
  // A ※ that starts none is a character, and its annotation a comment.
  assert.deepEqual(content('※［＃二の字点、1-2-22］'), ['chars ※', 'comment 二の字点、1-2-22']);
});

test('NFD: content is composed, whatever the source spelling', () => {
  assert.deepEqual(content(`　｜カ${D}ラス戸《か${D}らすと${D}》か${D}開いた。`), content('　｜ガラス戸《がらすど》が開いた。'));
  assert.deepEqual(content(`た${D}め［＃「だめ」に傍点］`), ['chars だめ emph=傍点']);
  assert.deepEqual(content(`聖剣《せいけん》［＃「聖剣」の左に「つるき${D}」のルビ］`), ['ruby 聖剣《せいけん》〈つるぎ〉']);
  assert.deepEqual(content(`［＃縦中横］か［＃x］${D}き［＃縦中横終わり］`), ['comment x', 'tcy がき']); // the cell composes as one
  assert.deepEqual(content(`｜か［＃x］${D}《よみ》`), ['ruby が《よみ》', 'comment x']); // …and so does a base
});

test('a ruby and a 縦中横 carry the runs they were joined from, each written where it was', () => {
  /** The runs of the one-line `src`'s first atomic cell, as `[origin text, source it was written at]`. */
  const runs = (src: string): [string, string][] => {
    const cell = parse(src).lines[0]?.content.find((item) => item.kind === 'ruby' || item.kind === 'tcy');
    assert.ok(cell?.kind === 'ruby' || cell?.kind === 'tcy');
    return cell.runs.map((run) => [`${run.origin} ${run.text}`, src.slice(run.span.start, run.span.end)]);
  };
  assert.deepEqual(runs('山田《やまだ》'), [['prose 山田', '山田']]);
  assert.deepEqual(runs('｜山田太郎《やまだたろう》'), [['prose 山田太郎', '山田太郎']]);
  // Markup inside a ｜ base cuts the runs; a value and a 外字注記 are runs of their origin.
  assert.deepEqual(runs('｜山［＃「山」に傍点］田《やまだ》'), [['prose 山', '山'], ['prose 田', '田']]);
  const value = valueAnnotation(VALUE_NAMES.title);
  assert.deepEqual(runs(`｜山${value}田《やまだ》`), [['prose 山', '山'], [`value ${VALUE_NAMES.title}`, value], ['prose 田', '田']]);
  assert.deepEqual(runs(`［＃縦中横］１${gaijiOf('⁉')}［＃縦中横終わり］`), [['prose １', '１'], ['gaiji ⁉', gaijiOf('⁉')]]);
  // A swallowed reading is no run; a kana composed across a comment is one run over both.
  assert.deepEqual(runs('［＃縦中横］１２《じゅうに》［＃縦中横終わり］'), [['prose １２', '１２']]);
  assert.deepEqual(runs(`｜か［＃x］${D}《が》`), [['prose が', `か［＃x］${D}`]]);
  // A 左ルビ or a 縦中横 postfix keeps the runs of what it covered.
  assert.deepEqual(runs('王都［＃「王都」の左に「おうと」のルビ］'), [['prose 王都', '王都']]);
  assert.deepEqual(runs('１２［＃「１２」は縦中横］'), [['prose １２', '１２']]);
});

test('NFD: a pair split by markup outside a cell stays two characters', () => {
  assert.deepEqual(content(`か［＃x］${D}`), ['chars か', 'comment x', `chars ${D}`]);
  // Two runs never rejoin across nodes, so nothing composes behind the resolver's back.
  assert.deepEqual(content(`か［＃ここから２字下げ］${D}`), ['chars か', `chars ${D}`]);
});

test('unshown: a character no output can carry leaves the content, wherever it is written', () => {
  for (const c of UNSHOWN) {
    const cases: readonly [src: string, content: string[]][] = [
      [`王${c}都`, ['chars 王都']],
      [c, []],
      [`${c}王都${c}`, ['chars 王都']],
      [`か${c}${D}`, ['chars が']], // dropped first, so the pair composes
      [`漢字《か${c}んじ》`, ['ruby 漢字《かんじ》']],
      [`｜王${c}都《おうと》`, ['ruby 王都《おうと》']],
      [`｜${c}《よみ》`, ['chars ｜《よみ》']], // nothing visible: no ruby to the Scanner (rubyBaseMissing), prose as typed
      [`序［＃縦中横］1${c}2［＃縦中横終わり］`, ['chars 序', 'tcy 12']],
      [`［＃縦中横］${c}［＃縦中横終わり］`, []],
      [`聖剣［＃「聖剣」の左に「つる${c}ぎ」のルビ］`, ['ruby 聖剣〈つるぎ〉']],
      [`前［＃-${c}-］`, ['chars 前', 'comment --']],
      [`これは［＃壊${c}れた`, ['chars これは', 'broken ［＃壊れた']],
    ];
    for (const [src, expected] of cases) {
      assert.deepEqual(content(src), expected, JSON.stringify(src));
      assert.equal(printSource(scan(src)), src, JSON.stringify(src)); // the nodes keep it
    }
  }
});

test('unshown: a postfix target is matched as shown, on both sides', () => {
  const inText = `聖${BEL}剣［＃「聖剣」に傍点］`;
  assert.deepEqual(content(inText), ['chars 聖剣 emph=傍点']);
  assert.deepEqual(boundOf(inText), [at(inText, `聖${BEL}剣`)]);
  assert.deepEqual(issuesOf(inText), []);
  const inTarget = `1${BEL}2［＃「${BEL}12」は縦中横］`;
  assert.deepEqual(content(inTarget), ['tcy 12']);
  assert.deepEqual(issuesOf(inTarget), []);
  // A target of nothing but such characters names nothing; the comment shows what is left of it.
  const empty = `聖剣［＃「${BEL}」に傍点］`;
  assert.deepEqual(content(empty), ['chars 聖剣', 'comment 「」に傍点']);
  assert.deepEqual(issuesOf(empty), [{ kind: 'postfixTargetMissing', span: at(empty, BEL), target: BEL }]);
});

test('unshown: a 縦中横 span holds what it shows, over what was written', () => {
  const src = `［＃縦中横］${BEL}1${BEL}［＃縦中横終わり］`;
  assert.deepEqual(heldOf(src), [{ text: '1', span: at(src, `${BEL}1${BEL}`) }]);
  const none = `［＃縦中横］${BEL}［＃縦中横終わり］`;
  assert.deepEqual(heldOf(none), [{ text: '', span: at(none, BEL) }]);
});

test('unshown: a run spans its kept characters, each knowing where it was written', () => {
  const src = `${BEL}王${BEL}都か${BEL}${D}${BEL}`;
  const [run] = parse(src).lines[0]?.content ?? [];
  assert.ok(run?.kind === 'chars');
  assert.equal(run.text, '王都が');
  assert.deepEqual(run.span, at(src, `王${BEL}都か${BEL}${D}`));
  assert.deepEqual(clusterStarts(run), [at(src, '王').start, at(src, '都').start, at(src, 'か').start]);
});

test('a run maps back to the source it came from', () => {
  const src = `あか${D}き［＃「がき」に傍点］く`;
  assert.deepEqual(parse(src).lines[0]?.content.map((item) => [item.kind === 'chars' ? item.text : '', item.span]), [
    ['あ', at(src, 'あ')],
    ['がき', at(src, `か${D}き`)], // the composed kana covers both of its units
    ['く', at(src, 'く')],
  ]);
  const field = valueAnnotation(VALUE_NAMES.title);
  assert.deepEqual(parse(`前${field}`, REAL).lines[0]?.content.map((item) => item.span), [
    at(`前${field}`, '前'),
    at(`前${field}`, field), // a value stands where its annotation is
  ]);
  const mark = gaijiOf('⁉');
  assert.deepEqual(parse(`前${mark}後`).lines[0]?.content.map((item) => item.span), [
    at(`前${mark}後`, '前'),
    at(`前${mark}後`, mark), // and so does the character of a 外字注記, its ※ included
    at(`前${mark}後`, '後'),
  ]);
});

test('each character of a run maps back to where it was written', () => {
  /** The characters of the one-line `src`'s runs, each with where it was written. */
  const written = (src: string): [string, number][] =>
    (parse(src).lines[0]?.content ?? []).flatMap((item) => {
      if (item.kind !== 'chars') {
        return [];
      }
      const chars = Array.from(item.text);
      return clusterStarts(item).map((start, i): [string, number] => [chars[i] ?? '', start]);
    });
  // A composed kana sits at its kana and what follows it past its mark: after a character of two
  // units, and in a piece a postfix cut off.
  const nfd = `𠮷か${D}きく［＃「く」に傍点］`;
  const start = (needle: string): number => at(nfd, needle).start;
  assert.deepEqual(written(nfd), [['𠮷', 0], ['が', start(`か${D}`)], ['き', start('き')], ['く', start('く')]]);

  // Only a run cut from a source with composed kana carries `starts`; plain text, a value and a
  // 外字注記 never do.
  const carries = (src: string, values?: ReadonlyMap<string, string>): boolean[] =>
    (parse(src, values).lines[0]?.content ?? []).flatMap((item) => (item.kind === 'chars' ? ['starts' in item] : []));
  assert.deepEqual(carries(nfd), [true, true]);
  assert.deepEqual(carries(`前${valueAnnotation(VALUE_NAMES.title)}`, REAL), [false, false]);
  assert.deepEqual(carries(`前${gaijiOf('⁉')}`), [false, false]);
});

// --------------------------------------------------------------- line state

/** Each line's [indent, heading, pageBreak, blockDirective]. */
const state = (src: string): unknown[][] =>
  parse(src).lines.map((l) => [l.indent, l.heading, l.pageBreak, l.blockDirective]);

test('字下げ: the single-line form is N spaces of its line, the block form the state of the lines after it', () => {
  assert.deepEqual(state('［＃３字下げ］本文の行。\n次の行。'), [[0, undefined, false, false], [0, undefined, false, false]]);
  assert.deepEqual(content('［＃３字下げ］本文の行。'), ['indent 　　　', 'chars 本文の行。']);
  assert.deepEqual(content('本文［＃２字下げ］本文'), ['chars 本文', 'indent 　　', 'chars 本文']);
  assert.deepEqual(content('　［＃１字下げ］本文'), ['chars 　', 'indent 　', 'chars 本文']); // the auto-indent space and its own
  assert.deepEqual(content('［＃０字下げ］本文'), ['chars 本文']);
  assert.deepEqual(content('［＃縦中横］［＃１字下げ］1［＃縦中横終わり］'), ['tcy 　1']);
  // A ［＃０字下げ］ inside a block adds nothing: the block's state stands.
  assert.deepEqual(
    state('［＃ここから２字下げ］同じ行。\n中の行。\n［＃０字下げ］ゼロ行。\n［＃ここで字下げ終わり］終端行。\n外の行。').map((s) => s[0]),
    [0, 2, 2, 2, 0],
  );
  // One slot: a block opened inside a block switches the depth.
  assert.deepEqual(state('［＃ここから２字下げ］\nあ。\n［＃ここから４字下げ］\n四の行。').map((s) => s[0]), [0, 2, 2, 4]);
  assert.deepEqual(state('［＃０字下げ］本文。').map((s) => s[0]), [0]);
});

test('見出し: a bound postfix and an inline span mark their line, a block the lines after it', () => {
  assert.deepEqual(state('序章［＃「序章」は大見出し］\n本文。').map((s) => s[1]), [1, undefined]);
  assert.deepEqual(state('序章［＃「別文」は大見出し］').map((s) => s[1]), [undefined]); // a miss marks nothing
  // The line carrying the end stays a heading.
  assert.deepEqual(state('［＃中見出し］題\nまだ題\n［＃中見出し終わり］終端行\nあと').map((s) => s[1]), [2, 2, 2, undefined]);
  assert.deepEqual(state('［＃ここから小見出し］\n題の行\n［＃ここで小見出し終わり］\nあと').map((s) => s[1]), [undefined, 3, 3, undefined]);
  // One slot for the three levels: a re-open is a level change.
  assert.deepEqual(state('［＃大見出し］一\n［＃小見出し］二').map((s) => s[1]), [1, 3]);
  // A heading is absent as a KEY, never an undefined value.
  assert.equal(Object.hasOwn(parse('本文').lines[0] ?? {}, 'heading'), false);
});

test('改ページ and the block directives are flags of their line', () => {
  assert.deepEqual(state('前［＃改ページ］後\n次'), [[0, undefined, true, false], [0, undefined, false, false]]);
  for (const src of ['［＃ここから２字下げ］', '［＃ここで字下げ終わり］', '［＃ここから太字］', '［＃ここで斜体終わり］', '［＃ここから大見出し］', '［＃ここで小見出し終わり］']) {
    assert.equal(parse(src).lines[0]?.blockDirective, true, src);
  }
  for (const src of ['［＃太字］', '［＃傍点終わり］', '［＃大見出し］', '［＃３字下げ］', '［＃改ページ］', '［＃メモ］', '本文']) {
    assert.equal(parse(src).lines[0]?.blockDirective, false, src);
  }
});

test('the state of a file is its own: nothing carries into the next parse', () => {
  parse('［＃ここから２字下げ］\n［＃太字］\n［＃大見出し］');
  assert.deepEqual(state('本文'), [[0, undefined, false, false]]);
  assert.deepEqual(contentOf('本文'), [['chars 本文']]);
});
