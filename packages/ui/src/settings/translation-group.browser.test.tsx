import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { fakeClient, READY_SETUP } from "../test/fake-client";
import { SettingsPanel } from "./settings-panel";

/**
 * Opens the settings the same way the accounts category is reached.
 * @remarks No real credential or model request is made.
 * @sideEffects Renders the settings.
 * @param answers - Responses controlled by the test.
 * @returns The rendered settings and fake client.
 */
async function settings(answers: Parameters<typeof fakeClient>[1] = {}) {
  await page.viewport(1280, 820);
  const fake = fakeClient({}, { setup: READY_SETUP, ...answers });
  await fake.client.loadSetup();
  const screen = await render(
    <SettingsPanel
      client={fake.client}
      section="accounts"
      onSection={() => undefined}
      onClose={() => undefined}
      openUrl={() => undefined}
      reveal={undefined}
    />,
  );
  return { ...fake, screen };
}

/**
 * Fails the first save and lets the next one finish.
 * @remarks Models a real retry without conditional logic in the test.
 * @sideEffects Advances the fixture's call counter.
 * @returns The save fixture.
 */
function firstSaveFails(): () => Promise<void> {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) throw new Error("private host failure");
  };
}

describe("translation settings", () => {
  it("retains the draft after failure, keeps the saved language and lets the user retry", async () => {
    const { screen, client, calls } = await settings({ setPreferences: firstSaveFails() });
    const group = screen.getByRole("region", { name: "回复翻译" });
    const field = group.getByRole("textbox", { name: "翻译目标语言" });
    const save = group.getByRole("button", { name: "保存翻译语言" });
    await field.fill("English");
    await save.click();
    await expect.element(group.getByRole("alert")).toHaveTextContent("没能保存翻译语言，请重试；当前语言没有改变");
    await expect.element(field).toHaveValue("English");
    expect(client.index.getState().preferences.translationLanguage).toBe("简体中文");
    await expect.element(screen.getByText("private host failure")).not.toBeInTheDocument();
    await save.click();
    await expect.element(group.getByRole("status")).toHaveTextContent("已保存");
    expect(client.index.getState().preferences.translationLanguage).toBe("English");
    expect(calls.filter((call) => call.startsWith("setPreferences"))).toHaveLength(2);
  });

  it.each(["", "   ", "a".repeat(81), "Eng\u0001lish"])(
    "rejects invalid language %j without a command",
    async (invalid) => {
      const { screen, calls, client } = await settings();
      const group = screen.getByRole("region", { name: "回复翻译" });
      await group.getByRole("textbox", { name: "翻译目标语言" }).fill(invalid);
      await expect.element(group.getByRole("alert")).toHaveTextContent("请输入 1～80 个字符的目标语言，不含控制字符");
      await expect.element(group.getByRole("button", { name: "保存翻译语言" })).toBeDisabled();
      expect(calls.filter((call) => call.startsWith("setPreferences"))).toStrictEqual([]);
      expect(client.index.getState().preferences.translationLanguage).toBe("简体中文");
    },
  );

  it("shows the language setting even when pi's login cannot be loaded", async () => {
    const { screen } = await settings({ setup: { ...READY_SETUP, login: { state: "unavailable" } } });
    await expect
      .element(screen.getByRole("region", { name: "回复翻译" }).getByRole("textbox", { name: "翻译目标语言" }))
      .toHaveValue("简体中文");
  });

  it("reflects another client's saved language without replacing an edited draft", async () => {
    const { screen, index } = await settings();
    const field = screen.getByRole("textbox", { name: "翻译目标语言" });
    index.setState({ preferences: { ...index.getState().preferences, translationLanguage: "English" } });
    await expect.element(field).toHaveValue("English");
    await field.fill("日本語");
    index.setState({ preferences: { ...index.getState().preferences, translationLanguage: "Français" } });
    await expect.element(field).toHaveValue("日本語");
    await screen.getByRole("button", { name: "保存翻译语言" }).click();
    await expect
      .element(screen.getByRole("region", { name: "回复翻译" }).getByRole("status"))
      .toHaveTextContent("已保存");
    expect(index.getState().preferences.translationLanguage).toBe("日本語");
  });

  it("defaults to Chinese and saves a trimmed target only after the host succeeds", async () => {
    const saving = Promise.withResolvers<void>();
    const { screen, client, calls } = await settings({ setPreferences: () => saving.promise });
    const group = screen.getByRole("region", { name: "回复翻译" });
    const field = group.getByRole("textbox", { name: "翻译目标语言" });
    const save = group.getByRole("button", { name: "保存翻译语言" });
    await expect.element(field).toHaveValue("简体中文");
    await expect.element(save).toBeDisabled();
    await field.fill("  日本語  ");
    await save.click();
    await expect.element(field).toBeDisabled();
    expect(client.index.getState().preferences.translationLanguage).toBe("简体中文");
    expect(calls).toContain('setPreferences {"translationLanguage":"日本語"}');
    saving.resolve();
    await expect.element(group.getByRole("status")).toHaveTextContent("已保存");
    await expect.element(field).toHaveValue("日本語");
    expect(client.index.getState().preferences.translationLanguage).toBe("日本語");
    await expect.element(group.getByRole("combobox")).not.toBeInTheDocument();
  });
});
