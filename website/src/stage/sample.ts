/**
 * The stage's chapter states, derived from the lint-clean src/samples/chapter1.jpnov: `emphasised`
 * drops the bait line's indent, `typing` also drops the 傍点 annotation beat 2 types. The pipeline
 * asserts that the product's fix-all turns `emphasised` back into the file.
 */

/** 0-based line of `覚悟［＃「覚悟」に傍点］は、決まっていた。` in chapter1.jpnov. */
export const EMPH_LINE = 4;
export const EMPH_ANNOTATION = '［＃「覚悟」に傍点］';
/** 0-based line whose leading 　 the lint beat restores. */
export const BAIT_LINE = 9;
/** 0-based index of the first line beat 1 types (lines 16–18 of the editor). */
export const TYPED_FROM = 15;

function withLine(src: string, index: number, edit: (line: string) => string): string {
  const lines = src.split('\n');
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`sample: no line ${String(index)}`);
  }
  lines[index] = edit(line);
  return lines.join('\n');
}

/** Beat 4's starting point: the file with the bait line un-indented. */
export function stateEmphasised(clean: string): string {
  return withLine(clean, BAIT_LINE, (line) => {
    if (!line.startsWith('　')) {
      throw new Error('sample: the bait line must start with a full-width space in the clean file');
    }
    return line.slice(1);
  });
}

/** Beat 1/2's starting point: the emphasised state before the 傍点 annotation is typed. */
export function stateTyping(clean: string): string {
  return withLine(stateEmphasised(clean), EMPH_LINE, (line) => {
    if (!line.includes(EMPH_ANNOTATION)) {
      throw new Error(`sample: line ${String(EMPH_LINE)} must carry ${EMPH_ANNOTATION}`);
    }
    return line.replace(EMPH_ANNOTATION, '');
  });
}
