/**
 * Test scaffolding for the server tests: a fake LSP `Connection` that records outgoing
 * notifications/diagnostics (plus semanticTokens.refresh calls), plus tmp workspace
 * helpers. Suites under `test/server/highlight/**` run inside plain `npm test`; the
 * fs-heavy build + jpbook suites run in `npm run test:integration`.
 */
import { rm, mkdir, writeFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CodeActionKind } from 'vscode-languageserver/node';
import type { Connection, PublishDiagnosticsParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { parse } from '../../src/shared/ast/parse.ts';
import { selectRules } from '../../src/shared/lint/select.ts';
import { buildCodeActions } from '../../src/server/lint/codeActions.ts';
import type { Finding } from '../../src/server/diagnostics.ts';
import { computeLintFindings } from '../../src/server/lint/engine.ts';
import { mergedEdits } from '../../src/server/targets.ts';
import type { RawLintConfigWire } from '../../src/shared/protocol.ts';
import { createHighlightStore, type BookNames } from '../../src/server/highlight/vocabulary.ts';
import { parseJpbook } from '../../src/shared/book/jpbook.ts';
import type { ReadText, ServerContext } from '../../src/server/context.ts';
import { errorText } from '../../src/shared/utils/errors.ts';

export interface RecordedNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface RecordedDiagnostics {
  readonly uri: string;
  readonly count: number;
}

export interface FakeConnection {
  readonly notifications: RecordedNotification[];
  /** Every `sendDiagnostics` payload, as sent. */
  readonly published: PublishDiagnosticsParams[];
  /** {@link published} as one uri and count per publish. */
  readonly diagnostics: RecordedDiagnostics[];
  /** How many times the server asked the client to re-pull semantic tokens. */
  semanticTokenRefreshes(): number;
  /** Cast to the real Connection for injection into a ServerContext. */
  asConnection(): Connection;
}

export function makeFakeConnection(): FakeConnection {
  const notifications: RecordedNotification[] = [];
  const published: PublishDiagnosticsParams[] = [];

  let refreshCount = 0;

  const impl = {
    notifications,
    published,
    get diagnostics(): RecordedDiagnostics[] {
      return published.map((p) => ({ uri: p.uri, count: p.diagnostics.length }));
    },
    languages: {
      semanticTokens: {
        refresh(): Promise<void> {
          refreshCount += 1;
          return Promise.resolve();
        },
      },
    },
    semanticTokenRefreshes(): number {
      return refreshCount;
    },
    sendNotification(method: string, params: unknown): Promise<void> {
      notifications.push({ method, params });
      return Promise.resolve();
    },
    sendDiagnostics(params: PublishDiagnosticsParams): Promise<void> {
      published.push(params);
      return Promise.resolve();
    },
    sendRequest(): Promise<unknown> {
      return Promise.resolve(undefined);
    },
    asConnection(): Connection {
      return impl as unknown as Connection;
    },
  };

  return impl;
}

/** A reader on Node's fs; `label` is the WHATWG decoder standing in for the editor's encoding choice. */
export function nodeReader(label = 'utf-8'): ReadText {
  const decoder = new TextDecoder(label);
  return async (uri) => {
    try {
      return { ok: true, text: decoder.decode(await readFile(fileURLToPath(uri))) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { ok: false, reason: code === 'ENOENT' ? 'notFound' : 'other', why: errorText(err) };
    }
  };
}

/** A book of the vocabulary store, as the listing hands it over: its lists as parsed from `text`. */
export function bookNames(rootUri: string, fileRel: string, text: string): BookNames {
  return { uri: `${rootUri}/${fileRel}`, fileRel, names: parseJpbook(text).names };
}

export function makeContext(conn: FakeConnection, readText: ReadText = nodeReader()): ServerContext {
  return {
    connection: conn.asConnection(),
    readText,
    lintSelection: selectRules({}),
    highlight: createHighlightStore(),
  };
}

/** Creates an isolated tmp workspace directory; returns its fs path + file:// uri. */
export async function makeTmpWorkspace(): Promise<{
  dir: string;
  uri: string;
  [Symbol.asyncDispose](): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'jpnov-server-'));
  const uri = pathToFileURL(dir).href.replace(/\/$/, '');
  return {
    dir,
    uri,
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Writes a file under `dir`, creating parent directories as needed; a string lands as UTF-8, bytes as given. */
export async function writeUnder(dir: string, rel: string, content: string | Uint8Array): Promise<string> {
  const full = join(dir, ...rel.split('/'));
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
  return full;
}

/** `src` as an open `.jpnov` document. */
export function openDoc(src: string): TextDocument {
  return TextDocument.create('mem://x.jpnov', 'jpnov', 1, src);
}

/** One lint-fix edit in absolute source offsets (`s === e` is an insert). */
export interface LintEdit {
  readonly s: number;
  readonly e: number;
  readonly t: string;
}

/** `src` as an open document, and its lint findings under `raw`. */
export function lintFindings(src: string, raw: RawLintConfigWire): { doc: TextDocument; findings: Finding[] } {
  const doc = openDoc(src);
  return { doc, findings: computeLintFindings(doc, parse(src), selectRules(raw)) };
}

/** Lints `src` under `raw` and applies every fix right-to-left (at one offset the wider edit first,
 *  so an insert there survives as under LSP `applyEdits`), returning the result and its edits. The
 *  対象文字列 the fixes land inside are rewritten with them, as the code actions do. */
export function applyLintFixes(src: string, raw: RawLintConfigWire): { out: string; edits: LintEdit[] } {
  const { doc, findings } = lintFindings(src, raw);
  const edits = mergedEdits(findings.flatMap((f) => (f.fix ? [f.fix] : [])))
    .map((edit): LintEdit => ({ s: doc.offsetAt(edit.range.start), e: doc.offsetAt(edit.range.end), t: edit.newText }))
    .sort((a, b) => b.s - a.s || b.e - a.e);
  let out = src;
  for (const ed of edits) {
    out = out.slice(0, ed.s) + ed.t + out.slice(ed.e);
  }
  return { out, edits };
}

/** `doc` after the `source.fixAll` action over `findings`, applied as LSP applies it (overlapping fixes dropped). */
export function fixAllOf(doc: TextDocument, findings: readonly Finding[]): string {
  const whole = { start: doc.positionAt(0), end: doc.positionAt(doc.getText().length) };
  const [action] = buildCodeActions(doc.uri, findings, whole, [CodeActionKind.SourceFixAll]);
  return TextDocument.applyEdits(doc, action?.edit?.changes?.[doc.uri] ?? []);
}

/** The source after the editor's fix-all under `raw` (unlike {@link applyLintFixes}, overlapping fixes are dropped). */
export function applyFixAll(src: string, raw: RawLintConfigWire): string {
  const { doc, findings } = lintFindings(src, raw);
  return fixAllOf(doc, findings);
}
