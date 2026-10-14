import { expect, test } from "@playwright/test";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { send } from "./messages";
import { focusWindow } from "./projects";

test("puts a chat that failed in the background into the inbox until it is looked at, and keeps its icon", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ waitFor: "fail", blocks: [], error: "模型出错了" }] });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    const tabs = window.getByRole("tab");
    await send(window, "一");
    await expect(tabs.getByRole("img", { name: "运行中" })).toHaveCount(1, { timeout: 30_000 });
    await window.keyboard.press("Meta+T");
    await expect(tabs).toHaveText(["一", "新会话"]);
    await pi.release("fail");

    const inbox = window.getByRole("region", { name: "等你处理" });
    const rows = inbox.getByTestId("inbox-row");
    // Folded at first into its heading, with the count and the status.
    const heading = inbox.getByRole("button", { name: /^等你处理/ });
    await expect(heading).toHaveText("等你处理1", { timeout: 30_000 });
    await expect(heading.getByRole("img", { name: "出错" })).toBeVisible();
    await heading.click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("一");
    await expect(rows.getByRole("img", { name: "出错" })).toBeVisible();
    await expect(tabs.filter({ hasText: "一" }).getByRole("img", { name: "出错" })).toBeVisible();

    await rows.click();
    await focusWindow(window);
    await expect(window.getByRole("tab", { selected: true })).toHaveText("一");
    await expect(inbox).toHaveCount(0);
    // Seen, the error leaves the inbox but keeps its icon until the next run starts.
    await expect(tabs.filter({ hasText: "一" }).getByRole("img", { name: "出错" })).toBeVisible();
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
