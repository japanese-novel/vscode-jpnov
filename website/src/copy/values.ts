/**
 * The cover's value annotations, from the product's own field table (compiler/tokenizer.ts), so
 * the page can only name fields the product substitutes; one note where a name needs it.
 */
import { VALUE_FIELD_BY_NAME } from '../../../src/shared/compiler/tokenizer.ts';

const NOTES: Readonly<Record<string, string>> = { 総ページ数: '本文のページ数' };

export const VALUE_MARKS = [...VALUE_FIELD_BY_NAME.keys()].map((name) => ({
  name,
  note: NOTES[name],
  mark: `［＃ここに「${name}」の値を表示］`,
}));
