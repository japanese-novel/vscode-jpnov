/** A position as LSP and VS Code both spell it, so either's is one structurally. */
export interface Position {
  readonly line: number;
  readonly character: number;
}

/** Negative when `a` comes before `b`, zero when equal, positive after: line first, then character. */
export function comparePositions(a: Position, b: Position): number {
  return a.line - b.line || a.character - b.character;
}
