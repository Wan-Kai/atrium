import { expect, test } from "@playwright/test";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";

test("shows the session's figures under the input box after a reply, with the context split, and keeps the groups chosen", async () => {
  const pi = await fauxPiEnvironment({
    replies: [
      { blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf ok" } }] },
      { blocks: [{ type: "text", text: "好的" }] },
    ],
  });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    const box = window.getByRole("textbox", { name: "消息" });
    await box.fill("一");
    await box.press("Enter");
    await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["好的"], {
      timeout: 30_000,
    });

    const bar = window.getByRole("group", { name: "状态栏" });
    // pi counts one message and one tool call; the faux model reports tokens, with some cached.
    await expect(bar.getByRole("button", { name: /^1 轮 1 步/ })).toBeVisible({ timeout: 30_000 });
    await expect(bar.getByRole("button", { name: /tok · 缓存命中 \d+%$/ })).toBeVisible();
    const context = bar.getByRole("button", { name: /^\d+%$/ });
    await expect(context).toBeVisible();
    await context.hover();
    // The split comes from the system prompt and tools pi wrote into the session.
    const card = window.getByRole("tooltip").filter({ hasText: "上下文已用" });
    await expect(card).toContainText("系统提示词");
    await expect(card).toContainText("工具定义");

    await bar.getByRole("button", { name: "自定义状态栏" }).click();
    await window.getByRole("switch", { name: "费用" }).click();
    await expect(bar.getByRole("button", { name: /^≈ \$/ })).toBeVisible();
    await window.keyboard.press("Escape");

    // The choice is global: a new chat shows the cost too, once it has figures.
    await window.keyboard.press("Meta+N");
    await box.fill("二");
    await box.press("Enter");
    await expect(window.getByRole("group", { name: "状态栏" }).getByRole("button", { name: /^≈ \$/ })).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
