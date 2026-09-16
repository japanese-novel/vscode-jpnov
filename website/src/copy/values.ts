/**
 * The cover's value annotations, from the product's own name table (compiler/tokenizer.ts) —
 * the four names a cover page fills; one note where a name needs it.
 */
import { VALUE_NAMES, valueAnnotation } from '../../../src/shared/compiler/tokenizer.ts';

const NOTES: Readonly<Record<string, string>> = { [VALUE_NAMES.totalPages]: '本文のページ数' };

export const VALUE_MARKS = [VALUE_NAMES.title, VALUE_NAMES.author, VALUE_NAMES.totalPages, VALUE_NAMES.sheets].map((name) => ({
  name,
  note: NOTES[name],
  mark: valueAnnotation(name),
}));
