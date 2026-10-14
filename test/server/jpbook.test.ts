/**
 * Integration tests for the impure `*.jpbook` editor features (diagnostics, completion,
 * document links) against real `file:` fixtures. Entries are relative to the book's directory,
 * which every function takes (off `file:` it is syntax-only).
 * Runs via `npm run test:integration` with the other fs-fixture suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CompletionItemKind, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { Diagnostic } from 'vscode-languageserver/node';

import { INDENT_MAX, indentAnnotation } from '../../src/shared/ast/notation.ts';
import { HEADER, JPBOOK_VERSION, parseJpbook, type ParsedJpbook } from '../../src/shared/book/jpbook.ts';
import { FURNITURE_ALIGNS } from '../../src/shared/compiler/chrome.ts';
import {
  completeJpbook,
  diagnoseJpbook,
  documentLinksForJpbook,
} from '../../src/server/jpbook.ts';
import { INDENT_TOO_LARGE } from '../../src/server/syntax.ts';
import { FENCE_LINE, HEAD, meta, metaBody, metaLineOf, metaWith } from '../shared/book/_fixture.ts';
import { bookNames, makeTmpWorkspace, writeUnder } from './helpers.ts';

const DIVIDER_LINE = metaLineOf('divider');

/** The diagnostics of a book alone in its root (no neighbour to conflict with). */
const diagnoseAlone = (dirUri: string, parsed: ParsedJpbook): Promise<Diagnostic[]> => diagnoseJpbook(dirUri, parsed, []);

/** A book directory off the `file:` scheme: syntax and metadata only, no fs. */
const OFF_FS = 'vscode-vfs://host/book';

/** Chapter-line completion helper: `line` is the second chapter, so only paths are offered. */
function completeLine(dirUri: string, line: string, character: number): ReturnType<typeof completeJpbook> {
  const doc = `${meta()}a.jpnov\n${line}`;
  return completeJpbook(dirUri, parseJpbook(doc), line, { line: FENCE_LINE + 2, character });
}

/** The `{code}` each diagnostic carries in `.data` (the localized text lives client-side). */
function codesOf(diags: readonly { data?: unknown }[]): string[] {
  return diags.map((d) => (d.data as { code: string }).code);
}

test('diagnoseJpbook flags missing / directory / backslash / non-.jpnov as Error and dupes as Warning', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'src/ok.jpnov', 'x');
  await writeUnder(ws.dir, 'adir.jpnov/keep', 'x'); // makes adir.jpnov a directory
  const text = meta() +
    ['src/ok.jpnov', 'missing.jpnov', 'adir.jpnov', 'sub\\bad.jpnov', 'note.md', 'src/ok.jpnov', './src/ok.jpnov'].join('\n');

  const diags = await diagnoseAlone(ws.uri, parseJpbook(text));
  const codes = codesOf(diags);

  assert.equal(diags.length, 6, 'the metadata and src/ok.jpnov (first) produce no diagnostic');
  assert.equal(diags.filter((d) => d.severity === DiagnosticSeverity.Error).length, 4);
  assert.equal(diags.filter((d) => d.severity === DiagnosticSeverity.Warning).length, 2); // the repeat, and its ./ spelling
  assert.ok(codes.includes('jpbook.fileNotFound')); // missing.jpnov
  assert.ok(codes.includes('jpbook.entryIsDirectory')); // adir.jpnov
  assert.ok(codes.includes('jpbook.backslashSeparator')); // sub\bad.jpnov
  assert.ok(codes.includes('jpbook.notJpnov')); // note.md
  assert.ok(codes.includes('jpbook.duplicateEntry')); // 2nd src/ok.jpnov
  const notJp = diags.find((d) => (d.data as { code: string }).code === 'jpbook.notJpnov');
  assert.deepEqual((notJp?.data as { args: unknown[] }).args, ['note.md']);
});

test('diagnoseJpbook resolves an entry above the book directory and stats it', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'chapters/ch1.jpnov', 'x');
  const bookDir = `${ws.uri}/books`;
  assert.deepEqual(await diagnoseAlone(bookDir, parseJpbook(`${meta()}../chapters/ch1.jpnov`)), []);
  // Two spellings of the file above are one entry.
  const spelled = await diagnoseAlone(bookDir, parseJpbook(`${meta()}../chapters/ch1.jpnov\n./../chapters/ch1.jpnov`));
  assert.deepEqual(codesOf(spelled), ['jpbook.duplicateEntry']);
  const diags = await diagnoseAlone(bookDir, parseJpbook(`${meta()}../chapters/ch1.jpnov\n../chapters/missing.jpnov`));
  assert.deepEqual(codesOf(diags), ['jpbook.fileNotFound']);
  assert.deepEqual((diags[0]?.data as { args: unknown[] }).args, ['../chapters/missing.jpnov']);
});

test('diagnoseJpbook surfaces metadata warnings; a colon-less metadata line is an Error', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'ok.jpnov', 'x');
  const text = `${metaWith('publisher: x\ntitle: 二\nno colon here')}ok.jpnov`;

  const diags = await diagnoseAlone(ws.uri, parseJpbook(text));
  const byCode = new Map(diags.map((d) => [(d.data as { code: string }).code, d]));

  assert.equal(diags.length, 3, 'valid meta lines and the ok chapter stay silent');
  assert.equal(byCode.get('jpbook.metaUnknownKey')?.severity, DiagnosticSeverity.Warning);
  assert.equal(byCode.get('jpbook.metaDuplicateKey')?.severity, DiagnosticSeverity.Warning);
  assert.equal(byCode.get('jpbook.metaNotKeyValue')?.severity, DiagnosticSeverity.Error);
  assert.deepEqual((byCode.get('jpbook.metaNotKeyValue')?.data as { args: unknown[] }).args, ['no colon here']);
});

test('diagnoseJpbook flags the unwritten keys that cannot be empty on the fence, and no fence on the first line, even off file:', async () => {
  assert.deepEqual(await diagnoseAlone(OFF_FS, parseJpbook(`${meta()}a.jpnov`)), [], 'every key written: nothing');

  const diags = await diagnoseAlone(OFF_FS, parseJpbook(`${HEAD}\n  title: t\n ---\na.jpnov`));
  assert.deepEqual(
    diags.map((d) => ({ data: d.data as unknown, range: d.range, severity: d.severity })),
    ['headerAlign', 'footerAlign'].map((key) => ({
      data: { code: 'jpbook.metaEmptyValue', args: [key] },
      range: { start: { line: 3, character: 1 }, end: { line: 3, character: 4 } },
      severity: DiagnosticSeverity.Error,
    })),
  );

  // No fence: the metadata runs to the end, and that is the one thing reported about it.
  const unclosed = await diagnoseAlone(OFF_FS, parseJpbook(`${HEAD}\n  title: t\na.jpnov`));
  assert.deepEqual(
    unclosed.map((d) => [(d.data as { code: string }).code, d.range.start.line, d.range.start.character]),
    [['jpbook.metaUnterminated', 2, 2], ['jpbook.metaNotKeyValue', 3, 0]],
  );

  // A header alone: the metadata never closes, and the header is the line that says so.
  const bare = await diagnoseAlone(OFF_FS, parseJpbook(HEAD));
  assert.deepEqual(codesOf(bare), ['jpbook.metaUnterminated']);
  assert.deepEqual(bare[0]?.range, { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } });

  // An empty file has no header, and that is all that is said about it.
  const empty = await diagnoseAlone(OFF_FS, parseJpbook(''));
  assert.deepEqual(empty.map((d) => [d.data as unknown, d.range]), [
    [{ code: 'jpbook.headerMissing', args: [HEADER] }, { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }],
  ]);
});

test('diagnoseJpbook: a key in Error reports itself on its line; an unwritten key is an empty one', async () => {
  const at = (text: string): Promise<unknown[][]> =>
    diagnoseAlone(OFF_FS, parseJpbook(text)).then((diags) =>
      diags.map((d) => [(d.data as { code: string }).code, (d.data as { args: unknown[] }).args, d.severity, d.range.start.line]));
  // `title:` (empty) and `footerAlign: どこか` report themselves; the unwritten divider is simply none.
  assert.deepEqual(await at(meta({ title: '', footerAlign: 'どこか' }, ['divider']) + 'a.jpnov'), [
    ['jpbook.metaEmptyValue', ['title'], DiagnosticSeverity.Error, metaLineOf('title')],
    ['jpbook.metaBadEnum', ['footerAlign', 'どこか', FURNITURE_ALIGNS.join(', ')], DiagnosticSeverity.Error, metaLineOf('footerAlign')],
  ]);
  // An unwritten title or alignment is the same Error its empty line would be, on the fence.
  assert.deepEqual(await at(meta({}, ['title', 'headerAlign']) + 'a.jpnov'), [
    ['jpbook.metaEmptyValue', ['title'], DiagnosticSeverity.Error, FENCE_LINE - 2],
    ['jpbook.metaEmptyValue', ['headerAlign'], DiagnosticSeverity.Error, FENCE_LINE - 2],
  ]);
});

test('diagnoseJpbook: a header this extension does not read is the one Error, whatever lies below it', async () => {
  // A broken body below (an empty title, a stray line, a non-.jpnov chapter) goes unreported: nothing was read.
  const body = `${metaBody({ title: '' })}---\nstray\na.txt\n`;
  const at = (text: string, data: unknown, endChar: number): Promise<void> =>
    diagnoseAlone(OFF_FS, parseJpbook(text)).then((diags) => {
      assert.deepEqual(diags.map((d) => [d.data as unknown, d.severity, d.range]), [
        [data, DiagnosticSeverity.Error, { start: { line: 0, character: 0 }, end: { line: 0, character: endChar } }],
      ], text);
    });
  for (const version of ['2', '1.0', '']) {
    await at(`jpbook/${version}\n${body}`, { code: 'jpbook.versionUnsupported', args: [version, JPBOOK_VERSION] }, 7 + version.length);
  }
  await at(`version: 1.0\n${body}`, { code: 'jpbook.headerMissing', args: [HEADER] }, 12);
  await at(`\n${HEAD}${body}`, { code: 'jpbook.headerMissing', args: [HEADER] }, 0);
});

test('diagnoseJpbook: the chapters never return to metadata (later key and item lines are paths)', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'c.jpnov', 'x');
  const diags = await diagnoseAlone(ws.uri, parseJpbook(`${meta()}c.jpnov\ntitle: x\n- c.jpnov`));
  assert.deepEqual(
    diags.map((d) => [(d.data as { code: string }).code, (d.data as { args: unknown[] }).args]),
    [['jpbook.notJpnov', ['title: x']], ['jpbook.fileNotFound', ['- c.jpnov']]],
  );
});

test('diagnoseJpbook skips the existence check off file:, and runs it on any file: directory', async () => {
  await using ws = await makeTmpWorkspace();
  assert.equal((await diagnoseAlone(OFF_FS, parseJpbook(`${meta()}missing.jpnov`))).length, 0);
  // A book under no workspace folder is still a `file:` book: its entries are stat'ed.
  assert.deepEqual(codesOf(await diagnoseAlone(`${ws.uri}/alone`, parseJpbook(`${meta()}missing.jpnov`))), ['jpbook.fileNotFound']);
});

test('completeJpbook offers matching .jpnov files and drillable subdirs; hides .jpbook', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'chapter1.jpnov', 'x');
  await writeUnder(ws.dir, 'chapter2.jpnov', 'x');
  await writeUnder(ws.dir, 'sub/inner.jpnov', 'x'); // makes sub a directory
  await writeUnder(ws.dir, 'index.jpbook', '');

  const ch = await completeLine(ws.uri, 'ch', 2);
  assert.deepEqual(ch.map((i) => i.label).sort(), ['chapter1.jpnov', 'chapter2.jpnov']);

  const all = await completeLine(ws.uri, '', 0);
  const sub = all.find((i) => i.label === 'sub');
  assert.ok(sub);
  assert.equal(sub.kind, CompletionItemKind.Folder);
  assert.equal(sub.textEdit?.newText, 'sub/');
  assert.ok(!all.some((i) => i.label === 'index.jpbook'), '.jpbook files are hidden');
});

test('completeJpbook routes metadata lines to key/value completion (fs-free)', async () => {
  // A half-typed key above the fence (an Error until its colon) gets the keys.
  const typing = `${metaWith('foot', {}, ['footer', 'footerAlign'])}a.jpnov`;
  const keys = await completeJpbook(OFF_FS, parseJpbook(typing), 'foot', { line: FENCE_LINE - 2, character: 4 });
  assert.deepEqual(keys.map((i) => i.label), ['footer', 'footerAlign']);
  const firstKey = keys[0];
  assert.ok(firstKey);
  assert.equal(firstKey.kind, CompletionItemKind.Property);
  assert.equal(firstKey.textEdit?.newText, 'footer: ');

  const valued = `${metaWith('headerAlign: c', {}, ['headerAlign'])}a.jpnov`;
  const vals = await completeJpbook(OFF_FS, parseJpbook(valued), 'headerAlign: c', { line: FENCE_LINE - 1, character: 14 });
  assert.deepEqual(vals.map((i) => i.label), ['center']);
  assert.equal(vals[0]?.kind, CompletionItemKind.EnumMember);
});

test('completeJpbook leaves out the keys already written', async () => {
  // A blank line among the keys: the keys no line took.
  const partial = `${HEAD}title: 作品名\n\nauthor:\n---\na.jpnov`;
  const some = await completeJpbook(OFF_FS, parseJpbook(partial), '', { line: 2, character: 0 });
  assert.deepEqual(some.map((i) => i.label), ['header', 'headerAlign', 'footer', 'footerAlign', 'divider', 'cover', 'characters', 'keywords']);

  // Every required key written: only the lists are left to offer…
  const full = `${metaWith('')}a.jpnov`;
  const rest = await completeJpbook(OFF_FS, parseJpbook(full), '', { line: FENCE_LINE, character: 0 });
  assert.deepEqual(rest.map((i) => i.label), ['cover', 'characters', 'keywords']);

  // …and once those are written too, nothing.
  const covered = `${metaWith('cover:\n- c.jpnov\ncharacters:\nkeywords:\n')}a.jpnov`;
  assert.deepEqual(await completeJpbook(OFF_FS, parseJpbook(covered), '', { line: FENCE_LINE + 4, character: 0 }), []);

  // The line being edited does not count as written (retyping `title` on its own line).
  const own = await completeJpbook(OFF_FS, parseJpbook(`${meta()}a.jpnov`), 'ti', { line: metaLineOf('title'), character: 2 });
  assert.deepEqual(own.map((i) => i.label), ['title']);
});

test('completeJpbook: keys above the fence, nothing on it, paths below; unclosed metadata is all keys', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'chapter1.jpnov', 'x');
  const at = (doc: string, lineText: string, line: number): ReturnType<typeof completeJpbook> =>
    completeJpbook(ws.uri, parseJpbook(doc), lineText, { line, character: lineText.length });

  assert.deepEqual((await at(`${metaWith('c')}chapter1.jpnov`, 'c', FENCE_LINE)).map((i) => i.label), ['cover', 'characters']);
  assert.deepEqual(await at(`${meta()}chapter1.jpnov`, '---', FENCE_LINE), []);
  assert.deepEqual((await at(`${meta()}c`, 'c', FENCE_LINE + 1)).map((i) => i.label), ['chapter1.jpnov']);
  assert.deepEqual((await at(`${HEAD}title: t\nc`, 'c', 2)).map((i) => i.label), ['cover', 'characters']);
  // The header line offers nothing, nor does a book whose header no parser reads.
  assert.deepEqual(await at(`${meta()}chapter1.jpnov`, HEADER, 0), []);
  assert.deepEqual(await at(`jpbook/2\n${metaBody()}---\nc`, 'c', FENCE_LINE + 1), []);
});

test('completeJpbook suppresses suggestions when the whole line already names a file', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'chapter1.jpnov', 'x');
  const items = await completeLine(ws.uri, 'chapter1.jpnov', 14);
  assert.equal(items.length, 0);
});

test('completeJpbook offers no chapter paths off the file: scheme', async () => {
  assert.equal((await completeLine(OFF_FS, 'ch', 2)).length, 0);
});

test('completeJpbook handles "./", "../", and digit-leading names', async () => {
  await using ws = await makeTmpWorkspace();

  await writeUnder(ws.dir, 'books/01-intro.jpnov', 'x');
  await writeUnder(ws.dir, 'books/chapter1.jpnov', 'x');
  await writeUnder(ws.dir, 'books/sub/inner.jpnov', 'x'); // makes sub a directory
  await writeUnder(ws.dir, 'chapters/ch2.jpnov', 'x');
  const bookDir = `${ws.uri}/books`;

  // "./" must list the book's directory, like the empty prefix.
  const dot = await completeLine(bookDir, './', 2);
  assert.deepEqual(dot.map((i) => i.label).sort(), ['01-intro.jpnov', 'chapter1.jpnov', 'sub']);

  // "./0" filters the book's directory by a digit-leading segment.
  const dotDigit = await completeLine(bookDir, './0', 3);
  assert.deepEqual(dotDigit.map((i) => i.label), ['01-intro.jpnov']);

  // A bare digit-leading prefix resolves correctly (auto-trigger is editor-side; content is right).
  const digit = await completeLine(bookDir, '0', 1);
  assert.deepEqual(digit.map((i) => i.label), ['01-intro.jpnov']);

  // "../" lists the parent, and drills on from there.
  const up = await completeLine(bookDir, '../', 3);
  assert.deepEqual(up.map((i) => i.label).sort(), ['books', 'chapters']);
  const upInto = await completeLine(bookDir, '../chapters/', 12);
  assert.deepEqual(upInto.map((i) => i.label), ['ch2.jpnov']);
  assert.deepEqual(upInto[0]?.textEdit, { range: { start: { line: FENCE_LINE + 2, character: 12 }, end: { line: FENCE_LINE + 2, character: 12 } }, newText: 'ch2.jpnov' });
});

test('diagnoseJpbook and completeJpbook take # and % in names literally (issue #76)', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, '第1巻#改稿.jpnov', 'x');
  await writeUnder(ws.dir, '50%.jpnov', 'x');
  await writeUnder(ws.dir, 'sub#1/b(1).jpnov', 'x');

  // Existing files pass; a missing one spelled with the same characters is flagged.
  assert.deepEqual(await diagnoseAlone(ws.uri, parseJpbook(`${meta()}第1巻#改稿.jpnov\n50%.jpnov\nsub#1/b(1).jpnov`)), []);
  const missing = await diagnoseAlone(ws.uri, parseJpbook(`${meta()}x#y.jpnov`));
  assert.deepEqual(codesOf(missing), ['jpbook.fileNotFound']);

  // Completion lists the on-disk names and drills into a directory with # in its name…
  assert.deepEqual((await completeLine(ws.uri, '第', 1)).map((i) => i.label), ['第1巻#改稿.jpnov']);
  assert.deepEqual((await completeLine(ws.uri, 'sub#1/', 6)).map((i) => i.label), ['b(1).jpnov']);
  // …and the "whole line already names a file" suppression sees the % file too.
  assert.deepEqual(await completeLine(ws.uri, '50%.jpnov', 9), []);
});

test("documentLinksForJpbook targets are percent-encoded like the client's Uri strings, resolved from the book directory", () => {
  const links = documentLinksForJpbook('file:///proj/books', parseJpbook(`${HEAD}---\nb#c.jpnov\n50%.jpnov\n../x.jpnov\nx/../b.jpnov`));
  assert.deepEqual(links.map((l) => l.target), [
    'file:///proj/books/b%23c.jpnov',
    'file:///proj/books/50%25.jpnov',
    'file:///proj/x.jpnov',
    'file:///proj/books/b.jpnov',
  ]);
});

test('documentLinksForJpbook links every valid chapter line (existence not required); meta lines never link', () => {
  // Pure URI resolution — no fs needed, so a literal root URI suffices.
  const parsed = parseJpbook(`${meta({ title: 'link.jpnov' })}src/vol1/chapter1.jpnov\nmissing.jpnov\n\nnote.md`);
  const links = documentLinksForJpbook('file:///proj', parsed);
  // The two syntactically-ok paths link; the meta value, blank, and note.md (non-.jpnov) do not.
  const targets = links.map((l) => l.target);
  assert.equal(links.length, 2);
  assert.ok(targets[0]?.endsWith('/proj/src/vol1/chapter1.jpnov'));
  assert.ok(targets[1]?.endsWith('/proj/missing.jpnov'));

  // Links need no fs: a book off `file:` links as well.
  assert.deepEqual(documentLinksForJpbook(OFF_FS, parsed).map((l) => l.target), [
    `${OFF_FS}/src/vol1/chapter1.jpnov`, `${OFF_FS}/missing.jpnov`,
  ]);
});

test('diagnoseJpbook flags a hand-edited divider Shift JIS cannot hold, on the character itself', async () => {
  // The Books panel refuses such a mark, and the prose lint never sees a `.jpbook`, so this is the
  // only thing standing between a hand edit and a 〓 at every chapter seam.
  const text = `${meta({ divider: '😀' })}a.jpnov`;
  const diags = await diagnoseAlone(OFF_FS, parseJpbook(text));
  assert.deepEqual(
    diags.map((d) => ({ code: (d.data as { code: string }).code, range: d.range, severity: d.severity })),
    [{
      code: 'jpbook.dividerNotEncodable',
      range: { start: { line: DIVIDER_LINE, character: 9 }, end: { line: DIVIDER_LINE, character: 11 } },
      severity: DiagnosticSeverity.Warning,
    }],
  );
  // The flagged span is exactly the offending character.
  assert.equal(text.split('\n')[DIVIDER_LINE]?.slice(9, 11), '😀');
});

test('diagnoseJpbook warns on a divider 字下げ above INDENT_MAX, over the annotation', async () => {
  const over = indentAnnotation(INDENT_MAX + 1);
  const line = `divider: ${over}＊`;
  const diags = await diagnoseAlone(OFF_FS, parseJpbook(`${meta({ divider: `${over}＊` })}a.jpnov`));
  const start = line.indexOf(over);
  assert.deepEqual(
    diags.map((d) => ({ data: d.data as unknown, range: d.range, severity: d.severity })),
    [{
      data: INDENT_TOO_LARGE,
      range: { start: { line: DIVIDER_LINE, character: start }, end: { line: DIVIDER_LINE, character: start + over.length } },
      severity: DiagnosticSeverity.Warning,
    }],
  );
  const atMax = `${meta({ divider: `${indentAnnotation(INDENT_MAX)}＊` })}a.jpnov`;
  assert.deepEqual(await diagnoseAlone(OFF_FS, parseJpbook(atMax)), []);
});

test('diagnoseJpbook leaves an encodable divider and the HTML-only metadata alone', async () => {
  // ◇ encodes; title/header ride the HTML build, which is UTF-8, so an emoji there is fine.
  const text = `${meta({ divider: '◇', title: '😀', header: '𠮷' })}a.jpnov`;
  assert.deepEqual(await diagnoseAlone(OFF_FS, parseJpbook(text)), []);
});

// --- cover lines -------------------------------------------------------------

test('diagnoseJpbook checks cover paths on the PATH span', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'src/c1.jpnov', 'x');
  await writeUnder(ws.dir, 'adir.jpnov/keep', 'x');
  const inlineOnly = metaWith([
    'cover:',
    '  - src/c1.jpnov', // fine
    '  - src/missing.jpnov', // Error: not found
    '  - adir.jpnov', // Error: directory
    '  - ../outside.jpnov', // Error: not found (resolved above the book)
    '  - src/c1.jpnov', // Warning: duplicate
  ].join('\n')) + 'src/c1.jpnov';

  const diags = await diagnoseAlone(ws.uri, parseJpbook(inlineOnly));
  assert.deepEqual(codesOf(diags), [
    'jpbook.fileNotFound',
    'jpbook.entryIsDirectory',
    'jpbook.fileNotFound',
    'jpbook.duplicateEntry',
  ]);
  // Each squiggle covers the PATH exactly: past the "  - " marker, out to the line end.
  assert.deepEqual(diags.map((d) => [d.range.start.character, d.range.end.character]), [
    [4, 21], // src/missing.jpnov
    [4, 14], // adir.jpnov
    [4, 20], // ../outside.jpnov
    [4, 16], // src/c1.jpnov
  ]);
  assert.deepEqual((diags[0]?.data as { args: unknown[] }).args, ['src/missing.jpnov']);

  // A value on the key line is the list's first item, checked on its own span.
  assert.deepEqual(await diagnoseAlone(ws.uri, parseJpbook(`${metaWith('cover: src/c1.jpnov')}src/c1.jpnov`)), []);
  const valued = await diagnoseAlone(ws.uri, parseJpbook(`${metaWith('cover: src/missing.jpnov')}src/c1.jpnov`));
  assert.deepEqual(valued.map((d) => [(d.data as { code: string }).code, (d.data as { args: unknown[] }).args, d.range.start.character, d.range.end.character]), [
    ['jpbook.fileNotFound', ['src/missing.jpnov'], 7, 24],
  ]);
});

test('diagnoseJpbook: the bare cover: key is clean, an orphan item is an Error', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'c.jpnov', 'x');
  const ok = await diagnoseAlone(ws.uri, parseJpbook(`${metaWith('cover:\n- c.jpnov')}c.jpnov`));
  assert.deepEqual(ok, []);

  const orphan = await diagnoseAlone(ws.uri, parseJpbook(`${metaWith('- c.jpnov')}c.jpnov`));
  assert.equal(orphan.length, 1);
  assert.equal((orphan[0]?.data as { code: string }).code, 'jpbook.itemWithoutKey');
  assert.equal(orphan[0]?.severity, DiagnosticSeverity.Error);
  // An orphan is a whole-line problem — it has no cover path to point at.
  assert.equal(orphan[0].range.start.character, 0);

  // A `---` right under the header closes an empty metadata block at once: the title and the
  // alignments are missing there, and the keys below read as (invalid) chapter paths.
  const fence = await diagnoseAlone(ws.uri, parseJpbook(`${HEAD}---\n${metaBody()}---\nc.jpnov`));
  assert.deepEqual(
    fence.slice(0, 4).map((d) => [(d.data as { code: string }).code, d.range.start.line]),
    [['jpbook.metaEmptyValue', 1], ['jpbook.metaEmptyValue', 1], ['jpbook.metaEmptyValue', 1], ['jpbook.notJpnov', 2]],
  );
});

test('documentLinksForJpbook links cover paths, spanning the path alone', () => {
  const parsed = parseJpbook(`${metaWith('cover:\n  - src/c1.jpnov\ncover2: x')}ch.jpnov`);
  const links = documentLinksForJpbook('file:///proj', parsed);
  assert.equal(links.length, 2);
  assert.ok(links[0]?.target?.endsWith('/proj/src/c1.jpnov'));
  assert.deepEqual(links[0]?.range, {
    start: { line: FENCE_LINE + 1, character: 4 },
    end: { line: FENCE_LINE + 1, character: 16 },
  });
  assert.ok(links[1]?.target?.endsWith('/proj/ch.jpnov'));
});

test('documentLinksForJpbook links the value of an inline cover key, spanning the path alone', () => {
  const links = documentLinksForJpbook('file:///proj', parseJpbook(metaWith('cover: src/c1.jpnov')));
  assert.deepEqual(links, [{
    range: { start: { line: FENCE_LINE, character: 7 }, end: { line: FENCE_LINE, character: 19 } },
    target: 'file:///proj/src/c1.jpnov',
  }]);
});

test('completeJpbook offers cover as a key and file paths after the item marker', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'src/c1.jpnov', 'x');
  const doc = (line: string): ReturnType<typeof parseJpbook> => parseJpbook(`${metaWith(line)}ch.jpnov`);
  const at = async (line: string, character: number): Promise<ReturnType<typeof completeJpbook>> =>
    completeJpbook(ws.uri, doc(line), line, { line: FENCE_LINE, character });

  const keys = await at('cov', 3);
  assert.deepEqual(keys.map((c) => c.label), ['cover']);

  // …and after the marker the path completion takes over, replacing only the path span.
  const item = await at('- src/', 6);
  assert.deepEqual(item.map((c) => c.label), ['c1.jpnov']);
  assert.deepEqual(item[0]?.textEdit, {
    range: { start: { line: FENCE_LINE, character: 6 }, end: { line: FENCE_LINE, character: 6 } },
    newText: 'c1.jpnov',
  });
  // The key's own value is a path too: it completes from the colon on.
  const inline = await at('cover: src/', 11);
  assert.deepEqual(inline.map((c) => c.label), ['c1.jpnov']);
  assert.deepEqual(inline[0]?.textEdit, { range: { start: { line: FENCE_LINE, character: 11 }, end: { line: FENCE_LINE, character: 11 } }, newText: 'c1.jpnov' });
  assert.ok((await at('cover:', 6)).some((c) => c.label === 'src'));
  assert.ok((await at('cover: ', 7)).some((c) => c.label === 'src'));
  // A folder still drills, from either marker.
  const dir = await at('－ s', 3);
  assert.deepEqual(dir.map((c) => c.label), ['src']);
  assert.equal(dir[0]?.kind, CompletionItemKind.Folder);
});

test('completeJpbook suppresses cover suggestions once the path names a file', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'src/c1.jpnov', 'x');
  const line = '- src/c1.jpnov';
  const parsed = parseJpbook(metaWith(`cover:\n${line}`));
  assert.deepEqual(await completeJpbook(ws.uri, parsed, line, { line: FENCE_LINE + 1, character: line.length }), []);
  const inline = 'cover: src/c1.jpnov';
  assert.deepEqual(await completeJpbook(ws.uri, parseJpbook(metaWith(inline)), inline, { line: FENCE_LINE, character: inline.length }), []);
});

// --- the name lists ------------------------------------------------------------------

/** Another book of the root, as the vocabulary store hands it over. */
const neighbour = (fileRel: string, text: string): ReturnType<typeof bookNames> => bookNames('file:///proj', fileRel, text);

test('diagnoseJpbook: name items warn when they are no name or repeat a base, each on the item itself', async () => {
  const text = `${metaWith('characters:\n- 山田　太郎\n- 山田《やまだ》太郎《たろう》\n  - 山田［＃太字］\n-\nkeywords:\n- 王都')}a.jpnov`;
  const diags = await diagnoseAlone(OFF_FS, parseJpbook(text));
  assert.deepEqual(diags.map((d) => [(d.data as { code: string; args: unknown[] }).code, d.severity, d.range.start.line, d.range.start.character]), [
    ['jpbook.duplicateEntry', DiagnosticSeverity.Warning, FENCE_LINE + 2, 2],
    ['jpbook.nameNotPlain', DiagnosticSeverity.Warning, FENCE_LINE + 3, 2],
    ['jpbook.nameEmpty', DiagnosticSeverity.Warning, FENCE_LINE + 4, 0],
  ]);
  assert.deepEqual((diags[0]?.data as { args: unknown[] }).args, ['山田《やまだ》太郎《たろう》']);
  // The repeat's range is the value past the marker: it ends where the line does.
  assert.equal(diags[0]?.range.end.character, 2 + '山田《やまだ》太郎《たろう》'.length);
});

test('diagnoseJpbook: a name another book of the root writes differently is a Warning naming that book', async () => {
  const mine = parseJpbook(`${metaWith('characters:\n- 山田　太郎\n- 山田　花子\nkeywords:\n- 王都')}a.jpnov`);
  const others = [
    neighbour('vol2/vol2.jpbook', `${metaWith('characters:\n- 山田《やまだ》太郎《たろう》\n- 山田　花子\nkeywords:\n- 王都《おうと》')}b.jpnov`),
    neighbour('vol3.jpbook', `${metaWith('characters:\n- 山田太郎')}c.jpnov`),
  ];
  const diags = await diagnoseJpbook(OFF_FS, mine, others);
  assert.deepEqual(diags.map((d) => [(d.data as { code: string; args: unknown[] }).args, d.range.start.line, d.severity]), [
    [['山田太郎', 'vol2/vol2.jpbook'], FENCE_LINE + 1, DiagnosticSeverity.Warning],
    [['山田太郎', 'vol3.jpbook'], FENCE_LINE + 1, DiagnosticSeverity.Warning],
    [['王都', 'vol2/vol2.jpbook'], FENCE_LINE + 4, DiagnosticSeverity.Warning],
  ]);
  assert.ok(diags.every((d) => (d.data as { code: string }).code === 'jpbook.nameConflict'));
  // The same writing in another book is no conflict; a book alone has none.
  const same = parseJpbook(`${metaWith('characters:\n- 山田　花子')}a.jpnov`);
  assert.deepEqual(await diagnoseJpbook(OFF_FS, same, others), []);
  assert.deepEqual(await diagnoseAlone(OFF_FS, mine), []);
});

test('name items get no document link and no completion, while a cover item next to them keeps both', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'src/c1.jpnov', 'x');
  const lines = 'characters:\n- 山田　太郎\ncover:\n- src/c1.jpnov\nkeywords:\n- ';
  const parsed = parseJpbook(`${metaWith(lines)}ch.jpnov`);
  assert.deepEqual(documentLinksForJpbook(ws.uri, parsed).map((l) => l.range.start.line), [FENCE_LINE + 3, FENCE_LINE + 7]);
  const at = async (line: number, lineText: string): Promise<string[]> =>
    (await completeJpbook(ws.uri, parsed, lineText, { line, character: lineText.length })).map((c) => c.label);
  assert.deepEqual(await at(FENCE_LINE + 1, '- 山'), []); // a character item
  assert.deepEqual(await at(FENCE_LINE + 5, '- '), []); // an (empty) keyword item
  assert.deepEqual(await at(FENCE_LINE, 'characters: '), []); // the key line's own value
  assert.deepEqual(await at(FENCE_LINE + 3, '- src/'), ['c1.jpnov']); // a cover item still completes paths
});
