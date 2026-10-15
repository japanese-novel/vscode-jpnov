/**
 * Word commands (#155): the pair rule on segment lists fed directly (the ICU dictionary drifts
 * between runtimes), lines through the real segmenter whose stops depend on character classes
 * alone, where the caret goes and what a delete removes across lines, and the manifest wiring.
 * vscode-free — imports the pure module directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  WORD_COMMANDS,
  deleteLeft,
  deleteRight,
  groupStops,
  mergeSpans,
  stopAfter,
  stopBefore,
  wordLeft,
  wordRight,
  type Lines,
  type Pos,
  type Span,
  type WordSegment,
} from '../../src/client/editor/word.ts';
import { D } from '../shared/_kana.ts';
import { REPO_ROOT } from '../shared/repo.ts';

const VARIATION_SELECTOR = String.fromCodePoint(0xe0100);

/** The stops of the whole line through the real segmenter: what the caret functions must agree with. */
function lineStops(line: string): readonly number[] {
  return groupStops(line, new Intl.Segmenter('ja', { granularity: 'word' }).segment(line));
}

/** Segments spelled `a / b / ~c`: `~` marks a segment that is not word-like. */
function segments(spec: string): WordSegment[] {
  let index = 0;
  return spec.split(' / ').map((raw) => {
    const isWordLike = !raw.startsWith('~');
    const segment = isWordLike ? raw : raw.slice(1);
    const seg = { segment, index, isWordLike };
    index += segment.length;
    return seg;
  });
}

/** `line` cut at `stops`, one string per group. */
function cut(line: string, stops: readonly number[]): string[] {
  return stops.slice(1).map((end, i) => line.slice(stops[i], end));
}

/** The groups of the line that `spec` spells, joined by `|`. */
function groups(spec: string): string {
  const list = segments(spec);
  const line = list.map((s) => s.segment).join('');
  return cut(line, groupStops(line, list)).join('|');
}

test('groups: the examples of the issue', () => {
  for (const [spec, expected] of [
    ['聖 / 剣 / を / 抜 / い / た / の / は / 山田 / ~　 / 太郎 / だ / っ / た / ~。', '聖剣を|抜いたのは|山田|　|太郎だった|。'],
    ['俺 / は / テキスト / ビル / ド / だ', '俺は|テキストビルドだ'],
    ['王 / 都 / へ / ~、 / 聖 / 剣 / を', '王都へ|、|聖剣を'],
    ['な / に / ~！ / ~？ / ~　 / 王 / 都 / へ', 'なに|！？　|王都へ'],
    ['遠 / の / い / た', '遠のいた'],
    ['サボ / っ / た', 'サボった'],
    ['ふわりと / も / ら / っ / た', 'ふわりともらった'],
    ['答え / た', '答えた'],
    ['静か / に', '静かに'],
    ['字 / 下げ', '字下げ'],
    ['す / ご / ー / い', 'すごーい'],
    ['三 / ヶ月', '三ヶ月'],
  ] as const) {
    assert.equal(groups(spec), expected, spec);
  }
});

test('groups: a standalone を or は closes its group; ははは stops at every は', () => {
  for (const [spec, expected] of [
    ['聖 / 剣 / を / も', '聖剣を|も'],
    ['は / は / は', 'は|は|は'],
    ['~「 / は / ~」', '「|は|」'],
  ] as const) {
    assert.equal(groups(spec), expected, spec);
  }
});

test('groups: punctuation runs are cut before an opening bracket and after a closing one', () => {
  for (const [spec, expected] of [
    ['だっ / た / ~。 / ~」 / ~「 / 王 / 都 / へ', 'だった|。」|「|王都へ'],
    ['~」 / ~、 / ~「', '」|、|「'],
    ['~　 / ~「 / 聖 / 剣', '　|「|聖剣'],
    ['~「 / ~『 / 聖 / 剣 / ~』 / ~」', '「|『|聖剣|』|」'],
    ['~［ / ~＃ / ~「 / 山田 / ~」 / に / 傍点 / ~］', '［＃|「|山田|」|に|傍点|］'],
    // An empty pair: nothing before its opening bracket or after its closing one to cut.
    ['~「 / ~」', '「」'],
  ] as const) {
    assert.equal(groups(spec), expected, spec);
  }
});

test('groups: kanji after hiragana, kanji against katakana, and letters or digits split', () => {
  for (const [spec, expected] of [
    ['静か / に / 聖 / 剣', '静かに|聖剣'],
    ['王 / 都 / テキスト', '王都|テキスト'],
    ['テキスト / 王 / 都', 'テキスト|王都'],
    ['ＳＦ / 聖 / 剣 / の', 'ＳＦ|聖剣の'],
    ['第 / ３ / 章', '第|３|章'],
    ['John / ~  / Smith', 'John| |Smith'],
  ] as const) {
    assert.equal(groups(spec), expected, spec);
  }
});

test('groups: character classes at the edges', () => {
  for (const [spec, expected] of [
    // The shared katakana table holds ー and ヵ; here ー is the prolonged mark and ヵ a kanji.
    ['す / ご / ー', 'すごー'],
    ['三 / ヵ月', '三ヵ月'],
    ['人 / 々', '人々'],
    ['〆 / 切', '〆切'],
    // Iteration marks go with their script; half-width katakana is katakana.
    ['た / ゞ', 'たゞ'],
    ['ソ / ヽ', 'ソヽ'],
    ['ｶﾀｶﾅ / だ', 'ｶﾀｶﾅだ'],
    // The base character decides, past an NFD 濁点 or a variation selector; astral kanji count.
    [`か${D} / く`, `か${D}く`],
    [`聖${VARIATION_SELECTOR} / 剣`, `聖${VARIATION_SELECTOR}剣`],
    ['𠮟 / ら / れ / た', '𠮟られた'],
    // A segment of marks alone has no class.
    [`${D} / く`, `${D}|く`],
    // A run of punctuation without brackets is one group.
    ['~… / ~… / ~。', '……。'],
  ] as const) {
    assert.equal(groups(spec), expected, spec);
  }
});

test('groups: a segment without isWordLike counts as not word-like; an empty line stops at 0', () => {
  const list: WordSegment[] = [{ segment: '「', index: 0 }, { segment: '」', index: 1 }];
  assert.deepEqual(groupStops('「」', list), [0, 2]);
  assert.deepEqual(groupStops('', []), [0]);
});

test('real segmenter: lines whose stops depend on character classes alone', () => {
  for (const [line, expected] of [
    ['　聖剣を抜いたのは山田　太郎だった。', ['　', '聖剣を', '抜いたのは', '山田', '　', '太郎だった', '。']],
    ['王都へ、なに！？　王都へ', ['王都へ', '、', 'なに', '！？　', '王都へ']],
    ['ぱっともらった聖剣を', ['ぱっともらった', '聖剣を']],
    ['「王都へ」「聖剣を」', ['「', '王都へ', '」', '「', '聖剣を', '」']],
    ['', []],
  ] as const) {
    assert.deepEqual(cut(line, lineStops(line)), expected, line);
  }
});

// Lines the caret walk must cut like the whole line: space runs, ー and marks right after
// punctuation, selectors and joiners, Latin with its mid-word punctuation, half-width kana, long
// groups, a line with no punctuation at all.
const WALKED = [
  '　聖剣を抜いたのは山田　太郎だった。',
  '王都へ、なに！？　王都へ',
  '「王都へ」「聖剣を」',
  '山田　　太郎　　　だ。　　',
  '。ーい。ーい',
  `が、${D}く　${D}あ`,
  `聖${VARIATION_SELECTOR}剣を抜いた。${VARIATION_SELECTOR}剣`,
  '👨\u200d👩\u200d👧　👨「🙂\u200d🙂」',
  'John’s book, isn’t it? 3.5、12,345。',
  'ｶﾀｶﾅ　ｶﾅﾞだ',
  '東京，京都３．５Ａ：Ｂ',
  'ははは「は」を',
  `${D}あ`,
  '、。！？「」',
  '',
  `${'あ'.repeat(100)}。${'ア'.repeat(100)}、${'漢'.repeat(100)}`,
  `${'！'.repeat(80)}あ${'…'.repeat(80)}`,
  `${'　'.repeat(50)}あ${'　'.repeat(50)}`,
  '聖剣を抜いた'.repeat(40),
];

test('the caret walk agrees with the whole line at every offset (#183)', () => {
  for (const line of WALKED) {
    const stops = lineStops(line);
    for (let offset = 0; offset <= line.length; offset += 1) {
      assert.equal(stopBefore(line, offset), stops.findLast((s) => s < offset) ?? 0, `${line} ← ${String(offset)}`);
      assert.equal(stopAfter(line, offset), stops.find((s) => s > offset) ?? line.length, `${line} → ${String(offset)}`);
    }
  }
});

// Stops: line 0 at 0 1 4 9 11 12 17 18, line 1 (empty) at 0, line 2 at 0 3 4 6 8.
const LINES = ['　聖剣を抜いたのは山田　太郎だった。', '', '王都へ、なに！？'];
const DOC: Lines = { lineCount: LINES.length, lineAt: (line) => ({ text: LINES[line] ?? '' }) };

function at(line: number, character: number): Pos {
  return { line, character };
}

function span(start: Pos, end: Pos): Span {
  return { start, end };
}

/** Every position `step` reaches from `from`, until it stops moving. */
function walk(step: (doc: Lines, from: Pos) => Pos, from: Pos): Pos[] {
  const out: Pos[] = [];
  for (let pos = from; ;) {
    const next = step(DOC, pos);
    if (next.line === pos.line && next.character === pos.character) {
      return out;
    }
    out.push(next);
    pos = next;
  }
}

test('caret: → and ← walk the same stops across lines and stop at the document ends', () => {
  for (const [step, from, expected] of [
    // → ends every group, then crosses the empty line to the first group end below.
    [wordRight, at(0, 0), [
      at(0, 1), at(0, 4), at(0, 9), at(0, 11), at(0, 12), at(0, 17), at(0, 18),
      at(1, 0), at(2, 3), at(2, 4), at(2, 6), at(2, 8),
    ]],
    // ← from a line's start goes to the start of the last group on the line above.
    [wordLeft, at(2, 8), [
      at(2, 6), at(2, 4), at(2, 3), at(2, 0),
      at(1, 0), at(0, 17), at(0, 12), at(0, 11), at(0, 9), at(0, 4), at(0, 1), at(0, 0),
    ]],
  ] as const) {
    assert.deepEqual(walk(step, from), expected);
  }
});

test('caret: inside a group, ← goes to its start and → to its end', () => {
  assert.deepEqual(wordLeft(DOC, at(0, 6)), at(0, 4));
  assert.deepEqual(wordRight(DOC, at(0, 6)), at(0, 9));
});

test('delete: back to the group start, forward to its end, only the line break at a line edge', () => {
  for (const [reach, from, expected] of [
    [deleteLeft, at(0, 6), span(at(0, 4), at(0, 6))],
    [deleteRight, at(0, 6), span(at(0, 6), at(0, 9))],
    [deleteLeft, at(2, 0), span(at(1, 0), at(2, 0))],
    [deleteLeft, at(1, 0), span(at(0, 18), at(1, 0))],
    [deleteRight, at(0, 18), span(at(0, 18), at(1, 0))],
    [deleteLeft, at(0, 0), null],
    [deleteRight, at(2, 8), null],
  ] as const) {
    assert.deepEqual(reach(DOC, from), expected);
  }
});

test('mergeSpans: sorts, and merges overlapping, touching and contained spans', () => {
  for (const [input, expected] of [
    [[span(at(0, 4), at(0, 6)), span(at(0, 0), at(0, 5))], [span(at(0, 0), at(0, 6))]],
    [[span(at(0, 6), at(0, 9)), span(at(0, 4), at(0, 6))], [span(at(0, 4), at(0, 9))]],
    [[span(at(0, 0), at(0, 9)), span(at(0, 4), at(0, 6))], [span(at(0, 0), at(0, 9))]],
    [[span(at(2, 0), at(2, 3)), span(at(0, 1), at(0, 4))], [span(at(0, 1), at(0, 4)), span(at(2, 0), at(2, 3))]],
  ] as const) {
    assert.deepEqual(mergeSpans(input), expected);
  }
});

interface Manifest {
  readonly contributes: {
    readonly commands: readonly { readonly command: string; readonly category?: string; readonly title: string }[];
    readonly keybindings: readonly { readonly command: string }[];
    readonly menus: { readonly commandPalette: readonly { readonly command: string }[] };
  };
}

async function readJson<T>(rel: string): Promise<T> {
  return JSON.parse(await readFile(new URL(rel, REPO_ROOT), 'utf8')) as T;
}

const MOVE_WHEN = 'textInputFocus && editorLangId == jpnov && !isComposing && !(accessibilityModeEnabled && isWindows)';
const DELETE_WHEN = 'textInputFocus && !editorReadonly && editorLangId == jpnov && !isComposing';

// The keys of VS Code's own word commands, under their conditions plus `.jpnov` and no IME
// composition. Ctrl+→ also accepts the next word of an inline suggestion, so it yields to one.
const BINDINGS = [
  { command: 'jpnov.cursorWordLeft', key: 'ctrl+left', mac: 'alt+left', when: MOVE_WHEN },
  { command: 'jpnov.cursorWordEndRight', key: 'ctrl+right', mac: 'alt+right', when: `${MOVE_WHEN} && !inlineSuggestionVisible` },
  { command: 'jpnov.cursorWordLeftSelect', key: 'ctrl+shift+left', mac: 'shift+alt+left', when: MOVE_WHEN },
  { command: 'jpnov.cursorWordEndRightSelect', key: 'ctrl+shift+right', mac: 'shift+alt+right', when: MOVE_WHEN },
  { command: 'jpnov.deleteWordLeft', key: 'ctrl+backspace', mac: 'alt+backspace', when: DELETE_WHEN },
  { command: 'jpnov.deleteWordRight', key: 'ctrl+delete', mac: 'alt+delete', when: DELETE_WHEN },
];

test('manifest: each word command is titled in both bundles, bound like its built-in, off the palette', async () => {
  const [pkg, en, ja] = await Promise.all([
    readJson<Manifest>('package.json'),
    readJson<Record<string, string>>('package.nls.json'),
    readJson<Record<string, string>>('package.nls.ja.json'),
  ]);
  const ids = new Set(WORD_COMMANDS.map((c) => c.id));

  assert.deepEqual(pkg.contributes.keybindings.filter((b) => ids.has(b.command)), BINDINGS);
  assert.deepEqual(
    pkg.contributes.menus.commandPalette.filter((m) => ids.has(m.command)),
    WORD_COMMANDS.map((c) => ({ command: c.id, when: 'false' })),
  );
  for (const c of WORD_COMMANDS) {
    const entry = pkg.contributes.commands.find((e) => e.command === c.id);
    assert.ok(entry, `${c.id} is not contributed`);
    assert.equal(entry.category, '%command.category%');
    const key = /^%(.+)%$/.exec(entry.title)?.[1];
    assert.ok(key !== undefined && key in en && key in ja, `${c.id}: ${entry.title} is missing from a bundle`);
  }
});
