/** The hover over an annotation, as the client renders the server's lines (#134). */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

import type { LanguageClient } from 'vscode-languageclient/node';

import type { HoverResult } from '../../src/shared/protocol.ts';
import { buildVscode, createMockState, Hover, MarkdownString, Uri } from './_vscodeMock.ts';

const state = createMockState();
mock.module('vscode', { exports: buildVscode(state) });

const { registerAnnotationHover, renderHover } = await import('../../src/client/hover.ts');

const RESULT: HoverResult = {
  range: { start: { line: 2, character: 3 }, end: { line: 2, character: 14 } },
  lines: [{ code: 'hover.postfix', args: ['傍点'] }, { code: 'hover.target', args: ['覚悟'] }],
  link: 'https://www.aozora.gr.jp/annotation/emphasis.html',
};

/** The markdown of a rendered hover. */
function markdownOf(result: HoverResult): string {
  const [md] = renderHover(result).contents as unknown as MarkdownString[];
  assert.ok(md);
  return md.value;
}

test('the first line is bold, the rest follow, the guide is a link', () => {
  assert.equal(
    markdownOf(RESULT),
    '**傍点 \\(forward reference\\)**\n\nTarget: 覚悟\n\n[Aozora Bunko annotation guide](https://www.aozora.gr.jp/annotation/emphasis.html)',
  );
  assert.deepEqual(structuredClone(renderHover(RESULT).range), { start: { line: 2, character: 3 }, end: { line: 2, character: 14 } });
  assert.ok(!markdownOf({ range: RESULT.range, lines: RESULT.lines }).includes('['));
});

interface Provider {
  provideHover(document: { uri: Uri }, position: { line: number; character: number }, token: unknown): Promise<Hover | null>;
}

/** A client whose one request answers `reply`, recording what it was asked. */
function fakeClient(reply: () => Promise<HoverResult | null>): { client: LanguageClient; asked: unknown[] } {
  const asked: unknown[] = [];
  const client = {
    code2ProtocolConverter: { asUri: (uri: Uri) => uri.toString() },
    sendRequest(method: string, params: unknown): Promise<unknown> {
      asked.push([method, params]);
      return reply();
    },
  } as unknown as LanguageClient;
  return { client, asked };
}

test('the provider asks jpnov/hover for the document and position, and renders the reply', async () => {
  const { client, asked } = fakeClient(() => Promise.resolve(RESULT));
  const disposable = registerAnnotationHover(client);
  const registered = state.hoverProviders[0];
  assert.ok(registered);
  assert.deepEqual(registered.selector, { language: 'jpnov' });
  const uri = Uri.file('/w/a.jpnov');
  const hover = await (registered.provider as Provider).provideHover({ uri }, { line: 2, character: 5 }, undefined);
  assert.deepEqual(asked, [['jpnov/hover', { uri: uri.toString(), position: { line: 2, character: 5 } }]]);
  assert.ok(hover instanceof Hover);
  disposable.dispose();
  assert.deepEqual(state.hoverProviders, []);
});

test('no reply, or a failed request, is no hover', async () => {
  for (const reply of [() => Promise.resolve(null), () => Promise.reject(new Error('cancelled'))]) {
    const { client } = fakeClient(reply);
    const disposable = registerAnnotationHover(client);
    const registered = state.hoverProviders[0];
    assert.ok(registered);
    assert.equal(await (registered.provider as Provider).provideHover({ uri: Uri.file('/w/a.jpnov') }, { line: 0, character: 0 }, undefined), null);
    disposable.dispose();
  }
});
