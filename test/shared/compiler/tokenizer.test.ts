import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBrokenAnnotations,
  findTcyIssues,
  findUnpairedBlocks,
  splitLines,
  tokenize,
  VALUE_FIELD_BY_NAME,
  VALUE_FIELD_PLACEHOLDERS,
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

test('tokenize splits an explicit-base ruby with a ｜ marker', () => {
  const toks = tokenize('彼は｜走《はし》った');
  assert.deepEqual(toks, [
    { kind: 'text', raw: '彼は', text: '彼は' },
    { kind: 'rubyExplicit', raw: '｜走《はし》', base: '走', reading: 'はし' },
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
    { kind: 'rubyExplicit', raw: '｜c《r》', base: 'c', reading: 'r' },
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

test('値の表示 tokenizes each field name; an unknown name greys out like any typo', () => {
  for (const [name, field] of VALUE_FIELD_BY_NAME) {
    const raw = `［＃ここに「${name}」の値を表示］`;
    assert.deepEqual(tokenize(raw), [{ kind: 'valueField', raw, field }]);
  }
  assert.deepEqual(kinds(tokenize('［＃ここに「発行日」の値を表示］')), ['comment']);
  assert.deepEqual(kinds(tokenize('［＃ここに「タイトル」の値］')), ['comment']); // truncated tail
  assert.deepEqual(kinds(tokenize('［＃ここにタイトルの値を表示］')), ['comment']); // no corner quotes
});

test('値の表示: an Object.prototype name is just an unknown name, never a field', () => {
  // The name comes from the document: a plain object lookup would resolve these through the
  // prototype chain and hand the layout a function to substitute.
  for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const raw = `［＃ここに「${name}」の値を表示］`;
    assert.deepEqual(tokenize(raw), [{ kind: 'comment', raw, inner: raw.slice(2, -1) }]);
    assert.doesNotThrow(() => buildRows(tokenize(raw)));
    assert.doesNotThrow(() => findTcyIssues(`［＃縦中横］${raw}［＃縦中横終わり］`));
  }
});

test('値の表示 is not line-head gated and keeps its neighbours as text', () => {
  assert.deepEqual(kinds(tokenize('全［＃ここに「総ページ数」の値を表示］ページ')), [
    'text', 'valueField', 'text',
  ]);
});

test('findTcyIssues counts a value field at its BOOKLESS placeholder length', () => {
  // Relational, so the too-long threshold stays a private tuning value: a span holding a value
  // field must be judged exactly as one holding that field's placeholder typed out.
  const spanned = (content: string): string => `［＃縦中横］${content}［＃縦中横終わり］`;
  for (const [name, field] of VALUE_FIELD_BY_NAME) {
    const asField = findTcyIssues(spanned(`［＃ここに「${name}」の値を表示］`)).map((i) => i.kind);
    const asTyped = findTcyIssues(spanned(VALUE_FIELD_PLACEHOLDERS[field])).map((i) => i.kind);
    assert.deepEqual(asField, asTyped, `${name} must be accounted like its typed stand-in`);
  }
  // Two fields in one span accumulate, exactly as two typed runs would.
  assert.deepEqual(
    findTcyIssues(spanned('［＃ここに「タイトル」の値を表示］［＃ここに「ペンネーム」の値を表示］')).map((i) => i.kind),
    findTcyIssues(spanned(VALUE_FIELD_PLACEHOLDERS.title + VALUE_FIELD_PLACEHOLDERS.author)).map((i) => i.kind),
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

// --------------------------------------------------------------- findUnpairedBlocks

test('findUnpairedBlocks flags an unterminated ここから over the start annotation', () => {
  assert.deepEqual(findUnpairedBlocks('［＃ここから２字下げ］\nA'), [
    { start: 0, end: 11, kind: 'unterminated' },
  ]);
});

test('findUnpairedBlocks flags a dangling ここで…終わり over the end annotation', () => {
  assert.deepEqual(findUnpairedBlocks('A\n［＃ここで字下げ終わり］'), [
    { start: 2, end: 14, kind: 'dangling' },
  ]);
});

test('findUnpairedBlocks: balanced pairs and cross-channel overlap are clean', () => {
  assert.deepEqual(findUnpairedBlocks('［＃ここから太字］\nA\n［＃ここで太字終わり］'), []);
  assert.deepEqual(
    findUnpairedBlocks(
      '［＃ここから２字下げ］\n［＃ここから太字］\nA\n［＃ここで太字終わり］\n［＃ここで字下げ終わり］',
    ),
    [],
  );
});

test('findUnpairedBlocks: a same-channel re-open replaces the slot (last-wins, no warning)', () => {
  assert.deepEqual(
    findUnpairedBlocks('［＃ここから２字下げ］\n［＃ここから４字下げ］\nA\n［＃ここで字下げ終わり］'),
    [],
  );
});

test('findUnpairedBlocks: only a SECOND end of the same channel dangles', () => {
  assert.deepEqual(
    findUnpairedBlocks('［＃ここから太字］\nA\n［＃ここで太字終わり］\n［＃ここで太字終わり］'),
    [{ start: 24, end: 35, kind: 'dangling' }],
  );
});

test('findUnpairedBlocks: inline spans never participate in block pairing', () => {
  assert.deepEqual(findUnpairedBlocks('［＃太字］A'), []);
  assert.deepEqual(findUnpairedBlocks('［＃太字］A［＃ここで太字終わり］'), [
    { start: 6, end: 17, kind: 'dangling' },
  ]);
  assert.deepEqual(findUnpairedBlocks('［＃大見出し］A'), []);
});

test('findUnpairedBlocks: 見出し blocks ride their own channel', () => {
  assert.deepEqual(findUnpairedBlocks('［＃ここから大見出し］\nA'), [
    { start: 0, end: 11, kind: 'unterminated' },
  ]);
  assert.deepEqual(findUnpairedBlocks('A\n［＃ここで大見出し終わり］'), [
    { start: 2, end: 15, kind: 'dangling' },
  ]);
  assert.deepEqual(
    findUnpairedBlocks('［＃ここから大見出し］\nA\n［＃ここで大見出し終わり］'),
    [],
  );
  // Cross-channel overlap with 字下げ is clean; all three levels share the ONE heading
  // channel, so a re-open is a level change and a mismatched-level end still pairs.
  assert.deepEqual(
    findUnpairedBlocks(
      '［＃ここから２字下げ］\n［＃ここから大見出し］\nA\n［＃ここで大見出し終わり］\n［＃ここで字下げ終わり］',
    ),
    [],
  );
  assert.deepEqual(
    findUnpairedBlocks('［＃ここから大見出し］\n［＃ここから中見出し］\nA\n［＃ここで小見出し終わり］'),
    [],
  );
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
