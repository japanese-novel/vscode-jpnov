import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Writes `path` iff its content changed (parent folders created); returns whether a write happened. */
export async function writeIfChanged(path: string, next: string): Promise<boolean> {
  let prev: string | undefined;
  try {
    prev = await readFile(path, 'utf8');
  } catch {
    prev = undefined;
  }
  if (prev === next) {
    return false;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
  return true;
}
