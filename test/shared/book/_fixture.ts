/**
 * `.jpbook` text for tests: the header line and the seven required keys at the book template's
 * values, any of them overridden or left out, then the closing `---`, so a fixture reads as
 * `meta() + 'a.jpnov\n'` and the keys stay out of its way. The template itself is pinned by
 * create.test.ts.
 */
import { templateValues } from '../../../src/shared/book/create.ts';
import { FENCE, HEADER, META_KEYS, metaLine, type MetaKey, type ParsedJpbook } from '../../../src/shared/book/jpbook.ts';

/** The header line with its newline: what a hand-written book text opens with. */
export const HEAD = `${HEADER}\n`;

/** The line `key` is written on in {@link meta} (the header is line 0). */
export function metaLineOf(key: MetaKey): number {
  return META_KEYS.indexOf(key) + 1;
}

/** The line of the fence {@link meta} ends with; `metaWith(x)` moves it down by x's lines, `omit` up by theirs. */
export const FENCE_LINE = META_KEYS.length + 1;

/** The seven key lines alone, each with its newline: `overrides` applied, `omit` dropped. */
export function metaBody(overrides: Partial<Record<MetaKey, string>> = {}, omit: readonly MetaKey[] = []): string {
  const values = { ...templateValues('作品名'), ...overrides };
  return META_KEYS.filter((key) => !omit.includes(key)).map((key) => `${metaLine(key, values[key])}\n`).join('');
}

/** The header, {@link metaBody}, then `---` and a newline. */
export function meta(overrides: Partial<Record<MetaKey, string>> = {}, omit: readonly MetaKey[] = []): string {
  return `${HEAD}${metaBody(overrides, omit)}${FENCE}\n`;
}

/** {@link meta} with `lines` written last in the metadata, right above the fence. */
export function metaWith(
  lines: string,
  overrides: Partial<Record<MetaKey, string>> = {},
  omit: readonly MetaKey[] = [],
): string {
  return `${HEAD}${metaBody(overrides, omit)}${lines}\n${FENCE}\n`;
}

/** A parse with its first `n` lines dropped and the rest numbered from 0 — so a fixture written below
 *  the header (or below an empty metadata block) keeps its own line numbers in the assertions. */
export function below(parsed: ParsedJpbook, n: number): ParsedJpbook {
  return {
    ...parsed,
    lines: parsed.lines.slice(n).map((l) => ({ ...l, line: l.line - n })),
    fence: parsed.fence === null ? null : parsed.fence - n,
    metaErrors: parsed.metaErrors.map((e) => ({ ...e, line: e.line - n })),
  };
}
