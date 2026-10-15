import { expect, test } from "@playwright/test";
import { createTempDir, present } from "@atrium/testkit";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { type LaunchedApp, launchApp } from "./launch";
import { startCountingServer } from "./servers";

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.close();
});

test("opens a window on the host's UI at a fixed origin, protected by the content security policy", async () => {
  const csp = await launched.window.evaluate(async () =>
    (await fetch(location.href)).headers.get("content-security-policy"),
  );

  expect(launched.window.url()).toBe("atrium://app/");
  expect(csp).toContain("script-src 'self';");
  expect(csp).toMatch(/connect-src 'self' ws:\/\/127\.0\.0\.1:\d+;/);
});

test("keeps the page's storage across a restart, since its origin stays the same", async () => {
  const before = await launched.window.evaluate(() => [location.origin, localStorage.getItem("atrium.clientId")]);
  await launched.quit();

  launched = await launchApp({}, launched.home);
  const after = await launched.window.evaluate(() => [location.origin, localStorage.getItem("atrium.clientId")]);

  expect(after).toStrictEqual(before);
  expect(before[0]).toBe("atrium://app");
});

test("gives the page no Node access and only the bridge: bootstrap, folder choice, appearance, dropped files' paths and showing in the Finder", async () => {
  const exposed = await launched.window.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    bridge: Object.keys(window.atrium),
  }));

  expect(exposed).toStrictEqual({
    require: "undefined",
    process: "undefined",
    bridge: ["getBootstrap", "pickDirectory", "setAppearance", "pathForFile", "reveal"],
  });
});

test("shows in the Finder only an absolute path that exists", async () => {
  const dir = await createTempDir("reveal");
  try {
    await launched.app.evaluate(({ shell }) => {
      const revealed: string[] = [];
      Object.assign(globalThis, { revealed });
      // Record instead of opening the real Finder during tests.
      shell.showItemInFolder = (path: string) => {
        revealed.push(path);
      };
    });

    await launched.window.evaluate(async (path) => {
      const { reveal } = window.atrium as unknown as { reveal: (path: unknown) => Promise<void> };
      await reveal(path);
      await reveal(`${path}/missing`);
      // Exists, from wherever the app runs.
      await reveal(".");
      await reveal(42);
    }, dir.path);

    expect(await launched.app.evaluate(() => (globalThis as unknown as { revealed: string[] }).revealed)).toStrictEqual(
      [dir.path],
    );
  } finally {
    await dir.cleanup();
  }
});

test("keeps the page on its own origin and refuses new windows", async () => {
  const target = await startCountingServer();
  const origin = new URL(launched.window.url()).origin;
  await launched.app.evaluate(({ BrowserWindow, shell }) => {
    const attempts: string[] = [];
    const external: string[] = [];
    Object.assign(globalThis, { navigationAttempts: attempts, externalOpens: external });
    BrowserWindow.getAllWindows()[0]?.webContents.on("will-navigate", (_event, url) => attempts.push(url));
    // Record instead of launching the real system browser during tests.
    shell.openExternal = async (url: string) => {
      external.push(url);
    };
  });

  const opened = await launched.window.evaluate((url) => window.open(url) === null, target.url);
  await launched.window.evaluate((url) => {
    location.href = url;
  }, `${target.url}/elsewhere`);
  await expect
    .poll(() => launched.app.evaluate(() => (globalThis as { navigationAttempts?: string[] }).navigationAttempts))
    .toStrictEqual([`${target.url}/elsewhere`]);
  await launched.window.reload();

  expect(opened).toBe(true);
  expect(new URL(launched.window.url()).origin).toBe(origin);
  expect(target.requests()).toBe(0);
  expect(await launched.app.evaluate(() => (globalThis as { externalOpens?: string[] }).externalOpens)).toStrictEqual([
    `${target.url}/`,
    `${target.url}/elsewhere`,
  ]);
  await target.close();
});

test("refuses to navigate to another host of its own scheme", async () => {
  await launched.app.evaluate(({ BrowserWindow }) => {
    const attempts: string[] = [];
    Object.assign(globalThis, { navigationAttempts: attempts });
    BrowserWindow.getAllWindows()[0]?.webContents.on("will-navigate", (_event, url) => attempts.push(url));
  });

  await launched.window.evaluate(() => {
    location.href = "atrium://other/";
  });
  await expect
    .poll(() => launched.app.evaluate(() => (globalThis as { navigationAttempts?: string[] }).navigationAttempts))
    .toStrictEqual(["atrium://other/"]);
  await launched.window.waitForTimeout(500);

  expect(launched.window.url()).toBe("atrium://app/");
});

test("follows the system appearance", async () => {
  const isDark = () => launched.window.evaluate(() => document.documentElement.classList.contains("dark"));

  await launched.app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = "dark";
  });
  await expect.poll(isDark).toBe(true);
  await launched.app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = "light";
  });
  await expect.poll(isDark).toBe(false);
});

test("marks the page as having macOS's sidebar material behind it, the page see-through", async () => {
  const page = await launched.window.evaluate(() => [
    document.documentElement.dataset["material"],
    getComputedStyle(document.body).backgroundColor,
  ]);

  expect(page).toStrictEqual(["", "rgba(0, 0, 0, 0)"]);
});

/**
 * The mean colour of an empty patch of the app's sidebar, as macOS draws its window now.
 *
 * @remarks
 * Only a capture of the window itself has the material in it; the page's own screenshot does not.
 * Scaling the patch down to one pixel averages it.
 *
 * @sideEffects Runs `screencapture`, writing `file`.
 * @param app - The app.
 * @param file - Where the capture goes.
 * @returns The red, green and blue means, 0 to 255.
 */
async function sidebarColour(app: LaunchedApp["app"], file: string): Promise<number[]> {
  const source = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().startsWith("atrium://app"))
      ?.getMediaSourceId(),
  );
  await promisify(execFile)("screencapture", ["-x", "-o", `-l${String(source?.split(":")[1])}`, file]);
  return app.evaluate(({ nativeImage }, path) => {
    const image = nativeImage.createFromPath(path);
    const scale = image.getSize().width / 1280;
    const [blue, green, red] = image
      .crop({ x: 20 * scale, y: 400 * scale, width: 200 * scale, height: 150 * scale })
      .resize({ width: 1, height: 1, quality: "best" })
      .toBitmap();
    return [red ?? -1, green ?? -1, blue ?? -1];
  }, file);
}

test("keeps the sidebar's material as it is when another window takes the focus", async () => {
  const dir = await createTempDir("material");
  // Behind another app, the window is inactive from the start and there is nothing to compare.
  await launched.app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0]?.focus();
  });
  await expect
    .poll(() => launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() !== null))
    .toBe(true);
  await launched.window.waitForTimeout(500);
  const focused = await sidebarColour(launched.app, join(dir.path, "focused.png"));

  await launched.app.evaluate(({ BrowserWindow }) => {
    new BrowserWindow({ x: 0, y: 0, width: 120, height: 120 }).focus();
  });
  await expect
    .poll(() => launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL()))
    .toBe("");
  await launched.window.waitForTimeout(500);
  const unfocused = await sidebarColour(launched.app, join(dir.path, "unfocused.png"));
  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.destroy());
  await dir.cleanup();

  // Inactive, the material would turn a flat grey; a capture is not exact to the last level.
  expect(Math.max(...unfocused.map((channel, at) => Math.abs(channel - Number(focused[at]))))).toBeLessThanOrEqual(2);
});

test("puts the traffic lights level with the tabs: 14pt buttons 12pt in and 17pt down, centred 24pt down", async () => {
  const position = await launched.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition(),
  );

  expect(position).toStrictEqual({ x: 12, y: 17 });
});

test("records the connection under one trace id and never logs the token", async () => {
  const { token } = await launched.window.evaluate(() => window.atrium.getBootstrap());

  const log = await launched.readHostLog();
  const connected = present(
    log.find((record) => record["msg"] === "client connected"),
    "a connect record",
  );
  const span = present(
    log.find((record) => record["name"] === "ws.connect"),
    "a ws.connect span",
  );

  expect(connected["trace_id"]).toMatch(/^[0-9a-f]{32}$/);
  expect(span["trace_id"]).toBe(connected["trace_id"]);
  expect(JSON.stringify(log)).not.toContain(token);
});

test("a second launch on the same home quits and brings the first window back", async () => {
  /**
   * Reads the first app's windows.
   *
   * @remarks
   * Both the count and visibility show what the second launch did to the first app; a hidden
   * window stands in for a minimized one, which the test machine's window server may not honour.
   *
   * @sideEffects none
   * @returns Whether each window is visible.
   */
  const windows = () =>
    launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.isVisible()));
  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
  await expect.poll(windows).toStrictEqual([false]);
  const electronPath = createRequire(import.meta.url)("electron") as string;

  const second = spawn(electronPath, ["."], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, ATRIUM_HOME: launched.home, ATRIUM_PI_LATEST_URL: "" },
    stdio: "ignore",
  });
  const code = await new Promise<number | null>((done) => second.once("exit", done));

  expect(code).toBe(0);
  await expect.poll(windows).toStrictEqual([true]);
  await expect(launched.window.getByRole("status")).toHaveText(/已连接宿主/);
});
