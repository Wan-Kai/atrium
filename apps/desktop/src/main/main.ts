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

/**
 * Starts the host in an Electron utility process and waits until it listens.
 *
 * @remarks
 * The host runs on Electron's bundled Node, so users need no Node of their own for it
 * (overview.md, "桌面端怎么启动宿主"). The token goes over the process message port, never
 * through argv or the environment, which other local processes can read (security.md).
 *
 * @sideEffects Forks a utility process and posts the config to it; the process lives until
 * `stop` is called or the app quits.
 * @param options - Host bundle path, token, UI directory and extra allowed origins.
 * @returns The host's port and a function that stops it.
 * @throws {Error} When the host reports a failure, exits early, or does not start within 15 seconds.
 */
function startHost(options: {
  readonly hostEntry: string;
  readonly token: string;
  readonly uiDir: string | undefined;
  readonly extraOrigins: readonly string[];
}): Promise<{ port: number; stop: () => void }> {
  const child = utilityProcess.fork(options.hostEntry, [], { serviceName: "atrium-host", stdio: "inherit" });
  child.postMessage({ type: "config", token: options.token, uiDir: options.uiDir, extraOrigins: options.extraOrigins });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("host did not start within 15 seconds")), 15_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`host exited during startup with code ${code}`));
    });
    child.on("message", (message: { type?: string; port?: number; message?: string }) => {
      if (message.type === "ready" && typeof message.port === "number") {
        clearTimeout(timer);
        resolve({
          port: message.port,
          stop: () => {
            child.postMessage({ type: "shutdown" });
            setTimeout(() => child.kill(), 3_000).unref();
          },
        });
      } else if (message.type === "failed") {
        clearTimeout(timer);
        reject(new Error(`host failed to start: ${message.message ?? "unknown error"}`));
      }
    });
  });
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
 * origin. Permission requests are refused until a feature needs one.
 *
 * @sideEffects Generates the session token; starts the host; registers IPC handlers; creates a
 * window; stops the host when the app quits.
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
  app.once("will-quit", () => host.stop());

  const hostUrl = `http://127.0.0.1:${host.port}`;
  const pageUrl = devUrl ?? `${hostUrl}/`;
  const pageOrigin = new URL(pageUrl).origin;

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
