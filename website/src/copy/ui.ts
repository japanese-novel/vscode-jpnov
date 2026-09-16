/**
 * Every product label the page quotes, typed once. The terminology test checks each value against
 * the extension's own strings (l10n/bundle.l10n.ja.json, package.nls.ja.json) or VS Code's, so a
 * label the product does not ship cannot appear in the copy.
 */
export const UI = {
  container: '小説',
  books: '本の一覧',
  createBook: '本を作成…',
  bookInfo: '本の情報',
  title: 'タイトル',
  author: 'ペンネーム',
  header: 'ヘッダー',
  footer: 'フッター',
  footerAlign: 'フッターの配置',
  divider: '章区切り',
  covers: '表紙',
  newCover: '新しい表紙…',
  chapters: '目次',
  addChapters: '章を追加…',
  pickChapters: '追加する章ファイルを選択',
  newChapter: '新しい章…',
  previewToSide: 'プレビューを横に開く',
  print: '印刷／PDF 保存',
  txt: 'テキスト',
  epub: 'EPUB に出力',
  openAfterBuild: '出力後に出力フォルダーを開く',
  lintIndent: '行頭が字下げされていません',
  fixAll: '自動修正できる問題をすべて修正（小説）',
  settingsLayout: '小説 — 組版と出力',
  settingsLint: '小説 — 文章校正',
  settingsEditor: '小説 — エディター',
  kinsokuStrict: '厳格',
  kinsokuRelaxed: '緩め',
  edgeRed: '赤',
} as const;
