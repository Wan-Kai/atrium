import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { writeTerminalSession } from "./projects";

/**
 * Reads `setupDone` from the preferences file in a data directory.
 * @remarks The host writes the file once `set_preferences` arrives; until then there is none, which reads as not set.
 * @sideEffects Reads the file.
 * @param home - The data directory.
 * @returns The flag, or `null` when the file or the flag is missing.
 */
async function setupDone(home: string): Promise<boolean | null> {
  const text = await readFile(join(home, "preferences.json"), "utf8").catch(() => "{}");
  return (JSON.parse(text) as { setupDone?: boolean }).setupDone ?? null;
}

test("goes from the welcome page to a project found in pi's sessions, and opens on the workbench after", async () => {
  // The faux pi is a wrapper script, so Atrium cannot load pi's package to log in through it:
  // step 2 sends to the terminal's /login and lets first launch go on (SPEC-0001, "第 2 步").
  const pi = await fauxPiEnvironment({ replies: [] });
  // pi records the real path, and the host keeps projects at theirs.
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "atrium-e2e-found-")));
  await writeTerminalSession(pi.agentDir, cwd, "0a1b2c3d-0000-4000-8000-000000000001", "hello");
  const launched = await launchApp(pi.env, undefined, { firstLaunch: true });
  try {
    const { window } = launched;
    await expect(window.getByRole("heading", { level: 1 })).toHaveText("看得见内部的coding agent");
    await window.getByRole("button", { name: "开始设置" }).click();
    await expect(window.getByRole("heading", { level: 1 })).toHaveText("登录一个模型", { timeout: 30_000 });
    await expect(window.getByText("Atrium 加载不了你装的 pi，没法在这里登录。")).toBeVisible();
    await window.getByRole("button", { name: "继续" }).click();

    await expect(window.getByRole("heading", { level: 1 })).toHaveText("从一个项目开始", { timeout: 30_000 });
    const folders = window.getByRole("group", { name: "要添加的文件夹" });
    const found = folders.getByRole("checkbox");
    await expect(found).toHaveCount(1, { timeout: 30_000 });
    await expect(found).toHaveAccessibleName(cwd.slice(cwd.lastIndexOf("/") + 1));
    await expect(found).toHaveAttribute("aria-checked", "true");
    await expect(found).toContainText(cwd);
    await expect(found).toContainText("1 个会话");
    await window.getByRole("button", { name: "添加 1 个项目" }).click();

    await expect(window.getByRole("status")).toHaveText(/已连接宿主/, { timeout: 30_000 });
    await expect(window.getByTestId("workspace-row")).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => setupDone(launched.home)).toBe(true);
    await launched.quit();

    const again = await launchApp(pi.env, launched.home);
    await expect(again.window.getByRole("button", { name: "开始设置" })).toHaveCount(0);
    await again.quit();
  } finally {
    await launched.quit().catch(() => undefined);
    await launched.cleanup();
    await rm(cwd, { recursive: true, force: true });
    await pi.cleanup();
  }
});
