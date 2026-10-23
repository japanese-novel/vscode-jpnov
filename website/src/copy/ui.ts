/**
 * Every product label the page quotes, typed once. The terminology test checks each value against
 * the extension's own strings (l10n/bundle.l10n.ja.json, package.nls.ja.json), so a label the
 * product does not ship cannot appear in the copy.
 */
export const UI = {
  container: '小説',
  bookInfo: '本の情報',
  characters: '登場人物',
  keywords: '造語',
  covers: '表紙',
  chapters: '目次',
  addChapters: '章を追加…',
  pickChapters: '追加する章ファイルを選択するか、新しい章のファイル名を入力',
  previewToSide: 'プレビューを横に開く',
  annotationGuide: '青空文庫の注記一覧',
  print: '印刷／PDF 保存',
  txt: 'テキスト',
  epub: 'EPUB に出力',
  openAfterBuild: '出力後に出力フォルダーを開く',
} as const;
