/**
 * Integration tests for the impure `*.jpbook` editor features (diagnostics, completion,
 * document links) against real `file:` fixtures. Entries are root-relative, so every
 * function takes the owning workspace-folder root (null = no root: syntax-only).
 * Runs via `npm run test:integration` (not plain `npm test`): `src/server/jpbook.ts`
 * has `#/*` VALUE imports, which need the resolve hook in `test/resolve-hooks.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CompletionItemKind, DiagnosticSeverity } from 'vscode-languageserver/node';

import { parseJpbook } from '../../src/shared/book/jpbook.ts';
import {
  completeJpbook,
  diagnoseJpbook,
  documentLinksForJpbook,
} from '../../src/server/jpbook.ts';
import { makeTmpWorkspace, writeUnder } from './helpers.ts';

/** Single-line completion helper: the parse and the line are the same one-liner. */
function completeLine(rootUri: string | null, line: string, character: number): ReturnType<typeof completeJpbook> {
  return completeJpbook(rootUri, parseJpbook(line), line, { line: 0, character });
}

test('diagnoseJpbook flags missing / directory / backslash / non-.jpnov as Error and dupes as Warning', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'src/ok.jpnov', 'x');
  await writeUnder(ws.dir, 'adir.jpnov/keep', 'x'); // makes adir.jpnov a directory
  const text = ['src/ok.jpnov', 'missing.jpnov', 'adir.jpnov', 'sub\\bad.jpnov', 'note.md', 'src/ok.jpnov'].join('\n');

  const diags = await diagnoseJpbook(ws.uri, parseJpbook(text));
  // The localized text lives client-side; each diagnostic carries its {code,args} in `.data`.
  const codes = diags.map((d) => (d.data as { code: string }).code);

  assert.equal(diags.length, 5, 'src/ok.jpnov (first) produces no diagnostic');
  assert.equal(diags.filter((d) => d.severity === DiagnosticSeverity.Error).length, 4);
  assert.equal(diags.filter((d) => d.severity === DiagnosticSeverity.Warning).length, 1);
  assert.ok(codes.includes('jpbook.fileNotFound')); // missing.jpnov
  assert.ok(codes.includes('jpbook.entryIsDirectory')); // adir.jpnov
  assert.ok(codes.includes('jpbook.backslashSeparator')); // sub\bad.jpnov
  assert.ok(codes.includes('jpbook.notJpnov')); // note.md
  assert.ok(codes.includes('jpbook.duplicateEntry')); // 2nd src/ok.jpnov
  const notJp = diags.find((d) => (d.data as { code: string }).code === 'jpbook.notJpnov');
  assert.deepEqual((notJp?.data as { args: unknown[] }).args, ['note.md']);
});

test('diagnoseJpbook flags an entry escaping the workspace folder root', async () => {
  await using ws = await makeTmpWorkspace();
  const diags = await diagnoseJpbook(ws.uri, parseJpbook('../outside.jpnov'));
  assert.equal(diags.length, 1);
  assert.equal((diags[0]?.data as { code: string }).code, 'path.escapesRoot');
});

test('diagnoseJpbook surfaces front-matter warnings/errors with the metadata severities', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'ok.jpnov', 'x');
  const text = ['---', 'title: 一', 'publisher: x', 'title: 二', 'no colon here', '---', 'ok.jpnov'].join('\n');

  const diags = await diagnoseJpbook(ws.uri, parseJpbook(text));
  const byCode = new Map(diags.map((d) => [(d.data as { code: string }).code, d]));

  assert.equal(diags.length, 3, 'valid meta lines, fences, and the ok chapter stay silent');
  assert.equal(byCode.get('jpbook.metaUnknownKey')?.severity, DiagnosticSeverity.Warning);
  assert.equal(byCode.get('jpbook.metaDuplicateKey')?.severity, DiagnosticSeverity.Warning);
  assert.equal(byCode.get('jpbook.metaNotKeyValue')?.severity, DiagnosticSeverity.Error);
});

test('diagnoseJpbook flags an unterminated front matter even with NO owning root', async () => {
  const diags = await diagnoseJpbook(null, parseJpbook('---\ntitle: t'));
  assert.equal(diags.length, 1);
  const only = diags[0];
  assert.ok(only);
  assert.equal((only.data as { code: string }).code, 'jpbook.metaUnterminated');
  assert.equal(only.range.start.line, 0);
  assert.equal(only.severity, DiagnosticSeverity.Error);
});

test('diagnoseJpbook degrades to syntax-only without a root, and skips fs off file:', async () => {
  // No owning workspace folder: containment/existence unverifiable, so a valid-but-missing
  // path stays un-flagged…
  assert.equal((await diagnoseJpbook(null, parseJpbook('missing.jpnov'))).length, 0);
  // …and a virtual-scheme root verifies containment but never stats.
  assert.equal(
    (await diagnoseJpbook('vscode-vfs://host/root', parseJpbook('missing.jpnov'))).length,
    0,
  );
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

test('completeJpbook routes front-matter lines to key/value completion (root-free)', async () => {
  const parsed = parseJpbook('---\nfoot\n---\na.jpnov'); // meta completion needs no root at all

  const keys = await completeJpbook(null, parsed, 'foot', { line: 1, character: 4 });
  assert.deepEqual(keys.map((i) => i.label), ['footer', 'footerAlign']);
  const firstKey = keys[0];
  assert.ok(firstKey);
  assert.equal(firstKey.kind, CompletionItemKind.Property);
  assert.equal(firstKey.textEdit?.newText, 'footer: ');

  const vals = await completeJpbook(null, parsed, 'footerAlign: n', { line: 1, character: 14 });
  assert.deepEqual(vals.map((i) => i.label), ['none']);
  assert.equal(vals[0]?.kind, CompletionItemKind.EnumMember);

  // On the fences themselves: nothing.
  assert.equal((await completeJpbook(null, parsed, '---', { line: 0, character: 3 })).length, 0);
  assert.equal((await completeJpbook(null, parsed, '---', { line: 2, character: 3 })).length, 0);
});

test('completeJpbook keeps offering keys inside an UNTERMINATED front matter', async () => {
  const parsed = parseJpbook('---\nti');
  const items = await completeJpbook(null, parsed, 'ti', { line: 1, character: 2 });
  assert.deepEqual(items.map((i) => i.label), ['title']);
});

test('completeJpbook suppresses suggestions when the whole line already names a file', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'chapter1.jpnov', 'x');
  const items = await completeLine(ws.uri, 'chapter1.jpnov', 14);
  assert.equal(items.length, 0);
});

test('completeJpbook offers no chapter paths without a root or off the file: scheme', async () => {
  assert.equal((await completeLine(null, 'ch', 2)).length, 0);
  assert.equal((await completeLine('vscode-vfs://host/root', 'ch', 2)).length, 0);
});

test('completeJpbook handles "./", absolute "/", and digit-leading names', async () => {
  await using ws = await makeTmpWorkspace();

  await writeUnder(ws.dir, '01-intro.jpnov', 'x');
  await writeUnder(ws.dir, 'chapter1.jpnov', 'x');
  await writeUnder(ws.dir, 'sub/inner.jpnov', 'x'); // makes sub a directory

  // "./" must list the workspace folder root, like the empty prefix.
  const dot = await completeLine(ws.uri, './', 2);
  assert.deepEqual(dot.map((i) => i.label).sort(), ['01-intro.jpnov', 'chapter1.jpnov', 'sub']);

  // "./0" filters the root by a digit-leading segment.
  const dotDigit = await completeLine(ws.uri, './0', 3);
  assert.deepEqual(dotDigit.map((i) => i.label), ['01-intro.jpnov']);

  // A bare digit-leading prefix resolves correctly (auto-trigger is editor-side; content is right).
  const digit = await completeLine(ws.uri, '0', 1);
  assert.deepEqual(digit.map((i) => i.label), ['01-intro.jpnov']);

  // An absolute path is never a valid entry, so it must offer nothing — not the current dir.
  assert.equal((await completeLine(ws.uri, '/', 1)).length, 0);
  assert.equal((await completeLine(ws.uri, '/etc', 4)).length, 0);
});

test('documentLinksForJpbook links every valid chapter line (existence not required); meta lines never link', () => {
  // Pure URI resolution — no fs needed, so a literal root URI suffices.
  const parsed = parseJpbook('---\ntitle: link.jpnov\n---\nsrc/vol1/chapter1.jpnov\nmissing.jpnov\n\nnote.md');
  const links = documentLinksForJpbook('file:///proj', parsed);
  // The two syntactically-ok paths link; the meta value, blank, and note.md (non-.jpnov) do not.
  const targets = links.map((l) => l.target);
  assert.equal(links.length, 2);
  assert.ok(targets[0]?.endsWith('/proj/src/vol1/chapter1.jpnov'));
  assert.ok(targets[1]?.endsWith('/proj/missing.jpnov'));

  // Without an owning root there is no base to resolve against — no links at all.
  assert.deepEqual(documentLinksForJpbook(null, parsed), []);
});

test('diagnoseJpbook flags a hand-edited divider Shift JIS cannot hold, on the character itself', async () => {
  // The Books panel refuses such a mark, and the prose lint never sees a `.jpbook`, so this is the
  // only thing standing between a hand edit and a 〓 at every chapter seam.
  const text = '---\ndivider: 😀\n---\na.jpnov';
  const diags = await diagnoseJpbook(null, parseJpbook(text));
  assert.deepEqual(
    diags.map((d) => ({ code: (d.data as { code: string }).code, range: d.range, severity: d.severity })),
    [{
      code: 'jpbook.dividerNotEncodable',
      range: { start: { line: 1, character: 9 }, end: { line: 1, character: 11 } },
      severity: DiagnosticSeverity.Warning,
    }],
  );
  // The flagged span is exactly the offending character.
  assert.equal(text.split('\n')[1]?.slice(9, 11), '😀');
});

test('diagnoseJpbook leaves an encodable divider and the HTML-only metadata alone', async () => {
  // ◇ encodes; title/header ride the HTML build, which is UTF-8, so an emoji there is fine.
  const text = '---\ndivider: ◇\ntitle: 😀\nheader: 𠮷\n---\na.jpnov';
  assert.deepEqual(await diagnoseJpbook(null, parseJpbook(text)), []);
});

// --- cover lines -------------------------------------------------------------

test('diagnoseJpbook checks cover paths on the PATH span', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'src/c1.jpnov', 'x');
  await writeUnder(ws.dir, 'adir.jpnov/keep', 'x');
  const inlineOnly = [
    '---',
    'cover:',
    '  - src/c1.jpnov', // fine
    '  - src/missing.jpnov', // Error: not found
    '  - adir.jpnov', // Error: directory
    '  - ../outside.jpnov', // Error: escapes the root
    '  - src/c1.jpnov', // Warning: duplicate
    '---',
    'src/c1.jpnov',
  ].join('\n');

  const diags = await diagnoseJpbook(ws.uri, parseJpbook(inlineOnly));
  const codes = diags.map((d) => (d.data as { code: string }).code);
  assert.deepEqual(codes, [
    'jpbook.fileNotFound',
    'jpbook.entryIsDirectory',
    'path.escapesRoot',
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

  // A value on the key line never becomes a path: it is one error steering to the list form.
  const valued = await diagnoseJpbook(ws.uri, parseJpbook('---\ncover: src/c1.jpnov\n---\nsrc/c1.jpnov'));
  assert.equal(valued.length, 1);
  assert.equal((valued[0]?.data as { code: string }).code, 'jpbook.coverNeedsList');
  assert.equal(valued[0]?.severity, DiagnosticSeverity.Error);
});

test('diagnoseJpbook: the bare cover: key is clean, an orphan item is an Error', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'c.jpnov', 'x');
  const ok = await diagnoseJpbook(ws.uri, parseJpbook('---\ncover:\n- c.jpnov\n---\nc.jpnov'));
  assert.deepEqual(ok, []);

  const orphan = await diagnoseJpbook(ws.uri, parseJpbook('---\ntitle: t\n- c.jpnov\n---\nc.jpnov'));
  assert.equal(orphan.length, 1);
  assert.equal((orphan[0]?.data as { code: string }).code, 'jpbook.coverItemWithoutKey');
  assert.equal(orphan[0]?.severity, DiagnosticSeverity.Error);
  // An orphan is a whole-line problem — it has no cover path to point at.
  assert.equal(orphan[0].range.start.character, 0);
});

test('documentLinksForJpbook links cover paths, spanning the path alone', () => {
  const parsed = parseJpbook('---\ncover:\n  - src/c1.jpnov\ncover2: x\n---\nch.jpnov');
  const links = documentLinksForJpbook('file:///proj', parsed);
  assert.equal(links.length, 2);
  assert.ok(links[0]?.target?.endsWith('/proj/src/c1.jpnov'));
  assert.deepEqual(links[0]?.range, {
    start: { line: 2, character: 4 },
    end: { line: 2, character: 16 },
  });
  assert.ok(links[1]?.target?.endsWith('/proj/ch.jpnov'));
});

test('documentLinksForJpbook leaves a valued cover key alone (it names no path)', () => {
  assert.deepEqual(documentLinksForJpbook('file:///proj', parseJpbook('---\ncover: src/c1.jpnov\n---\n')), []);
});

test('completeJpbook offers cover as a key and file paths after the item marker', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'src/c1.jpnov', 'x');
  const doc = (line: string): ReturnType<typeof parseJpbook> =>
    parseJpbook(['---', line, '---', 'ch.jpnov'].join('\n'));
  const at = async (line: string, character: number): Promise<ReturnType<typeof completeJpbook>> =>
    completeJpbook(ws.uri, doc(line), line, { line: 1, character });

  const keys = await at('cov', 3);
  assert.deepEqual(keys.map((c) => c.label), ['cover']);

  // …and after the marker the path completion takes over, replacing only the path span.
  const item = await at('- src/', 6);
  assert.deepEqual(item.map((c) => c.label), ['c1.jpnov']);
  assert.deepEqual(item[0]?.textEdit, {
    range: { start: { line: 1, character: 6 }, end: { line: 1, character: 6 } },
    newText: 'c1.jpnov',
  });
  // A valued key line offers nothing — it is an error, not a path.
  assert.deepEqual(await at('cover: src/', 11), []);
  // A folder still drills, from either marker.
  const dir = await at('－ s', 3);
  assert.deepEqual(dir.map((c) => c.label), ['src']);
  assert.equal(dir[0]?.kind, CompletionItemKind.Folder);
});

test('completeJpbook suppresses cover suggestions once the path names a file', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'src/c1.jpnov', 'x');
  const line = '- src/c1.jpnov';
  const parsed = parseJpbook(['---', 'cover:', line, '---'].join('\n'));
  assert.deepEqual(await completeJpbook(ws.uri, parsed, line, { line: 2, character: line.length }), []);
});
