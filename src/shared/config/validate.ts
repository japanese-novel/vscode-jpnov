import { encodeRelPath, pathSegments } from '../uri.ts';

/**
 * True when the value names an absolute location a relative field must reject:
 * a POSIX `/…` path, a Windows drive or UNC path, or a full `scheme:` URI. Shared with
 * the panel's file-name input so the two ends of the pipeline can't drift.
 */
export function isAbsoluteLocation(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)
  );
}

/** The `outDir` prefix that counts from the book's workspace folder instead of its own directory. */
export const WORKSPACE_FOLDER_TOKEN = '${workspaceFolder}';

/** A validated `jpnov.layout.outDir`: the relative path and the directory it counts from. */
export interface OutDir {
  /** True for a `${workspaceFolder}/…` value: `rel` counts from the book's workspace folder (its own directory when it has none). */
  readonly fromRoot: boolean;
  /** Segments collapsed, `/`-separated, not encoded, `../` kept (`../dist` gathers a folder's books one level up); `''` = the base folder itself (`.`). */
  readonly rel: string;
}

/** The product default: the `dist` of the book's workspace folder. `PROJECT_DEFAULT.outDir` spells it as a setting value. */
export const OUT_DIR_DEFAULT: OutDir = { fromRoot: true, rel: 'dist' };

/**
 * A configured project dir (`jpnov.layout.outDir`) as the server joins it. Null when it names no
 * folder: empty, absolute, `~`-relative, or text no URI can carry (a lone surrogate). `.` and
 * `${workspaceFolder}` alone are folders like any other: the output lands beside the book, or in
 * its workspace folder.
 */
export function outDirSubpath(value: string): OutDir | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const fromRoot = trimmed.startsWith(WORKSPACE_FOLDER_TOKEN);
  const rest = fromRoot ? trimmed.slice(WORKSPACE_FOLDER_TOKEN.length).replace(/^[\\/]+/, '') : trimmed;
  if (rest.startsWith('~') || isAbsoluteLocation(rest)) {
    return null;
  }
  const rel = pathSegments(rest).join('/');
  try {
    encodeRelPath(rel);
  } catch {
    return null;
  }
  return { fromRoot, rel };
}
