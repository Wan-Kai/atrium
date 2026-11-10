import { createGitScene } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { send } from "./messages";
import { addProject } from "./projects";

const TASK_NAME = "test task";
const SOURCE_PROMPT = "Let's plan the out.txt task";

/** A scripted reply that calls one tool. */
const call = (name: string, id: string, args: Record<string, unknown>) => ({
  blocks: [{ type: "toolCall" as const, id, name, arguments: args as Record<string, never> }],
});
const say = (text: string) => ({ blocks: [{ type: "text" as const, text }] });
const done = (id: string, summary: string) => call("node_done", id, { ok: true, summary });

const TESTS = {
  header: "测试",
  question: "要补哪些测试？",
  multiSelect: true,
  options: [
    { label: "单元", description: "纯函数" },
    { label: "组件", description: "展开收起" },
  ],
};

/** The graph the task conversation draws: explore, write, then you accept and merge. */
const NODES = [
  { id: "N1", name: "调研", kind: "agent", job: "look around", done: ["asked"], role: "explore" },
  { id: "N2", name: "写入", kind: "agent", job: "write out.txt", done: ["out.txt written"], role: "work" },
  { id: "H1", name: "验收合并", kind: "human", job: "check out.txt", done: ["ok"], merge: true },
];
const EDGES = [
  { from: "N1", to: "N2", kind: "seq" },
  { from: "N2", to: "H1", kind: "seq" },
];

test("from /task in a chat to accepting, merging and archiving, all inside Atrium (SPEC-0006, 验证 · 端到端)", async () => {
  test.setTimeout(240_000);
  const pi = await fauxPiEnvironment({
    replies: [],
    title: "A title",
    byConversation: [
      {
        startsWith: `<atrium-task-node>\n你在任务「${TASK_NAME}」里负责节点 N1 ·`,
        replies: [call("ask_user", "a1", { questions: [TESTS] }), done("d1", "Explored.")],
      },
      {
        startsWith: `<atrium-task-node>\n你在任务「${TASK_NAME}」里负责节点 N2 ·`,
        replies: [call("write", "w1", { path: "./out.txt", content: "hello\n" }), done("d2", "Wrote out.txt.")],
      },
      {
        startsWith: "<atrium-task-design>",
        replies: [
          call("task_set_meta", "t1", { name: TASK_NAME }),
          call("task_propose_graph", "t2", { nodes: NODES, edges: EDGES, note: "three steps", guide: "feature" }),
          say("Three steps."),
        ],
      },
      { startsWith: SOURCE_PROMPT, replies: [say("Understood.")] },
    ],
  });
  const scene = await createGitScene("e2e-task-flow");
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    const repo = await realpath(scene.repo);
    await addProject(app, window, repo);

    // A conversation that is the requirements; `/task` makes the task and opens its tab.
    await window.getByTestId("workspace-row").click({ timeout: 30_000 });
    await window.keyboard.press("Meta+T");
    await expect(window.getByRole("tab")).toHaveText(["新会话"], { timeout: 30_000 });
    await send(window, SOURCE_PROMPT);
    await expect(window.getByText("Understood.")).toBeVisible({ timeout: 60_000 });
    await send(window, "/task");
    await expect(window.getByTestId("task-tab")).toBeVisible({ timeout: 60_000 });
    await expect(window.getByTestId("graph-node")).toHaveCount(3, { timeout: 60_000 });

    // Confirm the first graph and start.
    await window.getByRole("button", { name: "确认并启动" }).click();
    await expect(window.getByTestId("task-bar-status")).not.toContainText("设计中", { timeout: 30_000 });

    // N1 asks a multiple-choice question; it is answered in the list's row.
    await window.getByRole("tab", { name: "任务", exact: true }).click();
    const row = window.getByTestId("task-row");
    await row.click();
    const card = window.getByTestId("question");
    await expect(card).toBeVisible({ timeout: 90_000 });
    await card.getByRole("checkbox", { name: /单元/ }).click();
    await card.getByRole("checkbox", { name: /组件/ }).click();
    await card.getByRole("button", { name: "提交回答" }).click();

    // N2 writes out.txt; the human node waits with a review card in the task tab.
    await window.getByRole("button", { name: "打开任务" }).click();
    const review = window.getByTestId("review");
    await expect(review).toBeVisible({ timeout: 120_000 });
    await expect(window.getByTestId("review-subject")).toContainText("验收合并");
    await review.getByRole("button", { name: "通过并合并" }).click();

    // Merged: the archive question comes; archive it.
    await expect(window.getByTestId("review-subject")).toContainText("要归档 worktree 吗", { timeout: 90_000 });
    expect(await readFile(join(repo, "out.txt"), "utf8")).toBe("hello\n");
    await window.getByTestId("review").getByRole("button", { name: "归档" }).click();
    await expect(window.getByTestId("review")).toHaveCount(0, { timeout: 60_000 });
    await expect
      .poll(
        () => execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }).trim().split("\n").length,
        {
          timeout: 60_000,
        },
      )
      .toBe(1);
    await expect(window.getByRole("button", { name: /^关闭 / })).toBeVisible();
    // The rail kept what you decided.
    await expect(window.getByTestId("review-record").first()).toBeVisible();
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});
