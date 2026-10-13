import { createGitScene } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { addProject } from "./projects";

test("creates a worktree from a project's new-workspace page with the first message, and sends it there", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "好的" }] }] });
  const scene = await createGitScene("e2e-new-workspace");
  const repo = await realpath(scene.repo);
  // The local main moves past origin's, so starting from origin/main shows.
  await scene.commit(repo, "local.txt", "not pushed");
  const launched = await launchApp(pi.env);
  try {
    const { window } = launched;
    await addProject(launched.app, window, repo);
    await expect(window.getByTestId("workspace-row")).toHaveText(["main"], { timeout: 30_000 });
    const project = window.getByTestId("project-row");
    await project.hover();
    await project.getByRole("button", { name: "在 repo 新建工作区" }).click();
    await expect(window.getByRole("button", { name: "起点", exact: true })).toHaveText("基于 origin/main", {
      timeout: 30_000,
    });
    await window.getByRole("button", { name: "分支名", exact: true }).click();
    await window.getByRole("textbox", { name: "分支名" }).fill("atrium/e2e-otter");
    await window.getByRole("textbox", { name: "分支名" }).press("Enter");
    await window.getByRole("textbox", { name: "消息" }).fill("修一下");
    await window.getByRole("textbox", { name: "消息" }).press("Enter");

    await expect(window.getByTestId("reply")).toHaveText("好的", { timeout: 60_000 });
    await expect(window.getByTestId("user-message")).toContainText("修一下");
    await expect(window.getByTestId("launch-step")).toHaveCount(0);
    await expect(window.getByTestId("workspace-row")).toHaveText(["main", "atrium/e2e-otter"]);
    await expect(window.getByTestId("workspace-row").nth(1)).toHaveAttribute("aria-current", "true");
    const dir = join(dirname(repo), "repo.worktrees", "e2e-otter");
    expect(await scene.git(dir, "branch", "--show-current")).toBe("atrium/e2e-otter");
    expect(await scene.git(dir, "rev-parse", "HEAD")).toBe(await scene.git(repo, "rev-parse", "origin/main"));
    expect(await scene.git(repo, "config", "--list")).not.toContain("branch.atrium/e2e-otter.");
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});
