import { OUT_DIR_DEFAULT, WORKSPACE_FOLDER_TOKEN } from './validate.ts';

/**
 * Inclusive bounds for `jpnov.layout.charsPerLine` / `jpnov.layout.linesPerPage`.
 */
export const CHARS_MIN = 16;
export const CHARS_MAX = 64;

/**
 * `jpnov.layout.kinsoku` members: `none` = bare hard wrap; `relaxed` = 禁則処理 (行頭・行末禁則 +
 * 分離禁止 + ぶら下げ) with 小書き仮名 and ー allowed at a line head (Word 標準 / CSS
 * `line-break: normal`); `strict` = relaxed plus those two classes (Word 高レベル / CSS `strict`).
 * The character classes live next to the wrap engine in compiler/layout.ts.
 */
export const KINSOKU_MODES = ['none', 'relaxed', 'strict'] as const;
export type KinsokuMode = (typeof KINSOKU_MODES)[number];

/**
 * `jpnov.lint.common.dash` members: the dash character the manuscript uses. The catalog row in
 * lint/catalog.ts spells the same list (it must stay import-free); catalog.test.ts locks the two.
 */
export const DASH_MODES = ['emDash', 'horizontalBar', 'boxDrawing'] as const;
export type DashMode = (typeof DASH_MODES)[number];

/** Narrows an untrusted string (e.g. the lint options' `mode`) to a {@link DashMode}. */
export function isDashMode(value: string): value is DashMode {
  return (DASH_MODES as readonly string[]).includes(value);
}

/**
 * `jpnov.layout.linePitch` members: 行送り as a multiple of the character size — the CSS
 * line-height (`--pitch`) and fitPaper's block-axis quantum. Ruby geometry per column: a
 * reading's outer edge at 1.0em off the column centre, the drawn rule at pitch/2, an opposing
 * left-side reading at pitch−1.0, the neighbouring glyphs at pitch−0.5 — so 2.25 keeps 0.125em
 * clear of rules and opposing readings, 2.0 sits flush, below 2.0 a reading crosses them, and
 * plain right-side ruby touches the neighbours only at 1.5. The author's tradeoff, unguarded.
 */
export const LINE_PITCHES = [1.5, 1.75, 2, 2.25] as const;
export type LinePitch = (typeof LINE_PITCHES)[number];

/**
 * The `jpnov.layout.*` slice (plus the `jpnov.lint.common.dash` choice) shared verbatim by both
 * wire snapshots — preview and build stay same-source. `linesPerPage`: the build grid's page
 * depth; the preview edge frame reserves the same extent per segment while drawn.
 */
export interface LayoutSettings {
  readonly charsPerLine: number;
  readonly linesPerPage: number;
  readonly linePitch: LinePitch;
  /** 組版 font-family list; '' = the built-in 明朝 stack (css.ts DEFAULT_FONT_STACK). */
  readonly fontFamily: string;
  readonly kinsoku: KinsokuMode;
  /** ダッシュ choice (`jpnov.lint.common.dash`) — the one lint key the render pipeline also reads. */
  readonly dash: DashMode;
}

/**
 * `jpnov.layout.*` defaults (投稿書式 40×34, 行送り 1.5 — the pitch print books and e-book readers
 * settle on, 禁則 strict, ダッシュ ―) — the single source for the schema defaults and the
 * settings resolver's fallbacks; the config-codegen test locks package.json to these values
 * (`dash` is owned by the lint catalog; catalog.test.ts locks the two defaults together).
 */
export const LAYOUT_DEFAULT: LayoutSettings = {
  charsPerLine: 40,
  linesPerPage: 34,
  linePitch: 1.5,
  fontFamily: '',
  kinsoku: 'strict',
  dash: 'horizontalBar',
};

/**
 * `jpnov.layout.outDir` defaults as setting values — the single source for the schema defaults;
 * the config-codegen test locks package.json to them. The server's silent fallback is the parsed
 * form, {@link OUT_DIR_DEFAULT}.
 */
export const PROJECT_DEFAULT = { outDir: `${WORKSPACE_FOLDER_TOKEN}/${OUT_DIR_DEFAULT.rel}` } as const;
