import { createGitScene } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { addProject, focusWindow, writeTerminalSession } from "./projects";

test("lists a git project's worktrees and a plain folder as git has them, and finds terminal sessions on focus", async () => {
  const pi = await fauxPiEnvironment({ replies: [] });
  const scene = await createGitScene("e2e-workspaces");
  const repo = await realpath(scene.repo);
  const feature = await realpath(await scene.worktree("feature/sidebar"));
  const plain = await realpath(await mkdtemp(join(tmpdir(), "atrium-e2e-plain-")));
  const plainName = basename(plain);
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    await addProject(app, window, repo);
    const rows = window.getByTestId("workspace-row");
    await expect(rows).toHaveText(["main", "feature/sidebar"], { timeout: 30_000 });

    await scene.commit(feature, "a.txt", "a");
    await focusWindow(window);
    await expect(rows.nth(1)).toHaveText("feature/sidebar1", { timeout: 30_000 });

    await addProject(app, window, plain);
    await expect(window.getByTestId("project-row")).toHaveText(["repo", plainName]);
    await expect(rows.nth(2)).toHaveText(plainName);

    await writeTerminalSession(pi.agentDir, feature, "terminal-session-1", "终端里问的问题");
    await focusWindow(window);
    await rows.nth(1).click();
    await window.getByRole("button", { name: "历史" }).click();
    await expect(window.getByRole("menuitem", { name: /终端里问的问题/ })).toBeVisible({ timeout: 30_000 });
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
    await rm(plain, { recursive: true, force: true });
  }
});

test("creates sessions as tabs, keeps them and the tab it was on across a restart, and discards an empty draft", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "pong" }] }] });
  const folder = await realpath(await mkdtemp(join(tmpdir(), "atrium-e2e-tabs-")));
  await mkdir(folder, { recursive: true });
  let launched = await launchApp(pi.env);
  const home = launched.home;
  try {
    const { window, app } = launched;
    await addProject(app, window, folder);
    await window.getByTestId("workspace-row").click({ timeout: 30_000 });
    await window.keyboard.press("Meta+T");
    await expect(window.getByRole("tab")).toHaveText(["新会话"], { timeout: 30_000 });
    await window.getByRole("textbox", { name: "消息" }).fill("ping");
    await window.getByRole("textbox", { name: "消息" }).press("Enter");
    await expect(window.getByTestId("reply")).toHaveText("pong", { timeout: 30_000 });
    await expect(window.getByRole("tab")).toHaveText(["ping"], { timeout: 30_000 });
    await window.keyboard.press("Meta+T");
    await expect(window.getByRole("tab")).toHaveText(["ping", "新会话"], { timeout: 30_000 });
    await launched.quit();

    launched = await launchApp(pi.env, home);
    const restarted = launched.window;
    await expect(restarted.getByRole("tab")).toHaveText(["ping", "新会话"], { timeout: 30_000 });
    await expect(restarted.getByRole("tab", { selected: true })).toHaveText("新会话");
    await restarted.keyboard.press("Meta+W");
    await expect(restarted.getByRole("tab")).toHaveText(["ping"]);
    // The tab left is a session on file whose pi has not started since the restart.
    await expect(restarted.getByTestId("reply")).toHaveText("pong", { timeout: 30_000 });
    await restarted.getByRole("button", { name: "历史" }).click();
    await expect(restarted.getByRole("menuitem")).toHaveText([/^ping已打开/]);
  } finally {
    await launched.close();
    await pi.cleanup();
    await rm(folder, { recursive: true, force: true });
  }
});
