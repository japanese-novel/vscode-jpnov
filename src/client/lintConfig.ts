/**
 * Snapshots the user's `jpnov.lint.*` settings into the flat, IPC-safe map the (vscode-free) server
 * resolves with `selectRules()`, which decides per rule kind what counts as enabled. An unset key is
 * omitted; the server reads an absent key as off.
 *
 * Read at default (resource-less) scope: there are no folder-level lint overrides.
 */
import * as vscode from 'vscode';

import { allSettingKeys } from '#/shared/lint/catalog.ts';
import type { RawLintConfigWire } from '#/shared/protocol.ts';

export function buildLintSnapshot(): RawLintConfigWire {
  const config = vscode.workspace.getConfiguration();
  const snapshot: Record<string, unknown> = {};
  for (const key of allSettingKeys()) {
    const value: unknown = config.get(key);
    if (value !== undefined) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}
