/**
 * E2E for the Books panel's focus restore across host-driven rebuilds (#78): the REAL webview
 * bundle runs in a headless Chromium against a stub host that answers every message synchronously
 * in the provider's order. Each scenario focuses a control, acts (Enter on a focused button is a
 * click) and reports where focus landed after the rebuild. Skips without a discoverable browser
 * unless `JPNOV_E2E_REQUIRE_BROWSER=1` (CI).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import { BOOKS_CSS, BOOKS_JS } from '../../src/client/book/webviewBundle.generated.ts';
import type { EntryList } from '../../src/client/protocol.ts';

import { resolveBrowserExecutable } from './_browser.ts';
import { MARKER, measurePage } from './_headless.ts';

const browser = resolveBrowserExecutable({
  env: process.env,
  platform: process.platform,
  exists: existsSync,
});
const browserRequired = process.env.JPNOV_E2E_REQUIRE_BROWSER === '1';
const BROWSER_SKIP = {
  skip: browser === undefined && !browserRequired
    ? 'no Chromium-family browser on this machine (CI requires one via JPNOV_E2E_REQUIRE_BROWSER=1)'
    : false,
};

const cleanups: string[] = [];
after(async () => {
  await Promise.all(
    cleanups.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

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
const entry = (list: EntryList, part: 'open' | 'up' | 'down' | 'rm', name: string): string =>
  `${list}:${part}:${u(name)}`;

/**
 * The stub host, installed before the bundle loads: `acquireVsCodeApi().postMessage` lands in
 * `host.on`, which answers synchronously through a MessageEvent on `window` (the bundle listens
 * there). Payloads are copied, as postMessage's structured clone would.
 */
const HOST_SCRIPT = `
const FIX = ${JSON.stringify(FIX)};
const U = (n) => FIX.root + '/' + n;
const send = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
const host = {
  groups: [],
  details: new Map(),
  open: null,
  posted: [],
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
    const vms = (list) => list.map((n, i) => ({ line: i + 3, name: n, folder: '', fileUri: U(n), missing: false }));
    send({
      type: 'detail', uri: this.open, title: d.title,
      chapters: vms(d.chapters), covers: vms(d.covers), meta: d.meta.map((m) => ({ ...m })),
    });
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
    mutate(this.details.get(this.open));
    this.state();
    this.detail();
  },
  chapters() {
    return this.open === null ? null : [...this.details.get(this.open).chapters];
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
        const list = this.details.get(m.uri)[m.list];
        const i = m.line - 3;
        const [e] = list.splice(i, 1);
        list.splice(i + m.dir, 0, e);
        this.state();
        this.detail();
        break;
      }
      case 'removeEntry':
        this.details.get(m.uri)[m.list].splice(m.line - 3, 1);
        this.state();
        this.detail();
        break;
      default:
        break; // build / openFile / addEntries / createEntry / editMeta / …: recorded only
    }
  },
};
window.__host = host;
window.acquireVsCodeApi = () => ({ postMessage: (m) => host.on(m), getState: () => undefined, setState: () => {} });
`;

/**
 * The scenarios, run synchronously at parse time (\`--dump-dom\` serializes at load). \`step\`
 * focuses the keyed control, acts (default: click), and records the landing key plus the
 * open book's chapter order and the messages the bundle posted meanwhile.
 */
const SCENARIO_SCRIPT = `<script>
(() => {
  const host = window.__host;
  const results = [];
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
  function step(name, key, act) {
    const el = byKey(key);
    const from = host.posted.length;
    let pre = false;
    if (el !== null) {
      el.focus();
      pre = document.activeElement === el;
    }
    if (act === undefined) {
      if (el !== null) {
        el.click();
      }
    } else {
      act();
    }
    results.push({
      name, pre, landed: landing(), chapters: host.chapters(),
      posted: host.posted.slice(from).map((m) => m.type),
    });
  }
  const K = (list, part, n) => list + ':' + part + ':' + U(n);
  const open = (n) => byKey('book:' + U(n)).click();
  const { A, B, C } = FIX.books;

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
  step('D6a', 'coverhead');
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
}

interface Expected {
  readonly landed: string | null;
  readonly chapters?: readonly string[];
  readonly posted?: readonly string[];
}

const { B, C } = FIX.books;
const [C1, C2, C3] = FIX.chapters;

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
  D6a: { landed: 'coverhead', posted: [] },
  D6b: { landed: 'covers:add', posted: ['removeEntry'] },
  D7: { landed: entry('chapters', 'open', C3), chapters: [C1, C3] },
  D8: { landed: entry('chapters', 'open', C3), chapters: [C3] },
  D9a: { landed: 'infohead', posted: [] },
  D9b: { landed: 'meta:title' },
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
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
});
