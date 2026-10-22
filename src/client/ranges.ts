/**
 * The one place a shared `Position`/`Range` (LSP coordinates) becomes its `vscode` counterpart.
 */
import * as vscode from 'vscode';

import type { Position, Range } from '#/shared/utils/position.ts';

export function toVsPosition(p: Position): vscode.Position {
  return new vscode.Position(p.line, p.character);
}

export function toVsRange({ start, end }: Range): vscode.Range {
  return new vscode.Range(start.line, start.character, end.line, end.character);
}
