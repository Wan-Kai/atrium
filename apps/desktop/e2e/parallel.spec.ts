import { type Page, type WebSocketRoute, chromium, expect, test } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp, markSetupDone } from "./launch";
import { send, sentAs } from "./messages";

/** The page's connection to the host, which a test can cut and restore. */
interface Line {
  /** Drops every connection and refuses new ones, as a network outage would. */
  readonly cut: () => Promise<void>;
  /** Lets connections through again. */
  readonly restore: () => void;
}

/**
 * Routes the page's connections to the host through the test, and reloads it so they do.
 *
 * @remarks
 * The host and pi keep running while the page loses its connection, as when the network drops;
 * Playwright forwards every message unchanged until the line is cut.
 *
 * @sideEffects Routes the page's WebSockets; reloads the page and waits for it to connect.
 * @param window - The app's page.
 * @returns The line.
 */
async function routeLine(window: Page): Promise<Line> {
  const open = new Set<WebSocketRoute>();
  let down = false;
  await window.routeWebSocket(/.*/, (socket) => {
    if (down) {
      // Fire and forget: the page sees the attempt fail and tries again later.
      void socket.close();
      return;
    }
    socket.connectToServer();
    open.add(socket);
    socket.onClose(() => open.delete(socket));
  });
  await window.reload();
  await expect(window.getByRole("status")).toHaveText(/已连接宿主/, { timeout: 15_000 });
  return {
    cut: async () => {
      down = true;
      await Promise.all([...open].map((socket) => socket.close()));
    },
    restore: () => {
      down = false;
    },
  };
}

/**
 * How many of pi's session files hold this text.
 *
 * @remarks
 * Shows what pi wrote while the page could not see it.
 *
 * @sideEffects Reads pi's session files.
 * @param agentDir - pi's agent directory.
 * @param text - The text.
 * @returns The number of files.
 */
async function sessionFilesWith(agentDir: string, text: string): Promise<number> {
  const root = join(agentDir, "sessions");
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".jsonl"));
  const contents = await Promise.all(files.map((file) => readFile(join(root, file), "utf8")));
  return contents.filter((content) => content.includes(text)).length;
}

test("runs three chats at once in the background, through tab switches, a dropped connection and a host restart", async () => {
  const pi = await fauxPiEnvironment({
    replies: [
      { waitFor: "first", blocks: [{ type: "text", text: "做完了" }] },
      { waitFor: "second", blocks: [{ type: "text", text: "不会说到这里" }] },
    ],
  });
  let launched = await launchApp(pi.env);
  const home = launched.home;
  try {
    let { window } = launched;
    const line = await routeLine(window);
    const tabs = window.getByRole("tab");
    const running = tabs.getByRole("img", { name: "运行中" });
    await send(window, "一");
    await expect(running).toHaveCount(1, { timeout: 30_000 });
    for (const [text, count] of [
      ["二", 2],
      ["三", 3],
    ] as const) {
      await window.keyboard.press("Meta+T");
      await expect(tabs).toHaveCount(count);
      await send(window, text);
    }
    await expect(tabs).toHaveText(["一", "二", "三"]);
    await expect(running).toHaveCount(3, { timeout: 30_000 });

    // Each tab shows its own run, still going while the others are shown.
    for (const text of ["一", "二", "三"]) {
      await tabs.filter({ hasText: text }).click();
      await expect(window.getByTestId("user-message")).toHaveText([sentAs(text)]);
      await expect(window.getByRole("button", { name: "停止" })).toBeVisible();
    }

    await line.cut();
    await expect(window.getByRole("status")).toHaveText(/正在重连/);
    await pi.release("first");
    await expect.poll(() => sessionFilesWith(pi.agentDir, "做完了"), { timeout: 30_000 }).toBe(3);
    line.restore();

    await expect(window.getByRole("status")).toHaveText(/已连接宿主/, { timeout: 15_000 });
    await expect(running).toHaveCount(0, { timeout: 30_000 });
    for (const text of ["一", "二", "三"]) {
      await tabs.filter({ hasText: text }).click();
      await expect(window.getByTestId("user-message")).toHaveText([sentAs(text)]);
      await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["做完了"]);
    }

    // The third chat runs again as the host goes away; its run ends with it.
    await send(window, "再来");
    await expect(running).toHaveCount(1, { timeout: 30_000 });
    await launched.quit();

    launched = await launchApp(pi.env, home);
    window = launched.window;
    const restored = window.getByRole("tab");
    await expect(restored).toHaveText(["一", "二", "三"], { timeout: 30_000 });
    await expect(window.getByRole("tab", { selected: true })).toHaveText("三");
    await expect(window.getByTestId("user-message")).toHaveText([sentAs("三"), sentAs("再来")], { timeout: 30_000 });
    await expect(window.getByTestId("turn").last()).toContainText("已停止");
    await expect(restored.getByRole("img", { name: "运行中" })).toHaveCount(0);
    for (const text of ["一", "二"]) {
      await restored.filter({ hasText: text }).click();
      await expect(window.getByTestId("user-message")).toHaveText([sentAs(text)], { timeout: 30_000 });
      await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["做完了"]);
    }
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

const repo = join(import.meta.dirname, "..", "..", "..");

/** A port free on loopback now, for a host started again to listen on the same one. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

/**
 * The built host run without Electron, which a test stops and starts again under a page that stays.
 *
 * @remarks
 * The desktop app never starts its host again; a host run on its own does, on the same home, port
 * and token, as when its operator restarts it. The token goes to the host as `ATRIUM_TOKEN`, which
 * only a host run on its own reads (security.md, "WebSocket 与鉴权").
 *
 * @sideEffects Creates a home directory, first launch done; `start` spawns the host, `stop` ends exactly that process.
 * @param env - pi's environment.
 * @returns The host's address and token, what it logged, and how to start, stop and clean it up.
 */
async function standaloneHost(env: Record<string, string>) {
  const home = await mkdtemp(join(tmpdir(), "atrium-e2e-"));
  await markSetupDone(home);
  const port = await freePort();
  const token = randomBytes(32).toString("base64url");
  let child: ChildProcess | null = null;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    /** How many times the host started a chat's pi, from its log. */
    chatPiStarts: async () =>
      (await readFile(join(home, "logs", "current.log"), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        // Not the short-lived pi the model list asks, which runs in Atrium's own directory.
        .filter((line) => line["msg"] === "pi started" && String(line["cwd"]).includes(`${sep}chats${sep}`)).length,
    start: async () => {
      const started = spawn(process.execPath, [join(repo, "packages", "host", "dist", "entry.cjs")], {
        env: {
          ...process.env,
          ...env,
          ATRIUM_HOME: home,
          ATRIUM_PI_LATEST_URL: "",
          ATRIUM_PORT: String(port),
          ATRIUM_TOKEN: token,
          ATRIUM_UI_DIR: join(repo, "packages", "ui", "dist"),
        },
        stdio: ["ignore", "pipe", "inherit"],
      });
      child = started;
      let out = "";
      await new Promise<void>((ready, failed) => {
        started.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes('"type":"ready"')) ready();
        });
        started.once("exit", (code) => failed(new Error(`host exited with ${code}`)));
      });
    },
    stop: async () => {
      const running = child;
      child = null;
      if (running === null || running.exitCode !== null) return;
      const exited = new Promise((done) => running.once("exit", done));
      running.kill("SIGTERM");
      await exited;
    },
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

test("opens the chat shown again when its host restarts under a page that stays, and goes on", async () => {
  const pi = await fauxPiEnvironment({
    replies: [{ blocks: [{ type: "text", text: "做完了" }] }],
  });
  const host = await standaloneHost(pi.env);
  const browser = await chromium.launch();
  try {
    await host.start();
    const page = await browser.newPage();
    // The page's bridge, as the desktop preload gives it: the address and token, never in the URL.
    await page.addInitScript(
      ({ hostUrl, token }) => {
        window.atrium = { getBootstrap: async () => ({ hostUrl, token }) };
      },
      { hostUrl: host.url, token: host.token },
    );
    await page.goto(`${host.url}/`);
    await expect(page.getByRole("status")).toHaveText(/已连接宿主/, { timeout: 15_000 });
    await send(page, "一");
    await expect(page.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["做完了"], {
      timeout: 30_000,
    });

    const started = await host.chatPiStarts();
    await host.stop();
    await expect(page.getByRole("status")).toHaveText(/正在重连/);
    await host.start();

    // The chat's pi starts again with no message sent: the page opened the chat on the new host.
    await expect(page.getByRole("status")).toHaveText(/已连接宿主/, { timeout: 15_000 });
    await expect.poll(() => host.chatPiStarts(), { timeout: 30_000 }).toBe(started + 1);
    await expect(page.getByRole("tab", { selected: true })).toHaveText("一");
    await expect(page.getByTestId("user-message")).toHaveText([sentAs("一")]);
    await send(page, "二");
    await expect(page.getByTestId("user-message")).toHaveText([sentAs("一"), sentAs("二")], { timeout: 30_000 });
    await expect(page.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["做完了", "做完了"], {
      timeout: 30_000,
    });
  } finally {
    await browser.close();
    await host.stop();
    await host.cleanup();
    await pi.cleanup();
  }
});
