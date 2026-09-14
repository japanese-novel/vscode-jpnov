/**
 * The site's character set: everything the page can show in the Mincho face — the copy in
 * src/**, the manuscript samples, and every string inside the product renders — plus the
 * characters the build inserts (〓, the dash and leader translations) and printable ASCII.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { sitePath } from './root.ts';

const TEXT_EXT = /\.(astro|ts|md|css|jpnov|jpbook)$/;
const SKIP = /^(generated|node_modules)\//;

/** The text files under `dir`, generated ones excluded. */
async function textFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries
    .map((rel) => rel.split(sep).join('/'))
    .filter((rel) => TEXT_EXT.test(rel) && !SKIP.test(rel))
    .map((rel) => join(dir, rel));
}

function* jsonStrings(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) {
      yield* jsonStrings(item);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      yield* jsonStrings(item);
    }
  }
}

const ALWAYS = `${Array.from({ length: 0x7f - 0x20 }, (_v, i) => String.fromCharCode(0x20 + i)).join('')}　〓…‥―—─`;

/** Sorted, de-duplicated code points as a string. */
export async function collectGlyphs(): Promise<string> {
  const set = new Set<string>(ALWAYS);
  const files = await textFiles(sitePath('src'));
  for (const text of await Promise.all(files.map((file) => readFile(file, 'utf8')))) {
    for (const ch of text) {
      set.add(ch);
    }
  }
  const renders: unknown = JSON.parse(await readFile(sitePath('src/generated/renders.json'), 'utf8'));
  for (const text of jsonStrings(renders)) {
    for (const ch of text.replace(/<[^>]*>/g, '')) {
      set.add(ch);
    }
  }
  return [...set]
    .filter((ch) => !/[\p{Cc}\s]/u.test(ch) || ch === '　')
    .sort((a, b) => (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0))
    .join('');
}

/** `U+XXXX-YYYY` runs for a `unicode-range` descriptor. */
export function unicodeRanges(chars: string): string {
  const hex = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0');
  const run = (start: number, end: number): string => (start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`);
  const runs: string[] = [];
  let start: number | undefined;
  let prev = 0;
  for (const ch of chars) {
    const p = ch.codePointAt(0) ?? 0;
    if (start !== undefined && p === prev + 1) {
      prev = p;
      continue;
    }
    if (start !== undefined) {
      runs.push(run(start, prev));
    }
    start = p;
    prev = p;
  }
  if (start !== undefined) {
    runs.push(run(start, prev));
  }
  return runs.join(', ');
}
