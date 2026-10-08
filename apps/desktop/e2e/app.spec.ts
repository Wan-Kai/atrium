import { expect, test } from "@playwright/test";
import { present } from "@atrium/testkit";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
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

test("gives the page no Node access and only the bridge: bootstrap, folder choice and appearance", async () => {
  const exposed = await launched.window.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    bridge: Object.keys(window.atrium),
  }));

  expect(exposed).toStrictEqual({
    require: "undefined",
    process: "undefined",
    bridge: ["getBootstrap", "pickDirectory", "setAppearance"],
  });
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
    env: { ...process.env, ATRIUM_HOME: launched.home },
    stdio: "ignore",
  });
  const code = await new Promise<number | null>((done) => second.once("exit", done));

  expect(code).toBe(0);
  await expect.poll(windows).toStrictEqual([true]);
  await expect(launched.window.getByRole("status")).toHaveText(/已连接宿主/);
});
