/**
 * The single command boundary: every `registerCommand` goes through {@link command}, so an
 * unexpected throw (sync or async) becomes ONE localized error popup instead of a silently
 * dropped rejection. A handler that shows its own popup returns without rethrowing.
 */
import * as vscode from 'vscode';

import { errorText } from '#/shared/utils/errors.ts';

/** Runs `run`; an unexpected throw (sync or async) becomes one localized error popup. */
export async function guarded(run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
  } catch (err) {
    const m = errorText(err);
    // The last-resort popup itself never rejects; void it so this catch can't re-throw.
    void vscode.window.showErrorMessage(vscode.l10n.t('Japanese Novel: {0}', m));
  }
}

/** Registers `id` with a body shielded by {@link guarded}; command arguments flow through untouched. */
export function command(id: string, run: (...args: unknown[]) => Promise<void> | void): vscode.Disposable {
  return vscode.commands.registerCommand(id, (...args: unknown[]) => guarded(() => run(...args)));
}
