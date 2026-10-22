/**
 * `jpnov.preview.pickFont` (also the layout widget's font button): the 本文 font from a list of
 * 明朝 families, a typed CSS font list, or the built-in stack again, written to
 * `jpnov.layout.fontFamily` in the user or workspace settings the author picks. The write's change
 * event re-renders the preview; the HTML build reads the same key.
 */
import * as vscode from 'vscode';

import { isFontList } from '#/shared/compiler/css.ts';

import { saveSettings } from './settingsTarget.ts';

const FONT_KEY = 'jpnov.layout.fontFamily';
/** The setting's own example, shown wherever a list is asked for. */
const FONT_EXAMPLE = '"Yu Mincho", serif';

/** The scopes this picker writes, each with the `inspect()` field that says the key is written there. */
const WRITTEN_SCOPES = [
  ['workspaceValue', vscode.ConfigurationTarget.Workspace],
  ['globalValue', vscode.ConfigurationTarget.Global],
] as const;

/** `value`: the font list to write; `null` for the default (the key removed); absent for the typed list, asked next. */
type FontItem = vscode.QuickPickItem & { readonly value?: string | null };

export async function pickFont(): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  // The families on offer: each a font list that ends in the generic serif, as the setting's own
  // example does. The two with a Japanese name are localized; the other two are product names.
  const families: readonly [string, string][] = [
    [vscode.l10n.t('Hiragino Mincho'), '"Hiragino Mincho ProN", serif'],
    [vscode.l10n.t('Yu Mincho'), '"Yu Mincho", "YuMincho", serif'],
    ['Noto Serif JP', '"Noto Serif JP", "Noto Serif CJK JP", serif'],
    ['BIZ UDMincho', '"BIZ UDMincho", serif'],
  ];
  const items: FontItem[] = [
    ...families.map(([label, value]): FontItem => ({ label, description: value, value })),
    { label: vscode.l10n.t('Custom font…') },
    { label: vscode.l10n.t('Restore default'), description: vscode.l10n.t('The default Mincho stack'), value: null },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Body font'),
    placeHolder: vscode.l10n.t('Select the body font'),
  });
  if (pick === undefined) {
    return;
  }
  if (pick.value === null) {
    // The key goes from every scope that holds it: removed from one, the other would still apply.
    const scopes = config.inspect<string>(FONT_KEY);
    for (const [field, target] of WRITTEN_SCOPES) {
      if (scopes?.[field] !== undefined) {
        await config.update(FONT_KEY, undefined, target);
      }
    }
    return;
  }
  let value = pick.value;
  if (value === undefined) {
    const typed = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('A CSS font-family list, for example: {0}', FONT_EXAMPLE),
      value: config.get<string>(FONT_KEY, ''),
      placeHolder: FONT_EXAMPLE,
      validateInput: (v) => (isFontList(v) ? null : vscode.l10n.t('Enter a CSS font-family list, for example: {0}', FONT_EXAMPLE)),
    });
    if (typed === undefined) {
      return;
    }
    value = typed.trim();
  }
  await saveSettings([[FONT_KEY, value]]);
}
