/**
 * The cover's value annotations, from the product's own name table (ast/notation.ts) — the names a
 * cover page or a header fills, one note where a name needs it — and the two kanji functions, each
 * with the tail it gives the annotation and an example the product formats.
 */
import { formatValue, VALUE_FORMATS, VALUE_NAMES, valueAnnotation, valueTail } from '../../../src/shared/ast/notation.ts';

const NOTES: Readonly<Record<string, string>> = { [VALUE_NAMES.totalPages]: '本文のページ数', [VALUE_NAMES.heading]: 'その章が目次の何番目か' };

export const VALUE_MARKS = [VALUE_NAMES.title, VALUE_NAMES.author, VALUE_NAMES.totalPages, VALUE_NAMES.sheets, VALUE_NAMES.heading].map((name) => ({
  name,
  note: NOTES[name],
  mark: valueAnnotation(name),
}));

const EXAMPLE = '128';

/** A kanji function: the tail it gives the annotation, and what {@link EXAMPLE} becomes under it. */
function kanjiFormat(format: string): { readonly tail: string; readonly sample: string } {
  return { tail: valueTail(format), sample: formatValue(format, EXAMPLE) };
}

/** The kanji note: the plain tail a function replaces, the example number, and the two functions. */
export const KANJI = { plainTail: valueTail(), example: EXAMPLE, positional: kanjiFormat(VALUE_FORMATS.positional), named: kanjiFormat(VALUE_FORMATS.named) } as const;
