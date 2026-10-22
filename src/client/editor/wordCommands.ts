/**
 * The vscode half of the word commands: six commands on the keys of VS Code's own word
 * commands, bound to `.jpnov` editors in package.json. Server-free, registered in Phase-1
 * activate().
 */
import * as vscode from 'vscode';

import { command } from '../commands.ts';
import {
  WORD_COMMANDS,
  deleteLeft,
  deleteRight,
  mergeSpans,
  wordLeft,
  wordRight,
  type WordCommand,
} from './word.ts';
import type { Range } from '#/shared/utils/position.ts';

import { toVsPosition, toVsRange } from '../ranges.ts';

const LANG_ID = 'jpnov';

async function move(editor: vscode.TextEditor, c: WordCommand): Promise<void> {
  const step = c.toward === 'left' ? wordLeft : wordRight;
  const next = editor.selections.map((sel) => {
    const to = toVsPosition(step(editor.document, sel.active));
    return new vscode.Selection(c.action === 'select' ? sel.anchor : to, to);
  });
  const [only] = next;
  if (next.length === 1 && only !== undefined && vscode.window.activeTextEditor === editor) {
    // The core command closes the undo group first, as VS Code's own word moves do: text typed
    // after the move undoes on its own. Setting `editor.selections` would not.
    await vscode.commands.executeCommand('setSelection', {
      selection: {
        selectionStartLineNumber: only.anchor.line + 1,
        selectionStartColumn: only.anchor.character + 1,
        positionLineNumber: only.active.line + 1,
        positionColumn: only.active.character + 1,
      },
    });
    editor.revealRange(new vscode.Range(only.active, only.active));
    return;
  }
  editor.selections = next;
  await vscode.commands.executeCommand('noop');
}

async function remove(editor: vscode.TextEditor, c: WordCommand): Promise<void> {
  const reach = c.toward === 'left' ? deleteLeft : deleteRight;
  const spans = mergeSpans(editor.selections.flatMap((sel): Range[] => {
    if (!sel.isEmpty) {
      return [{ start: sel.start, end: sel.end }];
    }
    const span = reach(editor.document, sel.active);
    return span === null ? [] : [span];
  }));
  if (spans.length === 0) {
    return;
  }
  // Undo stops before and after (the defaults): one undo step per press, as VS Code's own deletes.
  // A stale document version refuses the edit (`false`), and the press is dropped.
  const applied = await editor.edit((b) => {
    for (const span of spans) {
      b.delete(toVsRange(span));
    }
  });
  if (applied) {
    const at = editor.selection.active;
    editor.revealRange(new vscode.Range(at, at));
  }
}

async function run(editor: vscode.TextEditor | undefined, c: WordCommand): Promise<void> {
  if (editor?.document.languageId !== LANG_ID) {
    await vscode.commands.executeCommand(c.builtin);
    return;
  }
  // A held key can outlive its editor (closed, or hidden by a tab switch): drop the rest.
  if (!vscode.window.visibleTextEditors.includes(editor)) {
    return;
  }
  await (c.action === 'delete' ? remove(editor, c) : move(editor, c));
}

/**
 * Presses run one at a time, and each ends on a round trip to the workbench (a command or an
 * edit), so the next one reads the editor's current selections. The extension host sets its own
 * copy at once and late echoes overwrite it; a delete computed from a stale copy would pass the
 * version check and remove the wrong text.
 */
let queue: Promise<unknown> = Promise.resolve();

function serially(task: () => Promise<void>): Promise<void> {
  const next = queue.then(task);
  queue = next.catch(() => undefined);
  return next;
}

/** Registers the six commands; the editor a key was pressed in is captured before queuing. */
export function registerWordCommands(): vscode.Disposable {
  return vscode.Disposable.from(...WORD_COMMANDS.map((c) => command(c.id, () => {
    const editor = vscode.window.activeTextEditor;
    return serially(() => run(editor, c));
  })));
}
