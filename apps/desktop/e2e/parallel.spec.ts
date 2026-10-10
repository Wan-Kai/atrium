import { type Page, type WebSocketRoute, expect, test } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
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
