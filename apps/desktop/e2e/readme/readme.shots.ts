import { type Page, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDemo, capture, launchShotsApp, startBackend } from "./app";
import { makeDemo } from "./demo";
import { providers } from "./providers";
import { ASK, CHILDREN, MAIN } from "./story";

/** Where the README's images live. */
const IMAGES = join(import.meta.dirname, "../../../../docs/images");

/**
 * Takes the focus from whatever has it.
 *
 * @remarks
 * A focus ring on a button or the message box would show in the screenshot.
 *
 * @sideEffects Blurs the page's focused element.
 * @param window - The window.
 */
async function blur(window: Page): Promise<void> {
  await window.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

/**
 * Scrolls the conversation to its end.
 *
 * @remarks
 * The hero shows the whole turn down to the summary, above the composer.
 *
 * @sideEffects Scrolls the message list.
 * @param window - The window.
 */
async function toBottom(window: Page): Promise<void> {
  await window
    .getByTestId("user-message")
    .first()
    .evaluate((bubble) => {
      let scroller: HTMLElement | null = bubble.parentElement;
      while (scroller !== null && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement;
      if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
    });
}

/**
 * Moves the mouse out of the way and waits for animations to finish.
 *
 * @remarks
 * A hover state or a half-done transition would show in the screenshot.
 *
 * @sideEffects Moves the mouse; waits.
 * @param window - The window.
 * @param ms - How long to wait.
 */
async function settle(window: Page, ms = 1200): Promise<void> {
  await window.mouse.move(5, 600);
  await window.waitForTimeout(ms);
}

/**
 * Waits until a number of seconds after a moment.
 *
 * @remarks
 * The story releases each scripted reply at a fixed time after the message is sent, so the
 * children's durations in the screenshots are the same on every run.
 *
 * @sideEffects Waits.
 * @param window - The window.
 * @param since - The moment, in milliseconds since the epoch.
 * @param seconds - How long after it.
 */
async function waitUntil(window: Page, since: number, seconds: number): Promise<void> {
  const wait = since + seconds * 1000 - Date.now();
  if (wait > 0) await window.waitForTimeout(wait);
}

/**
 * Opens a session tab on the selected workspace, unless one is open.
 *
 * @remarks
 * A workspace opens on its last session's tab, or on none when it has no sessions yet.
 *
 * @sideEffects May open a tab.
 * @param window - The window.
 */
async function ensureTab(window: Page): Promise<void> {
  if ((await window.getByRole("tab").count()) === 0) await window.keyboard.press("Meta+T");
  await expect(window.getByRole("tab")).toHaveCount(1, { timeout: 30_000 });
}

/**
 * Expands the last turn's process, unless it is expanded.
 *
 * @remarks
 * The hero shows the steps of the turn with the children's lines.
 *
 * @sideEffects May click the process header.
 * @param window - The window.
 */
async function expandLastProcess(window: Page): Promise<void> {
  const header = window.getByTestId("process-header").last();
  if ((await header.getAttribute("aria-expanded")) === "false") await header.click();
}

test("readme screenshots", async () => {
  const run = await mkdtemp(join(tmpdir(), "atrium-readme-"));
  const repo = makeDemo(await mkdtemp(join(run, "demo-")));
  const backend = await startBackend();
  const started = Date.now();
  const { app, window, release } = await launchShotsApp(
    run,
    {
      providers: providers(backend.baseUrl),
      replies: MAIN,
      children: CHILDREN,
      title: "逐小时预报、缓存和错误处理",
      branch: "city-search-pinyin",
      tokensPerSecond: 120,
    },
    "system",
  );
  /**
   * Captures the window into the README's images.
   *
   * @remarks
   * Every screenshot goes the same way.
   *
   * @sideEffects Writes the image; may bring the window to the front.
   * @param name - The image's file name.
   */
  const shot = (name: string): Promise<void> => capture(app, run, join(IMAGES, name));
  try {
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
    await addDemo(app, window, repo);
    await window.getByTestId("workspace-row").first().click();
    await window.waitForTimeout(1500);
    await ensureTab(window);
    const box = window.getByRole("textbox", { name: "消息" });
    await box.fill(ASK);
    await box.press("Enter");

    // The children list while one child asks and the others work. The question goes first, so it
    // is the notice the main agent's turn takes in once `main-look` lets it on.
    const sent = Date.now();
    await waitUntil(window, sent, 34);
    release("audit-ask");
    await waitUntil(window, sent, 41);
    release("review-done");
    const capsule = window.getByRole("button", { name: /^子对话 3/ });
    await expect(capsule).toBeVisible({ timeout: 30_000 });
    await window.waitForTimeout(4000);
    await capsule.click();
    await settle(window);
    await shot("children-light.png");
    await window.keyboard.press("Escape");
    await blur(window);

    release("main-look");
    release("answer");
    await waitUntil(window, sent, 56);
    release("audit-done");
    await waitUntil(window, sent, 70);
    release("hourly-go");
    await waitUntil(window, sent, 129);
    release("hourly-done");
    // Both notices on their way before the main agent's turn goes on.
    await waitUntil(window, sent, 137);
    release("main-rest");

    // The finished turn with the right panel on the main workspace's changes, light and dark.
    await expect(window.getByTestId("reply").last()).toContainText("要不要我接着补上", {
      timeout: 120_000,
    });
    await window.waitForTimeout(8000);
    await blur(window);
    await expandLastProcess(window);
    await window.getByRole("button", { name: "查看改动" }).click();
    const panel = window.getByRole("complementary", { name: "文件与更改" });
    await expect(panel.getByTestId("changes-tree").getByRole("button").first()).toBeVisible({ timeout: 30_000 });
    await blur(window);
    await settle(window, 1500);
    await toBottom(window);
    await settle(window, 1500);
    await shot("workbench-light.png");
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await settle(window, 2000);
    await shot("workbench-dark.png");
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
    await settle(window, 2000);

    // The changes of src/cache.ts in a tab of their own.
    await panel
      .getByTestId("changes-tree")
      .getByRole("button", { name: /cache\.ts/ })
      .click();
    await expect(window.getByRole("region", { name: "改动" })).toBeVisible({ timeout: 30_000 });
    await blur(window);
    await settle(window, 2000);
    await shot("changes-light.png");
    await window.keyboard.press("Meta+W");
    await expect(window.getByRole("tab", { name: /改动/ })).toHaveCount(0);
    await panel.getByRole("button", { name: "关闭右栏" }).click();
    await settle(window, 1500);

    // The model panel, on ChatGPT's subscription while the session is on Claude's.
    await window.getByRole("button", { name: /^模型与推理强度/ }).click();
    await window.waitForTimeout(800);
    await window.getByRole("tab", { name: /ChatGPT 订阅/ }).click();
    await settle(window, 1500);
    await shot("model-panel-light.png");
    await window.keyboard.press("Escape");
    await settle(window, 1000);

    // A new workspace with its first message written.
    const project = window.getByTestId("project-row");
    await project.hover();
    await project.getByRole("button", { name: "在 weather-app 新建工作区" }).click();
    await expect(window.getByRole("button", { name: "起点", exact: true })).toHaveText("基于 origin/main", {
      timeout: 30_000,
    });
    await window.getByRole("textbox", { name: "消息" }).fill("城市搜索支持拼音，输入 hz 也能找到杭州");
    await project.hover();
    await window.waitForTimeout(1500);
    await shot("new-workspace-light.png");
    console.log(`story took ${Math.round((Date.now() - started) / 1000)} s`);
  } finally {
    await app.close();
    await backend.close();
    await rm(run, { recursive: true, force: true });
  }
});
