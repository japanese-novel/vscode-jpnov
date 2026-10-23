/**
 * Every string the reconstructed VS Code window shows. Product labels come from copy/ui.ts (and
 * are guarded against the extension's own bundles); the rest is VS Code's own chrome, in the
 * Japanese language pack's wording, and the sample's file names.
 */
import { UI } from '../copy/ui.ts';

export { UI };

/** VS Code chrome (not product strings). */
export const VSCODE = {
  quickFix: 'クイック修正',
  hoverActions: '問題の表示 (⌥F8)   クイック フィックス... (⌘.)',
  pickOk: 'OK',
  statusPosition: '行 10、列 21',
  statusIndent: 'スペース: 4',
  statusEncoding: 'UTF-8',
  statusEol: 'LF',
  problems: '0',
} as const;

/** Product strings the window composes at runtime (the product's own templates). */
export const PRODUCT = {
  previewTab: (name: string): string => `${name} — プレビュー`,
  viewTitle: (title: string): string => `${UI.container}: ${title}`,
} as const;

/** The stage book's chapters as the window names them, by their file in src/samples/ (ASCII on disk), in 目次 order. */
export const CHAPTERS = {
  'chapter1.jpnov': '第一章.jpnov',
  'chapter2.jpnov': '第二章.jpnov',
  'chapter3.jpnov': '第三章.jpnov',
} as const;

/** The chapter 章を追加… adds in the collect beat: absent before it, listed last and moved up by the timeline. */
export const LATE_CHAPTER = 'chapter2.jpnov' satisfies keyof typeof CHAPTERS;

/** The sample workspace as the window names it. */
export const NAMES = {
  folder: '作品名',
  bookTitle: '作品名',
  chapter1: CHAPTERS['chapter1.jpnov'],
} as const;
