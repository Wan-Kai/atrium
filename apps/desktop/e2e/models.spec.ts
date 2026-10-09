import { expect, test } from "@playwright/test";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";

test("switches the model and thinking level beside the input box, and a new chat starts on them", async () => {
  const pi = await fauxPiEnvironment({
    replies: [{ blocks: [{ type: "text", text: "好的" }] }, { blocks: [{ type: "text", text: "再来" }] }],
    models: [{ id: "faux-deep", name: "Faux Deep", reasoning: true, thinkingLevelMap: { max: "max" } }],
  });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    const chip = window.getByRole("button", { name: /^模型与推理强度/ });
    // Before any session, pi's own pick.
    await expect(chip).toHaveText("faux-1", { timeout: 30_000 });

    const box = window.getByRole("textbox", { name: "消息" });
    await box.fill("一");
    await box.press("Enter");
    await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["好的"], {
      timeout: 30_000,
    });
    await expect(chip).toHaveText("faux-1中");

    await chip.click();
    await window.getByRole("menuitemradio", { name: /Faux Deep/ }).click();
    await expect(chip).toHaveText("Faux Deep中");
    await window.keyboard.press("Meta+Shift+E");
    await expect(window.getByRole("slider", { name: "推理强度" })).toBeFocused();
    await window.keyboard.press("ArrowRight");
    await window.keyboard.press("ArrowRight");
    await expect(chip).toHaveText("Faux Deep最高");
    await expect(chip).toHaveAttribute("data-full", "");
    await window.keyboard.press("Escape");

    // A new chat starts on the model and level chosen last.
    await window.keyboard.press("Meta+N");
    await expect(chip).toHaveText("Faux Deep最高", { timeout: 30_000 });
    await box.fill("二");
    await box.press("Enter");
    await expect(window.locator('[data-testid="reply"][data-streaming="false"]')).toHaveText(["再来"], {
      timeout: 30_000,
    });
    await expect(chip).toHaveText("Faux Deep最高");
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
