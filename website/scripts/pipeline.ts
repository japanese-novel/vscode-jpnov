/**
 * Runs every sample through the product: `renderPreview` / `renderBook` for the fragments, the
 * semantic highlighter for the editor lines, the lint engine and its fix-all for the diagnostics.
 * Book inputs are assembled the way src/server/build.ts assembles them from a `.jpbook`.
 */
import { readdir } from 'node:fs/promises';

import { SPECIMENS } from '../../scripts/specimens.ts';
import type { SpecimenName } from '../../scripts/specimens.ts';
import type { CountsVM } from '../../src/client/protocol.ts';
import { parse } from '../../src/shared/ast/parse.ts';
import { COVER_TEMPLATE } from '../../src/shared/book/create.ts';
import { checkJpbook, composeBookChrome, composeBookInput, entryPaths, META_DEFAULTS, parseJpbook } from '../../src/shared/book/jpbook.ts';
import { EDGE_INSET } from '../../src/shared/compiler/geometry.ts';
import { bookCounts, renderBook } from '../../src/shared/compiler/document.ts';
import type { BookInput } from '../../src/shared/compiler/document.ts';
import { renderPreview } from '../../src/shared/compiler/preview.ts';
import { BUILD_CHROME_DEFAULT, BUILD_PAPER_DEFAULT, PREVIEW_CHROME_DEFAULT } from '../../src/shared/config/settings.ts';
import { LAYOUT_DEFAULT } from '../../src/shared/config/types.ts';
import { EMPH_ANNOTATION, EMPH_LINE, stateEmphasised, stateTyping } from '../src/stage/sample.ts';
import type { BookRender, PreviewRender, Renders, SampleName, SampleRender } from './contract.ts';
import { countsRow } from './counts.ts';
import { colourLines } from './editor.ts';
import { annotationHover } from './hover.ts';
import { lintSource } from './lint.ts';
import { readRootText, readSiteText, sitePath } from './root.ts';
import { SAMPLES } from './samples.ts';
import type { BookSample, PreviewSample } from './samples.ts';
import { scopeFragment } from './scope.ts';

const STAGE_SCOPE = '.jp-r-stage';

/** The cover `book.jpbook` lists: the product's own template, not a file in src/samples/. */
const COVER_FILE = 'cover.jpnov';

/** Every text the samples draw on, read once: src/samples/ by file name, docs/specimens/ by name. */
interface Texts {
  readonly sample: (file: string) => string;
  readonly specimen: (name: SpecimenName) => string;
}

async function loadTexts(): Promise<Texts> {
  const files = await readdir(sitePath('src/samples'));
  if (files.includes(COVER_FILE)) {
    throw new Error(`render: src/samples/${COVER_FILE} shadows the product's cover template; delete the file`);
  }
  const samples = new Map<string, string>([
    [COVER_FILE, COVER_TEMPLATE],
    ...(await Promise.all(files.map(async (file) => [file, await readSiteText(`src/samples/${file}`)] as const))),
  ]);
  const specimens = new Map(await Promise.all(SPECIMENS.map(async (name) => [name, await readRootText(`docs/specimens/${name}.jpnov`)] as const)));
  const get = (map: ReadonlyMap<string, string>, key: string, what: string): string => {
    const text = map.get(key);
    if (text === undefined) {
      throw new Error(`render: no ${what} "${key}"`);
    }
    return text;
  };
  return { sample: (file) => get(samples, file, 'sample'), specimen: (name) => get(specimens, name, 'specimen') };
}

/** A `.jpbook` in src/samples/ → the compiler's book input, chrome composed from its metadata as the build reads it. */
function bookFromJpbook(texts: Texts, name: string, chrome: BookSample['chrome']): { input: BookInput; chrome: ReturnType<typeof composeBookChrome> } {
  const parsed = parseJpbook(texts.sample(name));
  const verdict = checkJpbook(parsed);
  if (!verdict.ok) {
    throw new Error(`render: ${name} does not build: ${verdict.error.code}`);
  }
  const read = (kind: 'ok' | 'coverEntry'): BookInput['files'] => entryPaths(parsed.lines, kind).map((file) => ({ name: file, src: texts.sample(file) }));
  return { input: composeBookInput(verdict.meta, read('ok'), read('coverEntry')), chrome: composeBookChrome({ ...BUILD_CHROME_DEFAULT, ...chrome }, verdict.meta) };
}

function renderBookSample(texts: Texts, sample: BookSample): { render: BookRender; html: string } {
  const book = 'jpbook' in sample.source
    ? bookFromJpbook(texts, sample.source.jpbook, sample.chrome)
    : {
        input: { files: [{ name: `${sample.source.specimen}.jpnov`, src: texts.specimen(sample.source.specimen) }] },
        chrome: composeBookChrome({ ...BUILD_CHROME_DEFAULT, ...sample.chrome }, { ...META_DEFAULTS, header: sample.source.header }),
      };
  const layout = { ...LAYOUT_DEFAULT, ...sample.layout };
  const html = renderBook({
    books: [book.input],
    ...layout,
    paperSize: sample.paper?.size ?? BUILD_PAPER_DEFAULT.paperSize,
    paperOrientation: sample.paper?.orientation ?? BUILD_PAPER_DEFAULT.paperOrientation,
    chrome: book.chrome,
  });
  const scoped = scopeFragment(html, {
    scope: `.jp-r-${sample.name}`,
    kind: 'book',
    ...(sample.keepPages === undefined ? {} : { keepPages: sample.keepPages }),
    ...(sample.printButton === undefined ? {} : { printButton: sample.printButton }),
  });
  const counts = (files: BookInput['files']): CountsVM => countsRow(bookCounts({ ...book.input, files }, layout));
  const before = book.input.files.filter((f) => f.name !== sample.pending);
  if (sample.pending !== undefined && before.length === book.input.files.length) {
    throw new Error(`render: ${sample.name} has no chapter "${sample.pending}" to add later`);
  }
  return { render: { kind: 'book', counts: counts(book.input.files), countsBefore: counts(before), ...scoped }, html };
}

interface StageSources {
  readonly typing: string;
  readonly emphasised: string;
  readonly fixed: string;
}

/** The three stage states, derived from the clean chapter file; `fixed` must equal the file. */
function stageSources(texts: Texts): StageSources {
  const clean = texts.sample('chapter1.jpnov');
  const emphasised = stateEmphasised(clean);
  const lint = lintSource(emphasised);
  if (lint.diagnostics.length !== 1 || lint.diagnostics[0]?.code !== 'lint.narration.indent') {
    throw new Error(`render: the emphasised state must carry exactly one indent finding, got ${JSON.stringify(lint.diagnostics.map((d) => d.code))}`);
  }
  if (lint.fixAll !== clean) {
    throw new Error('render: fix-all on the emphasised state does not reproduce chapter1.jpnov');
  }
  return { typing: stateTyping(clean), emphasised, fixed: clean };
}

function renderPreviewSample(texts: Texts, sample: PreviewSample, stage: StageSources): PreviewRender {
  const src = 'specimen' in sample.source ? texts.specimen(sample.source.specimen) : stage[sample.source.state];
  const layout = { ...LAYOUT_DEFAULT, ...sample.layout };
  const html = renderPreview(parse(src), { ...layout, chrome: { ...PREVIEW_CHROME_DEFAULT, ...sample.chrome } });
  const isStage = 'state' in sample.source;
  const { fragment } = scopeFragment(html, { scope: isStage ? STAGE_SCOPE : `.jp-r-${sample.name}`, kind: 'preview' });
  const out: PreviewRender = {
    kind: 'preview',
    src,
    bandCells: layout.charsPerLine + 2 * EDGE_INSET,
    editorLines: sample.vocabulary === undefined ? [] : colourLines(src, parseJpbook(texts.sample(sample.vocabulary)).names),
    diagnostics: sample.vocabulary === undefined ? [] : lintSource(src).diagnostics,
    preview: fragment,
  };
  // The emphasised state carries the product's hover over the annotation it types (beat 2 shows it).
  return isStage && sample.source.state === 'emphasised' ? { ...out, annotation: annotationHover(src, EMPH_LINE, EMPH_ANNOTATION) } : out;
}

export async function buildRenders(): Promise<Renders> {
  const texts = await loadTexts();
  const stage = stageSources(texts);
  const samples: Partial<Record<SampleName, SampleRender>> = {};
  let book: string | undefined;
  for (const sample of SAMPLES) {
    if (sample.kind === 'book') {
      const { render, html } = renderBookSample(texts, sample);
      samples[sample.name] = render;
      if (sample.name === 'stageBook') {
        book = html;
      }
    } else {
      samples[sample.name] = renderPreviewSample(texts, sample, stage);
    }
  }
  if (book === undefined) {
    throw new Error('render: no stageBook artifact');
  }
  return { samples: samples as Readonly<Record<SampleName, SampleRender>>, artifacts: { book } };
}

export function serialize(renders: Renders): string {
  return `${JSON.stringify(renders, null, 1)}\n`;
}
