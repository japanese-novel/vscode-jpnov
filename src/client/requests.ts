/**
 * Guards around LanguageClient requests. `$/cancelRequest` only ASKS the server to stop —
 * the LSP reply still waits on the handler — so a caller that must not hang races the
 * request against its token and a plain-timer cap (never a wire/fs dependency).
 */
import * as vscode from 'vscode';

import { errorText } from '#/shared/utils/errors.ts';

/**
 * A request under its own cap: `send` gets a fresh token, the reply is raced against `timeoutMs`,
 * and a failure cancels the request on the server too (a timed-out one would otherwise run on).
 */
export async function cappedRequest<T>(
  send: (token: vscode.CancellationToken) => Thenable<T>,
  timeoutMs: number,
): Promise<T> {
  const cancel = new vscode.CancellationTokenSource();
  try {
    return await raceRequest(send(cancel.token), cancel.token, timeoutMs);
  } catch (err) {
    cancel.cancel();
    throw err;
  } finally {
    cancel.dispose();
  }
}

/**
 * Settles with `request`, or rejects when `token` cancels or `timeoutMs` passes first.
 * The abandoned request's later settlement is observed here, so it can never surface as
 * an unhandled rejection.
 */
export function raceRequest<T>(
  request: Thenable<T>,
  token: vscode.CancellationToken,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let sub: vscode.Disposable | undefined;
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`no reply from the language server within ${String(timeoutMs / 1000)}s`));
    }, timeoutMs);
    function finish(): void {
      clearTimeout(timer);
      sub?.dispose();
    }
    // An already-cancelled token may fire its listener synchronously INSIDE the subscribe
    // call (before `sub` exists) — branch on the flag instead of relying on the event.
    if (token.isCancellationRequested) {
      finish();
      reject(new Error('cancelled'));
    } else {
      sub = token.onCancellationRequested(() => {
        finish();
        reject(new Error('cancelled'));
      });
    }
    request.then(
      (value) => {
        finish();
        resolve(value);
      },
      (err: unknown) => {
        finish();
        reject(err instanceof Error ? err : new Error(errorText(err)));
      },
    );
  });
}
