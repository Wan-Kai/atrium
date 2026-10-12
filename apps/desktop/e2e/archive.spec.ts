import { createGitScene } from "@atrium/testkit";
import { type Page, expect, test } from "@playwright/test";
import { realpath, stat } from "node:fs/promises";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { addProject } from "./projects";

/**
 * Whether a directory is there.
 *
 * @remarks
 * Archiving removes the worktree's directory and restoring adds it back.
 *
 * @sideEffects Reads the file system.
 * @param dir - The directory.
 * @returns Whether it exists.
 */
async function there(dir: string): Promise<boolean> {
  return (await stat(dir).catch(() => null)) !== null;
}

/**
 * Opens a menu from the "···" button a row shows on hover.
 *
 * @sideEffects Hovers and clicks in the page.
 * @param window - The app's page.
 * @param row - The row's test id.
 * @param name - The name the row shows.
 * @param label - The menu button's name.
 */
async function openMenu(window: Page, row: string, name: string, label: string): Promise<void> {
  const shown = window.getByTestId(row).filter({ hasText: name });
  await shown.hover();
  await shown.getByRole("button", { name: label }).click();
}

test("archives a worktree after asking, removing its directory and keeping its branch, and restores it after a restart", async () => {
  const pi = await fauxPiEnvironment({ replies: [] });
  const scene = await createGitScene("e2e-archive");
  const repo = await realpath(scene.repo);
  const feature = await realpath(await scene.worktree("feature/old"));
  let launched = await launchApp(pi.env);
  const home = launched.home;
  try {
    let { window } = launched;
    await addProject(launched.app, window, repo);
    const rows = window.getByTestId("workspace-row");
    await expect(rows).toHaveText(["main", "feature/old"], { timeout: 30_000 });
    await rows.nth(1).click();
    await window.keyboard.press("Meta+T");
    await expect(window.getByRole("tab")).toHaveText(["新会话"], { timeout: 30_000 });

    await openMenu(window, "workspace-row", "feature/old", "工作区 feature/old");
    await window.getByRole("menuitem", { name: "归档…" }).click();
    const dialog = window.getByRole("alertdialog", { name: "归档工作区「feature/old」？" });
    await expect(dialog).toContainText("分支 feature/old 保留");
    await dialog.getByRole("button", { name: "归档", exact: true }).click();

    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(rows).toHaveText(["main"]);
    await expect(window.getByRole("tab")).toHaveCount(0);
    expect(await there(feature)).toBe(false);
    expect(await scene.git(repo, "branch", "--list", "feature/old")).toBe("feature/old");
    await launched.quit();

    launched = await launchApp(pi.env, home);
    window = launched.window;
    await expect(window.getByTestId("workspace-row")).toHaveText(["main"], { timeout: 30_000 });
    await openMenu(window, "project-row", "repo", "项目 repo");
    await window.getByRole("menuitem", { name: "已归档的工作区" }).click();
    await window.getByRole("menuitem", { name: "恢复 feature/old" }).click();

    await expect(window.getByTestId("workspace-row")).toHaveText(["main", "feature/old"], { timeout: 30_000 });
    expect(await there(feature)).toBe(true);
    expect(await scene.git(feature, "branch", "--show-current")).toBe("feature/old");
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});
