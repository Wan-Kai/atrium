import { expect, test } from "@playwright/test";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";

test("sends a message and streams the reply, reasoning first, until the run settles", async () => {
  const pi = await fauxPiEnvironment({
    replies: [
      {
        blocks: [
          { type: "thinking", text: "先想一想怎么回答。" },
          { type: "text", text: "## 你好\n\n这是 **faux** 的回复，带一个列表：\n\n- 一\n- 二" },
        ],
      },
    ],
  });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    await window.getByRole("textbox", { name: "消息" }).fill("你好");
    await window.getByRole("textbox", { name: "消息" }).press("Enter");

    await expect(window.getByTestId("user-message")).toHaveCount(1, { timeout: 30_000 });
    await expect(window.getByTestId("user-message")).toContainText("你好");
    const reply = window.locator('[data-testid="reply"][data-streaming="false"]');
    await expect(reply).toContainText("这是 faux 的回复，带一个列表：", { timeout: 30_000 });
    await expect(reply.locator("h2")).toHaveText("你好");
    await expect(reply.locator("li")).toHaveText(["一", "二"]);
    // Thinking was timed live, so its header says how long it took; the turn finished in view, so
    // its process stays open a second, then folds.
    const header = window.getByTestId("process-header");
    await expect(header).toHaveText(/^思考了 \d+ 秒$/);
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(window.getByTestId("step")).toHaveCount(0);
    await header.click();
    await window.getByTestId("step").getByRole("button").click();
    await expect(window.getByTestId("step-detail")).toHaveText("先想一想怎么回答。");
    await expect(window.getByTestId("run-status")).toHaveCount(0);
    await expect(window.locator('[data-testid="user-message"][data-pending="true"]')).toHaveCount(0);
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

test("shows tools without blank thinking and leaves a normal empty end without a reply", async () => {
  const testInfo = test.info();
  const pi = await fauxPiEnvironment({
    replies: [
      {
        blocks: [
          { type: "thinking", text: " \n" },
          { type: "toolCall", id: "empty-thinking-tool", name: "bash", arguments: { command: "printf ok" } },
        ],
      },
      {
        blocks: [
          { type: "thinking", text: "" },
          { type: "text", text: "" },
        ],
      },
      {
        blocks: [
          { type: "thinking", text: " \n" },
          { type: "text", text: " \t" },
        ],
      },
    ],
  });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    const input = window.getByRole("textbox", { name: "消息" });
    await input.fill("运行命令");
    await input.press("Enter");
    const first = window.getByTestId("turn").first();
    await expect(first).toHaveAttribute("data-outcome", "done", { timeout: 30_000 });
    await expect(first.getByTestId("process-header")).toHaveAttribute("aria-expanded", "false");
    await first.getByTestId("process-header").click();
    await expect(first.locator('[data-testid="step"][data-kind="tool"]')).toHaveCount(1);
    await expect(first.locator('[data-testid="step"][data-kind="thinking"]')).toHaveCount(0);
    await expect(first.getByTestId("reply")).toHaveCount(0);
    await first.getByRole("button", { name: /运行了 printf ok/ }).click();
    await expect(first.getByTestId("step-detail")).toContainText("ok");

    await input.fill("正常空结束");
    await input.press("Enter");
    await expect(window.getByTestId("turn")).toHaveCount(2);
    const second = window.getByTestId("turn").nth(1);
    await expect(second).toHaveAttribute("data-outcome", "done", { timeout: 30_000 });
    await expect(second.getByTestId("user-message")).toContainText("正常空结束");
    await expect(second.getByTestId("process-header")).toHaveCount(0);
    await expect(second.getByTestId("reply")).toHaveCount(0);
    await expect(second.getByTestId("turn-footer")).toHaveCount(0);
    await expect(window.getByTestId("turn-error")).toHaveCount(0);
    await expect(window.getByTestId("run-status")).toHaveCount(0);
    for (const theme of ["light", "dark"] as const) {
      await launched.app.evaluate(({ nativeTheme }, source) => {
        nativeTheme.themeSource = source;
      }, theme);
      await expect
        .poll(() => window.locator("html").evaluate((root) => root.classList.contains("dark")))
        .toBe(theme === "dark");
      await window.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => undefined)),
        );
      });
      await window.screenshot({ path: testInfo.outputPath(`empty-response-${theme}.png`) });
    }
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

test("names a chat with the model once its first run ends", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "pong" }] }], title: "乒乓测试" });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    await window.getByRole("textbox", { name: "消息" }).fill("ping");
    await window.getByRole("textbox", { name: "消息" }).press("Enter");

    await expect(window.getByTestId("reply")).toHaveText("pong", { timeout: 30_000 });
    await expect(window.getByRole("tab")).toHaveText(["乒乓测试"], { timeout: 30_000 });
    await window.getByRole("button", { name: "历史" }).click();
    await expect(window.getByRole("menuitem")).toHaveText([/^乒乓测试已打开/]);
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
