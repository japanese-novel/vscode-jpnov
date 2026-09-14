import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';

import { collectGlyphs, unicodeRanges } from '../scripts/glyphs.ts';
import { sitePath } from '../scripts/root.ts';

const sidecar = JSON.parse(await readFile(sitePath('public/fonts/subset.json'), 'utf8')) as { chars: string };
const covered = new Set(sidecar.chars);

test('the committed Noto Serif JP subset covers every character the site can show', async () => {
  const missing = Array.from(await collectGlyphs()).filter((ch) => !covered.has(ch));
  assert.deepEqual(missing, [], `run "npm run fonts" — missing: ${missing.join('')}`);
});

test('fonts.css declares the subset with the sidecar’s unicode-range and the files exist', async () => {
  const css = await readFile(sitePath('src/styles/fonts.css'), 'utf8');
  assert.ok(css.includes(`unicode-range: ${unicodeRanges(sidecar.chars)};`));
  for (const wght of [400, 700]) {
    assert.ok(css.includes(`/fonts/NotoSerifJP-${String(wght)}.woff2`));
    const { size } = await stat(sitePath(`public/fonts/NotoSerifJP-${String(wght)}.woff2`));
    assert.ok(size > 10_000 && size < 400_000, `NotoSerifJP-${String(wght)}.woff2 is ${String(size)} bytes`);
  }
});
