/**
 * The print browser: which browsers a setting value tries on each platform, how each is
 * launched, and what "not installed" looks like — a spawn error or a prompt non-zero exit; a
 * process that exits 0 or still runs after the settle time has the browser.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeSpawn } from './_fakeSpawn.ts';

const fake = createFakeSpawn();
mock.module('node:child_process', { exports: { spawn: fake.spawn } });

const { LAUNCH_SETTLE_MS, launchPlan, openInBrowser, printCandidates, PRINT_BROWSER_DEFAULT, PRINT_BROWSER_SETTINGS } = await import('../../src/client/book/browser.ts');

beforeEach(() => {
  fake.reset();
});

test('auto searches Chrome, Edge, Firefox on macOS only; default tries nothing; a named browser is itself', () => {
  assert.deepEqual(printCandidates('auto', 'darwin'), ['chrome', 'edge', 'firefox']);
  assert.deepEqual(printCandidates('auto', 'win32'), []);
  assert.deepEqual(printCandidates('auto', 'linux'), []);
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.deepEqual(printCandidates('default', platform), []);
    assert.deepEqual(printCandidates('edge', platform), ['edge']);
  }
  assert.deepEqual([...PRINT_BROWSER_SETTINGS], ['auto', 'default', 'chrome', 'edge', 'firefox']);
  assert.equal(PRINT_BROWSER_DEFAULT, 'auto');
});

test('each platform launches its own way: open -a, the install paths under the Windows roots, the commands on PATH', () => {
  assert.deepEqual(launchPlan('chrome', 'darwin'), [{ command: 'open', args: ['-a', 'Google Chrome'] }]);
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  assert.deepEqual(launchPlan('edge', 'win32', env).map((l) => l.command), [
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Users\\u\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
  ]);
  assert.deepEqual(launchPlan('firefox', 'win32', { ProgramFiles: 'C:\\Program Files' }).map((l) => l.command), ['C:\\Program Files\\Mozilla Firefox\\firefox.exe']);
  assert.deepEqual(launchPlan('firefox', 'linux'), [{ command: 'firefox', args: [] }]);
  assert.deepEqual(launchPlan('chrome', 'linux').map((l) => l.command), ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);
});

test('macOS: the url goes last to open -a; exit 0 opens, a non-zero exit (app not found) leaves the url unopened', async () => {
  fake.script.set('open', 0);
  assert.deepEqual(await openInBrowser(['file:///a.html'], ['chrome'], 'darwin'), []);
  assert.deepEqual(fake.spawned, [{ command: 'open', args: ['-a', 'Google Chrome', 'file:///a.html'] }]);
  fake.script.set('open', 1);
  assert.deepEqual(await openInBrowser(['file:///a.html'], ['edge'], 'darwin'), ['file:///a.html']);
});

test('the first url probes the browsers in order (ENOENT and a stub that exits non-zero move on); the launch that took it opens the rest', async () => {
  fake.script.set('google-chrome-stable', 1);
  fake.script.set('chromium', 0);
  const urls = ['file:///a.html', 'file:///b.html', 'file:///c.html'];
  assert.deepEqual(await openInBrowser(urls, ['chrome', 'firefox'], 'linux'), []);
  assert.deepEqual(fake.spawned.map((s) => [s.command, ...s.args].join(' ')), [
    'google-chrome file:///a.html',
    'google-chrome-stable file:///a.html',
    'chromium file:///a.html',
    'chromium file:///b.html',
    'chromium file:///c.html',
  ]);
});

test('no browser installed: the probe fails, every url is unopened, and no further url is tried', async () => {
  const urls = ['file:///a.html', 'file:///b.html'];
  assert.deepEqual(await openInBrowser(urls, ['edge', 'firefox'], 'linux'), urls);
  assert.deepEqual(fake.spawned.map((s) => s.command), ['microsoft-edge', 'microsoft-edge-stable', 'firefox']);
  assert.deepEqual(await openInBrowser(urls, [], 'linux'), urls); // no candidates: nothing spawned
  assert.equal(fake.spawned.length, 3);
});

test('a process still running after the settle time is the browser: the url opened, the child let go of', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fake.script.set('firefox', null);
  const result = openInBrowser(['file:///a.html'], ['firefox'], 'linux');
  await Promise.resolve(); // the spawn's microtask
  t.mock.timers.tick(LAUNCH_SETTLE_MS);
  assert.deepEqual(await result, []);
  assert.equal(fake.unrefs, 1);
});

test('a launcher that is itself missing (no `open`) leaves the url unopened, without a throw', async () => {
  assert.deepEqual(await openInBrowser(['file:///a.html'], ['firefox'], 'darwin'), ['file:///a.html']);
});
