import { BrowserWindow, app, ipcMain, nativeTheme, session, shell, utilityProcess } from "electron";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** Where the host's bundle and the built UI live. */
interface Paths {
  readonly hostEntry: string;
  readonly uiDir: string;
}

/**
 * Resolves the host bundle and UI build for this run.
 *
 * @remarks
 * Packaging is out of scope for v0.1 (development.md), so paths point into the repository;
 * `ATRIUM_HOST_ENTRY` overrides the host for tests.
 *
 * @sideEffects Reads environment variables.
 * @returns Absolute paths.
 */
function resolvePaths(): Paths {
  const repoRoot = join(__dirname, "..", "..", "..");
  return {
    hostEntry: process.env["ATRIUM_HOST_ENTRY"] ?? join(repoRoot, "packages", "host", "dist", "entry.cjs"),
    uiDir: join(repoRoot, "packages", "ui", "dist"),
  };
}

/** A started host process. */
interface HostProcess {
  readonly port: number;
  /** Asks the host to shut down and resolves once it has exited. */
  readonly stop: () => Promise<void>;
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
 * root and is covered by end-to-end tests, not unit tests with a fake clock.
 *
 * @sideEffects Forks a utility process and posts the config to it; logs to stderr if the host
 * later exits unexpectedly.
 * @param options - Host bundle path, token, UI directory and extra allowed origins.
 * @returns The host's port and a function that stops it.
 * @throws {Error} When the host reports a failure, exits early, or does not start in time.
 */
function startHost(options: {
  readonly hostEntry: string;
  readonly token: string;
  readonly uiDir: string | undefined;
  readonly extraOrigins: readonly string[];
}): Promise<HostProcess> {
  const child = utilityProcess.fork(options.hostEntry, [], { serviceName: "atrium-host", stdio: "inherit" });
  child.postMessage({ type: "config", token: options.token, uiDir: options.uiDir, extraOrigins: options.extraOrigins });
  let stopping = false;
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
      reject(new Error(`host exited during startup with code ${code}`));
      if (!stopping) console.error(`atrium: host exited unexpectedly with code ${code}`);
    });
    child.on("message", (message: { type?: string; port?: number; message?: string }) => {
      if (message.type === "ready" && typeof message.port === "number") {
        clearTimeout(timer);
        resolve({ port: message.port, stop });
      } else if (message.type === "failed") {
        clearTimeout(timer);
        reject(new Error(`host failed to start: ${message.message ?? "unknown error"}`));
      }
    });
  });
}

/**
 * Content Security Policy for the Vite dev server page.
 *
 * @remarks
 * In development the page comes from Vite, not the host, so the host's CSP header never reaches
 * it while it still holds the real token (security.md, "Electron"). The policy matches the
 * host's, except that inline scripts are allowed for React Fast Refresh's preamble and the page
 * may connect to the host on its own port.
 *
 * @sideEffects none
 * @param hostPort - Port the host listens on.
 * @returns The policy string.
 */
function devContentSecurityPolicy(hostPort: number): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
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
 * Applies the window-level security rules to a window's web contents.
 *
 * @remarks
 * The page may only stay on its own origin; any other navigation or `window.open` is refused,
 * and http(s) links go to the system browser instead (security.md, "Electron").
 *
 * @sideEffects Registers navigation and window-open handlers on `window`; may open URLs in the
 * system browser.
 * @param window - The window to restrict.
 * @param pageOrigin - The only origin the page may navigate within.
 */
function restrictNavigation(window: BrowserWindow, pageOrigin: string): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === pageOrigin) return;
    event.preventDefault();
    openInBrowser(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: "deny" };
  });
}

/**
 * Starts the host, then opens the main window on the page the host (or the Vite dev server) serves.
 *
 * @remarks
 * Renderer settings follow security.md ("Electron"): context isolation, sandbox, no Node. The
 * preload asks for the token over IPC, and the handler answers only frames from the expected
 * origin. Permission requests are refused until a feature needs one. Quitting is held until the
 * host has shut down cleanly. In development the Vite page gets its own CSP header.
 *
 * @sideEffects Generates the session token; starts the host; registers IPC handlers; creates a
 * window; adds a CSP header to dev pages; delays quitting until the host has stopped.
 */
async function main(): Promise<void> {
  await app.whenReady();
  nativeTheme.themeSource = "system";
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  const paths = resolvePaths();
  const devUrl = process.env["ATRIUM_DEV_URL"];
  const token = randomBytes(32).toString("base64url");
  const host = await startHost({
    hostEntry: paths.hostEntry,
    token,
    uiDir: devUrl === undefined ? paths.uiDir : undefined,
    extraOrigins: devUrl === undefined ? [] : [new URL(devUrl).origin],
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
  const pageUrl = devUrl ?? `${hostUrl}/`;
  const pageOrigin = new URL(pageUrl).origin;
  if (devUrl !== undefined) {
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${pageOrigin}/*`] }, (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [devContentSecurityPolicy(host.port)],
        },
      });
    });
  }

  ipcMain.handle("atrium:bootstrap", (event) => {
    if (event.senderFrame === null || new URL(event.senderFrame.url).origin !== pageOrigin) {
      throw new Error("bootstrap requested from an unexpected origin");
    }
    return { hostUrl, token };
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
  restrictNavigation(window, pageOrigin);
  window.once("ready-to-show", () => window.show());
  await window.loadURL(pageUrl);
}

app.on("window-all-closed", () => app.quit());
main().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
