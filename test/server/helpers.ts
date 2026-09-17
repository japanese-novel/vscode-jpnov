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

import type { Connection } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { selectRules } from '../../src/shared/lint/select.ts';
import { computeLintFindings } from '../../src/server/lint/engine.ts';
import type { RawLintConfigWire } from '../../src/shared/protocol.ts';
import { createHighlightStore } from '../../src/server/highlight/vocabulary.ts';
import type { ReadText, ServerContext } from '../../src/server/context.ts';
import { errorText } from '../../src/shared/errors.ts';
import { createWorkspaceRoots } from '../../src/server/roots.ts';

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
  readonly diagnostics: RecordedDiagnostics[];
  /** How many times the server asked the client to re-pull semantic tokens. */
  semanticTokenRefreshes(): number;
  /** Cast to the real Connection for injection into a ServerContext. */
  asConnection(): Connection;
}

export function makeFakeConnection(): FakeConnection {
  const notifications: RecordedNotification[] = [];
  const diagnostics: RecordedDiagnostics[] = [];

  let refreshCount = 0;

  const impl = {
    notifications,
    diagnostics,
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
    sendDiagnostics(params: { uri: string; diagnostics: unknown[] }): Promise<void> {
      diagnostics.push({ uri: params.uri, count: params.diagnostics.length });
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

export function makeContext(conn: FakeConnection, readText: ReadText = nodeReader()): ServerContext {
  return {
    connection: conn.asConnection(),
    readText,
    lintSelection: selectRules({}),
    highlight: createHighlightStore(),
    roots: createWorkspaceRoots(),
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

/** One lint-fix edit in absolute source offsets (`s === e` is an insert). */
export interface LintEdit {
  readonly s: number;
  readonly e: number;
  readonly t: string;
}

/** Lints `src` under `raw` and applies every fix right-to-left (at one offset the wider edit first,
 *  so an insert there survives as under LSP `applyEdits`), returning the result and its edits. */
export function applyLintFixes(src: string, raw: RawLintConfigWire): { out: string; edits: LintEdit[] } {
  const doc = TextDocument.create('mem://x.jpnov', 'jpnov', 1, src);
  const findings = computeLintFindings(src, selectRules(raw), doc);
  const edits = findings
    .flatMap((f) =>
      f.fix ? [{ s: doc.offsetAt(f.fix.range.start), e: doc.offsetAt(f.fix.range.end), t: f.fix.newText }] : [],
    )
    .sort((a, b) => b.s - a.s || b.e - a.e);
  let out = src;
  for (const ed of edits) {
    out = out.slice(0, ed.s) + ed.t + out.slice(ed.e);
  }
  return { out, edits };
}
