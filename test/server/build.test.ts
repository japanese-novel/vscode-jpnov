/**
 * Integration tests for the `jpnov/build` + `jpnov/listBooks` handlers against real `file:`
 * fixtures. Runs via `npm run test:integration` (not plain `npm test`): it imports server
 * modules whose `#/*` VALUE imports need the resolve hook in `test/resolve-hooks.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
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
import { LAYOUT_DEFAULT } from '../../src/shared/config/types.ts';
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
  // index.jpbook in vol1/ -> dist/vol1.{txt,html}; entries are root-relative.
  await writeUnder(ws.dir, 'vol1/index.jpbook', 'vol1/a.jpnov\nvol1/b.jpnov');
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
  assert.equal(html.path, `${ws.uri}/dist/vol1.html`);
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
  assert.equal(txt.path, `${ws.uri}/dist/vol1.txt`);
  // The .txt is the concatenated source: one blank glue line between chapters, no trailing newline.
  assert.equal(txt.content, 'あいう\n\nかきく');
});

test('a pre-cancelled token skips the work and returns an empty result', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/index.jpbook', 'vol1/a.jpnov');
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

test('a front-matter divider lands between heading-less chapters in BOTH artifacts', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(
    ws.dir,
    'vol1/index.jpbook',
    '---\ndivider: ＊\n---\nvol1/a.jpnov\nvol1/b.jpnov\nvol1/c.jpnov',
  );
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

test('build stays lenient on an unclosed ［＃: ok, artifacts emitted, tail visible as literal text', async () => {
  // Preview/build cohesion: a syntax error is an EDITOR diagnostic, never a build gate. The
  // swallowed tail must appear verbatim in the HTML (same shared buildRows arm the preview uses).
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/index.jpbook', 'vol1/a.jpnov');
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

test('nested jpbook mirrors the folder tree in the output path', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'part1/vol2/index.jpbook', 'part1/vol2/c.jpnov');
  await writeUnder(ws.dir, 'part1/vol2/c.jpnov', 'テスト');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifacts);
  const txt = result.artifacts[0];
  assert.ok(txt?.kind === 'txt');
  assert.equal(txt.path, `${ws.uri}/dist/part1/vol2.txt`);
  assert.equal(txt.content, 'テスト');
});

test('deeply nested jpbook writes a mirrored nested output path', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'a/b/c/index.jpbook', 'a/b/c/d.jpnov');
  await writeUnder(ws.dir, 'a/b/c/d.jpnov', 'ふかい');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  // The nested file's reveal target is still the resolved outDir, not its own parent.
  assert.deepEqual(result.outDirs, [`${ws.uri}/dist`]);
  const txt = result.artifacts[0];
  assert.ok(txt?.kind === 'txt');
  assert.equal(txt.path, `${ws.uri}/dist/a/b/c.txt`);
  assert.equal(txt.content, 'ふかい');
});

test('entries resolve against the workspace folder root, wherever the book sits', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  // The book lives in books/, its chapter in chapters/ — a sibling ABOVE the book's own dir.
  // Root-relative entries make that trivially expressible (and moving the book is a no-op).
  await writeUnder(ws.dir, 'books/volume01.jpbook', 'chapters/ch1.jpnov');
  await writeUnder(ws.dir, 'chapters/ch1.jpnov', 'ほん');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifacts);
  const txt = result.artifacts[0];
  assert.ok(txt?.kind === 'txt');
  assert.equal(txt.path, `${ws.uri}/dist/books/volume01.txt`);
  assert.equal(txt.content, 'ほん');
});

test('projectDirs overrides outDir per root', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/index.jpbook', 'vol1/a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'ほんぶん');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri, { outDir: 'out' }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.outDirs, [`${ws.uri}/out`]);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.path, `${ws.uri}/out/vol1.txt`);
});

test('outDirs carries each resolved output dir ONCE across the books that landed in it', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'a/index.jpbook', 'a/x.jpnov');
  await writeUnder(ws.dir, 'a/x.jpnov', 'A');
  await writeUnder(ws.dir, 'b/index.jpbook', 'b/y.jpnov');
  await writeUnder(ws.dir, 'b/y.jpnov', 'B');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.equal(result.artifacts.length, 2);
  assert.deepEqual(result.outDirs, [`${ws.uri}/dist`]);
});

test('an invalid outDir silently falls back to dist — and the FALLBACK dir is what discovery skips', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/index.jpbook', 'vol1/a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'あ');
  // Lives inside the FALLBACK output dir: it must be excluded even though the
  // configured outDir string ('/abs') never resolved.
  await writeUnder(ws.dir, 'dist/hidden.jpbook', 'a.jpnov');

  // An absolute outDir is rejected by containment and silently replaced by the
  // default — the build proceeds as if unset.
  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri, { outDir: '/abs' }),
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifacts);
  assert.equal(result.artifacts.length, 1, 'only vol1 built — dist/hidden.jpbook skipped');
  assert.equal(result.artifacts[0]?.path, `${ws.uri}/dist/vol1.txt`);
});

test('a missing referenced .jpnov is a per-book error + diagnostic; other books still build', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'bad/index.jpbook', 'bad/present.jpnov\nbad/gone.jpnov');
  await writeUnder(ws.dir, 'bad/present.jpnov', 'ある');
  await writeUnder(ws.dir, 'good/index.jpbook', 'good/y.jpnov');
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
  const badUri = `${ws.uri}/bad/index.jpbook`;
  assert.equal(err.book, 'bad/index.jpbook');
  assert.equal(err.uri, badUri); // the Books panel opens the failing book by this key
  assert.equal(err.code, 'book.entryFileNotFound');
  assert.ok(String(err.args?.[0]).includes('gone.jpnov'));
  // The good book still produced its artifact.
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.path, `${ws.uri}/dist/good.txt`);
  // A diagnostic was published on the offending .jpbook (line-level).
  assert.ok(conn.diagnostics.some((d) => d.uri === badUri && d.count > 0));
});

test('two book files colliding on the output path error BOTH and emit neither', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  // volume01/index.jpbook and volume01.jpbook both derive base "volume01".
  await writeUnder(ws.dir, 'volume01/index.jpbook', 'volume01/a.jpnov');
  await writeUnder(ws.dir, 'volume01/a.jpnov', 'A');
  await writeUnder(ws.dir, 'volume01.jpbook', 'volume01/a.jpnov');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors);
  assert.ok(result.artifacts);
  assert.ok(result.errors.length >= 2, 'both colliding book files error');
  assert.ok(
    result.errors.every((e) => e.code === 'build.outPathCollision'),
    'collision code present on both',
  );
  assert.equal(result.artifacts.length, 0, 'neither colliding book is emitted');
  assert.deepEqual(
    result.errors.map((e) => e.uri).sort(),
    ['volume01/index.jpbook', 'volume01.jpbook'].map((rel) => `${ws.uri}/${rel}`).sort(),
  );
  for (const rel of ['volume01/index.jpbook', 'volume01.jpbook']) {
    assert.ok(
      conn.diagnostics.some((d) => d.uri === `${ws.uri}/${rel}` && d.count > 0),
      `diagnostic on ${rel}`,
    );
  }
});

test('build honors the kinsoku mode from the settings snapshot (禁則)', async () => {
  await using ws = await makeTmpWorkspace();
  // 禁則 rides the request's settings snapshot (same source as the preview). At width 16 a
  // naive wrap ends column 1 on the opening 「 (cell 16); 追い出し pushes it down →
  // 15×あ | 「い」. Proves settings.kinsoku reaches renderBook alongside charsPerLine.
  // (The footer is suppressed through the book's OWN front matter, not settings.)
  const { ctx } = boot();
  const head = 'あ'.repeat(15);
  await writeUnder(ws.dir, 'vol1/index.jpbook', '---\nfooterAlign: none\n---\nvol1/a.jpnov');
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
          '<div class="line" data-line="0">「い」</div>',
    ),
    '追い出し keeps the opening bracket with its content',
  );
});

test('build with an empty projectDirs map returns ok with no artifacts', async () => {
  const { ctx } = boot();
  const result = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: {} });
  assert.deepEqual(result, { ok: true, outDirs: [], artifacts: [], errors: [] });
});

test('build targets only the roots in projectDirs', async () => {
  await using wsA = await makeTmpWorkspace();
  await using wsB = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(wsA.dir, 'va/index.jpbook', 'va/x.jpnov');
  await writeUnder(wsA.dir, 'va/x.jpnov', 'A');
  await writeUnder(wsB.dir, 'vb/index.jpbook', 'vb/y.jpnov');
  await writeUnder(wsB.dir, 'vb/y.jpnov', 'B');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(wsA.uri),
  });

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.path, `${wsA.uri}/dist/va.txt`);
});

test('listBooks enumerates every jpbook, carrying its front-matter title when present', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1/index.jpbook', 'vol1/a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'あ');
  await writeUnder(ws.dir, 'part1/vol2/index.jpbook', '---\ntitle: 第二巻\n---\npart1/vol2/c.jpnov');
  await writeUnder(ws.dir, 'part1/vol2/c.jpnov', 'て');

  // Enumeration reads each file (through the context's reader) only for its title; it
  // publishes no diagnostics by construction.
  const result: ListBooksResult = await handleListBooks(boot().ctx, { projectDirs: projectsFor(ws.uri) });

  assert.equal(result.books.length, 2);
  const byOut = new Map(result.books.map((b) => [b.outRel, b]));
  const vol1 = byOut.get('vol1');
  const vol2 = byOut.get('part1/vol2');
  assert.ok(vol1);
  assert.ok(vol2);
  assert.equal(vol1.uri, `${ws.uri}/vol1/index.jpbook`);
  assert.equal(vol1.fileRel, 'vol1/index.jpbook');
  assert.equal(vol1.rootUri, ws.uri);
  assert.equal(vol1.title, undefined, 'no front matter -> no title');
  assert.equal(vol2.fileRel, 'part1/vol2/index.jpbook');
  assert.equal(vol2.title, '第二巻');
});

test('build format "html" emits only the .html artifact', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/index.jpbook', 'vol1/a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'あ');

  const result = await handleBuild(ctx, {
    format: 'html',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifacts);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.path, `${ws.uri}/dist/vol1.html`);
});

test('build format "txt" emits only the .txt artifact', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/index.jpbook', 'vol1/a.jpnov');
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
  assert.equal(only.path, `${ws.uri}/dist/vol1.txt`);
  assert.equal(only.content, 'あ');
});

test('build restricts to the selected books (by jpbook uri)', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'a/index.jpbook', 'a/x.jpnov');
  await writeUnder(ws.dir, 'a/x.jpnov', 'A');
  await writeUnder(ws.dir, 'b/index.jpbook', 'b/y.jpnov');
  await writeUnder(ws.dir, 'b/y.jpnov', 'B');

  const onlyA = `${ws.uri}/a/index.jpbook`;
  const result = await handleBuild(ctx, {
    books: [onlyA],
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.artifacts.length, 1); // a.txt, and nothing from book b
  assert.equal(result.artifacts[0]?.path, `${ws.uri}/dist/a.txt`);
});

test('build with an empty books selection builds nothing (distinct from omitting it)', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'a/index.jpbook', 'a/x.jpnov');
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

test('a selected book still errors when it collides with an UNSELECTED one', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  // Both derive base "volume01"; select only the flat one.
  await writeUnder(ws.dir, 'volume01/index.jpbook', 'volume01/a.jpnov');
  await writeUnder(ws.dir, 'volume01/a.jpnov', 'A');
  await writeUnder(ws.dir, 'volume01.jpbook', 'volume01/a.jpnov');

  const selected = `${ws.uri}/volume01.jpbook`;
  const result = await handleBuild(ctx, {
    books: [selected],
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.code, 'build.outPathCollision');
  assert.deepEqual(result.artifacts, []);
});

test('a txt-only build still reports a missing .jpnov as a per-book error + diagnostic', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'bad/index.jpbook', 'bad/present.jpnov\nbad/gone.jpnov');
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
  const badUri = `${ws.uri}/bad/index.jpbook`;
  assert.ok(conn.diagnostics.some((d) => d.uri === badUri && d.count > 0));
});

test('a root-level jpbook is discovered (discovery is anchored at the folder root)', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'volume1.jpbook', 'ch1.jpnov');
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

test('a src/ layout mirrors the src layer into the output path', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'src/volume1.jpbook', 'src/ch1.jpnov');
  await writeUnder(ws.dir, 'src/ch1.jpnov', 'いぬ');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifacts);
  assert.ok(result.artifacts.some((a) => a.path === `${ws.uri}/dist/src/volume1.txt`));
});

test('discovery skips dot-folders, node_modules, and the resolved outDir', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1/index.jpbook', 'vol1/a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'あ');
  await writeUnder(ws.dir, '.hidden/x.jpbook', 'a.jpnov');
  await writeUnder(ws.dir, 'node_modules/pkg/y.jpbook', 'a.jpnov');
  await writeUnder(ws.dir, 'deep/node_modules/z.jpbook', 'a.jpnov');
  await writeUnder(ws.dir, 'dist/w.jpbook', 'a.jpnov');

  const result: ListBooksResult = await handleListBooks(boot().ctx, { projectDirs: projectsFor(ws.uri) });

  assert.equal(result.books.length, 1, 'only the real book is discovered');
  assert.equal(result.books[0]?.fileRel, 'vol1/index.jpbook');
});

test('a non-ASCII outDir (出力) is still excluded from discovery', async () => {
  // The walk compares the outDir in decoded fs-path space, so a non-ASCII name matches
  // regardless of percent-encoding.
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1/index.jpbook', 'vol1/a.jpnov');
  await writeUnder(ws.dir, 'vol1/a.jpnov', 'あ');
  await writeUnder(ws.dir, '出力/old.jpbook', 'a.jpnov');

  const result = await handleBuild(ctx, {
    format: 'txt',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri, { outDir: '出力' }),
  });

  assert.equal(result.ok, true);
  assert.ok(result.artifacts);
  assert.equal(result.artifacts.length, 1, '出力/old.jpbook is not a book');
  assert.ok(result.artifacts.every((a) => a.path.startsWith(`${ws.uri}/`)));
  assert.ok(result.artifacts.some((a) => a.path.endsWith('/vol1.txt')));
});

test("names with # and % (issue #76) list, build, and select — URIs are percent-encoded like the client's", async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, '進捗100%.jpbook', '---\ntitle: 作品名\n---\n第1巻#改稿.jpnov\n50%.jpnov');
  await writeUnder(ws.dir, '第1巻#改稿.jpnov', 'あ');
  await writeUnder(ws.dir, '50%.jpnov', 'い');
  await writeUnder(ws.dir, 'sub#1/index.jpbook', 'sub#1/b(1).jpnov');
  await writeUnder(ws.dir, 'sub#1/b(1).jpnov', 'う');
  const bookUri = `${ws.uri}/%E9%80%B2%E6%8D%97100%25.jpbook`;
  const subUri = `${ws.uri}/sub%231/index.jpbook`;

  const list: ListBooksResult = await handleListBooks(boot().ctx, { projectDirs: projectsFor(ws.uri) });
  assert.deepEqual(list.books.map((b) => [b.uri, b.fileRel, b.title]), [
    [subUri, 'sub#1/index.jpbook', undefined],
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
    [[`${ws.uri}/dist/sub%231.txt`, 'う'], [`${ws.uri}/dist/%E9%80%B2%E6%8D%97100%25.txt`, 'あ\n\nい']],
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

test('an outDir with # (出力#1) receives the artifact and stays excluded from discovery', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', 'a.jpnov');
  await writeUnder(ws.dir, 'a.jpnov', 'あ');
  await writeUnder(ws.dir, '出力#1/old.jpbook', 'a.jpnov');

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
  await writeUnder(ws.dir, '第1巻#改稿.jpbook', 'x#y.jpnov');
  await writeUnder(ws.dir, 'good.jpbook', 'good.jpnov');
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

test('one batch build renders a DIFFERENT header per volume, each from its own front matter', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', '---\nheader: 作品名　一\n---\nch/a.jpnov');
  await writeUnder(ws.dir, 'vol2.jpbook', '---\nheader: 作品名　二\nfooterAlign: none\n---\nch/b.jpnov');
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
  assert.ok(vol1.content.includes('<div class="hd">作品名　一</div>'), 'vol1 carries its own header');
  assert.ok(vol2.content.includes('<div class="hd">作品名　二</div>'), 'vol2 carries its own header');
  assert.ok(!vol1.content.includes('作品名　二'), 'no cross-contamination');
  // The settings snapshot carries no furniture: vol1 gets the default footer, vol2 opted out.
  assert.match(vol1.content, /<div class="ft [rl]">/);
  assert.ok(!/<div class="ft [rl]">/.test(vol2.content), 'footerAlign: none suppresses the footer');
});

test('front matter never leaks into the artifacts: body starts at the first chapter', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', '---\ntitle: 題\nheader: 柱\n---\na.jpnov');
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

test('a book whose front matter has warnings (unknown key) still builds', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', '---\npublisher: 誰か\nheader: 柱\n---\na.jpnov');
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
  await writeUnder(
    ws.dir,
    'vol1/index.jpbook',
    '---\ntitle: 試験本\nauthor: 誰か\n---\nvol1/a.jpnov\nvol1/b.jpnov',
  );
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
  assert.equal(epub.path, `${ws.uri}/dist/vol1.epub`);
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

test('results never carry a legacy epubs key; epub rides the collision check too', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'volume01/index.jpbook', 'volume01/a.jpnov');
  await writeUnder(ws.dir, 'volume01/a.jpnov', 'A');
  await writeUnder(ws.dir, 'volume01.jpbook', 'volume01/a.jpnov');

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
  assert.equal(result.ok, false);
  assert.ok(!('epubs' in result), 'epub builds share the same result shape');
  // Nothing was emitted, so no dir qualifies as a reveal target either.
  assert.deepEqual(result.outDirs, []);
  assert.deepEqual(result.artifacts, []);
  assert.ok(result.errors.every((e) => e.code === 'build.outPathCollision'));
});

// --- cover pages -------------------------------------------------------------

/** A book with a two-entry cover list, a template cover, and a two-page (three-sheet) body. */
async function writeCoverFixture(dir: string): Promise<void> {
  await writeUnder(dir, 'vol1.jpbook', [
    '---',
    'title: 作品名',
    'author: ペンネーム',
    'header: 柱',
    'cover:',
    '  - src/cover.jpnov',
    '  - src/arasuji.jpnov',
    '---',
    'src/a.jpnov',
  ].join('\n'));
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
  assert.match(sheets[2] ?? '', /<div class="hd">柱<\/div><div class="ft r">1 \/ 2<\/div>/);
});

test('build: the header and footer take the value annotations, filled per page', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', [
    '---',
    'title: 作品名',
    'author: ペンネーム',
    'header: ［＃ここに「タイトル」の値を表示］',
    'footer: ［＃ここに「ペンネーム」の値を表示］　［＃ここに「ページ番号」の値を表示］',
    '---',
    'a.jpnov',
  ].join('\n'));
  await writeUnder(ws.dir, 'a.jpnov', '本文。');

  const html = (await handleBuild(ctx, {
    format: 'html',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  })).artifacts[0];
  assert.ok(html?.kind === 'html');
  assert.match(html.content, /<div class="hd">作品名<\/div><div class="ft r">ペンネーム　1<\/div>/);
});

test('build: a title-less book falls back to the outRel STEM, exactly like the EPUB title', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx } = boot();
  // Nested on purpose: outRel is `part1/vol2` but its stem is `vol2`, so the two differ.
  await writeUnder(ws.dir, 'part1/vol2.jpbook', '---\ncover:\n- c.jpnov\n---\na.jpnov');
  await writeUnder(ws.dir, 'c.jpnov', '［＃ここに「タイトル」の値を表示］／［＃ここに「ペンネーム」の値を表示］');
  await writeUnder(ws.dir, 'a.jpnov', '本文。');

  const html = (await handleBuild(ctx, {
    format: 'html',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  })).artifacts[0];
  assert.ok(html?.kind === 'html');
  // The stem alone, and an absent author contributes nothing after the separator.
  assert.match(html.content, /<div class="line" data-line="0">vol2／<\/div>/);
  assert.doesNotMatch(html.content, /part1\/vol2/);

  // …and the EPUB's dc:title agrees, which is why the two share one expression.
  const epub = (await handleBuild(ctx, {
    format: 'epub',
    settings: SETTINGS,
    projectDirs: projectsFor(ws.uri),
  })).artifacts[0];
  assert.ok(epub?.kind === 'epub');
  const opf = epub.members.find((m) => m.name === 'OEBPS/package.opf')?.content ?? '';
  assert.match(opf, /<dc:title>vol2<\/dc:title>/);
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
  const plain = '---\ntitle: t\n---\nsrc/a.jpnov';
  const covered = '---\ntitle: t\ncover:\n  - src/cover.jpnov\n---\nsrc/a.jpnov';

  assert.equal(await build(covered, 'txt'), await build(plain, 'txt'));
  assert.equal(await build(covered, 'epub'), await build(plain, 'epub'));
});

test('build: a missing cover file fails ONLY the html build; txt still succeeds', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1.jpbook', '---\ncover:\n  - src/gone.jpnov\n---\nsrc/a.jpnov');
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
  await writeUnder(ws.dir, 'vol1.jpbook', [
    '---',
    'cover:',
    '  - src/c.jpnov',
    '  - src/c.jpnov', // duplicate — warned, built once
    'cover:',
    '  - src/second.jpnov', // muted by the duplicate key — never built
    '---',
    'src/a.jpnov',
  ].join('\n'));
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
  await writeUnder(ws.dir, 'vol1.jpbook', '---\ncover:\n  - src/gone-cover.jpnov\n---\nsrc/gone-chapter.jpnov');

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

test('build: CRLF chapters — the txt keeps CRLF, the html equals the LF build', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1.jpbook', 'src/a.jpnov\nsrc/b.jpnov');
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
  await writeUnder(ws.dir, 'vol1.jpbook', sjis('---\ntitle: 作品名\n---\nsrc/a.jpnov\n'));
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
  await writeUnder(ws.dir, 'vol1.jpbook', 'src/a.jpnov');
  await writeUnder(ws.dir, 'src/a.jpnov', sjis(CHAPTER));

  const result: BuildResult = await handleBuild(boot().ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri) });
  assert.equal(result.ok, true);
  const artifact = result.artifacts[0];
  assert.ok(artifact?.kind === 'txt');
  assert.ok(artifact.content.includes('\uFFFD'));
});

const READ_FAILURES: readonly [ReadTextFailure, MsgCode, readonly string[]][] = [
  ['notFound', 'book.entryFileNotFound', ['bad/x.jpnov']],
  ['notText', 'book.entryNotText', ['bad/x.jpnov']],
  ['other', 'book.entryReadFailed', ['bad/x.jpnov', 'EACCES: permission denied']],
];

for (const [reason, code, args] of READ_FAILURES) {
  test(`build: a "${reason}" read failure is that book's ${code}; the other book still builds`, async () => {
    await using ws = await makeTmpWorkspace();
    const ctx = makeContext(makeFakeConnection(), failing('bad/x.jpnov', reason));
    await writeUnder(ws.dir, 'bad/index.jpbook', 'bad/x.jpnov');
    await writeUnder(ws.dir, 'bad/x.jpnov', 'あ');
    await writeUnder(ws.dir, 'good/index.jpbook', 'good/y.jpnov');
    await writeUnder(ws.dir, 'good/y.jpnov', 'い');

    const result: BuildResult = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri) });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((e) => [e.uri, e.code, e.args]), [[`${ws.uri}/bad/index.jpbook`, code, args]]);
    assert.deepEqual(result.artifacts.map((a) => a.path), [`${ws.uri}/dist/good.txt`]);
  });
}

/** A `.jpbook` Error line refuses the book whatever the format; each row's manifest is `bad/index.jpbook`. */
const SYNTAX_FAILURES: readonly {
  readonly name: string;
  readonly manifest: string;
  /** Files to create (an Error line fails even when its file exists). */
  readonly files: readonly string[];
  readonly format: BuildFormat;
  readonly code: MsgCode;
  readonly args: readonly string[];
  /** Diagnostics published on the manifest: line errors plus fs verdicts on the ok lines. */
  readonly diagnostics: number;
}[] = [
  {
    name: 'a lone fence',
    manifest: '---',
    files: [],
    format: 'txt',
    code: 'jpbook.metaUnterminated',
    args: [],
    diagnostics: 1,
  },
  {
    name: 'a backslash separator',
    manifest: 'bad\\第一章.jpnov',
    files: ['bad/第一章.jpnov'],
    format: 'epub',
    code: 'jpbook.backslashSeparator',
    args: ['bad\\第一章.jpnov'],
    diagnostics: 1,
  },
  {
    name: 'a non-.jpnov entry after a valid chapter (CRLF manifest)',
    manifest: 'bad/第一章.jpnov\r\nbad/第二章.txt\r\n',
    files: ['bad/第一章.jpnov', 'bad/第二章.txt'],
    format: 'txt',
    code: 'jpbook.notJpnov',
    args: ['bad/第二章.txt'],
    diagnostics: 1,
  },
  {
    name: 'a cover-item error under a txt build',
    manifest: '---\ncover:\n  - bad/表紙.txt\n---\nbad/第一章.jpnov',
    files: ['bad/表紙.txt', 'bad/第一章.jpnov'],
    format: 'txt',
    code: 'jpbook.notJpnov',
    args: ['- bad/表紙.txt'],
    diagnostics: 1,
  },
  {
    // Reported over the missing chapter, which still gets its diagnostic.
    name: 'a syntax error beside a missing chapter',
    manifest: 'bad/第一章.jpnov\nbad/第二章.txt',
    files: [],
    format: 'html',
    code: 'jpbook.notJpnov',
    args: ['bad/第二章.txt'],
    diagnostics: 2,
  },
];

for (const row of SYNTAX_FAILURES) {
  test(`build: ${row.name} is that book's error and emits nothing`, async () => {
    await using ws = await makeTmpWorkspace();
    const { ctx, conn } = boot();
    await writeUnder(ws.dir, 'bad/index.jpbook', row.manifest);
    for (const rel of row.files) {
      await writeUnder(ws.dir, rel, 'あ');
    }

    const result: BuildResult = await handleBuild(ctx, { format: row.format, settings: SETTINGS, projectDirs: projectsFor(ws.uri) });
    const badUri = `${ws.uri}/bad/index.jpbook`;
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((e) => [e.uri, e.code, e.args]), [[badUri, row.code, row.args]]);
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(conn.diagnostics, [{ uri: badUri, count: row.diagnostics }]);
  });
}

test('build: an Error line fails the book before any chapter is read; the other book still builds', async () => {
  await using ws = await makeTmpWorkspace();
  const conn = makeFakeConnection();
  const reads: string[] = [];
  const disk = nodeReader();
  const ctx = makeContext(conn, (uri, token) => {
    reads.push(uri.slice(ws.uri.length + 1));
    return disk(uri, token);
  });
  await writeUnder(ws.dir, 'bad/index.jpbook', '---\ntitle: 作品名\nbad/a.jpnov\nbad/b.jpnov');
  await writeUnder(ws.dir, 'bad/a.jpnov', 'あ');
  await writeUnder(ws.dir, 'bad/b.jpnov', 'い');
  await writeUnder(ws.dir, 'good/index.jpbook', 'good/y.jpnov');
  await writeUnder(ws.dir, 'good/y.jpnov', 'う');

  const result: BuildResult = await handleBuild(ctx, { format: 'txt', settings: SETTINGS, projectDirs: projectsFor(ws.uri) });
  const badUri = `${ws.uri}/bad/index.jpbook`;
  assert.deepEqual(reads, ['bad/index.jpbook', 'good/index.jpbook', 'good/y.jpnov']); // no bad chapter
  assert.deepEqual(
    result.errors.map((e) => [e.book, e.uri, e.code, e.args]),
    [['bad/index.jpbook', badUri, 'jpbook.metaUnterminated', []]], // the fence, not the swallowed lines
  );
  assert.deepEqual(result.artifacts.map((a) => a.path), [`${ws.uri}/dist/good.txt`]);
  // bad: the fence + two swallowed chapter lines; good: none.
  assert.deepEqual(conn.diagnostics, [{ uri: badUri, count: 3 }, { uri: `${ws.uri}/good/index.jpbook`, count: 0 }]);
});

test('build: duplicate-key, bad-enum and duplicate-chapter warnings stay non-fatal', async () => {
  await using ws = await makeTmpWorkspace();
  const { ctx, conn } = boot();
  await writeUnder(ws.dir, 'vol1.jpbook', '---\ntitle: 作品名\ntitle: 作品名\nfooterAlign: どこか\n---\nsrc/a.jpnov\nsrc/a.jpnov');
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
  await writeUnder(ws.dir, 'vol1.jpbook', 'src/a.jpnov');
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
  await writeUnder(ws.dir, 'vol1.jpbook', '---\ntitle: 作品名\n---\nsrc/a.jpnov');
  const ctx = makeContext(makeFakeConnection(), failing('vol1.jpbook', 'other'));

  const result: ListBooksResult = await handleListBooks(ctx, { projectDirs: projectsFor(ws.uri) });
  assert.deepEqual(result.books.map((b) => [b.fileRel, b.outRel, b.title]), [['vol1.jpbook', 'vol1', undefined]]);
});

test('build: the request token rides every readText call', async () => {
  await using ws = await makeTmpWorkspace();
  await writeUnder(ws.dir, 'vol1.jpbook', 'src/a.jpnov\nsrc/b.jpnov');
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
