import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { send } from "./messages";

test("renames a session on its tab through pi, which writes the name to the session's file, kept across a restart", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "好的" }] }] });
  let launched = await launchApp(pi.env);
  const home = launched.home;
  try {
    let { window } = launched;
    await send(window, "一");
    await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["好的"], {
      timeout: 30_000,
    });
    // The system clipboard is the developer's; the page's copy lands here instead.
    await window.evaluate(() => {
      navigator.clipboard.writeText = async (text) => sessionStorage.setItem("copied", text);
    });
    await window.getByRole("button", { name: "当前会话" }).click();
    await window.getByRole("menuitem", { name: "复制会话文件路径" }).click();
    await expect.poll(() => window.evaluate(() => sessionStorage.getItem("copied"))).toMatch(/\.jsonl$/);
    const file = String(await window.evaluate(() => sessionStorage.getItem("copied")));

    await window.getByRole("button", { name: "当前会话" }).click();
    await window.getByRole("menuitem", { name: "重命名" }).click();
    const field = window.getByRole("tab", { selected: true }).getByRole("textbox", { name: "会话名称" });
    await field.fill("重构宿主");
    await field.press("Enter");

    await expect(window.getByRole("tab", { selected: true })).toHaveText("重构宿主", { timeout: 30_000 });
    const lines = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ type: "session_info", name: "重构宿主" });
    await launched.quit();

    launched = await launchApp(pi.env, home);
    window = launched.window;
    await expect(window.getByRole("tab", { selected: true })).toHaveText("重构宿主", { timeout: 30_000 });
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
