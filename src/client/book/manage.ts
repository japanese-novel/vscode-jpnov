/**
 * The Books panel's management commands — form-style editing over the `.jpbook` TEXT.
 * Every action plans precise range edits via the pure `#/shared/book/edits.ts`, applies
 * them as one `WorkspaceEdit`, and SAVES immediately (settings-UI semantics: a panel
 * action persists on the spot; the saved file then re-enters through the panel's own
 * watcher, so no manual refresh plumbing exists here). Metadata is upsert-only: every
 * META_KEYS key is always shown and never deleted or reordered — layout-conscious authors
 * use code mode. Chapters and covers are the two entry lists; a list action takes an
 * `EntryList` and never touches the other list.
 */
import * as vscode from 'vscode';

import { COVER_TEMPLATE, normalizeFileInput } from '#/shared/book/create.ts';
import {
  appendEntries,
  entryLines,
  listedEntries,
  moveEntryTo,
  removeEntry,
  resolveEntry,
  upsertMeta,
} from '#/shared/book/edits.ts';
import type { TextReplace } from '#/shared/book/edits.ts';
import {
  composeDividerValue,
  DIVIDER_PRESETS,
  parseDividerValue,
  parseJpbook,
  type EntryList,
  type MetaKey,
  type ParsedLine,
} from '#/shared/book/jpbook.ts';
import { PAGE_NUMBER_POSITIONS, type PageNumberPosition } from '#/shared/compiler/chrome.ts';
import { BUILD_CHROME_DEFAULT } from '#/shared/config/settings.ts';
import { unencodableChars } from '#/shared/encoding.ts';
import { errorText } from '#/shared/errors.ts';
import type { BookEntry } from '#/shared/protocol.ts';

import { command } from '../commands.ts';
import { renderMessage } from '../messages.ts';
import { chapterUri, FIND_FILES_EXCLUDE, splitRelPath } from '../paths.ts';
import { normalizeFsPath } from './rename.ts';
import type { BookNode, EntryNode } from './nodes.ts';
import type { BooksViewProvider } from './view.ts';

/** Localized display name of a metadata key (the meta row's label and edit prompt). */
export function metaLabel(key: MetaKey): string {
  switch (key) {
    case 'title':
      return vscode.l10n.t('Title');
    case 'author':
      return vscode.l10n.t('Author');
    case 'header':
      return vscode.l10n.t('Header');
    case 'pageNumber':
      return vscode.l10n.t('Page Number');
    case 'pageNumberFormat':
      return vscode.l10n.t('Page Number Format');
    case 'divider':
      return vscode.l10n.t('Chapter Divider');
  }
}

/** Localized display of one folio-position member (QuickPick items and meta-row values). */
function positionLabel(value: PageNumberPosition): string {
  switch (value) {
    case 'right':
      return vscode.l10n.t('Always bottom-right');
    case 'left':
      return vscode.l10n.t('Always bottom-left');
    case 'rightLeft':
      return vscode.l10n.t('Alternate: right, then left');
    case 'leftRight':
      return vscode.l10n.t('Alternate: left, then right');
    case 'none':
      return vscode.l10n.t('No page number');
  }
}

/**
 * The meta row split into its bare display VALUE and a status NOTE (default / not-set), so the
 * panel can place the note beside the LABEL rather than inside the value: a set value carries no
 * note, an absent key with a default shows that default value tagged "(default)", and an absent
 * key with no default shows an empty value tagged "(not set)".
 */
export function metaValueParts(key: MetaKey, value: string | undefined): { value: string; note: string } {
  const display = (v: string): string => (key === 'pageNumber' ? positionLabel(v as PageNumberPosition) : v);
  if (value !== undefined) {
    return { value: display(value), note: '' };
  }
  if (key === 'title' || key === 'author' || key === 'divider') {
    return { value: '', note: vscode.l10n.t('(not set)') }; // no default: absent = simply not set
  }
  const fallback = BUILD_CHROME_DEFAULT[key];
  return fallback === ''
    ? { value: '', note: vscode.l10n.t('(not set)') }
    : { value: display(fallback), note: vscode.l10n.t('(default)') };
}

/** Applies planned replaces and saves — the panel's watcher does the refresh. */
export async function applyBookEdits(uri: vscode.Uri, replaces: readonly TextReplace[]): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  for (const r of replaces) {
    edit.replace(uri, new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character), r.newText);
  }
  if (await vscode.workspace.applyEdit(edit)) {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    await doc?.save();
  }
}

/** The book's live text (dirty buffer included) and its version — every planner starts from this. */
async function bookText(entry: BookEntry): Promise<{ uri: vscode.Uri; text: string; version: number }> {
  const uri = vscode.Uri.parse(entry.uri);
  const doc = await vscode.workspace.openTextDocument(uri);
  return { uri, text: doc.getText(), version: doc.version };
}

/** The line a row verb acts on, or null when the panel was stale (the text moved past the row's
 *  version, or that line no longer lists that path): nothing is planned, the provider's re-push
 *  shows the live rows. */
function rowLine(node: EntryNode, lines: readonly ParsedLine[], version: number): number | null {
  return version === node.version ? resolveEntry(lines, node.list, node) : null;
}

function nodeOf(arg: unknown): BookNode | null {
  return typeof arg === 'object' && arg !== null && 'kind' in arg ? (arg as BookNode) : null;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** The list-specific wording of the add / create flows; everything else is shared. */
function listText(list: EntryList): { placeHolder: string; noneLeft: string; alreadyIn: string; prompt: string } {
  if (list === 'chapters') {
    return {
      placeHolder: vscode.l10n.t('Select chapter files to add'),
      noneLeft: vscode.l10n.t('Japanese Novel: no chapter files left to add.'),
      alreadyIn: vscode.l10n.t('Japanese Novel: those chapters are already in this book.'),
      prompt: vscode.l10n.t('File name of the new chapter'),
    };
  }
  return {
    placeHolder: vscode.l10n.t('Select cover page files to add'),
    noneLeft: vscode.l10n.t('Japanese Novel: no cover page files left to add.'),
    alreadyIn: vscode.l10n.t('Japanese Novel: those cover pages are already in this book.'),
    prompt: vscode.l10n.t('File name of the new cover page'),
  };
}

/** The folder's `.jpnov` files as sorted root-relative paths (book entries are root-relative). */
async function findJpnovFiles(rootUri: vscode.Uri): Promise<string[]> {
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(rootUri, '**/*.jpnov'), FIND_FILES_EXCLUDE);
  return found.map((uri) => normalizeFsPath(vscode.workspace.asRelativePath(uri, false))).sort();
}

/**
 * The multi-select file picker (add-files). Preserves the QuickPick distinction:
 * Esc = undefined, OK with none ticked = [].
 */
async function pickFiles(rels: readonly string[], placeHolder: string): Promise<string[] | undefined> {
  type FileItem = vscode.QuickPickItem & { rel: string };
  const items = rels.map((rel): FileItem => {
    const { name, dir } = splitRelPath(rel);
    return dir === '' ? { label: name, rel } : { label: name, description: dir, rel };
  });
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    matchOnDescription: true,
    placeHolder,
  });
  return picked?.map((p) => p.rel);
}

async function addFiles(arg: unknown): Promise<void> {
  const node = nodeOf(arg);
  if (node?.kind !== 'list') {
    return;
  }
  const wording = listText(node.list);
  // Entries are root-relative, so candidates come from THIS book's workspace folder only.
  const candidates = await findJpnovFiles(vscode.Uri.parse(node.entry.rootUri));
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('Japanese Novel: no .jpnov files found in this workspace folder.'));
    return;
  }

  // The lists dedupe independently: a file that is already a chapter may still become a cover.
  const listed = listedEntries(parseJpbook((await bookText(node.entry)).text).lines, node.list);
  const fresh = candidates.filter((rel) => !listed.has(rel));
  if (fresh.length === 0) {
    void vscode.window.showInformationMessage(wording.noneLeft);
    return;
  }

  const picked = await pickFiles(fresh, wording.placeHolder);
  if (picked === undefined || picked.length === 0) {
    return;
  }

  // Re-read AFTER the pick: the book may have changed while the picker was open, and the
  // edit must anchor to the live text (appendEntries re-dedupes against it too).
  const { uri, text } = await bookText(node.entry);
  const edit = appendEntries(text, node.list, picked);
  if (edit === null) {
    void vscode.window.showInformationMessage(wording.alreadyIn);
    return;
  }
  await applyBookEdits(uri, [edit]);
}

/** The book-mode target folder: the single workspace folder, or a pick between several. */
async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) {
    return folders[0];
  }
  return vscode.window.showWorkspaceFolderPick({
    placeHolder: vscode.l10n.t('Select a folder for the new book'),
    ignoreFocusOut: true,
  });
}

/**
 * The parked-suffix input box. Caret at 0, `suffix` after it: typing (IME composition
 * included) inserts before the suffix, so the value is never rewritten mid-composition.
 * Returns the normalized root-relative path; undefined = dismissed or unusable.
 */
async function promptNewFile(rootUri: string, suffix: string, prompt: string): Promise<string | undefined> {
  const raw = await vscode.window.showInputBox({
    prompt,
    value: suffix,
    valueSelection: [0, 0],
    ignoreFocusOut: true,
    validateInput: async (value) => {
      const parsed = normalizeFileInput(value, suffix);
      if (!parsed.ok) {
        return parsed.error === 'empty'
          ? vscode.l10n.t('Enter a file name')
          : vscode.l10n.t('This file name cannot be used');
      }
      return (await fileExists(chapterUri(rootUri, parsed.rel)))
        ? vscode.l10n.t('{0} already exists', parsed.rel)
        : null;
    },
  });
  if (raw === undefined) {
    return undefined;
  }
  // The validator is advisory: re-derive here (writeNewFile re-probes the target too).
  const parsed = normalizeFileInput(raw, suffix);
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Japanese Novel: this file name cannot be used. Nothing was created.'));
    return undefined;
  }
  return parsed.rel;
}

/** Creates `rel` holding `content` (parent folders included) under the root; null = exists / write failed (toasted). */
async function writeNewFile(rootUri: string, rel: string, content = ''): Promise<vscode.Uri | null> {
  const root = vscode.Uri.parse(rootUri);
  const segments = rel.split('/');
  const target = vscode.Uri.joinPath(root, ...segments);
  if (await fileExists(target)) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Japanese Novel: {0} already exists. Nothing was created.', rel));
    return null;
  }
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, ...segments.slice(0, -1)));
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
  } catch (err) {
    const message = errorText(err);
    void vscode.window.showErrorMessage(vscode.l10n.t("Japanese Novel: couldn't write {0}. {1}", rel, message));
    return null;
  }
  return target;
}

/** List mode: create the typed `.jpnov` under the book's root (a cover starts from the README sample), list it, open it. */
async function createEntry(entry: BookEntry, list: EntryList): Promise<void> {
  const rel = await promptNewFile(entry.rootUri, '.jpnov', listText(list).prompt);
  if (rel === undefined) {
    return;
  }
  const target = await writeNewFile(entry.rootUri, rel, list === 'covers' ? COVER_TEMPLATE : '');
  if (target === null) {
    return;
  }
  const { uri, text } = await bookText(entry);
  const edit = appendEntries(text, list, [rel]);
  if (edit !== null) {
    // null = already listed (re-creating a missing entry's file) — nothing to append then.
    await applyBookEdits(uri, [edit]);
  }
  await vscode.commands.executeCommand('vscode.open', target);
}

/** Book mode: create an empty `.jpbook` in the chosen folder and reveal its detail screen. */
async function createBook(view: BooksViewProvider | undefined): Promise<void> {
  if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
    // The `+` and the palette entry hide without a folder (workspaceFolderCount); the
    // walkthrough's command link can still land here, so open the folder picker instead.
    void vscode.commands.executeCommand('workbench.action.files.openFolder');
    return;
  }
  const folder = await pickFolder();
  if (folder === undefined) {
    return;
  }
  const root = folder.uri.toString();
  const rel = await promptNewFile(root, '.jpbook', vscode.l10n.t('File name of the new book'));
  if (rel === undefined) {
    return;
  }
  if (await writeNewFile(root, rel) !== null) {
    await view?.revealNewBook(folder.uri, rel);
  }
}

/**
 * `jpbook.createFile` — one input creates a file, the parked suffix trailing what's typed.
 * A list node makes a `.jpnov` for that list (chapter or cover); no node (title bar, welcome,
 * palette) makes an empty `.jpbook`, revealed in the panel — entries and metadata are then
 * added right there.
 */
export async function createFile(view: BooksViewProvider | undefined, arg?: unknown): Promise<void> {
  const node = nodeOf(arg);
  if (node === null) {
    await createBook(view);
  } else if (node.kind === 'list') {
    await createEntry(node.entry, node.list);
  }
}

async function removeEntryCmd(arg: unknown): Promise<void> {
  const node = nodeOf(arg);
  if (node?.kind !== 'entry') {
    return;
  }
  const { uri, text, version } = await bookText(node.entry);
  const line = rowLine(node, parseJpbook(text).lines, version);
  if (line === null) {
    return;
  }
  const edit = removeEntry(text, node.list, line);
  if (edit !== null) {
    await applyBookEdits(uri, [edit]);
  }
}

async function moveEntry(arg: unknown, direction: -1 | 1): Promise<void> {
  const node = nodeOf(arg);
  if (node?.kind !== 'entry') {
    return;
  }
  const { uri, text, version } = await bookText(node.entry);
  const parsed = parseJpbook(text);
  const line = rowLine(node, parsed.lines, version);
  if (line === null) {
    return;
  }
  const lines = entryLines(parsed.lines, node.list);
  const index = lines.indexOf(line); // ≥ 0: rowLine found it among this list's entries
  // Up: insert before the previous entry. Down: insert before the one PAST the next
  // (or at the end when the next entry is the last).
  const before =
    direction === -1
      ? lines[index - 1]
      : index + 2 < lines.length
        ? lines[index + 2]
        : null;
  if (before === undefined || (direction === 1 && index + 1 >= lines.length)) {
    return; // already first / already last
  }
  const edits = moveEntryTo(text, node.list, line, before);
  if (edits !== null) {
    await applyBookEdits(uri, edits);
  }
}

/**
 * Two-step divider flow: pick the mark (presets / custom input), then its position — a bare
 * value is centred at build time, a ［＃○字下げ］ prefix indents (the value grammar lives in
 * parseDividerValue/composeDividerValue). Any step dismissed = whole edit dismissed.
 */
async function pickDivider(current: string | undefined): Promise<string | undefined> {
  const parsed = current !== undefined && current !== '' ? parseDividerValue(current) : null;

  type MarkItem = vscode.QuickPickItem & { pick: 'none' | 'preset' | 'custom' };
  const markItems: MarkItem[] = [
    { label: vscode.l10n.t('(none)'), pick: 'none' },
    ...DIVIDER_PRESETS.map((m): MarkItem => ({ label: m, pick: 'preset' })),
    { label: vscode.l10n.t('Custom mark…'), pick: 'custom' },
  ];
  const markPick = await vscode.window.showQuickPick(markItems, {
    placeHolder: vscode.l10n.t('Divider between chapters without a heading'),
  });
  if (markPick === undefined) {
    return undefined;
  }
  if (markPick.pick === 'none') {
    return ''; // upsert-only: the row stays, with an empty value
  }
  let mark = markPick.label;
  if (markPick.pick === 'custom') {
    const typed = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Divider mark'),
      value: parsed?.mark ?? '',
      validateInput: (v) => {
        const mark = v.trim();
        if (mark === '') {
          return vscode.l10n.t('Enter a divider mark');
        }
        // The divider repeats at every chapter seam, so one unencodable mark would 〓 the whole
        // book. Refused here; a hand-edited `.jpbook` is caught by `diagnoseJpbook` instead.
        const unencodable = unencodableChars(mark)[0];
        return unencodable === undefined
          ? null
          : renderMessage({ code: 'jpbook.dividerNotEncodable', args: [unencodable.cluster] });
      },
    });
    if (typed === undefined) {
      return undefined;
    }
    mark = typed.trim();
  }

  type PosItem = vscode.QuickPickItem & { indented: boolean };
  const posItems: PosItem[] = [
    {
      label: vscode.l10n.t('Centred'),
      description: vscode.l10n.t('Centred with a ［＃○字下げ］ computed from the line length at build time'),
      indented: false,
    },
    { label: vscode.l10n.t('Indented'), description: '［＃○字下げ］', indented: true },
  ];
  const posPick = await vscode.window.showQuickPick(posItems, {
    placeHolder: vscode.l10n.t('Position of the divider in its line'),
  });
  if (posPick === undefined) {
    return undefined;
  }
  if (!posPick.indented) {
    return mark;
  }
  const amount = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Indent (full-width cells)'),
    value: String(parsed?.indent ?? 3),
    validateInput: (v) => (/^[0-9０-９]{1,2}$/.test(v.trim()) ? null : vscode.l10n.t('Enter a number (0-99)')),
  });
  if (amount === undefined) {
    return undefined;
  }
  // IME-friendly: full-width digits are accepted here and normalized — the composed
  // annotation is written in full-width either way.
  const digits = amount.trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  return composeDividerValue(mark, Number(digits));
}

async function editMeta(arg: unknown): Promise<void> {
  const node = nodeOf(arg);
  if (node?.kind !== 'meta') {
    return;
  }

  let value: string | undefined;
  if (node.metaKey === 'divider') {
    value = await pickDivider(node.value);
  } else if (node.metaKey === 'pageNumber') {
    const picked = await vscode.window.showQuickPick(
      PAGE_NUMBER_POSITIONS.map((v) => ({ label: positionLabel(v), description: v, value: v })),
      { placeHolder: vscode.l10n.t('Where the page number goes') },
    );
    value = picked?.value;
  } else {
    value = await vscode.window.showInputBox({
      prompt: metaLabel(node.metaKey),
      value: node.value ?? (node.metaKey === 'pageNumberFormat' ? BUILD_CHROME_DEFAULT.pageNumberFormat : ''),
      ...(node.metaKey === 'pageNumberFormat' ? { placeHolder: '{page} / {totalPage}' } : {}),
    });
  }
  if (value === undefined) {
    return; // dismissed
  }

  const { uri, text } = await bookText(node.entry);
  await applyBookEdits(uri, [upsertMeta(text, node.metaKey, value)]);
}

/** Registers the five panel commands (plain — they only fire from the Books panel). */
export function registerBookCommands(): vscode.Disposable[] {
  return [
    command('jpbook.addFiles', addFiles),
    command('jpbook.removeEntry', removeEntryCmd),
    command('jpbook.moveEntryUp', (arg?: unknown) => moveEntry(arg, -1)),
    command('jpbook.moveEntryDown', (arg?: unknown) => moveEntry(arg, 1)),
    command('jpbook.editMeta', editMeta),
  ];
}
