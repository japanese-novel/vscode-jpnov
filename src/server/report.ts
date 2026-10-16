/**
 * Server-side error reporting: an unexpected failure becomes a `jpnov/serverError` notification
 * the CLIENT renders (`renderMessage()`) and shows as an error popup — the forked server is
 * vscode-free and reaches the `Connection` only through {@link ServerContext}.
 */
import { errorText } from '#/shared/utils/errors.ts';
import { LocalizedError } from '#/shared/messages.ts';
import { ServerErrorNotification } from '#/shared/protocol.ts';
import type { LocalizableMessage, ServerErrorParams } from '#/shared/protocol.ts';

import type { ServerContext } from './context.ts';

/**
 * A {@link LocalizedError} forwards its code verbatim; anything else is wrapped as
 * `server.unexpected` with the raw detail. Never throws: `sendNotification` rejects only on a
 * dead connection, so its promise is dropped — call sites report from a synchronous `catch`.
 */
export function reportError(ctx: ServerContext, err: unknown): void {
  const message: LocalizableMessage = err instanceof LocalizedError
    ? err.localized
    : { code: 'server.unexpected', args: [errorText(err)] };
  void ctx.connection.sendNotification(ServerErrorNotification, { message } satisfies ServerErrorParams);
}
