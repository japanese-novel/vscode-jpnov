/**
 * No specific work titles, author names, cast names, or cover/synopsis prose anywhere in the
 * repository text — every sample uses the placeholders in CLAUDE.md (作品名 / ペンネーム / 山田　太郎 /
 * John Smith / 王都 …). A novelist who meets a made-up title or a real pen name in the extension
 * asks whose manuscript it ships with; that question must never come up. Two checks: the names
 * that slipped in before stay out, and every docs front-matter sample carries a placeholder value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from '../repo.ts';

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

/** Docs whose fenced `.jpbook` samples readers copy. */
const DOC_SAMPLES = ['README.md', 'README.en.md', 'docs/SCREENSHOTS.md', 'media/walkthrough/build.md'];
/** A sample title / author / header: a placeholder word, optionally with a volume suffix (第一巻 / 一 / その一). */
const PLACEHOLDER_VALUE = /^(作品名|ペンネーム|作品集|My 作品集|みんな)(　.+)?$/u;

test('docs front-matter samples carry placeholder titles, authors and headers only', () => {
  const offenders: string[] = [];
  for (const rel of DOC_SAMPLES) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      const m = /^(title|author|header):\s*(.*)$/u.exec(line);
      if (m !== null && !PLACEHOLDER_VALUE.test(m[2] ?? '')) {
        offenders.push(`${rel}:${String(i + 1)}: ${line}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'sample values must be placeholders (CLAUDE.md)');
});
