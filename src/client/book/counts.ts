/**
 * The Books view's status row: the bundle keys each figure of `bookCounts()` is formatted with
 * (text template and hover title) and the formatting itself. vscode-free, so the website prints
 * the same row through its own translator.
 */
import type { BookCounts } from '../../shared/compiler/document.ts';
import type { CountItem, CountsVM } from '../protocol.ts';

const COUNT_KEYS: Readonly<Record<keyof CountsVM, CountItem>> = {
  pages: { text: '{0} page(s)', title: 'Body pages' },
  sheets: { text: '{0} sheet(s)', title: 'Manuscript sheets (400-character 原稿用紙)' },
  chars: { text: '{0} character(s)', title: 'Character count' },
};

/** Each figure through the caller's translator `t` (bundle key, then the `{0}` argument) and number formatter `n`. */
export function formatCounts(counts: BookCounts, t: (key: string, ...args: string[]) => string, n: (value: number) => string): CountsVM {
  const figure = (key: keyof CountsVM): CountItem => ({ text: t(COUNT_KEYS[key].text, n(counts[key])), title: t(COUNT_KEYS[key].title) });
  return { pages: figure('pages'), sheets: figure('sheets'), chars: figure('chars') };
}
