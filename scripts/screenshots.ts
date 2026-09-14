// README 用スクリーンショット生成器（npm run screenshots）。
// ページ物 (hero/genkoyoshi) は出力 HTML を Chromium で印刷（test/e2e/_browser.ts
// printToPdfArgs と同じフラグ）して PDF にし、1 ページ目を qlmanage で
// ラスタライズする — 用紙余白含め「印刷」の結果そのまま（A4 横）。
// 見本 (notation/kinsoku) はプレビューレンダラー + headless --screenshot。
// 最終 PNG は docs/images/ を直接上書きし、中間産物は .scratch/shots/ に残す。
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBook } from '../src/shared/compiler/document.ts';
import { renderPreview } from '../src/shared/compiler/preview.ts';

const OUT = fileURLToPath(new URL('../.scratch/shots/', import.meta.url));
const IMAGES = fileURLToPath(new URL('../docs/images/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FFMPEG = '/opt/homebrew/bin/ffmpeg';

// サンプルテキスト

// docs/specimens/ (shared with the website); the credit for the 青空文庫 text is in
// docs/specimens/README.md and in both READMEs' captions.
function specimen(name: string): string {
  return readFileSync(new URL(`../docs/specimens/${name}.jpnov`, import.meta.url), 'utf8');
}
const NEKO = specimen('neko');
const NOTATION = specimen('notation');
const KINSOKU = specimen('kinsoku');

// ショット定義

// フォントは製品既定（css.ts DEFAULT_FONT_STACK — Hiragino 先頭）をそのまま使う。
// プレビューは透明背景 + --vscode-* 変数なので、紙色を与える。
// padding-block は vertical-rl では左右の余白（プレビュー自身は横方向フラッシュ）。
const PAPER = 'html{background:#fff;color:#1a1a1a}body{padding-block:24px}';

const bookOpts = {
  charsPerLine: 40,
  linesPerPage: 34,
  linePitch: 1.5, // 既定値のまま撮る
  fontFamily: '',
  kinsoku: 'strict',
  autoTcy: 'punctuationPairs',
  dash: 'horizontalBar',
  paperSize: 'a4',
  paperOrientation: 'auto',
} as const;
const folio = {
  pageNumber: 'right',
  pageNumberFormat: '{page} / {totalPage}',
  header: '吾輩は猫である',
} as const;

type PreviewOpts = Parameters<typeof renderPreview>[1];
/** 特写ショットのプレビュー設定。既定値を土台に、各ショットは差分だけ渡す。 */
const previewOpts = (overrides: Partial<PreviewOpts> = {}): PreviewOpts => ({
  charsPerLine: 20,
  linesPerPage: 34,
  linePitch: 1.5,
  fontFamily: '',
  kinsoku: 'strict',
  autoTcy: 'punctuationPairs',
  dash: 'horizontalBar',
  chrome: { lineNumbers: false, edgeLine: 'none' },
  ...overrides,
});

interface PdfShot {
  name: string;
  html: string;
  mode: 'pdf';
  /** qlmanage -s（長辺の物理 px。A4 横のページ長辺 297mm ≈ 1122.5 css px の 2 倍 ≈ 2245 で 2x 相当） */
  rasterSize: number;
  /** ffmpeg pad の台紙幅（物理 px）— 白い紙が GitHub のライトテーマに溶けないように */
  mat: number;
}
interface ScreenShot {
  name: string;
  html: string;
  mode: 'screenshot';
  style: string;
  /**
   * ウィンドウ幅（論理 px）は 500 未満にしないこと — screenshot モードの layout viewport は
   * 最小 500 のまま、キャンバスだけが --window-size に従うため、右端（vertical-rl の内容側）から
   * 欠ける。細くしたい絵は幅そのままで撮り、ffmpeg の crop で切る。
   */
  w: number;
  h: number;
  /**
   * 論理 px。fromRight: 内容が右寄せなので右端から w px を残す。
   * w はインク幅 + 左右対称の余白の実測値 — ショットの行送りを変えたら測り直す。
   */
  crop?: { w: number; fromRight: boolean };
}
type Shot = PdfShot | ScreenShot;

const shots: Shot[] = [
  {
    name: 'hero-page',
    mode: 'pdf',
    html: renderBook({
      books: [{ files: [{ name: 'wagahai.jpnov', src: NEKO }] }],
      ...bookOpts,
      chrome: { lineNumbers: false, edgeLine: 'none', ...folio },
    }),
    rasterSize: 2245,
    mat: 40,
  },
  {
    name: 'genkoyoshi',
    mode: 'pdf',
    html: renderBook({
      books: [{ files: [{ name: 'wagahai.jpnov', src: NEKO }] }],
      ...bookOpts,
      linePitch: 2, // 罫線あり — 既定 1.5 では罫線がルビを横切る
      chrome: { lineNumbers: true, edgeLine: 'red', ...folio },
    }),
    rasterSize: 2245,
    mat: 40,
  },
  {
    name: 'notation',
    mode: 'screenshot',
    // linePitch 2: 見本に左ルビがある — 既定 1.5 では隣の行に重なる
    html: renderPreview(NOTATION, previewOpts({ charsPerLine: 9, linePitch: 2 })),
    style: PAPER,
    w: 1080,
    h: 620,
    crop: { w: 865, fromRight: true },
  },
  {
    name: 'kinsoku-off',
    mode: 'screenshot',
    html: renderPreview(KINSOKU, previewOpts({ kinsoku: 'none' })),
    style: PAPER,
    w: 500, // 最小幅ちょうど。撮影後に左余白を crop
    h: 640,
    crop: { w: 180, fromRight: true },
  },
  {
    name: 'kinsoku-on',
    mode: 'screenshot',
    html: renderPreview(KINSOKU, previewOpts()),
    style: PAPER,
    w: 500,
    h: 640,
    crop: { w: 180, fromRight: true },
  },
];

// 撮影

/** 出力ファイルの生成をサイズ安定で検知し、Chrome を止める（headless は自然終了しない） */
async function runChromeUntilSettled(args: string[], outFile: string): Promise<void> {
  rmSync(outFile, { force: true }); // 前回の出力が残っているとポーリングが即座に誤終了する
  const profile = mkdtempSync(join(tmpdir(), 'jpnov-shot-')); // プロファイル再利用は SingletonLock で死ぬ
  const proc = spawn(CHROME, [`--user-data-dir=${profile}`, ...args], { stdio: 'ignore' });
  const deadline = Date.now() + 30_000;
  let last = -1;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    let size = 0;
    try {
      size = statSync(outFile).size;
    } catch {
      /* not yet */
    }
    if (size > 0 && size === last) break;
    last = size > 0 ? size : -1;
  }
  proc.kill('SIGKILL');
}

function screenshotArgs(png: string, w: number, h: number, url: string): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
    `--window-size=${String(w)},${String(h)}`,
    '--force-device-scale-factor=2',
    '--hide-scrollbars',
    '--timeout=3000',
    `--screenshot=${png}`,
    url,
  ];
}

// test/e2e/_browser.ts printToPdfArgs と同じフラグ（--user-data-dir は共通処理側）
function printToPdfArgs(pdf: string, url: string): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdf}`,
    url,
  ];
}

for (const shot of shots) {
  const htmlPath = join(OUT, `${shot.name}.html`);
  writeFileSync(
    htmlPath,
    shot.mode === 'pdf' ? shot.html : shot.html.replace('</head>', `<style>${shot.style}</style></head>`),
  );
  const url = `file://${htmlPath}`;
  const png = join(OUT, `${shot.name}.png`);

  if (shot.mode === 'pdf') {
    const pdf = join(OUT, `${shot.name}.pdf`);
    await runChromeUntilSettled(printToPdfArgs(pdf, url), pdf);
    // 1 ページ目をラスタライズ（qlmanage は <name>.pdf.png を書く）
    rmSync(png, { force: true });
    rmSync(`${pdf}.png`, { force: true });
    spawnSync('/usr/bin/qlmanage', ['-t', '-s', String(shot.rasterSize), '-o', OUT, pdf], {
      stdio: 'ignore',
    });
    renameSync(`${pdf}.png`, png);
    // 台紙を付ける（紙が白背景に溶けないように）
    const m = shot.mat;
    const tmp = join(OUT, `${shot.name}.mat.png`);
    spawnSync(FFMPEG, [
      '-y', '-loglevel', 'error', '-i', png,
      '-vf', `pad=iw+${String(m * 2)}:ih+${String(m * 2)}:${String(m)}:${String(m)}:color=0xe8e6e1`, tmp,
    ]);
    renameSync(tmp, png);
  } else {
    await runChromeUntilSettled(screenshotArgs(png, shot.w, shot.h, url), png);
    if (shot.crop) {
      // scale factor 2 なので物理 px は 2 倍
      const w = shot.crop.w * 2;
      const x = shot.crop.fromRight ? shot.w * 2 - w : 0;
      const tmp = join(OUT, `${shot.name}.crop.png`);
      spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', png, '-vf', `crop=${String(w)}:ih:${String(x)}:0`, tmp]);
      renameSync(tmp, png);
    }
  }
  copyFileSync(png, join(IMAGES, `${shot.name}.png`));
  console.log(`${shot.name}: ${String(statSync(png).size)} bytes`);
}
