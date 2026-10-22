/**
 * The browser behind "Print / save as PDF". `vscode.env.openExternal` takes a uri and nothing
 * else, so a chosen browser is launched as a process: `open -a` on macOS, the browser's own
 * executable elsewhere (its install paths on Windows, its command on PATH on Linux). This
 * module imports no `vscode`: the settings schema test (`test/shared/lint/_configSchema.ts`)
 * reads its constants.
 */
import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

/** The browsers the setting can name. */
export type Browser = 'chrome' | 'edge' | 'firefox';

/** The values of `jpnov.layout.print.browser`; `default` is the OS default browser. */
export const PRINT_BROWSER_SETTINGS = ['auto', 'default', 'chrome', 'edge', 'firefox'] as const;
export type PrintBrowserSetting = (typeof PRINT_BROWSER_SETTINGS)[number];
export const PRINT_BROWSER_DEFAULT: PrintBrowserSetting = 'auto';

/** The product names: what `open -a` takes on macOS, and what a toast shows. */
export const BROWSER_NAMES: Readonly<Record<Browser, string>> = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  firefox: 'Firefox',
};

export function isBrowser(setting: PrintBrowserSetting): setting is Browser {
  return setting in BROWSER_NAMES;
}

/** The executable under each Windows install root (`ProgramFiles`, `ProgramFiles(x86)`, `LOCALAPPDATA`). */
const WINDOWS_EXES: Readonly<Record<Browser, string>> = {
  chrome: 'Google\\Chrome\\Application\\chrome.exe',
  edge: 'Microsoft\\Edge\\Application\\msedge.exe',
  firefox: 'Mozilla Firefox\\firefox.exe',
};

/** The commands on PATH, tried in order, on Linux. */
const LINUX_COMMANDS: Readonly<Record<Browser, readonly string[]>> = {
  chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
  edge: ['microsoft-edge', 'microsoft-edge-stable'],
  firefox: ['firefox'],
};

/** The order `auto` searches, on macOS only: the one OS whose default browser may be Safari, which ignores the page's paper size and orientation. */
const AUTO_ORDER: readonly Browser[] = ['chrome', 'edge', 'firefox'];

/** How long a launched process may run before it counts as the browser: a stub, or `open` for a missing app, exits well within this. */
export const LAUNCH_SETTLE_MS = 1000;

/** One way to launch a browser; the url goes after `args`. */
export interface Launch {
  readonly command: string;
  readonly args: readonly string[];
}

/** The browsers to try for a setting value on a platform, in order; empty means the OS default browser. */
export function printCandidates(setting: PrintBrowserSetting, platform: string): readonly Browser[] {
  switch (setting) {
    case 'auto':
      return platform === 'darwin' ? AUTO_ORDER : [];
    case 'default':
      return [];
    default:
      return [setting];
  }
}

/** The launches to try for a browser on a platform, in order. */
export function launchPlan(browser: Browser, platform: string, env: NodeJS.ProcessEnv = process.env): readonly Launch[] {
  switch (platform) {
    case 'darwin':
      return [{ command: 'open', args: ['-a', BROWSER_NAMES[browser]] }];
    case 'win32':
      return [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
        .filter((root): root is string => root !== undefined)
        .map((root) => ({ command: win32.join(root, WINDOWS_EXES[browser]), args: [] }));
    default:
      return LINUX_COMMANDS[browser].map((command) => ({ command, args: [] }));
  }
}

/** Starts one launch; resolves whether the browser was found: a spawn error or a prompt non-zero exit says no, exit 0 or still running says yes. */
function launch({ command, args }: Launch, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args, url], { detached: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.unref();
      resolve(true);
    }, LAUNCH_SETTLE_MS);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Opens the urls in the first of `browsers` that is installed, and returns the urls nothing
 * opened. The first url is the probe (launching is the only test of what is installed); the
 * launch that took it opens the rest, and when none does, no url opens.
 */
export async function openInBrowser(urls: readonly string[], browsers: readonly Browser[], platform: string = process.platform): Promise<readonly string[]> {
  const [first, ...rest] = urls;
  if (first === undefined) {
    return urls;
  }
  let found: Launch | undefined;
  for (const step of browsers.flatMap((browser) => launchPlan(browser, platform))) {
    if (await launch(step, first)) {
      found = step;
      break;
    }
  }
  if (found === undefined) {
    return urls;
  }
  const unopened: string[] = [];
  for (const url of rest) {
    if (!(await launch(found, url))) {
      unopened.push(url);
    }
  }
  return unopened;
}
