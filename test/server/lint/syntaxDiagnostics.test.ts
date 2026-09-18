/**
 * Editor-surface tests for src/server/syntax.ts — the always-on unclosed-［＃ Error diagnostics
 * that publishFindings merges ahead of the lint findings. Pure + import-light (relative imports
 * only in the graph), so it runs on Node's native test loader inside the `test/server/lint/**`
 * npm-test glob. The span logic itself is covered in test/shared/compiler/tokenizer.test.ts via
 * `findBrokenAnnotations`; these tests pin the LSP mapping (Range / severity / code / source).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { annotationDiagnostics } from '../../../src/server/syntax.ts';

const doc = (text: string): TextDocument =>
  TextDocument.create('mem://x.jpnov', 'jpnov', 1, text);

test('a clean document yields no syntax diagnostics', () => {
  assert.deepEqual(annotationDiagnostics(doc('本文［＃メモ］と《るび》。')), []);
});

test('an unclosed ［＃ yields one Error covering ［＃…-to-line-end', () => {
  const diags = annotationDiagnostics(doc('本［＃こわれ\n次の行'));
  assert.equal(diags.length, 1);
  const d = diags[0];
  assert.ok(d);
  assert.equal(d.severity, DiagnosticSeverity.Error);
  assert.equal(d.source, 'jpnov');
  assert.deepEqual(d.data, { code: 'syntax.unclosedAnnotation' });
  assert.equal(d.message, 'unterminated ［＃ annotation (missing ］)');
  assert.deepEqual(d.range, {
    start: { line: 0, character: 1 },
    end: { line: 0, character: 6 }, // just past こわれ, before the \n
  });
});

test('the Error range excludes the \\r of a CRLF terminator', () => {
  const diags = annotationDiagnostics(doc('［＃注\r\n次'));
  assert.deepEqual(diags[0]?.range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 3 },
  });
});

test('one Error per broken line; lone ］ / 《 / 》 raise nothing', () => {
  const diags = annotationDiagnostics(doc('a［＃x\nb［＃y\n単独の］と《ひらき\nルビ》'));
  assert.equal(diags.length, 2);
  assert.deepEqual(diags.map((d) => d.range.start.line), [0, 1]);
});

test('an unclosed ［＃ at end of input (no trailing newline) spans to the document end', () => {
  const diags = annotationDiagnostics(doc('これは［＃壊れた'));
  assert.deepEqual(diags[0]?.range, {
    start: { line: 0, character: 3 },
    end: { line: 0, character: 8 },
  });
});

// --------------------------------------------------------------- block pairing Warnings

test('an unterminated ここから block yields one Warning over the ここから body', () => {
  const diags = annotationDiagnostics(doc('［＃ここから２字下げ］\n本文だけで終わる'));
  assert.equal(diags.length, 1);
  const d = diags[0];
  assert.ok(d);
  assert.equal(d.severity, DiagnosticSeverity.Warning);
  assert.deepEqual(d.data, { code: 'syntax.unterminatedBlock' });
  assert.equal(d.message, 'unterminated block annotation (missing ［＃ここで…終わり］)');
  assert.deepEqual(d.range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 11 }, // ［＃ここから２字下げ］
  });
});

test('a dangling ここで…終わり yields one Warning over the 終わり body', () => {
  const diags = annotationDiagnostics(doc('本文\n［＃ここで字下げ終わり］'));
  assert.equal(diags.length, 1);
  const d = diags[0];
  assert.ok(d);
  assert.equal(d.severity, DiagnosticSeverity.Warning);
  assert.deepEqual(d.data, { code: 'syntax.danglingBlockEnd' });
  assert.equal(d.message, 'block-end annotation without a matching start');
  assert.deepEqual(d.range, {
    start: { line: 1, character: 0 },
    end: { line: 1, character: 12 }, // ［＃ここで字下げ終わり］
  });
});

test('a balanced block pair yields no diagnostics', () => {
  assert.deepEqual(
    annotationDiagnostics(doc('［＃ここから２字下げ］\n本文\n［＃ここで字下げ終わり］')),
    [],
  );
});

test('見出し blocks ride the same pairing Warnings; the inline pair takes the span codes', () => {
  const un = annotationDiagnostics(doc('［＃ここから大見出し］\n題'));
  assert.equal(un.length, 1);
  assert.deepEqual(un[0]?.data, { code: 'syntax.unterminatedBlock' });
  const dg = annotationDiagnostics(doc('題\n［＃ここで中見出し終わり］'));
  assert.equal(dg.length, 1);
  assert.deepEqual(dg[0]?.data, { code: 'syntax.danglingBlockEnd' });
  assert.deepEqual(
    annotationDiagnostics(doc('［＃ここから大見出し］\n題\n［＃ここで大見出し終わり］')),
    [],
  );
  // The inline pair pairs like ［＃太字］; an unterminated opener is the inline Warning.
  assert.deepEqual(annotationDiagnostics(doc('［＃大見出し］題［＃大見出し終わり］')), []);
  const sp = annotationDiagnostics(doc('［＃大見出し］題'));
  assert.equal(sp.length, 1);
  assert.deepEqual(sp[0]?.data, { code: 'syntax.unterminatedSpan' });
});

test('an unterminated inline opener and a dangling inline 終わり yield the span Warnings', () => {
  const un = annotationDiagnostics(doc('本文［＃太字］題'));
  assert.equal(un.length, 1);
  const u = un[0];
  assert.ok(u);
  assert.equal(u.severity, DiagnosticSeverity.Warning);
  assert.deepEqual(u.data, { code: 'syntax.unterminatedSpan' });
  assert.equal(u.message, 'unterminated start/end annotation (missing ［＃…終わり］)');
  assert.deepEqual(u.range, {
    start: { line: 0, character: 2 },
    end: { line: 0, character: 7 }, // ［＃太字］
  });
  const dg = annotationDiagnostics(doc('題\n［＃傍点終わり］'));
  assert.equal(dg.length, 1);
  const d = dg[0];
  assert.ok(d);
  assert.equal(d.severity, DiagnosticSeverity.Warning);
  assert.deepEqual(d.data, { code: 'syntax.danglingSpanEnd' });
  assert.equal(d.message, 'end annotation without a matching start');
  assert.deepEqual(d.range, {
    start: { line: 1, character: 0 },
    end: { line: 1, character: 8 }, // ［＃傍点終わり］
  });
  // Forms pair by channel, as the render does: neither mixed pair warns.
  assert.deepEqual(annotationDiagnostics(doc('［＃ここから太字］\n題\n［＃太字終わり］')), []);
  assert.deepEqual(annotationDiagnostics(doc('［＃太字］題［＃ここで太字終わり］')), []);
});

test('a same-channel re-open replaces the slot (last-wins) — balanced, no Warning', () => {
  // ２字下げ → ４字下げ is a legal amount change (render is last-wins); one ここで clears it.
  // A stack model would wrongly flag the first ここから as unterminated (diagnostic ≠ render).
  assert.deepEqual(
    annotationDiagnostics(
      doc('［＃ここから２字下げ］\n本文\n［＃ここから４字下げ］\n本文\n［＃ここで字下げ終わり］'),
    ),
    [],
  );
});

test('lexical Errors come first, then span Warnings', () => {
  const diags = annotationDiagnostics(doc('［＃ここから太字］\n壊れ［＃こわれ'));
  assert.deepEqual(
    diags.map((d) => d.severity),
    [DiagnosticSeverity.Error, DiagnosticSeverity.Warning],
  );
});

// --------------------------------------------------------------- 縦中横 Warnings

test('縦中横 structural issues surface as Warnings with their codes', () => {
  const unterminated = annotationDiagnostics(doc('序［＃縦中横］12'));
  assert.equal(unterminated.length, 1);
  const d = unterminated[0];
  assert.ok(d);
  assert.equal(d.severity, DiagnosticSeverity.Warning);
  assert.deepEqual(d.data, { code: 'syntax.unterminatedTcy' });
  assert.deepEqual(annotationDiagnostics(doc('［＃縦中横終わり］'))[0]?.data, {
    code: 'syntax.danglingTcyEnd',
  });
  assert.deepEqual(annotationDiagnostics(doc('［＃縦中横］1234［＃縦中横終わり］'))[0]?.data, {
    code: 'syntax.tcyTooLong',
  });
  assert.deepEqual(annotationDiagnostics(doc('令和［＃縦中横］12［＃縦中横終わり］年')), []);
});

test('縦中横: a CRLF \\r is not content (no tooLong on three digits)', () => {
  const diags = annotationDiagnostics(doc('［＃縦中横］123\r\n次'));
  assert.equal(diags.length, 1); // the line-end auto-close only
  assert.deepEqual(diags[0]?.data, { code: 'syntax.unterminatedTcy' });
});

// --------------------------------------------------------------- postfix target Warnings

test('an unresolved postfix target yields one Warning over the annotation, carrying the target', () => {
  const diags = annotationDiagnostics(doc('別の文［＃「無」に傍点］'));
  assert.equal(diags.length, 1);
  const d = diags[0];
  assert.ok(d);
  assert.equal(d.severity, DiagnosticSeverity.Warning);
  assert.equal(d.source, 'jpnov');
  assert.deepEqual(d.data, { code: 'syntax.postfixTargetMissing', args: ['無'] });
  assert.equal(d.message, 'annotation target "無" is not on this line, or is not aligned to a character boundary');
  assert.deepEqual(d.range, {
    start: { line: 0, character: 3 },
    end: { line: 0, character: 12 }, // ［＃「無」に傍点］
  });
});

test('a boundary-unaligned target warns; whole-unit and plain-text matches stay silent', () => {
  // 字 cuts into the atomic ruby unit 漢字 → Warning (the mark is not applied).
  assert.equal(annotationDiagnostics(doc('漢字《かんじ》［＃「字」に傍点］')).length, 1);
  // Whole-unit coverage and plain-prose substrings are aligned → clean.
  assert.deepEqual(annotationDiagnostics(doc('漢字《かんじ》［＃「漢字」に傍点］')), []);
  assert.deepEqual(annotationDiagnostics(doc('文字［＃「字」に傍点］')), []);
});

test('a 見出し postfix rides the same target Warning; a resolved one is clean', () => {
  const diags = annotationDiagnostics(doc('本文［＃「別文」は大見出し］'));
  assert.equal(diags.length, 1);
  assert.deepEqual(diags[0]?.data, { code: 'syntax.postfixTargetMissing', args: ['別文'] });
  assert.deepEqual(annotationDiagnostics(doc('第一章［＃「第一章」は大見出し］')), []);
});

// --------------------------------------------------------------- base-less ruby Warnings

test('a closed 《…》 with no base yields one Warning over the run, carrying the reading', () => {
  const diags = annotationDiagnostics(doc('　行くぞ。《ごう》'));
  assert.equal(diags.length, 1);
  const d = diags[0];
  assert.ok(d);
  assert.equal(d.severity, DiagnosticSeverity.Warning);
  assert.equal(d.source, 'jpnov');
  assert.deepEqual(d.data, { code: 'syntax.rubyBaseMissing', args: ['ごう'] });
  assert.equal(d.message, 'ruby reading 《ごう》 has no base text before it (it prints as typed)');
  assert.deepEqual(d.range, {
    start: { line: 0, character: 5 },
    end: { line: 0, character: 9 }, // 《ごう》
  });
});

test('the ruby Warning range: from a bare ｜, before a CRLF, on the reading\'s own line', () => {
  const RANGES: readonly [src: string, line: number, from: number, to: number][] = [
    ['｜《よみ》', 0, 0, 5],
    ['《よみ》\r\n次', 0, 0, 4],
    ['｜語\n《ルビ》', 1, 0, 4],
    // A 縦中横 span edge ends a ｜ base: the reading after it has none and the ｜ stays literal.
    ['｜［＃縦中横］12［＃縦中横終わり］《じゅうに》', 0, 18, 24],
  ];
  for (const [src, line, from, to] of RANGES) {
    assert.deepEqual(
      annotationDiagnostics(doc(src)).map((d) => d.range),
      [{ start: { line, character: from }, end: { line, character: to } }],
      JSON.stringify(src),
    );
  }
});

test('a valid ruby and an unclosed 《 raise no ruby Warning; an empty 《》 is a Warning of its own', () => {
  assert.deepEqual(annotationDiagnostics(doc('漢字《かんじ》')), []);
  assert.deepEqual(annotationDiagnostics(doc('《ひらき')), []);
  const diags = annotationDiagnostics(doc('｜漢字《》'));
  assert.equal(diags.length, 1);
  const d = diags[0];
  assert.ok(d);
  assert.equal(d.severity, DiagnosticSeverity.Warning);
  assert.deepEqual(d.data, { code: 'syntax.rubyReadingEmpty' });
  assert.equal(d.message, 'empty ruby reading 《》 (it prints as typed)');
  assert.deepEqual(d.range, {
    start: { line: 0, character: 3 },
    end: { line: 0, character: 5 }, // 《》
  });
});

test('ruby Warnings come after the postfix-target Warnings', () => {
  const diags = annotationDiagnostics(doc('別の文［＃「無」に傍点］《x》'));
  assert.deepEqual(
    diags.map((d): unknown => d.data),
    [
      { code: 'syntax.postfixTargetMissing', args: ['無'] },
      { code: 'syntax.rubyBaseMissing', args: ['x'] },
    ],
  );
  assert.deepEqual(
    diags.map((d) => [d.range.start.character, d.range.end.character]),
    [[3, 12], [12, 15]],
  );
});

test('a ｜ base holding annotations is a ruby; a ｜ with nothing visible before its 《 warns from the ｜', () => {
  assert.deepEqual(annotationDiagnostics(doc('｜山田［＃「山田」に傍点］《やまだ》')), []);
  assert.deepEqual(annotationDiagnostics(doc('｜［＃ここに「タイトル」の値を表示］《たいとる》')), []);
  const diags = annotationDiagnostics(doc('｜［＃メモ］《よみ》'));
  assert.equal(diags.length, 1);
  const d = diags[0];
  assert.ok(d);
  assert.deepEqual(d.data, { code: 'syntax.rubyBaseMissing', args: ['よみ'] });
  assert.deepEqual(d.range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 10 }, // ｜［＃メモ］《よみ》
  });
});
