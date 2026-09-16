/**
 * The Books panel's command-argument vocabulary, shared by the WebviewView provider (`view.ts`)
 * and the management commands (`manage.ts`) so neither has to import the other for types. The
 * provider synthesizes one of these from a webview message and dispatches it to the matching
 * `jpbook.*` command; `manage.ts` narrows on `kind`. `list` names one of the book's two entry
 * lists (chapters / covers); `meta` carries one of the fixed front-matter keys (META_KEYS) and
 * its current value; `entry` carries the row as the panel rendered it (`line`, `path`, document
 * `version`), which the command checks against the live text.
 */
import type { EntryList, MetaKey } from '#/shared/book/jpbook.ts';
import type { BookEntry } from '#/shared/protocol.ts';

export type BookNode =
  | { readonly kind: 'list'; readonly list: EntryList; readonly entry: BookEntry }
  | {
    readonly kind: 'meta';
    readonly entry: BookEntry;
    readonly metaKey: MetaKey;
    readonly value: string | undefined;
  }
  | {
    readonly kind: 'entry';
    readonly list: EntryList;
    readonly entry: BookEntry;
    /** 0-based document line of this entry (the edit planners key on it). */
    readonly line: number;
    /** The path on that line and the `TextDocument.version` the panel rendered it from. */
    readonly path: string;
    readonly version: number;
  };

/** The row node the remove / move commands take. */
export type EntryNode = Extract<BookNode, { kind: 'entry' }>;
