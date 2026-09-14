import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';

import { readSiteText, sitePath } from '../../scripts/root.ts';

test('stage components carry no Japanese literals (all text flows through the data modules)', async () => {
  for (const name of await readdir(sitePath('src/components/stage'))) {
    const text = await readSiteText(`src/components/stage/${name}`);
    const m = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.exec(text);
    assert.equal(m, null, `${name} contains a Japanese literal near: ${text.slice(Math.max(0, (m?.index ?? 0) - 30), (m?.index ?? 0) + 10)}`);
  }
});
