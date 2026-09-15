/**
 * TEST-ONLY headless-Chromium DOM probe shared by the E2E suites. A page carries a parse-time
 * `<script>` that writes its findings into the `data-verify` attribute of `<html>`; `--dump-dom`
 * serializes the document at load, and the marker is read back out of the dump. Every run gets
 * a fresh `--user-data-dir` (a killed instance leaves a SingletonLock behind).
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

/** The `<html>` attribute a page's measurement script writes its JSON findings into. */
export const MARKER = 'data-verify';

/** The serializer escapes the attribute value; only `"` and `&` can occur in the JSON. */
const unescapeAttr = (s: string): string => s.replaceAll('&quot;', '"').replaceAll('&amp;', '&');

/**
 * Dumps the page DOM headlessly and extracts the marker attribute. The browser process
 * lingers after dumping, so poll the collected stdout for the complete marker, then kill.
 */
async function dumpMarker(browserPath: string, pageUrl: string, profileDir: string): Promise<string> {
  const ciFlags = process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
  const child = spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
    ...ciFlags,
    `--user-data-dir=${profileDir}`,
    '--window-size=900,700',
    '--timeout=3000',
    '--dump-dom',
    pageUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });

  const marker = new RegExp(`${MARKER}="([^"]*)"`);
  const deadline = Date.now() + 90_000;
  try {
    while (Date.now() < deadline) {
      const found = marker.exec(out);
      if (found) {
        return found[1] ?? '';
      }
      if (child.exitCode !== null) {
        break;
      }
      await delay(100);
    }
  } finally {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      if (child.exitCode === null) {
        await once(child, 'exit');
      }
    }
  }
  throw new Error(`no ${MARKER} marker in browser output.\nstderr tail: ${err.slice(-2000)}`);
}

/**
 * Writes `html` with `script` injected before </body> into a fresh temp dir (pushed onto
 * `cleanups` for the caller's teardown), dumps it headlessly, and returns the marker JSON text.
 */
export async function measurePage(
  browserPath: string,
  html: string,
  script: string,
  prefix: string,
  cleanups: string[],
): Promise<string> {
  const pageDir = await mkdtemp(join(tmpdir(), `jpnov-e2e-${prefix}-`));
  cleanups.push(pageDir);
  const pagePath = join(pageDir, `${prefix}.html`);
  await writeFile(pagePath, html.replace('</body>', `${script}</body>`), 'utf8');
  const profileDir = await mkdtemp(join(pageDir, 'profile-'));
  return unescapeAttr(await dumpMarker(browserPath, pathToFileURL(pagePath).href, profileDir));
}
