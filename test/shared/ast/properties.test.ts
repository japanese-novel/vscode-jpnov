/**
 * What holds for EVERY manuscript, checked over generated ones: the syntax layer is lossless and
 * tiles the source, the relations name real nodes, and the content stays inside its line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TextDocument } from 'vscode-languageserver-textdocument';

import type { PairedNode } from '../../../src/shared/ast/nodes.ts';
import { gaijiAnnotation } from '../../../src/shared/ast/notation.ts';
import { parse } from '../../../src/shared/ast/parse.ts';
import { printLine, printSource } from '../../../src/shared/ast/print.ts';
import { resolve } from '../../../src/shared/ast/resolve.ts';
import { scan } from '../../../src/shared/ast/scan.ts';
import { displayText, graphemes } from '../../../src/shared/chars.ts';

import { manuscripts, withEol } from './_fuzz.ts';
import { clusterStarts } from '../../../src/shared/ast/span.ts';
import { isPostfix, nodesIn } from './_shape.ts';

const CORPUS = manuscripts();
/** The same manuscripts with a lone CR for every terminator — the third line ending. */
const ALL = [...CORPUS, ...CORPUS.slice(0, 60).map((src) => withEol(src, '\r'))];

/** The slot a span start or end drives, the 縦中横 one included. */
const slotOf = (node: PairedNode): string =>
  'channel' in node ? node.channel : node.kind.replace(/Span(Start|End)|Block(Start|End)/, '');

test('the syntax layer prints back the source it was read from', () => {
  for (const src of ALL) {
    assert.equal(printSource(scan(src)), src, JSON.stringify(src));
    assert.equal(printSource(parse(src)), src, JSON.stringify(src));
  }
});

test('printLine prints a line without its terminator; printSource keeps every terminator as typed', () => {
  assert.deepEqual(scan('山田《やまだ》［＃メモ］\n次').lines.map(printLine), ['山田《やまだ》［＃メモ］', '次']);
  assert.equal(printSource(scan('あ\r\nい\nう\rえ\n')), 'あ\r\nい\nう\rえ\n');
});

test('the lines tile the source and are the lines of the editor', () => {
  for (const src of ALL) {
    const doc = TextDocument.create('mem://x.jpnov', 'jpnov', 1, src);
    const { lines } = scan(src);
    assert.equal(lines.length, doc.lineCount, JSON.stringify(src));
    let at = 0;
    lines.forEach((line, index) => {
      assert.equal(line.index, index);
      assert.equal(line.span.start, at);
      assert.equal(doc.positionAt(line.span.start).line, index);
      assert.equal(src.slice(line.span.end, line.span.end + line.eol.length), line.eol);
      at = line.span.end + line.eol.length;
    });
    assert.equal(at, src.length);
    assert.equal(lines[lines.length - 1]?.eol, '');
  }
});

test('the nodes tile their line; the parts tile their node', () => {
  for (const src of ALL) {
    for (const line of parse(src).lines) {
      let at = line.span.start;
      for (const node of line.syntax) {
        assert.equal(node.span.start, at, JSON.stringify(src));
        assert.equal(node.text, src.slice(node.span.start, node.span.end));
        assert.ok(node.text !== '', 'no empty node');
        at = node.span.end;
        if ('parts' in node) {
          let inside = node.span.start;
          for (const part of node.parts) {
            assert.equal(part.span.start, inside);
            assert.equal(part.text, src.slice(part.span.start, part.span.end));
            inside = part.span.end;
          }
          assert.equal(inside, node.span.end);
        }
      }
      assert.equal(at, line.span.end);
    }
  }
});

test('a pair is mutual and of one channel; a bound span lies before its postfix, on its line', () => {
  for (const src of ALL) {
    const ast = parse(src);
    const lineOf = new Map(ast.lines.flatMap((line) => line.syntax.map((node) => [node, line] as const)));
    const byStart = new Map([...ast.pairs.keys()].map((node) => [node.span.start, node]));
    for (const [node, to] of ast.pairs) {
      const other = byStart.get(to.start);
      assert.ok(other !== undefined, JSON.stringify(src));
      assert.deepEqual(other.span, to);
      assert.deepEqual(ast.pairs.get(other), node.span);
      assert.equal(slotOf(other), slotOf(node));
    }
    for (const [node, to] of ast.bound) {
      const line = lineOf.get(node);
      assert.ok(line !== undefined, JSON.stringify(src));
      assert.ok(to.start >= line.span.start && to.start < to.end, JSON.stringify(src));
      assert.ok(to.end <= node.span.start || to.end <= line.span.end);
    }
    for (const [node, held] of ast.held) {
      const line = lineOf.get(node);
      assert.ok(line !== undefined, JSON.stringify(src));
      assert.ok(held.span.start === node.span.end && held.span.end <= line.span.end, JSON.stringify(src));
    }
  }
});

test('the relations and the open spans name the very nodes of the lines', () => {
  for (const src of ALL) {
    const ast = parse(src);
    const nodes = new Set(nodesIn(ast));
    for (const node of [...ast.pairs.keys(), ...ast.bound.keys(), ...ast.held.keys(), ...ast.replaced.keys(), ...ast.openAtEnd]) {
      assert.ok(nodes.has(node), `${node.kind} in ${JSON.stringify(src)}`);
    }
    // Resolving adds the content and the state; the syntax layer is the scan's, untouched.
    const syntax = scan(src);
    assert.deepEqual(parse(src).lines.map((line) => line.syntax), syntax.lines.map((line) => line.syntax));
  }
});

test('what is open at the end is what the findings call unterminated; every finding sits on one line', () => {
  for (const src of ALL) {
    const ast = parse(src);
    const open = ast.openAtEnd.map((node) => node.span.start).sort((a, b) => a - b);
    const unterminated = ast.issues.flatMap((i) => (i.kind === 'unterminatedSpan' ? [i.span.start] : []));
    assert.deepEqual(unterminated, open, JSON.stringify(src));
    for (const issue of ast.issues) {
      assert.ok(issue.span.start >= 0 && issue.span.start <= issue.span.end && issue.span.end <= src.length);
      assert.doesNotMatch(src.slice(issue.span.start, issue.span.end), /[\r\n]/, `${issue.kind} in ${JSON.stringify(src)}`);
    }
  }
});

test('the content stays inside its line, is never empty, and is a display string', () => {
  for (const src of ALL) {
    for (const line of parse(src).lines) {
      for (const item of line.content) {
        assert.ok(item.span.start >= line.span.start && item.span.end <= line.span.end, JSON.stringify(src));
        const shown = item.kind === 'chars' || item.kind === 'tcy' ? item.text : item.kind === 'ruby' ? item.base : 'x';
        assert.ok(shown !== '', `an empty ${item.kind} in ${JSON.stringify(src)}`);
        assert.equal(displayText(shown), shown);
      }
    }
  }
});

test('every character of the content knows where it was written', () => {
  for (const src of ALL) {
    for (const line of parse(src).lines) {
      for (const item of line.content) {
        if (item.kind !== 'chars') {
          continue;
        }
        if (item.origin === 'value') {
          assert.equal(item.starts, undefined, JSON.stringify(src)); // a value has no place of its own
          continue;
        }
        if (item.origin === 'gaiji') {
          assert.equal(item.starts, undefined, JSON.stringify(src));
          assert.equal(src.slice(item.span.start, item.span.end), gaijiAnnotation(item.text), JSON.stringify(src));
          continue;
        }
        const starts = clusterStarts(item);
        graphemes(item.text).forEach((ch, i) => {
          const from = starts[i] ?? -1;
          const to = starts[i + 1] ?? item.span.end;
          assert.ok(item.span.start <= from && from < to && to <= item.span.end, JSON.stringify(src));
          assert.equal(displayText(src.slice(from, to)), ch, JSON.stringify(src));
        });
      }
    }
  }
});

test('a parse is a pure function of its source; the lines and the findings are plain data', () => {
  for (const src of ALL.slice(0, 120)) {
    const ast = parse(src);
    assert.deepEqual(parse(src), ast);
    const plain = { lines: ast.lines, issues: ast.issues, openAtEnd: ast.openAtEnd };
    assert.deepEqual(JSON.parse(JSON.stringify(plain)), plain);
  }
});

test('a postfix binds within its line: a line resolved alone binds as it does in its manuscript', () => {
  for (const src of ALL) {
    const ast = parse(src);
    for (const line of ast.lines) {
      const alone = resolve({ lines: [line], issues: [] }).bound;
      for (const node of line.syntax.filter(isPostfix)) {
        assert.deepEqual(alone.get(node), ast.bound.get(node), JSON.stringify(src));
      }
    }
  }
});

test('a line of any length scans and resolves', () => {
  // More nodes on one line than a call takes arguments.
  const many = 150_000;
  const memos = '［＃メモ］'.repeat(many);
  assert.equal(scan(`｜${memos}`).lines[0]?.syntax.length, many + 1); // a ｜ that gets no reading
  assert.equal(scan(`｜語${memos}《よみ》`).lines[0]?.syntax.length, many + 3);
  for (const src of [`語${memos}彙［＃「語彙」は縦中横］`, `語${memos}彙［＃「語彙」の左に「ごい」のルビ］`, `｜語${memos}彙《ごい》`]) {
    const ast = parse(src);
    assert.deepEqual([ast.lines[0]?.content.length, ast.issues], [many + 1, []], src.slice(-20));
  }
  // A 《 with no 》 after it on its line is text, however many there are.
  assert.deepEqual(scan('《'.repeat(many)).lines[0]?.syntax.map((node) => node.kind), ['text']);
});
