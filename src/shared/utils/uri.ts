/**
 * Path and file-URI string helpers, dependency-free. The percent-encoding mirrors
 * `vscode.Uri.toString()`: everything outside RFC 3986's unreserved set
 * (https://www.rfc-editor.org/rfc/rfc3986#section-2.3) is escaped as UTF-8 with uppercase hex, so
 * a URI the server composes from raw names equals the one the client gets from `Uri.joinPath`.
 */

/**
 * The segments of a relative path, either separator: `.` and empty ones (`a//b`, a trailing `/`)
 * dropped, a `..` folding the segment before it (a leading `..` stays, as in `../a`).
 */
export function pathSegments(path: string): string[] {
  const segments: string[] = [];
  for (const seg of path.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') {
      continue;
    }
    const last = segments[segments.length - 1];
    if (seg === '..' && last !== undefined && last !== '..') {
      segments.pop();
    } else {
      segments.push(seg);
    }
  }
  return segments;
}

/** One path segment, percent-encoded; throws `URIError` on a lone surrogate (as `encodeURIComponent` does). */
export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A `/`-separated relative path with every segment percent-encoded; `.` and `..` pass through unchanged. */
export function encodeRelPath(rel: string): string {
  return rel.split('/').map(encodePathSegment).join('/');
}
