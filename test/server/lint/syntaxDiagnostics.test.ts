/**
 * Editor-surface tests for src/server/syntax.ts — the always-on syntax findings (the unclosed-［＃
 * Error, the Warnings, the one fix) that publishFindings merges ahead of the lint findings. Pure + import-light (relative imports
 * only in the graph), so it runs on Node's native test loader inside the `test/server/lint/**`
 * npm-test glob. The findings themselves are covered in test/shared/ast/issues.test.ts; these
 * tests pin the LSP mapping (Range / severity / code / source).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CodeActionKind, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { Diagnostic } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import type { Finding } from '../../../src/server/diagnostics.ts';
import { buildCodeActions } from '../../../src/server/lint/codeActions.ts';
import { INDENT_TOO_LARGE, TCY_MAX, syntaxFindings } from '../../../src/server/syntax.ts';
import { rangeOf } from '../../../src/server/targets.ts';
import { INDENT_MAX, fullWidthDigits, indentAnnotation } from '../../../src/shared/ast/notation.ts';
import { parse } from '../../../src/shared/ast/parse.ts';
import { COVER_TEMPLATE } from '../../../src/shared/book/create.ts';
import { renderEnglish } from '../../../src/shared/messages.ts';
import { D } from '../../shared/_kana.ts';
import { at, blockOf } from '../../shared/ast/_shape.ts';
import { fixAllOf, openDoc as doc } from '../helpers.ts';

/** The syntax findings of `document` over the editor's parse of it. */
const annotationFindings = (document: TextDocument): Finding[] => syntaxFindings(document, parse(document.getText()));

/** The syntax diagnostics of `document` over the editor's parse of it. */
const annotationDiagnostics = (document: TextDocument): Diagnostic[] => annotationFindings(document).map((f) => f.diagnostic);

test('a clean document yields no syntax diagnostics', () => {
  assert.deepEqual(annotationDiagnostics(doc('本文［＃メモ］と《るび》。')), []);
});

test('the cover the panel creates yields no syntax diagnostics', () => {
  // Its counts sit inside ［＃縦中横］: a value field is judged by what it shows, not by its name.
  assert.deepEqual(annotationDiagnostics(doc(COVER_TEMPLATE)), []);
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
  // Forms pair by channel, as the render does: a mixed pair is neither unterminated nor dangling.
  assert.deepEqual(annotationDiagnostics(doc('［＃ここから太字］\n題\n［＃太字終わり］')).map((d) => d.code), ['syntax.spanFormMismatch']);
});

test('an end of the other form than its start: one Warning over the end, with the fix respelling it', () => {
  const cases: readonly [src: string, closer: string, expected: string, fixed: string][] = [
    ['［＃ここから太字］\n題\n［＃太字終わり］', '［＃太字終わり］', '［＃ここで太字終わり］', '［＃ここから太字］\n題\n［＃ここで太字終わり］'],
    ['［＃太字］題［＃ここで太字終わり］', '［＃ここで太字終わり］', '［＃太字終わり］', '［＃太字］題［＃太字終わり］'],
    // The keyword stays as written: the level is not this finding's object.
    ['［＃ここから大見出し］\n題\n［＃小見出し終わり］', '［＃小見出し終わり］', '［＃ここで小見出し終わり］', '［＃ここから大見出し］\n題\n［＃ここで小見出し終わり］'],
  ];
  for (const [src, closer, expected, fixed] of cases) {
    const document = doc(src);
    const findings = annotationFindings(document);
    assert.equal(findings.length, 1, src);
    const f = findings[0];
    assert.ok(f);
    assert.equal(f.diagnostic.severity, DiagnosticSeverity.Warning);
    assert.deepEqual(f.diagnostic.data, { code: 'syntax.spanFormMismatch', args: [expected] });
    assert.equal(f.diagnostic.message, `end annotation does not match the form of its start (write ${expected})`);
    const range = rangeOf(document, at(src, closer));
    assert.deepEqual(f.diagnostic.range, range);
    assert.deepEqual(f.fix, { range, newText: expected, within: [] });
    assert.equal(TextDocument.applyEdits(document, [f.fix]), fixed);
    // The code actions see it like a lint fix: a quick fix over the end, and the fix-all.
    const actions = buildCodeActions(document.uri, findings, range, undefined);
    assert.deepEqual(actions.map((a) => a.kind), [CodeActionKind.QuickFix, CodeActionKind.SourceFixAll]);
    assert.deepEqual(actions[0]?.edit?.changes?.[document.uri], [{ range, newText: expected }]);
  }
});

test('a start while its channel is in effect: one Warning over the start; the fix removes a redundant one', () => {
  const cases: readonly [src: string, mark: string, fixed: string | null][] = [
    // Mid-line: the annotation alone goes.
    ['［＃ここから太字］［＃太字］題［＃太字終わり］［＃ここで太字終わり］', '太字', '［＃ここから太字］題［＃太字終わり］［＃ここで太字終わり］'],
    // A ここから directive alone on its line goes with the line: the line painted nothing.
    ['［＃ここから太字］\n［＃ここから太字］\n題\n［＃ここで太字終わり］', '太字', '［＃ここから太字］\n題\n［＃ここで太字終わり］'],
    ['［＃ここから２字下げ］\r\n［＃ここから２字下げ］\r\n題', '２字下げ', '［＃ここから２字下げ］\r\n題'],
    // On the last line, the terminator before it goes instead.
    ['［＃ここから太字］\n題\n［＃ここから太字］', '太字', '［＃ここから太字］\n題'],
    // An inline start alone on its line stays a line: that line is painted (empty) either way.
    ['［＃太字］\n［＃太字］\n題［＃太字終わり］', '太字', '［＃太字］\n\n題［＃太字終わり］'],
    // What is set changes: the Warning names what is in effect, and there is no fix.
    ['［＃ここから大見出し］\n［＃ここから中見出し］\n題\n［＃ここで小見出し終わり］', '大見出し', null],
  ];
  for (const [src, mark, fixed] of cases) {
    const document = doc(src);
    const findings = annotationFindings(document).filter((f) => f.diagnostic.code === 'syntax.spanAlreadyOpen');
    assert.equal(findings.length, 1, src);
    const f = findings[0];
    assert.ok(f);
    assert.equal(f.diagnostic.severity, DiagnosticSeverity.Warning);
    assert.deepEqual(f.diagnostic.data, { code: 'syntax.spanAlreadyOpen', args: [mark] });
    assert.equal(f.diagnostic.message, `start annotation while ${mark} is already in effect`);
    assert.equal(f.diagnostic.range.start.line, rangeOf(document, at(src, '］', 1)).start.line, src);
    if (fixed === null) {
      assert.equal(f.fix, undefined, src);
      continue;
    }
    assert.ok(f.fix, src);
    assert.equal(f.fix.newText, '');
    assert.deepEqual(f.fix.within, []);
    assert.equal(TextDocument.applyEdits(document, [f.fix]), fixed, src);
  }
  // Blocks of different counts run together with one 終わり: the notation's own form, no Warning
  // (https://www.aozora.gr.jp/annotation/layout_2.html).
  assert.deepEqual(annotationDiagnostics(doc('［＃ここから２字下げ］\n本文\n［＃ここから４字下げ］\n本文\n［＃ここで字下げ終わり］')), []);
});

test('an end with nothing open: the fix removes it, with its line when a ここで directive had the line to itself', () => {
  const cases: readonly [src: string, code: string, fixed: string][] = [
    ['題\n［＃ここで太字終わり］\n次', 'syntax.danglingBlockEnd', '題\n次'],
    ['題\n［＃ここで字下げ終わり］', 'syntax.danglingBlockEnd', '題'],
    ['題［＃ここで太字終わり］次', 'syntax.danglingBlockEnd', '題次'], // not alone: the annotation only
    ['題［＃傍点終わり］次', 'syntax.danglingSpanEnd', '題次'],
    ['題\n［＃傍点終わり］\n次', 'syntax.danglingSpanEnd', '題\n\n次'], // an inline-only line is painted: it stays
    ['題［＃縦中横終わり］次', 'syntax.danglingTcyEnd', '題次'],
    // The second ここで of your example: the first one closed the channel.
    ['［＃ここから太字］\n題\n［＃ここで太字終わり］\n［＃ここで太字終わり］', 'syntax.danglingBlockEnd', '［＃ここから太字］\n題\n［＃ここで太字終わり］'],
  ];
  for (const [src, code, fixed] of cases) {
    const document = doc(src);
    const findings = annotationFindings(document);
    assert.deepEqual(findings.map((f) => f.diagnostic.code), [code], src);
    const f = findings[0];
    assert.ok(f?.fix, src);
    assert.deepEqual(f.fix, { range: f.fix.range, newText: '', within: [] });
    assert.equal(TextDocument.applyEdits(document, [f.fix]), fixed, src);
  }
});

test('a redundant pair in the other form resolves in ONE fix-all: the redundant start and the dangling end go, the end in between is respelled', () => {
  const src = '［＃ここから太字］［＃太字］テスト［＃太字終わり］［＃ここで太字終わり］\n［＃太字］［＃ここから太字］テスト［＃ここで太字終わり］［＃太字終わり］';
  const document = doc(src);
  const findings = annotationFindings(document);
  assert.deepEqual(
    findings.map((f) => [f.diagnostic.range.start.line, f.diagnostic.code]),
    [
      [0, 'syntax.spanAlreadyOpen'], [0, 'syntax.spanFormMismatch'], [0, 'syntax.danglingBlockEnd'],
      [1, 'syntax.spanAlreadyOpen'], [1, 'syntax.spanFormMismatch'], [1, 'syntax.danglingSpanEnd'],
    ],
  );
  const fixed = fixAllOf(document, findings);
  assert.equal(fixed, '［＃ここから太字］テスト［＃ここで太字終わり］\n［＃太字］テスト［＃太字終わり］');
  assert.deepEqual(annotationDiagnostics(doc(fixed)), []);
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

test('Errors and Warnings come in source order', () => {
  const diags = annotationDiagnostics(doc('［＃ここから太字］\n壊れ［＃こわれ'));
  assert.deepEqual(
    diags.map((d) => [d.range.start.line, d.severity]),
    [[0, DiagnosticSeverity.Warning], [1, DiagnosticSeverity.Error]],
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

test('縦中横: a postfix combining too much warns over its target', () => {
  const diags = annotationDiagnostics(doc('1234［＃「1234」は縦中横］'));
  assert.deepEqual(diags.map((d): unknown => d.data), [{ code: 'syntax.tcyTooLong' }]);
  assert.deepEqual(diags[0]?.range, {
    start: { line: 0, character: 7 },
    end: { line: 0, character: 11 }, // 1234, inside ［＃「1234」は縦中横］
  });
});

test('縦中横: a CRLF \\r is not content (no tooLong on three digits)', () => {
  const diags = annotationDiagnostics(doc('［＃縦中横］123\r\n次'));
  assert.equal(diags.length, 1); // the line-end auto-close only
  assert.deepEqual(diags[0]?.data, { code: 'syntax.unterminatedTcy' });
});

/** `[code, covered text]` of every diagnostic of a one-line `src`. */
const onLine = (src: string): unknown[] =>
  annotationDiagnostics(doc(src)).map((d): unknown => [
    (d.data as { code: string }).code,
    src.slice(d.range.start.character, d.range.end.character),
  ]);

test('縦中横: a span holding too much warns over what it holds, whatever closes it', () => {
  assert.deepEqual(onLine('［＃縦中横］1234［＃縦中横終わり］'), [['syntax.tcyTooLong', '1234']]);
  assert.deepEqual(onLine('［＃縦中横］123［＃縦中横終わり］'), []); // three render cleanly
  assert.deepEqual(onLine('［＃縦中横］12辻\u{E0100}［＃縦中横終わり］'), []); // a variation selector is no character of its own
  // A ruby inside keeps its base alone (its reading is reported instead); a comment adds nothing.
  assert.deepEqual(onLine('［＃縦中横］漢《かん》［＃縦中横終わり］'), [['syntax.rubyInTcy', '《かん》']]);
  assert.deepEqual(onLine('［＃縦中横］漢字《かんじ》の国［＃縦中横終わり］'), [['syntax.tcyTooLong', '漢字《かんじ》の国'], ['syntax.rubyInTcy', '《かんじ》']]);
  assert.deepEqual(onLine('［＃縦中横］12［＃x］3［＃縦中横終わり］'), []);
  // Closed by the line end: the range is the content still.
  for (const eol of ['', '\n次', '\r\n次']) {
    assert.deepEqual(
      onLine(`［＃縦中横］1234［＃メモ］${eol}`),
      [['syntax.unterminatedTcy', '［＃縦中横］'], ['syntax.tcyTooLong', '1234']],
      JSON.stringify(eol),
    );
  }
});

test('縦中横: the length is counted on the composed text', () => {
  assert.deepEqual(onLine(`［＃縦中横］か${D}きく［＃縦中横終わり］`), []);
  assert.deepEqual(onLine(`か${D}きく［＃「か${D}きく」は縦中横］`), []);
  assert.deepEqual(onLine(`［＃縦中横］か${D}きくけ［＃縦中横終わり］`), [['syntax.tcyTooLong', `か${D}きくけ`]]);
});

test('縦中横: a character no output can carry is not counted, in either form', () => {
  const fits = `1\u0007${'2'.repeat(TCY_MAX - 1)}\uFFFE`;
  assert.deepEqual(onLine(`［＃縦中横］${fits}［＃縦中横終わり］`), []);
  assert.deepEqual(onLine(`${fits}［＃「${fits}」は縦中横］`), []);
  assert.deepEqual(onLine(`［＃縦中横］${fits}3［＃縦中横終わり］`), [['syntax.tcyTooLong', `${fits}3`]]);
  assert.deepEqual(onLine(`${fits}3［＃「${fits}3」は縦中横］`), [['syntax.tcyTooLong', `${fits}3`]]);
});

test('縦中横: a value field counts as what it shows, never as its annotation', () => {
  assert.deepEqual(onLine('［＃縦中横］［＃ここに「総ページ数」の値を表示］［＃縦中横終わり］'), []);
  assert.deepEqual(
    onLine('［＃縦中横］123［＃ここに「ページ番号」の値を表示］［＃縦中横終わり］'),
    [['syntax.tcyTooLong', '123［＃ここに「ページ番号」の値を表示］']],
  );
  // A text value shows its name, a name outside the table itself.
  assert.deepEqual(
    onLine('［＃縦中横］［＃ここに「タイトル」の値を表示］［＃縦中横終わり］'),
    [['syntax.tcyTooLong', '［＃ここに「タイトル」の値を表示］']],
  );
  assert.deepEqual(onLine('［＃縦中横］［＃ここに「13」の値を表示］［＃縦中横終わり］'), []);
});

test('縦中横: a postfix inside an open span is reported where it is written', () => {
  assert.deepEqual(onLine('［＃縦中横］12［＃「12345」は縦中横］'), [
    ['syntax.unterminatedTcy', '［＃縦中横］'],
    ['syntax.postfixTargetMissing', '12345'], // the open span holds the text: nothing to bind to
    ['syntax.tcyTooLong', '12345'],
  ]);
});

// --------------------------------------------------------------- postfix target Warnings

test('an unresolved postfix target yields one Warning over the target, carrying it', () => {
  const diags = annotationDiagnostics(doc('別の文［＃「無」に傍点］'));
  assert.equal(diags.length, 1);
  const d = diags[0];
  assert.ok(d);
  assert.equal(d.severity, DiagnosticSeverity.Warning);
  assert.equal(d.source, 'jpnov');
  assert.deepEqual(d.data, { code: 'syntax.postfixTargetMissing', args: ['無'] });
  assert.equal(d.message, 'annotation target "無" is not on this line, or is not aligned to a character boundary');
  assert.deepEqual(d.range, {
    start: { line: 0, character: 6 },
    end: { line: 0, character: 7 }, // 無, inside ［＃「無」に傍点］
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

test('a postfix-target Warning and a ruby Warning on one line come in source order', () => {
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
    [[6, 7], [12, 15]],
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
  // Control characters alone show nothing (#140): the same warning, beside noControlChar's.
  const controls = annotationDiagnostics(doc('　｜\u0007\u0008《よみ》だ。'));
  assert.deepEqual(controls.map((c) => [c.data as unknown, c.range.start.character, c.range.end.character]), [
    [{ code: 'syntax.rubyBaseMissing', args: ['よみ'] }, 1, 8],
  ]);
});

test('a 字下げ above INDENT_MAX yields one Warning over the annotation, naming the largest count that is read', () => {
  const over = indentAnnotation(INDENT_MAX + 1);
  const [d, ...rest] = annotationDiagnostics(doc(`${over}本文`));
  assert.deepEqual(rest, []);
  assert.equal(d?.severity, DiagnosticSeverity.Warning);
  assert.deepEqual(d.data, INDENT_TOO_LARGE);
  assert.equal(d.message, renderEnglish(INDENT_TOO_LARGE.code, INDENT_TOO_LARGE.args));
  assert.ok(d.message.includes(fullWidthDigits(INDENT_MAX)));
  assert.deepEqual(d.range, { start: { line: 0, character: 0 }, end: { line: 0, character: over.length } });

  // The block form: its end no longer has a start.
  const block = annotationDiagnostics(doc(`${blockOf(over)}\nA\n［＃ここで字下げ終わり］`));
  assert.deepEqual(block.map((x) => x.range.start.line), [0, 2]);
  assert.deepEqual(block.map((x): unknown => x.data), [INDENT_TOO_LARGE, { code: 'syntax.danglingBlockEnd' }]);

  assert.deepEqual(annotationDiagnostics(doc(`${indentAnnotation(INDENT_MAX)}本文`)), []);
  assert.deepEqual(annotationDiagnostics(doc(`本文${over}`)), []); // mid-line: a comment like any other
});
