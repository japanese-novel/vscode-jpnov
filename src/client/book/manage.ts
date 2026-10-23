/**
 * The Books panel's verbs — form-style editing over the `.jpbook` TEXT (and the one command, `jpbook.createFile`).
 * Every action plans precise range edits via the pure `#/shared/book/edits.ts`, applies
 * them as one `WorkspaceEdit`, and SAVES immediately (settings-UI semantics: a panel
 * action persists on the spot; the saved file then re-enters through the panel's own
 * watcher, so no manual refresh plumbing exists here). Every META_KEYS key is always shown;
 * editing one rewrites or removes the lines of that key alone. Chapters, covers, characters and
 * keywords are the entry lists; a list action takes an `EntryList` and never touches another.
 * A file list is added to from a picker of the files on disk; a name list from an input box, the
 * one way a name gets its ruby typed.
 */
import { homedir } from 'node:os';
import { posix } from 'node:path';

import * as vscode from 'vscode';

import { composeDividerValue, INDENT_MAX, VALUE_FORMATS, VALUE_NAMES, valueAnnotation } from '#/shared/ast/notation.ts';
import { bookTemplate, COVER_TEMPLATE, normalizeFileInput, type FileInputError } from '#/shared/book/create.ts';
import {
  appendEntries,
  listedEntries,
  moveEntryTo,
  removeEntry,
  removeMeta,
  replaceEntry,
  resolveEntry,
  setMeta,
  type EntryRef,
} from '#/shared/book/edits.ts';
import type { TextReplace } from '#/shared/utils/position.ts';
import {
  DIVIDER_PRESETS,
  entryIdentity,
  identityOf,
  isAlignKey,
  isNameList,
  META_DEFAULTS,
  type EntryList,
  type FileList,
  type NameList,
  parseDividerValue,
  parseJpbook,
  type MetaKey,
  type ParsedLine,
  jpbookStem,
} from '#/shared/book/jpbook.ts';
import { nameIdentity, readName } from '#/shared/book/names.ts';
import { FURNITURE_ALIGNS, type FurnitureAlign } from '#/shared/compiler/chrome.ts';
import { unencodableChars } from '#/shared/encoding.ts';
import { errorText } from '#/shared/utils/errors.ts';
import type { BookEntry } from '#/shared/protocol.ts';

import { toVsRange } from '../ranges.ts';
import { renderMessage } from '../messages.ts';
import { bookDir, compareStr, FIND_FILES_EXCLUDE, lastPathSegment, resolveUri, splitRelPath } from '../paths.ts';
import { normalizeFsPath } from './rename.ts';
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
    case 'headerAlign':
      return vscode.l10n.t('Header Alignment');
    case 'footer':
      return vscode.l10n.t('Footer');
    case 'footerAlign':
      return vscode.l10n.t('Footer Alignment');
    case 'divider':
      return vscode.l10n.t('Chapter Divider');
  }
}

/** Localized display of one alignment member, shared by the header and the footer (the row names the band). */
function alignLabel(value: FurnitureAlign): string {
  switch (value) {
    case 'right':
      return vscode.l10n.t('Right');
    case 'left':
      return vscode.l10n.t('Left');
    case 'rightLeft':
      return vscode.l10n.t('Alternate: right, then left');
    case 'leftRight':
      return vscode.l10n.t('Alternate: left, then right');
    case 'center':
      return vscode.l10n.t('Center');
  }
}

/**
 * The meta row split into its bare display VALUE and a status NOTE, so the panel can place the
 * note beside the LABEL rather than inside the value: a written value carries no note; a key the
 * file does not write shows its default tagged "(default)"; an empty value, written or the
 * default, says what it does instead — a hidden header or footer, no divider, a title or author
 * not set — so an unwritten header reads like an emptied one, as the output treats them.
 */
export function metaValueParts(key: MetaKey, value: string | undefined): { value: string; note: string } {
  const shown = value ?? (key === 'title' ? '' : META_DEFAULTS[key]);
  if (shown !== '') {
    return { value: isAlignKey(key) ? alignLabel(shown as FurnitureAlign) : shown, note: value === undefined ? vscode.l10n.t('(default)') : '' };
  }
  const note = key === 'header' || key === 'footer'
    ? vscode.l10n.t('(hidden)')
    : key === 'divider' ? vscode.l10n.t('(none)') : vscode.l10n.t('(not set)');
  return { value: '', note };
}

/**
 * What a picker resolves to: the value to write, `null` to restore the default (the key's lines
 * are deleted), `undefined` for a dismissed dialog.
 */
type MetaPick = string | null | undefined;

/** The 「既定に戻す」 item of a picker, describing what the default shows; the caller adds what it resolves to. */
function restoreItem(key: Exclude<MetaKey, 'title'>): vscode.QuickPickItem {
  const parts = metaValueParts(key, undefined);
  return { label: vscode.l10n.t('Restore default'), description: parts.value || parts.note, alwaysShow: true };
}

/** Applies planned replaces and, unless told not to, saves — the panel's watcher does the refresh. A refused
 *  edit (false) or save is toasted; `save = false` leaves a buffer that was already dirty to its owner. */
export async function applyBookEdits(uri: vscode.Uri, replaces: readonly TextReplace[], save = true): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();
  for (const r of replaces) {
    edit.replace(uri, toVsRange(r.range), r.newText);
  }
  const name = lastPathSegment(uri.toString());
  if (!(await vscode.workspace.applyEdit(edit))) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Japanese Novel: couldn't edit {0}.", name),
    );
    return false;
  }
  if (save) {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if ((await doc?.save()) === false) {
      void vscode.window.showErrorMessage(vscode.l10n.t("Japanese Novel: couldn't save {0}.", name));
    }
  }
  return true;
}

/**
 * The Books panel's verbs take the row as the panel rendered it. `list` names one of the book's
 * entry lists (chapters / covers / characters / keywords); a `MetaNode` carries one of the fixed
 * metadata keys (META_KEYS) and its current value; an `EntryNode` carries the row (`line`, `path`,
 * the document `version`), which the verb checks against the live text.
 */
export interface ListNode {
  readonly list: EntryList;
  readonly entry: BookEntry;
}

export interface MetaNode {
  readonly entry: BookEntry;
  readonly metaKey: MetaKey;
  readonly value: string | undefined;
}

export interface EntryNode extends ListNode {
  /** 0-based document line of this entry (the edit planners key on it). */
  readonly line: number;
  /** The value on that line (a path, a name) and the `TextDocument.version` the panel rendered it from. */
  readonly path: string;
  readonly version: number;
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

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** The list-specific wording of the add-files picker; everything else is shared. */
function listText(list: FileList): { placeholder: string; create: string } {
  const text: Record<FileList, { placeholder: string; create: string }> = {
    chapters: {
      placeholder: vscode.l10n.t('Pick chapter files to add, or type a name to create a new one'),
      create: vscode.l10n.t('Create a new chapter'),
    },
    covers: {
      placeholder: vscode.l10n.t('Pick cover page files to add, or type a name to create a new one'),
      create: vscode.l10n.t('Create a new cover page'),
    },
  };
  return text[list];
}

/**
 * The `.jpnov` files under the book's workspace folder (its own folder when none contains it), as
 * paths from the book's folder, the form an entry takes: sorted, those under the book's folder first.
 */
async function findJpnovFiles(dir: vscode.Uri): Promise<string[]> {
  const base = vscode.workspace.getWorkspaceFolder(dir)?.uri ?? dir;
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(base, '**/*.jpnov'), FIND_FILES_EXCLUDE);
  const dirPath = normalizeFsPath(dir.fsPath);
  const above = (rel: string): number => Number(rel.startsWith('../'));
  return found
    .map((uri) => posix.relative(dirPath, normalizeFsPath(uri.fsPath)))
    .sort((a, b) => above(a) - above(b) || compareStr(a, b));
}

/** What the picker returns: ticked files on disk, then names to create, both from the book's folder. */
interface PickedFiles {
  readonly existing: readonly string[];
  readonly created: readonly string[];
}

/**
 * The picker's rows: a file on disk not yet listed (`existing`), a typed name that is no file yet
 * (`create`; the row is parked in the list once ticked), and a typed name that cannot be created
 * (`info`, never stays ticked).
 */
type FileItem = vscode.QuickPickItem & {
  readonly role: 'existing' | 'create' | 'info';
  readonly rel: string;
};

/**
 * Shows `qp` and resolves with `answerOnAccept()` on Enter, undefined on Esc; the picker is
 * disposed either way.
 */
function runQuickPick<T extends vscode.QuickPickItem, R>(qp: vscode.QuickPick<T>, answerOnAccept: () => R): Promise<R | undefined> {
  return new Promise((resolve) => {
    let answer: R | undefined;
    qp.onDidAccept(() => {
      answer = answerOnAccept();
      qp.hide();
    });
    qp.onDidHide(() => {
      qp.dispose();
      resolve(answer);
    });
    qp.show();
  });
}

/** The validator's word for a name `normalizeFileInput` refused. */
function fileNameError(error: FileInputError): string {
  return error === 'empty' ? vscode.l10n.t('Enter a file name') : vscode.l10n.t('This file name cannot be used');
}

/**
 * One multi-select picker for adding files: the `.jpnov` files on disk not yet in the list are
 * ticked, and a typed name that is no file yet rides as the first row. Enter takes the ticked
 * rows and that typed name; ticking the typed row instead parks it and clears the input for the
 * next name. Esc = undefined, Enter with nothing = empty lists.
 */
function pickFiles(
  onDisk: readonly string[],
  listed: ReadonlySet<string>,
  wording: { placeholder: string; create: string },
): Promise<PickedFiles | undefined> {
  const candidates = onDisk.filter((rel) => !listed.has(entryIdentity(rel))).map((rel): FileItem => {
    const { name, dir } = splitRelPath(rel);
    return dir === '' ? { label: name, role: 'existing', rel } : { label: name, description: dir, role: 'existing', rel };
  });
  const exists = new Set(onDisk);
  /** Typed rows ticked so far, in that order; they stay listed (ticked or not) until Enter. */
  const pending: FileItem[] = [];
  /** The row for what is typed now, null when the input names nothing to add. */
  let typed: FileItem | null = null;

  const qp = vscode.window.createQuickPick<FileItem>();
  qp.canSelectMany = true;
  qp.matchOnDescription = true;
  qp.ignoreFocusOut = true;
  qp.placeholder = wording.placeholder;

  const typedRow = (): FileItem | null => {
    const raw = qp.value.trim();
    const parsed = normalizeFileInput(raw, '.jpnov');
    const row = (label: string, role: FileItem['role'], rel: string, description: string): FileItem =>
      ({ label, description, role, rel, alwaysShow: true });
    if (!parsed.ok) {
      return parsed.error === 'empty' ? null : row(raw, 'info', raw, fileNameError(parsed.error));
    }
    if (listed.has(entryIdentity(parsed.rel)) && exists.has(parsed.rel)) {
      return row(parsed.rel, 'info', parsed.rel, vscode.l10n.t('Already in this book'));
    }
    // On disk and unlisted: its candidate row shows through the filter. Parked: listed already.
    return exists.has(parsed.rel) || pending.some((p) => p.rel === parsed.rel)
      ? null
      : row(parsed.rel, 'create', parsed.rel, wording.create);
  };
  // Replacing `items` drops every tick, so the rows that stay keep theirs. Nothing is replaced
  // while the typed row is the same, which also absorbs VS Code's echo of a cleared input.
  const refresh = (): void => {
    const next = typedRow();
    if (next?.role === typed?.role && next?.rel === typed?.rel) {
      return;
    }
    typed = next;
    const rows = [...(typed === null ? [] : [typed]), ...pending, ...candidates];
    const ticked = qp.selectedItems;
    qp.items = rows;
    qp.selectedItems = rows.filter((r) => ticked.includes(r));
  };
  qp.items = candidates;
  qp.onDidChangeValue(refresh);
  qp.onDidChangeSelection((selected) => {
    if (typed !== null && selected.includes(typed)) {
      pending.push(typed);
      qp.value = '';
      refresh();
      return;
    }
    const allowed = selected.filter((i) => i.role !== 'info');
    if (allowed.length !== selected.length) {
      qp.selectedItems = allowed;
    }
  });

  return runQuickPick(qp, () => {
    const ticked = qp.selectedItems;
    return {
      existing: candidates.filter((c) => ticked.includes(c)).map((c) => c.rel),
      created: [
        ...pending.filter((p) => ticked.includes(p)).map((p) => p.rel),
        ...(typed?.role === 'create' ? [typed.rel] : []),
      ],
    };
  });
}

/** The prompt of a name list's input box; the placeholder shows the notation a name may use. */
function nameText(list: NameList): { prompt: string; placeholder: string; empty: string } {
  const text: Record<NameList, { prompt: string; placeholder: string; empty: string }> = {
    characters: {
      prompt: vscode.l10n.t('Character name (ruby allowed; a space or a ruby boundary separates surname and given name)'),
      placeholder: '山田《やまだ》太郎《たろう》',
      empty: vscode.l10n.t('Enter a name'),
    },
    keywords: {
      prompt: vscode.l10n.t('Keyword (ruby allowed)'),
      placeholder: '王都《おうと》',
      empty: vscode.l10n.t('Enter a keyword'),
    },
  };
  return text[list];
}

/**
 * One input box for a name: refused while empty, while it holds an annotation other than ruby
 * (the diagnostic's own words), or while `listed` already has its base (`except` = the row being
 * edited, whose own base is fine). Undefined when dismissed.
 */
async function askName(list: NameList, listed: ReadonlySet<string>, current: string | undefined): Promise<string | undefined> {
  const text = nameText(list);
  const except = current === undefined ? null : identityOf(list, current);
  const typed = await vscode.window.showInputBox({
    prompt: text.prompt,
    placeHolder: text.placeholder,
    value: current ?? '',
    validateInput: (v) => {
      const value = v.trim();
      const read = readName(value);
      if (!read.ok) {
        return read.error === 'empty' ? text.empty : renderMessage({ code: 'jpbook.nameNotPlain', args: [value] });
      }
      const id = nameIdentity(read.name);
      return id !== except && listed.has(id) ? vscode.l10n.t('Already in this book') : null;
    },
  });
  return typed?.trim();
}

/**
 * The add verb, a list's one way in. A name list asks for one name in an input box and appends
 * it. A file list opens the picker: tick files already on disk, type a name to create, or both.
 * The ticked files are appended first and the new ones after them, as one edit; the last new
 * file opens in the editor.
 */
export async function addEntries(node: ListNode): Promise<void> {
  if (isNameList(node.list)) {
    const listed = listedEntries(parseJpbook((await bookText(node.entry)).text).lines, node.list);
    const name = await askName(node.list, listed, undefined);
    if (name === undefined) {
      return;
    }
    const { uri, text } = await bookText(node.entry);
    const edit = appendEntries(text, node.list, [name]);
    if (edit !== null) {
      await applyBookEdits(uri, [edit]);
    }
    return;
  }
  const dir = bookDir(node.entry.uri);
  const onDisk = await findJpnovFiles(dir);
  // The lists dedupe independently: a file that is already a chapter may still become a cover.
  const listed = listedEntries(parseJpbook((await bookText(node.entry)).text).lines, node.list);
  const picked = await pickFiles(onDisk, listed, listText(node.list));
  if (picked === undefined) {
    return;
  }

  const rels = [...picked.existing];
  let last: vscode.Uri | undefined;
  for (const rel of picked.created) {
    const target = await writeNewFile(dir, rel, node.list === 'covers' ? COVER_TEMPLATE : '');
    if (target !== null) {
      rels.push(rel);
      last = target;
    }
  }
  if (rels.length === 0) {
    return;
  }
  // Re-read AFTER the pick: the book may have changed while the picker was open, and the
  // edit must anchor to the live text. appendEntries re-dedupes against it, so re-creating
  // a listed file whose file went missing appends nothing.
  const { uri, text } = await bookText(node.entry);
  const edit = appendEntries(text, node.list, rels);
  if (edit !== null) {
    await applyBookEdits(uri, [edit]);
  }
  if (last !== undefined) {
    await vscode.commands.executeCommand('vscode.open', last);
  }
}

/** The book's target folder: the single workspace folder, or a pick between several. */
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
 * The parked-suffix input box for a new book. Caret at 0, `.jpbook` after it: typing (IME
 * composition included) inserts before the suffix, so the value is never rewritten
 * mid-composition. Returns the normalized path from `base`; undefined = dismissed or unusable.
 */
async function promptNewBook(base: vscode.Uri): Promise<string | undefined> {
  const suffix = '.jpbook';
  const raw = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('File name of the new book'),
    value: suffix,
    valueSelection: [0, 0],
    ignoreFocusOut: true,
    validateInput: async (value) => {
      const parsed = normalizeFileInput(value, suffix);
      if (!parsed.ok) {
        return fileNameError(parsed.error);
      }
      return (await fileExists(resolveUri(base, parsed.rel)))
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

/**
 * Creates `rel` holding `content` (parent folders included) from `base`; null = exists / write
 * failed (toasted). A `../` path may leave the workspace folder `base` sits in: the file is
 * created all the same, with a warning, since the Explorer does not show it and renames there
 * are not tracked.
 */
async function writeNewFile(base: vscode.Uri, rel: string, content = ''): Promise<vscode.Uri | null> {
  const target = resolveUri(base, rel);
  if (await fileExists(target)) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Japanese Novel: {0} already exists. Nothing was created.', rel));
    return null;
  }
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
  } catch (err) {
    const message = errorText(err);
    void vscode.window.showErrorMessage(vscode.l10n.t("Japanese Novel: couldn't write {0}. {1}", rel, message));
    return null;
  }
  if (vscode.workspace.getWorkspaceFolder(base) !== undefined && vscode.workspace.getWorkspaceFolder(target) === undefined) {
    void vscode.window.showWarningMessage(vscode.l10n.t(
      'Japanese Novel: {0} was created outside the workspace folder. The Explorer does not show it; after a rename or move, fix the paths in the book file by hand.',
      rel,
    ));
  }
  return target;
}

/**
 * Where a new book goes: without a workspace folder a save dialog names the file; with one, the
 * folder pick (when there are several) then the parked-suffix prompt. Undefined = dismissed or unusable.
 */
async function newBookTarget(): Promise<{ base: vscode.Uri; rel: string } | undefined> {
  if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
    const picked = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(vscode.Uri.file(homedir()), `${vscode.l10n.t('My Book')}.jpbook`),
      filters: { [vscode.l10n.t('Book file')]: ['jpbook'] },
      saveLabel: vscode.l10n.t('Create'),
    });
    if (picked === undefined) {
      return undefined;
    }
    return { base: vscode.Uri.joinPath(picked, '..'), rel: `${jpbookStem(lastPathSegment(picked.toString()))}.jpbook` };
  }
  const folder = await pickFolder();
  if (folder === undefined) {
    return undefined;
  }
  const rel = await promptNewBook(folder.uri);
  return rel === undefined ? undefined : { base: folder.uri, rel };
}

/**
 * `jpbook.createFile` (title bar, welcome, palette) — one dialog names a `.jpbook` holding the
 * {@link bookTemplate} (every required key, titled after the file) and reveals it in the panel;
 * entries and metadata are then edited right there. A book under no workspace folder stays open
 * in the editor, which is what lists it. Chapters and covers are created from their lists.
 */
export async function createFile(view: BooksViewProvider | undefined): Promise<void> {
  const picked = await newBookTarget();
  if (picked === undefined) {
    return;
  }
  const target = await writeNewFile(picked.base, picked.rel, bookTemplate(jpbookStem(splitRelPath(picked.rel).name)));
  if (target === null) {
    return;
  }
  if (vscode.workspace.getWorkspaceFolder(target) === undefined) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: false, preserveFocus: true });
  }
  await view?.revealNewBook(target);
}

/** The edit verb: a name row's input box, prefilled with the item as written; the value is rewritten in place. A file row has no edit. */
export async function editEntry(node: EntryNode): Promise<void> {
  if (!isNameList(node.list)) {
    return;
  }
  const listed = listedEntries(parseJpbook((await bookText(node.entry)).text).lines, node.list);
  const name = await askName(node.list, listed, node.path);
  if (name === undefined) {
    return;
  }
  const { uri, text, version } = await bookText(node.entry);
  const line = rowLine(node, parseJpbook(text).lines, version);
  if (line === null) {
    return;
  }
  const edit = replaceEntry(text, node.list, line, name);
  if (edit !== null) {
    await applyBookEdits(uri, [edit]);
  }
}

/** Removes the row's line. */
export async function removeEntryRow(node: EntryNode): Promise<void> {
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

/**
 * Moves the row to sit before the row `before` (null = the end of its list): the up/down buttons
 * and a drop alike. Both rows must still be where the panel showed them (version + resolveEntry);
 * otherwise, as for a no-op move, nothing is planned — never a fallback to the end of the list.
 */
export async function moveEntry(node: EntryNode, before: EntryRef | null): Promise<void> {
  const { uri, text, version } = await bookText(node.entry);
  const lines = parseJpbook(text).lines;
  const from = rowLine(node, lines, version);
  const beforeLine = before === null ? null : resolveEntry(lines, node.list, before);
  if (from === null || (before !== null && beforeLine === null)) {
    return;
  }
  const edits = moveEntryTo(text, node.list, from, beforeLine);
  if (edits !== null) {
    await applyBookEdits(uri, edits);
  }
}

/**
 * Two-step divider flow: pick the mark (presets / custom input), then its position — a bare
 * value is centred at build time, a ［＃○字下げ］ prefix indents (the value grammar lives in
 * parseDividerValue/composeDividerValue). Any step dismissed = whole edit dismissed.
 */
async function pickDivider(current: string | undefined): Promise<MetaPick> {
  const parsed = current !== undefined ? parseDividerValue(current) : null;

  type MarkItem = vscode.QuickPickItem & { pick: 'none' | 'preset' | 'custom' | 'restore' };
  const markItems: MarkItem[] = [
    { label: vscode.l10n.t('(none)'), pick: 'none' },
    ...DIVIDER_PRESETS.map((m): MarkItem => ({ label: m, pick: 'preset' })),
    { label: vscode.l10n.t('Custom mark…'), pick: 'custom' },
    { ...restoreItem('divider'), pick: 'restore' },
  ];
  const markPick = await vscode.window.showQuickPick(markItems, {
    placeHolder: vscode.l10n.t('Divider between chapters without a heading'),
  });
  if (markPick === undefined) {
    return undefined;
  }
  if (markPick.pick === 'restore') {
    return null; // the line goes: no divider, as a new book has none
  }
  if (markPick.pick === 'none') {
    return ''; // written as `divider:` = no divider
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
  // IME-friendly: full-width digits are accepted and normalized — the composed annotation is
  // written in full-width either way. 0 would mean the line head, which the divider never offers.
  const indentOf = (v: string): number | null => {
    const digits = v.trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
    const n = Number(digits);
    return /^[0-9]+$/.test(digits) && n >= 1 && n <= INDENT_MAX ? n : null;
  };
  const amount = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Indent (full-width cells)'),
    value: String(Math.max(parsed?.indent ?? 3, 1)), // a written ０字下げ prefills the smallest offer
    validateInput: (v) => (indentOf(v) === null ? vscode.l10n.t('Enter a number (1-{0})', INDENT_MAX) : null),
  });
  if (amount === undefined) {
    return undefined;
  }
  return composeDividerValue({ mark, indent: indentOf(amount) });
}

/** The headers the picker offers ready-made: the book's title, and the title with the page's chapter number in 命数 (作品名　一). */
const HEADER_TITLE = valueAnnotation(VALUE_NAMES.title);
const HEADER_TITLE_HEADING = `${HEADER_TITLE}　${valueAnnotation(VALUE_NAMES.heading, VALUE_FORMATS.named)}`;

/**
 * One dialog for a free-text line (the header, the footer, the author): the typed line rides as
 * the first item, so Enter takes it as is; the key's ready-made choices stay listed below it,
 * 「既定に戻す」 last.
 */
function pickLine(key: 'header' | 'footer' | 'author', current: string | undefined): Promise<MetaPick> {
  /** The value to write, or `null` to restore the default. */
  type LineItem = vscode.QuickPickItem & { readonly value: string | null };
  const offer: { placeholder: string; fixed: LineItem[] } = key === 'header'
    ? {
        placeholder: vscode.l10n.t('Type the header, or pick one below'),
        fixed: [
          { label: vscode.l10n.t('Title'), description: HEADER_TITLE, alwaysShow: true, value: HEADER_TITLE },
          { label: vscode.l10n.t('Title and chapter number'), description: HEADER_TITLE_HEADING, alwaysShow: true, value: HEADER_TITLE_HEADING },
          { label: vscode.l10n.t('No header'), alwaysShow: true, value: '' },
        ],
      }
    : key === 'footer'
      ? { placeholder: vscode.l10n.t('Type the footer, or pick one below'), fixed: [{ label: vscode.l10n.t('No footer'), alwaysShow: true, value: '' }] }
      : { placeholder: vscode.l10n.t('Type the author, or pick one below'), fixed: [] };
  const fixed: LineItem[] = [...offer.fixed, { ...restoreItem(key), value: null }];
  const qp = vscode.window.createQuickPick<LineItem>();
  qp.title = metaLabel(key);
  qp.placeholder = offer.placeholder;
  const refresh = (): void => {
    const typed = qp.value.trim();
    qp.items = typed === '' ? fixed : [{ label: typed, alwaysShow: true, value: typed }, ...fixed];
    qp.activeItems = qp.items.slice(0, 1);
  };
  qp.value = current ?? '';
  refresh();
  qp.onDidChangeValue(refresh);

  return runQuickPick(qp, (): MetaPick => qp.selectedItems[0]?.value);
}

/** Edits one metadata value through its own dialog: the divider's two steps, a line's picker, an align's list, or an input box. */
export async function editMeta(node: MetaNode): Promise<void> {
  let value: MetaPick;
  if (node.metaKey === 'divider') {
    value = await pickDivider(node.value);
  } else if (node.metaKey === 'header' || node.metaKey === 'footer' || node.metaKey === 'author') {
    value = await pickLine(node.metaKey, node.value);
  } else if (isAlignKey(node.metaKey)) {
    type AlignItem = vscode.QuickPickItem & { readonly value: FurnitureAlign | null };
    const picked = await vscode.window.showQuickPick<AlignItem>(
      [
        ...FURNITURE_ALIGNS.map((v): AlignItem => ({ label: alignLabel(v), description: v, value: v })),
        { ...restoreItem(node.metaKey), value: null },
      ],
      {
        placeHolder: node.metaKey === 'headerAlign'
          ? vscode.l10n.t('Where the header goes')
          : vscode.l10n.t('Where the footer goes'),
      },
    );
    value = picked?.value;
  } else {
    value = await vscode.window.showInputBox({ prompt: metaLabel(node.metaKey), value: node.value ?? '' });
  }
  if (value === undefined) {
    return; // dismissed
  }

  const { uri, text } = await bookText(node.entry);
  const edits = value === null ? removeMeta(text, node.metaKey) : setMeta(text, node.metaKey, value);
  if (edits.length > 0) {
    await applyBookEdits(uri, edits);
  }
}
