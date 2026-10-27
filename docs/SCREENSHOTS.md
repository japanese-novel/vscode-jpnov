# README screenshots

`docs/images/` holds two kinds of images: **generated renders** produced straight
from the compiler (section A) and **manual VS Code UI captures** (section B).
Nothing under `docs/` ships in the VSIX — the Marketplace loads these images from
the GitHub repository via the manifest's `repository` field, so the repo must be
public by publish time. README.md references every image; README.en.md all but
`vscode-settings.png` and the two `vscode-encoding-*` crops.

Inventory:

| File | Kind | Shows |
| --- | --- | --- |
| `hero-page.png` | generated (A) | page 1 of the built HTML, printed |
| `genkoyoshi.png` | generated (A) | same, line numbers + red rules |
| `notation.png` | generated (A) | annotation specimen |
| `kinsoku-off.png` / `kinsoku-on.png` | generated (A) | kinsoku comparison |
| `vscode-workspace.png` | capture 1, whole window (B) | the writing screen: Books view + editor + preview |
| `vscode-highlight.png` | capture 4, whole window (B) | the book's cast and keywords beside coloured narration |
| `vscode-books-panel.png` | crop of capture 2 (B) | open book: Book Info + 登場人物 + 造語 (folded) + 表紙 + 目次 |
| `vscode-lint-quickfix.png` | crop of capture 2 (B) | lint squiggle + quick-fix menu |
| `vscode-fix-problems.png` | crop of capture 5 (B) | 「本の問題を修正…」: every chapter's problems, the fixable ones ticked |
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

Requirements: macOS with Google Chrome at the standard path, `ffmpeg` at
`/opt/homebrew/bin/ffmpeg` (`brew install ffmpeg`; the script hard-codes the Apple
Silicon Homebrew path), Node ≥ 24 (runs TypeScript directly).

## B. Manual VS Code captures

Six images come from **one window arrangement and five whole-window
captures**; four of the six are crops of those captures. Retake by
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
├── 第二章.jpnov        ← paste the source below
├── 表紙.jpnov          ← the cover sample from README「応募用の表紙と扉」
├── 作品集.jpbook       ← the sample below
└── .vscode/settings.json
```

```json
{
  "chat.disableAIFeatures": true,
  "jpnov.lint.narration.indent": false
}
```

`作品集.jpbook` source:

```
jpbook/1
title: My 作品集
author: みんな
header: 作品集　その一
headerAlign: center
footer: ［＃ここに「ページ番号」の値を表示］ / ［＃ここに「総ページ数」の値を表示］
footerAlign: right
divider: ＊　＊　＊
characters:
  - 山田　太郎
  - John Smith
keywords:
  - 王都
cover:
  - 表紙.jpnov
---
第一章.jpnov
第二章.jpnov
```

`第一章.jpnov` source (same spirit as the walkthrough sample; line 5 is the long paragraph
that shows the editor's word wrap, and the half-width pairs are written as the one character
`⁉` `‼` the lint's default fix produces):

```
　ようこそ、物語《ものがたり》の世界へ。
ここぞという言葉には傍点［＃「傍点」に傍点］を打てます。
　太字［＃「太字」は太字］や字下げも青空文庫の注記のままに。
　その日、太郎は王都に着いた。
　王都の門をくぐった山田太郎は、しばらく石畳の上で足を止めた。朝の光に濡れた道の先には白い塔が並び、その向こうに聖剣を納めた神殿の屋根が見えた。背中の荷が急に重く感じられたのは、ここまでの道のりを思い出したからだろう。
「⁉」
［＃改ページ］
　まさか――これが、［＃太字］事実――［＃太字終わり］ということか。
「なすべきことを、なすだけ」
「29［＃「29」は縦中横］番隊隊長、参ります」
　英雄《えいゆう》になるには、代償が必要。
「進め‼」
　天地［＃「天地」に傍点］は、裂けた［＃「裂けた」に傍線］。
　境界線から｜詠唱の声《キャスターサウンド》が聞こえた。
　作者の魔術だ。
「えっ、作者の魔術って？」
「［＃丸傍点］あれ［＃丸傍点終わり］を勝てる術あるのかよ」
「あるさ」
　山田太郎は片方の口角だけを引き上げた。
「編集部からご指示により、全文を書き直せ！」
「何だと⁉」
　次のシーン、「焼肉、やっぱうまくね？」
```

`第二章.jpnov` source (the bait of capture 5: a half-width pair, an odd 三点リーダー and a
stray 」 — the first two fixable, the last not):

```
　花子は王都の外れで待っていた。
「遅かったな!?」
「道に迷った…」
　花子は笑って、先に歩き出した。
　聖剣が朝日を受けて輝いた。」
```

### Arrangement (once)

Open `第一章.jpnov` and click the editor-title 「プレビューを横に開く」 icon.
In the activity-bar 「小説」 view, open My 作品集 (click its title row) so the
sidebar shows 「本の情報」 and 「目次」. Cursor somewhere mid-text. Leave
`jpnov.lint.narration.indent` **off** (the settings line above) for the first
capture.

### Capture 1 — the writing screen (clean editor)

Whole window, saved as `vscode-workspace.png`.

- Must show: 目次 with the two chapter rows in the sidebar (the ページ数・原稿用紙換算枚数・文字数
  row, the build buttons and the 「出力後に出力フォルダーを開く」 checkbox in the view
  footer), annotated source with syntax highlighting in the middle — the long
  paragraph (line 5) wrapped over several editor lines, which the extension sets
  for `.jpnov` by default (`editor.wordWrap`) — and the vertical preview on the right.

### Capture 2 — book management + quick fix

Expand 「本の情報」 and 「表紙」 (leave 「登場人物」 and 「造語」 folded), re-enable `jpnov.lint.narration.indent` (delete the
settings line or set it true — the line-2 sample text is its bait), and open
the lightbulb menu on the squiggle.
Whole window, then two crops:

- `vscode-books-panel.png` (sidebar incl. activity bar): from the view header
  down through the 「章を追加…」 row. Must show the 「本の問題を修正…」 icon in the view
  header, all seven 本の情報 rows
  (タイトル・ペンネーム・ヘッダー・章区切り filled in; ヘッダーの配置 and the two フッター
  rows at the product defaults), the folded 「登場人物」 and 「造語」 headers, the 表紙
  section (the 表紙.jpnov row and the 「表紙を追加…」 row), and the chapter rows.
  The build buttons are deliberately outside this crop — they are visible in
  `vscode-workspace.png`.
- `vscode-lint-quickfix.png` (editor area): the squiggle, its hover, and the
  open quick-fix menu (the fix and the 「…の設定を開く」 entry), plus a few lines of
  context.

### Capture 3 — settings

Settings (<kbd>⌘,</kbd>) → search `jpnov` (settings search matches the key
prefix; it does not index the localized group titles, so 「小説」 finds
nothing). Whole window, cropped to the settings editor. Must show: the three
小説 groups in the tree on the left, and the 「小説 — 組版と出力」 items with
the 40 × 34 defaults visible.

### Capture 4 — the book's lists beside the text

Back on the Books view **list** screen (the `<` arrow), open `作品集.jpbook` in
the preview's editor group so its `characters:` (山田　太郎 / John Smith) and
`keywords:` (王都) sit beside the chapter text. Whole window, saved as
`vscode-highlight.png` — no crop.

- Must show: both lists in the book file, and `山田太郎は` coloured / `王都`
  bold in the narration at 1:1 — the lists and their effect side by side are
  the point of this image. If nothing is coloured, the Books view has not
  listed the books yet (the listing is what hands the server the names); press
  「本の一覧を更新」 (Refresh Books) before capturing.

### Capture 5 — the book's problems

From the list screen, open My 作品集 again and press the view-title
「本の問題を修正…」 icon. The sidebar switches to the 問題 screen: a heading per
chapter, its problems in order of place with a checkbox each, and the
「すべて選択」/「すべて解除」 links with the 「修正」 button in the view footer. Keep
`jpnov.lint.narration.indent` on (as for capture 2) and both chapters as pasted.
The list is four rows, so at the common 1600 × 1000 window most of the screen
is empty between the rows and the footer. For this capture only, shrink the
window to 1600 × 520 first (the common-setup script with the height changed):

```sh
osascript -e 'tell application "System Events" to tell process "Code"
  set position of front window to {80, 40}
  set size of front window to {1600, 520}
end tell'
```

(Windows: the same `MoveWindow` call with `520` as the height.) That keeps the
footer just under the list. Whole window, then one crop:

- `vscode-fix-problems.png` (sidebar incl. activity bar): from the view header
  down through the footer. Must show: both chapter headings — 第一章.jpnov with
  the line-2 字下げ row, 第二章.jpnov with the `!?` row, the `…` row and the
  stray 」 row that says 「自動修正できません」 — the three fixable rows ticked, the
  unfixable row's checkbox disabled, and the footer links and 「修正」 button.
  Capture before pressing 「修正」: it fixes the chapters and returns to the
  detail screen.

### Crop commands

The rects used this round (ffmpeg, physical px on a 3204×2004 capture with
the sidebar at ≈350 logical px including the activity bar). Bounds shift with
your window and sidebar size — re-aim by eye, or crop in Preview.app; nothing
depends on exact pixels. The sidebar crops start at y=80 (under the window
title bar); the problems crop runs to the bottom of the view, above the
status bar, so it follows the window height.

```sh
ffmpeg -i cap2.png -vf "crop=700:1290:0:80"     docs/images/vscode-books-panel.png
ffmpeg -i cap2.png -vf "crop=1064:356:706:80"   docs/images/vscode-lint-quickfix.png
ffmpeg -i cap3.png -vf "crop=2544:1540:644:80"  docs/images/vscode-settings.png
ffmpeg -i cap5.png -vf "crop=700:ih-154:0:80"   docs/images/vscode-fix-problems.png
```
