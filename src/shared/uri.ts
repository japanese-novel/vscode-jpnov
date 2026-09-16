/**
 * Percent-encoding for the file URIs the server composes from raw names (dirents, `.jpbook`
 * entries, output paths). It mirrors `vscode.Uri.toString()`: everything outside RFC 3986's
 * unreserved set (https://www.rfc-editor.org/rfc/rfc3986#section-2.3) is escaped as UTF-8 with
 * uppercase hex, so a URI built here equals the one the client gets from `Uri.joinPath`.
 */

/** One path segment, percent-encoded; throws `URIError` on a lone surrogate (as `encodeURIComponent` does). */
export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A `/`-separated relative path with every segment percent-encoded; `.` and `..` pass through unchanged. */
export function encodeRelPath(rel: string): string {
  return rel.split('/').map(encodePathSegment).join('/');
}
