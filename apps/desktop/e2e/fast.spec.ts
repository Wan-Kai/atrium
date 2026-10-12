import { FAUX_BASE_URL_ENV, startModelListServer } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";

test("switches Fast beside the model for a model Codex's list gives it, and pi's next requests ask for priority", async () => {
  // Codex's model list as measured: GPT-6.1 Sol has Fast at 2x and more usage, GPT-5.5 has none.
  const list = await startModelListServer();
  const pi = await fauxPiEnvironment({
    // As ChatGPT's subscription; faux-1 is in neither the list nor the built-in rule.
    provider: "openai-codex",
    // One pi answers all three messages.
    replies: Array.from({ length: 3 }, () => ({ blocks: [{ type: "text" as const, text: "好的" }] })),
    models: [
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
      { id: "gpt-5.5", name: "GPT-5.5" },
    ],
  });
  const launched = await launchApp({ ...pi.env, [FAUX_BASE_URL_ENV]: list.baseUrl });
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
    const sol = window.getByRole("menuitemradio", { name: /GPT-6.1 Sol/ });
    await expect(sol.getByRole("img", { name: "支持 Fast" })).toBeVisible();
    // The built-in rule would give GPT-5.5 Fast; the list does not.
    await expect(
      window.getByRole("menuitemradio", { name: /GPT-5.5/ }).getByRole("img", { name: "支持 Fast" }),
    ).toHaveCount(0);
    await sol.click();
    await expect(fast).toHaveAttribute("aria-pressed", "false");
    await fast.hover();
    await expect(window.getByRole("tooltip")).toHaveText("Fast 未开启约 2 倍速度，额度消耗增加从下一次请求开始生效");
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
      { model: "gpt-6.1-sol", service_tier: "priority" },
      { model: "faux-1" },
    ]);
    // Asked by the catalog's pi, and the session's once Fast was on, each time with pi's login.
    expect(list.requests.length).toBeGreaterThan(0);
    expect(
      new Set(list.requests.map(({ url, headers }) => `${url} ${String(headers["authorization"])}`)),
    ).toStrictEqual(new Set(["/backend-api/codex/models?client_version=99.0.0 Bearer faux-key"]));
  } finally {
    await launched.close();
    await pi.cleanup();
    await list.close();
  }
});
