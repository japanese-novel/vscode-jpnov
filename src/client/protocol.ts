/**
 * The host ↔ webview wire contract for the client's two webviews (the Books panel and the live
 * preview). PURE types + no imports (a type-only mirror of a shared literal union is fine, an
 * import is not): this module is compiled into BOTH the Node host bundle
 * (view.ts / preview.ts, which post and receive these) and the browser webview bundles
 * (webview/book/main.ts, webview/preview/scroll.ts, which are the other end). It must therefore
 * stay vscode-free, node-free and DOM-free — only shapes crossing `postMessage`'s structured
 * clone, plus the `__INIT` bootstrap each webview reads synchronously on first paint.
 *
 * Mirrors the host↔server split's `protocol.ts`: single repo, both ends move together, so a
 * shape change is safe as long as both sides change in one commit.
 */

// Books panel — view models (host → webview `state` / `detail` payloads)

export interface BookVM {
  readonly uri: string;
  readonly title: string;
  readonly fileRel: string;
  readonly checked: boolean;
}

/** One per-root section of the book list; `rootLabel` is null when there is a single root (flat). */
export interface BookGroupVM {
  readonly rootLabel: string | null;
  readonly books: readonly BookVM[];
}

/** One chapter or cover row in a `detail`. */
export interface EntryVM {
  readonly line: number;
  /** The entry path as written in the `.jpbook` (a cover item's marker excluded); with `line` and
   *  the detail's `version`, the row's identity the row verbs echo. */
  readonly path: string;
  readonly name: string;
  readonly folder: string;
  readonly fileUri: string;
  /** Absent or not a file; the webview renders the row as an error. */
  readonly missing: boolean;
}

/**
 * Which entry list a detail row or a panel verb refers to — also the `DetailMessage` field
 * names. Mirrors `EntryList` in `#/shared/book/jpbook.ts` (this module imports nothing).
 */
export type EntryList = 'chapters' | 'covers';

/** One Book-Info metadata row in a `detail` (`note` is the （既定）/（未設定） status beside the label). */
export interface MetaVM {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly note: string;
}

// Books panel — messages

/** Host → webview: the full book list + selection. The sole authority; every push reconciles the view. */
export interface StateMessage {
  readonly type: 'state';
  /** True before the first enumeration lands — show a neutral placeholder, not the "no books" welcome. */
  readonly loading: boolean;
  readonly noFolder: boolean;
  /** The footer's "open the output folder after building" toggle (host-held, like the selection). */
  readonly revealOutput: boolean;
  readonly groups: readonly BookGroupVM[];
}

/** Host → webview: one book's DETAIL screen (covers, chapters + Book Info). */
export interface DetailMessage {
  readonly type: 'detail';
  readonly uri: string;
  readonly title: string;
  /** The `TextDocument.version` the rows were parsed from; the row verbs echo it. */
  readonly version: number;
  readonly chapters: readonly EntryVM[];
  readonly covers: readonly EntryVM[];
  readonly meta: readonly MetaVM[];
  /** Host-initiated open (create-book reveal, failed-build hand-off, ready re-hydration): the
   *  webview adopts the intent instead of dropping the push as a stale race, and re-applies its
   *  entry-time fold rule. Refresh re-pushes omit it. */
  readonly reveal?: boolean;
}

/** Host → webview: a vanished open book returns the webview to the list. */
export interface CloseDetailMessage {
  readonly type: 'closeDetail';
}

/** Every message the host posts to the Books webview. */
export type BooksInbound = StateMessage | DetailMessage | CloseDetailMessage;

/** A build action fired from the footer (`print` = build HTML, then open it in the browser). */
export type BuildAction = 'print' | 'txt' | 'epub';

/** An empty-state welcome-link action. */
export type WelcomeAction = 'createBook' | 'openGuide' | 'openFolder';

/** Every message the Books webview dispatches back to the host. */
export type BooksOutbound =
  | { readonly type: 'ready' }
  | { readonly type: 'toggle'; readonly uri: string; readonly checked: boolean }
  | { readonly type: 'selectAll' }
  | { readonly type: 'deselectAll' }
  // `uri` present = build exactly that one book (the open detail); absent = the checked set.
  | { readonly type: 'build'; readonly format: BuildAction; readonly uri?: string }
  | { readonly type: 'revealOutput'; readonly on: boolean }
  | { readonly type: 'openDetail'; readonly uri: string }
  | { readonly type: 'closeDetail' }
  | { readonly type: 'openFile'; readonly uri: string }
  | { readonly type: 'editMeta'; readonly uri: string; readonly metaKey: string }
  // Entry-list verbs: `list` names the target list. A row verb names the row as rendered (`line`,
  // the `path` written there, the detail's `version`); the host acts only while the text still
  // matches, and answers a stale row with a re-push.
  | { readonly type: 'addEntries'; readonly uri: string; readonly list: EntryList }
  | { readonly type: 'createEntry'; readonly uri: string; readonly list: EntryList }
  | {
    readonly type: 'removeEntry';
    readonly uri: string;
    readonly list: EntryList;
    readonly line: number;
    readonly path: string;
    readonly version: number;
  }
  | {
    readonly type: 'moveEntry';
    readonly uri: string;
    readonly list: EntryList;
    readonly line: number;
    readonly path: string;
    readonly version: number;
    readonly dir: -1 | 1;
  }
  | {
    readonly type: 'moveEntryTo';
    readonly uri: string;
    readonly list: EntryList;
    readonly line: number;
    readonly path: string;
    readonly version: number;
    /** The row to drop before, named like the moved row; both null = after the list's last entry. */
    readonly before: number | null;
    readonly beforePath: string | null;
  }
  | { readonly type: 'welcome'; readonly action: WelcomeAction };

/**
 * Localized UI strings the Books webview renders. Baked into `__INIT` (not re-fetched per node)
 * because the webview builds its own DOM. Keys mirror `labels()` in webviewHtml.ts one-to-one.
 */
export interface Labels {
  readonly loading: string;
  readonly selectAll: string;
  readonly deselectAll: string;
  readonly selectBook: string;
  readonly print: string;
  readonly buildTxt: string;
  readonly buildEpub: string;
  readonly revealOutput: string;
  readonly back: string;
  readonly openChapter: string;
  readonly chapters: string;
  readonly bookInfo: string;
  readonly addChapters: string;
  readonly newChapter: string;
  readonly moveUp: string;
  readonly moveDown: string;
  readonly remove: string;
  readonly missing: string;
  readonly noChapters: string;
  readonly covers: string;
  readonly addCovers: string;
  readonly newCover: string;
  readonly openCover: string;
  readonly noCovers: string;
  readonly noBooksTitle: string;
  readonly noBooksBody: string;
  readonly createBook: string;
  readonly openGuide: string;
  readonly noFolderTitle: string;
  readonly noFolderBody: string;
  readonly openFolder: string;
}

/** The Books webview's `__INIT` bootstrap: localized strings baked in for the first paint. */
export interface BooksInit {
  readonly labels: Labels;
}

// Live preview — messages + bootstrap

/** Host → preview webview: scroll the anchor for `line` to the reveal position (with a glide). */
export interface RevealMessage {
  readonly type: 'reveal';
  readonly line: number;
}

/**
 * The preview webview's `__INIT` bootstrap: the previewed document URI (persisted through the
 * webview state API for the window-reload serializer) and the line to park on the first paint.
 */
export interface PreviewInit {
  readonly uri: string;
  readonly line: number;
}
