/**
 * Answers the server's `jpnov/readText`: bytes from DISK (a build never sees the dirty buffer),
 * the encoding from the editor. An open document decodes with its own encoding, so "Reopen with
 * Encoding" holds; a closed file takes VS Code's choice for its uri (`files.encoding`,
 * `files.autoGuessEncoding`, a byte order mark).
 */
import * as vscode from 'vscode';

import { errorText } from '#/shared/errors.ts';
import type { ReadTextParams, ReadTextResult } from '#/shared/protocol.ts';

/** `FileSystemError.code` of a rejection ('FileNotFound', 'NoPermissions', …), '' for anything else. */
function fsCode(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : '';
}

export async function readText(params: ReadTextParams): Promise<ReadTextResult> {
  const uri = vscode.Uri.parse(params.uri);
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (err) {
    return { ok: false, reason: fsCode(err) === 'FileNotFound' ? 'notFound' : 'other', why: errorText(err) };
  }
  // #76: server URIs equal `Uri.toString()`, so the open-document lookup is a plain string compare.
  const key = uri.toString();
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === key);
  try {
    const text = await (open === undefined
      ? vscode.workspace.decode(bytes, { uri })
      : vscode.workspace.decode(bytes, { encoding: open.encoding }));
    return { ok: true, text };
  } catch (err) {
    // VS Code's decoder refuses binary content; anything else decodes, substitution characters included.
    return { ok: false, reason: 'notText', why: errorText(err) };
  }
}
