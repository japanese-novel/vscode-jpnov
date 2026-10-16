/**
 * Puts a request behind the open of the document it names. The language client writes a request
 * the moment its start resolves, but the start's own didOpen for every visible open document waits
 * on that same start, behind the request. The request middleware runs after the start, once those
 * opens are recorded, so waiting there for the document's open puts the open on the wire first.
 */
import type { Middleware } from 'vscode-languageclient/node';

import { isRecord } from '#/shared/utils/guards.ts';

export type DocumentSync = Required<Pick<Middleware, 'didOpen' | 'didClose' | 'sendRequest'>>;

/** The params of jpnov's own document requests name the document by a top-level `uri`. */
function documentUri(param: unknown): string | undefined {
  return isRecord(param) && typeof param.uri === 'string' ? param.uri : undefined;
}

export function documentSync(): DocumentSync {
  /** The open the client last sent for each document, by uri; gone once it closed. */
  const opened = new Map<string, Promise<void>>();
  return {
    didOpen: (document, next) => {
      const sent = next(document);
      opened.set(document.uri.toString(), sent);
      return sent;
    },
    didClose: (document, next) => {
      opened.delete(document.uri.toString());
      return next(document);
    },
    async sendRequest(type, param, token, next) {
      const uri = documentUri(param);
      if (uri !== undefined) {
        await opened.get(uri);
      }
      return next(type, param, token);
    },
  };
}
