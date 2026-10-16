/**
 * The single command boundary: every `registerCommand` goes through {@link command}, so an
 * unexpected throw (sync or async) becomes ONE localized error popup instead of a silently
 * dropped rejection. A handler that shows its own popup returns without rethrowing.
 */
import * as vscode from 'vscode';

import { errorText } from '#/shared/utils/errors.ts';

/** Registers `id` with a body shielded by one try/catch; command arguments flow through untouched. */
export function command(id: string, run: (...args: unknown[]) => Promise<void> | void): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (...args: unknown[]) => {
    try {
      await run(...args);
    } catch (err) {
      const m = errorText(err);
      // The last-resort popup itself never rejects; void it so this catch can't re-throw.
      void vscode.window.showErrorMessage(vscode.l10n.t('Japanese Novel: {0}', m));
    }
  });
}
