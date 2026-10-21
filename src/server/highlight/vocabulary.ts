/**
 * Per-root narration vocabulary (cast + coined keywords): the `characters:` and `keywords:`
 * lists of every `.jpbook` under a root, as the server read them while listing the books
 * (`jpnov/listBooks`, `build.ts`), consumed by the semantic-tokens recognizer.
 *
 * The store is the SINGLE source of per-root vocabulary state: `apply()` swaps the whole
 * snapshot (replacement semantics — a root absent from the push has no vocabulary; a root with
 * no books has an empty one, so a nested folder shadows its parent), and `recognizerFor()`
 * routes a document to its owning root by longest-prefix match over the store's own keys. A
 * root's vocabulary is the UNION of its books' lists, deduped by the name's identity, the first
 * book winning: the books come in the order the listing found them, `fileRel` order per root.
 * Recognizers are built lazily per entry and memoized on it, so a fresh `apply()` invalidates
 * every cache by construction.
 *
 * Two listings can overlap (a watcher burst) and finish out of order: a ticket taken before the
 * reads makes an overtaken apply a no-op. `generation()` moves only when the names actually
 * change, so a listing after a title edit recolours nothing. `othersOf()` gives a book's
 * neighbours in its root, for the conflict diagnostics of an open `.jpbook`.
 *
 * vscode-free: its value imports are the recognizer, the name helpers and the URI helpers.
 */
import { createRecognizer } from './recognizer.ts';
import { longestPrefixRoot, normalizeRootUri, uriKey } from '../fsUri.ts';
import type { NameList, ParsedJpbook } from '#/shared/book/jpbook.ts';
import { keywordSurface, nameSurfaces, type ListedName } from '#/shared/book/names.ts';

import type { Recognizer } from './recognizer.ts';

/** One book's lists, as parsed; `fileRel` is the label the panel and the messages show. */
export interface BookNames {
  readonly uri: string;
  readonly fileRel: string;
  readonly names: ParsedJpbook['names'];
}

/** The books of one targeted root (empty when it holds none), in the order the listing found them. */
export interface RootNames {
  readonly rootUri: string;
  readonly books: readonly BookNames[];
}

interface StoreEntry {
  readonly books: readonly BookNames[];
  /** Lazily built on first {@link HighlightStore.recognizerFor} hit; dies with the entry. `null` = nothing to recognise. */
  recognizer?: Recognizer | null;
}

export interface HighlightStore {
  /** A number for the listing about to start; {@link apply} with it is ignored once a later listing applied. */
  ticket(): number;
  /** Replaces the whole snapshot with the books of these roots (an overtaken listing is dropped). */
  apply(ticket: number, roots: readonly RootNames[]): void;
  /** Moves when an apply changed what any root lists; the same names again leave it where it was. */
  generation(): number;
  /** The recognizer for the root owning `docUri`, or `undefined` when it declares no vocabulary. */
  recognizerFor(docUri: string): Recognizer | undefined;
  /** The other books of the root owning `bookUri`, in `fileRel` order; empty off every root. */
  othersOf(bookUri: string): readonly BookNames[];
}

/** The union of one list over the books, first occurrence of an identity kept. */
function union(books: readonly BookNames[], list: NameList): ListedName[] {
  const seen = new Set<string>();
  const out: ListedName[] = [];
  for (const book of books) {
    for (const entry of book.names[list]) {
      if (!seen.has(entry.identity)) {
        seen.add(entry.identity);
        out.push(entry.name);
      }
    }
  }
  return out;
}

/** What the snapshot lists, as a string: the same names in the same books compare equal. */
function fingerprint(roots: readonly RootNames[]): string {
  return JSON.stringify(roots.map((root) => [
    root.rootUri,
    root.books.map((book) => [book.fileRel, book.names.characters.map((n) => n.text), book.names.keywords.map((n) => n.text)]),
  ]));
}

export function createHighlightStore(): HighlightStore {
  let entries = new Map<string, StoreEntry>();
  let issued = 0;
  let applied = 0;
  let listed = fingerprint([]);
  let changes = 0;

  const entryOf = (uri: string): StoreEntry | undefined => {
    const root = longestPrefixRoot(entries.keys(), uri);
    return root === null ? undefined : entries.get(root);
  };

  return {
    ticket(): number {
      issued += 1;
      return issued;
    },

    apply(ticket: number, roots: readonly RootNames[]): void {
      if (ticket < applied) {
        return;
      }
      applied = ticket;
      const now = fingerprint(roots);
      if (now === listed) {
        return; // the same names again: the entries and their recognizers stand
      }
      listed = now;
      changes += 1;
      entries = new Map(roots.map((root) => [normalizeRootUri(root.rootUri), { books: root.books }]));
    },

    generation(): number {
      return changes;
    },

    recognizerFor(docUri: string): Recognizer | undefined {
      const entry = entryOf(docUri);
      if (entry === undefined) {
        return undefined;
      }
      if (entry.recognizer === undefined) {
        const characters = union(entry.books, 'characters');
        const keywords = union(entry.books, 'keywords');
        entry.recognizer = characters.length === 0 && keywords.length === 0
          ? null
          : createRecognizer(characters.flatMap(nameSurfaces), keywords.map(keywordSurface));
      }
      return entry.recognizer ?? undefined;
    },

    othersOf(bookUri: string): readonly BookNames[] {
      const self = uriKey(bookUri);
      return entryOf(bookUri)?.books.filter((book) => uriKey(book.uri) !== self) ?? [];
    },
  };
}
