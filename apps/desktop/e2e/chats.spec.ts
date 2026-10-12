import { expect, test } from "@playwright/test";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { send, sentAs } from "./messages";

test("keeps each chat to itself, with its own sessions as tabs, across a restart", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "好的" }] }] });
  let launched = await launchApp(pi.env);
  const home = launched.home;
  try {
    let { window } = launched;
    const replies = window.locator('[data-testid="reply"][data-streaming="false"]');
    await send(window, "第一个对话");
    await expect(replies).toHaveText(["好的"], { timeout: 30_000 });
    // ⌘T adds a session to the chat the window is in.
    await window.keyboard.press("Meta+T");
    await expect(window.getByRole("tab")).toHaveText(["第一个对话", "新会话"], { timeout: 30_000 });
    await send(window, "同一个对话里");
    await expect(replies).toHaveText(["好的"], { timeout: 30_000 });
    // The chat's active tab is not its latest session, which coming back must not change.
    await window.getByRole("tab", { name: /第一个对话/ }).click();

    // ⌘N starts a chat of its own, which shows none of the first chat's tabs.
    await window.keyboard.press("Meta+N");
    await expect(window.getByRole("tab")).toHaveText(["新会话"], { timeout: 30_000 });
    await send(window, "第二个对话");
    await expect(replies).toHaveText(["好的"], { timeout: 30_000 });
    const rows = window.getByRole("region", { name: "对话" }).getByTestId("chat-row");
    await expect(rows).toHaveText([/^第二个对话/, /^第一个对话/], { timeout: 30_000 });
    await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");

    await rows.nth(1).click();
    await expect(window.getByRole("tab")).toHaveText(["第一个对话", "同一个对话里"]);
    await expect(window.getByRole("tab", { selected: true })).toHaveText("第一个对话");
    await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
    await launched.quit();

    launched = await launchApp(pi.env, home);
    window = launched.window;
    const restored = window.getByRole("region", { name: "对话" }).getByTestId("chat-row");
    await expect(restored).toHaveText([/^第二个对话/, /^第一个对话/], { timeout: 30_000 });
    await expect(window.getByRole("tab")).toHaveText(["第一个对话", "同一个对话里"], { timeout: 30_000 });
    await restored.nth(0).click();
    await expect(window.getByRole("tab")).toHaveText(["第二个对话"]);
    await expect(window.getByTestId("user-message")).toHaveText([sentAs("第二个对话")], { timeout: 30_000 });
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

test("archives a chat with its sessions and restores it from 已归档的对话, across a restart", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "好的" }] }] });
  let launched = await launchApp(pi.env);
  const home = launched.home;
  try {
    let { window } = launched;
    const replies = window.locator('[data-testid="reply"][data-streaming="false"]');
    await send(window, "要归档的对话");
    await expect(replies).toHaveText(["好的"], { timeout: 30_000 });
    await window.keyboard.press("Meta+T");
    await expect(window.getByRole("tab")).toHaveText(["要归档的对话", "新会话"], { timeout: 30_000 });
    await send(window, "它的第二个会话");
    await expect(replies).toHaveText(["好的"], { timeout: 30_000 });
    await window.keyboard.press("Meta+N");
    await expect(window.getByRole("tab")).toHaveText(["新会话"], { timeout: 30_000 });
    await send(window, "留下的对话");
    await expect(replies).toHaveText(["好的"], { timeout: 30_000 });
    const section = window.getByRole("region", { name: "对话" });
    const rows = section.getByTestId("chat-row");
    await expect(rows).toHaveText([/^留下的对话/, /^要归档的对话/], { timeout: 30_000 });

    await rows.nth(1).hover();
    await rows.nth(1).getByRole("button", { name: "对话 要归档的对话" }).click();
    await window.getByRole("menuitem", { name: "归档" }).click();

    await expect(rows).toHaveText([/^留下的对话/], { timeout: 30_000 });
    await launched.quit();

    launched = await launchApp(pi.env, home);
    window = launched.window;
    const restarted = window.getByRole("region", { name: "对话" });
    await expect(restarted.getByTestId("chat-row")).toHaveText([/^留下的对话/], { timeout: 30_000 });
    await restarted.getByRole("button", { name: "已归档的对话" }).click();
    await expect(restarted.getByRole("list", { name: "已归档的对话" })).toHaveText(/^要归档的对话/);
    await restarted.getByRole("button", { name: "恢复 要归档的对话" }).click();

    await expect(restarted.getByTestId("chat-row")).toHaveText([/^留下的对话/, /^要归档的对话/], { timeout: 30_000 });
    await expect(restarted.getByRole("button", { name: "已归档的对话" })).toHaveCount(0);
    await restarted.getByTestId("chat-row").nth(1).click();
    await expect(window.getByRole("tab")).toHaveText(["它的第二个会话"], { timeout: 30_000 });
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
