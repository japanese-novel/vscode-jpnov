/**
 * The hover over an annotation of a .jpnov. The server answers `jpnov/hover` with message codes
 * (it writes no UI text), and this side renders them: the first line in bold, then what the
 * annotation relates to, then the page of the 青空文庫 guide for its kind.
 */
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

import { HoverRequest, type HoverParams, type HoverResult } from '#/shared/protocol.ts';

import { renderMessage } from './messages.ts';
import { toVsRange } from './ranges.ts';

/** The hover as the editor shows it. */
export function renderHover(result: HoverResult): vscode.Hover {
  const md = new vscode.MarkdownString();
  result.lines.forEach((line, i) => {
    if (i === 0) {
      md.appendMarkdown('**').appendText(renderMessage(line)).appendMarkdown('**');
    } else {
      md.appendMarkdown('\n\n').appendText(renderMessage(line));
    }
  });
  if (result.link !== undefined) {
    md.appendMarkdown(`\n\n[${vscode.l10n.t('Aozora Bunko annotation guide')}](${result.link})`);
  }
  return new vscode.Hover(md, toVsRange(result.range));
}

export function registerAnnotationHover(client: LanguageClient): vscode.Disposable {
  return vscode.languages.registerHoverProvider({ language: 'jpnov' }, {
    async provideHover(document, position, token): Promise<vscode.Hover | null> {
      const params: HoverParams = {
        uri: client.code2ProtocolConverter.asUri(document.uri),
        position: { line: position.line, character: position.character },
      };
      let result: HoverResult | null;
      try {
        result = await client.sendRequest<HoverResult | null>(HoverRequest, params, token);
      } catch {
        return null; // cancelled, or the server is not running: no hover
      }
      return result === null ? null : renderHover(result);
    },
  });
}
