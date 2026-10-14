/**
 * Integration tests for the `jpnov/build` + `jpnov/listBooks` handlers against real `file:`
 * fixtures. Runs via `npm run test:integration` with the other fs-fixture suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CancellationToken, CancellationTokenSource } from 'vscode-languageserver/node';

import { handleBuild, handleListBooks } from '../../src/server/build.ts';
import {
  makeContext,
  makeFakeConnection,
  makeTmpWorkspace,
  nodeReader,
  writeUnder,
  type FakeConnection,
} from './helpers.ts';
import type { ReadText, ServerContext } from '../../src/server/context.ts';
import { BUILD_CHROME_DEFAULT, BUILD_PAPER_DEFAULT } from '../../src/shared/config/settings.ts';
import { INDENT_MAX, indentAnnotation } from '../../src/shared/ast/notation.ts';
import { HEADER, JPBOOK_VERSION, META_KEYS } from '../../src/shared/book/jpbook.ts';
import { FURNITURE_ALIGNS } from '../../src/shared/compiler/chrome.ts';
import { CHARS_MIN, LAYOUT_DEFAULT, PROJECT_DEFAULT } from '../../src/shared/config/types.ts';
import { outDirSubpath } from '../../src/shared/config/validate.ts';
import { MANUSCRIPT_SHEET } from '../../src/shared/compiler/document.ts';
import { encodeTxt } from '../../src/shared/encoding.ts';
import type {
  BuildFormat,
  BuildResult,
  HtmlSettings,
  ListBooksResult,
  MsgCode,
  ProjectDirs,
  ProjectDirsMap,
  ReadTextFailure,
} from '../../src/shared/protocol.ts';
import { FENCE_LINE, HEAD, meta, metaBody, metaWith } from '../shared/book/_fixture.ts';

/** The product-default settings snapshot every build request carries (settings is required). */
const SETTINGS: HtmlSettings = {
  ...LAYOUT_DEFAULT,
  lineNumbers: BUILD_CHROME_DEFAULT.lineNumbers,
  edgeLine: BUILD_CHROME_DEFAULT.edgeLine,
  ...BUILD_PAPER_DEFAULT,
};

/** The per-root `jpnov.layout.outDir` map a request carries; defaults unless overridden. */
function projectsFor(uri: string, dirs: Partial<ProjectDirs> = {}): ProjectDirsMap {
  return { [uri]: { outDir: dirs.outDir ?? 'dist' } };
}

/** A fresh server context + recording connection (builds read only the request's projectDirs). */
function boot(): { ctx: ServerContext; conn: FakeConnection } {
  const conn = makeFakeConnection();
  return { ctx: makeContext(conn), conn };
}

test('build emits the requested artifact kind per jpbook containing both files', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  // vol1/vol1.jpbook -> vol1/dist/vol1.{txt,html}; entries are relative to the book's directory.
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta() + 'a.jpnov\nb.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'あいう');
  await writeUnder(ws.dir, 'vol1/b.jpnov', 'かきく');

  const htmlResult: BuildResult = await handleBuild(ctx, {
    format: 'html',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(htmlResult.ok, true);
  assert.equal(htmlResult.errors.length, 0);
  assert.equal(htmlResult.artifacts.length, 1);

  const html = htmlResult.artifacts[0];
  assert.ok(html?.kind === 'html');
  assert.equal(html.path, `${ws.uri}/vol1/dist/vol1.html`);
  assert.match(html.content, /<!DOCTYPE html>/i);
  assert.ok(html.content.includes('あいう'), 'first file content present');
  assert.ok(html.content.includes('かきく'), 'second file content present');

  const txtResult: BuildResult = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });
  const txt = txtResult.artifacts[0];
  assert.ok(txt?.kind === 'txt');
  assert.equal(txt.path, `${ws.uri}/vol1/dist/vol1.txt`);
  // The .txt is the concatenated source: one blank glue line between chapters, no trailing newline.
  assert.equal(txt.content, 'あいう\n\nかきく');
});

test('a pre-cancelled token skips the work and returns an empty result', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'あいう');

  const result: BuildResult = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  }, undefined, CancellationToken.Cancelled);

  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.outDirs, []);
  assert.equal(result.errors.length, 0);
});

test('a metadata divider lands between heading-less chapters in BOTH artifacts', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta({ divider: '＊' }) + 'a.jpnov\nb.jpnov\nc.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'あいう');
  await writeUnder(ws.dir, 'vol1/b.jpnov', 'かきく');
  await writeUnder(ws.dir, 'vol1/c.jpnov', '終章［＃「終章」は大見出し］\nすえ');

  const txtResult: BuildResult = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });
  assert.equal(txtResult.ok, true);

  // a→b: no heading → blank + centred ＊ (cpl 40 → ［＃１９字下げ］) + one more blank.
  // b→c: c opens with a 見出し → the heading is the separator, blank line only.
  const txt = txtResult.artifacts[0];
  assert.ok(txt?.kind === 'txt');
  assert.equal(
    txt.content,
    'あいう\n\n［＃１９字下げ］＊\n\nかきく\n\n終章［＃「終章」は大見出し］\nすえ',
  );

  const htmlResult = await handleBuild(ctx, {
    format: 'html',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });
  const html = htmlResult.artifacts[0];
  assert.ok(html?.kind === 'html');
  assert.ok(html.content.includes('<div class="line indent-19">＊</div>'), 'centred divider row');
  assert.match(html.content, /\.indent-19\{padding-inline-start:19em\}/);
  assert.match(html.content, /<div class="line midashi" data-line="0">終章<\/div>/);
  assert.match(html.content, /\.midashi\{font-family:sans-serif;font-weight:bold\}/);
});

test('a span left open at a chapter end is closed at the .txt seam, matching the HTML reset', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta() + 'a.jpnov\nb.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', '［＃太字］あ');
  await writeUnder(ws.dir, 'vol1/b.jpnov', 'い');

  const txtResult: BuildResult = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });
  const txt = txtResult.artifacts[0];
  assert.ok(txt?.kind === 'txt');
  assert.equal(txt.content, '［＃太字］あ\n［＃ここで太字終わり］\n\nい');

  // buildRows runs per chapter in the HTML build, so chapter 2 is plain there; the .txt agrees.
  const htmlResult = await handleBuild(ctx, {
    format: 'html',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });
  const html = htmlResult.artifacts[0];
  assert.ok(html?.kind === 'html');
  assert.ok(html.content.includes('<span class="b">あ</span>'), 'chapter 1 is bold');
  assert.ok(html.content.includes('<div class="line" data-line="0">い</div>'), 'chapter 2 opens plain');
});

test('build stays lenient on an unclosed ［＃: ok, artifacts emitted, tail visible as literal text', async () => {
  // Preview/build cohesion: a syntax error is an EDITOR diagnostic, never a build gate. The
  // swallowed tail must appear verbatim in the HTML (same shared buildRows arm the preview uses).
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', '本文［＃閉じない注記\n次の行');

  const result: BuildResult = await handleBuild(ctx, {
    format: 'html',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifacts);
  assert.ok(result.errors);
  assert.equal(result.errors.length, 0);
  assert.equal(result.artifacts.length, 1);
  const html = result.artifacts[0];
  assert.ok(html?.kind === 'html');
  assert.ok(html.content.includes('本文［＃閉じない注記'), 'swallowed tail visible in HTML');
  assert.ok(html.content.includes('次の行'), 'the next line is untouched');
  const txtResult = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });
  const txt = txtResult.artifacts[0];
  assert.ok(txt?.kind === 'txt');
  assert.equal(txt.content, '本文［＃閉じない注記\n次の行'); // .txt is byte-faithful anyway
});

test('the output lands beside the book, whatever its depth, named after the book file', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'part1/vol2/index.jpbook', meta() + 'c.jpnov');
  await writeUnder(ws.dir, 'part1/vol2/c.jpnov', 'テスト');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.outDirs, [`${ws.uri}/part1/vol2/dist`]);
  const txt = result.artifacts[0];
  assert.ok(txt?.kind === 'txt');
  assert.equal(txt.path, `${ws.uri}/part1/vol2/dist/index.txt`);
  assert.equal(txt.content, 'テスト');
});

test("entries resolve against the book's directory, `..` included", async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  // The book lives in books/, one chapter beside it, one in chapters/ above it.
  await writeUnder(ws.dir, 'books/volume01.jpbook', meta() + '../chapters/ch1.jpnov\n./ch2.jpnov');
  await writeUnder(ws.dir, 'chapters/ch1.jpnov', 'ほん');
  await writeUnder(ws.dir, 'books/ch2.jpnov', 'に');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.deepEqual(result.errors, []);
  const txt = result.artifacts[0];
  assert.ok(txt?.kind === 'txt');
  assert.equal(txt.path, `${ws.uri}/books/dist/volume01.txt`);
  assert.equal(txt.content, 'ほん\n\nに');
  assert.deepEqual(conn.diagnostics, [{ uri: `${ws.uri}/books/volume01.jpbook`, count: 0 }]);
});

test('an entry may leave the workspace folder', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'proj/vol1.jpbook', meta() + '../shared/ch.jpnov');
  await writeUnder(ws.dir, 'shared/ch.jpnov', 'そと');
  const root = `${ws.uri}/proj`;

  const result = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(root) });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.artifacts.map((a) => [a.path, a.kind === 'txt' ? a.content : a.kind]), [[`${root}/dist/vol1.txt`, 'そと']]);
  assert.deepEqual(conn.diagnostics, [{ uri: `${root}/vol1.jpbook`, count: 0 }]);
});

test('two spellings of one file are one entry: built once, the repeat a Warning', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', meta() + 'a.jpnov\nx/../a.jpnov');
  await writeUnder(ws.dir, 'a.jpnov', 'あ');

  const result = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri) });

  assert.deepEqual(result.errors, []);
  const txt = result.artifacts[0];
  assert.ok(txt?.kind === 'txt');
  assert.equal(txt.content, 'あ');
  assert.deepEqual(conn.diagnostics, [{ uri: `${ws.uri}/vol1.jpbook`, count: 1 }]);
});

test('outDir may climb: `../dist` gathers the books of several folders one level up', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'books/a/a.jpbook', meta() + 'x.jpnov');
  await writeUnder(ws.dir, 'books/a/x.jpnov', 'A');
  await writeUnder(ws.dir, 'books/b/b.jpbook', meta() + 'y.jpnov');
  await writeUnder(ws.dir, 'books/b/y.jpnov', 'B');

  const result = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri, { outDir: '../dist' }) });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.outDirs, [`${ws.uri}/books/dist`]);
  assert.deepEqual(result.artifacts.map((a) => a.path), [`${ws.uri}/books/dist/a.txt`, `${ws.uri}/books/dist/b.txt`]);
});

test('projectDirs overrides outDir per root', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'ほんぶん');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri, { outDir: 'out' }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.outDirs, [`${ws.uri}/vol1/out`]);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.path, `${ws.uri}/vol1/out/vol1.txt`);
});

test('outDir ${workspaceFolder}/… counts from the book\'s root whatever its depth; a book under no root counts from itself', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'proj/vol1.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'proj/a.jpnov', 'A');
  await writeUnder(ws.dir, 'proj/books/deep/vol2.jpbook', meta() + 'b.jpnov');
  await writeUnder(ws.dir, 'proj/books/deep/b.jpnov', 'B');
  await writeUnder(ws.dir, 'alone/hon.jpbook', meta() + 'c.jpnov');
  await writeUnder(ws.dir, 'alone/c.jpnov', 'C');
  const root = `${ws.uri}/proj`;
  const alone = `${ws.uri}/alone/hon.jpbook`;
  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(root, { outDir: '${workspaceFolder}/out' }),
    openBooks: [{ uri: alone, outDir: '${workspaceFolder}/out' }],
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.artifacts.map((a) => a.path), [`${root}/out/vol2.txt`, `${root}/out/vol1.txt`, `${ws.uri}/alone/out/hon.txt`]);
  assert.deepEqual(result.outDirs, [`${root}/out`, `${ws.uri}/alone/out`]);
});

test('outDir `.` lands the output beside the book, `${workspaceFolder}` alone in its root', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'books/vol1.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'books/a.jpnov', 'A');
  await writeUnder(ws.dir, 'dist/vol2.jpbook', meta() + 'b.jpnov');
  await writeUnder(ws.dir, 'dist/b.jpnov', 'B');

  const beside = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri, { outDir: '.' }) });
  assert.deepEqual(beside.errors, []);
  assert.deepEqual(beside.artifacts.map((a) => a.path), [`${ws.uri}/books/vol1.txt`, `${ws.uri}/dist/vol2.txt`]);
  assert.deepEqual(beside.outDirs, [`${ws.uri}/books`, `${ws.uri}/dist`]);

  const root = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri, { outDir: '${workspaceFolder}' }) });
  assert.deepEqual(root.errors, []);
  assert.deepEqual(root.artifacts.map((a) => a.path), [`${ws.uri}/vol1.txt`, `${ws.uri}/vol2.txt`]);
  assert.deepEqual(root.outDirs, [ws.uri]);
});

test('outDirs carries each output dir ONCE across the books that landed in it', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'a.jpbook', meta() + 'x.jpnov');
  await writeUnder(ws.dir, 'x.jpnov', 'A');
  await writeUnder(ws.dir, 'b.jpbook', meta() + 'y.jpnov');
  await writeUnder(ws.dir, 'y.jpnov', 'B');
  await writeUnder(ws.dir, 'c/c.jpbook', meta() + 'z.jpnov');
  await writeUnder(ws.dir, 'c/z.jpnov', 'C');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.equal(result.artifacts.length, 3);
  assert.deepEqual(result.outDirs, [`${ws.uri}/dist`, `${ws.uri}/c/dist`]);
});

test('an invalid outDir silently falls back to the default: the root\'s dist, whatever the book\'s depth', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'あ');

  for (const outDir of ['/abs', '', '~/out']) {
    const result = await handleBuild(ctx, {
      format: 'txt',
      settings: SETTINGS,
      projectDirs: projectsFor(ws.uri, { outDir }),
    });

    assert.equal(result.ok, true, outDir);
    assert.deepEqual(result.artifacts.map((a) => a.path), [`${ws.uri}/dist/vol1.txt`], outDir);
  }
  assert.deepEqual(outDirSubpath(PROJECT_DEFAULT.outDir), { fromRoot: true, rel: 'dist' });
});

test('two book files resolving to one output file error BOTH, with a diagnostic, and emit neither', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'a/index.jpbook', meta() + 'x.jpnov');
  await writeUnder(ws.dir, 'a/x.jpnov', 'A');
  await writeUnder(ws.dir, 'b/index.jpbook', meta() + 'y.jpnov');
  await writeUnder(ws.dir, 'b/y.jpnov', 'B');
  await writeUnder(ws.dir, 'c/other.jpbook', meta() + 'z.jpnov');
  await writeUnder(ws.dir, 'c/z.jpnov', 'C');
  const first = `${ws.uri}/a/index.jpbook`;
  const second = `${ws.uri}/b/index.jpbook`;

  const result = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri, { outDir: '${workspaceFolder}/dist' }) });

  assert.equal(result.ok, false);
  const collision = ['build.outPathCollision', [`${ws.uri}/dist/index`, 'a/index.jpbook, b/index.jpbook']];
  assert.deepEqual(result.errors.map((e) => [e.uri, e.code, e.args]), [[first, ...collision], [second, ...collision]]);
  assert.deepEqual(result.artifacts.map((a) => a.path), [`${ws.uri}/dist/other.txt`]);
  for (const uri of [first, second]) {
    assert.ok(conn.published.some((p) => p.uri === uri && p.diagnostics.some((d) => d.code === 'build.outPathCollision')), uri);
  }

  // A selected book still errors when it collides with an UNSELECTED one.
  const selected = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri, { outDir: '${workspaceFolder}/dist' }), books: [first] });
  assert.deepEqual(selected.errors.map((e) => e.code), ['build.outPathCollision']);
  assert.deepEqual(selected.artifacts, []);

  // An open book under no root counts too: here it aims its output at c/dist from outside.
  await using other = await makeTmpWorkspace();
  await writeUnder(other.dir, 'other.jpbook', meta() + 'w.jpnov');
  const withOpen = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri, { outDir: 'dist' }),
    openBooks: [{ uri: `${other.uri}/other.jpbook`, outDir: `../${basename(ws.dir)}/c/dist` }],
  });
  assert.deepEqual(withOpen.errors.map((e) => [e.book, e.code]), [['c/other.jpbook', 'build.outPathCollision'], ['other.jpbook', 'build.outPathCollision']]);
});

test('a missing referenced .jpnov is a per-book error + diagnostic; other books still build', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'bad/bad.jpbook', meta() + 'present.jpnov\ngone.jpnov');
  await writeUnder(ws.dir, 'bad/present.jpnov', 'ある');
  await writeUnder(ws.dir, 'good/good.jpbook', meta() + 'y.jpnov');
  await writeUnder(ws.dir, 'good/y.jpnov', 'よい');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  const err = result.errors[0];
  assert.ok(err);
  const badUri = `${ws.uri}/bad/bad.jpbook`;
  assert.equal(err.book, 'bad/bad.jpbook');
  assert.equal(err.uri, badUri); // the Books panel opens the failing book by this key
  assert.equal(err.code, 'book.entryFileNotFound');
  assert.ok(String(err.args?.[0]).includes('gone.jpnov'));
  // The good book still produced its artifact.
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.path, `${ws.uri}/good/dist/good.txt`);
  // A diagnostic was published on the offending .jpbook (line-level).
  assert.ok(conn.diagnostics.some((d) => d.uri === badUri && d.count > 0));
});

test('two book files of one name in different folders build both, each into its own output dir', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'volume01/index.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'volume01/a.jpnov', 'A');
  await writeUnder(ws.dir, 'index.jpbook', meta() + 'volume01/a.jpnov');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.artifacts.map((a) => a.path), [`${ws.uri}/dist/index.txt`, `${ws.uri}/volume01/dist/index.txt`]);
  assert.deepEqual(conn.diagnostics.map((d) => d.count), [0, 0]);
});

test('build honors the kinsoku mode from the settings snapshot (禁則)', async () => {
  await using ws = await makeTmpWorkspace();
  // 禁則 rides the request's settings snapshot (same source as the preview). At width 16 a
  // naive wrap ends column 1 on the opening 「 (cell 16); 追い出し pushes it down →
  // 15×あ | 「い」. Proves settings.kinsoku reaches renderBook alongside charsPerLine.
  // (The footer is suppressed through the book's OWN metadata, not settings.)
  const { ctx } = boot();
  const head = 'あ'.repeat(15);
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta({ footer: '' }) + 'a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', `${head}「い」`);

  const result = await handleBuild(ctx, {
    format: 'html',
    settings: { ...SETTINGS, charsPerLine: 16, kinsoku: 'relaxed' },
    projectDirs: projectsFor(ws.uri),
  });
  const html = result.artifacts.find((a) => a.kind === 'html')?.content ?? '';
  assert.ok(
    html.includes(
      `<div class="line" data-line="0">${head}</div>` +
          `<div class="line" data-line="0" data-ch="${String(head.length)}">「い」</div>`,
    ),
    '追い出し keeps the opening bracket with its content',
  );
});

test('build with an empty projectDirs map returns ok with no artifacts', async () => {
  const { ctx } = boot();
  const result = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: {} });
  assert.deepEqual(result, { ok: true, outDirs: [], artifacts: [], errors: [] });
  assert.deepEqual(await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: {}, openBooks: [] }), result);
});

test('build targets only the roots in projectDirs', async () => {
  await using wsA = await makeTmpWorkspace();
  await using wsB = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(wsA.dir, 'va/va.jpbook', meta() + 'x.jpnov');
  await writeUnder(wsA.dir, 'va/x.jpnov', 'A');
  await writeUnder(wsB.dir, 'vb/vb.jpbook', meta() + 'y.jpnov');
  await writeUnder(wsB.dir, 'vb/y.jpnov', 'B');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(wsA.uri),
  });

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.path, `${wsA.uri}/va/dist/va.txt`);
});

test('listBooks gives the server the books\' names, root by root, as the union of every book under the root', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', metaWith('characters:\n  - 山田　太郎\nkeywords:\n  - 王都') + 'a.jpnov');
  await writeUnder(ws.dir, 'vol2/vol2.jpbook', metaWith('characters:\n  - 山田《やまだ》花子《はなこ》') + 'b.jpnov');
  await writeUnder(ws.dir, 'sub/root/inner.jpbook', metaWith('characters:\n  - John Smith') + 'c.jpnov');
  const { ctx } = boot();
  const outer = ws.uri;
  const inner = `${ws.uri}/sub/root`;
  await handleListBooks(ctx, { projectDirs: { ...projectsFor(outer), ...projectsFor(inner) } });

  const subject = (doc: string, who: string): boolean =>
    ctx.highlight.recognizerFor(doc)?.recognize(`${who}は`).some((s) => s.kind === 'character') ?? false;
  // A chapter anywhere under the outer root, in a book or not, sees both volumes' casts…
  for (const who of ['太郎', '山田', '花子', '山田花子']) {
    assert.ok(subject(`${outer}/drafts/new.jpnov`, who), who);
  }
  assert.ok(ctx.highlight.recognizerFor(`${outer}/vol1/a.jpnov`)?.recognize('王都へ').some((s) => s.kind === 'keyword'));
  // …and the nested root keeps its own book to itself, in both directions.
  assert.ok(subject(`${inner}/c.jpnov`, 'John Smith'));
  assert.ok(!subject(`${inner}/c.jpnov`, '太郎'));
  assert.ok(!subject(`${outer}/drafts/new.jpnov`, 'John Smith'));
  // The neighbours of a book: the other books of its root, labelled as the panel lists them.
  assert.deepEqual(ctx.highlight.othersOf(`${outer}/vol1/vol1.jpbook`).map((b) => b.fileRel), ['vol2/vol2.jpbook']);
  assert.deepEqual(ctx.highlight.othersOf(`${inner}/inner.jpbook`), []);

  // The next listing replaces the snapshot: a root gone from the request takes its names with it.
  await handleListBooks(ctx, { projectDirs: projectsFor(inner) });
  assert.equal(ctx.highlight.recognizerFor(`${outer}/drafts/new.jpnov`), undefined);
  assert.ok(subject(`${inner}/c.jpnov`, 'John Smith'));
});

test('listBooks enumerates every jpbook, carrying its title when one is written', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta({}, ['title']) + 'a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'あ');
  await writeUnder(ws.dir, 'part1/vol2/vol2.jpbook', meta({ title: '作品名　二' }) + 'c.jpnov');
  await writeUnder(ws.dir, 'part1/vol2/c.jpnov', 'て');
  await writeUnder(ws.dir, 'vol3.jpbook', meta({ title: '' }) + 'vol1/a.jpnov');

  // Enumeration reads each file (through the context's reader) only for its title; it
  // publishes no diagnostics by construction.
  const result: ListBooksResult = await handleListBooks(boot().ctx, { projectDirs: projectsFor(ws.uri) });

  assert.equal(result.books.length, 3);
  const byFile = new Map(result.books.map((b) => [b.fileRel, b]));
  const vol1 = byFile.get('vol1/vol1.jpbook');
  const vol2 = byFile.get('part1/vol2/vol2.jpbook');
  assert.ok(vol1);
  assert.ok(vol2);
  assert.equal(vol1.uri, `${ws.uri}/vol1/vol1.jpbook`);
  assert.equal(vol1.rootUri, ws.uri);
  assert.equal(vol1.title, undefined, 'no title key -> no title (the build reports it)');
  assert.equal(byFile.get('vol3.jpbook')?.title, undefined, 'an empty title -> no title');
  assert.equal(vol2.title, '作品名　二');
});

test('build format "html" emits only the .html artifact', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'あ');

  const result = await handleBuild(ctx, {
    format: 'html',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifacts);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.path, `${ws.uri}/vol1/dist/vol1.html`);
});

test('build format "txt" emits only the .txt artifact', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'あ');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifacts);
  assert.equal(result.artifacts.length, 1);
  const only = result.artifacts[0];
  assert.ok(only?.kind === 'txt');
  assert.equal(only.path, `${ws.uri}/vol1/dist/vol1.txt`);
  assert.equal(only.content, 'あ');
});

test('build restricts to the selected books (by jpbook uri)', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'a/a.jpbook', meta() + 'x.jpnov');
  await writeUnder(ws.dir, 'a/x.jpnov', 'A');
  await writeUnder(ws.dir, 'b/b.jpbook', meta() + 'y.jpnov');
  await writeUnder(ws.dir, 'b/y.jpnov', 'B');

  const onlyA = `${ws.uri}/a/a.jpbook`;
  const result = await handleBuild(ctx, {
    books: [onlyA],
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.artifacts.length, 1); // a.txt, and nothing from book b
  assert.equal(result.artifacts[0]?.path, `${ws.uri}/a/dist/a.txt`);
});

test('build with an empty books selection builds nothing (distinct from omitting it)', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'a/a.jpbook', meta() + 'x.jpnov');
  await writeUnder(ws.dir, 'a/x.jpnov', 'A');

  const result = await handleBuild(ctx, {
    books: [],
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.outDirs, []);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.errors, []);
});

test('a txt-only build still reports a missing .jpnov as a per-book error + diagnostic', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'bad/bad.jpbook', meta() + 'present.jpnov\ngone.jpnov');
  await writeUnder(ws.dir, 'bad/present.jpnov', 'ある');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors);
  assert.equal(result.errors.length, 1);
  const err = result.errors[0];
  assert.ok(err);
  assert.equal(err.code, 'book.entryFileNotFound');
  assert.ok(String(err.args?.[0]).includes('gone.jpnov'));
  // Format gating only skips artifact emission — diagnosis still runs.
  const badUri = `${ws.uri}/bad/bad.jpbook`;
  assert.ok(conn.diagnostics.some((d) => d.uri === badUri && d.count > 0));
});

test('a root-level jpbook is discovered (discovery is anchored at the folder root)', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'volume1.jpbook', meta() + 'ch1.jpnov');
  await writeUnder(ws.dir, 'ch1.jpnov', 'ねこ');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifacts);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.path, `${ws.uri}/dist/volume1.txt`);
});

test('a src/ layout builds into src/dist, beside the book', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'src/volume1.jpbook', meta() + 'ch1.jpnov');
  await writeUnder(ws.dir, 'src/ch1.jpnov', 'いぬ');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.artifacts.map((a) => a.path), [`${ws.uri}/src/dist/volume1.txt`]);
});

test('discovery skips dot-folders and node_modules only: a book inside an output folder is a book', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'あ');
  await writeUnder(ws.dir, '.hidden/x.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'node_modules/pkg/y.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'deep/node_modules/z.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'dist/w.jpbook', meta() + 'a.jpnov');

  const result: ListBooksResult = await handleListBooks(boot().ctx, { projectDirs: projectsFor(ws.uri, { outDir: 'dist' }) });

  assert.deepEqual(result.books.map((b) => b.fileRel), ['dist/w.jpbook', 'vol1/vol1.jpbook']);
});

test('a non-ASCII outDir (出力) receives the artifact under its encoded name', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'あ');

  const result = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri, { outDir: '出力' }) });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.artifacts.map((a) => a.path), [`${ws.uri}/vol1/${encodeURIComponent('出力')}/vol1.txt`]);
});

/** The nested-root fixture: `extra/` is a targeted root inside the targeted root `dir`. */
async function writeNestedRoots(dir: string): Promise<void> {
  // The outer book lists a chapter of its own and one inside the nested root.
  await writeUnder(dir, 'vol1.jpbook', meta() + 'ch1.jpnov\nextra/ch.jpnov');
  await writeUnder(dir, 'ch1.jpnov', 'そと');
  await writeUnder(dir, 'extra/side.jpbook', meta() + 'ch.jpnov');
  await writeUnder(dir, 'extra/deep/index.jpbook', meta() + '../ch.jpnov');
  await writeUnder(dir, 'extra/ch.jpnov', 'うち');
}

test('nested roots: a book belongs to the innermost root and is listed once, in either order of the roots', async () => {
  await using ws = await makeTmpWorkspace();
  await writeNestedRoots(ws.dir);
  const inner = `${ws.uri}/extra`;

  for (const roots of [[ws.uri, inner], [inner, ws.uri]]) {
    const projectDirs: ProjectDirsMap = Object.fromEntries(roots.map((uri) => [uri, { outDir: 'dist' }]));
    const { books } = await handleListBooks(boot().ctx, { projectDirs });

    assert.equal(books.length, 3, 'each book once');
    assert.deepEqual(
      Object.fromEntries(books.map((b) => [b.uri, [b.rootUri, b.fileRel]])),
      {
        [`${ws.uri}/vol1.jpbook`]: [ws.uri, 'vol1.jpbook'],
        [`${inner}/side.jpbook`]: [inner, 'side.jpbook'],
        [`${inner}/deep/index.jpbook`]: [inner, 'deep/index.jpbook'],
      },
    );
  }
});

test('nested roots: each book builds once, into its own output dir', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeNestedRoots(ws.dir);
  const inner = `${ws.uri}/extra`;

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: { ...projectsFor(ws.uri), ...projectsFor(inner) },
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.artifacts.map((a) => [a.path, a.kind === 'txt' ? a.content : a.kind]),
    [
      [`${ws.uri}/dist/vol1.txt`, 'そと\n\nうち'], // an entry may name a file inside the nested root
      [`${inner}/deep/dist/index.txt`, 'うち'],
      [`${inner}/dist/side.txt`, 'うち'],
    ],
  );
  // One publish per book: no second root diagnoses the same file against another base.
  assert.deepEqual(conn.diagnostics, [
    { uri: `${ws.uri}/vol1.jpbook`, count: 0 },
    { uri: `${inner}/deep/index.jpbook`, count: 0 },
    { uri: `${inner}/side.jpbook`, count: 0 },
  ]);
});

test('nested roots: a nested folder the disk holds decomposed still ends the outer walk', async () => {
  await using ws = await makeTmpWorkspace();
  const name = 'ガイド';
  await writeUnder(ws.dir, `${name.normalize('NFD')}/side.jpbook`, 'ch.jpnov');
  // The folder's URI as the editor gives it: the composed name, percent-encoded.
  const inner = `${ws.uri}/${encodeURIComponent(name)}`;

  const { books } = await handleListBooks(boot().ctx, {
    projectDirs: { ...projectsFor(ws.uri), ...projectsFor(inner) },
  });

  // Whether the nested root itself finds the book depends on the file system resolving the
  // composed path; the outer root never claims it.
  assert.deepEqual(books.filter((b) => b.rootUri === ws.uri), []);
});

test("names with # and % (issue #76) list, build, and select — URIs are percent-encoded like the client's", async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, '進捗100%.jpbook', meta() + '第1巻#改稿.jpnov\n50%.jpnov');
  await writeUnder(ws.dir, '第1巻#改稿.jpnov', 'あ');
  await writeUnder(ws.dir, '50%.jpnov', 'い');
  await writeUnder(ws.dir, 'sub#1/index.jpbook', meta() + 'b(1).jpnov');
  await writeUnder(ws.dir, 'sub#1/b(1).jpnov', 'う');
  const bookUri = `${ws.uri}/%E9%80%B2%E6%8D%97100%25.jpbook`;
  const subUri = `${ws.uri}/sub%231/index.jpbook`;

  const list: ListBooksResult = await handleListBooks(boot().ctx, { projectDirs: projectsFor(ws.uri) });
  assert.deepEqual(list.books.map((b) => [b.uri, b.fileRel, b.title]), [
    [subUri, 'sub#1/index.jpbook', '作品名'],
    [bookUri, '進捗100%.jpbook', '作品名'],
  ]);
  // Each URI decodes back to the real file, whatever the name.
  for (const b of list.books) {
    assert.equal(fileURLToPath(b.uri), join(ws.dir, ...b.fileRel.split('/')));
  }

  const result: BuildResult = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.artifacts.map((a) => [a.path, a.kind === 'txt' ? a.content : a.kind]),
    [[`${ws.uri}/sub%231/dist/index.txt`, 'う'], [`${ws.uri}/dist/%E9%80%B2%E6%8D%97100%25.txt`, 'あ\n\nい']],
  );

  // A subset build selects by that same key (the panel sends BookEntry.uri back verbatim).
  const subset: BuildResult = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
    books: [bookUri],
  });
  assert.deepEqual(subset.artifacts.map((a) => a.path), [`${ws.uri}/dist/%E9%80%B2%E6%8D%97100%25.txt`]);
});

test('an outDir with # (出力#1) receives the artifact', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'a.jpnov', 'あ');

  const result: BuildResult = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri, { outDir: '出力#1' }),
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.outDirs, [`${ws.uri}/%E5%87%BA%E5%8A%9B%231`]);
  assert.deepEqual(result.artifacts.map((a) => a.path), [`${ws.uri}/%E5%87%BA%E5%8A%9B%231/vol1.txt`]);
});

test('a failing book with # in its name is reported under its encoded URI; the other book still builds', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, '第1巻#改稿.jpbook', meta() + 'x#y.jpnov');
  await writeUnder(ws.dir, 'good.jpbook', meta() + 'good.jpnov');
  await writeUnder(ws.dir, 'good.jpnov', 'よい');

  const result: BuildResult = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  const badUri = `${ws.uri}/%E7%AC%AC1%E5%B7%BB%23%E6%94%B9%E7%A8%BF.jpbook`;
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((e) => [e.uri, e.book, e.code]),
    [[badUri, '第1巻#改稿.jpbook', 'book.entryFileNotFound']],
  );
  assert.deepEqual(result.artifacts.map((a) => a.path), [`${ws.uri}/dist/good.txt`]);
  // The line-level diagnostic lands on the same key the Books panel opens the book by.
  assert.ok(conn.diagnostics.some((d) => d.uri === badUri && d.count > 0));
});

test('one batch build renders a DIFFERENT header per volume, each from its own metadata', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', meta({ header: '作品名　一' }) + 'ch/a.jpnov');
  await writeUnder(ws.dir, 'vol2.jpbook', meta({ header: '作品名　二', headerAlign: 'right', footer: '' }) + 'ch/b.jpnov');
  await writeUnder(ws.dir, 'ch/a.jpnov', 'いち');
  await writeUnder(ws.dir, 'ch/b.jpnov', 'に');

  const result = await handleBuild(ctx, {
    format: 'html',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifacts);
  const vol1 = result.artifacts.find((a) => a.path.endsWith('/vol1.html'));
  const vol2 = result.artifacts.find((a) => a.path.endsWith('/vol2.html'));
  assert.ok(vol1?.kind === 'html');
  assert.ok(vol2?.kind === 'html');
  assert.ok(vol1.content.includes('<div class="hd c">作品名　一</div>'), 'vol1 carries its own header, centred by default');
  assert.ok(vol2.content.includes('<div class="hd r">作品名　二</div>'), 'vol2 carries its own header, where it asked');
  assert.ok(!vol1.content.includes('作品名　二'), 'no cross-contamination');
  // The settings snapshot carries no furniture: vol1 gets the default footer, vol2 opted out.
  assert.match(vol1.content, /<div class="ft r">/);
  assert.ok(!vol2.content.includes('class="ft'), 'an empty footer suppresses the footer');
});

test('metadata never leaks into the artifacts: body starts at the first chapter', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', meta({ title: '題', header: '柱' }) + 'a.jpnov');
  await writeUnder(ws.dir, 'a.jpnov', 'ほんぶん');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  const txt = result.artifacts[0];
  assert.ok(txt?.kind === 'txt');
  assert.equal(txt.content, 'ほんぶん', 'the .txt is the chapters only — no metadata lines');
});

test('a book whose metadata has warnings (unknown key) still builds', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', `${metaWith('publisher: 誰か', { header: '柱' })}a.jpnov`);
  await writeUnder(ws.dir, 'a.jpnov', 'あ');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.equal(result.artifacts.length, 1);
  // The warning is still published as a diagnostic on the .jpbook.
  assert.ok(conn.diagnostics.some((d) => d.uri === `${ws.uri}/vol1.jpbook` && d.count > 0));
});

test('build format "epub" returns one kind:"epub" artifact of member files per book', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta({ title: '試験本', author: '誰か' }) + 'a.jpnov\nb.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', '一章［＃「一章」は大見出し］\n本文。');
  await writeUnder(ws.dir, 'vol1/b.jpnov', '結び。');

  const result = await handleBuild(ctx, {
    format: 'epub',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifacts);
  assert.equal(result.artifacts.length, 1);
  const epub = result.artifacts[0];
  assert.ok(epub?.kind === 'epub');
  assert.equal(epub.path, `${ws.uri}/vol1/dist/vol1.epub`);
  const names = epub.members.map((m) => m.name);
  assert.ok(names.includes('META-INF/container.xml'));
  assert.ok(names.includes('OEBPS/text/ch002.xhtml'));
  const opf = epub.members.find((m) => m.name === 'OEBPS/package.opf');
  assert.ok(opf);
  assert.ok(opf.content.includes('<dc:title>試験本</dc:title>'));
  assert.ok(opf.content.includes('<dc:creator>誰か</dc:creator>'));
  // The timestamp is wall clock (second precision) — exactness lives in the pure module's tests.
  assert.match(
    opf.content,
    /<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/,
  );
});

test('build caps the EPUB 字下げ by charsPerLine from the settings snapshot', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/vol1.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', `${indentAnnotation(INDENT_MAX)}本文。`);

  const result = await handleBuild(ctx, {
    format: 'epub',
    settings: { ...SETTINGS, charsPerLine: CHARS_MIN },
    projectDirs: projectsFor(ws.uri),
  });
  const epub = result.artifacts[0];
  assert.ok(epub?.kind === 'epub');
  const doc = epub.members.find((m) => m.name === 'OEBPS/text/ch001.xhtml')?.content ?? '';
  assert.ok(doc.includes(`<p class="indent-${String(CHARS_MIN - 1)}">本文。</p>`));
});

test('results never carry a legacy epubs key', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'volume01.jpbook', meta() + 'a.jpnov');
  await writeUnder(ws.dir, 'a.jpnov', 'A');

  const txt = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });
  assert.ok(!('epubs' in txt), 'text builds keep the exact {ok, artifacts, errors} shape');

  const result = await handleBuild(ctx, {
    format: 'epub',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });
  assert.equal(result.ok, true);
  assert.ok(!('epubs' in result), 'epub builds share the same result shape');
});

test('build: an inline `cover: path` is the first cover page', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', `${metaWith('cover: src/c.jpnov\n  - src/d.jpnov')}src/a.jpnov`);
  await writeUnder(ws.dir, 'src/c.jpnov', '一枚目');
  await writeUnder(ws.dir, 'src/d.jpnov', '二枚目');
  await writeUnder(ws.dir, 'src/a.jpnov', '本文。');

  const result: BuildResult = await handleBuild(ctx, { format: 'html', settings: SETTINGS, projectDirs: projectsFor(ws.uri) });
  assert.deepEqual(result.errors, []);
  const html = result.artifacts[0];
  assert.ok(html?.kind === 'html');
  const covers = html.content.split(/(?=<div class="page)/).slice(1, 3);
  assert.ok(covers[0]?.includes('一枚目') && covers[1]?.includes('二枚目'));
  assert.deepEqual(conn.diagnostics, [{ uri: `${ws.uri}/vol1.jpbook`, count: 0 }]);
});

// --- open books: a `.jpbook` under no root rides the request itself ---

test('openBooks: a book under no root lists and builds from its own directory, with its own outDir', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'alone/本.jpbook', meta() + 'a.jpnov\n../shared/b.jpnov');
  await writeUnder(ws.dir, 'alone/a.jpnov', 'あ');
  await writeUnder(ws.dir, 'shared/b.jpnov', 'い');
  const uri = `${ws.uri}/alone/%E6%9C%AC.jpbook`;

  const list: ListBooksResult = await handleListBooks(ctx, { projectDirs: {}, openBooks: [{ uri, outDir: 'out' }] });
  assert.deepEqual(list.books, [{ uri, rootUri: null, fileRel: '本.jpbook', title: '作品名' }]);

  const result: BuildResult = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: {}, openBooks: [{ uri, outDir: 'out' }] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.outDirs, [`${ws.uri}/alone/out`]);
  assert.deepEqual(result.artifacts.map((a) => [a.path, a.kind === 'txt' ? a.content : a.kind]), [[`${ws.uri}/alone/out/%E6%9C%AC.txt`, 'あ\n\nい']]);
  assert.deepEqual(conn.diagnostics, [{ uri, count: 0 }]);

  // An invalid outDir falls back like a root's; a selection names it by uri; it follows the roots' books.
  const fallback = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: {}, openBooks: [{ uri, outDir: '/abs' }], books: [uri] });
  assert.deepEqual(fallback.outDirs, [`${ws.uri}/alone/dist`]);
  await writeUnder(ws.dir, 'proj/p.jpbook', meta() + 'p.jpnov');
  await writeUnder(ws.dir, 'proj/p.jpnov', 'ぷ');
  const both = await handleListBooks(ctx, { projectDirs: projectsFor(`${ws.uri}/proj`), openBooks: [{ uri, outDir: 'out' }] });
  assert.deepEqual(both.books.map((b) => [b.fileRel, b.rootUri]), [['p.jpbook', `${ws.uri}/proj`], ['本.jpbook', null]]);
});

test("openBooks: a missing entry is that book's error under its file name; the reader's text is what builds", async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'alone/hon.jpbook', meta() + 'gone.jpnov');
  await writeUnder(ws.dir, 'alone/a.jpnov', 'あ');
  const uri = `${ws.uri}/alone/hon.jpbook`;
  const open = { projectDirs: {}, openBooks: [{ uri, outDir: 'dist' }] };

  const missing: BuildResult = await handleBuild(boot().ctx, { format: 'txt', settings: SETTINGS, ...open });
  assert.deepEqual(missing.errors.map((e) => [e.book, e.uri, e.code, e.args]), [['hon.jpbook', uri, 'book.entryFileNotFound', ['gone.jpnov']]]);

  const live = makeContext(makeFakeConnection(), unsaved('hon.jpbook', meta() + 'a.jpnov'));
  const built: BuildResult = await handleBuild(live, { format: 'txt', settings: SETTINGS, ...open });
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.artifacts.map((a) => a.path), [`${ws.uri}/alone/dist/hon.txt`]);
});

// --- cover pages -------------------------------------------------------------

/** A book with a two-entry cover list, a template cover, and a two-page (three-sheet) body. */
async function writeCoverFixture(dir: string): Promise<void> {
  await writeUnder(dir, 'vol1.jpbook', metaWith([
    'cover:',
    '  - src/cover.jpnov',
    '  - src/arasuji.jpnov',
  ].join('\n'), { author: 'ペンネーム', header: '柱' }) + 'src/a.jpnov');
  await writeUnder(dir, 'src/cover.jpnov', [
    '［＃ここに「タイトル」の値を表示］',
    '［＃ここに「ペンネーム」の値を表示］',
    '全［＃縦中横］［＃ここに「総ページ数」の値を表示］［＃縦中横終わり］ページ',
    '４００字詰め原稿用紙換算［＃縦中横］［＃ここに「原稿用紙換算枚数」の値を表示］［＃縦中横終わり］枚',
  ].join('\n'));
  await writeUnder(dir, 'src/arasuji.jpnov', 'あらすじ本文。');
  // Two pages on the 40×34 SETTINGS grid; three sheets (the lines after the break spill one).
  const after = Array.from({ length: MANUSCRIPT_SHEET.linesPerPage + 1 }, () => '続き。').join('\n');
  await writeUnder(dir, 'src/a.jpnov', `本文。\n［＃改ページ］\n${after}`);
}

test('build: covers render as unnumbered front pages carrying the book values (html only)', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeCoverFixture(ws.dir);

  const result: BuildResult = await handleBuild(ctx, {
    format: 'html',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });
  assert.equal(result.ok, true);
  const html = result.artifacts[0];
  assert.ok(html?.kind === 'html');

  const sheets = html.content.split(/(?=<div class="page)/).slice(1);
  assert.equal(sheets.length, 4); // 2 covers + 2 body pages
  assert.ok(sheets[0]?.startsWith('<div class="page cover" data-page="0">'));
  assert.ok(sheets[1]?.startsWith('<div class="page cover" data-page="1">'));
  // The book's own values land on the cover; both counts are the BODY's, each on its own grid.
  assert.ok(sheets[0]?.includes('作品名'));
  assert.ok(sheets[0]?.includes('ペンネーム'));
  assert.ok(sheets[0]?.includes('全<span class="tcy">2</span>ページ'));
  assert.ok(sheets[0]?.includes('換算<span class="tcy">3</span>枚'));
  // Neither cover carries the book's header or a footer; the body starts at page 1.
  for (const cover of [sheets[0], sheets[1]]) {
    assert.ok(cover !== undefined && !cover.includes('class="hd') && !cover.includes('class="ft'));
  }
  assert.match(sheets[2] ?? '', /<div class="hd c">柱<\/div><div class="ft r">1 \/ 2<\/div>/);
});

test('build: the header and footer take the value annotations, filled per page', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', meta({
    author: 'ペンネーム',
    header: '［＃ここに「タイトル」の値を表示］',
    footer: '［＃ここに「ペンネーム」の値を表示］　［＃ここに「ページ番号」の値を表示］',
  }) + 'a.jpnov');
  await writeUnder(ws.dir, 'a.jpnov', '本文。');

  const html = (await handleBuild(ctx, {
    format: 'html',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  })).artifacts[0];
  assert.ok(html?.kind === 'html');
  assert.match(html.content, /<div class="hd c">作品名<\/div><div class="ft r">ペンネーム　1<\/div>/);
});

test('build: the title is used verbatim; an author left empty, or showing nothing, is unset in every format', async () => {
  for (const author of ['', '\u0007']) {
    await using ws = await makeTmpWorkspace();
    const { ctx } = boot();
    // Nested on purpose: the output name (`part1/vol2`) never stands in for the title.
    await writeUnder(ws.dir, 'part1/vol2.jpbook', metaWith('cover:\n- ../c.jpnov', { title: '作品名　二', author }) + '../a.jpnov');
    await writeUnder(ws.dir, 'c.jpnov', '［＃ここに「タイトル」の値を表示］／［＃ここに「ペンネーム」の値を表示］');
    await writeUnder(ws.dir, 'a.jpnov', '本文。');

    const html = (await handleBuild(ctx, {
      format: 'html',
      settings: SETTINGS,
      projectDirs: projectsFor(ws.uri),
    })).artifacts[0];
    assert.ok(html?.kind === 'html');
    // The title as written, and an absent author contributes nothing after the separator.
    assert.match(html.content, /<div class="line" data-line="0">作品名　二／<\/div>/);
    assert.doesNotMatch(html.content, /vol2/);

    // …and the EPUB's dc:title agrees, with no dc:creator.
    const epub = (await handleBuild(ctx, {
      format: 'epub',
      settings: SETTINGS,
      projectDirs: projectsFor(ws.uri),
    })).artifacts[0];
    assert.ok(epub?.kind === 'epub');
    const opf = epub.members.find((m) => m.name === 'OEBPS/package.opf')?.content ?? '';
    assert.match(opf, /<dc:title>作品名　二<\/dc:title>/);
    assert.doesNotMatch(opf, /<dc:creator>/);
  }
});

test('build: txt and epub ignore the cover key entirely (byte-identical either way)', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'src/cover.jpnov', '［＃ここに「タイトル」の値を表示］');
  await writeUnder(ws.dir, 'src/a.jpnov', '本文。');
  // One workspace, so paths match too; the EPUB's wall-clock dcterms:modified is normalized.
  const build = async (jpbook: string, format: 'txt' | 'epub'): Promise<string> => {
    await writeUnder(ws.dir, 'vol1.jpbook', jpbook);
    const result: BuildResult = await handleBuild(boot().ctx, {
      format,
      settings: SETTINGS,
      projectDirs: projectsFor(ws.uri),
    });
    assert.equal(result.ok, true);
    return JSON.stringify(result.artifacts).replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, 'T');
  };
  const plain = meta() + 'src/a.jpnov';
  const covered = `${metaWith('cover:\n  - src/cover.jpnov')}src/a.jpnov`;

  assert.equal(await build(covered, 'txt'), await build(plain, 'txt'));
  assert.equal(await build(covered, 'epub'), await build(plain, 'epub'));
});

test('build: a missing cover file fails ONLY the html build; txt still succeeds', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1.jpbook', `${metaWith('cover:\n  - src/gone.jpnov')}src/a.jpnov`);
  await writeUnder(ws.dir, 'src/a.jpnov', '本文。');

  const html: BuildResult = await handleBuild(boot().ctx, {
    format: 'html',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });
  assert.equal(html.ok, false);
  assert.equal(html.artifacts.length, 0);
  assert.equal(html.errors[0]?.code, 'book.entryFileNotFound');
  assert.deepEqual(html.errors[0].args, ['src/gone.jpnov']);
  assert.equal(html.errors[0].uri, `${ws.uri}/vol1.jpbook`);

  const txt: BuildResult = await handleBuild(boot().ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });
  assert.equal(txt.ok, true);
  assert.equal(txt.artifacts.length, 1);
});

test('build: duplicate and muted cover lines never reach the output', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', metaWith([
    'cover:',
    '  - src/c.jpnov',
    '  - src/c.jpnov', // duplicate — warned, built once
    'cover:',
    '  - src/second.jpnov', // muted by the duplicate key — never built
  ].join('\n')) + 'src/a.jpnov');
  await writeUnder(ws.dir, 'src/c.jpnov', '表紙');
  await writeUnder(ws.dir, 'src/second.jpnov', '二枚目');
  await writeUnder(ws.dir, 'src/a.jpnov', '本文。');

  const result: BuildResult = await handleBuild(ctx, {
    format: 'html',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });
  assert.equal(result.ok, true);
  const html = result.artifacts[0];
  assert.ok(html?.kind === 'html');
  assert.equal((html.content.match(/class="page cover"/g) ?? []).length, 1);
  assert.ok(!html.content.includes('二枚目'));
  // A clean build still publishes the manifest's problems (codes pinned by diagnoseJpbook).
  assert.ok(conn.diagnostics.some((d) => d.uri === `${ws.uri}/vol1.jpbook` && d.count === 3));
});

test('build: a missing chapter outranks a missing cover, so every format reports the same error', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1.jpbook', `${metaWith('cover:\n  - src/gone-cover.jpnov')}src/gone-chapter.jpnov`);

  for (const format of ['html', 'txt'] as const) {
    const result: BuildResult = await handleBuild(boot().ctx, {
      format,
      settings: SETTINGS,
      projectDirs: projectsFor(ws.uri),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors[0]?.args, ['src/gone-chapter.jpnov'], `${format} names the chapter`);
  }
});

test('build: CRLF chapters — the txt keeps CRLF, the html equals the LF build; CR chapters build as LF', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1.jpbook', meta() + 'src/a.jpnov\nsrc/b.jpnov');
  const build = async (eol: string, format: 'txt' | 'html'): Promise<string> => {
    await writeUnder(ws.dir, 'src/a.jpnov', `あいう${eol}`);
    await writeUnder(ws.dir, 'src/b.jpnov', `かきく${eol}`);
    const result: BuildResult = await handleBuild(boot().ctx, {
      format,
      settings: SETTINGS,
      projectDirs: projectsFor(ws.uri),
    });
    assert.equal(result.ok, true);
    const artifact = result.artifacts[0];
    assert.ok(artifact !== undefined && artifact.kind !== 'epub');
    return artifact.content;
  };
  assert.equal(await build('\r\n', 'txt'), 'あいう\r\n\r\nかきく');
  assert.equal(await build('\n', 'txt'), 'あいう\n\nかきく');
  assert.equal(await build('\r\n', 'html'), await build('\n', 'html'));
  assert.equal(await build('\r', 'txt'), 'あいう\n\nかきく');
  assert.equal(await build('\r', 'html'), await build('\n', 'html'));
});

// --- manuscript encoding (issue #81): the server never decodes bytes, the context's reader does ---

/** Shift JIS bytes of `text`. */
function sjis(text: string): Uint8Array {
  return encodeTxt(text, 'shiftJis').bytes;
}

/** A reader that fails `rel` with `reason` and reads everything else from disk as UTF-8. */
function failing(rel: string, reason: ReadTextFailure): ReadText {
  const disk = nodeReader();
  return (uri, token) =>
    uri.endsWith(`/${rel}`) ? Promise.resolve({ ok: false, reason, why: 'EACCES: permission denied' }) : disk(uri, token);
}

const CHAPTER = '　山田　太郎は王都へ向かった。';

test('build: Shift JIS manuscript and manifest come out clean when the reader decodes them as the editor would', async () => {
  await using ws = await makeTmpWorkspace();
  const ctx = makeContext(makeFakeConnection(), nodeReader('shift_jis'));
  await writeUnder(ws.dir, 'vol1.jpbook', sjis(meta() + 'src/a.jpnov\n'));
  await writeUnder(ws.dir, 'src/a.jpnov', sjis(CHAPTER));

  const txt: BuildResult = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri) });
  assert.deepEqual(txt.errors, []);
  const artifact = txt.artifacts[0];
  assert.ok(artifact?.kind === 'txt');
  assert.equal(artifact.content, CHAPTER);

  const epub: BuildResult = await handleBuild(ctx, { format: 'epub', settings: SETTINGS, projectDirs: projectsFor(ws.uri) });
  const book = epub.artifacts[0];
  assert.ok(book?.kind === 'epub');
  const opf = book.members.find((m) => m.name === 'OEBPS/package.opf')?.content ?? '';
  assert.ok(opf.includes('<dc:title>作品名</dc:title>'));
});

test('build: the same Shift JIS bytes under a UTF-8 reader build ok with U+FFFD, as the editor would show them', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1.jpbook', meta() + 'src/a.jpnov');
  await writeUnder(ws.dir, 'src/a.jpnov', sjis(CHAPTER));

  const result: BuildResult = await handleBuild(boot().ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri) });
  assert.equal(result.ok, true);
  const artifact = result.artifacts[0];
  assert.ok(artifact?.kind === 'txt');
  assert.ok(artifact.content.includes('\uFFFD'));
});

const READ_FAILURES: readonly [ReadTextFailure, MsgCode, readonly string[]][] = [
  ['notFound', 'book.entryFileNotFound', ['x.jpnov']],
  ['notText', 'book.entryNotText', ['x.jpnov']],
  ['noReply', 'book.entryNoReply', ['x.jpnov']],
  ['other', 'book.entryReadFailed', ['x.jpnov', 'EACCES: permission denied']],
];

for (const [reason, code, args] of READ_FAILURES) {
  test(`build: a "${reason}" read failure is that book's ${code}; the other book still builds`, async () => {
    await using ws = await makeTmpWorkspace();
    const ctx = makeContext(makeFakeConnection(), failing('bad/x.jpnov', reason));
    await writeUnder(ws.dir, 'bad/bad.jpbook', meta() + 'x.jpnov');
    await writeUnder(ws.dir, 'bad/x.jpnov', 'あ');
    await writeUnder(ws.dir, 'good/good.jpbook', meta() + 'y.jpnov');
    await writeUnder(ws.dir, 'good/y.jpnov', 'い');

    const result: BuildResult = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri) });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((e) => [e.uri, e.code, e.args]), [[`${ws.uri}/bad/bad.jpbook`, code, args]]);
    assert.deepEqual(result.artifacts.map((a) => a.path), [`${ws.uri}/good/dist/good.txt`]);
  });
}

/** A `.jpbook` Error line or missing key refuses the book whatever the format; each row's manifest is `bad/bad.jpbook`. */
const SYNTAX_FAILURES: readonly {
  readonly name: string;
  readonly manifest: string;
  /** Files to create (an Error line fails even when its file exists). */
  readonly files: readonly string[];
  readonly format: BuildFormat;
  readonly code: MsgCode;
  readonly args: readonly string[];
  /** Diagnostics published on the manifest: the missing keys, line errors, fs verdicts on the ok lines. */
  readonly diagnostics: number;
}[] = [
  {
    name: 'an empty manifest',
    manifest: '',
    files: [],
    format: 'txt',
    code: 'jpbook.headerMissing',
    args: [HEADER],
    diagnostics: 1,
  },
  {
    // The keys stand where the header should: nothing below the first line is read.
    name: 'the header line missing',
    manifest: `${metaBody()}---\n第一章.jpnov`,
    files: ['bad/第一章.jpnov'],
    format: 'txt',
    code: 'jpbook.headerMissing',
    args: [HEADER],
    diagnostics: 1,
  },
  {
    name: 'a version this extension does not read',
    manifest: `jpbook/2\n${metaBody()}---\n第一章.jpnov`,
    files: ['bad/第一章.jpnov'],
    format: 'html',
    code: 'jpbook.versionUnsupported',
    args: ['2', JPBOOK_VERSION],
    diagnostics: 1,
  },
  {
    // An unwritten key is an empty one: the title cannot be, so its empty-value Error sits on the fence.
    name: 'the title not written',
    manifest: meta({}, ['title']) + '第一章.jpnov',
    files: ['bad/第一章.jpnov'],
    format: 'html',
    code: 'jpbook.metaEmptyValue',
    args: ['title'],
    diagnostics: 1,
  },
  {
    name: 'both alignments not written (reported in key order)',
    manifest: meta({}, ['footerAlign', 'headerAlign']) + '第一章.jpnov',
    files: ['bad/第一章.jpnov'],
    format: 'txt',
    code: 'jpbook.metaEmptyValue',
    args: ['headerAlign'],
    diagnostics: 2,
  },
  {
    // The key counts as written: the error names the empty value, not a missing key.
    name: 'an empty title',
    manifest: meta({ title: '' }) + '第一章.jpnov',
    files: ['bad/第一章.jpnov'],
    format: 'epub',
    code: 'jpbook.metaEmptyValue',
    args: ['title'],
    diagnostics: 1,
  },
  {
    name: 'a bad alignment',
    manifest: meta({ footerAlign: 'どこか' }) + '第一章.jpnov',
    files: ['bad/第一章.jpnov'],
    format: 'txt',
    code: 'jpbook.metaBadEnum',
    args: ['footerAlign', 'どこか', FURNITURE_ALIGNS.join(', ')],
    diagnostics: 1,
  },
  {
    // The bad line took the key; the valid retake below it is a duplicate (a Warning).
    name: 'an empty alignment, retaken below',
    manifest: meta({ headerAlign: '' }) + 'headerAlign: center\n第一章.jpnov',
    files: ['bad/第一章.jpnov'],
    format: 'html',
    code: 'jpbook.metaEmptyValue',
    args: ['headerAlign'],
    diagnostics: 2,
  },
  {
    // A lone fence closes an empty metadata block: the title and both alignments are missing.
    name: 'a lone fence',
    manifest: `${HEAD}---`,
    files: [],
    format: 'txt',
    code: 'jpbook.metaEmptyValue',
    args: ['title'],
    diagnostics: 3,
  },
  {
    // A `---` right under the header closes the metadata at once; the keys below read as chapters.
    name: 'a fence under the header, above the keys',
    manifest: `${HEAD}---\n${metaBody()}---\n第一章.jpnov`,
    files: ['bad/第一章.jpnov'],
    format: 'txt',
    code: 'jpbook.metaEmptyValue',
    args: ['title'],
    diagnostics: 4 + META_KEYS.length,
  },
  {
    // Without a fence the chapter lines read as metadata; the missing fence is the root cause.
    name: 'no closing fence',
    manifest: `${HEAD}${metaBody()}第一章.jpnov`,
    files: ['bad/第一章.jpnov'],
    format: 'txt',
    code: 'jpbook.metaUnterminated',
    args: [],
    diagnostics: 2,
  },
  {
    name: 'a backslash separator',
    manifest: meta() + 'sub\\第一章.jpnov',
    files: ['bad/sub/第一章.jpnov'],
    format: 'epub',
    code: 'jpbook.backslashSeparator',
    args: ['sub\\第一章.jpnov'],
    diagnostics: 1,
  },
  {
    name: 'a non-.jpnov entry after a valid chapter (CRLF manifest)',
    manifest: meta().replaceAll('\n', '\r\n') + '第一章.jpnov\r\n第二章.txt\r\n',
    files: ['bad/第一章.jpnov', 'bad/第二章.txt'],
    format: 'txt',
    code: 'jpbook.notJpnov',
    args: ['第二章.txt'],
    diagnostics: 1,
  },
  {
    // A colon-less line among the keys is an Error of its own; the keys below it stay metadata.
    name: 'a colon-less metadata line',
    manifest: `${HEAD}just text\n${metaBody()}---\n第一章.jpnov`,
    files: ['bad/第一章.jpnov'],
    format: 'txt',
    code: 'jpbook.metaNotKeyValue',
    args: ['just text'],
    diagnostics: 1,
  },
  {
    name: 'a cover-item error under a txt build',
    manifest: `${metaWith('cover:\n  - 表紙.txt')}第一章.jpnov`,
    files: ['bad/表紙.txt', 'bad/第一章.jpnov'],
    format: 'txt',
    code: 'jpbook.notJpnov',
    args: ['- 表紙.txt'],
    diagnostics: 1,
  },
  {
    // Reported over the missing chapter, which still gets its diagnostic.
    name: 'a syntax error beside a missing chapter',
    manifest: meta() + '第一章.jpnov\n第二章.txt',
    files: [],
    format: 'html',
    code: 'jpbook.notJpnov',
    args: ['第二章.txt'],
    diagnostics: 2,
  },
];

for (const row of SYNTAX_FAILURES) {
  test(`build: ${row.name} is that book's error and emits nothing`, async () => {
    await using ws = await makeTmpWorkspace();
    const { ctx, conn } = boot();
    await writeUnder(ws.dir, 'bad/bad.jpbook', row.manifest);
    for (const rel of row.files) {
      await writeUnder(ws.dir, rel, 'あ');
    }

    const result: BuildResult = await handleBuild(ctx, { format: row.format, settings: SETTINGS, projectDirs: projectsFor(ws.uri) });
    const badUri = `${ws.uri}/bad/bad.jpbook`;
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((e) => [e.uri, e.code, e.args]), [[badUri, row.code, row.args]]);
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(conn.diagnostics, [{ uri: badUri, count: row.diagnostics }]);
  });
}

test('build: a missing key fails the book before any chapter is read; the other book still builds', async () => {
  await using ws = await makeTmpWorkspace();
  const conn = makeFakeConnection();
  const reads: string[] = [];
  const disk = nodeReader();
  const ctx = makeContext(conn, (uri, token) => {
    reads.push(uri.slice(ws.uri.length + 1));
    return disk(uri, token);
  });
  await writeUnder(ws.dir, 'bad/bad.jpbook', meta({}, ['title']) + 'a.jpnov\nb.jpnov');
  await writeUnder(ws.dir, 'bad/a.jpnov', 'あ');
  await writeUnder(ws.dir, 'bad/b.jpnov', 'い');
  await writeUnder(ws.dir, 'good/good.jpbook', meta() + 'y.jpnov');
  await writeUnder(ws.dir, 'good/y.jpnov', 'う');

  const result: BuildResult = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri) });
  const badUri = `${ws.uri}/bad/bad.jpbook`;
  assert.deepEqual(reads, ['bad/bad.jpbook', 'good/good.jpbook', 'good/y.jpnov']); // no bad chapter
  assert.deepEqual(
    result.errors.map((e) => [e.book, e.uri, e.code, e.args]),
    [['bad/bad.jpbook', badUri, 'jpbook.metaEmptyValue', ['title']]],
  );
  assert.deepEqual(result.artifacts.map((a) => a.path), [`${ws.uri}/good/dist/good.txt`]);
  // bad: the unwritten title, on its fence (the metadata one line shorter); good: none.
  const badFence = FENCE_LINE - 1;
  assert.deepEqual(conn.published.map((p) => [p.uri, p.diagnostics.map((d) => d.range.start.line)]), [[badUri, [badFence]], [`${ws.uri}/good/good.jpbook`, []]]);
});

test('build: duplicate-key, unknown-key and duplicate-chapter warnings stay non-fatal', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', `${metaWith('title: 作品名\npublisher: 誰か')}src/a.jpnov\nsrc/a.jpnov`);
  await writeUnder(ws.dir, 'src/a.jpnov', 'あ');

  const result: BuildResult = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  const artifact = result.artifacts[0];
  assert.ok(artifact?.kind === 'txt');
  assert.equal(artifact.content, 'あ'); // the duplicate line is not built twice
  assert.deepEqual(conn.diagnostics, [{ uri: `${ws.uri}/vol1.jpbook`, count: 3 }]);
});

test('build: a manifest the reader cannot decode is that book\'s error; a vanished manifest is skipped', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1.jpbook', meta() + 'src/a.jpnov');
  await writeUnder(ws.dir, 'src/a.jpnov', 'あ');
  const params = { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri) } as const;

  const notText: BuildResult = await handleBuild(makeContext(makeFakeConnection(), failing('vol1.jpbook', 'notText')), params);
  assert.deepEqual(notText.errors.map((e) => [e.uri, e.code, e.args]), [[`${ws.uri}/vol1.jpbook`, 'book.entryNotText', ['vol1.jpbook']]]);
  assert.equal(notText.artifacts.length, 0);

  const vanished: BuildResult = await handleBuild(makeContext(makeFakeConnection(), failing('vol1.jpbook', 'notFound')), params);
  assert.equal(vanished.ok, true);
  assert.equal(vanished.artifacts.length, 0);
});

test('listBooks: a book whose manifest the reader cannot read is listed untitled', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1.jpbook', meta() + 'src/a.jpnov');
  const ctx = makeContext(makeFakeConnection(), failing('vol1.jpbook', 'other'));

  const result: ListBooksResult = await handleListBooks(ctx, { projectDirs: projectsFor(ws.uri) });
  assert.deepEqual(result.books.map((b) => [b.fileRel, b.title]), [['vol1.jpbook', undefined]]);
});

test('build: the request token rides every readText call', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1.jpbook', meta() + 'src/a.jpnov\nsrc/b.jpnov');
  await writeUnder(ws.dir, 'src/a.jpnov', 'あ');
  await writeUnder(ws.dir, 'src/b.jpnov', 'い');
  const seen: (CancellationToken | undefined)[] = [];
  const disk = nodeReader();
  const ctx = makeContext(makeFakeConnection(), (uri, token) => {
    seen.push(token);
    return disk(uri, token);
  });
  const token = new CancellationTokenSource().token;

  await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri) }, undefined, token);
  assert.equal(seen.length, 3); // the manifest + two chapters
  assert.ok(seen.every((t) => t === token));
});

// --- an open manifest (issue #82): its diagnostics sit on the lines the reader returns ---

/** A reader that answers `rel` with `text`, the editor's unsaved buffer, and reads everything else from disk. */
function unsaved(rel: string, text: string): ReadText {
  const disk = nodeReader();
  return (uri, token) => (uri.endsWith(`/${rel}`) ? Promise.resolve({ ok: true, text }) : disk(uri, token));
}

test('build: the manifest is diagnosed on the lines the reader returns, unsaved edits included', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1.jpbook', meta() + 'src/gone.jpnov');
  // Saved, the missing chapter follows the fence; a blank line typed above it and left unsaved moves it down one.
  const readers: readonly [ReadText, number][] = [
    [nodeReader(), FENCE_LINE + 1],
    [unsaved('vol1.jpbook', `${meta()}\nsrc/gone.jpnov`), FENCE_LINE + 2],
  ];

  for (const [reader, line] of readers) {
    const conn = makeFakeConnection();
    await handleBuild(makeContext(conn, reader), { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri) });
    assert.deepEqual(
      conn.published.map((p) => [p.uri, p.diagnostics.map((d) => [d.code, d.range.start.line])]),
      [[`${ws.uri}/vol1.jpbook`, [['jpbook.fileNotFound', line]]]],
    );
  }
});
