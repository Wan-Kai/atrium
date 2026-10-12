import { expect, test } from "@playwright/test";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";

test("switches Fast beside the model for a model that has it, and pi's next requests ask for priority", async () => {
  const pi = await fauxPiEnvironment({
    // As ChatGPT's subscription, whose GPT-5.5 has Fast and whose faux-1 has not.
    provider: "openai-codex",
    // One pi answers all three messages.
    replies: Array.from({ length: 3 }, () => ({ blocks: [{ type: "text" as const, text: "好的" }] })),
    models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
  });
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    const chip = window.getByRole("button", { name: /^模型与推理强度/ });
    const fast = window.getByRole("button", { name: "Fast", exact: true });
    const box = window.getByRole("textbox", { name: "消息" });
    const replies = window.locator('[data-testid="reply"][data-streaming="false"]');
    await expect(chip).toContainText("faux-1", { timeout: 30_000 });
    await expect(fast).toHaveCount(0);

    await box.fill("一");
    await box.press("Enter");
    await expect(replies).toHaveText(["好的"], { timeout: 30_000 });
    await chip.click();
    await expect(
      window.getByRole("menuitemradio", { name: /GPT-5.5/ }).getByRole("img", { name: "支持 Fast" }),
    ).toBeVisible();
    await window.getByRole("menuitemradio", { name: /GPT-5.5/ }).click();
    await expect(fast).toHaveAttribute("aria-pressed", "false");
    await fast.click();
    await expect(fast).toHaveAttribute("aria-pressed", "true");
    await box.fill("二");
    await box.press("Enter");
    await expect(replies).toHaveText(["好的", "好的"], { timeout: 30_000 });

    // Back on a model without Fast: the button goes, and so does priority, though Fast stays on.
    await chip.click();
    await window.getByRole("menuitemradio", { name: /faux-1/ }).click();
    await expect(fast).toHaveCount(0);
    await box.fill("三");
    await box.press("Enter");
    await expect(replies).toHaveText(["好的", "好的", "好的"], { timeout: 30_000 });

    expect(await pi.payloads()).toStrictEqual([
      { model: "faux-1" },
      { model: "gpt-5.5", service_tier: "priority" },
      { model: "faux-1" },
    ]);
  } finally {
    await launched.close();
    await pi.cleanup();
  }
});
