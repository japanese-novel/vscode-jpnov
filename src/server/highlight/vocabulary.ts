/**
 * Per-book narration vocabulary (cast + coined keywords): the `characters:` and `keywords:`
 * lists of every `.jpbook`, as the server read them while listing the books (`jpnov/listBooks`,
 * `build.ts`), consumed by the semantic-tokens recognizer.
 *
 * A chapter takes its vocabulary from the books that LIST it (a chapter line or a cover page),
 * whatever folder either sits in: the union of their lists, every writing of a name included. A
 * chapter no book lists has none, and a book sent open from outside every root counts like any
 * other. The store is the SINGLE source of this state: `apply()` takes each book's parse and
 * swaps the whole snapshot (replacement semantics — a book absent from the push is gone with its
 * pages), and `recognizerFor()` looks a document up by its page key, which only this module
 * makes. The pages listed by one set of books share one recognizer, built on the first hit and
 * memoized, so a fresh `apply()` invalidates every cache by construction.
 *
 * Two listings can overlap (a watcher burst) and finish out of order: a ticket taken before the
 * reads makes an overtaken apply a no-op. `generation()` moves only when the names or the pages
 * actually change, so a listing after a title edit, or after chapters are reordered, recolours
 * nothing. `othersOf()` gives the books sharing a page with a book, for the conflict diagnostics
 * of an open `.jpbook`: the lines are the caller's own parse, so an unsaved chapter list is
 * checked against the neighbours it names now.
 *
 * vscode-free: its value imports are the recognizer, the manifest's entry reader, the name
 * helpers and the URI helpers.
 */
import { createRecognizer } from './recognizer.ts';
import { parentUri, resolveUri, uriKey } from '../fsUri.ts';
import { entryPathOf, NO_NAMES, type ParsedJpbook, type ParsedLine } from '#/shared/book/jpbook.ts';
import { keywordSurface, nameSurfaces } from '#/shared/book/names.ts';

import type { Recognizer } from './recognizer.ts';

/** A book as the listing read it: its parse, or null for a file the client could not read. */
export interface ListedBook {
  readonly uri: string;
  readonly fileRel: string;
  readonly parsed: ParsedJpbook | null;
}

/** One book's lists, as parsed; `fileRel` is the label the panel and the messages show. */
export interface BookNames {
  readonly uri: string;
  readonly fileRel: string;
  readonly names: ParsedJpbook['names'];
  /** The pages the book lists, as {@link pagesOf} keys them. */
  readonly pages: readonly string[];
}

export interface HighlightStore {
  /** A number for the listing about to start; {@link apply} with it is ignored once a later listing applied. */
  ticket(): number;
  /** Replaces the whole snapshot with these books, in listing order (an overtaken listing is dropped). */
  apply(ticket: number, books: readonly ListedBook[]): void;
  /** Moves when an apply changed what any book lists; the same names and pages again leave it where it was. */
  generation(): number;
  /** The recognizer of the books listing `docUri`, or `undefined` when none does or they declare no vocabulary. */
  recognizerFor(docUri: string): Recognizer | undefined;
  /** The books other than `bookUri` listing one of the pages its `lines` list (as parsed now), in listing order. */
  othersOf(bookUri: string, lines: readonly ParsedLine[]): readonly BookNames[];
}

/**
 * The key of every page a book lists (chapters and covers, repeats folded), resolved from the
 * book's directory and sorted, so the order of the chapters is no change of the snapshot.
 */
function pagesOf(bookUri: string, lines: readonly ParsedLine[]): string[] {
  const dirUri = parentUri(bookUri);
  const pages = new Set<string>();
  for (const pl of lines) {
    const entry = entryPathOf(pl);
    const uri = entry === null ? null : resolveUri(dirUri, entry.value);
    if (uri !== null) {
      pages.add(uriKey(uri));
    }
  }
  return [...pages].sort();
}

/** What the store keeps of a listed book: its names and the keys of its pages (none for an unread file). */
export function bookNamesOf({ uri, fileRel, parsed }: ListedBook): BookNames {
  return parsed === null
    ? { uri, fileRel, names: NO_NAMES, pages: [] }
    : { uri, fileRel, names: parsed.names, pages: pagesOf(uri, parsed.lines) };
}

/** The books listing one page, and the recognizer they make together once it is asked for. */
interface Listing {
  readonly books: readonly BookNames[];
  /** Built on the first {@link HighlightStore.recognizerFor} hit; `null` = nothing to recognise. */
  recognizer?: Recognizer | null;
}

/** What the snapshot lists, as a string: the same names and pages in the same books compare equal. */
function fingerprint(books: readonly BookNames[]): string {
  return JSON.stringify(books.map((book) => [
    book.uri,
    book.fileRel,
    book.pages,
    book.names.characters.map((n) => n.text),
    book.names.keywords.map((n) => n.text),
  ]));
}

/** The recognizer of `books` taken together: every surface of every entry; `null` when they list nothing. */
function recognizerOf(books: readonly BookNames[]): Recognizer | null {
  const characters = books.flatMap((book) => book.names.characters.flatMap((entry) => nameSurfaces(entry.name)));
  const keywords = books.flatMap((book) => book.names.keywords.map((entry) => keywordSurface(entry.name)));
  return characters.length === 0 && keywords.length === 0 ? null : createRecognizer(characters, keywords);
}

/** Each page's listing: the pages listed by the same books share one, so they share its recognizer. */
function index(books: readonly BookNames[]): Map<string, Listing> {
  const holders = Map.groupBy(books.flatMap((book) => book.pages.map((page) => ({ page, book }))), (held) => held.page);
  const shared = new Map<string, Listing>();
  const byPage = new Map<string, Listing>();
  for (const [page, held] of holders) {
    const key = held.map(({ book }) => book.uri).join('\n');
    let listing = shared.get(key);
    if (listing === undefined) {
      listing = { books: held.map(({ book }) => book) };
      shared.set(key, listing);
    }
    byPage.set(page, listing);
  }
  return byPage;
}

export function createHighlightStore(): HighlightStore {
  /** The snapshot, in listing order. */
  let listed: readonly BookNames[] = [];
  let byPage = new Map<string, Listing>();
  let issued = 0;
  let applied = 0;
  let print = fingerprint([]);
  let changes = 0;

  return {
    ticket(): number {
      issued += 1;
      return issued;
    },

    apply(ticket: number, books: readonly ListedBook[]): void {
      if (ticket < applied) {
        return;
      }
      applied = ticket;
      const named = books.map(bookNamesOf);
      const now = fingerprint(named);
      if (now === print) {
        return; // the same names and pages again: the listings and their recognizers stand
      }
      print = now;
      changes += 1;
      listed = named;
      byPage = index(named);
    },

    generation(): number {
      return changes;
    },

    recognizerFor(docUri: string): Recognizer | undefined {
      const listing = byPage.get(uriKey(docUri));
      if (listing === undefined) {
        return undefined;
      }
      listing.recognizer ??= recognizerOf(listing.books);
      return listing.recognizer ?? undefined;
    },

    othersOf(bookUri: string, lines: readonly ParsedLine[]): readonly BookNames[] {
      const self = uriKey(bookUri);
      const mine = new Set(pagesOf(bookUri, lines));
      return listed.filter((book) => uriKey(book.uri) !== self && book.pages.some((page) => mine.has(page)));
    },
  };
}
