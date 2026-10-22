/** A position as LSP and VS Code both spell it, so either's is one structurally. */
export interface Position {
  readonly line: number;
  readonly character: number;
}

/** A span between two positions, as LSP and VS Code both spell it. */
export interface Range {
  readonly start: Position;
  readonly end: Position;
}

/** One replacement of a text: `range` out (`end` exclusive; an insertion is zero-width), `newText` in. */
export interface TextReplace {
  readonly range: Range;
  readonly newText: string;
}

/** Negative when `a` comes before `b`, zero when equal, positive after: line first, then character. */
export function comparePositions(a: Position, b: Position): number {
  return a.line - b.line || a.character - b.character;
}

/** Orders ranges by start, then by end. */
export function compareRanges(a: Range, b: Range): number {
  return comparePositions(a.start, b.start) || comparePositions(a.end, b.end);
}

/** A range as a comparable key: two things over the same characters are of the same place. */
export function rangeKey(r: Range): string {
  return [r.start.line, r.start.character, r.end.line, r.end.character].join(':');
}
