/**
 * The host ↔ webview wire contract for the client's two webviews (the Books panel and the live
 * preview). PURE types + no imports (a type-only mirror of a shared literal union is fine, an
 * import is not): this module is compiled into BOTH the Node host bundle
 * (view.ts / preview.ts, which post and receive these) and the browser webview bundles
 * (webview/book/main.ts, webview/preview/*, which are the other end). It must therefore
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

/** One section of the book list (a workspace folder, or the open files under none); `label` is null when there is a single section (flat). */
export interface BookGroupVM {
  readonly label: string | null;
  readonly books: readonly BookVM[];
}

/** One row of an entry list in a `detail`: a chapter, a cover page, a character, a keyword. */
export interface EntryVM {
  readonly line: number;
  /** The entry's value as written in the `.jpbook` (an item's marker excluded): a path, or a name
   *  with its ruby; with `line` and the detail's `version`, the row's identity the row verbs echo. */
  readonly path: string;
  readonly name: string;
  readonly folder: string;
  /** The file a path row opens; null for a name row, which an input box edits instead. */
  readonly fileUri: string | null;
  /** Absent or not a file; the webview renders the row as an error. */
  readonly missing: boolean;
}

/**
 * Which entry list a detail row or a panel verb refers to — also the `DetailMessage` field
 * names. Mirrors `EntryList` in `#/shared/book/jpbook.ts` (this module imports nothing).
 */
export type EntryList = 'chapters' | 'covers' | 'characters' | 'keywords';

/** One Book-Info metadata row in a `detail` (`note` is the （既定）/（未設定） status beside the label). */
export interface MetaVM {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly note: string;
}

/** One figure of the detail's status bar: the short text shown, and the full name its tooltip gives. */
export interface CountItem {
  readonly text: string;
  readonly title: string;
}

/**
 * The body's figures in a detail's status bar, each localized and formatted by the host
 * (number and unit), so the webview prints them as given.
 */
export interface CountsVM {
  readonly pages: CountItem;
  readonly sheets: CountItem;
  readonly chars: CountItem;
}

// Books panel — messages

/** Host → webview: the full book list + selection. The sole authority; every push reconciles the view. */
export interface StateMessage {
  readonly type: 'state';
  /** True before the first enumeration lands — show a neutral placeholder, not the "no books" welcome. */
  readonly loading: boolean;
  /** True with no workspace folder open: the empty state then recommends opening one. */
  readonly noFolder: boolean;
  /** The footer's "open the output folder after building" toggle (host-held, like the selection). */
  readonly revealOutput: boolean;
  readonly groups: readonly BookGroupVM[];
}

/** Host → webview: one book's DETAIL screen (Book Info, the names, covers, chapters). */
export interface DetailMessage {
  readonly type: 'detail';
  readonly uri: string;
  readonly title: string;
  /** The `TextDocument.version` the rows were parsed from; the row verbs echo it. */
  readonly version: number;
  readonly chapters: readonly EntryVM[];
  readonly covers: readonly EntryVM[];
  readonly characters: readonly EntryVM[];
  readonly keywords: readonly EntryVM[];
  readonly meta: readonly MetaVM[];
  /** The body's pages, 原稿用紙 sheets and characters; null when a chapter could not be read or the server did not answer. */
  readonly counts: CountsVM | null;
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
export type WelcomeAction = 'createBook' | 'openGuide';

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
  // A name row's primary action: an input box that rewrites the item (a path row opens its file).
  | {
    readonly type: 'editEntry';
    readonly uri: string;
    readonly list: EntryList;
    readonly line: number;
    readonly path: string;
    readonly version: number;
  }
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
  readonly loadingHint: string;
  readonly selectAll: string;
  readonly deselectAll: string;
  readonly selectBook: string;
  readonly print: string;
  readonly buildTxt: string;
  readonly buildEpub: string;
  readonly revealOutput: string;
  readonly back: string;
  /** Accessible name of the book list (the grid) when no root heading names it. */
  readonly books: string;
  readonly chapters: string;
  readonly bookInfo: string;
  readonly addChapters: string;
  readonly moveUp: string;
  readonly moveDown: string;
  readonly remove: string;
  readonly missing: string;
  readonly noChapters: string;
  readonly covers: string;
  readonly addCovers: string;
  readonly noCovers: string;
  readonly characters: string;
  readonly addCharacters: string;
  readonly noCharacters: string;
  readonly keywords: string;
  readonly addKeywords: string;
  readonly noKeywords: string;
  /** Tooltip and accessible name of a name row's edit action. */
  readonly editEntry: string;
  readonly noBooksTitle: string;
  readonly noBooksBody: string;
  /** Appended to the empty state's body when no folder is open. */
  readonly noFolderHint: string;
  readonly createBook: string;
  readonly openGuide: string;
}

/** The Books webview's `__INIT` bootstrap: localized strings baked in for the first paint. */
export interface BooksInit {
  readonly labels: Labels;
}

// Live preview — messages + bootstrap

/** A cursor as the editor counts it: a 0-based line and the UTF-16 offset in it. */
export interface Cursor {
  readonly line: number;
  readonly character: number;
}

/**
 * Host → preview webview: glide the column holding the cursor to the reveal position. `uri` names
 * the document the cursor is in; the webview acts only while it shows that document.
 */
export interface RevealMessage extends Cursor {
  readonly type: 'reveal';
  readonly uri: string;
}

/** The two `jpnov.layout.*` grid keys the preview's layout widget adjusts in place. */
export type PreviewLayoutKey = 'charsPerLine' | 'linesPerPage';

/** Every message the preview webview dispatches back to the host (the layout widget's verbs). */
export type PreviewOutbound =
  | { readonly type: 'layout'; readonly key: PreviewLayoutKey; readonly value: number }
  | { readonly type: 'reset' }
  | { readonly type: 'save' };

/** Localized strings the layout widget renders; baked into `__INIT` like the Books panel's Labels. */
export interface PreviewLayoutLabels {
  /** Unit text after each input (字 / 行). */
  readonly chars: string;
  readonly lines: string;
  /** Accessible names of the two inputs. */
  readonly charsPerLine: string;
  readonly linesPerPage: string;
  /** The widget's tooltip: what the values mean, or, while adjusted, what the settings still say. */
  readonly hint: string;
  /** Tooltips of the reset / save buttons (the command titles). */
  readonly reset: string;
  readonly save: string;
  /** Accessible name of the folded widget's summary (clicking it opens the controls). */
  readonly show: string;
}

/**
 * The layout widget's bootstrap: the values to show (a preview-only override where set, else the
 * resolved setting), whether any override is active, the inputs' bounds, and the input to
 * re-focus after the swap when its own change caused this render.
 */
export interface PreviewLayoutInit {
  readonly charsPerLine: number;
  readonly linesPerPage: number;
  readonly adjusted: boolean;
  readonly min: number;
  readonly max: number;
  readonly focus?: PreviewLayoutKey;
  readonly labels: PreviewLayoutLabels;
}

/**
 * The preview webview's `__INIT` bootstrap: the previewed document URI (persisted through the
 * webview state API for the window-reload serializer), the cursor to park on the first paint, and
 * the layout widget's state.
 */
export interface PreviewInit extends Cursor {
  readonly uri: string;
  readonly layout: PreviewLayoutInit;
}
