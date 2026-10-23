/**
 * The Books view's status row for a book: `bookCounts()`'s figures in the Japanese the product
 * prints them in (src/client/book/view.ts `countsOf`, through the same formatter), so the stage
 * cannot drift from the product's wording.
 */
import { formatCounts } from '../../src/client/book/counts.ts';
import type { CountsVM } from '../../src/client/protocol.ts';
import type { BookCounts } from '../../src/shared/compiler/document.ts';
import { ja } from './l10n.ts';

export function countsRow(counts: BookCounts): CountsVM {
  return formatCounts(counts, ja, (value) => value.toLocaleString('ja'));
}
