/**
 * Client-side renderer for server-origin {@link LocalizableMessage}s (build errors, config-state
 * errors, and — via the diagnostic middleware in `extension.ts` — diagnostics). The English
 * template is the l10n bundle key; Japanese lives in `l10n/bundle.l10n.ja.json`.
 */
import * as vscode from 'vscode';

import { SLOT_COUNTS, TEMPLATES } from '#/shared/messages.ts';
import type { LocalizableMessage } from '#/shared/protocol.ts';
import { isRecord } from '#/shared/utils/guards.ts';

/** Runtime guard for an `LSPAny` (a Diagnostic's `data`, or a custom-payload field). */
export function isLocalizableMessage(value: unknown): value is LocalizableMessage {
  return isRecord(value) && typeof value.code === 'string';
}

/** Render a server {@link LocalizableMessage} to localized UI text: the shared template, resolved by
 *  the ja bundle, every `{n}` slot filled (a slot with no argument renders as ''). */
export function renderMessage(msg: LocalizableMessage): string {
  const args = msg.args ?? [];
  const slots = Array.from({ length: Math.max(args.length, SLOT_COUNTS[msg.code]) }, (_, i) => String(args[i] ?? ''));
  return vscode.l10n.t(TEMPLATES[msg.code], ...slots);
}
