import { expect, test } from "@playwright/test";
import { present } from "@atrium/testkit";
import { type LaunchedApp, launchApp } from "./launch";

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.close();
});

test("opens a window on the host-served UI, protected by the content security policy", async () => {
  const csp = await launched.window.evaluate(async () =>
    (await fetch(location.href)).headers.get("content-security-policy"),
  );

  expect(new URL(launched.window.url()).hostname).toBe("127.0.0.1");
  expect(csp).toContain("script-src 'self'");
});

test("gives the page no Node access and only the bootstrap bridge", async () => {
  const exposed = await launched.window.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    bridge: Object.keys(window.atrium),
  }));

  expect(exposed).toStrictEqual({ require: "undefined", process: "undefined", bridge: ["getBootstrap"] });
});

test("keeps the page on its own origin and refuses new windows", async () => {
  const before = launched.window.url();

  const opened = await launched.window.evaluate(() => window.open("https://example.com") === null);
  await launched.window.evaluate(() => {
    location.href = "https://example.com/";
  });

  expect(opened).toBe(true);
  await expect.poll(() => launched.window.url()).toBe(before);
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
