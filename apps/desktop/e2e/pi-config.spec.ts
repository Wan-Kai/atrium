import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";

test("edits commented models config in settings and real pi loads the saved model", async () => {
  const pi = await fauxPiEnvironment({ replies: [] });
  try {
    const modelsPath = join(pi.agentDir, "models.json");
    const original =
      '\uFEFF{\r\n  // Keep this local configuration comment.\r\n  "providers": {\r\n    "config-local": {\r\n      "baseUrl": "http://127.0.0.1:9/v1",\r\n      "api": "openai-completions",\r\n      "apiKey": "not-a-real-key",\r\n      "models": [{ "id": "config-saved", "name": "Config Before", }],\r\n    },\r\n  },\r\n}\r\n';
    await writeFile(modelsPath, original);
    const launched = await launchApp({ ...pi.env, PI_OFFLINE: "1" });
    try {
      const { window } = launched;
      await window.getByRole("button", { name: "设置", exact: true }).click();
      const settings = window.getByRole("dialog", { name: "设置", exact: true });
      await settings.getByRole("button", { name: "pi", exact: true }).click();
      await settings.getByRole("combobox", { name: "配置文件", exact: true }).selectOption("models.json");
      const editor = settings.getByRole("textbox", { name: "配置内容", exact: true });
      await expect(editor).toHaveValue(original.slice(1).replaceAll("\r\n", "\n"));
      const edited = original.replace("Config Before", "Config After");
      await editor.fill(edited.slice(1).replaceAll("\r\n", "\n"));
      const save = settings.getByRole("button", { name: "保存配置", exact: true });
      await expect(save).toBeEnabled({ timeout: 5_000 });
      await save.click();
      await expect(settings.getByText("已保存", { exact: true })).toBeVisible();
      expect(await readFile(modelsPath, "utf8")).toBe(edited);
      await settings.getByRole("button", { name: "关闭设置", exact: true }).click();

      await window.getByRole("button", { name: /^模型与推理强度/ }).click();
      await window.getByRole("button", { name: "刷新模型列表", exact: true }).click();
      await window.getByRole("tab", { name: "config-local", exact: true }).click();
      await expect(window.getByRole("menuitemradio", { name: /Config After/ })).toBeVisible({ timeout: 30_000 });
    } finally {
      await launched.close();
    }
  } finally {
    await pi.cleanup();
  }
});
