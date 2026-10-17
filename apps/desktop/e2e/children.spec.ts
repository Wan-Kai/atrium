import { createGitScene } from "@atrium/testkit";
import { type Page, expect, test } from "@playwright/test";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { send } from "./messages";
import { addProject } from "./projects";

/**
 * Starts a session in the project's local workspace and sends it a first message.
 *
 * @remarks
 * The parent of the child conversations below (SPEC-0002): one on file, with a reply to open a
 * child from.
 *
 * @sideEffects Opens the workspace, a session in it, and sends "一".
 * @param window - The app's page.
 */
async function parentWithReply(window: Page): Promise<void> {
  await window.getByTestId("workspace-row").click({ timeout: 30_000 });
  await window.keyboard.press("Meta+T");
  await expect(window.getByRole("tab")).toHaveText(["新会话"], { timeout: 30_000 });
  await send(window, "一");
  await expect(window.getByTestId("reply")).toHaveText(["好的"], { timeout: 60_000 });
  await expect(window.getByRole("tab")).toHaveText(["一"], { timeout: 30_000 });
}

test("opens a child from a reply carrying the conversation, which shows in its parent's capsule and usage once it replied", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "好的" }] }] });
  const scene = await createGitScene("e2e-children");
  const repo = await realpath(scene.repo);
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    await addProject(app, window, repo);
    await parentWithReply(window);

    await window.getByRole("button", { name: "从这里开子对话" }).click();
    const dialog = window.getByRole("dialog", { name: "开子对话" });
    await expect(dialog.getByRole("textbox", { name: "名字" })).toHaveValue("子对话 1");
    await dialog.getByRole("button", { name: "开子对话" }).click();

    const tabs = window.getByRole("tab");
    await expect(tabs).toHaveText(["一", "子对话 1"], { timeout: 30_000 });
    await expect(tabs.nth(1).getByLabel("子对话", { exact: true })).toBeVisible();
    await expect(window.getByRole("navigation", { name: "子对话的位置" })).toHaveText("一子对话 1");
    await expect(window.getByTestId("reply")).toHaveText(["好的"], { timeout: 30_000 });
    await send(window, "二");
    await expect(window.getByTestId("reply")).toHaveText(["好的", "好的"], { timeout: 60_000 });

    await window.getByRole("navigation", { name: "子对话的位置" }).getByRole("button", { name: "一" }).click();
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await window.getByRole("button", { name: /^子对话 1/ }).click();
    await expect(window.getByRole("dialog", { name: "子对话" }).getByTestId("child-row")).toHaveText([/^子对话 1/]);
    await window.getByRole("button", { name: /缓存命中/ }).hover();
    await expect(window.getByRole("tooltip").filter({ hasText: "Token 用量" })).toContainText("含子对话", {
      timeout: 30_000,
    });
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});

test("forks a child into a new worktree, which is told where it works, and archiving the parent archives a child beside it and detaches that one", async () => {
  const pi = await fauxPiEnvironment({ replies: [{ blocks: [{ type: "text", text: "好的" }] }] });
  const scene = await createGitScene("e2e-child-worktree");
  const repo = await realpath(scene.repo);
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    await addProject(app, window, repo);
    await parentWithReply(window);

    await window.getByRole("button", { name: "从这里开子对话" }).click();
    const dialog = window.getByRole("dialog", { name: "开子对话" });
    await dialog.getByRole("textbox", { name: "名字" }).fill("补测试");
    await dialog.getByRole("radio", { name: "新建 worktree" }).click();
    await dialog.getByRole("textbox", { name: "分支" }).fill("atrium/e2e-child");
    await dialog.getByRole("button", { name: "开子对话" }).click();

    await expect(window.getByTestId("workspace-row")).toHaveText(["main", "atrium/e2e-child"], { timeout: 60_000 });
    await expect(window.getByTestId("workspace-row").nth(1)).toHaveAttribute("aria-current", "true");
    const dir = join(dirname(repo), "repo.worktrees", "e2e-child");
    expect(await scene.git(dir, "branch", "--show-current")).toBe("atrium/e2e-child");
    await expect(window.getByRole("tab")).toHaveText(["补测试"], { timeout: 30_000 });
    await expect(window.getByRole("tab").getByLabel("子对话", { exact: true })).toBeVisible();
    await expect(window.getByText(`在新的 worktree 里继续：${dir}（之前的路径属于 ${repo}）`)).toBeVisible({
      timeout: 30_000,
    });
    await send(window, "二");
    await expect(window.getByTestId("reply")).toHaveText(["好的", "好的"], { timeout: 60_000 });

    await window.getByRole("navigation", { name: "子对话的位置" }).getByRole("button", { name: "一" }).click();
    await expect(window.getByTestId("workspace-row").nth(0)).toHaveAttribute("aria-current", "true");
    await window.getByRole("button", { name: "新建", exact: true }).click();
    await window.getByRole("menuitem", { name: /子对话/ }).click();
    await window.getByRole("dialog", { name: "开子对话" }).getByRole("button", { name: "开子对话" }).click();
    await expect(window.getByRole("tab")).toHaveText(["一", "子对话 2"], { timeout: 30_000 });

    await window.getByRole("tab").nth(0).click();
    await window.getByRole("button", { name: "当前会话" }).click();
    await window.getByRole("menuitem", { name: "归档" }).click();
    await expect(window.getByRole("tab")).toHaveCount(0, { timeout: 30_000 });
    await window.getByRole("button", { name: "历史" }).click();
    await expect(window.getByRole("menuitem")).toHaveCount(0);
    await window.keyboard.press("Escape");
    await window.getByTestId("workspace-row").nth(1).click();
    await expect(window.getByRole("tab")).toHaveText(["补测试"], { timeout: 30_000 });
    await expect(window.getByRole("tab").getByLabel("子对话", { exact: true })).toHaveCount(0);
    await expect(window.getByRole("navigation", { name: "子对话的位置" })).toHaveCount(0);
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});
