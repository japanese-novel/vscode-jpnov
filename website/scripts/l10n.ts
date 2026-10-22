/**
 * The extension's Japanese bundle, looked up by the English template exactly as the extension
 * does: a key the bundle lacks is an error, never a silent fallback to English.
 */
import { readRootText } from './root.ts';

const BUNDLE = JSON.parse(await readRootText('l10n/bundle.l10n.ja.json')) as Readonly<Record<string, string>>;

/** The Japanese of `key`, its `{n}` slots filled from `args`. */
export function ja(key: string, ...args: readonly string[]): string {
  const template = BUNDLE[key];
  if (template === undefined) {
    throw new Error(`l10n: no Japanese text for "${key}"`);
  }
  return template.replace(/\{(\d)\}/g, (_m, i: string) => args[Number(i)] ?? '');
}
