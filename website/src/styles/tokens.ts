/** Values a script sets that a stylesheet also writes; test/styles.test.ts holds each stylesheet to these. */

/** The stage runs its motion window only here (stage.css shows the static sequence otherwise). */
export const MOTION_QUERY = '(prefers-reduced-motion: no-preference) and (min-width: 56.25rem)';

/** Scroll reveals run only here (global.css pre-hides the marked elements under the same query). */
export const REVEAL_QUERY = '(prefers-reduced-motion: no-preference) and (min-width: 48rem)';

/** The editor's share of a split editor area (window.css `.jp-split`); the motion window sets it when the preview opens. */
export const SPLIT_EDITOR_WIDTH = '54%';
