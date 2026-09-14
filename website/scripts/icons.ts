/**
 * `npm run icons`: copies the codicon glyphs the stage draws (VS Code's icon set, CC BY 4.0;
 * credited in the site footer) out of the package's per-icon SVG sources into
 * src/generated/icons.json, so the page inlines a handful of paths instead of the icon font.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeIfChanged } from '../../scripts/write.ts';
import { sitePath } from './root.ts';

export const CODICONS = [
  'files', 'search', 'source-control', 'debug-alt', 'extensions', 'account', 'settings-gear', 'refresh',
  'chevron-left', 'chevron-right', 'chevron-down', 'chevron-up', 'close', 'gripper', 'checklist', 'new-file',
  'edit', 'open-preview', 'split-horizontal', 'ellipsis', 'lightbulb', 'lightbulb-autofix', 'warning', 'error',
  'check', 'bell', 'remote',
] as const;

/** Each glyph keeps its own grid: most codicons are 16×16, the activity-bar set is 24×24. */
export interface Icon {
  readonly viewBox: string;
  readonly inner: string;
}

const iconsDir = join(dirname(fileURLToPath(import.meta.resolve('@vscode/codicons/package.json'))), 'src', 'icons');
const icons: Readonly<Record<string, Icon>> = Object.fromEntries(await Promise.all(CODICONS.map(async (id) => {
  const svg = await readFile(join(iconsDir, `${id}.svg`), 'utf8');
  const m = /<svg[^>]*viewBox="([^"]+)"[^>]*>([\s\S]*?)<\/svg>/.exec(svg);
  if (m?.[1] === undefined || m[2] === undefined) {
    throw new Error(`icons: codicon "${id}" has no viewBox`);
  }
  return [id, { viewBox: m[1], inner: m[2].trim() }] as const;
})));
const out = sitePath('src/generated/icons.json');
console.log(`${(await writeIfChanged(out, `${JSON.stringify(icons, null, 1)}\n`)) ? 'wrote' : 'unchanged'} ${out}`);
