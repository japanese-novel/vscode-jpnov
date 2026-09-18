/**
 * The Books panel's webview-side renderer (runs in the panel's browser realm). It rebuilds the DOM
 * from the host's pushed `state` / `detail` messages with the `h()` builder — string children
 * become text nodes, so user data (book titles, chapter paths) NEVER flows through innerHTML and
 * can carry no markup — and dispatches every user action back as a typed message. The host
 * ({@link ../../book/view.ts}) owns all truth; a checkbox toggle updates optimistically and is not
 * echoed, but each `state` push is authoritative and reconciles the view.
 *
 * Because every push rebuilds the DOM, cross-render continuity rides on two mechanisms: `data-fk`
 * focus keys captured/restored around each rebuild (capture/restore/focusKeys; each control also
 * declares its `fallback` keys for when it vanishes or goes disabled), and applyControls(), which
 * owns the list footer's disabled state after each list render and optimistic toggle. Localized
 * strings arrive once via the host's `__INIT` bootstrap.
 */
import type {
  BooksInbound,
  BooksInit,
  BooksOutbound,
  BookVM,
  BuildAction,
  DetailMessage,
  EntryList,
  EntryVM,
  MetaVM,
  StateMessage,
  WelcomeAction,
} from '../../protocol.ts';

import { svgGlyph } from '../svg.ts';

/** Every glyph the panel draws; `cbOff`/`cbOn` are the selection checkbox's two states. */
type IconName =
  | 'chevR' | 'chevL' | 'up' | 'down' | 'err' | 'pick' | 'newFile' | 'close' | 'edit' | 'grip' | 'cbOff' | 'cbOn';

/** Codicon suffix per icon; the element gets `class="codicon codicon-<suffix>"`. */
const CODICON: Record<IconName, string> = {
  chevR: 'chevron-right',
  chevL: 'chevron-left',
  up: 'chevron-up',
  down: 'chevron-down',
  err: 'error',
  pick: 'checklist',
  newFile: 'new-file',
  close: 'close',
  edit: 'edit',
  grip: 'gripper',
  cbOff: 'circle-large-outline',
  cbOn: 'circle-large-filled',
};

const api = acquireVsCodeApi();
function post(m: BooksOutbound): void {
  api.postMessage(m);
}
/** A click/action handler that dispatches one fixed message — snapshots `m` at build time. */
function poster(m: BooksOutbound): () => void {
  return () => {
    post(m);
  };
}

const L = (window.__INIT as BooksInit).labels;

/** Per-list strings: the two entry sections render identically, only the words differ. */
const LIST_TEXT: Record<EntryList, { title: string; add: string; create: string; open: string; empty: string }> = {
  chapters: { title: L.chapters, add: L.addChapters, create: L.newChapter, open: L.openChapter, empty: L.noChapters },
  covers: { title: L.covers, add: L.addCovers, create: L.newCover, open: L.openCover, empty: L.noCovers },
};

/** The root element, guaranteed present (the shell always emits `<div id="app">`). Returning a
 * non-null type keeps it narrowed inside the render closures below. */
function requireApp(): HTMLElement {
  const el = document.getElementById('app');
  if (el === null) {
    throw new Error('#app missing');
  }
  return el;
}
const app = requireApp();

let state: StateMessage | null = null;
let detail: DetailMessage | null = null;
let screen: 'list' | 'detail' = 'list';
let lastDetailUri: string | null = null;
let infoOpen = false;
let coverOpen = false; // folds like Book Info, except on entry to a book whose cover list shows an error
/** The row being dragged: its identity for the drop message, and its element to mark pending. */
let drag: { readonly list: EntryList; readonly line: number; readonly path: string; readonly row: HTMLElement } | null = null;
let detailWanted = false; // true while the detail screen is intended (user click, or an adopted host reveal)

/** The attributes/handlers this panel sets; keys mirror the DOM attribute names, so a grep for
 * `data-fk` / `aria-expanded` finds every writer. Extend only as call sites need. */
interface Props {
  readonly class?: string;
  readonly title?: string;
  readonly role?: string;
  readonly type?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-expanded'?: boolean;
  readonly 'aria-hidden'?: true;
  readonly 'data-fk'?: string;
  /** Focus keys to try, in order, when this control is gone or disabled after a rebuild; `undefined`
   * entries (absent neighbours) are dropped. Never a destructive or build action. */
  readonly fallback?: readonly (string | undefined)[];
  readonly onClick?: () => void;
}
/** A child of `h()`; `false` is skipped so call sites can inline `cond && h(...)` conditionals. */
type Child = Node | string | false;

/** The Props keys h() writes with `setAttribute`; booleans serialize as 'true'/'false'. */
const ATTRS: readonly Exclude<keyof Props, 'onClick' | 'fallback'>[] =
  ['class', 'title', 'role', 'type', 'aria-label', 'aria-expanded', 'aria-hidden', 'data-fk'];
/** Each control's declared `fallback` keys, read by capture() off the outgoing DOM. */
const FALLBACK = new WeakMap<Element, readonly string[]>();

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const name of ATTRS) {
    const v = props[name];
    if (v !== undefined) {
      el.setAttribute(name, String(v));
    }
  }
  if (props.onClick !== undefined) {
    el.addEventListener('click', props.onClick);
  }
  if (props.fallback !== undefined) {
    FALLBACK.set(el, props.fallback.filter((k): k is string => k !== undefined));
  }
  for (const c of children) {
    if (c !== false) {
      el.append(c);
    }
  }
  return el;
}
/** A codicon glyph span; `extraCls` appends site classes. */
function icon(name: IconName, extraCls?: string): HTMLSpanElement {
  const cls = 'codicon codicon-' + CODICON[name] + (extraCls === undefined ? '' : ' ' + extraCls);
  return h('span', { class: cls, 'aria-hidden': true });
}
/**
 * Inline-SVG glyphs for the build buttons (a printer on the primary print button, the EPUB
 * mark on its icon button) — the webview CSP loads no external images, and currentColor
 * keeps them right in every theme. `print` is Fluent UI System Icons' ic_fluent_print_16_regular
 * (MIT, https://github.com/microsoft/fluentui-system-icons; codicons have no printer). `epub` is
 * the mark-only cut of the official logo (https://www.w3.org/publishing/groups/epub-wg/, whose
 * usage guide allows the bare mark), its viewBox the mark's measured bounds.
 */
const GLYPH = {
  print: {
    viewBox: '0 0 16 16',
    d: [
      'M4 3.5C4 2.67157 4.67157 2 5.5 2H10.5C11.3284 2 12 2.67157 12 3.5V4H13C14.1046 4 15 4.89543 15 6V10.5C15 11.3284 14.3284 12 13.5 12H12V12.5C12 13.3284 11.3284 14 10.5 14H5.5C4.67157 14 4 13.3284 4 12.5V12H2.5C1.67157 12 1 11.3284 1 10.5V6C1 4.89543 1.89543 4 3 4H4V3.5ZM4 11V10.5C4 9.67157 4.67157 9 5.5 9H10.5C11.3284 9 12 9.67157 12 10.5V11H13.5C13.7761 11 14 10.7761 14 10.5V6C14 5.44772 13.5523 5 13 5H3C2.44772 5 2 5.44772 2 6V10.5C2 10.7761 2.22386 11 2.5 11H4ZM5 4H11V3.5C11 3.22386 10.7761 3 10.5 3H5.5C5.22386 3 5 3.22386 5 3.5V4ZM5 10.5V12.5C5 12.7761 5.22386 13 5.5 13H10.5C10.7761 13 11 12.7761 11 12.5V10.5C11 10.2239 10.7761 10 10.5 10H5.5C5.22386 10 5 10.2239 5 10.5Z',
    ],
  },
  epub: {
    viewBox: '97.1 135.5 401.2 401.2',
    d: [
      'M297.63,462.07,171.58,336l126-126,42,42-84.05,84,42,42L423.69,252,313.88,142.17a23,23,0,0,0-32.48,0L103.79,319.78a23,23,0,0,0,0,32.48L281.4,529.86a23,23,0,0,0,32.48,0l177.61-177.6a23,23,0,0,0,0-32.48L465.7,294Z',
    ],
  },
} as const;

/** An h()-composable SVG glyph; SVG needs createElementNS, which h() (HTML-only) cannot do. */
function glyph(name: keyof typeof GLYPH): SVGSVGElement {
  const mark = GLYPH[name];
  return svgGlyph(mark.viewBox, mark.d);
}

/** `data-fk` is required — every icon button participates in the focus-restore system. */
interface BtnExtra {
  readonly 'data-fk': string;
  readonly fallback?: readonly (string | undefined)[];
  readonly disabled?: boolean;
}
function iconBtn(name: IconName, aria: string, fn: () => void, extra: BtnExtra): HTMLButtonElement {
  const b = h('button', {
    class: 'iconbtn', 'aria-label': aria, title: aria, onClick: fn,
    'data-fk': extra['data-fk'], fallback: extra.fallback ?? [],
  }, icon(name));
  b.disabled = extra.disabled ?? false;
  return b;
}
/** The scrollable pane; `scroller()` (for capture/restore) finds it by this class. */
function scrollPane(...children: Child[]): HTMLElement {
  return h('div', { class: 'scroll' }, ...children);
}
function scroller(): Element | null {
  return app.querySelector('.scroll');
}

/** The focus keys to try (own key first, then its declared fallbacks) + scroll offset, restored
 * across a host-driven re-render. */
interface Capture {
  readonly keys: readonly string[];
  readonly top: number;
}
// Focus + scroll preservation across host-driven re-renders (the detail edit loop rebuilds the DOM).
function capture(): Capture {
  const a = document.activeElement;
  const key = a === null ? null : a.getAttribute('data-fk');
  const keys = a === null || key === null ? [] : [key, ...(FALLBACK.get(a) ?? [])];
  const sc = scroller();
  return { keys, top: sc ? sc.scrollTop : 0 };
}
/** Focuses the first key whose control exists and is enabled; none → focus stays where the rebuild left it. */
function focusKeys(keys: readonly string[]): void {
  const byKey = new Map<string, HTMLButtonElement>();
  for (const el of app.querySelectorAll<HTMLButtonElement>('[data-fk]')) {
    const k = el.getAttribute('data-fk');
    if (k !== null) {
      byKey.set(k, el);
    }
  }
  for (const key of keys) {
    const el = byKey.get(key);
    if (el !== undefined && !el.disabled) {
      el.focus();
      return;
    }
  }
}
function restore(cap: Capture): void {
  const sc = scroller();
  if (sc) {
    sc.scrollTop = cap.top;
  }
  focusKeys(cap.keys);
}
function counts(): { selected: number; total: number } {
  let sel = 0;
  let total = 0;
  if (state) {
    for (const group of state.groups) {
      for (const b of group.books) {
        total += 1;
        if (b.checked) {
          sel += 1;
        }
      }
    }
  }
  return { selected: sel, total };
}
// Drive every footer control from (selected, total): Select-all off when all are already selected,
// Deselect-all off when none are, and the build buttons off when none are. Called after each list
// render and on every optimistic toggle. The detail footer shares these data-fk keys but must stay
// enabled, hence the list-only guard.
function applyControls(): void {
  if (screen !== 'list') {
    return;
  }
  const c = counts();
  const off = { selall: c.selected === c.total, deselall: c.selected === 0, build: c.selected === 0 };
  const els = app.querySelectorAll<HTMLButtonElement>('[data-fk]');
  for (const el of els) {
    const k = el.getAttribute('data-fk');
    if (k === 'selall') {
      el.disabled = off.selall;
    } else if (k === 'deselall') {
      el.disabled = off.deselall;
    } else if (k === 'bprint' || k === 'btxt' || k === 'bepub') {
      el.disabled = off.build;
    }
  }
}
// The entry after the given one in the current detail's list (null if it is the last) — DnD target.
function nextEntry(list: EntryList, line: number): EntryVM | null {
  const entries = detail?.[list] ?? [];
  const i = entries.findIndex((e) => e.line === line);
  return i < 0 ? null : entries[i + 1] ?? null;
}
function clearDrop(): void {
  for (const el of app.querySelectorAll('.drop-before, .drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

function render(): void {
  if (screen === 'detail' && detail) {
    renderDetail();
  } else {
    renderList();
  }
}

function renderList(): void {
  // Before the first enumeration lands (server still starting) show a neutral placeholder, NOT the
  // "no books yet" welcome — the books may well exist and that copy would misleadingly say create one.
  if (state?.loading) {
    app.replaceChildren(scrollPane(h('div', { class: 'empty' }, L.loading)));
    return;
  }
  if (state?.noFolder) {
    app.replaceChildren(scrollPane(
      welcome(L.noFolderTitle, L.noFolderBody, [['openFolder', L.openFolder], ['openGuide', L.openGuide]])));
    return;
  }
  if (counts().total === 0) {
    app.replaceChildren(scrollPane(
      welcome(L.noBooksTitle, L.noBooksBody, [['createBook', L.createBook], ['openGuide', L.openGuide]])));
    return;
  }
  const groups = state?.groups ?? [];
  const flat = groups.flatMap((g) => g.books); // row neighbours run across group boundaries
  app.replaceChildren(
    scrollPane(h('div', { class: 'list' }, ...groups.flatMap((g) => [
      g.rootLabel !== null && h('div', { class: 'group-header' }, g.rootLabel),
      ...g.books.map((b) => {
        const i = flat.indexOf(b);
        return bookRow(b, flat[i + 1], flat[i - 1]);
      }),
    ]))),
    footer(),
  );
  applyControls();
}

/** The single writer of the checkbox's checked look (aria-checked, `.on` tint, glyph) — used at
 * build time and by the optimistic toggle. */
function paintChecked(cb: HTMLButtonElement, checked: boolean): void {
  cb.setAttribute('aria-checked', String(checked));
  cb.classList.toggle('on', checked);
  cb.replaceChildren(icon(checked ? 'cbOn' : 'cbOff'));
}

/** A neighbouring book's row key, or undefined past the list's edge. */
function bookKey(prefix: 'cb:' | 'book:', b: BookVM | undefined): string | undefined {
  return b === undefined ? undefined : prefix + b.uri;
}

// `next`/`prev`: the rows focus moves to once this one is gone (the book deleted), staying in its column.
function bookRow(bk: BookVM, next: BookVM | undefined, prev: BookVM | undefined): HTMLElement {
  // Custom checkbox: a button with role=checkbox. The glyph is always in the DOM (hidden until hover
  // or checked); the .on class tints the tile and swaps the outline circle for the filled one.
  const cb = h('button', {
    class: 'cbtile',
    role: 'checkbox',
    'aria-label': L.selectBook + ': ' + bk.title,
    'data-fk': 'cb:' + bk.uri,
    fallback: [bookKey('cb:', next), bookKey('cb:', prev)],
  });
  paintChecked(cb, bk.checked);
  cb.addEventListener('click', () => {
    const checked = !bk.checked;
    paintChecked(cb, checked);
    // Optimistic: write the cached VM so applyControls()'s counts() sees the new value now, and a
    // later re-render off this state (e.g. Back from detail) reflects it. The host records the
    // selection authoritatively without echoing.
    (bk as { checked: boolean }).checked = checked;
    applyControls();
    post({ type: 'toggle', uri: bk.uri, checked });
  });
  return h('div', { class: 'row book' },
    cb,
    h('button', {
      class: 'main',
      'aria-label': bk.title,
      'data-fk': 'book:' + bk.uri,
      fallback: [bookKey('book:', next), bookKey('book:', prev)],
      onClick: () => {
        detailWanted = true;
        post({ type: 'openDetail', uri: bk.uri });
      },
    },
    h('div', { class: 'maincol' },
      h('div', { class: 'title' }, bk.title),
      h('div', { class: 'sub' }, bk.fileRel)),
    icon('chevR', 'chev')));
}

// Disabled states (list mode only) are applied by applyControls() once the footer is in the DOM.
function footer(buildUri?: string): HTMLElement {
  const build = (format: BuildAction): BooksOutbound =>
    buildUri === undefined ? { type: 'build', format } : { type: 'build', format, uri: buildUri };
  return h('div', { class: 'footer' },
    // Justified to the two edges: Deselect on the left, Select on the right. Each link's own click
    // disables it (none / all selected), so focus crosses to the other one.
    buildUri === undefined &&
      h('div', { class: 'selrow' },
        h('button', { class: 'link', 'data-fk': 'deselall', fallback: ['selall'], onClick: poster({ type: 'deselectAll' }) },
          L.deselectAll),
        h('button', { class: 'link', 'data-fk': 'selall', fallback: ['deselall'], onClick: poster({ type: 'selectAll' }) },
          L.selectAll)),
    // Build buttons go disabled only on the list (the last checked book vanished); Select all is the way back.
    // Icon + text primary: a printer glyph rides the print button.
    h('button', { class: 'btn primary', 'data-fk': 'bprint', fallback: ['selall'], onClick: poster(build('print')) },
      glyph('print'), L.print),
    // The text button keeps the row's growing flex; EPUB is an icon button whose
    // accessible name doubles as the hover tooltip.
    h('div', { class: 'btnrow' },
      h('button', { class: 'btn', 'data-fk': 'btxt', fallback: ['selall'], onClick: poster(build('txt')) }, L.buildTxt),
      h('button', {
        class: 'btn icon', 'data-fk': 'bepub', title: L.buildEpub, 'aria-label': L.buildEpub,
        fallback: ['selall'], onClick: poster(build('epub')),
      }, glyph('epub'))),
    revealRow(),
  );
}

/** The "open the output folder after building" preference: optimistic like the book checkboxes —
 * paint + cache the new value here, the host records it without echoing. */
function revealRow(): HTMLElement {
  const input = h('input', { type: 'checkbox', 'data-fk': 'reveal' });
  // `state` always precedes a footer render (the ready handshake answers with it); the
  // fallback mirrors the host-side default.
  input.checked = state?.revealOutput ?? true;
  input.addEventListener('change', () => {
    if (state) {
      (state as { revealOutput: boolean }).revealOutput = input.checked;
    }
    post({ type: 'revealOutput', on: input.checked });
  });
  return h('label', { class: 'chkrow' }, input, L.revealOutput);
}

/** Entry-time fold rule: the cover list opens when it shows an error (a missing file). */
function troubledCovers(d: DetailMessage): boolean {
  return d.covers.some((e) => e.missing);
}

function renderDetail(): void {
  if (detail === null) {
    return;
  }
  const d = detail;
  drag = null; // a rebuild mid-drag (e.g. an edit-triggered refresh) cancels the in-progress drag
  const hdr = h('div', { class: 'dhdr' },
    iconBtn('chevL', L.back, () => {
      detailWanted = false;
      screen = 'list';
      detail = null;
      post({ type: 'closeDetail' });
      render();
      focusKeys(['book:' + (lastDetailUri ?? '')]);
    }, { 'data-fk': 'back' }),
    h('div', { class: 'dtitle' }, d.title));
  // Book Info: collapsible (collapsed by default), ABOVE the lists.
  const info = h('div', { class: 'section' },
    h('div', { class: 'shead' }, disclosure(infoOpen, L.bookInfo, 'infohead', () => {
      infoOpen = !infoOpen;
    })),
    ...(infoOpen ? d.meta.map((mi) => metaRow(d, mi)) : []));
  // Covers precede chapters, as in the printed book. The cover list folds like Book Info; the
  // chapter list is always open.
  app.replaceChildren(scrollPane(hdr, info, listSection(d, 'covers'), listSection(d, 'chapters')), footer(d.uri));
}

/** The disclosure button of a collapsible section (caret + title); `flip` toggles the state it reflects. */
function disclosure(open: boolean, title: string, fkKey: string, flip: () => void): HTMLButtonElement {
  return h('button', {
    class: 'sectoggle',
    'aria-expanded': open,
    'data-fk': fkKey,
    onClick: () => {
      flip();
      const c = capture();
      render();
      restore(c);
    },
  },
  icon(open ? 'down' : 'chevR', 'caret'),
  h('span', { class: 'stitle' }, title));
}

type EntryPart = 'open' | 'up' | 'down' | 'rm';
/** Focus keys carry the list: a file may be both a cover and a chapter, so its URI alone is not unique. */
function fk(list: EntryList, part: EntryPart, fileUri: string): string {
  return list + ':' + part + ':' + fileUri;
}

/**
 * One entry list: a header with the pick action, the rows (or the empty text), and the create-file
 * tail row. The cover list is collapsible — folded, only its disclosure shows.
 */
function listSection(d: DetailMessage, list: EntryList): HTMLElement {
  const text = LIST_TEXT[list];
  const entries = d[list];
  const collapsible = list === 'covers';
  const open = !collapsible || coverOpen;
  let title: HTMLElement;
  if (collapsible) {
    title = disclosure(coverOpen, text.title, 'coverhead', () => {
      coverOpen = !coverOpen;
    });
  } else {
    title = h('span', { class: 'stitle' }, text.title);
  }
  const body: Child[] = [];
  if (open) {
    body.push(
      entries.length === 0 && h('div', { class: 'empty' }, text.empty),
      ...entries.map((e, i) => entryRow(d, list, e, i, entries)),
      h('button', {
        class: 'row action',
        'data-fk': list + ':new',
        onClick: poster({ type: 'createEntry', uri: d.uri, list }),
      }, icon('newFile'), text.create),
    );
  }
  return h('div', { class: 'section' },
    h('div', { class: 'shead' },
      title,
      open && iconBtn('pick', text.add, poster({ type: 'addEntries', uri: d.uri, list }), { 'data-fk': list + ':add' })),
    ...body);
}

function entryRow(d: DetailMessage, list: EntryList, e: EntryVM, idx: number, entries: readonly EntryVM[]): HTMLElement {
  const grip = icon('grip', 'grip');
  const key = (part: EntryPart): string => fk(list, part, e.fileUri);
  // Once this row is gone (removed, or dropped by an edit) focus goes to the next row, which slides
  // into its place, else the previous, else the list header's add button.
  const openOf = (n: EntryVM | undefined): string | undefined => (n === undefined ? undefined : fk(list, 'open', n.fileUri));
  const vanished = [openOf(entries[idx + 1]), openOf(entries[idx - 1]), list + ':add'];
  const row = h('div', { class: 'row entry' + (e.missing ? ' missing' : '') });
  // A row verb names the row as rendered (line, path, the detail's version) and dims the row until
  // the host's re-push rebuilds the list; the host ignores a row the text no longer has.
  const ref = { line: e.line, path: e.path, version: d.version };
  const verb = (m: BooksOutbound): (() => void) => () => {
    row.classList.add('pending');
    post(m);
  };
  row.append(
    grip,
    h('button', {
      class: 'emain',
      title: e.missing ? (L.missing + ': ' + e.name) : LIST_TEXT[list].open,
      'aria-label': e.name,
      'data-fk': key('open'),
      fallback: vanished,
      onClick: poster({ type: 'openFile', uri: e.fileUri }),
    },
    e.missing && icon('err', 'err'),
    h('div', { class: 'maincol' },
      h('div', { class: 'title' },
        e.folder !== '' && h('span', { class: 'dir' }, e.folder + '/'),
        e.name))),
    // Focus keys use the entry's fileUri (stable across a move) so keyboard focus follows the row.
    // An arrow disabled at the list's edge hands focus to the other arrow, then the row — never to Remove.
    h('div', { class: 'acts' },
      iconBtn('up', L.moveUp, verb({ type: 'moveEntry', uri: d.uri, list, ...ref, dir: -1 }),
        { 'data-fk': key('up'), fallback: [key('down'), key('open'), ...vanished], disabled: idx === 0 }),
      iconBtn('down', L.moveDown, verb({ type: 'moveEntry', uri: d.uri, list, ...ref, dir: 1 }),
        { 'data-fk': key('down'), fallback: [key('up'), key('open'), ...vanished], disabled: idx === entries.length - 1 }),
      iconBtn('close', L.remove, verb({ type: 'removeEntry', uri: d.uri, list, ...ref }),
        { 'data-fk': key('rm'), fallback: vanished })));

  // Drag wiring attaches after construction — the handlers mutate `row` from both elements.
  grip.draggable = true;
  grip.addEventListener('dragstart', (ev: DragEvent) => {
    drag = { list, line: e.line, path: e.path, row };
    ev.dataTransfer?.setData('text/plain', '');
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
    }
    row.classList.add('dragging');
  });
  grip.addEventListener('dragend', () => {
    drag = null;
    row.classList.remove('dragging');
    clearDrop();
  });
  // Drop target: the pointer in a row's top half inserts before it, bottom half after it (before
  // next). Rows of the other list never preventDefault, so the browser refuses the drop there.
  row.addEventListener('dragover', (ev: DragEvent) => {
    if (drag?.list !== list || drag.line === e.line) {
      return;
    }
    ev.preventDefault();
    if (ev.dataTransfer) {
      ev.dataTransfer.dropEffect = 'move';
    }
    const r = row.getBoundingClientRect();
    const after = (ev.clientY - r.top) > r.height / 2;
    row.classList.toggle('drop-after', after);
    row.classList.toggle('drop-before', !after);
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-before', 'drop-after');
  });
  row.addEventListener('drop', (ev: DragEvent) => {
    if (drag?.list !== list) {
      return;
    }
    ev.preventDefault();
    const r = row.getBoundingClientRect();
    const after = (ev.clientY - r.top) > r.height / 2;
    row.classList.remove('drop-before', 'drop-after');
    // The dragged row stays dimmed until the host's re-push lands it in its new place.
    const target = after ? nextEntry(list, e.line) : e;
    drag.row.classList.add('pending');
    post({
      type: 'moveEntryTo', uri: d.uri, list, line: drag.line, path: drag.path, version: d.version,
      before: target === null ? null : target.line, beforePath: target === null ? null : target.path,
    });
    drag = null;
  });
  return row;
}

function metaRow(d: DetailMessage, mi: MetaVM): HTMLElement {
  return h('button', {
    class: 'row meta',
    'aria-label': mi.label + (mi.note ? ' ' + mi.note : '') + (mi.value ? ': ' + mi.value : ''),
    'data-fk': 'meta:' + mi.key,
    onClick: poster({ type: 'editMeta', uri: d.uri, metaKey: mi.key }),
  },
  h('div', { class: 'maincol' },
    // Status note (（既定）/（未設定）) sits beside the LABEL; the value line holds only the value.
    h('div', { class: 'mlabel' },
      h('span', { class: 'mlabeltext' }, mi.label),
      mi.note !== '' && h('span', { class: 'mnote' }, mi.note)),
    mi.value !== '' && h('div', { class: 'mvalue' }, mi.value)),
  icon('edit', 'pen'));
}

function welcome(title: string, body: string, actions: readonly (readonly [WelcomeAction, string])[]): HTMLElement {
  return h('div', { class: 'welcome' },
    h('div', { class: 'wtitle' }, title),
    h('div', { class: 'wbody' }, body),
    ...actions.map(([action, label]) =>
      h('button', { class: 'btn welcomebtn', onClick: poster({ type: 'welcome', action }) }, label)));
}

window.addEventListener('message', (e: MessageEvent) => {
  const m: unknown = e.data;
  if (typeof m !== 'object' || m === null || !('type' in m)) {
    return;
  }
  const msg = m as BooksInbound;
  switch (msg.type) {
    case 'state':
      state = msg;
      // Only the list screen renders off state; preserve focus/scroll across the rebuild.
      if (screen === 'list') {
        const c = capture();
        render();
        restore(c);
      }
      break;
    case 'detail': {
      if (!detailWanted && msg.reveal !== true) {
        return; // a late push arriving after the user navigated back is ignored
      }
      detailWanted = true; // a reveal adopts the intent, so later plain re-pushes render too
      // A re-push of the SAME open book (after an edit saved -> watcher -> refresh) preserves
      // focus/scroll; opening a book fresh moves focus to the Back button.
      const reentry = screen === 'detail' && detail !== null && detail.uri === msg.uri;
      const troubled = troubledCovers(msg);
      detail = msg;
      screen = 'detail';
      lastDetailUri = msg.uri;
      if (reentry) {
        if (msg.reveal === true) {
          coverOpen = coverOpen || troubled; // a failed build of the open book re-applies the entry rule
        }
        const c2 = capture();
        render();
        restore(c2);
      } else {
        infoOpen = false; // a freshly opened book folds Book Info; the cover list opens only to show an error
        coverOpen = troubled;
        render();
        focusKeys(['back']);
      }
      break;
    }
    case 'closeDetail':
      // Precedes the list re-push that drops a vanished book (view.ts refresh()), so its row is still
      // here to take focus; the next `state` then moves focus on through the row's fallback keys.
      detailWanted = false;
      screen = 'list';
      detail = null;
      render();
      focusKeys(['book:' + (lastDetailUri ?? '')]);
      break;
  }
});

post({ type: 'ready' });
