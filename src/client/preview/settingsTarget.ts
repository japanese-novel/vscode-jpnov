/**
 * A widget's write of `jpnov.*` settings: the author picks where it goes, the user settings
 * (always offered) or the open folder's workspace settings, and the entries are written there.
 * The user item says so when a workspace value of one of the keys would still take precedence.
 * A dismissed pick writes nothing.
 */
import * as vscode from 'vscode';

export async function saveSettings(entries: readonly (readonly [key: string, value: unknown])[]): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const shadowed = entries.some(([key]) => {
    const scopes = config.inspect(key);
    return scopes?.workspaceValue !== undefined || scopes?.workspaceFolderValue !== undefined;
  });
  const items: (vscode.QuickPickItem & { readonly target: vscode.ConfigurationTarget })[] = [{
    label: vscode.l10n.t('User Settings'),
    description: vscode.l10n.t('Applies to every folder you open'),
    ...(shadowed ? { detail: vscode.l10n.t('A workspace setting already exists and takes precedence') } : {}),
    target: vscode.ConfigurationTarget.Global,
  }];
  if ((vscode.workspace.workspaceFolders ?? []).length > 0) {
    items.push({
      label: vscode.l10n.t('Workspace Settings'),
      description: vscode.l10n.t('Applies to the open folder only'),
      target: vscode.ConfigurationTarget.Workspace,
    });
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Select where to save') });
  if (pick === undefined) {
    return;
  }
  for (const [key, value] of entries) {
    await config.update(key, value, pick.target);
  }
}
