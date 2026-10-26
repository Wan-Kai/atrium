import { present } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";

const ORIGINAL = "The request owns cancellation. Keep `api.ts` unchanged.";
const ORIGINAL_VIEW = "The request owns cancellation. Keep api.ts unchanged.";
const TRANSLATED = "请求负责取消。保持 `api.ts` 不变。";

test("translates below the original reply, saves only the language, and forgets the translation after restart", async ({
  browserName: _browserName,
}, info) => {
  const pi = await fauxPiEnvironment({
    replies: [{ blocks: [{ type: "text", text: ORIGINAL }] }],
    title: "Translation example",
    translation: TRANSLATED,
  });
  let launched = await launchApp(pi.env);
  const home = launched.home;
  try {
    let { window } = launched;
    await window.getByRole("textbox", { name: "消息", exact: true }).fill("Explain cancellation.");
    await window.getByRole("button", { name: "发送", exact: true }).click();
    const original = window.getByTestId("reply");
    await expect(original).toHaveText(ORIGINAL_VIEW, { timeout: 30_000 });
    const translate = window.getByRole("button", { name: "翻译回复", exact: true });
    await expect(translate).toBeVisible();
    await expect(window.getByRole("tab")).toHaveText(["Translation example"], { timeout: 30_000 });
    const files = (await readdir(join(pi.agentDir, "sessions"), { recursive: true })).filter((file) =>
      file.endsWith(".jsonl"),
    );
    expect(files).toHaveLength(1);
    const sessionFile = join(pi.agentDir, "sessions", present(files[0], "the original session file"));
    const before = await readFile(sessionFile, "utf8");
    await translate.click();
    const translation = window.getByTestId("reply-translation");
    await expect(translation).toContainText("请求负责取消。保持 api.ts 不变。", { timeout: 30_000 });
    await expect(translation).toContainText("简体中文");
    await expect(translation).toContainText("faux-1");
    await expect(original).toHaveText(ORIGINAL_VIEW);
    await expect(window.getByTestId("turn")).toHaveCount(1);
    expect(await readFile(sessionFile, "utf8")).toBe(before);
    await window.getByRole("button", { name: "收起译文", exact: true }).click();
    await expect(translation).toHaveCount(0);
    await translate.click();
    await expect(translation).toContainText("请求负责取消。");
    for (const appearance of ["light", "dark"] as const) {
      await launched.app.evaluate(({ nativeTheme }, chosen) => {
        nativeTheme.themeSource = chosen;
      }, appearance);
      await expect
        .poll(() => window.locator("html").evaluate((node) => node.classList.contains("dark")))
        .toBe(appearance === "dark");
      await window.screenshot({ path: info.outputPath(`reply-translation-${appearance}.png`) });
    }

    await window.keyboard.press("Meta+,");
    const settings = window.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "模型与账户", exact: true }).click();
    await settings.getByRole("textbox", { name: "翻译目标语言", exact: true }).fill("日本語");
    await settings.getByRole("button", { name: "保存翻译语言", exact: true }).click();
    await expect(settings.getByRole("region", { name: "回复翻译", exact: true })).toContainText("已保存");
    await window.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(translation).toHaveCount(0);
    await translate.click();
    await expect(translation).toContainText("日本語", { timeout: 30_000 });
    // The faux translation is fixed; this asserts request language, not linguistic quality.
    const preferences = await readFile(join(home, "preferences.json"), "utf8");
    expect(JSON.parse(preferences)).toMatchObject({ translationLanguage: "日本語" });
    expect(preferences).not.toContain("请求负责取消");
    expect(await readFile(sessionFile, "utf8")).toBe(before);
    const logs = JSON.stringify(await launched.readHostLog());
    expect(logs).not.toContain("请求负责取消");
    expect(logs).not.toContain(ORIGINAL);

    await launched.quit();
    launched = await launchApp(pi.env, home);
    window = launched.window;
    await expect(window.getByTestId("reply")).toHaveText(ORIGINAL_VIEW, { timeout: 30_000 });
    await expect(window.getByTestId("reply-translation")).toHaveCount(0);
    await window.keyboard.press("Meta+,");
    const reopenedSettings = window.getByRole("dialog", { name: "设置", exact: true });
    await reopenedSettings.getByRole("button", { name: "模型与账户", exact: true }).click();
    await expect(reopenedSettings.getByRole("textbox", { name: "翻译目标语言", exact: true })).toHaveValue("日本語");
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
