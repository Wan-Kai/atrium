import { expect, test } from "@playwright/test";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { send } from "./messages";

test("hands a chat to the terminal with its command, keeps it there across a restart, and takes it back", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "好的" }] }] });
  let launched = await launchApp(pi.env);
  const home = launched.home;
  try {
    let { window } = launched;
    const replies = () => window.locator('[data-testid="reply"][data-streaming="false"]');
    await send(window, "一");
    await expect(replies()).toHaveText(["好的"], { timeout: 30_000 });
    // The system clipboard is the developer's; the page's copy lands here instead.
    await window.evaluate(() => {
      navigator.clipboard.writeText = async (text) => sessionStorage.setItem("copied", text);
    });

    await window.getByRole("button", { name: "当前会话" }).click();
    await window.getByRole("menuitem", { name: "在终端中继续" }).click();
    const panel = () => window.getByRole("region", { name: "已在终端中继续" });
    await expect(panel()).toBeVisible({ timeout: 30_000 });
    const command = await panel().locator("code").textContent();
    expect(command).toMatch(/^pi --session '\/[^']+\.jsonl'$/);
    expect(await window.evaluate(() => sessionStorage.getItem("copied"))).toBe(command);
    await expect(window.getByRole("textbox", { name: "消息" })).toHaveCount(0);
    await launched.quit();

    launched = await launchApp(pi.env, home);
    window = launched.window;
    await expect(panel()).toBeVisible({ timeout: 30_000 });
    await expect(panel().locator("code")).toHaveText(String(command));
    await panel().getByRole("button", { name: "在 Atrium 里继续" }).click();

    await expect(panel()).toHaveCount(0, { timeout: 30_000 });
    await expect(replies()).toHaveText(["好的"], { timeout: 30_000 });
    await send(window, "二");
    // The pi started again answers from the start of its script.
    await expect(replies()).toHaveText(["好的", "好的"], { timeout: 30_000 });
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
