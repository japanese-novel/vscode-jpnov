/**
 * E2E for the Books panel's focus restore across host-driven rebuilds (#78), its row verbs
 * against a stale list (#77), and its grid keyboard model + section drop zones (#92): the REAL
 * webview bundle runs in a headless Chromium against a stub host that answers every message
 * synchronously in the provider's order, or, when held, only on release (the DOM lagging the host
 * as across the real round trip). Each scenario focuses a control, acts (Enter on a focused button
 * is a click; keys are dispatched as keydown events) and reports where focus landed after the
 * rebuild, plus each grid's single Tab stop. Skips without a discoverable browser unless
 * `JPNOV_E2E_REQUIRE_BROWSER=1` (CI).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { BOOKS_CSS, BOOKS_JS } from '../../src/client/book/webviewBundle.generated.ts';
import type { EntryList } from '../../src/client/protocol.ts';

import { MARKER, measurePage } from './_headless.ts';
import { BROWSER_SKIP, browser, cleanups, removeCleanups } from './_setup.ts';

after(removeCleanups);

/**
 * The stub workspace: three books under one root, listed A, B, C. B's name carries the raw
 * full-width space and non-ASCII a server-composed book URI can, so the keys must survive it.
 */
const FIX = {
  root: 'file:///ws',
  books: { A: 'a.jpbook', B: '作品名　第一巻.jpbook', C: 'c.jpbook' },
  chapters: ['01.jpnov', '02.jpnov', '03.jpnov'],
  cover: '表紙.jpnov',
} as const;

const u = (name: string): string => `${FIX.root}/${name}`;
const book = (name: string): string => `book:${u(name)}`;
const cb = (name: string): string => `cb:${u(name)}`;
/** An entry row's key: the list, the part, and the path as listed (a row's identity, file or name). */
const entry = (list: EntryList, part: 'open' | 'up' | 'down' | 'rm', name: string): string =>
  `${list}:${part}:${name}`;

/**
 * The stub host, installed before the bundle loads: `acquireVsCodeApi().postMessage` lands in
 * `host.on`, which answers synchronously through a MessageEvent on `window` (the bundle listens
 * there), or between \`hold()\` and \`release()\` only once released. Payloads are copied, as
 * postMessage's structured clone would. A row verb counts only when it names a row the book still
 * has (version + path on that line, as the host checks) and is answered like the host: a detail
 * re-push, then after an edit the watcher's list + detail.
 */
const HOST_SCRIPT = `
const FIX = ${JSON.stringify(FIX)};
const U = (n) => FIX.root + '/' + n;
const send = (data) => {
  if (host.held !== null) {
    host.held.push(data);
    return;
  }
  window.dispatchEvent(new MessageEvent('message', { data }));
};
const host = {
  groups: [],
  details: new Map(),
  open: null,
  posted: [],
  held: null,
  hold() {
    this.held = [];
  },
  release() {
    const queued = this.held;
    this.held = null;
    for (const data of queued) {
      send(data);
    }
  },
  // A fresh workspace: \`groups\` = book names per root (default one root, A B C), \`checked\`
  // = ticked book names (default A and C). Ends on the list screen with nothing focused.
  reset(spec = {}) {
    const checked = new Set((spec.checked ?? [FIX.books.A, FIX.books.C]).map(U));
    const names = spec.groups ?? [[FIX.books.A, FIX.books.B, FIX.books.C]];
    this.groups = names.map((group, i) => ({
      rootLabel: names.length > 1 ? 'root' + i : null,
      books: group.map((n) => ({ uri: U(n), title: n, fileRel: n, checked: checked.has(U(n)) })),
    }));
    this.details = new Map(names.flat().map((n) => [U(n), {
      title: n,
      version: 1,
      chapters: [...FIX.chapters],
      covers: [FIX.cover],
      meta: [{ key: 'title', label: 'title', value: '作品名', note: '' }],
    }]));
    this.open = null;
    send({ type: 'closeDetail' });
    this.state();
    const a = document.activeElement;
    if (a !== null && a !== document.body) {
      a.blur();
    }
  },
  state() {
    send({
      type: 'state', loading: false, noFolder: false, revealOutput: true,
      groups: this.groups.map((g) => ({ rootLabel: g.rootLabel, books: g.books.map((b) => ({ ...b })) })),
    });
  },
  detail() {
    const d = this.details.get(this.open);
    const vms = (list) => list.map((n, i) => ({ line: i + 3, path: n, name: n, folder: '', fileUri: U(n), missing: false }));
    send({
      type: 'detail', uri: this.open, title: d.title, version: d.version,
      chapters: vms(d.chapters), covers: vms(d.covers), characters: [], keywords: [], meta: d.meta.map((m) => ({ ...m })), counts: null,
    });
  },
  // A row verb's outcome: the prompt re-push always; the save → watcher round trip only after an edit.
  answer(edited) {
    this.detail();
    if (edited) {
      this.state();
      this.detail();
    }
  },
  // Mirrors view.ts refresh(): a vanished open book closes the detail first, then the list re-pushes.
  removeBook(n) {
    const uri = U(n);
    this.groups = this.groups
      .map((g) => ({ rootLabel: g.rootLabel, books: g.books.filter((b) => b.uri !== uri) }))
      .filter((g) => g.books.length > 0);
    this.details.delete(uri);
    if (this.open === uri) {
      this.open = null;
      send({ type: 'closeDetail' });
    }
    this.state();
  },
  // An external edit of the open book: the watcher re-pushes the list, then the detail.
  repush(mutate) {
    const d = this.details.get(this.open);
    mutate(d);
    d.version += 1;
    this.state();
    this.detail();
  },
  chapters() {
    return this.open === null ? null : [...this.details.get(this.open).chapters];
  },
  // The open book's problems screen: chapter 01 with a fixable and a fix-less problem, 02 with a fixable one.
  problems() {
    const R = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
    const pr = (range, code, fixable) => ({ range, code, severity: fixable ? 'warning' : 'error', message: code, where: 'L', fixable });
    send({
      type: 'problems', uri: this.open,
      chapters: [
        { uri: U(FIX.chapters[0]), path: FIX.chapters[0], problems: [pr(R(0, 2, 0, 4), 'fix', true), pr(R(1, 0, 1, 1), 'nofix', false)] },
        { uri: U(FIX.chapters[1]), path: FIX.chapters[1], problems: [pr(R(3, 0, 3, 1), 'fix', true)] },
      ],
    });
  },
  on(m) {
    this.posted.push(m);
    const books = this.groups.flatMap((g) => g.books);
    switch (m.type) {
      case 'ready':
        this.state();
        break;
      case 'openDetail':
        this.open = m.uri;
        this.detail();
        break;
      case 'closeDetail':
        this.open = null;
        break;
      case 'toggle':
        books.filter((b) => b.uri === m.uri).forEach((b) => { b.checked = m.checked; });
        break;
      case 'selectAll':
        books.forEach((b) => { b.checked = true; });
        this.state();
        break;
      case 'deselectAll':
        books.forEach((b) => { b.checked = false; });
        this.state();
        break;
      case 'moveEntry': {
        const d = this.details.get(m.uri);
        const list = d[m.list];
        const i = m.line - 3;
        const fresh = m.version === d.version && list[i] === m.path;
        if (fresh) {
          const [e] = list.splice(i, 1);
          list.splice(i + m.dir, 0, e);
          d.version += 1;
        }
        this.answer(fresh);
        break;
      }
      case 'removeEntry': {
        const d = this.details.get(m.uri);
        const list = d[m.list];
        const i = m.line - 3;
        const fresh = m.version === d.version && list[i] === m.path;
        if (fresh) {
          list.splice(i, 1);
          d.version += 1;
        }
        this.answer(fresh);
        break;
      }
      case 'moveEntryTo': {
        const d = this.details.get(m.uri);
        const list = d[m.list];
        const i = m.line - 3;
        const j = m.before === null ? list.length : m.before - 3;
        const fresh = m.version === d.version && list[i] === m.path && (m.before === null || list[j] === m.beforePath);
        if (fresh) {
          const [e] = list.splice(i, 1);
          list.splice(j > i ? j - 1 : j, 0, e);
          d.version += 1;
        }
        this.answer(fresh);
        break;
      }
      default:
        break; // build / openFile / addEntries / editMeta / …: recorded only
    }
  },
};
window.__host = host;
window.acquireVsCodeApi = () => ({ postMessage: (m) => host.on(m), getState: () => undefined, setState: () => {} });
`;

/**
 * The scenarios, run synchronously at parse time (\`--dump-dom\` serializes at load). \`step\`
 * focuses the keyed control, acts (default: click), and records the landing key plus the
 * open book's chapter order, the messages the bundle posted meanwhile, how many rows are
 * marked pending (a verb posted, the host's re-push not yet rendered), each grid's Tab stop
 * (the one cell with tabindex=0; 'MULTI' if more), the grid the focused cell belongs to, and
 * the insertion mark a drag painted before its drop.
 */
const SCENARIO_SCRIPT = `<script>
(() => {
  const host = window.__host;
  const results = [];
  const GRIDS = ['books', 'covers', 'chapters', 'meta', 'problems'];
  const byKey = (key) => {
    for (const el of document.querySelectorAll('[data-fk]')) {
      if (el.getAttribute('data-fk') === key) {
        return el;
      }
    }
    return null;
  };
  const landing = () => {
    const a = document.activeElement;
    return a === null || a === document.body ? null : a.getAttribute('data-fk');
  };
  const gridOf = () => document.activeElement?.closest('.cell > button')?.closest('[data-grid]')?.getAttribute('data-grid') ?? null;
  const tabStops = () => Object.fromEntries(GRIDS.map((id) => {
    const z = document.querySelectorAll('[data-grid="' + id + '"] .cell > button[tabindex="0"]');
    return [id, z.length === 1 ? z[0].getAttribute('data-fk') : z.length === 0 ? null : 'MULTI'];
  }));
  function step(name, key, act) {
    const el = byKey(key);
    const from = host.posted.length;
    let pre = false;
    let drop = null;
    if (el !== null) {
      el.focus();
      pre = document.activeElement === el;
      // A headless window may lack focus, where focus() moves activeElement but fires no focus
      // event; the bundle's focusin path is what a focused window would run.
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    }
    if (act === undefined) {
      if (el !== null) {
        el.click();
      }
    } else {
      drop = act() ?? null; // only dragTo returns something: the mark painted before the drop
    }
    results.push({
      name, pre, landed: landing(), chapters: host.chapters(),
      posted: host.posted.slice(from).map((m) => m.type),
      pending: document.querySelectorAll('.entry.pending').length,
      tab0: tabStops(), grid: gridOf(), drop,
    });
  }
  const K = (list, part, n) => list + ':' + part + ':' + n;
  const open = (n) => byKey('book:' + U(n)).click();
  const { A, B, C } = FIX.books;
  // A key pressed on the focused control (the bundle handles keydown by \`key\`).
  const press = (key, init = {}) => () => {
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  };
  const rowOf = (key) => byKey(key).closest('[role="row"]');
  const rect = (key) => rowOf(key).getBoundingClientRect();
  const section = (list) => document.querySelector('.section[data-list="' + list + '"]');
  // Drags the focused row over \`list\`'s section at height \`y\` and drops it there; returns the
  // mark dragover painted, read before the drop clears it.
  const dragTo = (list, y) => () => {
    const row = document.activeElement.closest('[role="row"]');
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const sec = section(list);
    sec.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: y, dataTransfer: dt }));
    const mark = [...document.querySelectorAll('.drop-before, .drop-after')]
      .map((el) => (el.classList.contains('drop-before') ? 'before ' : 'after ') + el.querySelector('[data-fk]').getAttribute('data-fk'))
      .join(',') || null;
    sec.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientY: y, dataTransfer: dt }));
    row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return mark;
  };

  host.reset();
  step('L1a', 'selall');
  step('L1b', 'deselall');
  host.reset();
  step('L2', 'deselall');
  host.reset({ checked: [A] });
  step('L3', 'bprint', () => host.removeBook(A));
  host.reset();
  step('L4', 'book:' + U(B), () => host.removeBook(B));
  host.reset();
  step('L5', 'book:' + U(C), () => host.removeBook(C));
  host.reset();
  step('L6', 'cb:' + U(B), () => host.removeBook(B));
  host.reset();
  open(B);
  step('L7', 'back', () => host.removeBook(B));
  host.reset({ groups: [[A], [B]] });
  step('L8', 'book:' + U(A), () => host.removeBook(A));
  host.reset();
  step('L9', 'reveal', () => host.state());
  host.reset({ groups: [[A]] });
  step('L10', 'book:' + U(A), () => host.removeBook(A));

  host.reset();
  step('D10a', 'book:' + U(B));
  step('D10b', 'back');
  host.reset();
  open(B);
  step('D1a', K('chapters', 'down', '02.jpnov'));
  step('D1b', K('chapters', 'up', '02.jpnov'));
  step('D2', K('chapters', 'up', '02.jpnov'));
  host.reset();
  open(B);
  step('D3', K('chapters', 'rm', '02.jpnov'));
  host.reset();
  open(B);
  step('D4', K('chapters', 'rm', '03.jpnov'));
  host.reset();
  open(B);
  step('D5a', K('chapters', 'open', '01.jpnov'), () => host.repush((d) => { d.chapters = ['01.jpnov']; }));
  step('D5b', K('chapters', 'rm', '01.jpnov'));
  host.reset();
  open(B);
  step('D6a', 'covers:head');
  step('D6b', K('covers', 'rm', FIX.cover));
  host.reset();
  open(B);
  step('D7', K('chapters', 'open', '02.jpnov'), () => host.repush((d) => { d.chapters = ['01.jpnov', '03.jpnov']; }));
  host.reset();
  open(B);
  step('D8', K('chapters', 'up', '03.jpnov'), () => host.repush((d) => { d.chapters = ['03.jpnov']; }));
  host.reset();
  open(B);
  step('D9a', 'infohead');
  step('D9b', 'meta:title', () => host.repush(() => {}));

  // #77: with the pushes held, the list is stale after the first click; a second click on the removed
  // row (D11) or its neighbour (D12) names a row the book no longer has at that version — swallowed.
  host.reset();
  open(B);
  host.hold();
  step('D11a', K('chapters', 'rm', '02.jpnov'));
  step('D11b', K('chapters', 'rm', '02.jpnov'));
  step('D11c', K('chapters', 'rm', '02.jpnov'), () => host.release());
  host.reset();
  open(B);
  host.hold();
  step('D12a', K('chapters', 'rm', '02.jpnov'));
  step('D12b', K('chapters', 'rm', '03.jpnov'));
  step('D12c', K('chapters', 'rm', '03.jpnov'), () => host.release());

  // #92: one Tab stop per grid; arrows move among rows and cells, a disabled edge arrow hands over
  // to the other arrow; Alt+arrows and Delete are the row's own verbs; Escape is Back.
  host.reset();
  open(B);
  step('K1', K('chapters', 'open', '01.jpnov'), press('ArrowDown'));
  step('K2', K('chapters', 'up', '02.jpnov'), press('ArrowUp'));
  step('K3', K('chapters', 'down', '02.jpnov'), press('ArrowDown'));
  step('K4a', K('chapters', 'open', '01.jpnov'), press('End'));
  step('K4b', K('chapters', 'open', '03.jpnov'), press('Home'));
  step('K5a', K('chapters', 'open', '01.jpnov'), press('ArrowRight'));
  step('K5b', K('chapters', 'down', '01.jpnov'), press('ArrowRight'));
  step('K5c', K('chapters', 'rm', '01.jpnov'), press('ArrowRight'));
  step('K5d', K('chapters', 'rm', '01.jpnov'), press('ArrowLeft'));
  step('K5e', K('chapters', 'down', '01.jpnov'), press('ArrowLeft'));
  step('K5f', K('chapters', 'open', '01.jpnov'), press('ArrowUp'));
  host.reset();
  open(B);
  step('K6a', K('chapters', 'open', '02.jpnov'), press('ArrowDown', { altKey: true }));
  step('K6b', K('chapters', 'open', '01.jpnov'), press('ArrowUp', { altKey: true }));
  host.reset();
  open(B);
  step('K7a', K('chapters', 'open', '02.jpnov'), press('Delete'));
  step('K7b', K('chapters', 'open', '03.jpnov'), press('Backspace'));
  host.reset();
  open(B);
  step('K8', K('chapters', 'open', '01.jpnov'), press('Escape'));
  host.reset();
  step('K9a', 'cb:' + U(A), press('ArrowRight'));
  step('K9b', 'book:' + U(A), press('ArrowDown'));
  step('K9c', 'book:' + U(B), press('ArrowLeft'));
  step('K9d', 'cb:' + U(B), press('Escape'));
  host.reset();
  open(B);
  step('K10a', K('chapters', 'open', '02.jpnov'), () => host.repush(() => {}));
  step('K10b', 'bprint', () => host.repush(() => {}));
  step('K10c', 'infohead');
  step('K11', K('chapters', 'rm', '02.jpnov'));
  host.reset({ groups: [[A], [B]] });
  step('K12', 'book:' + U(A), press('ArrowDown'));
  host.reset();
  step('W1', 'book:' + U(A), () => host.reset({ groups: [[]] }));
  step('W2', 'welcome:createBook', () => host.state());

  // #92: the whole section takes the drop; the slot is the row whose midpoint is below the pointer.
  host.reset();
  open(B);
  step('N1', K('chapters', 'open', '01.jpnov'), dragTo('chapters', rect(K('chapters', 'open', '03.jpnov')).bottom - 1));
  host.reset();
  open(B);
  step('N2', K('chapters', 'open', '03.jpnov'), dragTo('chapters', section('chapters').querySelector('.shead').getBoundingClientRect().top + 2));
  host.reset();
  open(B);
  step('N3', K('chapters', 'open', '01.jpnov'), dragTo('covers', rect(K('chapters', 'open', '03.jpnov')).bottom - 1));
  host.reset();
  open(B);
  step('N4', K('chapters', 'open', '02.jpnov'), dragTo('chapters', rect(K('chapters', 'open', '03.jpnov')).top + 1));

  // #230: the problems screen is a grid too (checkbox / open); a disabled checkbox hands over to its
  // row; the select links and the fix button follow the checked set; a plain detail re-push keeps the
  // screen, Back and Escape return to the detail.
  const P = (part, n, l1, c1, l2, c2, code) => 'pb:' + part + ':' + U(n) + ':' + [l1, c1, l2, c2, code].join(':');
  host.reset();
  open(B);
  step('P1', 'back', () => host.problems());
  step('P2a', 'deselall');
  step('P2b', 'selall');
  step('P3a', P('cb', '01.jpnov', 0, 2, 0, 4, 'fix'));
  step('P3b', P('cb', '01.jpnov', 0, 2, 0, 4, 'fix'), press('ArrowDown'));
  step('P3c', P('open', '01.jpnov', 1, 0, 1, 1, 'nofix'), press('ArrowDown'));
  step('P4', P('open', '02.jpnov', 3, 0, 3, 1, 'fix'), () => host.detail());
  step('P5', P('open', '02.jpnov', 3, 0, 3, 1, 'fix'));
  step('P6', 'bfix');
  host.reset();
  open(B);
  host.problems();
  step('P7', P('cb', '01.jpnov', 0, 2, 0, 4, 'fix'), press('Escape'));
  host.problems();
  step('P8', 'back');

  document.documentElement.setAttribute('${MARKER}', JSON.stringify(results));
})();
</script>`;

interface StepResult {
  readonly name: string;
  /** The starting control took focus — guards against a vacuous pass. */
  readonly pre: boolean;
  readonly landed: string | null;
  readonly chapters: readonly string[] | null;
  readonly posted: readonly string[];
  /** Rows dimmed as pending once the step is done (none after a synchronous rebuild). */
  readonly pending: number;
  /** Per grid, the key of its one `tabindex="0"` cell; null when it has no rows, 'MULTI' when broken. */
  readonly tab0: Readonly<Record<string, string | null>>;
  /** The grid the focused cell belongs to, null when focus is outside every grid. */
  readonly grid: string | null;
  /** The insertion mark a drag painted ('before <key>' / 'after <key>'), null when none. */
  readonly drop: string | null;
}

interface Expected {
  readonly landed: string | null;
  readonly chapters?: readonly string[];
  readonly posted?: readonly string[];
  readonly pending?: number;
  /** Only the grids named are compared. */
  readonly tab0?: Readonly<Record<string, string | null>>;
  readonly drop?: string | null;
}

const { A, B, C } = FIX.books;
const [C1, C2, C3] = FIX.chapters;
const ch = (part: 'open' | 'up' | 'down' | 'rm', name: string): string => entry('chapters', part, name);
/** A problem row's key: the part, its chapter, place and code (as the stub host lists them). */
const pb = (part: 'cb' | 'open', name: string, at: readonly [number, number, number, number], code: string): string =>
  `pb:${part}:${u(name)}:${at.join(':')}:${code}`;

/** Where focus must land per scenario, in run order (a checkbox stays in the checkbox column). */
const EXPECT: Readonly<Record<string, Expected>> = {
  L1a: { landed: 'deselall', posted: ['selectAll'] },
  L1b: { landed: 'selall', posted: ['deselectAll'] },
  L2: { landed: 'selall', posted: ['deselectAll'] },
  L3: { landed: 'selall', posted: [] },
  L4: { landed: book(C) },
  L5: { landed: book(B) },
  L6: { landed: cb(C) },
  L7: { landed: book(C) },
  L8: { landed: book(B) },
  L9: { landed: 'reveal' },
  L10: { landed: null },
  D10a: { landed: 'back', posted: ['openDetail'] },
  D10b: { landed: book(B), posted: ['closeDetail'] },
  D1a: { landed: entry('chapters', 'up', C2), chapters: [C1, C3, C2], posted: ['moveEntry'] },
  D1b: { landed: entry('chapters', 'up', C2), chapters: [C1, C2, C3], posted: ['moveEntry'] },
  D2: { landed: entry('chapters', 'down', C2), chapters: [C2, C1, C3], posted: ['moveEntry'] },
  D3: { landed: entry('chapters', 'open', C3), chapters: [C1, C3], posted: ['removeEntry'] },
  D4: { landed: entry('chapters', 'open', C2), chapters: [C1, C2], posted: ['removeEntry'] },
  D5a: { landed: entry('chapters', 'open', C1), chapters: [C1] },
  D5b: { landed: 'chapters:add', chapters: [], posted: ['removeEntry'] },
  D6a: { landed: 'covers:head', posted: [] },
  D6b: { landed: 'covers:add', posted: ['removeEntry'] },
  D7: { landed: entry('chapters', 'open', C3), chapters: [C1, C3] },
  D8: { landed: entry('chapters', 'open', C3), chapters: [C3] },
  D9a: { landed: 'infohead', posted: [] },
  D9b: { landed: 'meta:title' },
  // Held pushes: the click dims its row and the DOM stays; the stale second click is posted but
  // changes nothing; release rebuilds the list — the removed row's focus falls through to its neighbour.
  D11a: { landed: entry('chapters', 'rm', C2), chapters: [C1, C3], posted: ['removeEntry'], pending: 1 },
  D11b: { landed: entry('chapters', 'rm', C2), chapters: [C1, C3], posted: ['removeEntry'], pending: 1 },
  D11c: { landed: entry('chapters', 'open', C3), chapters: [C1, C3], posted: [], pending: 0 },
  D12a: { landed: entry('chapters', 'rm', C2), chapters: [C1, C3], posted: ['removeEntry'], pending: 1 },
  D12b: { landed: entry('chapters', 'rm', C3), chapters: [C1, C3], posted: ['removeEntry'], pending: 2 },
  D12c: { landed: entry('chapters', 'rm', C3), chapters: [C1, C3], posted: [], pending: 0 },
  // Grid keys. A fresh detail's Tab stop is the first row's open cell; the arrows keep the column,
  // and the first row's disabled "up" (K2) / the last row's disabled "down" (K3) hand over to the
  // other arrow. Row ends do not wrap (K5c, K5f).
  K1: { landed: ch('open', C2), posted: [], tab0: { chapters: ch('open', C2), covers: null, meta: null } },
  K2: { landed: ch('down', C1), posted: [] },
  K3: { landed: ch('up', C3), posted: [] },
  K4a: { landed: ch('open', C3), posted: [] },
  K4b: { landed: ch('open', C1), posted: [] },
  K5a: { landed: ch('down', C1), posted: [] },
  K5b: { landed: ch('rm', C1), posted: [] },
  K5c: { landed: ch('rm', C1), posted: [] },
  K5d: { landed: ch('down', C1), posted: [] },
  K5e: { landed: ch('open', C1), posted: [] },
  K5f: { landed: ch('open', C1), posted: [] },
  // Alt+arrows move the row through its own buttons (focus follows, as after a click); at the top
  // the disabled "up" makes Alt+ArrowUp a no-op.
  K6a: { landed: ch('open', C2), chapters: [C1, C3, C2], posted: ['moveEntry'], pending: 0 },
  K6b: { landed: ch('open', C1), chapters: [C1, C3, C2], posted: [], pending: 0 },
  K7a: { landed: ch('open', C3), chapters: [C1, C3], posted: ['removeEntry'] },
  K7b: { landed: ch('open', C1), chapters: [C1], posted: ['removeEntry'] },
  K8: { landed: book(B), posted: ['closeDetail'] },
  // The book list is a grid too (checkbox / open); Escape does nothing on the list screen.
  K9a: { landed: book(A), posted: [], tab0: { books: book(A) } },
  K9b: { landed: book(B), posted: [], tab0: { books: book(B) } },
  K9c: { landed: cb(B), posted: [], tab0: { books: cb(B) } },
  K9d: { landed: cb(B), posted: [] },
  // A re-push keeps each grid's Tab stop whether focus is in the grid or on the footer; a folded
  // section has no rows, hence no Tab stop; a removed row's Tab stop follows focus to its neighbour.
  K10a: { landed: ch('open', C2), tab0: { chapters: ch('open', C2) } },
  K10b: { landed: 'bprint', tab0: { chapters: ch('open', C2), meta: null } },
  K10c: { landed: 'infohead', posted: [], tab0: { meta: 'meta:title', chapters: ch('open', C2) } },
  K11: { landed: ch('open', C3), chapters: [C1, C3], posted: ['removeEntry'], tab0: { chapters: ch('open', C3) } },
  K12: { landed: book(B), posted: [], tab0: { books: book(B) } },
  // The welcome screen's buttons keep focus across a state push.
  W1: { landed: null, posted: [] },
  W2: { landed: 'welcome:createBook', posted: [] },
  // Drops: below the last row's midpoint = the tail; on the header = before the first row; the
  // other list's section refuses; the row's own slot (before its successor) paints and posts nothing.
  N1: { landed: ch('open', C1), chapters: [C2, C3, C1], posted: ['moveEntryTo'], drop: 'after ' + ch('open', C3), pending: 0 },
  N2: { landed: ch('open', C3), chapters: [C3, C1, C2], posted: ['moveEntryTo'], drop: 'before ' + ch('open', C1), pending: 0 },
  N3: { landed: ch('open', C1), chapters: [C1, C2, C3], posted: [], drop: null },
  N4: { landed: ch('open', C2), chapters: [C1, C2, C3], posted: [], drop: null },
  // The problems screen: focus lands on Back; its one Tab stop is the first row's open cell. The
  // links disable themselves (none / all checked) so focus crosses; ArrowDown from a checkbox onto
  // a fix-less row lands on that row's open cell, then keeps the column. A re-push keeps the screen
  // and the focus; a row opens its chapter; Fix posts the verb and returns to the detail.
  P1: { landed: 'back', posted: [], tab0: { problems: pb('open', C1, [0, 2, 0, 4], 'fix'), chapters: null } },
  P2a: { landed: 'selall', posted: [] },
  P2b: { landed: 'deselall', posted: [] },
  P3a: { landed: pb('cb', C1, [0, 2, 0, 4], 'fix'), posted: [] },
  P3b: { landed: pb('open', C1, [1, 0, 1, 1], 'nofix'), posted: [] },
  P3c: { landed: pb('open', C2, [3, 0, 3, 1], 'fix'), posted: [] },
  P4: { landed: pb('open', C2, [3, 0, 3, 1], 'fix'), posted: [], tab0: { problems: pb('open', C2, [3, 0, 3, 1], 'fix'), chapters: null } },
  P5: { landed: pb('open', C2, [3, 0, 3, 1], 'fix'), posted: ['openProblem'] },
  P6: { landed: 'back', posted: ['fixProblems'], tab0: { problems: null, chapters: ch('open', C1) } },
  P7: { landed: 'back', posted: [], tab0: { problems: null } },
  P8: { landed: 'back', posted: [], tab0: { problems: null, chapters: ch('open', C1) } },
};

/** The page as the host serves it: the `__INIT` bootstrap (every label reads as its own key — the
 * words never steer focus), the stub host, then the real CSS and bundle. */
function page(): string {
  return [
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">',
    `<style>${BOOKS_CSS}</style>`,
    '</head><body><div id="app"></div>',
    `<script>window.__INIT = { labels: new Proxy({}, { get: (_, k) => String(k) }) };${HOST_SCRIPT}</script>`,
    `<script>${BOOKS_JS}</script>`,
    '</body></html>',
  ].join('');
}

test('focus lands on a safe neighbour after every host-driven rebuild (#78)', BROWSER_SKIP, async () => {
  assert.ok(browser, 'JPNOV_E2E_REQUIRE_BROWSER=1 but no Chromium-family browser was found');
  const results = JSON.parse(
    await measurePage(browser, page(), SCENARIO_SCRIPT, 'books-focus', cleanups),
  ) as StepResult[];

  assert.deepEqual(results.map((r) => r.name), Object.keys(EXPECT), 'every scenario reports once, in order');
  // Every mismatch at once: a landing regression is easier to read as the whole table.
  const wrong: string[] = [];
  for (const r of results) {
    const want = EXPECT[r.name];
    assert.ok(want !== undefined, r.name);
    if (!r.pre) {
      wrong.push(`${r.name}: the starting control did not take focus`);
    }
    if (r.landed !== want.landed) {
      wrong.push(`${r.name}: focus landed on ${String(r.landed)}, expected ${String(want.landed)}`);
    }
    if (want.chapters !== undefined && JSON.stringify(r.chapters) !== JSON.stringify(want.chapters)) {
      wrong.push(`${r.name}: chapters ${JSON.stringify(r.chapters)}, expected ${JSON.stringify(want.chapters)}`);
    }
    if (want.posted !== undefined && JSON.stringify(r.posted) !== JSON.stringify(want.posted)) {
      wrong.push(`${r.name}: posted ${JSON.stringify(r.posted)}, expected ${JSON.stringify(want.posted)}`);
    }
    if (want.pending !== undefined && r.pending !== want.pending) {
      wrong.push(`${r.name}: ${String(r.pending)} pending row(s), expected ${String(want.pending)}`);
    }
    for (const [grid, key] of Object.entries(want.tab0 ?? {})) {
      if (r.tab0[grid] !== key) {
        wrong.push(`${r.name}: ${grid} Tab stop is ${String(r.tab0[grid])}, expected ${String(key)}`);
      }
    }
    if (want.drop !== undefined && r.drop !== want.drop) {
      wrong.push(`${r.name}: drop mark ${String(r.drop)}, expected ${String(want.drop)}`);
    }
    // Invariants of every step: one Tab stop per grid at most, and the focused cell is its grid's.
    for (const [grid, key] of Object.entries(r.tab0)) {
      if (key === 'MULTI') {
        wrong.push(`${r.name}: ${grid} has several tabindex=0 cells`);
      }
    }
    if (r.grid !== null && r.tab0[r.grid] !== r.landed) {
      wrong.push(`${r.name}: focus is on ${String(r.landed)} but ${r.grid}'s Tab stop is ${String(r.tab0[r.grid])}`);
    }
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
});
