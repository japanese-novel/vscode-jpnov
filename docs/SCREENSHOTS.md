# README screenshots

`docs/images/` holds two kinds of images: **generated renders** produced straight
from the compiler (section A) and **manual VS Code UI captures** (section B).
Nothing under `docs/` ships in the VSIX — the Marketplace loads these images from
the GitHub repository via the manifest's `repository` field, so the repo must be
public by publish time. Both READMEs reference the same files.

Inventory:

| File | Kind | Shows |
| --- | --- | --- |
| `hero-page.png` | generated (A) | page 1 of the built HTML, printed |
| `genkoyoshi.png` | generated (A) | same, line numbers + red rules |
| `notation.png` | generated (A) | annotation specimen |
| `kinsoku-off.png` / `kinsoku-on.png` | generated (A) | kinsoku comparison |
| `vscode-workspace.png` | capture 1, whole window (B) | the writing screen: Books view + editor + preview |
| `vscode-highlight.png` | capture 4, whole window (B) | highlight settings beside coloured narration |
| `vscode-books-panel.png` | crop of capture 2 (B) | open book: Book Info + 表紙 + 目次 |
| `vscode-lint-quickfix.png` | crop of capture 2 (B) | lint squiggle + quick-fix menu |
| `vscode-settings.png` | crop of capture 3 (B) | settings search `jpnov` |
| `vscode-encoding-statusbar.png` / `vscode-encoding-reopen.png` | ad-hoc crops | FAQ: Shift JIS reopen; UI-stable, retake only if that VS Code flow changes |

## A. Generated renders

`hero-page.png`, `genkoyoshi.png`, `notation.png`, `kinsoku-off.png`,
`kinsoku-on.png` — regenerate whenever the renderer's visual output changes:

```sh
npm run screenshots
```

The script, `scripts/screenshots.ts`, drives the product's own code — page
shots by printing the built HTML the way a user's browser would (`renderBook()`
→ headless Chrome `--print-to-pdf` with the flags of `test/e2e/_browser.ts`
`printToPdfArgs()` → page 1 rasterized by `qlmanage`), specimen shots through
`renderPreview()` + `--screenshot` — and overwrites the five PNGs in
`docs/images/`. The images are unretouched product output apart from the grey
mat around the page shots and the whitespace crops on the specimen shots.
Intermediates (HTML, PDFs, uncropped PNGs) stay in `.scratch/shots/` for
inspection; Chrome quirks and layout constraints are documented as comments
in the script.

Requirements: macOS with Google Chrome at the standard path, `ffmpeg`
(`brew install ffmpeg`), Node ≥ 24 (runs TypeScript directly).

## B. Manual VS Code captures

Five images come from **one window arrangement and four whole-window
captures**; three of the five are crops of those captures. Retake by
overwriting the PNGs in `docs/images/` under the same filenames.

Common setup:

- macOS retina display (2× pixel density), whole-window capture
  (<kbd>⇧⌘4</kbd> then <kbd>Space</kbd>; hold <kbd>⌥</kbd> while clicking to
  drop the drop shadow if you prefer).
- VS Code in **Japanese display language**, **Dark Modern** theme.
- Pin the window, then:

  ```sh
  osascript -e 'tell application "System Events" to tell process "Code"
    set position of front window to {80, 40}
    set size of front window to {1600, 1000}
  end tell'
  ```

  On "not allowed assistive access": システム設定 → プライバシーとセキュリティ →
  アクセシビリティ → allow your terminal. The Extension Development Host is the
  same `Code` process; Insiders is `"Code - Insiders"`.

  Windows equivalent (PowerShell; capture with <kbd>Alt</kbd>+<kbd>PrtScn</kbd>):

  ```powershell
  Add-Type -Namespace Native -Name Win -MemberDefinition @'
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int W, int H, bool Repaint);
  '@
  [Native.Win]::SetProcessDPIAware() | Out-Null
  $hwnd = (Get-Process Code | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1).MainWindowHandle
  [Native.Win]::MoveWindow($hwnd, 80, 40, 1600, 1000, $true) | Out-Null
  ```

  Sizes are physical pixels — use 3200 × 2000 on a HiDPI monitor. With several
  VS Code windows open, close the extras or pick one by title:
  `Where-Object MainWindowTitle -like '*拡張機能開発ホスト*'`.
- Bump the editor font one step (<kbd>⌘+</kbd>) so text survives README
  downscaling.

Sample project to open (any temp folder):

```
novel-sample/
├── 第一章.jpnov        ← paste the source below
├── 第二章.jpnov        ← a few plain lines are enough
├── 表紙.jpnov          ← the cover sample from README「応募用の表紙と扉」
├── 作品集.jpbook       ← the front-mattered sample below
└── .vscode/settings.json
```

```json
{
  "chat.disableAIFeatures": true,
  "jpnov.editor.highlight.characters": ["山田 太郎", "John Smith"],
  "jpnov.editor.highlight.keywords": ["王都"],
  "jpnov.lint.narration.indent": false
}
```

`作品集.jpbook` source:

```
---
title: My 作品集
author: みんな
header: 作品集　その一
divider: ＊　＊　＊
cover:
  - 表紙.jpnov
---
第一章.jpnov
第二章.jpnov
```

`第一章.jpnov` source (same spirit as the walkthrough sample):

```
　ようこそ、物語《ものがたり》の世界へ。
ここぞという言葉には傍点［＃「傍点」に傍点］を打てます。
　太字［＃「太字」は太字］や字下げも青空文庫の注記のままに。
　その日、太郎は王都に着いた。
「!?」
［＃改ページ］
　まさか――これが、［＃太字］事実――［＃太字終わり］ということか。
「なすべきことを、なすだけ」
「29［＃「29」は縦中横］番隊隊長、参ります」
　英雄《えいゆう》になるには、代償が必要。
「進め!!」
　天地［＃「天地」に傍点］は、裂けた［＃「裂けた」に傍線］。
　境界線から｜詠唱の声《キャスターサウンド》が聞こえた。
　作者の魔術だ。
「えっ、作者の魔術って？」
「［＃丸傍点］あれ［＃丸傍点終わり］を勝てる術あるのかよ」
「あるさ」
　山田太郎は片方の口角だけを引き上げた。
「編集部からご指示により、全文を書き直せ！」
「何だと!?」
　次のシーン、「焼肉、やっぱうまくね？」
```

### Arrangement (once)

Open `第一章.jpnov` and click the editor-title 「プレビューを横に開く」 icon.
In the activity-bar 「小説」 view, open My 作品集 (click its title row) so the
sidebar shows 「本の情報」 and 「目次」. Cursor somewhere mid-text. Leave
`jpnov.lint.narration.indent` **off** (the settings line above) for the first
capture.

### Capture 1 — the writing screen (clean editor)

Whole window, saved as `vscode-workspace.png`.

- Must show: 目次 with the two chapter rows in the sidebar (build buttons and
  the 「出力後に出力フォルダーを開く」 checkbox in the view footer), annotated
  source with syntax highlighting in the middle, the vertical preview on the
  right.

### Capture 2 — book management + quick fix

Expand 「本の情報」 and 「表紙」, re-enable `jpnov.lint.narration.indent` (delete the
settings line or set it true — the line-2 sample text is its bait), and open
the lightbulb menu on the squiggle.
Whole window, then two crops:

- `vscode-books-panel.png` (sidebar incl. activity bar): from the view header
  down through the 「新しい章…」 row. Must show all six 本の情報 rows
  (タイトル・ヘッダー・章区切り filled in; ペンネーム and the two フッター rows at their
  defaults), the 表紙 section (the 表紙.jpnov row, its header's 「表紙を追加…」
  button and the 「新しい表紙…」 row), the chapter rows, and the 目次 header's
  「章を追加…」 button.
  The build buttons are deliberately outside this crop — they are visible in
  `vscode-workspace.png`.
- `vscode-lint-quickfix.png` (editor area): the squiggle, its hover, and the
  open quick-fix menu, plus a few lines of context.

### Capture 3 — settings

Settings (<kbd>⌘,</kbd>) → search `jpnov` (settings search matches the key
prefix; it does not index the localized group titles, so 「小説」 finds
nothing). Whole window, cropped to the settings editor. Must show: the three
小説 groups in the tree on the left, and the 「小説 — 組版と出力」 items with
the 40 × 34 defaults visible.

### Capture 4 — highlight settings beside the text

Back on the Books view **list** screen (the `<` arrow), open Settings
(<kbd>⌘,</kbd>) in the preview's editor group, search `jpnov`, and scroll
until **Highlight: Characters** (山田 太郎 / John Smith) and
**Highlight: Keywords** (王都) sit beside the chapter text. Whole window,
saved as `vscode-highlight.png` — no crop.

- Must show: both populated highlight lists in the settings pane, and
  `山田太郎は` coloured / `王都` bold in the narration at 1:1 — config and
  effect side by side are the point of this image. If nothing is coloured,
  the workspace highlight settings didn't load; fix that before capturing.

### Crop commands

The rects used this round (ffmpeg, physical px on a 3204×2004 capture with
the sidebar at ≈425 logical px). Bounds shift with your window and sidebar
size — re-aim by eye, or crop in Preview.app; nothing depends on exact
pixels.

```sh
ffmpeg -i cap2.png -vf "crop=690:920:0:80"      docs/images/vscode-books-panel.png
ffmpeg -i cap2.png -vf "crop=1056:420:706:96"   docs/images/vscode-lint-quickfix.png
ffmpeg -i cap3.png -vf "crop=2544:1452:644:80"  docs/images/vscode-settings.png
```
