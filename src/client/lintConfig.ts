/**
 * Snapshots the user's `jpnov.lint.*` settings into the flat, IPC-safe map the (vscode-free) server
 * resolves with `selectRules()`. Only ENABLED rules ride the wire — a `false` boolean or a `null`
 * threshold is simply omitted, since the server treats an absent key as "off" identically.
 *
 * Read at default (resource-less) scope: there are no folder-level lint overrides.
 */
import * as vscode from 'vscode';

import { allSettingKeys } from '#/shared/lint/catalog.ts';
import { lintWireValue } from '#/shared/lint/wire.ts';
import type { RawLintConfigWire } from '#/shared/protocol.ts';

export function buildLintSnapshot(): RawLintConfigWire {
  const config = vscode.workspace.getConfiguration();
  const snapshot: Record<string, boolean | number | string> = {};
  for (const key of allSettingKeys()) {
    const value = lintWireValue(config.get(key));
    if (value !== undefined) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}
