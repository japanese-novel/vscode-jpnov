/**
 * Tiny URI string helpers for the server's filesystem seams (build, jpbook, the vocabulary
 * store, server.ts). PURE string ops over `#/shared/utils/uri.ts`: no `node:fs`, no
 * `vscode-languageserver`, so any server module can pull it in.
 *
 * Scheme handling is deliberately a prefix test, not URL parsing: the server only ever
 * distinguishes `file:` (real disk via `node:fs`) from "anything else" (virtual fs over the
 * client bridge). Root and document URIs arrive already encoded from the LSP/vscode layer; the
 * names this module appends to them are raw (dirents, `.jpbook` entries, output paths) and get
 * that same encoding.
 */
import { encodeRelPath } from '#/shared/utils/uri.ts';

/** True iff `uri` is on the `file:` scheme (the only scheme the server reads via `node:fs`). */
export function isFileScheme(uri: string): boolean {
  return uri.startsWith('file:');
}

/** Joins a directory URI and a raw relative path (a dirent name, `part1/vol2.txt`) into a percent-encoded child URI. */
export function childUri(dirUri: string, rel: string): string {
  const encoded = encodeRelPath(rel);
  return dirUri.endsWith('/') ? `${dirUri}${encoded}` : `${dirUri}/${encoded}`;
}

/** The directory URI a file URI sits in (everything before its last `/`). */
export function parentUri(uri: string): string {
  return uri.slice(0, uri.lastIndexOf('/'));
}

/**
 * A URI as a key for "the same file": no trailing slash, percent-decoded, NFC — the disk may hold
 * a name decomposed where the editor holds it composed (as `dirKey` in build.ts keys fs paths).
 */
export function uriKey(uri: string): string {
  const bare = normalizeRootUri(uri);
  try {
    return decodeURIComponent(bare).normalize('NFC');
  } catch {
    return bare;
  }
}

/** The last segment of a URI, percent-decoded: the raw file name. */
export function baseName(uri: string): string {
  return decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1));
}

/**
 * `rel` (a book entry or a path prefix as written: `/`-separated, `.`/`..` allowed, nothing
 * bounding it) resolved from `dirUri` by URL rules, encoded like the client's `Uri` strings;
 * null when it cannot be encoded (a lone surrogate).
 */
export function resolveUri(dirUri: string, rel: string): string | null {
  try {
    return new URL(encodeRelPath(rel), dirUri.endsWith('/') ? dirUri : `${dirUri}/`).href;
  } catch {
    return null;
  }
}

/** Strips a single trailing slash so root URIs compare/hash consistently. */
export function normalizeRootUri(uri: string): string {
  return uri.endsWith('/') ? uri.slice(0, -1) : uri;
}
