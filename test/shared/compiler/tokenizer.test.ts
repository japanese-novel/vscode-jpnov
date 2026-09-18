import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closingAnnotation,
  findBrokenAnnotations,
  findRubyIssues,
  findTcyIssues,
  findUnpairedSpans,
  splitLines,
  tokenize,
  unterminatedOpeners,
  VALUE_NAMES,
  valueAnnotation,
  type RubyIssue,
  type SpanOpener,
  type Token,
} from '../../../src/shared/compiler/tokenizer.ts';
import { buildRows } from '../../../src/shared/compiler/layout.ts';

const kinds = (tokens: readonly Token[]): string[] => tokens.map((t) => t.kind);

test('tokenize returns no tokens for the empty string', () => {
  assert.deepEqual(tokenize(''), []);
});

test('tokenize emits a single text token for plain text', () => {
  assert.deepEqual(tokenize('ただの本文'), [
    { kind: 'text', raw: 'ただの本文', text: 'ただの本文' },
  ]);
});

test('tokenize keeps 「」 dialogue as ordinary text (never a comment)', () => {
  const toks = tokenize('彼は「こんにちは」と言った');
  assert.deepEqual(kinds(toks), ['text']);
});

test('tokenize splits an explicit-base ruby with a ｜ marker into its span', () => {
  const toks = tokenize('彼は｜走《はし》った');
  assert.deepEqual(toks, [
    { kind: 'text', raw: '彼は', text: '彼は' },
    { kind: 'rubyStart', raw: '｜' },
    { kind: 'text', raw: '走', text: '走' },
    { kind: 'rubyEnd', raw: '《はし》', reading: 'はし' },
    { kind: 'text', raw: 'った', text: 'った' },
  ]);
});

test('tokenize keeps a standalone ｜ (no following ruby) as literal text', () => {
  assert.deepEqual(tokenize('これは｜です'), [
    { kind: 'text', raw: 'これは｜です', text: 'これは｜です' },
  ]);
});

test('tokenize keeps a trailing ｜ at end of input as literal text', () => {
  assert.deepEqual(tokenize('終わり｜'), [
    { kind: 'text', raw: '終わり｜', text: '終わり｜' },
  ]);
});

test('tokenize keeps the ｜ when the reading is empty (｜漢字《》)', () => {
  assert.deepEqual(tokenize('｜漢字《》'), [
    { kind: 'text', raw: '｜漢字《》', text: '｜漢字《》' },
  ]);
});

test('tokenize keeps the ｜ when the explicit base is empty (｜《よみ》)', () => {
  assert.deepEqual(tokenize('｜《よみ》'), [
    { kind: 'text', raw: '｜《よみ》', text: '｜《よみ》' },
  ]);
});

test('tokenize lets the last ｜ win and keeps earlier ｜ as literal text', () => {
  assert.deepEqual(tokenize('a｜b｜c《r》'), [
    { kind: 'text', raw: 'a｜b', text: 'a｜b' },
    { kind: 'rubyStart', raw: '｜' },
    { kind: 'text', raw: 'c', text: 'c' },
    { kind: 'rubyEnd', raw: '《r》', reading: 'r' },
  ]);
});

test('tokenize detects an implicit ruby base by class walk-back', () => {
  const toks = tokenize('前置き漢字《かんじ》');
  assert.deepEqual(toks, [
    { kind: 'text', raw: '前置き', text: '前置き' },
    { kind: 'rubyImplicit', raw: '漢字《かんじ》', base: '漢字', reading: 'かんじ' },
  ]);
});

test('tokenize treats an empty 《》 as literal text (no ruby)', () => {
  assert.deepEqual(tokenize('漢字《》です'), [
    { kind: 'text', raw: '漢字《》です', text: '漢字《》です' },
  ]);
});

test('tokenize classifies a postfix emphasis annotation', () => {
  const toks = tokenize('対象［＃「対象」に傍点］');
  assert.deepEqual(toks, [
    { kind: 'text', raw: '対象', text: '対象' },
    {
      kind: 'emphasisPostfix',
      raw: '［＃「対象」に傍点］',
      target: '対象',
      variant: '傍点',
    },
  ]);
});

test('tokenize classifies の左に postfix and keeps the whole の左に in the variant', () => {
  // の is NOT a connector (only に/は are stripped): the の左に direction prefix travels
  // whole inside the variant and resolveStyle handles it.
  const toks = tokenize('対象［＃「対象」の左に傍点］');
  assert.deepEqual(toks[1], {
    kind: 'emphasisPostfix',
    raw: '［＃「対象」の左に傍点］',
    target: '対象',
    variant: 'の左に傍点',
  });
});

test('tokenize classifies emphasis span start and end (cross-line stream)', () => {
  const toks = tokenize('a［＃傍点］b\nc［＃傍点終わり］d');
  assert.deepEqual(kinds(toks), [
    'text',
    'emphasisSpanStart',
    'text', // "b\nc"
    'emphasisSpanEnd',
    'text',
  ]);
  assert.equal((toks[1] as { variant: string }).variant, '傍点');
  assert.equal((toks[3] as { variant: string }).variant, '傍点');
});

test('tokenize maps ［＃改ページ］ to a pageBreak token', () => {
  const toks = tokenize('前［＃改ページ］後');
  assert.deepEqual(kinds(toks), ['text', 'pageBreak', 'text']);
  assert.equal(toks[1]?.raw, '［＃改ページ］');
});

test('tokenize recognises 傍線 postfix; a half-width block 字下げ stays a comment', () => {
  const toks = tokenize('文［＃「文」に傍線］［＃ここから2字下げ］');
  assert.deepEqual(kinds(toks), ['text', 'emphasisPostfix', 'comment']);
  assert.deepEqual(toks[1], {
    kind: 'emphasisPostfix',
    raw: '［＃「文」に傍線］',
    target: '文',
    variant: '傍線',
  });
  // Full-width digits only (locked spec): the half-width 2 degrades to a comment.
  assert.equal((toks[2] as { inner: string }).inner, 'ここから2字下げ');
});

test('tokenize closes at the FIRST ］; inner (incl. a ［＃-looking run) is not re-scanned', () => {
  // The first ］ closes the annotation; the leftover "］" after it is literal text.
  const toks = tokenize('［＃注 ［＃ネスト］あと］');
  assert.deepEqual(kinds(toks), ['comment', 'text']);
  assert.equal((toks[0] as { inner: string }).inner, '注 ［＃ネスト');
  assert.equal((toks[1] as { text: string }).text, 'あと］');
});

// --------------------------------------------------------------- broken ［＃ (line-bounded)

test('tokenize turns an unmatched ［＃ into a brokenAnnotation swallowed to end of input', () => {
  assert.deepEqual(tokenize('これは［＃壊れた'), [
    { kind: 'text', raw: 'これは', text: 'これは' },
    { kind: 'brokenAnnotation', raw: '［＃壊れた' },
  ]);
});

test('a broken ［＃ swallows only to the line end; the next line tokenizes fresh', () => {
  assert.deepEqual(tokenize('壊れ［＃注\n次'), [
    { kind: 'text', raw: '壊れ', text: '壊れ' },
    { kind: 'brokenAnnotation', raw: '［＃注' },
    { kind: 'text', raw: '\n次', text: '\n次' },
  ]);
});

test('a ］ on a LATER line does not close a ［＃ (no cross-line pairing)', () => {
  assert.deepEqual(kinds(tokenize('［＃注\n終わり］')), ['brokenAnnotation', 'text']);
  assert.equal(tokenize('［＃注\n終わり］')[1]?.raw, '\n終わり］'); // the lone ］ stays literal text
});

test('multiple ［＃ in one swallowed tail collapse into ONE brokenAnnotation', () => {
  assert.deepEqual(tokenize('［＃あ［＃い'), [{ kind: 'brokenAnnotation', raw: '［＃あ［＃い' }]);
});

test('a bare ［＃ at end of line / end of input is a brokenAnnotation of just ［＃', () => {
  assert.deepEqual(tokenize('［＃'), [{ kind: 'brokenAnnotation', raw: '［＃' }]);
  assert.deepEqual(tokenize('［＃\n次'), [
    { kind: 'brokenAnnotation', raw: '［＃' },
    { kind: 'text', raw: '\n次', text: '\n次' },
  ]);
});

test('CRLF: the \\r of a \\r\\n terminator is never swallowed into the broken raw', () => {
  assert.deepEqual(tokenize('［＃注\r\n次'), [
    { kind: 'brokenAnnotation', raw: '［＃注' },
    { kind: 'text', raw: '\r\n次', text: '\r\n次' },
  ]);
});

test('a closed ［＃…］ on the same line still parses normally (no regression)', () => {
  assert.deepEqual(kinds(tokenize('前［＃メモ］後')), ['text', 'comment', 'text']);
});

test('a standalone ］ with no opener is ordinary text (no error, no token split)', () => {
  assert.deepEqual(tokenize('閉じ括弧だけの］行'), [
    { kind: 'text', raw: '閉じ括弧だけの］行', text: '閉じ括弧だけの］行' },
  ]);
});

test('findBrokenAnnotations reports the exact [start, end) source spans', () => {
  assert.deepEqual(findBrokenAnnotations('本［＃こわれ'), [{ start: 1, end: 6 }]);
  assert.deepEqual(findBrokenAnnotations('closed［＃注］ok'), []);
  assert.deepEqual(findBrokenAnnotations('a［＃x\nb［＃y'), [
    { start: 1, end: 4 },
    { start: 6, end: 9 },
  ]);
  // CRLF: the span ends before the \r.
  assert.deepEqual(findBrokenAnnotations('［＃注\r\n次'), [{ start: 0, end: 3 }]);
});

// --------------------------------------------------------------- lenient 《 (line-bounded)

test('tokenize recovers leniently from an unmatched 《 (emit literally)', () => {
  assert.deepEqual(tokenize('これは《壊れた'), [
    { kind: 'text', raw: 'これは《壊れた', text: 'これは《壊れた' },
  ]);
});

test('a 》 on a LATER line does not pair with a 《 (both stay literal, no error)', () => {
  assert.deepEqual(tokenize('例《。\nルビ》'), [
    { kind: 'text', raw: '例《。\nルビ》', text: '例《。\nルビ》' },
  ]);
});

test('a ｜ base marker does not survive a line break (no cross-line explicit ruby)', () => {
  assert.deepEqual(tokenize('｜語\n《ルビ》'), [
    { kind: 'text', raw: '｜語\n《ルビ》', text: '｜語\n《ルビ》' },
  ]);
});

test('same-line ruby after a broken-annotation line still parses', () => {
  const toks = tokenize('［＃こわれ\n漢字《かんじ》');
  assert.deepEqual(kinds(toks), ['brokenAnnotation', 'text', 'rubyImplicit']);
  assert.deepEqual(toks[2], { kind: 'rubyImplicit', raw: '漢字《かんじ》', base: '漢字', reading: 'かんじ' });
});

// --------------------------------------------------------------- 字下げ (indent)

test('a line-head ［＃○字下げ］ is an indent token (full-width digits, multi-digit ok)', () => {
  assert.deepEqual(tokenize('［＃３字下げ］本文')[0], {
    kind: 'indent',
    raw: '［＃３字下げ］',
    amount: 3,
  });
  // Line-head after a newline counts too.
  const toks = tokenize('　まくら\n［＃２字下げ］次');
  assert.deepEqual(toks[1], { kind: 'indent', raw: '［＃２字下げ］', amount: 2 });
  // Any number of digits parses; the layout clamps (no lexer-side bound).
  assert.deepEqual(tokenize('［＃１００字下げ］x')[0], {
    kind: 'indent',
    raw: '［＃１００字下げ］',
    amount: 100,
  });
  // Leading zeros parse numerically; 0 is a valid (layout no-op) amount.
  assert.equal((tokenize('［＃００３字下げ］x')[0] as { amount: number }).amount, 3);
  assert.deepEqual(tokenize('［＃０字下げ］x')[0], {
    kind: 'indent',
    raw: '［＃０字下げ］',
    amount: 0,
  });
});

test('a mid-line ［＃○字下げ］ degrades to a comment (line-head only, strict column 0)', () => {
  const toks = tokenize('本文［＃３字下げ］');
  assert.deepEqual(kinds(toks), ['text', 'comment']);
  assert.equal((toks[1] as { inner: string }).inner, '３字下げ');
  // A leading full-width space also disqualifies it — the ［ must open the line.
  assert.deepEqual(kinds(tokenize('　［＃３字下げ］')), ['text', 'comment']);
  // A lone \r is a line separator in the editor's model, so the ［ after it IS line-head.
  assert.deepEqual(kinds(tokenize('A\r［＃３字下げ］')), ['text', 'indent']);
});

test('half-width and kanji numerals degrade to comments (full-width only)', () => {
  assert.deepEqual(kinds(tokenize('［＃3字下げ］')), ['comment']);
  assert.deepEqual(kinds(tokenize('［＃三字下げ］')), ['comment']);
});

test('block 字下げ start/end tokens pair around lines', () => {
  const toks = tokenize('［＃ここから２字下げ］\nA\n［＃ここで字下げ終わり］');
  assert.deepEqual(toks[0], {
    kind: 'indentBlockStart',
    raw: '［＃ここから２字下げ］',
    amount: 2,
  });
  assert.deepEqual(toks[2], { kind: 'indentBlockEnd', raw: '［＃ここで字下げ終わり］' });
});

test('the hanging-indent 折り返して form degrades to a comment (out of scope)', () => {
  const toks = tokenize('［＃ここから２字下げ、折り返して３字下げ］');
  assert.deepEqual(kinds(toks), ['comment']);
});

// --------------------------------------------------------------- 太字 / 斜体 / 傍線

test('block 太字/斜体 reuse the span tokens with block:true', () => {
  const toks = tokenize('［＃ここから太字］\nA\n［＃ここで太字終わり］');
  assert.deepEqual(toks[0], {
    kind: 'emphasisSpanStart',
    raw: '［＃ここから太字］',
    variant: '太字',
    block: true,
  });
  assert.deepEqual(toks[2], {
    kind: 'emphasisSpanEnd',
    raw: '［＃ここで太字終わり］',
    variant: '太字',
    block: true,
  });
  assert.equal((tokenize('［＃ここから斜体］')[0] as { variant: string }).variant, '斜体');
});

test('inline 太字/斜体 spans carry no block flag', () => {
  const toks = tokenize('あ［＃太字］い［＃太字終わり］');
  assert.deepEqual(toks[1], { kind: 'emphasisSpanStart', raw: '［＃太字］', variant: '太字' });
  assert.deepEqual(toks[3], {
    kind: 'emphasisSpanEnd',
    raw: '［＃太字終わり］',
    variant: '太字',
  });
});

test('傍点/傍線 have no block form: ここから傍点 / ここで傍点終わり are comments', () => {
  assert.deepEqual(kinds(tokenize('［＃ここから傍点］')), ['comment']);
  assert.deepEqual(kinds(tokenize('［＃ここで傍点終わり］')), ['comment']);
});

test('傍線 span and left variants tokenize like 傍点', () => {
  const toks = tokenize('［＃二重傍線］x［＃二重傍線終わり］');
  assert.deepEqual(kinds(toks), ['emphasisSpanStart', 'text', 'emphasisSpanEnd']);
  assert.equal((toks[0] as { variant: string }).variant, '二重傍線');
  assert.equal((tokenize('［＃左に波線］')[0] as { variant: string }).variant, '左に波線');
  assert.deepEqual(tokenize('語［＃「語」の左に傍線］')[1], {
    kind: 'emphasisPostfix',
    raw: '［＃「語」の左に傍線］',
    target: '語',
    variant: 'の左に傍線',
  });
});

test('太字 postfix requires the は connector', () => {
  assert.deepEqual(tokenize('重要［＃「重要」は太字］')[1], {
    kind: 'emphasisPostfix',
    raw: '［＃「重要」は太字］',
    target: '重要',
    variant: '太字',
  });
  // Bare (no connector) 太字 postfix is NOT accepted — mirrors the grammar's mandatory (は).
  assert.deepEqual(kinds(tokenize('x［＃「x」太字］')), ['text', 'comment']);
});

test('connector×channel mismatches degrade to comments', () => {
  assert.deepEqual(kinds(tokenize('x［＃「x」は傍点］')), ['text', 'comment']); // は+dot
  assert.deepEqual(kinds(tokenize('x［＃「x」に太字］')), ['text', 'comment']); // に+weight
  assert.deepEqual(kinds(tokenize('x［＃「x」のばつ傍点］')), ['text', 'comment']); // lone の
  assert.deepEqual(kinds(tokenize('x［＃「x」の左に太字］')), ['text', 'comment']); // 太字 has no side
  // The lenient existing behaviour stays: bare 傍点 postfix (no に) is accepted.
  assert.deepEqual(kinds(tokenize('x［＃「x」傍点］')), ['text', 'emphasisPostfix']);
});

test('the left prefix is form-bound — postfix takes の左に only, spans take bare 左に only', () => {
  // The Aozora spec never writes a postfix with bare 左に nor a span with の左に; the wrong
  // spelling degrades to a comment in BOTH layers (tmLanguage mirrors these exactly).
  assert.deepEqual(kinds(tokenize('対象［＃「対象」左に傍線］')), ['text', 'comment']); // bare 左に postfix
  assert.deepEqual(kinds(tokenize('［＃の左に傍線］')), ['comment']); // の左に span start
  assert.deepEqual(kinds(tokenize('［＃の左に傍線終わり］')), ['comment']); // の左に span end
  // Connector and direction prefix are mutually exclusive — にの左に never resolves.
  assert.deepEqual(kinds(tokenize('対象［＃「対象」にの左に傍点］')), ['text', 'comment']);
});

// --------------------------------------------------------------- 左ルビ

test('左ルビ postfix tokenizes with target and reading', () => {
  assert.deepEqual(tokenize('青空文庫［＃「青空文庫」の左に「あおぞらぶんこ」のルビ］'), [
    { kind: 'text', raw: '青空文庫', text: '青空文庫' },
    {
      kind: 'rubyLeftPostfix',
      raw: '［＃「青空文庫」の左に「あおぞらぶんこ」のルビ］',
      target: '青空文庫',
      reading: 'あおぞらぶんこ',
    },
  ]);
});

test('左ルビ pairs with a 《》 right reading on the same base (両側 stream)', () => {
  // The spec's flagship 両側 example: right reading via 《》, LATIN left reading (with a space)
  // via the annotation — the annotation names the base only, never the 《》 part.
  const toks = tokenize('青空文庫《あおぞらぶんこ》［＃「青空文庫」の左に「aozora bunko」のルビ］');
  assert.deepEqual(kinds(toks), ['rubyImplicit', 'rubyLeftPostfix']);
  assert.deepEqual(toks[1], {
    kind: 'rubyLeftPostfix',
    raw: '［＃「青空文庫」の左に「aozora bunko」のルビ］',
    target: '青空文庫',
    reading: 'aozora bunko',
  });
});

test('左ルビ degrades to a comment on every malformed shape', () => {
  assert.deepEqual(kinds(tokenize('［＃「」の左に「よみ」のルビ］')), ['comment']); // empty target
  assert.deepEqual(kinds(tokenize('対象［＃「対象」の左に「」のルビ］')), ['text', 'comment']); // empty reading (silent)
  assert.deepEqual(kinds(tokenize('対象［＃「対象」の左に「よみ」の注記］')), ['text', 'comment']); // 注記 family: out of scope
  assert.deepEqual(kinds(tokenize('対象［＃「対象」の左に「よみ」］')), ['text', 'comment']); // missing のルビ tail
  assert.deepEqual(kinds(tokenize('対象［＃「対象」左に「よみ」のルビ］')), ['text', 'comment']); // bare 左に (postfix takes の左に)
  assert.deepEqual(kinds(tokenize('対象［＃「対象」に「よみ」のルビ］')), ['text', 'comment']); // に (no right-side annotation ruby exists)
});

// --------------------------------------------------------------- 縦中横

test('縦中横 span start/end tokenize as dedicated tokens', () => {
  const toks = tokenize('序［＃縦中横］12［＃縦中横終わり］年');
  assert.deepEqual(kinds(toks), ['text', 'tcySpanStart', 'text', 'tcySpanEnd', 'text']);
  assert.equal(toks[1]?.raw, '［＃縦中横］');
  assert.equal(toks[3]?.raw, '［＃縦中横終わり］');
});

test('縦中横 postfix requires the は connector (like 太字/斜体)', () => {
  assert.deepEqual(tokenize('米機Ｂ29［＃「29」は縦中横］')[1], {
    kind: 'tcyPostfix',
    raw: '［＃「29」は縦中横］',
    target: '29',
  });
  assert.deepEqual(kinds(tokenize('29［＃「29」に縦中横］')), ['text', 'comment']); // に connector
  assert.deepEqual(kinds(tokenize('29［＃「29」縦中横］')), ['text', 'comment']); // bare (no は)
  assert.deepEqual(kinds(tokenize('A［＃「」は縦中横］')), ['text', 'comment']); // empty target
  // 縦中横 has no block (ここから/ここで) form.
  assert.deepEqual(kinds(tokenize('［＃ここから縦中横］')), ['comment']);
  assert.deepEqual(kinds(tokenize('［＃ここで縦中横終わり］')), ['comment']);
});

// --------------------------------------------------------------- 値の表示

test('値の表示 tokenizes ANY non-empty name, which rides the token; an empty pair greys out', () => {
  for (const name of [...Object.values(VALUE_NAMES), '発行日', '13', 'a」b']) {
    const raw = valueAnnotation(name);
    assert.deepEqual(tokenize(raw), [{ kind: 'valueField', raw, name }]);
  }
  assert.deepEqual(kinds(tokenize('［＃ここに「」の値を表示］')), ['comment']); // empty pair
  assert.deepEqual(kinds(tokenize('［＃ここに「タイトル」の値］')), ['comment']); // truncated tail
  assert.deepEqual(kinds(tokenize('［＃ここにタイトルの値を表示］')), ['comment']); // no corner quotes
});

test('値の表示: an Object.prototype name is a name like any other, never a lookup hazard', () => {
  // The name comes from the document: a plain object lookup would resolve these through the
  // prototype chain and hand the layout a function to substitute.
  for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const raw = valueAnnotation(name);
    assert.deepEqual(tokenize(raw), [{ kind: 'valueField', raw, name }]);
    const units = buildRows(tokenize(raw)).flatMap((r) => (r.kind === 'line' ? r.units : []));
    assert.equal(units.map((u) => u.text).join(''), name);
    assert.doesNotThrow(() => findTcyIssues(`［＃縦中横］${raw}［＃縦中横終わり］`));
  }
});

test('値の表示 is not line-head gated and keeps its neighbours as text', () => {
  assert.deepEqual(kinds(tokenize('全［＃ここに「総ページ数」の値を表示］ページ')), [
    'text', 'valueField', 'text',
  ]);
});

test('findTcyIssues counts a value field at its NAME length (what a bookless compile renders)', () => {
  // Relational, so the too-long threshold stays a private tuning value: a span holding a value
  // field must be judged exactly as one holding that name typed out.
  const spanned = (content: string): string => `［＃縦中横］${content}［＃縦中横終わり］`;
  for (const name of [...Object.values(VALUE_NAMES), '13', '発行日']) {
    const asField = findTcyIssues(spanned(valueAnnotation(name))).map((i) => i.kind);
    const asTyped = findTcyIssues(spanned(name)).map((i) => i.kind);
    assert.deepEqual(asField, asTyped, `${name} must be accounted like its typed name`);
  }
  // Two fields in one span accumulate, exactly as two typed runs would.
  assert.deepEqual(
    findTcyIssues(spanned(valueAnnotation('12') + valueAnnotation('34'))).map((i) => i.kind),
    findTcyIssues(spanned('1234')).map((i) => i.kind),
  );
});

// --------------------------------------------------------------- 見出し

test('見出し postfix carries its level (大=1) and requires the は connector', () => {
  assert.deepEqual(tokenize('第一章［＃「第一章」は大見出し］')[1], {
    kind: 'headingPostfix',
    raw: '［＃「第一章」は大見出し］',
    target: '第一章',
    level: 1,
  });
  assert.deepEqual(tokenize('一［＃「一」は中見出し］')[1], {
    kind: 'headingPostfix',
    raw: '［＃「一」は中見出し］',
    target: '一',
    level: 2,
  });
  assert.deepEqual(tokenize('一［＃「一」は小見出し］')[1], {
    kind: 'headingPostfix',
    raw: '［＃「一」は小見出し］',
    target: '一',
    level: 3,
  });
  assert.deepEqual(kinds(tokenize('一［＃「一」に大見出し］')), ['text', 'comment']); // に connector
  assert.deepEqual(kinds(tokenize('一［＃「一」大見出し］')), ['text', 'comment']); // bare (no は)
  assert.deepEqual(kinds(tokenize('［＃「」は大見出し］')), ['comment']); // empty target
});

test('見出し inline span pair carries its level; no block flag', () => {
  assert.deepEqual(tokenize('［＃大見出し］')[0], {
    kind: 'headingSpanStart',
    raw: '［＃大見出し］',
    level: 1,
  });
  assert.deepEqual(tokenize('［＃中見出し終わり］')[0], {
    kind: 'headingSpanEnd',
    raw: '［＃中見出し終わり］',
    level: 2,
  });
  assert.deepEqual(kinds(tokenize('［＃小見出し］第三節［＃小見出し終わり］')), [
    'headingSpanStart',
    'text',
    'headingSpanEnd',
  ]);
});

test('見出し block pair carries its level and the block flag', () => {
  assert.deepEqual(tokenize('［＃ここから中見出し］')[0], {
    kind: 'headingSpanStart',
    raw: '［＃ここから中見出し］',
    level: 2,
    block: true,
  });
  assert.deepEqual(tokenize('［＃ここで小見出し終わり］')[0], {
    kind: 'headingSpanEnd',
    raw: '［＃ここで小見出し終わり］',
    level: 3,
    block: true,
  });
});

test('見出し near-miss spellings stay comments', () => {
  assert.deepEqual(kinds(tokenize('［＃見出し］')), ['comment']); // no bare 見出し literal
  assert.deepEqual(kinds(tokenize('［＃大見出し終り］')), ['comment']); // wrong okurigana
  assert.deepEqual(kinds(tokenize('［＃ここから大見出し終わり］')), ['comment']); // mixed scaffolding
});

// --------------------------------------------------------------- findTcyIssues

test('findTcyIssues: an unterminated span warns over its opening annotation (line-local)', () => {
  assert.deepEqual(findTcyIssues('序［＃縦中横］12\n次'), [
    { start: 1, end: 7, kind: 'unterminated' },
  ]);
  assert.deepEqual(findTcyIssues('［＃縦中横］12'), [
    { start: 0, end: 6, kind: 'unterminated' }, // EOF closes with its line, still warned
  ]);
});

test('findTcyIssues: a dangling 終わり warns; a balanced pair is clean', () => {
  assert.deepEqual(findTcyIssues('AB［＃縦中横終わり］'), [
    { start: 2, end: 11, kind: 'dangling' },
  ]);
  assert.deepEqual(findTcyIssues('令和［＃縦中横］12［＃縦中横終わり］年'), []);
});

test('findTcyIssues: over-long content warns in both forms (>3 code points)', () => {
  // Span form: the range covers the CONTENT between the markers.
  assert.deepEqual(findTcyIssues('［＃縦中横］1234［＃縦中横終わり］'), [
    { start: 6, end: 10, kind: 'tooLong' },
  ]);
  assert.deepEqual(findTcyIssues('［＃縦中横］123［＃縦中横終わり］'), []); // 3 renders cleanly
  // Postfix form: the range covers the annotation.
  assert.deepEqual(findTcyIssues('1234［＃「1234」は縦中横］'), [
    { start: 4, end: 17, kind: 'tooLong' },
  ]);
});

test('findTcyIssues: an inner ruby raw joins the cell literally and counts as content', () => {
  assert.deepEqual(findTcyIssues('［＃縦中横］漢《かん》［＃縦中横終わり］'), [
    { start: 6, end: 11, kind: 'tooLong' },
  ]);
});

// --------------------------------------------------------------- findRubyIssues

const missing = (start: number, end: number, reading: string): RubyIssue => ({
  start,
  end,
  kind: 'baseMissing',
  reading,
});
const empty = (start: number, end: number): RubyIssue => ({ start, end, kind: 'readingEmpty', reading: '' });

/** `[source, expected spans]` — offsets are UTF-16 code units (every character here is BMP). */
const RUBY_ISSUE_CASES: readonly [string, RubyIssue[]][] = [
  // No base character before the reading: line start, punctuation, a space, another ruby.
  ['《ごう》', [missing(0, 4, 'ごう')]],
  ['　行くぞ。《ごう》', [missing(5, 9, 'ごう')]],
  ['行く　《ごう》', [missing(3, 7, 'ごう')]],
  ['漢字《かんじ》《かんじ》', [missing(7, 12, 'かんじ')]],
  // Without a ｜, an annotation flushes the text before it and a value field is not a base.
  ['山田［＃「山田」に傍点］《やまだ》', [missing(12, 17, 'やまだ')]],
  ['［＃ここに「タイトル」の値を表示］《たいとる》', [missing(17, 23, 'たいとる')]],
  // A ｜ with nothing visible before its 《 reports from the ｜ (the last ｜ wins); a ｜ never
  // survives a line break.
  ['｜《よみ》', [missing(0, 5, 'よみ')]],
  ['あ｜《よみ》', [missing(1, 6, 'よみ')]],
  ['｜｜《よみ》', [missing(1, 6, 'よみ')]],
  ['｜［＃メモ］《よみ》', [missing(0, 10, 'よみ')]],
  ['｜［＃傍点］《よみ》', [missing(0, 10, 'よみ')]],
  ['｜［＃縦中横］12［＃縦中横終わり］《じゅうに》', [missing(18, 24, 'じゅうに')]],
  ['｜語\n《ルビ》', [missing(3, 7, 'ルビ')]],
  // Document order; a CRLF end stays before the \r; inside 縦中横 the run is literal as well.
  ['。《あ》\n｜《い》', [missing(1, 4, 'あ'), missing(5, 9, 'い')]],
  ['《よみ》\r\n次', [missing(0, 4, 'よみ')]],
  ['あ。\r\n《よみ》', [missing(4, 8, 'よみ')]],
  ['［＃縦中横］《１》［＃縦中横終わり］', [missing(6, 9, '１')]],
  // An empty 《》 is a reading that never came: reported over the 《》 wherever it sits.
  ['《》', [empty(0, 2)]],
  ['漢字《》です', [empty(2, 4)]],
  ['｜漢字《》', [empty(3, 5)]],
  ['《》《ab》', [empty(0, 2), missing(2, 6, 'ab')]],
  // Pairing follows the tokenizer: the first 》 closes; a 》 is not a base.
  ['》《ab》', [missing(1, 5, 'ab')]],
  ['《a《b》', [missing(0, 5, 'a《b')]],
  // Valid rubies (a ｜ base may hold annotations) and an unclosed 《 are clean.
  ['漢字《かんじ》', []],
  ['｜お茶の間《おちゃのま》', []],
  ['｜あ。《よみ》', []],
  ['漢字《か｜んじ》', []],
  ['立《た》ち', []],
  ['｜山田［＃「山田」に傍点］《やまだ》', []],
  ['｜［＃ここに「タイトル」の値を表示］《たいとる》', []],
  ['《ひらき', []],
];

test('findRubyIssues reports every 《…》 the tokenizer kept literal: no base, or no reading', () => {
  for (const [src, expected] of RUBY_ISSUE_CASES) {
    assert.deepEqual(findRubyIssues(src), expected, JSON.stringify(src));
  }
});

test('the issues sink leaves the token stream unchanged', () => {
  for (const [src] of RUBY_ISSUE_CASES) {
    assert.deepEqual(tokenize(src, { issues: [] }), tokenize(src), JSON.stringify(src));
  }
});

// --------------------------------------------------------------- span-form explicit ruby

/** An explicit ruby is a span — the ｜, the base tokens in source order, the 《reading》 — so a base
 *  may hold annotations; a ｜ that meets no reading on its line comes out as it was typed. */
const SPAN_FORM_CASES: readonly [string, Token[]][] = [
  ['｜山田［＃「山田」に傍点］《やまだ》', [
    { kind: 'rubyStart', raw: '｜' },
    { kind: 'text', raw: '山田', text: '山田' },
    { kind: 'emphasisPostfix', raw: '［＃「山田」に傍点］', target: '山田', variant: '傍点' },
    { kind: 'rubyEnd', raw: '《やまだ》', reading: 'やまだ' },
  ]],
  ['｜［＃ここに「タイトル」の値を表示］《たいとる》', [
    { kind: 'rubyStart', raw: '｜' },
    { kind: 'valueField', raw: '［＃ここに「タイトル」の値を表示］', name: 'タイトル' },
    { kind: 'rubyEnd', raw: '《たいとる》', reading: 'たいとる' },
  ]],
  ['あ｜山田［＃x］太郎《やまだたろう》は', [
    { kind: 'text', raw: 'あ', text: 'あ' },
    { kind: 'rubyStart', raw: '｜' },
    { kind: 'text', raw: '山田', text: '山田' },
    { kind: 'comment', raw: '［＃x］', inner: 'x' },
    { kind: 'text', raw: '太郎', text: '太郎' },
    { kind: 'rubyEnd', raw: '《やまだたろう》', reading: 'やまだたろう' },
    { kind: 'text', raw: 'は', text: 'は' },
  ]],
  ['｜［＃傍点］山田［＃傍点終わり］《やまだ》', [
    { kind: 'rubyStart', raw: '｜' },
    { kind: 'emphasisSpanStart', raw: '［＃傍点］', variant: '傍点' },
    { kind: 'text', raw: '山田', text: '山田' },
    { kind: 'emphasisSpanEnd', raw: '［＃傍点終わり］', variant: '傍点' },
    { kind: 'rubyEnd', raw: '《やまだ》', reading: 'やまだ' },
  ]],
  // No reading on the line, an empty 《》, a later ｜ (last wins), a broken ［＃, or nothing
  // visible before the 《: the ｜ and what followed it come out as typed.
  ['｜山田［＃x］\n次', [
    { kind: 'text', raw: '｜山田', text: '｜山田' },
    { kind: 'comment', raw: '［＃x］', inner: 'x' },
    { kind: 'text', raw: '\n次', text: '\n次' },
  ]],
  ['｜a［＃x］《》b', [
    { kind: 'text', raw: '｜a', text: '｜a' },
    { kind: 'comment', raw: '［＃x］', inner: 'x' },
    { kind: 'text', raw: '《》b', text: '《》b' },
  ]],
  ['｜a［＃x］｜b《r》', [
    { kind: 'text', raw: '｜a', text: '｜a' },
    { kind: 'comment', raw: '［＃x］', inner: 'x' },
    { kind: 'rubyStart', raw: '｜' },
    { kind: 'text', raw: 'b', text: 'b' },
    { kind: 'rubyEnd', raw: '《r》', reading: 'r' },
  ]],
  ['｜山田［＃こわれ《やまだ》', [
    { kind: 'text', raw: '｜山田', text: '｜山田' },
    { kind: 'brokenAnnotation', raw: '［＃こわれ《やまだ》' },
  ]],
  // A 縦中横 span edge ends the base: the ｜ turns literal on either side of it.
  ['［＃縦中横］｜1［＃縦中横終わり］2《いち》', [
    { kind: 'tcySpanStart', raw: '［＃縦中横］' },
    { kind: 'text', raw: '｜1', text: '｜1' },
    { kind: 'tcySpanEnd', raw: '［＃縦中横終わり］' },
    { kind: 'rubyImplicit', raw: '2《いち》', base: '2', reading: 'いち' },
  ]],
  ['｜［＃縦中横］12［＃縦中横終わり］《じゅうに》', [
    { kind: 'text', raw: '｜', text: '｜' },
    { kind: 'tcySpanStart', raw: '［＃縦中横］' },
    { kind: 'text', raw: '12', text: '12' },
    { kind: 'tcySpanEnd', raw: '［＃縦中横終わり］' },
    { kind: 'text', raw: '《じゅうに》', text: '《じゅうに》' },
  ]],
  ['｜［＃メモ］《よみ》', [
    { kind: 'text', raw: '｜', text: '｜' },
    { kind: 'comment', raw: '［＃メモ］', inner: 'メモ' },
    { kind: 'text', raw: '《よみ》', text: '《よみ》' },
  ]],
];

test('an explicit ruby tokenizes as rubyStart … rubyEnd, annotations inside included; a ｜ without a reading stays typed', () => {
  for (const [src, expected] of SPAN_FORM_CASES) {
    assert.deepEqual(tokenize(src), expected, JSON.stringify(src));
  }
});

test('findTcyIssues: an explicit ruby inside 縦中横 counts its markup as content, like the implicit form', () => {
  assert.deepEqual(findTcyIssues('［＃縦中横］｜1［＃x］2《いち》［＃縦中横終わり］'), [
    { start: 6, end: 17, kind: 'tooLong' }, // ｜12《いち》 = 7 code points, the comment adds none
  ]);
});

// --------------------------------------------------------------- findUnpairedSpans

test('findUnpairedSpans flags an unterminated ここから over the start annotation', () => {
  assert.deepEqual(findUnpairedSpans('［＃ここから２字下げ］\nA'), [
    { start: 0, end: 11, kind: 'unterminated', block: true },
  ]);
});

test('findUnpairedSpans flags a dangling ここで…終わり over the end annotation', () => {
  assert.deepEqual(findUnpairedSpans('A\n［＃ここで字下げ終わり］'), [
    { start: 2, end: 14, kind: 'dangling', block: true },
  ]);
});

test('findUnpairedSpans: balanced pairs and cross-channel overlap are clean', () => {
  assert.deepEqual(findUnpairedSpans('［＃ここから太字］\nA\n［＃ここで太字終わり］'), []);
  assert.deepEqual(
    findUnpairedSpans(
      '［＃ここから２字下げ］\n［＃ここから太字］\nA\n［＃ここで太字終わり］\n［＃ここで字下げ終わり］',
    ),
    [],
  );
});

test('findUnpairedSpans: a same-channel re-open replaces the slot (last-wins, no warning)', () => {
  assert.deepEqual(
    findUnpairedSpans('［＃ここから２字下げ］\n［＃ここから４字下げ］\nA\n［＃ここで字下げ終わり］'),
    [],
  );
});

test('findUnpairedSpans: only a SECOND end of the same channel dangles', () => {
  assert.deepEqual(
    findUnpairedSpans('［＃ここから太字］\nA\n［＃ここで太字終わり］\n［＃ここで太字終わり］'),
    [{ start: 24, end: 35, kind: 'dangling', block: true }],
  );
});

test('findUnpairedSpans: inline spans pair per channel, whatever the form (as the render does)', () => {
  // An unterminated inline opener is the inline Warning (block: false picks its message).
  assert.deepEqual(findUnpairedSpans('［＃太字］A'), [{ start: 0, end: 5, kind: 'unterminated', block: false }]);
  assert.deepEqual(findUnpairedSpans('［＃大見出し］A'), [{ start: 0, end: 7, kind: 'unterminated', block: false }]);
  // Mixed forms pair: the render clears the channel whichever form the end takes.
  assert.deepEqual(findUnpairedSpans('［＃太字］A［＃ここで太字終わり］'), []);
  assert.deepEqual(findUnpairedSpans('［＃ここから太字］\nA\n［＃太字終わり］'), []);
  assert.deepEqual(findUnpairedSpans('［＃傍点］A［＃傍点終わり］'), []);
});

test('findUnpairedSpans: a dangling inline 終わり warns; channels pair, not variants', () => {
  assert.deepEqual(findUnpairedSpans('A［＃傍点終わり］'), [{ start: 1, end: 9, kind: 'dangling', block: false }]);
  // Same channel, another variant: one slot, so it pairs.
  assert.deepEqual(findUnpairedSpans('［＃傍点］A［＃白ゴマ傍点終わり］'), []);
  // The left-side spelling resolves through the span form's bare 左に.
  assert.deepEqual(findUnpairedSpans('［＃左に傍点］A［＃傍点終わり］'), []);
  // Another channel: the opener stays unterminated AND the end dangles.
  assert.deepEqual(findUnpairedSpans('［＃傍点］A［＃傍線終わり］'), [
    { start: 0, end: 5, kind: 'unterminated', block: false },
    { start: 6, end: 14, kind: 'dangling', block: false },
  ]);
  // 縦中横 is line-local: findTcyIssues owns it.
  assert.deepEqual(findUnpairedSpans('［＃縦中横］12'), []);
});

test('findUnpairedSpans: 見出し blocks ride their own channel', () => {
  assert.deepEqual(findUnpairedSpans('［＃ここから大見出し］\nA'), [
    { start: 0, end: 11, kind: 'unterminated', block: true },
  ]);
  assert.deepEqual(findUnpairedSpans('A\n［＃ここで大見出し終わり］'), [
    { start: 2, end: 15, kind: 'dangling', block: true },
  ]);
  assert.deepEqual(
    findUnpairedSpans('［＃ここから大見出し］\nA\n［＃ここで大見出し終わり］'),
    [],
  );
  // Cross-channel overlap with 字下げ is clean; all three levels share the ONE heading
  // channel, so a re-open is a level change and a mismatched-level end still pairs.
  assert.deepEqual(
    findUnpairedSpans(
      '［＃ここから２字下げ］\n［＃ここから大見出し］\nA\n［＃ここで大見出し終わり］\n［＃ここで字下げ終わり］',
    ),
    [],
  );
  assert.deepEqual(
    findUnpairedSpans('［＃ここから大見出し］\n［＃ここから中見出し］\nA\n［＃ここで小見出し終わり］'),
    [],
  );
});

// --------------------------------------------------------------- unterminatedOpeners / closingAnnotation

/** The one opener `src` leaves open (each source below opens exactly one channel). */
const openerOf = (src: string): SpanOpener => {
  const openers = unterminatedOpeners(src);
  assert.equal(openers.length, 1);
  const first = openers[0];
  assert.ok(first);
  return first;
};

test('unterminatedOpeners: survivors in channel order; a re-open supersedes; an end clears', () => {
  const six =
    '［＃ここから２字下げ］\n［＃ここから太字］\n［＃ここから斜体］\n［＃ここから中見出し］\n［＃左に傍点］［＃傍線］一';
  assert.deepEqual(
    unterminatedOpeners(six).map((t) => t.raw),
    ['［＃ここから２字下げ］', '［＃ここから太字］', '［＃ここから斜体］', '［＃ここから中見出し］', '［＃左に傍点］', '［＃傍線］'],
  );
  assert.equal(openerOf('［＃傍点］一［＃白ゴマ傍点］二').raw, '［＃白ゴマ傍点］');
  assert.deepEqual(unterminatedOpeners('［＃太字］一［＃太字終わり］'), []);
  assert.deepEqual(unterminatedOpeners('［＃縦中横］12'), []);
});

test('closingAnnotation: the ここで form wherever the channel has one, the inline form for 傍点/傍線', () => {
  const cases: readonly [opener: string, text: string, block: boolean][] = [
    ['［＃ここから２字下げ］', '［＃ここで字下げ終わり］', true],
    ['［＃太字］', '［＃ここで太字終わり］', true],
    ['［＃ここから斜体］', '［＃ここで斜体終わり］', true],
    ['［＃中見出し］', '［＃ここで中見出し終わり］', true],
    ['［＃ここから小見出し］', '［＃ここで小見出し終わり］', true],
    ['［＃左に傍点］', '［＃左に傍点終わり］', false],
    ['［＃波線］', '［＃波線終わり］', false],
  ];
  for (const [opener, text, block] of cases) {
    assert.deepEqual(closingAnnotation(openerOf(opener)), { text, block });
    // Self-consistency: the closer re-tokenizes to the end that pairs this opener.
    assert.deepEqual(findUnpairedSpans(`${opener}\n${text}`), []);
  }
});

// --------------------------------------------------------------- splitLines

test('splitLines: \\n and \\r\\n terminate; a lone \\r stays literal', () => {
  assert.deepEqual(splitLines('あ\r\nい\n\r\n'), ['あ', 'い', '', '']);
  assert.deepEqual(splitLines('あ\rい'), ['あ\rい']);
  assert.deepEqual(splitLines(''), ['']);
});

test('findTcyIssues: a CRLF \\r is neither content nor inside the range', () => {
  // the line-end auto-close only, no tooLong
  assert.deepEqual(findTcyIssues('［＃縦中横］123\r\n次'), [{ start: 0, end: 6, kind: 'unterminated' }]);
  // the range stops before the \r
  assert.deepEqual(findTcyIssues('［＃縦中横］1234\r\n次'), [
    { start: 0, end: 6, kind: 'unterminated' },
    { start: 6, end: 10, kind: 'tooLong' },
  ]);
});
