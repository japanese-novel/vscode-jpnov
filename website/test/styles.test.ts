/** The stylesheets carry the values the scripts share with them (src/styles/tokens.ts) and the product's font stack. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_FONT_STACK } from '../../src/shared/compiler/css.ts';
import { readSiteText } from '../scripts/root.ts';
import { MOTION_QUERY, REVEAL_QUERY, SPLIT_EDITOR_WIDTH } from '../src/styles/tokens.ts';

test('the Mincho stack is the product’s default stack', async () => {
  assert.ok((await readSiteText('src/styles/global.css')).includes(`--font-mincho: ${DEFAULT_FONT_STACK};`));
});

test('the stylesheets gate motion and size the split editor with the scripts’ values', async () => {
  assert.ok((await readSiteText('src/styles/stage.css')).includes(`@media ${MOTION_QUERY} {`), 'stage.css MOTION_QUERY');
  assert.ok((await readSiteText('src/styles/global.css')).includes(`@media ${REVEAL_QUERY} {`), 'global.css REVEAL_QUERY');
  assert.ok((await readSiteText('src/styles/window.css')).includes(`.jp-editors.jp-split .jp-group.jp-editor { flex: 0 0 ${SPLIT_EDITOR_WIDTH};`), 'window.css SPLIT_EDITOR_WIDTH');
});
