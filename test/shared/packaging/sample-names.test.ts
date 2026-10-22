/**
 * No specific work titles, author names, cast names, or cover/synopsis prose anywhere in the
 * repository text — every sample uses the placeholders in CLAUDE.md (作品名 / ペンネーム / 山田　太郎 /
 * John Smith / 王都 …). A novelist who meets a made-up title or a real pen name in the extension
 * asks whose manuscript it ships with; that question must never come up. Two checks: the names
 * that slipped in before stay out, and every docs `.jpbook` sample carries a placeholder value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from '../repo.ts';
import { ANNOTATION_CLOSE, ANNOTATION_OPEN, CORNER_CLOSE, CORNER_OPEN, VALUE_HERE, VALUE_OF, VALUE_SHOW_AS } from '../../../src/shared/ast/notation.ts';

/** Names caught in samples before (titles, pen names, cast, readings) — extend, never prune. */
const BANNED = ['あの秋にて', '浅霧未発', '夜霧の姫', '神木', '境無', '黒剣', '朝霧', '巳一', 'みはつ', 'Arill', 'Stains'];

/** Directories with no repository text: dependencies, build output, git, local tooling, binaries. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '.git', '.scratch', '.claude', '.astro', '.cache', 'docs/images', 'media/codicon']);
const SKIP_FILES = new Set(['package-lock.json']);
const BINARY = /\.(png|jpe?g|gif|ico|svg|webp|avif|ttf|otf|woff2?|vsix|pdf)$/u;

const ROOT = fileURLToPath(REPO_ROOT);
const relPath = (path: string): string => relative(ROOT, path).replaceAll('\\', '/');
/** This file spells the banned names on purpose. */
const SELF = relPath(fileURLToPath(import.meta.url));

function* textFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !SKIP_DIRS.has(relPath(path))) {
        yield* textFiles(path);
      }
    } else if (entry.isFile() && !SKIP_FILES.has(entry.name) && !BINARY.test(entry.name)) {
      yield path;
    }
  }
}

test('no previously caught name appears anywhere in the repository text', () => {
  const hits: string[] = [];
  for (const path of textFiles(ROOT)) {
    const rel = relPath(path);
    if (rel === SELF) {
      continue;
    }
    const text = readFileSync(path, 'utf8');
    for (const name of BANNED) {
      if (text.includes(name)) {
        hits.push(`${rel}: ${name}`);
      }
    }
  }
  assert.deepEqual(hits, [], 'replace with the placeholders in CLAUDE.md');
});

/** Docs whose `.jpbook` samples readers copy. */
const DOC_SAMPLES = ['README.md', 'README.en.md', 'docs/SCREENSHOTS.md', 'media/walkthrough/book.md', 'media/walkthrough/build.md', 'media/walkthrough/highlight.md'];
/** A value annotation (［＃ここに「…」の値を表示］, with or without a 〇〇で format): it names nobody, so a sample may carry any number. */
const VALUE_ANNOTATION = new RegExp(
  `${ANNOTATION_OPEN}${VALUE_HERE}${CORNER_OPEN}[^${CORNER_CLOSE}]+${CORNER_CLOSE}${VALUE_OF}(?:[^${ANNOTATION_CLOSE}]*${VALUE_SHOW_AS}|表示)${ANNOTATION_CLOSE}`,
  'gu',
);
/** A sample title / author / header / footer with its value annotations and their separators set aside: a placeholder word, optionally with a volume suffix (第一巻 / 一 / その一). */
const PLACEHOLDER_VALUE = /^(作品名|ペンネーム|作品集|My 作品集|みんな)(　.+)?$/u;
const bareValue = (value: string): string => value.replace(VALUE_ANNOTATION, '').replace(/^[\s　/／]+|[\s　/／]+$/gu, '');
/** A sample character or keyword (a `- ` item that is no `.jpnov` path, or the value of `characters:`/`keywords:`):
 *  the placeholder names, with their readings in any of the notation's forms. */
const PLACEHOLDER_NAME = /^(｜?山田(《やまだ》)?[ 　｜]?(太郎|花子)(《(たろう|はなこ|やまだたろう|やまだはなこ)》)?|John Smith|王都(《おうと》)?|聖剣(《せいけん》)?)$/u;

test('docs .jpbook samples carry placeholder titles, authors, headers, footers, characters and keywords only (or none)', () => {
  const offenders: string[] = [];
  for (const rel of DOC_SAMPLES) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    let fenced = false; // only a code block holds a sample; a Markdown bullet is prose
    for (const [i, line] of lines.entries()) {
      if (line.startsWith('```')) {
        fenced = !fenced;
        continue;
      }
      const m = /^(title|author|header|footer):\s*(.*)$/u.exec(line);
      const bare = bareValue(m?.[2] ?? '');
      if (m !== null && bare !== '' && !PLACEHOLDER_VALUE.test(bare)) {
        offenders.push(`${rel}:${String(i + 1)}: ${line}`);
      }
      const item = /^\s*(?:[-－]|characters:|keywords:)\s*(\S.*?)\s*$/u.exec(line);
      if (fenced && item !== null && line.trim() !== '---' && !/\.jpnov$/iu.test(item[1] ?? '') && !PLACEHOLDER_NAME.test(item[1] ?? '')) {
        offenders.push(`${rel}:${String(i + 1)}: ${line}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'sample values must be placeholders (CLAUDE.md)');
});
