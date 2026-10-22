/**
 * TEST-ONLY Chromium resolution + headless print argv for the E2E fidelity suites: the
 * product only hands a page to a browser, but these suites print through a real Chromium — the
 * reference engine for the paper geometry (@page boxes, page count, vertical-flow metrics)
 * the artifact promises to any browser's print dialog. Candidate paths mirror
 * chrome-launcher / puppeteer's install-location lists; Chrome, Edge, Chromium and Brave
 * accept the same flags.
 */

interface BrowserResolveOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** Existence predicate (real caller: `fs.existsSync`); injected so the resolver stays pure. */
  readonly exists: (path: string) => boolean;
}

/**
 * The browser executable to drive, or `undefined` when none is found. Priority: the
 * `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` env vars, then per-platform defaults.
 */
export function resolveBrowserExecutable(opts: BrowserResolveOptions): string | undefined {
  for (const key of ['CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH'] as const) {
    const value = opts.env[key]?.trim();
    if (value && opts.exists(value)) {
      return value;
    }
  }
  for (const candidate of platformCandidates(opts.platform, opts.env)) {
    if (opts.exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Well-known install locations per platform, in preference order (Chrome → Edge → Chromium → Brave). */
function platformCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (platform === 'win32') {
    // %ProgramFiles% is the 64-bit install root, the (x86) variant 32-bit, %LOCALAPPDATA% per-user.
    const roots = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']
      .map((key) => env[key])
      .filter((root): root is string => typeof root === 'string' && root.length > 0);
    const relatives = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'Chromium\\Application\\chrome.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ];
    return relatives.flatMap((rel) => roots.map((root) => `${root}\\${rel}`));
  }
  // Linux / other: fixed absolute paths, then the same binaries resolved against $PATH.
  const absolute = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/brave-browser',
  ];
  const names = [
    'google-chrome-stable',
    'google-chrome',
    'microsoft-edge-stable',
    'microsoft-edge',
    'chromium',
    'chromium-browser',
    'brave-browser',
  ];
  return [...absolute, ...resolveOnPath(names, env)];
}

/** Each name joined onto every `$PATH` directory (POSIX), name-major so preference order holds. */
function resolveOnPath(names: string[], env: NodeJS.ProcessEnv): string[] {
  const dirs = (env.PATH ?? '').split(':').filter((dir) => dir.length > 0);
  return names.flatMap((name) => dirs.map((dir) => `${dir}/${name}`));
}

/**
 * The headless print-to-PDF invocation for any Chromium-family browser. A fresh
 * `--user-data-dir` is mandatory: it forces a standalone instance (never joining a running
 * Chrome) and sidesteps the SingletonLock a shared profile leaves behind. `--use-mock-keychain`
 * keeps the fresh profile's first run from touching the macOS Keychain, whose (invisible)
 * unlock prompt stalls a headless browser. The built HTML already keeps the browser's own
 * header/footer off the paper via `@page{margin:0}`; `--no-pdf-header-footer` is
 * belt-and-braces.
 */
export function printToPdfArgs(htmlFileUrl: string, outPdfPath: string, userDataDir: string): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    `--user-data-dir=${userDataDir}`,
    '--no-pdf-header-footer',
    `--print-to-pdf=${outPdfPath}`,
    htmlFileUrl,
  ];
}
