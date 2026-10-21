# Architecture

How Japanese Novel is put together, and why: the programs it runs as, the stages
a manuscript passes through, and the rules that decide where a piece of logic
belongs. The README says what the extension does; this says how.

## Programs

One repository ships three programs.

| Program | Source | Runs in | Owns |
| --- | --- | --- | --- |
| Client | `src/client/` | the VS Code extension host | the Books view and the preview panel, commands, settings snapshots, every file write |
| Server | `src/server/` | a forked Node process, LSP over IPC | parsing, diagnostics, lint, highlighting, rendering, builds |
| Webviews | `src/client/webview/` | the webview's own browser context | the scripts of the Books view and the preview, and the 傍点 probe the compiler inlines into its HTML (`probe/`) |

`src/shared/` holds what client and server both use: the manuscript pipeline
(`ast/`, `compiler/`), the settings resolvers (`config/`), the `.jpbook` manifest
(`book/`), the lint catalog (`lint/`) and the wire shapes (`protocol.ts`). Its
`utils/` holds the helpers that know nothing of the notation, the manifest, the
settings or the wire: not a stage, the leaf under every stage, it imports nothing
and every program may read it. The unit is the file: a file enters when it has
users in two layers, and a helper with one user rides in the file of its kind.
A helper whose file would have one user stays in that user's layer.

The boundaries:

- **Only the client imports `vscode`.** The forked server has no such module.
  `src/shared/` and `src/server/` stay free of it, so the same modules run in the
  tests, behind the end-to-end harness, and on the website (`website/`, a
  separate npm project that imports from `src/`).
- **The server never reads the contents of a file and never writes one.** It asks
  the client for manuscript text (`jpnov/readText`) and gets what the editor
  shows: the open buffer with its unsaved edits, else the file decoded as VS Code
  decodes it. A build therefore matches the editor, whatever the encoding.
  Artifacts leave the server as text; the client writes them, encodes the `.txt`
  and zips the EPUB. The server does list directories, to find books and to
  complete paths.
- **The client pushes settings; the server never pulls them.** Layout settings
  ride each render, build and count request as raw values, and the server resolves them
  (`src/shared/config/settings.ts`), because a payload is untrusted at runtime.
  The lint selection arrives at start and again on every change. The narration
  vocabulary is no setting: the server reads the `characters:` and `keywords:` of
  every `.jpbook` while it lists the books, root by root, and the client lists
  them at start and on every `.jpbook` change.
- **The server emits message codes, the client renders text.** Localization needs
  `vscode.l10n`, which the server does not have.
- **A webview is a program of its own.** Its TypeScript compiles against the DOM
  alone, reads nothing of `src/` but `src/shared/utils/` and the types of its
  host's contract, and reaches its host as a string the host inlines.
- **The website reads the server's modules.** `website/scripts/` imports the
  lint engine, the syntax diagnostics, the annotation features and the
  highlighter from `src/server/` to render its samples through the real
  pipeline, so those exports carry an unstated stability duty. Accepted for
  now; revisit when it starts breaking the site.

esbuild produces two bundles, `dist/client/extension.js` and
`dist/server/server.js`. The stylesheet fragments and the webview scripts become
generated modules first (`scripts/gen-styles.ts`, `scripts/gen-webview.ts`), and
the TextMate grammar of `.jpnov` is generated from the notation and the colour of
each part role (`scripts/gen-grammar.ts`); generated files are not committed.
`npm run gen` (`scripts/gen.ts`) runs the three together, and every script that
reads `src/` runs it first, through its `pre*` hook or, for the bundles, inside
`esbuild.config.js`.

## The pipeline

```text
.jpnov text
   │  scan        src/shared/ast/scan.ts
   ▼
nodes            each line as written
   │  resolve     src/shared/ast/resolve.ts
   ▼
AST              what the notation means     ──▶  editor: diagnostics, lint
   │  buildRows   src/shared/compiler/layout.ts
   ▼
rows of units
   ├─ wrap, 禁則, paginate   ──▶  preview, book HTML, the book's counts
   └─ reflow                 ──▶  EPUB

The text build prints the nodes.
```

| Stage | Produces | Holds |
| --- | --- | --- |
| **Scanner** | Per line, the nodes in source order: text, annotations, ruby marks and readings. Each is a verbatim slice with its position; an annotation also carries the position of every part inside it. | Lossless: printing the nodes gives the source back. Every pairing the scanner makes is bounded by its line, so broken markup affects that line alone. |
| **AST** | Per line, the content in paint order with its decoration marks, and the line's state (block 字下げ, 見出し, 改ページ). Beside the lines: which span start pairs with which end, what each annotation bound to, and every structural finding. | Total: it always yields a result. Content strings are display strings (kana composed, values substituted, a 外字注記 as its character, the characters no output can carry dropped), a character being one grapheme cluster; the nodes stay verbatim. |
| **Output** | Rows of units, a unit being one glyph group with its advance in cells. From the rows: the preview, the paginated HTML, the EPUB. | The only stage that takes layout settings. |

`parse` is `scan` followed by `resolve`.

The editor side of the server keeps one scan and one resolve per document
version (`src/server/parsed.ts`). The highlighter reads the nodes for the markup
and the AST for the narration; the syntax diagnostics, the hover, the lint and
the preview read the AST. The lint judges the content, the line as its reader
sees it (`src/server/shown.ts`), and lands its fixes on the nodes: what was
typed is edited in place, what an annotation shows is not, and an insert at its
edge goes outside the annotation. The builds parse on their
own, from the files they read through `jpnov/readText`; a cover page, and the
page furniture, also get the book's values.

The outputs:

| Output | Entry point | From |
| --- | --- | --- |
| Preview | `renderPreview` | the rows, as one continuous flow, marked where the build would turn the page |
| Book HTML | `renderBook` | the rows, paginated in the compiler so the printed page is what the screen showed |
| EPUB | `epubMembers` | the rows, reflowed: the reading system breaks the lines and the pages; the block 字下げ keeps the paginated cap |
| Text | `concatBookText` | the nodes, printed back; the characters no output can carry removed |

Preview and builds run the same layout engine. No output has a rule the others
lack, error states included: an unclosed annotation prints as the characters it
is made of, everywhere.

## Where logic goes

Decide the stage first. The rules:

1. **Place logic by what it needs.** A decision that depends on what an
   annotation bound to belongs after the AST, because binding happens there.
   Made earlier, it has to guess, and every annotation then has to be taught
   about the guess.

2. **Layout settings enter at `buildRows` or later, never above it.** The Scanner
   and the AST take no setting. So the editor and every output read the same
   AST, and a diagnostic the editor shows holds for every output.

   The values of ［＃ここに「…」の値を表示］ are data of the book, not settings:
   the title and the pen name come from its `.jpbook`, the page count and the
   sheet count from laying out its chapters (`bookCounts`, which also gives the
   Books view its figures). They reach only the AST of a cover
   page, and a cover page is resolved after the chapters are laid out. The editor
   resolves without them, so it does not report an annotation that fails to bind
   after a value: the real value is unknown.

3. **A character class lives with the rule that uses it.** Which characters form
   a ruby base is a rule of the notation: the Scanner. Which characters may not
   start a line, which must not be split, which half-width run sets as one: rules
   of typesetting, in Output. One character may be classed twice, each stage
   cutting as finely as its own rule needs.

4. **With one consumer, the logic lives in that consumer's stage.** It moves
   upstream when a second consumer appears there, not before.

5. **The text build bypasses the rows.** It prints the nodes, to stay faithful to
   what was typed. What Output decides reaches the text as insertions at
   positions of the source. The text build's one own edit is removing the
   characters no output can carry, from each chapter and from the divider
   (`concatBookText`).

6. **A stage is a boundary, not a module.** Do not split a module to make the
   stages look complete.

Where things live today:

| Logic | Stage | Reason |
| --- | --- | --- |
| Which characters before a `《…》` are its base | Scanner | a rule of the notation; a grapheme cluster is one character, classed by its first code point |
| The largest 字下げ that is read | Scanner | a rule of the notation |
| What a ［＃○字下げ］ shows: ○ full-width spaces where it stands, so a wrapped continuation returns to the margin ([layout_2](https://www.aozora.gr.jp/annotation/layout_2.html), １行だけの字下げ); the block form is a value of the line, padding on every column of it | AST (the spaces); Output (the block padding) | content is what is shown; the padding is typesetting |
| Pairing ［＃傍点］ with ［＃傍点終わり］; finding what ［＃「…」に傍点］ names | AST | what the notation means |
| A start while its channel is in effect (［＃太字］ inside ［＃ここから太字］); a ［＃ここから○字下げ］ of another count is the notation's own form, not a finding ([layout_2](https://www.aozora.gr.jp/annotation/layout_2.html)) | AST (the finding); editor (the fix removing a start that sets again what is in effect, or an end with nothing open, with its line when a block directive had it to itself) | the slot is the resolver's: a start replaces the open one, never nests; whether a line can go is the editor's |
| An end of the other form than its start (［＃ここから太字］ closed by ［＃太字終わり］) | AST (the finding); editor (the fix, `src/server/syntax.ts`) | the pairing is the resolver's, and it holds both forms; which annotation to rewrite, and how, is the editor's: the end, respelled in the start's form |
| A `《…》` no ｜ opened and no base precedes | AST (the finding); editor (the fix, `src/server/syntax.ts`) | the scanner knows it made no ruby; respelling it as the 二重山括弧 外字注記, the brackets it already prints as, is the editor's call, and only where no ｜ said ruby was meant |
| Which `※［＃…］` is a 外字注記 | Scanner | a rule of the notation: the annotation directly follows its `※` |
| Showing a 外字注記 as its character | AST | content is what is shown |
| What one character shown is: a grapheme cluster, its kana composed | AST | content is what is shown; a target cannot cut one |
| Dropping a character no output can carry (a C0 control other than tab and the line ends, U+FFFE, U+FFFF) | AST | content is what is shown; the nodes keep it, so the lint reports it |
| Where each character shown was written in the source | AST | kana are composed, characters dropped, values and 外字注記 substituted there; a ruby and a 縦中横 keep the runs they were joined from; Output does not read the source |
| The narration a name or a keyword is recognised in | editor (`src/server/shown.ts`, the highlighter) | the body as the AST shows it, so a word the markup cuts (新［＃「新」に傍点］帝都) is one word; what is coloured is where each piece was written |
| What the lint judges, and where its fixes land | editor (`src/server/lint/`) | a rule reads the line as shown, so a 外字注記 is its character and a ［＃○字下げ］ its spaces, with no exception per rule; a fix edits the source: typed text in place, never what an annotation shows (an insert at its edge goes outside the annotation, a deletion of the spaces removes the ［＃○字下げ］); the block 字下げ is a value of the line, not characters, and is not judged |
| The ダッシュ glyph, 禁則, 分離禁止, ぶら下げ, the space dropped after a line-end 区切り約物, ruby overhang, wrapping, pagination | Output | typesetting, driven by layout settings |
| The class of a character under 禁則: its first code point's | Output | a rule of typesetting |
| Which characters a ダッシュ may be typed with (－－, ––), and that ー never is one | editor (lint) | a convention of the manuscript; the typesetting class stays the 分離禁止 one |
| A 縦中横 too long to fit its cell | editor | a threshold, judged on what the AST holds |
| Which 「」『』 of the prose open and close an utterance, across lines | editor (`src/server/dialogue.ts`; the corner characters themselves in `src/shared/chars.ts`) | a convention of the manuscript over the prose of the content, read by the lint and the highlighter alike; an annotation's 「対象」, what a value shows and a listed name hold no corner |
| A half-width pair (`!?`) with no 縦中横 annotation | editor | a manuscript convention, judged on what the AST holds; the fix replaces the pair with its character or writes the annotation, as the lint setting says |
| What an annotation shows on hover, what lights up with it, renaming a 対象文字列 with the body it names, a fix rewriting the 「…」 of the postfix bound over it | editor (`src/server/annotations.ts`, `targets.ts`) | each reads what the postfix bound to and which start pairs with which end: the resolver's findings; the 「…」 is rewritten only where it is written as the body it bound to |
| Writing `‼` `⁇` `⁈` `⁉` `¡` `¿` as 外字注記 in a Shift JIS text (`《` `》` have a cell and are written as themselves) | client (`encodeTxt`, `src/shared/encoding.ts`) | the encoding is a client setting; the Scanner and the AST take none |

## The full pipeline, and why ours is shorter

Written out in full, a compiler for the notation would have nine stages:

```text
source → Scanner → Tokenizer → Parser → AST → Resolver → Analyzer → IR → Output
```

| In full | Here |
| --- | --- |
| Scanner, Tokenizer, Parser | `scan.ts` with `classify.ts`, one pass |
| AST | the nodes (the textbook's AST is the parser's output; what this document calls the AST is the Resolver's) |
| Resolver | `resolve.ts` |
| Analyzer | syntax diagnostics (`src/server/syntax.ts`), lint (`src/server/lint/`), highlighting, the annotation features (`src/server/annotations.ts`) |
| IR | the rows of units |
| Output | the emitters of `src/shared/compiler/` |

The first three are one pass because the notation is flat: a ruby and an
annotation close on their own line, and nothing nests. There is no tree to
build, and a tokenizer would hand the parser nothing the scanner does not know
already. Spans that run across lines are paired in the Resolver.

What the full list contributes is the order, and with it rule 2: a setting that
belongs to the IR must not reach the stages above it.

## Books and workspace folders

Everything about a book comes from the directory of its `.jpbook`. Its entries
count from there, as an `import` counts from its module: `../` goes up, and
nothing stops it at a workspace folder. Its output folder is that directory
joined with `jpnov.layout.outDir` (a `${workspaceFolder}/…` value, the default
included, joins onto the book's root instead, and onto the book's directory
when it has none), and its output name is its path from that base without
`.jpbook`, `-` for `/`: the bare file name under a book-relative `outDir`, the
folders joined under `${workspaceFolder}/…`, so two folders of one root may
each hold a `原稿.jpbook`. The same file means the same book whichever folder
is open, and with none.

A root is a workspace folder, and a folder nested in another is a root of its
own. A root decides five things: which `.jpbook` files discovery finds
(the walk stops at every other root, at dot-folders and at `node_modules`), the group a
book is listed under, the `outDir` value of the books found under it, the
narration vocabulary of the chapters under it (the union of the `characters:`
and `keywords:` of every `.jpbook` under that root, whichever book the chapter
is in), and which books a `.jpbook`'s names are checked against for the
conflict diagnostic. A
`.jpbook` open in the editor that no root contains is listed too, with the
`outDir` the client reads for its uri (`rootUri: null`, the 「開いているファイル」
group); it adds no names. The folder a chapter sits in decides the settings of
that file (the encoding it is read in) as well.

Each reader takes the book's directory from one place:

| Reader | Takes the directory from |
| --- | --- |
| The list and the builds (`src/server/build.ts`) | `parentUri(book.uri)`, the book discovered or sent open |
| An open `.jpbook` (`src/server/server.ts`) | `parentUri(doc.uri)` |
| The Books view and 「章を追加…」 (`src/client/book/`) | `BookEntry.uri`; `rootUri` only names the group |
| Rename tracking (`src/client/book/tracking.ts`) | the book's own path after the event, mapped back through the renames for the path before |

The client never asks VS Code for a workspace-relative path. `asRelativePath`
counts from the workspace folder of the file it is given; a book entry counts
from the directory of its `.jpbook`.

## What keeps this true

- **Import rules** (`eslint.config.mjs`): `src/shared/` and `src/server/` may not
  import `vscode`; `src/shared/ast/` may import only its own modules,
  `src/shared/chars.ts` and `src/shared/utils/`; `chars.ts` imports nothing, and
  holds the character tables the stages share, the grapheme clusters among them;
  `src/shared/utils/` imports nothing, its own files included. The AST cannot see the
  settings types, so it cannot take a setting by accident. In `src/server/`,
  only the preview (`server.ts`) and the builds (`build.ts`) may import
  `src/shared/compiler/`: the editor side reads the nodes and the AST.
  `src/shared/compiler/` may not import the manifest (`src/shared/book/`), the
  wire shapes (`protocol.ts`) or a program (`src/server/`, `src/client/`). A
  webview may import only its own folder, `src/shared/utils/` and the types of
  `src/client/protocol.ts`.
- **Properties** (`test/shared/ast/properties.test.ts`), checked over generated
  manuscripts: the nodes print back the source, they tile their line, the
  relations name nodes of the lines, and a line resolved alone binds as it does
  in its manuscript.
- **The dual of the text build** (`test/shared/compiler/document.test.ts`):
  rendering the concatenated text gives the pages that rendering the chapters
  gave.
- **The directory of a book** (`eslint.config.mjs`, `test/server/build.test.ts`):
  `src/client/` may not call `asRelativePath` (it counts from the folder; a book
  entry counts from the `.jpbook`), and the tests hold the list and the builds to
  the book's own directory, the one the editor resolves the same book against.
- **End to end** (`test/e2e/`): the bundled server over LSP, and the pages it
  renders in a headless browser.
