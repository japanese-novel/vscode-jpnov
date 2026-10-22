/**
 * The Books view's status row for a book: `bookCounts()`'s figures in the Japanese the product
 * prints them in (src/client/book/view.ts `countsOf`), so the stage cannot drift from the
 * product's wording.
 */
import type { CountItem, CountsVM } from '../../src/client/protocol.ts';
import type { BookCounts } from '../../src/shared/compiler/document.ts';
import { ja } from './l10n.ts';

/** The bundle keys `countsOf` formats each figure with: its text template and its hover title. */
export const COUNT_KEYS: Readonly<Record<keyof CountsVM, CountItem>> = {
  pages: { text: '{0} page(s)', title: 'Body pages' },
  sheets: { text: '{0} sheet(s)', title: 'Manuscript sheets (400-character 原稿用紙)' },
  chars: { text: '{0} character(s)', title: 'Character count' },
};

export function countsRow(counts: BookCounts): CountsVM {
  const figure = (key: keyof CountsVM): CountItem => ({ text: ja(COUNT_KEYS[key].text, counts[key].toLocaleString('ja')), title: ja(COUNT_KEYS[key].title) });
  return { pages: figure('pages'), sheets: figure('sheets'), chars: figure('chars') };
}
