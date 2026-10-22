import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";

test("switches the model and thinking level beside the input box, and a new chat starts on them", async () => {
  const pi = await fauxPiEnvironment({
    // Each pi, the new chat's too, answers from the first reply on.
    replies: [{ blocks: [{ type: "text", text: "好的" }] }],
    models: [{ id: "faux-deep", name: "Faux Deep", reasoning: true, thinkingLevelMap: { max: "max" } }],
  });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    const chip = window.getByRole("button", { name: /^模型与推理强度/ });
    // Before any session, pi's own pick; the faux provider has no icon, so its first letter shows.
    await expect(chip).toHaveText("Ffaux-1", { timeout: 30_000 });

    const box = window.getByRole("textbox", { name: "消息" });
    await box.fill("一");
    await box.press("Enter");
    await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["好的"], {
      timeout: 30_000,
    });
    await expect(chip).toHaveText("Ffaux-1中");

    await chip.click();
    await window.getByRole("menuitemradio", { name: /Faux Deep/ }).click();
    await expect(chip).toHaveText("FFaux Deep中");
    await window.keyboard.press("Meta+Shift+E");
    await expect(window.getByRole("slider", { name: "推理强度" })).toBeFocused();
    await window.keyboard.press("ArrowRight");
    await window.keyboard.press("ArrowRight");
    await expect(chip).toHaveText("FFaux Deep最高");
    await expect(chip).toHaveAttribute("data-full", "");
    await window.keyboard.press("Escape");

    // A new chat starts on the model and level chosen last.
    await window.keyboard.press("Meta+N");
    // The model chip also matches the previous chat; wait for the new conversation before typing.
    await expect(window.getByRole("region", { name: "对话" }).getByTestId("chat-row")).toHaveCount(2);
    await expect(window.getByTestId("user-message")).toHaveCount(0);
    await expect(chip).toHaveText("FFaux Deep最高", { timeout: 30_000 });
    await box.fill("二");
    await box.press("Enter");
    await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["好的"], {
      timeout: 30_000,
    });
    await expect(chip).toHaveText("FFaux Deep最高");
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

test("hides non-plan Claude and clears its default from the model picker", async () => {
  const testInfo = test.info();
  const pi = await fauxPiEnvironment({
    provider: "anthropic",
    replies: [{ blocks: [{ type: "text", text: "好的" }] }],
    models: [{ id: "native-claude", name: "Native Claude", reasoning: true }],
  });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    const chip = window.getByRole("button", { name: /^模型与推理强度/ });
    await expect(chip).toHaveText("选择模型", { timeout: 30_000 });
    await chip.click();
    await expect(window.getByText("没有可用的模型，先在 pi 里登录一个服务商")).toBeVisible({ timeout: 30_000 });
    await expect(window.getByRole("tab", { name: "Anthropic", exact: true })).toHaveCount(0);
    await expect(window.getByRole("menuitemradio")).toHaveCount(0);
    for (const colorScheme of ["light", "dark"] as const) {
      await window.emulateMedia({ colorScheme });
      await window.screenshot({ path: testInfo.outputPath(`native-claude-${colorScheme}.png`) });
    }
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

test("renders Friday branding for sankuai-openai", async () => {
  const icon = await readFile(new URL("../../../packages/ui/src/design/brand/friday.png", import.meta.url));
  const source = `data:image/png;base64,${icon.toString("base64")}`;
  const pi = await fauxPiEnvironment({ provider: "sankuai-openai", replies: [] });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    const chip = window.getByRole("button", { name: /^模型与推理强度/ });
    await expect(chip).toHaveText("faux-1", { timeout: 30_000 });
    await expect(chip.locator("img")).toHaveAttribute("src", source);
    await expect.poll(() => chip.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(80);
    await chip.click();
    const tab = window.getByRole("tab", { name: "Friday", exact: true });
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab.locator("img")).toHaveAttribute("src", source);
    await expect(window.getByRole("tabpanel", { name: "Friday" })).toBeVisible();
    for (const colorScheme of ["light", "dark"] as const) {
      await window.emulateMedia({ colorScheme });
      await window.screenshot({ path: test.info().outputPath(`friday-${colorScheme}.png`) });
    }
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

test("renders the supplied CatPaw icon in the model button and provider list", async () => {
  const testInfo = test.info();
  const pi = await fauxPiEnvironment({
    provider: "catpaw-cli",
    replies: [],
    models: [{ id: "gemini-4-argon", name: "Gemini 4 Argon", reasoning: true }],
  });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    const chip = window.getByRole("button", { name: /^模型与推理强度/ });
    await expect(chip).toHaveText("faux-1", { timeout: 30_000 });
    await expect(chip.locator("img")).toHaveAttribute("src", /catpaw-[\w-]+\.webp$/);
    await expect.poll(() => chip.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(512);
    await chip.click();
    const tab = window.getByRole("tab", { name: "catpaw-cli", exact: true });
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab.locator("img")).toHaveAttribute("src", /catpaw-[\w-]+\.webp$/);
    await expect.poll(() => tab.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(512);
    await window.getByRole("menuitemradio", { name: /Gemini 4 Argon/ }).click();
    await expect(chip).toHaveText("Gemini 4 Argon中");
    await chip.click();
    for (const colorScheme of ["light", "dark"] as const) {
      await window.emulateMedia({ colorScheme });
      await window.screenshot({ path: testInfo.outputPath(`catpaw-${colorScheme}.png`) });
    }
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});

test("lists pi's commands as / is typed, and runs the one chosen", async () => {
  const pi = await fauxPiEnvironment({ replies: [] });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    const box = window.getByRole("textbox", { name: "消息" });
    await box.fill("/faux-n");

    const option = window.getByRole("option", { name: /faux-noop/ });
    await expect(option).toBeVisible({ timeout: 30_000 });
    await expect(window.getByRole("option", { name: /^\/mcp/ })).toHaveCount(0);
    await box.press("Enter");
    // The chosen command shows as a tag before the empty box (design-language, "命令标签").
    const tag = window.getByTestId("command-tag");
    await expect(tag).toHaveText("faux-noop");
    await expect(box).toHaveValue("");
    await box.press("Enter");

    // The extension handles it without a run: no reply, and the box is empty for the next message.
    await expect(tag).toHaveCount(0);
    await expect(box).toHaveValue("");
    await expect(window.getByTestId("user-message")).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
