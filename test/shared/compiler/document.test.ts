import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BuildChrome } from '../../../src/shared/compiler/chrome.ts';
import { chapterGlue, concatBookText, MANUSCRIPT_SHEET, renderBook, type BookInput } from '../../../src/shared/compiler/document.ts';
import { FOOTER_BAND, HEADER_BAND, SIDE_PAD } from '../../../src/shared/compiler/geometry.ts';
import { indentAnnotation } from '../../../src/shared/compiler/tokenizer.ts';

// Band totals come from the tunable geometry constants — never write them out as literals.
const HTOP_RE = new RegExp(String.raw`:root\{[^}]*--htop:` + String(HEADER_BAND) + '[;}]');
const FOOTER_PAD_RE = new RegExp(
  String.raw`\.page\{[^}]*padding:calc\(var\(--htop\)\*1em\) ` + String(SIDE_PAD) + 'em ' + String(FOOTER_BAND) + 'em ' + String(SIDE_PAD) + 'em',
);

const book = (over: Pick<BookInput, 'files' | 'divider'>): BookInput => ({ ...over });

/** All-off chrome: renderBook emits the bare page/line skeleton with no furniture. */
const OFF: BuildChrome = {
  lineNumbers: false,
  edgeLine: 'none',
  footerAlign: 'none',
  footer: '［＃ここに「ページ番号」の値を表示］ / ［＃ここに「総ページ数」の値を表示］',
  header: '',
};

/** Render one file with explicit resolved options; returns the full HTML document. */
const render = (
  src: string,
  opts: { charsPerLine?: number; linesPerPage?: number; chrome?: Partial<BuildChrome> } = {},
): string =>
  renderBook({
    books: [book({ files: [{ name: 'a.jpnov', src }] })],
    charsPerLine: opts.charsPerLine ?? 40,
    linesPerPage: opts.linesPerPage ?? 34,
    linePitch: 2,
    kinsoku: 'none',
    autoTcy: 'none',
    dash: 'horizontalBar',
    paperSize: 'a4',
    paperOrientation: 'auto',
    fontFamily: '',
    chrome: { ...OFF, ...opts.chrome },
  });

/** Body content after the leading 印刷 button (the button itself has its own test below). */
const bodyOf = (html: string): string => {
  const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
  assert.match(body, /^<button class="print" /);
  return body.slice(body.indexOf('</button>') + '</button>'.length);
};

test('renderBook emits a paginated page/line skeleton document', () => {
  const html = render('本文');
  assert.match(html, /^<!DOCTYPE html><html lang="ja"><head>/);
  assert.match(html, /<style>[^<]*\.page\{/);
  assert.equal(
    bodyOf(html),
    '<div class="book"><div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">本文</div></div></div></div>',
  );
});

test('every build document opens with exactly one print button, removed under @media print', () => {
  const html = render('本文');
  const button = '<button class="print" type="button" onclick="window.print()">印刷／PDF 保存</button>';
  // First thing in <body> (the document's only tab stop), and exactly once.
  assert.equal(html.indexOf(button), html.indexOf('<body>') + '<body>'.length);
  assert.equal(html.lastIndexOf(button), html.indexOf(button));
  // Never on the paper: the stylesheet must carry the print-media removal.
  assert.match(html, /@media print\{\.print\{display:none;\}\}/);
});

test('the head carries the ?p=1 auto-print hook (reachable by browser-internal navigation only)', () => {
  const html = render('本文');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /<script>if\(new URLSearchParams\(location\.search\)\.get\('p'\)==='1'\)/);
  assert.match(head, /window\.print\(\)/);
});

test('a right-side 傍点 emits the --emr-shift probe script; otherwise no probe at all', () => {
  const emph = render('語［＃「語」に傍点］');
  assert.match(emph, /<script>[^]*--emr-shift[^]*<\/script><\/body>/);
  assert.doesNotMatch(render('語［＃「語」の左に傍点］'), /--emr-shift/);
  assert.doesNotMatch(render('語［＃「語」に傍線］'), /--emr-shift/);
});

test('renderBook joins files[] in order with one blank separator line', () => {
  const html = renderBook({
    books: [
      book({
        files: [
          { name: 'a.jpnov', src: '第一' },
          { name: 'b.jpnov', src: '第二' },
        ],
      }),
    ],
    charsPerLine: 40,
    linesPerPage: 34,
    linePitch: 2,
    kinsoku: 'none',
    autoTcy: 'none',
    dash: 'horizontalBar',
    paperSize: 'a4',
    paperOrientation: 'auto',
    fontFamily: '',
    chrome: OFF,
  });
  // The glue's blank column is synthetic (srcLine −1): no data-line anchor.
  assert.equal(
    bodyOf(html),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">第一</div>' +
      '<div class="line"></div>' +
      '<div class="line" data-line="0">第二</div></div></div></div>',
  );
});

test('renderBook keeps a broken ［＃ as visible literal text (build stays lenient)', () => {
  assert.equal(
    bodyOf(render('本文［＃こわれ')),
    '<div class="book"><div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">本文［＃こわれ</div></div></div></div>',
  );
});

test('renderBook: ［＃改ページ］ starts a new page', () => {
  assert.equal(
    bodyOf(render('前\n［＃改ページ］\n後')),
    '<div class="book">' +
      '<div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">前</div></div></div>' +
      '<div class="page" data-page="1"><div class="grid"><div class="line" data-line="2">後</div></div></div></div>',
  );
});

test('renderBook paginates at linesPerPage lines per page', () => {
  assert.equal(
    bodyOf(render('一\n二\n三', { linesPerPage: 2 })),
    '<div class="book">' +
      '<div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">一</div><div class="line" data-line="1">二</div></div></div>' +
      '<div class="page" data-page="1"><div class="grid"><div class="line" data-line="2">三</div></div></div></div>',
  );
});

test('renderBook wraps a long source line at charsPerLine', () => {
  assert.equal(
    bodyOf(render('一二三四五', { charsPerLine: 2 })),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">一二</div>' +
      '<div class="line" data-line="0">三四</div>' +
      '<div class="line" data-line="0">五</div></div></div></div>',
  );
});

test('renderBook renders ruby + emphasis inside the page lines', () => {
  const html = render('漢字《かんじ》と語［＃「語」に傍点］');
  assert.match(html, /<ruby class="rr"><span>漢<\/span><span>字<\/span><rt><span><span>か<\/span><span>ん<\/span><span>じ<\/span><\/span><\/rt><\/ruby>/);
  assert.match(html, /<span class="emph-fs">語<\/span>/);
  // On-demand: the used classes' rules are present inside the stylesheet.
  assert.match(html, /\.emph-fs\{text-emphasis-style:filled sesame\}/);
  assert.match(html, /ruby\.rr>rt>span\{transform:translate\(-50%,-50%\) translateX\(1\.5em\)\}/);
});

test('concatBookText strips one trailing newline per file and joins with one blank line', () => {
  // no trailing newline: exactly one blank separator line between files
  assert.equal(
    concatBookText(book({ files: [{ name: 'a.jpnov', src: 'あいう' }, { name: 'b.jpnov', src: 'かきく' }] }), 'none', 40),
    'あいう\n\nかきく',
  );
  // one trailing newline per file: the artifact is stripped, never doubling the seam
  assert.equal(
    concatBookText(book({ files: [{ name: 'a.jpnov', src: 'あ\n' }, { name: 'b.jpnov', src: 'か\n' }] }), 'none', 40),
    'あ\n\nか',
  );
  // a genuine author blank line (\n\n) is preserved LITERALLY and stacks with the glue
  assert.equal(
    concatBookText(book({ files: [{ name: 'a.jpnov', src: 'あ\n\n' }, { name: 'b.jpnov', src: 'か' }] }), 'none', 40),
    'あ\n\n\nか',
  );
  // CRLF trailing is stripped as one EOL too
  assert.equal(concatBookText(book({ files: [{ name: 'a.jpnov', src: 'あ\r\n' }] }), 'none', 40), 'あ');
  // empty book -> ""
  assert.equal(concatBookText(book({ files: [] }), 'none', 40), '');
});

test('concatBookText follows the manuscript EOL: CRLF throughout when any chapter is CRLF', () => {
  const files = (a: string, b: string, divider?: string): BookInput =>
    book({ files: [{ name: 'a.jpnov', src: a }, { name: 'b.jpnov', src: b }], divider });
  // seam and divider line included
  assert.equal(concatBookText(files('あいう\r\n', 'かきく\r\n'), 'none', 40), 'あいう\r\n\r\nかきく');
  assert.equal(
    concatBookText(files('あ\r\n', 'か\r\n', '＊'), 'none', 8),
    'あ\r\n\r\n［＃３字下げ］＊\r\n\r\nか',
  );
  // any CRLF chapter decides; an all-LF book stays LF
  assert.equal(concatBookText(files('あ\r\n', 'か\n'), 'none', 40), 'あ\r\n\r\nか');
  assert.equal(concatBookText(files('あ\n', 'か\n'), 'none', 40), 'あ\n\nか');
});

test('renderBook: a CRLF chapter paginates exactly like its LF twin', () => {
  const lf = 'あいう\n［＃ここから２字下げ］\nあ\n［＃ここで字下げ終わり］\n［＃縦中横］12\n［＃改ページ］\nか\n';
  assert.equal(render(lf.replaceAll('\n', '\r\n'), { charsPerLine: 3 }), render(lf, { charsPerLine: 3 }));
});

// --- chapter divider (章区切り) --------------------------------------------------------

const two = (a: string, b: string, divider?: string): BookInput =>
  book({ files: [{ name: 'a.jpnov', src: a }, { name: 'b.jpnov', src: b }], divider });

test('chapterGlue: one blank line always; divider centred by CELLS + one blank after', () => {
  assert.equal(chapterGlue('前章', '次章', '', 40), '\n');
  // ＊ = 1 cell at cpl 8 → floor((8−1)/2) = 3, spelled as the Aozora annotation.
  assert.equal(chapterGlue('前章', '次章', '＊', 8), '\n［＃３字下げ］＊\n\n');
  // A 縦中横 mark is ONE cell however many chars it combines (cells ≠ chars).
  assert.equal(
    chapterGlue('前章', '次章', '!?［＃「!?」は縦中横］', 9),
    '\n［＃４字下げ］!?［＃「!?」は縦中横］\n\n',
  );
  // A value already ［＃○字下げ］-prefixed passes through verbatim (author's own position).
  assert.equal(chapterGlue('前章', '次章', '［＃２字下げ］＊', 40), '\n［＃２字下げ］＊\n\n');
  // A mark as wide as the line centres to 0 → bare, no ［＃０字下げ］ noise, never negative.
  assert.equal(chapterGlue('前章', '次章', '＊　＊　＊', 3), '\n＊　＊　＊\n\n');
});

test('chapterGlue suppression: a 見出し-opening next chapter takes the plain blank seam', () => {
  assert.equal(chapterGlue('前章', '第二章［＃「第二章」は大見出し］\n本文', '＊', 8), '\n');
  // Leading blank lines are skipped when probing for the heading.
  assert.equal(chapterGlue('前章', '\n\n二［＃「二」は中見出し］', '＊', 8), '\n');
  // A broken-target 見出し renders plain, so it does NOT suppress the divider.
  assert.equal(chapterGlue('前章', '二［＃「別」は中見出し］', '＊', 8), '\n［＃３字下げ］＊\n\n');
});

test('chapterGlue suppression covers the 見出し span/block openers too', () => {
  // Block form: the first non-blank line paints nothing — the opener token decides.
  assert.equal(
    chapterGlue('前章', '［＃ここから大見出し］\n第二章\n［＃ここで大見出し終わり］', '＊', 8),
    '\n',
  );
  // Inline pair on the first line resolves through the normal heading-row probe.
  assert.equal(chapterGlue('前章', '［＃大見出し］第二章［＃大見出し終わり］\n本文', '＊', 8), '\n');
  // A lone inline opener line (the title follows on the next line) suppresses too.
  assert.equal(chapterGlue('前章', '［＃大見出し］\n第二章\n［＃大見出し終わり］', '＊', 8), '\n');
  // A non-見出し directive first line still takes the divider (first painted line is prose).
  assert.equal(
    chapterGlue('前章', '［＃ここから２字下げ］\n本文', '＊', 8),
    '\n［＃３字下げ］＊\n\n',
  );
});

test('chapterGlue suppression at ［＃改ページ］ junctions keeps the blank line', () => {
  assert.equal(chapterGlue('あ\n［＃改ページ］', 'か', '＊', 8), '\n'); // prev ends on a break
  assert.equal(chapterGlue('あ', '［＃改ページ］\nか', '＊', 8), '\n'); // next opens on a break
  assert.equal(chapterGlue('あ', 'か', '＊', 8), '\n［＃３字下げ］＊\n\n'); // no break → divider
});

test('chapterGlue: charsPerLine null = the bare mark at the line head; an author 字下げ stays', () => {
  assert.equal(chapterGlue('前章', '次章', '＊', null), '\n＊\n\n');
  assert.equal(chapterGlue('前章', '次章', '［＃２字下げ］＊', null), '\n［＃２字下げ］＊\n\n');
  // The suppression rules read the sources alone, so they apply either way.
  assert.equal(chapterGlue('前章', '第二章［＃「第二章」は大見出し］\n本文', '＊', null), '\n');
  assert.equal(chapterGlue('前章', '次章', '', null), '\n');
});

test('concatBookText interleaves the divider; author edge blanks stack literally', () => {
  assert.equal(concatBookText(two('あ', 'か', '＊'), 'none', 8), 'あ\n\n［＃３字下げ］＊\n\nか');
  assert.equal(
    concatBookText(two('あ\n\n', '\nか', '＊'), 'none', 8),
    'あ\n\n\n［＃３字下げ］＊\n\n\nか', // one author blank each side, kept verbatim around the glue
  );
  assert.equal(
    concatBookText(two('あ', '第二章［＃「第二章」は大見出し］\n本文', '＊'), 'none', 8),
    'あ\n\n第二章［＃「第二章」は大見出し］\n本文',
  );
});

/** Chapters that leave a span open, with the exact `.txt` each concatenates to (cpl 8: a ＊ divider
 *  centres as ［＃３字下げ］＊). The dual-invariant test re-renders every one of these. */
const SEAM_CASES: readonly [book: BookInput, txt: string][] = [
  [two('［＃太字］一', '二'), '［＃太字］一\n［＃ここで太字終わり］\n\n二'],
  [
    two('［＃ここから２字下げ］\n一', '二', '＊'),
    '［＃ここから２字下げ］\n一\n［＃ここで字下げ終わり］\n\n［＃３字下げ］＊\n\n二', // closer line, blank, divider
  ],
  [two('［＃傍点］一', '二', '＊'), '［＃傍点］一\n［＃傍点終わり］\n［＃３字下げ］＊\n\n二'],
  [two('［＃大見出し］一', '二'), '［＃大見出し］一\n［＃ここで大見出し終わり］\n\n二'],
  [two('［＃ここから大見出し］\n一', '二'), '［＃ここから大見出し］\n一\n［＃ここで大見出し終わり］\n\n二'],
  [
    // All six channels: the ここで line, then the inline remainder on the blank line.
    two('［＃ここから２字下げ］\n［＃ここから太字］\n［＃ここから斜体］\n［＃ここから中見出し］\n［＃左に傍点］［＃傍線］一', '二'),
    '［＃ここから２字下げ］\n［＃ここから太字］\n［＃ここから斜体］\n［＃ここから中見出し］\n［＃左に傍点］［＃傍線］一\n' +
      '［＃ここで字下げ終わり］［＃ここで太字終わり］［＃ここで斜体終わり］［＃ここで中見出し終わり］\n［＃左に傍点終わり］［＃傍線終わり］\n二',
  ],
  [two('［＃太字］一\n\n', '二'), '［＃太字］一\n\n［＃ここで太字終わり］\n\n二'], // the author's blank stays first
  [two('［＃太字］一\n［＃改ページ］', '二', '＊'), '［＃太字］一\n［＃改ページ］\n［＃ここで太字終わり］\n\n二'], // divider suppressed
  [
    two('［＃傍点］一', '第二章［＃「第二章」は大見出し］\n本文', '＊'),
    '［＃傍点］一\n［＃傍点終わり］\n第二章［＃「第二章」は大見出し］\n本文',
  ],
  [two('［＃太字］第［＃縦中横］12', '二'), '［＃太字］第［＃縦中横］12\n［＃ここで太字終わり］\n\n二'], // the cell flushes bold first
  [two('［＃傍点］一［＃白ゴマ傍点］二', '三'), '［＃傍点］一［＃白ゴマ傍点］二\n［＃白ゴマ傍点終わり］\n三'], // the surviving variant
  [two('［＃ここから太字］', '二'), '［＃ここから太字］\n［＃ここで太字終わり］\n\n二'],
  [two('［＃太字］一［＃太字終わり］', '二'), '［＃太字］一［＃太字終わり］\n\n二'], // closed: untouched
  [two('［＃太字］一\r\n', '二\r\n'), '［＃太字］一\r\n［＃ここで太字終わり］\r\n\r\n二'],
  [
    book({ files: [{ name: 'a.jpnov', src: '［＃太字］一' }, { name: 'b.jpnov', src: '二' }, { name: 'c.jpnov', src: '［＃斜体］三' }] }),
    '［＃太字］一\n［＃ここで太字終わり］\n\n二\n\n［＃斜体］三', // the last chapter ends the book, not a seam
  ],
];

test('concatBookText closes the spans a chapter leaves open at the seam (txt follows HTML)', () => {
  for (const [b, txt] of SEAM_CASES) {
    assert.equal(concatBookText(b, 'none', 8), txt);
  }
});

test('renderBook inserts the divider line + one blank as synthetic (anchor-less) rows', () => {
  const html = renderBook({
    books: [two('第一', '第二', '＊')],
    charsPerLine: 4,
    linesPerPage: 34,
    linePitch: 2,
    kinsoku: 'none',
    autoTcy: 'none',
    dash: 'horizontalBar',
    paperSize: 'a4',
    paperOrientation: 'auto',
    fontFamily: '',
    chrome: OFF,
  });
  // cpl 4 → the centring annotation is ［＃１字下げ］: the glue line carries indent-1.
  assert.equal(
    bodyOf(html),
    '<div class="book"><div class="page" data-page="0"><div class="grid">' +
      '<div class="line" data-line="0">第一</div>' +
      '<div class="line"></div>' +
      '<div class="line indent-1">＊</div>' +
      '<div class="line"></div>' +
      '<div class="line" data-line="0">第二</div></div></div></div>',
  );
  assert.match(html, /\.indent-1\{padding-inline-start:1em\}/); // its rule emits on demand
});

test('dual invariant: per-file render + glue == rendering the concatenated .txt', () => {
  const opts = {
    charsPerLine: 8,
    linesPerPage: 5,
    linePitch: 2,
    kinsoku: 'none',
    autoTcy: 'none',
    dash: 'horizontalBar',
    paperSize: 'a4',
    paperOrientation: 'auto',
    fontFamily: '',
    chrome: OFF,
  } as const;
  const matrix: BookInput[] = [
    two('あ\n\nい', 'か', '＊'), // divider + author blanks
    two('あ', '第二章［＃「第二章」は大見出し］\n本文', '＊'), // heading suppression
    two('あ\n［＃改ページ］', '\nか', '＊'), // page-break suppression
    two('あ', 'か'), // no divider configured
    two('あ', 'か', '［＃３字下げ］◇'), // indented divider
    two('あ\r\n\r\nい\r\n', 'か\r\n', '＊'), // CRLF chapters
    ...SEAM_CASES.map(([b]) => b), // spans left open at a seam (closed by concatBookText)
  ];
  const strip = (h: string): string => bodyOf(h).replace(/ data-line="\d+"/g, '');
  for (const b of matrix) {
    const perFile = renderBook({ books: [b], ...opts });
    const combined = renderBook({
      books: [book({ files: [{ name: 'all.jpnov', src: concatBookText(b, 'none', opts.charsPerLine) }] })],
      ...opts,
    });
    // data-line is the only legitimate delta: per-file numbering restarts (and glue rows have
    // no anchor at all) while the combined source numbers continuously.
    assert.equal(strip(perFile), strip(combined));
  }
});

test('renderBook: a 太字 span emits <span class="b"> and the .b rule on demand', () => {
  const out = render('［＃太字］強［＃太字終わり］');
  assert.match(out, /<span class="b">強<\/span>/);
  assert.match(out, /\.b\{font-weight:bold\}/);
});

test('renderBook: a 字下げ column carries the indent class + its .indent-N rule', () => {
  const out = render('［＃２字下げ］頭');
  assert.match(out, /<div class="line indent-2" data-line="0">頭<\/div>/);
  assert.match(out, /\.indent-2\{padding-inline-start:2em\}/);
});

// --- page furniture (chrome) ---------------------------------------------------------

/** Three one-line pages: display pages 1, 2, 3. */
const THREE_PAGES = '一\n二\n三';

test('footer parity: rightLeft puts odd pages bottom-right, even bottom-left', () => {
  const body = bodyOf(
    render(THREE_PAGES, {
      linesPerPage: 1,
      chrome: { footerAlign: 'rightLeft' },
    }),
  );
  assert.match(body, /data-page="0">[^]*?<div class="ft r">1 \/ 3<\/div>/);
  assert.match(body, /data-page="1">[^]*?<div class="ft l">2 \/ 3<\/div>/);
  assert.match(body, /data-page="2">[^]*?<div class="ft r">3 \/ 3<\/div>/);
  // Furniture comes AFTER the lines, so line adjacency is untouched.
  assert.match(body, /<div class="line" data-line="0">一<\/div><\/div><div class="ft r">/);
});

test('footer positions: all five enum values place (or omit) the number correctly', () => {
  const sides = (pos: BuildChrome['footerAlign']): (string | null)[] => {
    const body = bodyOf(
      render('一\n二', { linesPerPage: 1, chrome: { footerAlign: pos } }),
    );
    return [0, 1].map((i) => {
      const m = new RegExp(`data-page="${String(i)}">[^]*?<div class="ft (r|l)">`).exec(body);
      return m?.[1] ?? null;
    });
  };
  assert.deepEqual(sides('rightLeft'), ['r', 'l']);
  assert.deepEqual(sides('leftRight'), ['l', 'r']);
  assert.deepEqual(sides('right'), ['r', 'r']);
  assert.deepEqual(sides('left'), ['l', 'l']);
  assert.deepEqual(sides('none'), [null, null]);
});

test('footer: markup around a value is escaped; a name the page lacks prints as itself', () => {
  const escaped = render('本文', {
    chrome: { footerAlign: 'right', footer: '<b>［＃ここに「ページ番号」の値を表示］</b>' },
  });
  assert.match(escaped, /<div class="ft r">&lt;b&gt;1&lt;\/b&gt;<\/div>/);
  const unknown = render('本文', {
    chrome: { footerAlign: 'right', footer: 'p［＃ここに「ページ番号」の値を表示］/［＃ここに「foo」の値を表示］' },
  });
  assert.match(unknown, /<div class="ft r">p1\/foo<\/div>/);
});

test('footer blank suppression: a blank footer drops the footer, keeps its band', () => {
  for (const footer of ['', '   ']) {
    const html = render('本文', {
      chrome: { footerAlign: 'rightLeft', footer },
    });
    assert.doesNotMatch(html, /class="ft/);
    assert.match(html, FOOTER_PAD_RE); // element goes, band stays reserved
  }
  // A non-blank footer is NOT suppressed; literal spaces are kept as-is.
  const kept = render('本文', {
    chrome: { footerAlign: 'left', footer: ' ［＃ここに「ページ番号」の値を表示］ ' },
  });
  assert.match(kept, /<div class="ft l"> 1 <\/div>/);
});

test('header and footer: タイトル／ペンネーム／ページ番号／総ページ数 fill from the book and the page', () => {
  const body = bodyOf(
    renderBooks(
      [{ files: [{ name: 'a.jpnov', src: '一\n二' }], title: '作品名', author: 'ペンネーム' }],
      {
        linesPerPage: 1,
        chrome: {
          footerAlign: 'right',
          header: '［＃ここに「タイトル」の値を表示］　［＃ここに「ペンネーム」の値を表示］',
          footer: '［＃ここに「ページ番号」の値を表示］／［＃ここに「総ページ数」の値を表示］',
        },
      },
    ),
  );
  const sheets = body.split(/(?=<div class="page)/).slice(1);
  assert.match(sheets[0] ?? '', /<div class="hd">作品名　ペンネーム<\/div><div class="ft r">1／2<\/div>/);
  assert.match(sheets[1] ?? '', /<div class="hd">作品名　ペンネーム<\/div><div class="ft r">2／2<\/div>/);
});

test('header and footer: a book without title and author fills them blank', () => {
  const body = bodyOf(
    render('本文', {
      chrome: {
        footerAlign: 'right',
        header: '［＃ここに「タイトル」の値を表示］',
        footer: '［＃ここに「ペンネーム」の値を表示］',
      },
    }),
  );
  assert.match(body, /<div class="hd"><\/div><div class="ft r"><\/div>/);
});

test('header: centered furniture div, escaped, absent (with its band) when empty', () => {
  const on = render('本文', { chrome: { header: '第一章' } });
  assert.match(on, /<div class="hd">第一章<\/div>/);
  assert.match(on, HTOP_RE);
  const escaped = render('本文', { chrome: { header: 'a<b' } });
  assert.match(escaped, /<div class="hd">a&lt;b<\/div>/);
  const off = render('本文');
  assert.doesNotMatch(off, /class="hd"/);
  // No element, but the band stays reserved — sheet geometry is header-independent.
  assert.match(off, HTOP_RE);
  assert.match(off, /\.page\{[^}]*padding:calc\(var\(--htop\)\*1em\) /);
});

test('line numbers and edge lines never change the body DOM (pure CSS features)', () => {
  const plain = bodyOf(render(THREE_PAGES, { linesPerPage: 2 }));
  const decorated = bodyOf(
    render(THREE_PAGES, { linesPerPage: 2, chrome: { lineNumbers: true, edgeLine: 'text' } }),
  );
  assert.equal(decorated, plain);
});

// --- cover pages (応募用表紙・扉) ---------------------------------------------------

const COVER_SRC = '［＃５字下げ］［＃ここに「タイトル」の値を表示］\n' +
  '［＃７字下げ］［＃ここに「ペンネーム」の値を表示］\n' +
  '［＃７字下げ］全［＃縦中横］［＃ここに「総ページ数」の値を表示］［＃縦中横終わり］ページ';

/** Render `books` with the shared option baseline; `chrome` overrides ride on top. */
const renderBooks = (
  books: readonly BookInput[],
  opts: { linesPerPage?: number; chrome?: Partial<BuildChrome> } = {},
): string =>
  renderBook({
    books,
    charsPerLine: 40,
    linesPerPage: opts.linesPerPage ?? 34,
    linePitch: 2,
    kinsoku: 'none',
    autoTcy: 'none',
    dash: 'horizontalBar',
    paperSize: 'a4',
    paperOrientation: 'auto',
    fontFamily: '',
    chrome: { ...OFF, ...opts.chrome },
  });

const withCover = (
  files: readonly { name: string; src: string }[],
  body: readonly { name: string; src: string }[],
  meta: { title?: string; author?: string } = {},
): BookInput => ({
  files: body,
  title: meta.title ?? '題',
  author: meta.author ?? '著',
  cover: { files },
});

test('cover: front pages precede the body, unnumbered and furniture-free', () => {
  const body = bodyOf(
    renderBooks(
      [withCover([{ name: 'c.jpnov', src: '表紙' }], [{ name: 'a.jpnov', src: '一\n二' }])],
      { linesPerPage: 1, chrome: { footerAlign: 'rightLeft', header: '柱' } },
    ),
  );
  const sheets = body.split(/(?=<div class="page)/).slice(1);
  assert.equal(sheets.length, 3);
  // The cover sheet: its own class, no header, no footer.
  assert.ok(sheets[0]?.startsWith('<div class="page cover" data-page="0">'));
  assert.ok(!sheets[0]?.includes('class="ft') && !sheets[0]?.includes('class="hd'));
  assert.match(sheets[0] ?? '', /<div class="line" data-line="0">表紙<\/div>/);
  // The body still starts at page 1 of 2 — the cover is not counted, and page 1 stays odd.
  assert.match(sheets[1] ?? '', /<div class="hd">柱<\/div><div class="ft r">1 \/ 2<\/div>/);
  assert.match(sheets[2] ?? '', /<div class="hd">柱<\/div><div class="ft l">2 \/ 2<\/div>/);
});

test('cover: each cover file starts a fresh page', () => {
  const body = bodyOf(
    renderBooks([
      withCover(
        [{ name: 'c1.jpnov', src: '表紙' }, { name: 'c2.jpnov', src: 'あらすじ' }],
        [{ name: 'a.jpnov', src: '本文' }],
      ),
    ]),
  );
  const sheets = body.split(/(?=<div class="page)/).slice(1);
  assert.equal(sheets.length, 3);
  assert.match(sheets[0] ?? '', /^<div class="page cover" data-page="0">.*表紙/);
  assert.match(sheets[1] ?? '', /^<div class="page cover" data-page="1">.*あらすじ/);
  assert.match(sheets[2] ?? '', /^<div class="page" data-page="2">.*本文/);
});

test('cover: the template annotations substitute the book values; 総ページ数 == the body count', () => {
  const body = bodyOf(
    renderBooks(
      [
        withCover(
          [{ name: 'c.jpnov', src: COVER_SRC }],
          [{ name: 'a.jpnov', src: '一\n二\n三' }],
          { title: '作品名', author: 'ペンネーム' },
        ),
      ],
      { linesPerPage: 1, chrome: { footerAlign: 'right' } },
    ),
  );
  const bodyPages = (body.match(/<div class="page" data-page=/g) ?? []).length;
  assert.equal(bodyPages, 3);
  assert.match(body, /<div class="line indent-5" data-line="0">作品名<\/div>/);
  assert.match(body, /<div class="line indent-7" data-line="1">ペンネーム<\/div>/);
  // The count is derived, never pinned: it must equal the number of BODY sheets…
  assert.match(
    body,
    new RegExp(`<div class="line indent-7" data-line="2">全<span class="tcy">${String(bodyPages)}</span>ページ</div>`),
  );
  // …which is exactly what the footer's 総ページ数 reports.
  assert.match(body, new RegExp(`<div class="ft r">1 / ${String(bodyPages)}</div>`));
});

test('cover: ページ番号 has no value on a cover page, so the name prints', () => {
  const body = bodyOf(
    renderBooks([
      withCover([{ name: 'c.jpnov', src: '［＃ここに「ページ番号」の値を表示］' }], [{ name: 'a.jpnov', src: '本文' }]),
    ]),
  );
  assert.match(body, /<div class="line" data-line="0">ページ番号<\/div>/);
});

test('cover: a value annotation in the BODY prints its name (body chapters take no values)', () => {
  const body = bodyOf(
    renderBooks([
      withCover(
        [{ name: 'c.jpnov', src: '表紙' }],
        [{ name: 'a.jpnov', src: '［＃ここに「タイトル」の値を表示］' }],
        { title: '実際のタイトル' },
      ),
    ]),
  );
  assert.match(body, /<div class="line" data-line="0">タイトル<\/div>/);
  assert.doesNotMatch(body, /実際のタイトル/);
});

test('cover: covers interleave per book and the footer numbers the bodies continuously', () => {
  const body = bodyOf(
    renderBooks(
      [
        withCover([{ name: 'c1.jpnov', src: '表紙一' }], [{ name: 'a.jpnov', src: '一' }]),
        withCover([{ name: 'c2.jpnov', src: '表紙二' }], [{ name: 'b.jpnov', src: '二' }]),
      ],
      { chrome: { footerAlign: 'right' } },
    ),
  );
  const sheets = body.split(/(?=<div class="page)/).slice(1);
  assert.deepEqual(
    sheets.map((s) => s.slice(0, s.indexOf('>') + 1)),
    [
      '<div class="page cover" data-page="0">',
      '<div class="page" data-page="1">',
      '<div class="page cover" data-page="2">',
      '<div class="page" data-page="3">',
    ],
  );
  assert.match(sheets[1] ?? '', /<div class="ft r">1 \/ 2<\/div>/);
  assert.match(sheets[3] ?? '', /<div class="ft r">2 \/ 2<\/div>/);
});

test('cover: line numbers are exempted in CSS, since the counter matches .page like any sheet', () => {
  // The header and footer are withheld elements; the line number is a counter that
  // `class="page cover"` still matches, so only a rule can withhold it.
  const on = renderBooks(
    [withCover([{ name: 'c.jpnov', src: '表紙' }], [{ name: 'a.jpnov', src: '本文' }])],
    { chrome: { lineNumbers: true } },
  );
  assert.match(on, /\.line::before\{content:counter\(ln\)/);
  assert.match(on, /\.page\.cover \.line::before\{content:none;?\}/);
  // The exemption must come after the painter, or the cascade keeps the number.
  assert.ok(on.indexOf('.page.cover .line::before') > on.indexOf('.line::before{content:counter'));
  // With numbering off, neither rule ships (the fragment is on-demand).
  const off = renderBooks([withCover([{ name: 'c.jpnov', src: '表紙' }], [{ name: 'a.jpnov', src: '本文' }])]);
  assert.doesNotMatch(off, /counter\(ln\)/);
  assert.doesNotMatch(off, /\.page\.cover/);
});

test('cover: the sheet geometry and its reserved bands are cover-independent', () => {
  const opts = { chrome: { footerAlign: 'right' as const, header: '柱' } };
  const body = [{ name: 'a.jpnov', src: '本文' }];
  const covered = renderBooks([withCover([{ name: 'c.jpnov', src: '表紙' }], body)], opts);
  const plain = renderBooks([{ files: body }], opts);
  // The whole stylesheet must be identical — a cover can add no rule and move no band.
  const styleOf = (html: string): string => html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.equal(styleOf(covered), styleOf(plain));
  assert.match(covered, HTOP_RE);
  assert.match(covered, FOOTER_PAD_RE);
  assert.doesNotMatch(covered, /\.cover\{/); // structural class only — no rule of its own
});

test('cover: an empty cover file list renders exactly the cover-less document', () => {
  const files = [{ name: 'a.jpnov', src: '本文' }];
  const plain = renderBooks([{ files }]);
  assert.equal(renderBooks([{ files, title: 't', author: 'a', cover: { files: [] } }]), plain);
  assert.doesNotMatch(plain, /class="page cover"/);
});

test('cover: covers reach the on-demand CSS sink like any other content', () => {
  const html = renderBooks([
    withCover([{ name: 'c.jpnov', src: '本［＃「本」に傍点］' }], [{ name: 'a.jpnov', src: '本文' }]),
  ]);
  assert.match(html, /<style>[^<]*\.emph-fs\{/); // the cover's own class rule is emitted
});

test('cover: a book with covers and no chapters renders the covers, page count 0', () => {
  const body = bodyOf(
    renderBooks([withCover([{ name: 'c.jpnov', src: COVER_SRC }], [], { title: '題', author: '著' })], {
      chrome: { footerAlign: 'right', header: '柱' },
    }),
  );
  const sheets = body.split(/(?=<div class="page)/).slice(1);
  assert.equal(sheets.length, 1);
  assert.ok(sheets[0]?.startsWith('<div class="page cover" data-page="0">'));
  assert.match(body, /全<span class="tcy">0<\/span>ページ/);
  assert.doesNotMatch(body, /class="(pn|hd)/); // no body page exists to carry furniture
});

test('cover: an unset author leaves its column blank, indent and neighbours intact', () => {
  const body = bodyOf(
    renderBooks([
      {
        files: [{ name: 'a.jpnov', src: '本文' }],
        title: '題',
        author: '',
        cover: { files: [{ name: 'c.jpnov', src: COVER_SRC }] },
      },
    ]),
  );
  assert.match(body, /<div class="line indent-5" data-line="0">題<\/div>/);
  assert.match(body, /<div class="line indent-7" data-line="1"><\/div>/); // the author column
  assert.match(body, /<div class="line indent-7" data-line="2">全<span class="tcy">1<\/span>ページ<\/div>/);
});

test('per-book pagination: an empty book adds no blank sheet and never breaks the run', () => {
  // Per-book pagination equals the old joined run because paginate flushes only non-empty
  // pages; an empty middle book is where the two would diverge if it did not.
  const body = bodyOf(
    renderBooks(
      [
        { files: [{ name: 'a.jpnov', src: '一' }] },
        { files: [] },
        { files: [{ name: 'b.jpnov', src: '二' }] },
      ],
      { chrome: { footerAlign: 'right' } },
    ),
  );
  assert.equal(
    body,
    '<div class="book">' +
      '<div class="page" data-page="0"><div class="grid"><div class="line" data-line="0">一</div></div><div class="ft r">1 / 2</div></div>' +
      '<div class="page" data-page="1"><div class="grid"><div class="line" data-line="0">二</div></div><div class="ft r">2 / 2</div></div>' +
      '</div>',
  );
});

test('per-book pagination: a book opening with ［＃改ページ］ still starts one page in', () => {
  const body = bodyOf(
    renderBooks([
      { files: [{ name: 'a.jpnov', src: '一' }] },
      { files: [{ name: 'b.jpnov', src: '［＃改ページ］\n二' }] },
    ]),
  );
  // The leading page break flushes an already-empty page — no blank sheet appears.
  assert.equal((body.match(/class="page[ "]/g) ?? []).length, 2);
  assert.match(body, /data-page="1"><div class="grid"><div class="line" data-line="1">二<\/div>/);
});

test('cover: the footer side follows the BODY page, whatever the cover count', () => {
  // Product ruling: front pages never shift the body's numbering.
  for (const count of [0, 1, 2, 3]) {
    const files = Array.from({ length: count }, (_, i) => ({ name: `c${String(i)}.jpnov`, src: `表紙${String(i)}` }));
    const body = [{ name: 'a.jpnov', src: '一\n二' }];
    const book: BookInput = count === 0
      ? { files: body }
      : { files: body, title: '題', author: '著', cover: { files } };
    const out = bodyOf(renderBooks([book], { linesPerPage: 1, chrome: { footerAlign: 'rightLeft' } }));
    const sheets = out.split(/(?=<div class="page)/).slice(1);
    assert.equal(sheets.length, count + 2, `${String(count)} covers + 2 body pages`);
    assert.match(sheets[count] ?? '', /<div class="ft r">1 \/ 2<\/div>/, `${String(count)} covers: body page 1 stays right`);
    assert.match(sheets[count + 1] ?? '', /<div class="ft l">2 \/ 2<\/div>/, `${String(count)} covers: body page 2 stays left`);
  }
});

// --- 原稿用紙換算枚数 (400字詰め sheet count) -----------------------------------------

const SHEETS_SRC = '［＃ここに「原稿用紙換算枚数」の値を表示］枚';
/** Both counts on one cover: line 0 = 総ページ数, line 1 = 原稿用紙換算枚数. */
const COUNTS_SRC = `［＃ここに「総ページ数」の値を表示］ページ\n${SHEETS_SRC}`;

/** `n` lines of `text`, newline-joined. */
const repeat = (n: number, text: string): string => Array.from({ length: n }, () => text).join('\n');

/** A book with the COUNTS_SRC cover in front of `files`. */
const counted = (files: readonly { name: string; src: string }[], divider?: string): BookInput => ({
  files,
  divider,
  title: '題',
  author: '著',
  cover: { files: [{ name: 'c.jpnov', src: COUNTS_SRC }] },
});

/** The two substituted counts on the COUNTS_SRC cover, plus the output's body page count. */
const countsOf = (books: readonly BookInput[]): { pages: string; sheets: string; bodyPages: number } => {
  const body = bodyOf(renderBooks(books));
  const pages = /<div class="line" data-line="0">(\d+)ページ<\/div>/.exec(body)?.[1];
  const sheets = /<div class="line" data-line="1">(\d+)枚<\/div>/.exec(body)?.[1];
  assert.ok(pages !== undefined && sheets !== undefined, body);
  return { pages, sheets, bodyPages: (body.match(/<div class="page" data-page=/g) ?? []).length };
};

test('cover: 原稿用紙換算枚数 re-flows the body on MANUSCRIPT_SHEET, so pages and sheets differ', () => {
  // 45 one-char lines: 2 pages on the 34-line grid, ceil(45 / 20) = 3 sheets.
  const n = MANUSCRIPT_SHEET.linesPerPage * 2 + 5;
  const { pages, sheets, bodyPages } = countsOf([counted([{ name: 'a.jpnov', src: repeat(n, 'あ') }])]);
  assert.equal(bodyPages, 2);
  assert.equal(pages, String(bodyPages));
  assert.equal(sheets, String(Math.ceil(n / MANUSCRIPT_SHEET.linesPerPage)));
  assert.notEqual(sheets, pages);
});

test('cover: the sheet count wraps columns at MANUSCRIPT_SHEET.charsPerLine', () => {
  // 21 lines of 21 chars: one column each at cpl 40 (1 page), two each on the sheet → 42 → 3.
  const width = MANUSCRIPT_SHEET.charsPerLine + 1;
  const n = MANUSCRIPT_SHEET.linesPerPage + 1;
  const { pages, sheets } = countsOf([counted([{ name: 'a.jpnov', src: repeat(n, 'あ'.repeat(width)) }])]);
  assert.equal(pages, '1');
  assert.equal(sheets, String(Math.ceil((n * 2) / MANUSCRIPT_SHEET.linesPerPage)));
});

test('cover: 原稿用紙換算枚数 counts an NFD kana as one cell, like its NFC spelling', () => {
  const D = '\u3099';
  // linesPerPage full columns: one sheet composed; decomposed, every column would spill into two.
  const filled = (kana: string): BookInput =>
    counted([{ name: 'a.jpnov', src: repeat(MANUSCRIPT_SHEET.linesPerPage, kana.repeat(MANUSCRIPT_SHEET.charsPerLine)) }]);
  const nfd = countsOf([filled(`か${D}`)]);
  assert.deepEqual(nfd, countsOf([filled('が')]));
  assert.equal(nfd.sheets, '1');
});

test('cover: a 天地中央揃え divider counts from the line head; an author 字下げ passes through', () => {
  // 16 lines + glue (blank, mark, blank) + 1 line = 20 → one sheet. The grid's own centring
  // (indent-17 at cpl 40) would leave the sheet a budget of 1: 5 columns for the mark → 2 sheets.
  const n = MANUSCRIPT_SHEET.linesPerPage - 4;
  const chapters = (divider: string): BookInput =>
    counted([{ name: 'a.jpnov', src: repeat(n, 'あ') }, { name: 'b.jpnov', src: 'か' }], divider);
  assert.equal(countsOf([chapters('＊　＊　＊')]).sheets, '1');
  assert.match(bodyOf(renderBooks([chapters('＊　＊　＊')])), /<div class="line indent-17">＊　＊　＊<\/div>/);
  // ［＃１９字下げ］＊＊ is the author's own position: budget 1 on the sheet → 2 columns → 21 → 2.
  const indented = chapters(`${indentAnnotation(MANUSCRIPT_SHEET.charsPerLine - 1)}＊＊`);
  assert.equal(countsOf([indented]).sheets, '2');
});

test('cover: ［＃改ページ］ starts a new sheet, and the count sums every book in the run', () => {
  assert.equal(countsOf([counted([{ name: 'a.jpnov', src: 'あ\n［＃改ページ］\nい' }])]).sheets, '2');
  const body = bodyOf(renderBooks([
    counted([{ name: 'a.jpnov', src: 'あ' }]),
    counted([{ name: 'b.jpnov', src: 'い' }]),
  ]));
  // Two one-line bodies: two sheets, reported on both covers (like 総ページ数 and the footer).
  assert.equal((body.match(/<div class="line" data-line="1">2枚<\/div>/g) ?? []).length, 2);
});

test('cover: 原稿用紙換算枚数 in a BODY chapter prints its name', () => {
  const body = bodyOf(renderBooks([counted([{ name: 'a.jpnov', src: SHEETS_SRC }])]));
  assert.match(body, /<div class="line" data-line="0">原稿用紙換算枚数枚<\/div>/);
});

test('footer: 原稿用紙換算枚数 fills from the same count the cover reports', () => {
  const n = MANUSCRIPT_SHEET.linesPerPage * 2 + 5;
  const body = bodyOf(
    renderBooks([counted([{ name: 'a.jpnov', src: repeat(n, 'あ') }])], { chrome: { footerAlign: 'right', footer: SHEETS_SRC } }),
  );
  const expected = String(Math.ceil(n / MANUSCRIPT_SHEET.linesPerPage));
  assert.match(body, new RegExp(`<div class="line" data-line="1">${expected}枚</div>`));
  assert.match(body, new RegExp(`<div class="ft r">${expected}枚</div>`));
});

test('cover: the sheet count runs only when a cover or the furniture asks for it, once per render', () => {
  // renderBook reads `file.src` once per row build: the configured grid always, the
  // MANUSCRIPT_SHEET re-flow only for a cover (or the header / footer) naming 原稿用紙換算枚数 —
  // and once for all of them.
  const readsFor = (covers: readonly string[], chrome: Partial<BuildChrome> = {}): number => {
    let reads = 0;
    const chapter = {
      name: 'a.jpnov',
      get src(): string {
        reads += 1;
        return 'あ';
      },
    };
    renderBooks([withCover(covers.map((src, i) => ({ name: `c${String(i)}.jpnov`, src })), [chapter])], { chrome });
    return reads;
  };
  assert.equal(readsFor(['表紙']), 1);
  assert.equal(readsFor([COVER_SRC]), 1); // 総ページ数 rides the configured pagination
  assert.equal(readsFor([SHEETS_SRC]), 2);
  assert.equal(readsFor([SHEETS_SRC, COUNTS_SRC]), 2);
  assert.equal(readsFor(['表紙'], { footerAlign: 'right', footer: SHEETS_SRC }), 2);
  assert.equal(readsFor(['表紙'], { header: SHEETS_SRC }), 2);
  assert.equal(readsFor([SHEETS_SRC], { header: SHEETS_SRC, footer: SHEETS_SRC }), 2);
});
