import { createGitScene } from "@atrium/testkit";
import { type Page, expect, test } from "@playwright/test";
import { realpath, stat } from "node:fs/promises";
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

test("the agent opens two children, one writing in a worktree of its own; both finish, and the parent is told and sums them up", async () => {
  const pi = await fauxPiEnvironment({
    replies: [
      {
        blocks: [
          { type: "toolCall", id: "spawn-1", name: "agent_spawn", arguments: { name: "audit", task: "查一遍登录" } },
          {
            type: "toolCall",
            id: "spawn-2",
            name: "agent_spawn",
            arguments: { name: "tests", task: "补登录的测试", role: "work" },
          },
        ],
      },
      { blocks: [{ type: "text", text: "派出去了" }] },
      // The two notices come as one, or one after the other: either way the parent sums up.
      { blocks: [{ type: "text", text: "两个都做完了" }] },
      { blocks: [{ type: "text", text: "两个都做完了" }] },
    ],
    childReplies: [{ blocks: [{ type: "text", text: "查完了" }] }],
  });
  const scene = await createGitScene("e2e-agent-children");
  const repo = await realpath(scene.repo);
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    await addProject(app, window, repo);
    await window.getByTestId("workspace-row").click({ timeout: 30_000 });
    await window.keyboard.press("Meta+T");
    await expect(window.getByRole("tab")).toHaveText(["新会话"], { timeout: 30_000 });
    await send(window, "查一下登录");

    await expect(window.getByTestId("reply").last()).toHaveText("两个都做完了", { timeout: 90_000 });
    const sources = window.getByTestId("source-line");
    await expect(sources.filter({ hasText: "来自子对话「audit」· 完成" })).toHaveCount(1);
    await expect(sources.filter({ hasText: "来自子对话「tests」· 完成" })).toHaveCount(1);
    await expect(window.getByRole("tab")).toHaveText(["查一下登录"]);
    await window.getByRole("button", { name: /^子对话 2/ }).click();
    const rows = window.getByRole("dialog", { name: "子对话" }).getByTestId("child-row");
    await expect(rows.filter({ hasText: /^audit只读/ })).toHaveCount(1);
    await expect(rows.filter({ hasText: /^tests可写/ })).toHaveCount(1);
    // A work child has a worktree of its own, on a branch named after its handle.
    const dir = join(dirname(repo), "repo.worktrees", "tests");
    expect(await scene.git(dir, "branch", "--show-current")).toBe("agent/tests");
    await window.keyboard.press("Escape");

    await sources.filter({ hasText: "「audit」" }).getByRole("button", { name: "打开子对话「audit」" }).click();
    await expect(window.getByRole("tab")).toHaveText(["查一下登录", "audit"], { timeout: 30_000 });
    await expect(window.getByTestId("task-text")).toHaveText("查一遍登录", { timeout: 30_000 });
    await expect(window.getByTestId("reply")).toHaveText(["查完了"]);
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});

/**
 * Opens the project's local workspace and sends a session its first message.
 *
 * @remarks
 * Waits for the new tab first, so the message goes to it.
 *
 * @sideEffects Opens the workspace and a session; sends the message.
 * @param window - The app's page.
 * @param text - The message.
 */
async function startSession(window: Page, text: string): Promise<void> {
  await window.getByTestId("workspace-row").click({ timeout: 30_000 });
  await window.keyboard.press("Meta+T");
  await expect(window.getByRole("tab")).toHaveText(["新会话"], { timeout: 30_000 });
  await send(window, text);
}

/**
 * How many pi processes the host stopped on purpose so far, by its log.
 *
 * @remarks
 * A child's pi goes when its run ended and no tab shows it (SPEC-0002, "角色与限制 · 进程").
 *
 * @sideEffects Reads the host's log.
 * @param readHostLog - Reads the host's log lines.
 * @returns The count.
 */
async function stoppedPis(readHostLog: () => Promise<Record<string, unknown>[]>): Promise<number> {
  return (await readHostLog()).filter((line) => line["msg"] === "pi exited" && line["requested"] === true).length;
}

test("a grandchild's result reaches the main conversation through a child whose pi was stopped in between", async () => {
  const pi = await fauxPiEnvironment({
    replies: [
      {
        blocks: [
          { type: "toolCall", id: "spawn-1", name: "agent_spawn", arguments: { name: "mid", task: "安排孙对话" } },
        ],
      },
      { blocks: [{ type: "text", text: "派出去了" }] },
      { blocks: [{ type: "text", text: "收到" }] },
      { blocks: [{ type: "text", text: "收到" }] },
    ],
    childReplies: [
      {
        blocks: [
          { type: "toolCall", id: "spawn-2", name: "agent_spawn", arguments: { name: "leaf", task: "做叶子的事" } },
        ],
      },
      { blocks: [{ type: "text", text: "交给孙对话了" }] },
      { blocks: [{ type: "text", text: "孙对话做完了" }] },
    ],
    grandchildReplies: [{ blocks: [{ type: "text", text: "叶子做完了" }] }],
  });
  const scene = await createGitScene("e2e-agent-chain");
  const repo = await realpath(scene.repo);
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    await addProject(app, window, repo);
    await startSession(window, "安排一下");

    const notices = window.getByTestId("source-line").filter({ hasText: "来自子对话「mid」· 完成" });
    await expect(notices).toHaveCount(2, { timeout: 90_000 });
    await expect.poll(() => stoppedPis(launched.readHostLog), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    await window.getByRole("button", { name: /^子对话 1/ }).click();
    await expect(window.getByRole("dialog", { name: "子对话" }).getByTestId("child-row")).toHaveText([/^mid只读.*\+1/]);
    await window.keyboard.press("Escape");

    await notices.first().getByRole("button", { name: "打开子对话「mid」" }).click();
    await expect(window.getByRole("tab")).toHaveText(["安排一下", "mid"], { timeout: 30_000 });
    await expect(window.getByTestId("source-line").filter({ hasText: "来自子对话「leaf」· 完成" })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(window.getByTestId("reply").last()).toHaveText("孙对话做完了");
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});

test("a read-only child cannot write a file: pi never offers it the tool", async () => {
  const pi = await fauxPiEnvironment({
    replies: [
      {
        blocks: [{ type: "toolCall", id: "spawn-1", name: "agent_spawn", arguments: { name: "reader", task: "看看" } }],
      },
      { blocks: [{ type: "text", text: "派出去了" }] },
      { blocks: [{ type: "text", text: "收到" }] },
    ],
    childReplies: [
      { blocks: [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "x.txt", content: "hi" } }] },
      { blocks: [{ type: "text", text: "写不了" }] },
    ],
  });
  const scene = await createGitScene("e2e-agent-read-only");
  const repo = await realpath(scene.repo);
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    await addProject(app, window, repo);
    await startSession(window, "看一下");

    const notice = window.getByTestId("source-line").filter({ hasText: "来自子对话「reader」· 完成" });
    await expect(notice).toHaveCount(1, { timeout: 90_000 });
    await notice.getByRole("button", { name: "打开子对话「reader」" }).click();
    await expect(window.getByTestId("reply").last()).toHaveText("写不了", { timeout: 30_000 });

    expect(await stat(join(repo, "x.txt")).catch(() => null)).toBeNull();
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});
