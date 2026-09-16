import type { MsgCode } from '#/shared/protocol.ts';

import { encodeRelPath } from '../uri.ts';

/** Failure of {@link resolveContained}: the `path.*` code. */
export interface ContainmentError {
  readonly ok: false;
  readonly code: MsgCode;
}

/**
 * True when the value names an absolute location a root-relative field must reject:
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

/**
 * Resolves a user-supplied relative path against a workspace-root URI, refusing any
 * value that escapes the root or names an absolute / home-relative location.
 *
 * Pure + vscode-free: `rootUri` and the returned `abs` are URI strings
 * (e.g. `file:///Users/x/proj`); `rel` is the plain path as written (a `.jpbook` entry, a
 * setting) and is percent-encoded here the way VS Code encodes a `Uri`, so `abs` matches the
 * client's strings. On success `abs` is guaranteed to be at or below `rootUri`. On failure it
 * returns a `path.*` {@link MsgCode}; the CLIENT renders the localized text (the server fills
 * the English diagnostic fallback).
 *
 * Rejected:
 * - `""` and whitespace-only
 * - `"."` (the root itself — a config field must name a *sub*path)
 * - any `..` segment that would climb above the root
 * - absolute paths (`/foo`, `C:\foo`, `\\server\share`, or a `scheme:` URI)
 * - a leading `~` (home-relative)
 */
export function resolveContained(rootUri: string, rel: string): { ok: true; abs: string } | ContainmentError {
  const trimmed = rel.trim();

  if (trimmed === '') {
    return { ok: false, code: 'path.empty' };
  }
  if (trimmed === '.') {
    return { ok: false, code: 'path.rootDot' };
  }
  if (trimmed.startsWith('~')) {
    return { ok: false, code: 'path.homeRelative' };
  }

  if (isAbsoluteLocation(trimmed)) {
    return { ok: false, code: 'path.absolute' };
  }

  // Resolve against the root using URL semantics (handles ./ and ../ collapsing). A trailing
  // slash on the base makes the relative path resolve *inside* the root. The path is encoded
  // first, so `#` `?` `%` stay in the name while `.`/`..` (unreserved) collapse as usual.
  const base = rootUri.endsWith('/') ? rootUri : `${rootUri}/`;
  let resolved: URL;
  try {
    resolved = new URL(encodeRelPath(trimmed.split('\\').join('/')), base);
  } catch {
    return { ok: false, code: 'path.invalid' }; // a lone surrogate fails the encoding
  }

  const baseUrl = new URL(base);
  // The root path in both spellings (with/without the trailing slash), derived once for the
  // two checks below. `base` ends with '/', so `pathname` normally does too.
  const rootDir = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`;
  const rootPath = rootDir.slice(0, -1);

  // Containment: same origin/scheme, and the resolved path is at or under the base.
  if (
    resolved.protocol !== baseUrl.protocol ||
    resolved.host !== baseUrl.host ||
    !(resolved.pathname === rootPath || resolved.pathname.startsWith(rootDir))
  ) {
    return { ok: false, code: 'path.escapesRoot' };
  }

  // Equal to the root after collapsing (e.g. "foo/..") is also a rejection: a config
  // field must name a real subpath. (Shares `path.rootDot` with the literal "." case.)
  if (resolved.pathname === rootPath || resolved.pathname === rootDir) {
    return { ok: false, code: 'path.rootDot' };
  }

  return { ok: true, abs: resolved.href.replace(/\/$/, '') };
}
