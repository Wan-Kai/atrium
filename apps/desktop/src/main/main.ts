import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
  utilityProcess,
} from "electron";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Where the host's bundle and the built UI live, and how often the app's processes are sampled. */
interface Paths {
  readonly hostEntry: string;
  readonly uiDir: string;
  readonly metricsIntervalMs: number;
}

/**
 * Resolves the host bundle and UI build for this run.
 *
 * @remarks
 * Packaging is out of scope for v0.1 (development.md), so paths point into the repository;
 * `ATRIUM_HOST_ENTRY` overrides the host for tests, and `ATRIUM_APP_METRICS_INTERVAL_MS` the
 * minute between samples of the app's processes, so a test need not wait for one.
 *
 * @sideEffects Reads environment variables.
 * @returns Absolute paths and the sampling interval.
 */
function resolvePaths(): Paths {
  const repoRoot = join(__dirname, "..", "..", "..");
  return {
    hostEntry: process.env["ATRIUM_HOST_ENTRY"] ?? join(repoRoot, "packages", "host", "dist", "entry.cjs"),
    uiDir: join(repoRoot, "packages", "ui", "dist"),
    metricsIntervalMs: Number(process.env["ATRIUM_APP_METRICS_INTERVAL_MS"] ?? 60_000),
  };
}

/** A started host process. */
interface HostProcess {
  readonly port: number;
  /** Asks the host to shut down and resolves once it has exited. */
  readonly stop: () => Promise<void>;
}

/**
 * Samples the app's processes in the shape the host logs them.
 *
 * @remarks
 * The main process has no log of its own, so the host logs these next to its own resource counts
 * (observability.md, "和测试的关系"). Memory is the working set, in KB.
 *
 * @sideEffects Reads process metrics.
 * @returns One entry per process.
 */
function sampleAppMetrics(): Array<{ type: string; memoryKb: number; cpuPercent: number }> {
  return app.getAppMetrics().map((metric) => ({
    type: metric.type,
    memoryKb: metric.memory.workingSetSize,
    cpuPercent: metric.cpu.percentCPUUsage,
  }));
}

/** How long the host gets to flush logs and close connections before it is killed. */
const HOST_SHUTDOWN_TIMEOUT_MS = 5_000;
/** How long the host may take to start. */
const HOST_STARTUP_TIMEOUT_MS = 15_000;

/**
 * Starts the host in an Electron utility process and waits until it listens.
 *
 * @remarks
 * The host runs on Electron's bundled Node, so users need no Node of their own for it
 * (overview.md, "桌面端怎么启动宿主"). The token goes over the process message port, never
 * through argv or the environment, which other local processes can read (security.md). Once the
 * host is ready, an unexpected exit is reported instead of being swallowed by the settled
 * startup promise. Timers here use the platform directly: the main process is the composition
 * root and is covered by end-to-end tests, not unit tests with a fake clock. Once the host is
 * ready it gets a sample of the app's processes at every interval, until it stops or exits
 * (testing.md, "运行时监控").
 *
 * @sideEffects Forks a utility process and posts the config to it; posts app metrics at every
 * interval while the host runs; logs to stderr if the host later exits unexpectedly.
 * @param options - Host bundle path, token, UI directory, extra allowed origins and the interval
 * between samples of the app's processes.
 * @returns The host's port and a function that stops it.
 * @throws {Error} When the host reports a failure, exits early, or does not start in time.
 */
function startHost(options: {
  readonly hostEntry: string;
  readonly token: string;
  readonly uiDir: string | undefined;
  readonly extraOrigins: readonly string[];
  readonly metricsIntervalMs: number;
}): Promise<HostProcess> {
  const child = utilityProcess.fork(options.hostEntry, [], { serviceName: "atrium-host", stdio: "inherit" });
  child.postMessage({ type: "config", token: options.token, uiDir: options.uiDir, extraOrigins: options.extraOrigins });
  let stopping = false;
  let metricsTimer: NodeJS.Timeout | undefined;
  const exited = new Promise<number>((done) => child.once("exit", (code) => done(code)));

  /**
   * Asks the host to stop and waits for it, killing it if it takes too long.
   *
   * @remarks
   * Quitting must wait for this, or Electron tears down the utility process before the host has
   * written its last log records (Electron shuts utility processes down while quitting).
   *
   * @sideEffects Posts `shutdown`; may kill the process.
   */
  async function stop(): Promise<void> {
    stopping = true;
    child.postMessage({ type: "shutdown" });
    const killTimer = setTimeout(() => child.kill(), HOST_SHUTDOWN_TIMEOUT_MS);
    await exited;
    clearTimeout(killTimer);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("host did not start in time"));
    }, HOST_STARTUP_TIMEOUT_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      clearInterval(metricsTimer);
      reject(new Error(`host exited during startup with code ${code}`));
      if (!stopping) console.error(`atrium: host exited unexpectedly with code ${code}`);
    });
    child.on("message", (message: { type?: string; port?: number; message?: string }) => {
      if (message.type === "ready" && typeof message.port === "number") {
        clearTimeout(timer);
        metricsTimer = setInterval(
          () => child.postMessage({ type: "app_metrics", processes: sampleAppMetrics() }),
          options.metricsIntervalMs,
        );
        resolve({ port: message.port, stop });
      } else if (message.type === "failed") {
        clearTimeout(timer);
        reject(new Error(`host failed to start: ${message.message ?? "unknown error"}`));
      }
    });
  });
}

/** The scheme and origin the window loads the UI from, the same on every launch. */
const APP_SCHEME = "atrium";
const APP_ORIGIN = `${APP_SCHEME}://app`;

/**
 * Content Security Policy for a page the host does not serve directly.
 *
 * @remarks
 * Matches the host's own policy (security.md, "Electron"), except that the page may connect to
 * the host on its port, which is not the page's own origin. In development the page comes from
 * Vite, and inline scripts are also allowed for React Fast Refresh's preamble.
 *
 * @sideEffects none
 * @param hostPort - Port the host listens on.
 * @param dev - Whether the page is Vite's.
 * @returns The policy string.
 */
function pageContentSecurityPolicy(hostPort: number, dev: boolean): string {
  return [
    "default-src 'self'",
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    `connect-src 'self' ws://127.0.0.1:${hostPort}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * Opens an http(s) URL in the system browser and ignores every other scheme.
 *
 * @remarks
 * Links never open inside the app, and schemes such as `file:` or custom protocols are never
 * handed to the OS (security.md, "Electron").
 *
 * @sideEffects May launch the system browser.
 * @param url - The URL the page tried to open.
 */
function openInBrowser(url: string): void {
  // Fire and forget: nothing in the app depends on whether the browser opened.
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
}

/**
 * Whether the page may show a path in the Finder: an absolute path that exists.
 *
 * @remarks
 * The page asks for pi's location and the log folder (SPEC-0001, "设置"); anything else it sends
 * is ignored (security.md, "Electron").
 *
 * @sideEffects Reads the file system.
 * @param path - The path the page sent.
 * @returns Whether to show it.
 */
async function isRevealable(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Whether a URL belongs to the app's page.
 *
 * @remarks
 * Compares scheme and host (with port), not `URL.origin`: Node gives every URL of a scheme it does
 * not know, `atrium:` included, the origin `"null"`, so all opaque origins would compare equal
 * (security.md, "Electron").
 *
 * @sideEffects none
 * @param url - The URL to check.
 * @param pageUrl - The page's URL.
 * @returns Whether it is the page's.
 */
function isPageUrl(url: string, pageUrl: string): boolean {
  try {
    const candidate = new URL(url);
    const page = new URL(pageUrl);
    return candidate.protocol === page.protocol && candidate.host === page.host;
  } catch {
    return false;
  }
}

/**
 * Applies the window-level security rules to a window's web contents.
 *
 * @remarks
 * The page may only stay on its own origin; any other navigation or `window.open` is refused,
 * and http(s) links go to the system browser instead (security.md, "Electron").
 *
 * @sideEffects Registers navigation and window-open handlers on `window`; may open URLs in the
 * system browser.
 * @param window - The window to restrict.
 * @param pageUrl - The page; navigation stays within its scheme and host.
 */
function restrictNavigation(window: BrowserWindow, pageUrl: string): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (isPageUrl(url, pageUrl)) return;
    event.preventDefault();
    openInBrowser(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: "deny" };
  });
}

/**
 * Starts the host, then opens the main window on the UI: the host's files at `atrium://app/`, or
 * the Vite dev server's page.
 *
 * @remarks
 * Renderer settings follow security.md ("Electron"): context isolation, sandbox, no Node. The
 * preload asks for the token over IPC, and the handler answers only frames from the expected
 * origin. Permission requests are refused until a feature needs one. Quitting is held until the
 * host has shut down cleanly. In development the Vite page gets its own CSP header. Opening the
 * app again focuses this window.
 *
 * @sideEffects Generates the session token; starts the host; registers IPC handlers (bootstrap,
 * choosing a folder, appearance); sets the app menu; creates a window; adds a CSP header to dev pages; delays quitting until the host has stopped; focuses
 * the window when the app is opened again.
 */
async function main(): Promise<void> {
  await app.whenReady();
  nativeTheme.themeSource = "system";
  Menu.setApplicationMenu(appMenu());
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  const paths = resolvePaths();
  const devUrl = process.env["ATRIUM_DEV_URL"];
  const token = randomBytes(32).toString("base64url");
  const host = await startHost({
    hostEntry: paths.hostEntry,
    token,
    uiDir: devUrl === undefined ? paths.uiDir : undefined,
    extraOrigins: [devUrl === undefined ? APP_ORIGIN : new URL(devUrl).origin],
    metricsIntervalMs: paths.metricsIntervalMs,
  });
  let hostStopped = false;
  app.on("will-quit", (event) => {
    if (hostStopped) return;
    event.preventDefault();
    hostStopped = true;
    // Fire and forget: quitting resumes once the host has exited.
    void host.stop().finally(() => app.quit());
  });

  const hostUrl = `http://127.0.0.1:${host.port}`;
  const pageUrl = devUrl ?? `${APP_ORIGIN}/`;
  const pageOrigin = new URL(pageUrl).origin;
  if (devUrl !== undefined) {
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${pageOrigin}/*`] }, (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [pageContentSecurityPolicy(host.port, true)],
        },
      });
    });
  } else {
    serveAppScheme(hostUrl, pageContentSecurityPolicy(host.port, false));
  }

  /**
   * Refuses IPC from any frame but the app's page.
   *
   * @remarks
   * Every handler answers only the expected origin (security.md, "Electron").
   *
   * @sideEffects none
   * @param event - The IPC event.
   * @throws {Error} When the sender is another origin.
   */
  const checkSender = (event: Electron.IpcMainInvokeEvent): void => {
    if (event.senderFrame === null || !isPageUrl(event.senderFrame.url, pageUrl)) {
      throw new Error("IPC from an unexpected origin");
    }
  };
  ipcMain.handle("atrium:bootstrap", (event) => {
    checkSender(event);
    return { hostUrl, token };
  });
  ipcMain.handle("atrium:pick-directory", async (event) => {
    checkSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
    const chosen =
      window === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
    return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
  });
  ipcMain.handle("atrium:reveal", async (event, path: unknown) => {
    checkSender(event);
    if (typeof path === "string" && (await isRevealable(path))) shell.showItemInFolder(path);
  });
  ipcMain.handle("atrium:appearance", (event, appearance: unknown) => {
    checkSender(event);
    if (appearance === "system" || appearance === "light" || appearance === "dark") {
      nativeTheme.themeSource = appearance;
    }
  });

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d1016" : "#e8ecf2",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  restrictNavigation(window, pageUrl);
  window.once("ready-to-show", () => window.show());
  // Opening the app again brings this window forward (domain-model §1, "索引的存储").
  app.on("second-instance", () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  await window.loadURL(pageUrl);
}

/**
 * Serves `atrium://app/` from the host's static files.
 *
 * @remarks
 * The page needs an origin that stays the same across launches, or its `localStorage` (the
 * client id, collapsed projects, drafts) is lost with every new host port (overview.md,
 * "桌面端怎么启动宿主"). Requests are forwarded to the host, which keeps the path and symlink
 * checks (security.md, "子进程与文件"); only the CSP header is replaced, so the page may reach
 * the host's WebSocket.
 *
 * @sideEffects Registers the scheme's handler on the default session.
 * @param hostUrl - The host's HTTP origin.
 * @param policy - The page's CSP.
 */
function serveAppScheme(hostUrl: string, policy: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    // Only the app's own host; another would be a different page with the same powers.
    if (url.host !== "app") return new Response(null, { status: 404 });
    const response = await net.fetch(`${hostUrl}${url.pathname}${url.search}`, { bypassCustomProtocolHandlers: true });
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", policy);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
}

/**
 * The app menu: the standard app, edit and window items, without closing the window on ⌘W.
 *
 * @remarks
 * ⌘W closes a session tab and ⌘N, ⌘T create sessions (SPEC-0001, "标签栏"); Electron's default
 * menu would take ⌘W to close the window first. The edit items keep copy, paste and undo working
 * in text fields; the view items keep reload and the developer tools.
 *
 * @sideEffects none
 * @returns The menu.
 */
function appMenu(): Menu {
  return Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" }],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] },
  ]);
}

/**
 * Keeps Electron's own data with the Atrium home it was pointed at.
 *
 * @remarks
 * Electron's single-instance lock and the page's storage live in its user data directory. With
 * `ATRIUM_HOME` set (tests, a second development copy), the app is a separate instance with its
 * own storage, so it neither blocks nor is blocked by the Atrium in normal use.
 *
 * @sideEffects Changes Electron's user data path when `ATRIUM_HOME` is set.
 */
function separateUserData(): void {
  const home = process.env["ATRIUM_HOME"];
  if (home !== undefined && home !== "") app.setPath("userData", join(home, "electron"));
}

separateUserData();
// Before the app is ready, so the page's origin behaves like https: storage, fetch and a secure context.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);
// Only one app per home: a second launch hands over to the first and quits (domain-model §1,
// "索引的存储").
if (app.requestSingleInstanceLock()) {
  app.on("window-all-closed", () => app.quit());
  main().catch((error: unknown) => {
    console.error(error);
    app.exit(1);
  });
} else {
  app.quit();
}
