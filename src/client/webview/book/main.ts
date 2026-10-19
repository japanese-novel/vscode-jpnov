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
 *
 * Every row list is an ARIA grid with a roving tabindex (one Tab stop per list; arrows move among
 * rows and cells, see onKey): the cell holding `tabindex="0"` is derived state, recomputed by
 * initRoving() after each rebuild from the remembered cursor and moved by the focusin listener.
 */
import type {
  BooksInbound,
  BooksInit,
  BooksOutbound,
  BookVM,
  BuildAction,
  CountsVM,
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
  | 'chevR' | 'chevL' | 'up' | 'down' | 'err' | 'add' | 'close' | 'edit' | 'cbOff' | 'cbOn';

/** Codicon suffix per icon; the element gets `class="codicon codicon-<suffix>"`. */
const CODICON: Record<IconName, string> = {
  chevR: 'chevron-right',
  chevL: 'chevron-left',
  up: 'chevron-up',
  down: 'chevron-down',
  err: 'error',
  add: 'add',
  close: 'close',
  edit: 'edit',
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

/** Per-list strings: the entry sections render identically, only the words differ. */
const LIST_TEXT: Record<EntryList, { title: string; add: string; empty: string }> = {
  chapters: { title: L.chapters, add: L.addChapters, empty: L.noChapters },
  covers: { title: L.covers, add: L.addCovers, empty: L.noCovers },
  characters: { title: L.characters, add: L.addCharacters, empty: L.noCharacters },
  keywords: { title: L.keywords, add: L.addKeywords, empty: L.noKeywords },
};

/** The sections that fold (every list but the chapters), in the order the detail shows them. */
const FOLDING: readonly EntryList[] = ['characters', 'keywords', 'covers'];

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
/** The folding sections now open; they fold like Book Info, except the cover list on entry to a book whose covers show an error. */
const openLists = new Set<EntryList>();
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
  /** The key equivalent of a control, in the attribute's own syntax (space-separated alternatives). */
  readonly 'aria-keyshortcuts'?: string;
  readonly 'data-fk'?: string;
  /** The grid a row list belongs to; the roving tabindex and the arrow keys address rows by it. */
  readonly 'data-grid'?: GridId;
  /** The entry list an entry section holds; the drop zone is found by it. */
  readonly 'data-list'?: EntryList;
  /** Focus keys to try, in order, when this control is gone or disabled: after a rebuild (focus
   * restore, the grid's Tab stop) or when an arrow move lands on it. `undefined` entries (absent
   * neighbours) are dropped. Never a destructive or build action. */
  readonly fallback?: readonly (string | undefined)[];
  readonly onClick?: () => void;
}
/** A child of `h()`; `false` is skipped so call sites can inline `cond && h(...)` conditionals. */
type Child = Node | string | false;

/** The Props keys h() writes with `setAttribute`; booleans serialize as 'true'/'false'. */
const ATTRS: readonly Exclude<keyof Props, 'onClick' | 'fallback'>[] = [
  'class', 'title', 'role', 'type', 'aria-label', 'aria-expanded', 'aria-hidden', 'aria-keyshortcuts',
  'data-fk', 'data-grid', 'data-list',
];
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
interface BtnExtra extends Pick<Props, 'fallback' | 'aria-keyshortcuts'> {
  readonly 'data-fk': string;
  readonly disabled?: boolean;
}
function iconBtn(name: IconName, aria: string, fn: () => void, { disabled = false, ...extra }: BtnExtra): HTMLButtonElement {
  const b = h('button', { class: 'iconbtn', 'aria-label': aria, title: aria, onClick: fn, ...extra }, icon(name));
  b.disabled = disabled;
  return b;
}
/** The scrollable pane; `scroller()` (for capture/restore) finds it by this class. */
function scrollPane(...children: Child[]): HTMLElement {
  return h('div', { class: 'scroll' }, ...children);
}
function scroller(): Element | null {
  return app.querySelector('.scroll');
}

/** A control's focus-key chain: its own key, then its declared fallbacks; empty without a key. */
function keyChain(el: Element): readonly string[] {
  const key = el.getAttribute('data-fk');
  return key === null ? [] : [key, ...(FALLBACK.get(el) ?? [])];
}
/** The first of `keys` that names an enabled control in `pool` (by `data-fk`). */
function firstEnabled(keys: readonly string[], pool: readonly HTMLButtonElement[]): HTMLButtonElement | undefined {
  for (const key of keys) {
    const el = pool.find((b) => b.getAttribute('data-fk') === key && !b.disabled);
    if (el !== undefined) {
      return el;
    }
  }
  return undefined;
}
/** The one way this file moves focus: focus, then make a grid cell its grid's Tab stop. A window
 * without focus moves `activeElement` but fires no focusin, hence the explicit rove. */
function focusEl(el: HTMLElement): void {
  el.focus();
  roveTo(el);
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
  const sc = scroller();
  return { keys: a === null ? [] : keyChain(a), top: sc ? sc.scrollTop : 0 };
}
/** Focuses the first key whose control exists and is enabled; none → focus stays where the rebuild left it. */
function focusKeys(keys: readonly string[]): void {
  const el = firstEnabled(keys, [...app.querySelectorAll<HTMLButtonElement>('[data-fk]')]);
  if (el !== undefined) {
    focusEl(el);
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

// Grids: every row list (the book list, the two entry lists, Book Info) is a `role=grid` whose
// rows hold their controls in `.cell` wrappers (the row's primary control a `rowheader`, the rest
// `gridcell`s). One Tab stop per grid (roving tabindex); the arrow keys move among rows and cells.
// A grid may span several containers (one per root group on the list screen, as a heading cannot
// sit inside a grid); rows are addressed by `data-grid`.

type GridId = 'books' | EntryList | 'meta';
const GRIDS: readonly GridId[] = ['books', 'meta', 'characters', 'keywords', 'covers', 'chapters'];
/** Per grid, the focus-key chain of the cell that last had focus; initRoving() replays it after a
 * rebuild so the Tab stop follows the row, as focus restore does. */
const cursor = new Map<GridId, readonly string[]>();
/** A grid cell's control. */
const CELL_BTN = '.cell > button';

/** A grid cell: the wrapper that makes `btn` a flex item of its row and takes it out of the Tab
 * order. `lead` is the row's primary control, its header for assistive tech and where Tab lands
 * when nothing is remembered; `stretch` is the full-height checkbox segment. */
function cell(btn: HTMLElement, kind?: 'lead' | 'stretch'): HTMLElement {
  btn.tabIndex = -1;
  return h('div', { class: kind === undefined ? 'cell' : 'cell ' + kind, role: kind === 'lead' ? 'rowheader' : 'gridcell' }, btn);
}
function gridRows(id: GridId): HTMLElement[] {
  return [...app.querySelectorAll<HTMLElement>('[data-grid="' + id + '"] [role="row"]')];
}
function cellsOf(row: Element): HTMLButtonElement[] {
  return [...row.querySelectorAll<HTMLButtonElement>(CELL_BTN)];
}
/** The grid cell `el` is (or sits in), with its row and grid; null outside every grid. */
function cellAt(el: Element): { readonly btn: HTMLButtonElement; readonly row: HTMLElement; readonly id: GridId } | null {
  const btn = el.closest<HTMLButtonElement>(CELL_BTN);
  const row = btn?.closest<HTMLElement>('[role="row"]') ?? null;
  const id = row?.closest('[data-grid]')?.getAttribute('data-grid') as GridId | null | undefined;
  return btn === null || row === null || id === null || id === undefined ? null : { btn, row, id };
}
/** A grid cell that took focus becomes its grid's Tab stop, remembered by its key chain. Called by
 * focusEl and by focusin (Tab, the mouse). */
function roveTo(el: Element): void {
  const c = cellAt(el);
  if (c === null) {
    return;
  }
  for (const other of gridRows(c.id).flatMap(cellsOf)) {
    other.tabIndex = -1;
  }
  c.btn.tabIndex = 0;
  cursor.set(c.id, keyChain(c.btn));
}
/** After a rebuild: the grid's Tab stop is the first remembered key still present and enabled, else
 * the first row's lead cell (never disabled). Never moves focus; a grid off this screen has no rows. */
function initRoving(id: GridId): void {
  const rows = gridRows(id);
  const head = rows[0];
  if (head === undefined) {
    return;
  }
  const stop = firstEnabled(cursor.get(id) ?? [], rows.flatMap(cellsOf)) ?? head.querySelector<HTMLButtonElement>('[role="rowheader"] > button');
  if (stop !== null) {
    stop.tabIndex = 0;
  }
}
/** The cell of `row` in column `col` (the last cell of a shorter row); a disabled one hands over
 * along its own fallback keys within the row (an edge arrow to the other arrow, never to Remove). */
function sameCell(row: Element | undefined, col: number): HTMLButtonElement | undefined {
  if (row === undefined) {
    return undefined;
  }
  const cells = cellsOf(row);
  const c = cells[col] ?? cells.at(-1);
  if (c === undefined) {
    return undefined;
  }
  return c.disabled ? firstEnabled(FALLBACK.get(c) ?? [], cells) : c;
}
function onFocusIn(ev: FocusEvent): void {
  if (ev.target instanceof Element) {
    roveTo(ev.target);
  }
}
/** The pressed chord in `aria-keyshortcuts` spelling (modifiers in the attribute's order, then the key). */
function chordOf(ev: KeyboardEvent): string {
  const mods = [ev.altKey && 'Alt', ev.ctrlKey && 'Control', ev.metaKey && 'Meta', ev.shiftKey && 'Shift'];
  return [...mods.filter((m): m is string => m !== false), ev.key].join('+');
}
/**
 * Keyboard: Escape on the detail screen is Back. Inside a grid, a chord a button of the row declares
 * in `aria-keyshortcuts` clicks that button (Alt+ArrowUp/Down move an entry, Delete/Backspace remove
 * it; a disabled edge arrow is a native no-op). Plain ArrowUp/Down keep the column across rows
 * (sameCell), Home/End go to the first/last row, ArrowLeft/Right step along the row's enabled cells
 * (no wrap). Handled keys are consumed so the pane does not scroll; Enter/Space/Tab stay native.
 */
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    if (screen === 'detail' && drag === null) {
      ev.preventDefault();
      goBack();
    }
    return;
  }
  const c = ev.target instanceof Element ? cellAt(ev.target) : null;
  if (c === null) {
    return;
  }
  const bound = c.row.querySelector<HTMLButtonElement>('[aria-keyshortcuts~="' + CSS.escape(chordOf(ev)) + '"]');
  if (bound !== null) {
    ev.preventDefault();
    bound.click();
    return;
  }
  if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) {
    return;
  }
  const rows = gridRows(c.id);
  const i = rows.indexOf(c.row);
  const cells = cellsOf(c.row);
  const col = cells.indexOf(c.btn);
  let target: HTMLButtonElement | undefined;
  switch (ev.key) {
    case 'ArrowUp':
      target = sameCell(rows[i - 1], col);
      break;
    case 'ArrowDown':
      target = sameCell(rows[i + 1], col);
      break;
    case 'Home':
      target = sameCell(rows[0], col);
      break;
    case 'End':
      target = sameCell(rows.at(-1), col);
      break;
    case 'ArrowLeft':
      target = cells.findLast((b, j) => j < col && !b.disabled);
      break;
    case 'ArrowRight':
      target = cells.find((b, j) => j > col && !b.disabled);
      break;
    default:
      return;
  }
  ev.preventDefault();
  if (target !== undefined) {
    focusEl(target);
  }
}

/** Dims a row and announces it busy until the host's re-push rebuilds the list. */
function markPending(row: HTMLElement): void {
  row.classList.add('pending');
  row.setAttribute('aria-busy', 'true');
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
  for (const id of GRIDS) {
    initRoving(id);
  }
}

function renderList(): void {
  // Before the first enumeration lands (server still starting) show a neutral placeholder, NOT the
  // "no books yet" welcome — the books may well exist and that copy would misleadingly say create one.
  if (state?.loading) {
    app.replaceChildren(scrollPane(h('div', { class: 'empty' }, L.loading), h('div', { class: 'empty' }, L.loadingHint)));
    return;
  }
  if (counts().total === 0) {
    app.replaceChildren(scrollPane(
      welcome(L.noBooksTitle, state?.noFolder ? [L.noBooksBody, L.noFolderHint] : [L.noBooksBody], [['createBook', L.createBook], ['openGuide', L.openGuide]])));
    return;
  }
  const groups = state?.groups ?? [];
  const flat = groups.flatMap((g) => g.books); // row neighbours run across group boundaries
  // One grid container per group, named as its heading is; a single group's grid is "Books".
  app.replaceChildren(
    scrollPane(h('div', { class: 'list' }, ...groups.flatMap((g) => {
      const rows = g.books.map((b) => {
        const i = flat.indexOf(b);
        return bookRow(b, flat[i + 1], flat[i - 1]);
      });
      return [
        g.label !== null && h('h2', { class: 'group-header' }, g.label),
        h('div', { class: 'grid', role: 'grid', 'data-grid': 'books', 'aria-label': g.label ?? L.books }, ...rows),
      ];
    }))),
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
  const cbName = L.selectBook + ': ' + bk.title;
  const cb = h('button', {
    class: 'cbtile',
    role: 'checkbox',
    'aria-label': cbName,
    title: cbName,
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
  // The tooltip carries both ellipsized lines in full.
  const main = h('button', {
    class: 'main',
    'aria-label': bk.title,
    title: bk.title + '\n' + bk.fileRel,
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
  icon('chevR', 'chev'));
  return h('div', { class: 'row book', role: 'row' }, cell(cb, 'stretch'), cell(main, 'lead'));
}

// Disabled states (list mode only) are applied by applyControls() once the footer is in the DOM.
function footer(buildUri?: string, counts: CountsVM | null = null): HTMLElement {
  const build = (format: BuildAction): BooksOutbound =>
    buildUri === undefined ? { type: 'build', format } : { type: 'build', format, uri: buildUri };
  return h('div', { class: 'footer' },
    // The detail's status bar: the body's figures as short items, the full name on hover; read-only
    // text outside every grid, present only when the host could count.
    counts !== null &&
      h('div', { class: 'status' },
        ...[counts.pages, counts.sheets, counts.chars].map((item) => h('span', { title: item.title }, item.text))),
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

/** The list screen again; focus returns to the row of the book just closed. */
function showList(): void {
  detailWanted = false;
  screen = 'list';
  detail = null;
  render();
  focusKeys(['book:' + (lastDetailUri ?? '')]);
}
/** The Back button and Escape. */
function goBack(): void {
  post({ type: 'closeDetail' });
  showList();
}

function renderDetail(): void {
  if (detail === null) {
    return;
  }
  const d = detail;
  drag = null; // a rebuild mid-drag (e.g. an edit-triggered refresh) cancels the in-progress drag
  const hdr = h('div', { class: 'dhdr' },
    iconBtn('chevL', L.back, goBack, { 'data-fk': 'back', 'aria-keyshortcuts': 'Escape' }),
    h('h1', { class: 'dtitle', title: d.title }, d.title));
  // Book Info: collapsible (collapsed by default), ABOVE the lists.
  const info = h('div', { class: 'section' },
    h('div', { class: 'shead' }, h('h2', { class: 'stitle' }, disclosure(infoOpen, L.bookInfo, 'infohead', () => {
      infoOpen = !infoOpen;
    }))),
    infoOpen && h('div', { class: 'grid', role: 'grid', 'data-grid': 'meta', 'aria-label': L.bookInfo },
      ...d.meta.map((mi) => metaRow(d, mi))));
  // The names sit with the book's information; covers precede chapters, as in the printed book.
  // Every folding list folds like Book Info; the chapter list is always open.
  app.replaceChildren(
    scrollPane(hdr, info, ...FOLDING.map((list) => listSection(d, list)), listSection(d, 'chapters')),
    footer(d.uri, d.counts),
  );
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
  title);
}

type EntryPart = 'open' | 'up' | 'down' | 'rm';
/** Focus keys carry the list and the row's path (its identity): a file may be both a cover and a chapter. */
function fk(list: EntryList, part: EntryPart, e: EntryVM): string {
  return list + ':' + part + ':' + e.path;
}

/**
 * One entry list: a header with the add action, the rows (or the empty text), and the add tail
 * row. Every list but the chapters is collapsible — folded, only its disclosure shows. The whole
 * section is the drop zone of its own rows (sectionDnD).
 */
function listSection(d: DetailMessage, list: EntryList): HTMLElement {
  const text = LIST_TEXT[list];
  const entries = d[list];
  const collapsible = FOLDING.includes(list);
  const open = !collapsible || openLists.has(list);
  let title: Child = text.title;
  if (collapsible) {
    title = disclosure(open, text.title, list + ':head', () => {
      if (open) {
        openLists.delete(list);
      } else {
        openLists.add(list);
      }
    });
  }
  const body: Child[] = [];
  const rows: readonly EntryRow[] = open ? entries.map((e, i) => [e, entryRow(d, list, e, i, entries)] as const) : [];
  if (open) {
    body.push(
      entries.length === 0 && h('div', { class: 'empty' }, text.empty),
      entries.length > 0 && h('div', { class: 'grid', role: 'grid', 'data-grid': list, 'aria-label': text.title },
        ...rows.map(([, row]) => row)),
      h('button', {
        class: 'row action',
        'data-fk': list + ':add',
        onClick: poster({ type: 'addEntries', uri: d.uri, list }),
      }, icon('add'), text.add),
    );
  }
  const section = h('div', { class: 'section', 'data-list': list },
    h('div', { class: 'shead' }, h('h2', { class: 'stitle' }, title)),
    ...body);
  sectionDnD(section, d, list, rows);
  return section;
}

/** An entry with the row rendered for it. */
type EntryRow = readonly [EntryVM, HTMLElement];
/** A drop slot: the entry to insert before (null = the tail) and the row to mark. */
interface Slot {
  readonly before: EntryVM | null;
  readonly row: HTMLElement;
}
/** Where a drop at pointer height `y` would put the dragged row: before the first other row whose
 * midpoint lies below the pointer, else after the last one. Null when the list has no other row, or
 * the slot is the row's present place (before its successor; the tail when it is last). */
function slotAt(rows: readonly EntryRow[], draggedLine: number, y: number): Slot | null {
  const i = rows.findIndex(([e]) => e.line === draggedLine);
  const next = rows[i + 1]?.[0] ?? null;
  const others = rows.filter(([e]) => e.line !== draggedLine);
  for (const [e, row] of others) {
    const r = row.getBoundingClientRect();
    if (y < r.top + r.height / 2) {
      return e === next ? null : { before: e, row };
    }
  }
  const last = others.at(-1);
  return last === undefined || next === null ? null : { before: null, row: last[1] };
}
/**
 * The section is the drop zone of its own list — header, empty text, blank and the tail row all
 * take the drop, so the end of the list is anywhere below the last row's midpoint. The other
 * list's section never preventDefaults, so the browser refuses the drop there.
 */
function sectionDnD(section: HTMLElement, d: DetailMessage, list: EntryList, rows: readonly EntryRow[]): void {
  const onDrag = (ev: DragEvent): void => {
    if (drag?.list !== list) {
      return;
    }
    ev.preventDefault();
    const slot = slotAt(rows, drag.line, ev.clientY);
    clearDrop();
    if (ev.type === 'dragover') {
      if (ev.dataTransfer) {
        ev.dataTransfer.dropEffect = 'move';
      }
      if (slot !== null) {
        slot.row.classList.add(slot.before === null ? 'drop-after' : 'drop-before');
      }
      return;
    }
    const dragged = drag;
    drag = null;
    if (slot !== null) {
      // The dragged row stays dimmed until the host's re-push lands it in its new place.
      markPending(dragged.row);
      post({
        type: 'moveEntryTo', uri: d.uri, list, line: dragged.line, path: dragged.path, version: d.version,
        before: slot.before === null ? null : slot.before.line, beforePath: slot.before === null ? null : slot.before.path,
      });
    }
  };
  section.addEventListener('dragover', onDrag);
  section.addEventListener('drop', onDrag);
}

function entryRow(d: DetailMessage, list: EntryList, e: EntryVM, idx: number, entries: readonly EntryVM[]): HTMLElement {
  const key = (part: EntryPart): string => fk(list, part, e);
  // Once this row is gone (removed, or dropped by an edit) focus goes to the next row, which slides
  // into its place, else the previous, else the list header's add button.
  const openOf = (n: EntryVM | undefined): string | undefined => (n === undefined ? undefined : fk(list, 'open', n));
  const vanished = [openOf(entries[idx + 1]), openOf(entries[idx - 1]), list + ':add'];
  const row = h('div', { class: 'row entry' + (e.missing ? ' missing' : ''), role: 'row' });
  // A row verb names the row as rendered (line, path, the detail's version) and dims the row until
  // the host's re-push rebuilds the list; the host ignores a row the text no longer has.
  const ref = { line: e.line, path: e.path, version: d.version };
  const verb = (m: BooksOutbound): (() => void) => () => {
    markPending(row);
    post(m);
  };
  // The name as written (folder and file), in full, as the accessible name and the tooltip; a
  // missing file says so in both. A name row's primary action edits it, so its name says so.
  const full = e.folder === '' ? e.name : e.folder + '/' + e.name;
  const name = e.missing ? L.missing + ': ' + full : e.fileUri === null ? L.editEntry + ': ' + full : full;
  const fileUri = e.fileUri;
  row.append(
    cell(h('button', {
      class: 'emain',
      title: name,
      'aria-label': name,
      'data-fk': key('open'),
      fallback: vanished,
      onClick: fileUri === null ? verb({ type: 'editEntry', uri: d.uri, list, ...ref }) : poster({ type: 'openFile', uri: fileUri }),
    },
    e.missing && icon('err', 'err'),
    h('div', { class: 'maincol' },
      h('div', { class: 'title' },
        e.folder !== '' && h('span', { class: 'dir' }, e.folder + '/'),
        e.name)),
    fileUri === null && icon('edit', 'pen')), 'lead'),
    // Focus keys use the entry's path (stable across a move) so keyboard focus follows the row.
    // An arrow disabled at the list's edge hands focus to the other arrow, then the row — never to Remove.
    h('div', { class: 'acts', role: 'presentation' },
      cell(iconBtn('up', L.moveUp, verb({ type: 'moveEntry', uri: d.uri, list, ...ref, dir: -1 }), {
        'data-fk': key('up'), fallback: [key('down'), key('open'), ...vanished], disabled: idx === 0,
        'aria-keyshortcuts': 'Alt+ArrowUp',
      })),
      cell(iconBtn('down', L.moveDown, verb({ type: 'moveEntry', uri: d.uri, list, ...ref, dir: 1 }), {
        'data-fk': key('down'), fallback: [key('up'), key('open'), ...vanished], disabled: idx === entries.length - 1,
        'aria-keyshortcuts': 'Alt+ArrowDown',
      })),
      cell(iconBtn('close', L.remove, verb({ type: 'removeEntry', uri: d.uri, list, ...ref }), {
        'data-fk': key('rm'), fallback: vanished, 'aria-keyshortcuts': 'Delete Backspace',
      }))));

  // The whole row is the drag handle; the section takes the drop.
  row.draggable = true;
  row.addEventListener('dragstart', (ev: DragEvent) => {
    drag = { list, line: e.line, path: e.path, row };
    ev.dataTransfer?.setData('text/plain', '');
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
    }
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    drag = null;
    row.classList.remove('dragging');
    clearDrop();
  });
  return row;
}

function metaRow(d: DetailMessage, mi: MetaVM): HTMLElement {
  const btn = h('button', {
    class: 'meta',
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
  return h('div', { class: 'row metarow', role: 'row' }, cell(btn, 'lead'));
}

function welcome(title: string, body: readonly string[], actions: readonly (readonly [WelcomeAction, string])[]): HTMLElement {
  return h('div', { class: 'welcome' },
    h('div', { class: 'wtitle' }, title),
    ...body.map((text) => h('div', { class: 'wbody' }, text)),
    ...actions.map(([action, label]) =>
      h('button', { class: 'btn welcomebtn', 'data-fk': 'welcome:' + action, onClick: poster({ type: 'welcome', action }) }, label)));
}

app.addEventListener('keydown', onKey);
app.addEventListener('focusin', onFocusIn);
// Leaving the dragging list's section (header, other list, footer) drops the insertion mark.
app.addEventListener('dragover', (ev: DragEvent) => {
  if (drag !== null && !(ev.target instanceof Element && ev.target.closest('.section[data-list="' + drag.list + '"]'))) {
    clearDrop();
  }
});

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
        if (msg.reveal === true && troubled) {
          openLists.add('covers'); // a failed build of the open book re-applies the entry rule
        }
        const c2 = capture();
        render();
        restore(c2);
      } else {
        infoOpen = false; // a freshly opened book folds Book Info and the lists; the cover list opens only to show an error
        openLists.clear();
        if (troubled) {
          openLists.add('covers');
        }
        cursor.clear(); // another book's rows: the Tab stops start afresh
        render();
        focusKeys(['back']);
      }
      break;
    }
    case 'closeDetail':
      // Precedes the list re-push that drops a vanished book (view.ts refresh()), so its row is still
      // here to take focus; the next `state` then moves focus on through the row's fallback keys.
      detailWanted = false;
      if (screen === 'list') {
        break; // the book never opened: focus stays on the clicked row
      }
      showList();
      break;
  }
});

post({ type: 'ready' });
