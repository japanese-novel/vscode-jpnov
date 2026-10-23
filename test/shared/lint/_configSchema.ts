/**
 * Derives the expected `contributes.configuration` block + its nls keys from the rule catalog and
 * the render-settings constants. Used by config-codegen.test.ts to hold package.json honest (the
 * deepEqual doubles as the "package.json defaults == resolver constants" lock). NOT a test file
 * (no `.test` suffix), so the runner skips it.
 *
 * Section order in the Settings UI (the `order` field, locked by the deepEqual):
 * Layout & Output(1) > Lint(2) > Editor(3). Every property carries an explicit in-section `order`.
 */
import { EDGE_LINE_STYLES } from '../../../src/shared/compiler/chrome.ts';
import { PAPER_ORIENTATIONS, PAPER_SIZES } from '../../../src/shared/compiler/geometry.ts';
import {
  BUILD_CHROME_DEFAULT,
  BUILD_PAPER_DEFAULT,
  PREVIEW_CHROME_DEFAULT,
} from '../../../src/shared/config/settings.ts';
import {
  CHARS_MAX,
  CHARS_MIN,
  KINSOKU_MODES,
  LAYOUT_DEFAULT,
  LINE_PITCHES,
  PROJECT_DEFAULT,
} from '../../../src/shared/config/types.ts';
import { TXT_ENCODINGS, TXT_ENCODING_DEFAULT } from '../../../src/shared/encoding.ts';
import { PRINT_BROWSER_DEFAULT, PRINT_BROWSER_SETTINGS } from '../../../src/client/book/browser.ts';
import { RULES, ruleDefault, settingKey } from '../../../src/shared/lint/catalog.ts';
import type { RuleMeta, Scope } from '../../../src/shared/lint/catalog.ts';

/**
 * Rule ordering inside the merged Lint section. Every rule gets an explicit per-property
 * `order` so the merged section keeps the common → narration → dialogue → ruby clustering
 * in the Settings UI.
 */
export const SCOPES: readonly Scope[] = ['common', 'narration', 'dialogue', 'ruby'];

/** nls key for one rule's setting description. */
export function ruleDescriptionKey(rule: RuleMeta): string {
  return `${settingKey(rule)}.description`;
}

/** nls key for one enum choice's drop-down label (`enumItemLabels`, enum rules only). */
export function enumLabelKey(rule: RuleMeta, value: string): string {
  return `${settingKey(rule)}.${value}.label`;
}

/** nls key for one enum choice's drop-down sub-text (`enumDescriptions`, enum rules only). */
export function enumDescriptionKey(rule: RuleMeta, value: string): string {
  return `${settingKey(rule)}.${value}.description`;
}

/** The JSON-schema property for one rule (boolean / nullable-integer threshold / string enum). */
function propertyFor(rule: RuleMeta, order: number): Record<string, unknown> {
  const base = { default: ruleDefault(rule), order, markdownDescription: `%${ruleDescriptionKey(rule)}%` };
  if (rule.kind === 'boolean') {
    return { type: 'boolean', ...base };
  }
  if (rule.kind === 'threshold') {
    return { type: ['integer', 'null'], minimum: rule.min, maximum: rule.max, ...base };
  }
  const values = rule.values ?? [];
  return {
    type: 'string',
    enum: values,
    enumItemLabels: values.map((v) => `%${enumLabelKey(rule, v)}%`),
    enumDescriptions: values.map((v) => `%${enumDescriptionKey(rule, v)}%`),
    ...base,
  };
}

/** An `edgeLine` enum property (shared shape between the preview and paper slices). */
function edgeLineProperty(keyPrefix: string, order: number): Record<string, unknown> {
  return {
    type: 'string',
    enum: [...EDGE_LINE_STYLES],
    default: 'none',
    enumItemLabels: EDGE_LINE_STYLES.map((v) => `%${keyPrefix}.${v}.label%`),
    enumDescriptions: EDGE_LINE_STYLES.map((v) => `%${keyPrefix}.${v}.description%`),
    order,
    markdownDescription: `%${keyPrefix}.description%`,
  };
}

/**
 * The Layout & Output section: the shared layout core, then the preview / paper render slices
 * (derived from the same constants the resolver uses — the codegen deepEqual is what locks
 * package.json's defaults to them), then the two output-side paths. `outDir` is per-folder
 * (`scope: resource`).
 */
function layoutSection(): unknown {
  return {
    title: '%jpnov.layout.title%',
    order: 1,
    properties: {
      'jpnov.layout.charsPerLine': {
        type: 'integer',
        default: LAYOUT_DEFAULT.charsPerLine,
        minimum: CHARS_MIN,
        maximum: CHARS_MAX,
        order: 1,
        markdownDescription: '%jpnov.layout.charsPerLine.description%',
      },
      'jpnov.layout.linesPerPage': {
        type: 'integer',
        default: LAYOUT_DEFAULT.linesPerPage,
        minimum: CHARS_MIN,
        maximum: CHARS_MAX,
        order: 2,
        markdownDescription: '%jpnov.layout.linesPerPage.description%',
      },
      'jpnov.layout.linePitch': {
        type: 'number',
        enum: [...LINE_PITCHES],
        default: LAYOUT_DEFAULT.linePitch,
        enumItemLabels: LINE_PITCHES.map((v) => `%jpnov.layout.linePitch.${String(v)}.label%`),
        enumDescriptions: LINE_PITCHES.map((v) => `%jpnov.layout.linePitch.${String(v)}.description%`),
        order: 3,
        markdownDescription: '%jpnov.layout.linePitch.description%',
      },
      'jpnov.layout.fontFamily': {
        type: 'string',
        default: LAYOUT_DEFAULT.fontFamily,
        order: 4,
        markdownDescription: '%jpnov.layout.fontFamily.description%',
      },
      'jpnov.layout.kinsoku': {
        type: 'string',
        enum: [...KINSOKU_MODES],
        default: LAYOUT_DEFAULT.kinsoku,
        enumItemLabels: KINSOKU_MODES.map((v) => `%jpnov.layout.kinsoku.${v}.label%`),
        enumDescriptions: KINSOKU_MODES.map((v) => `%jpnov.layout.kinsoku.${v}.description%`),
        order: 5,
        markdownDescription: '%jpnov.layout.kinsoku.description%',
      },
      'jpnov.layout.preview.lineNumbers': {
        type: 'boolean',
        default: PREVIEW_CHROME_DEFAULT.lineNumbers,
        order: 6,
        markdownDescription: '%jpnov.layout.preview.lineNumbers.description%',
      },
      'jpnov.layout.preview.edgeLine': edgeLineProperty('jpnov.layout.preview.edgeLine', 7),
      // Page furniture (ヘッダー/ノンブル) is deliberately NOT here: it is book identity, carried
      // by each `.jpbook`'s front matter (parsed in shared/book/jpbook.ts), never a setting.
      // The `paper.*` slice governs the paper-format output (the built HTML, which prints at
      // this paper): the physical paper first, then the proofing chrome drawn on it.
      'jpnov.layout.paper.size': {
        type: 'string',
        enum: [...PAPER_SIZES],
        default: BUILD_PAPER_DEFAULT.paperSize,
        enumItemLabels: PAPER_SIZES.map((v) => `%jpnov.layout.paper.size.${v}.label%`),
        enumDescriptions: PAPER_SIZES.map((v) => `%jpnov.layout.paper.size.${v}.description%`),
        order: 8,
        markdownDescription: '%jpnov.layout.paper.size.description%',
      },
      'jpnov.layout.paper.orientation': {
        type: 'string',
        enum: [...PAPER_ORIENTATIONS],
        default: BUILD_PAPER_DEFAULT.paperOrientation,
        enumItemLabels: PAPER_ORIENTATIONS.map((v) => `%jpnov.layout.paper.orientation.${v}.label%`),
        enumDescriptions: PAPER_ORIENTATIONS.map((v) => `%jpnov.layout.paper.orientation.${v}.description%`),
        order: 9,
        markdownDescription: '%jpnov.layout.paper.orientation.description%',
      },
      'jpnov.layout.paper.lineNumbers': {
        type: 'boolean',
        default: BUILD_CHROME_DEFAULT.lineNumbers,
        order: 10,
        markdownDescription: '%jpnov.layout.paper.lineNumbers.description%',
      },
      'jpnov.layout.paper.edgeLine': edgeLineProperty('jpnov.layout.paper.edgeLine', 11),
      // The `.txt` slice: one setting, because the Aozora deliverable is plain text and only its
      // encoding is a choice. HTML carries no counterpart — the HTML standard fixes it to UTF-8.
      'jpnov.layout.txt.encoding': {
        type: 'string',
        enum: [...TXT_ENCODINGS],
        default: TXT_ENCODING_DEFAULT,
        enumItemLabels: TXT_ENCODINGS.map((v) => `%jpnov.layout.txt.encoding.${v}.label%`),
        enumDescriptions: TXT_ENCODINGS.map((v) => `%jpnov.layout.txt.encoding.${v}.description%`),
        order: 12,
        markdownDescription: '%jpnov.layout.txt.encoding.description%',
      },
      // The print hand-off: which browser opens the built HTML (client-only; the constants live
      // in `client/book/browser.ts`). Machine scope: the installed browsers differ per machine.
      'jpnov.layout.print.browser': {
        type: 'string',
        enum: [...PRINT_BROWSER_SETTINGS],
        default: PRINT_BROWSER_DEFAULT,
        scope: 'machine-overridable',
        enumItemLabels: PRINT_BROWSER_SETTINGS.map((v) => `%jpnov.layout.print.browser.${v}.label%`),
        enumDescriptions: PRINT_BROWSER_SETTINGS.map((v) => `%jpnov.layout.print.browser.${v}.description%`),
        order: 13,
        markdownDescription: '%jpnov.layout.print.browser.description%',
      },
      'jpnov.layout.outDir': {
        type: 'string',
        default: PROJECT_DEFAULT.outDir,
        scope: 'resource',
        order: 14,
        markdownDescription: '%jpnov.layout.outDir.description%',
      },
    },
  };
}

/** The single merged Lint section: every rule, ordered common → narration → dialogue → ruby. */
function lintSection(): unknown {
  const properties: Record<string, unknown> = {};
  let order = 1;
  for (const scope of SCOPES) {
    for (const rule of RULES.filter((r) => r.scope === scope)) {
      properties[settingKey(rule)] = propertyFor(rule, order);
      order += 1;
    }
  }
  return { title: '%jpnov.lint.title%', order: 2, properties };
}

const UPDATE_REFS_MODES = ['prompt', 'always', 'never'] as const;

/**
 * The Editor section: typing behavior and in-editor aids, all client-only (never sent to the
 * resolver). The defaults are bare literals here — `autoIndent` mirrored in
 * `client/editor/autoIndent.ts`, the `updateRefsOnFileMove` triad in `client/book/tracking.ts`.
 * The narration vocabulary is no setting: it is the `characters:`/`keywords:` of the `.jpbook` files.
 */
function editorSection(): unknown {
  return {
    title: '%jpnov.editor.title%',
    order: 3,
    properties: {
      'jpnov.editor.autoIndent': {
        type: 'boolean',
        default: true,
        order: 1,
        markdownDescription: '%jpnov.editor.autoIndent.description%',
      },
      'jpnov.editor.updateRefsOnFileMove': {
        type: 'string',
        enum: [...UPDATE_REFS_MODES],
        default: 'prompt',
        enumItemLabels: UPDATE_REFS_MODES.map(
          (v) => `%jpnov.editor.updateRefsOnFileMove.${v}.label%`,
        ),
        enumDescriptions: UPDATE_REFS_MODES.map(
          (v) => `%jpnov.editor.updateRefsOnFileMove.${v}.description%`,
        ),
        order: 2,
        markdownDescription: '%jpnov.editor.updateRefsOnFileMove.description%',
      },
    },
  };
}

/** The `.label` + `.description` key pair for one enum choice. */
function enumChoiceKeys(choiceKey: string): string[] {
  return [`${choiceKey}.label`, `${choiceKey}.description`];
}

/** The nls keys the Layout & Output and Editor sections reference (titles + descriptions + enum labels). */
function staticNlsKeys(): string[] {
  return [
    'jpnov.layout.title',
    'jpnov.layout.charsPerLine.description',
    'jpnov.layout.linesPerPage.description',
    'jpnov.layout.linePitch.description',
    ...LINE_PITCHES.flatMap((v) => enumChoiceKeys(`jpnov.layout.linePitch.${String(v)}`)),
    'jpnov.layout.fontFamily.description',
    'jpnov.layout.kinsoku.description',
    ...KINSOKU_MODES.flatMap((v) => enumChoiceKeys(`jpnov.layout.kinsoku.${v}`)),
    'jpnov.layout.preview.lineNumbers.description',
    'jpnov.layout.preview.edgeLine.description',
    ...EDGE_LINE_STYLES.flatMap((v) => enumChoiceKeys(`jpnov.layout.preview.edgeLine.${v}`)),
    'jpnov.layout.paper.size.description',
    ...PAPER_SIZES.flatMap((v) => enumChoiceKeys(`jpnov.layout.paper.size.${v}`)),
    'jpnov.layout.paper.orientation.description',
    ...PAPER_ORIENTATIONS.flatMap((v) => enumChoiceKeys(`jpnov.layout.paper.orientation.${v}`)),
    'jpnov.layout.paper.lineNumbers.description',
    'jpnov.layout.paper.edgeLine.description',
    ...EDGE_LINE_STYLES.flatMap((v) => enumChoiceKeys(`jpnov.layout.paper.edgeLine.${v}`)),
    'jpnov.layout.txt.encoding.description',
    ...TXT_ENCODINGS.flatMap((v) => enumChoiceKeys(`jpnov.layout.txt.encoding.${v}`)),
    'jpnov.layout.print.browser.description',
    ...PRINT_BROWSER_SETTINGS.flatMap((v) => enumChoiceKeys(`jpnov.layout.print.browser.${v}`)),
    'jpnov.layout.outDir.description',
    'jpnov.editor.title',
    'jpnov.editor.autoIndent.description',
    'jpnov.editor.updateRefsOnFileMove.description',
    ...UPDATE_REFS_MODES.flatMap((v) => enumChoiceKeys(`jpnov.editor.updateRefsOnFileMove.${v}`)),
  ];
}

/**
 * The full `contributes.configuration` array — Layout & Output, the merged Lint section,
 * then Editor (array position mirrors the `order` fields).
 */
export function expectedConfiguration(): unknown[] {
  return [layoutSection(), lintSection(), editorSection()];
}

/** Every nls key the configuration block references (section titles + descriptions + enum labels). */
export function expectedNlsKeys(): string[] {
  const keys: string[] = ['jpnov.lint.title'];
  for (const rule of RULES) {
    keys.push(ruleDescriptionKey(rule));
    if (rule.kind === 'enum') {
      for (const v of rule.values) {
        keys.push(enumLabelKey(rule, v), enumDescriptionKey(rule, v));
      }
    }
  }
  return [...keys, ...staticNlsKeys()];
}
