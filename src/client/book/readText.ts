/**
 * Answers the server's `jpnov/readText` with the text the editor shows: an open document's live
 * buffer (unsaved edits included, #87), else the disk decoded as VS Code would for the uri
 * (`files.encoding`, `files.autoGuessEncoding`, a byte order mark).
 */
import * as vscode from 'vscode';

import { errorText } from '#/shared/errors.ts';
import type { ReadTextParams, ReadTextResult } from '#/shared/protocol.ts';

/** `FileSystemError.code` of a rejection ('FileNotFound', 'NoPermissions', …), '' for anything else. */
function fsCode(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : '';
}

/**
 * The open document at `uri`: an exact `Uri.toString()` match (#76), else the same scheme,
 * authority and NFC-normalized `path` (an NFD file name against the NFC entry in the `.jpbook`;
 * `toString()` percent-encodes, so the compare runs on the decoded path).
 */
function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const docs = vscode.workspace.textDocuments;
  const key = uri.toString();
  const path = uri.path.normalize('NFC');
  return docs.find((doc) => doc.uri.toString() === key) ??
    docs.find((doc) =>
      doc.uri.scheme === uri.scheme && doc.uri.authority === uri.authority && doc.uri.path.normalize('NFC') === path);
}

export async function readText(params: ReadTextParams): Promise<ReadTextResult> {
  const uri = vscode.Uri.parse(params.uri);
  const open = openDocument(uri);
  if (open !== undefined) {
    return { ok: true, text: open.getText() };
  }
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (err) {
    return { ok: false, reason: fsCode(err) === 'FileNotFound' ? 'notFound' : 'other', why: errorText(err) };
  }
  try {
    return { ok: true, text: await vscode.workspace.decode(bytes, { uri }) };
  } catch (err) {
    // VS Code's decoder refuses binary content; anything else decodes, substitution characters included.
    return { ok: false, reason: 'notText', why: errorText(err) };
  }
}
