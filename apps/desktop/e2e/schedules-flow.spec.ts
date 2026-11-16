import { createGitScene } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { realpath } from "node:fs/promises";
import { fauxPiEnvironment } from "./faux-pi";
import { launchApp } from "./launch";
import { send } from "./messages";
import { addProject } from "./projects";

const RULE_NAME = "Poll the logs";
const SOURCE_PROMPT = "Let's plan the log polling";

/** A scripted reply that calls one tool. */
const call = (name: string, id: string, args: Record<string, unknown>) => ({
  blocks: [{ type: "toolCall" as const, id, name, arguments: args as Record<string, never> }],
});
const say = (text: string) => ({ blocks: [{ type: "text" as const, text }] });

const SUMMARY = { goal: "poll", decisions: [], constraints: [], nonGoals: [], openQuestions: [], acceptance: [] };
const NODES = [{ id: "N1", name: "看日志", kind: "agent", job: "look at the logs", done: ["looked"], role: "explore" }];

test("a rule from a conversation: saved from the start page, shown in 定时, run now, paused, resumed and deleted (SPEC-0006, T10)", async () => {
  test.setTimeout(240_000);
  const pi = await fauxPiEnvironment({
    replies: [],
    title: "A title",
    byConversation: [
      {
        startsWith: `<atrium-task-node>\n你在任务「${RULE_NAME} · `,
        replies: [call("node_done", "d1", { ok: true, summary: "Looked." })],
      },
      {
        startsWith: "<atrium-task-design>",
        replies: [
          call("task_set_summary", "t1", { summary: SUMMARY }),
          call("task_set_meta", "t2", { name: RULE_NAME }),
          call("task_set_schedule", "t3", { when: { every: "day", at: "2:00" }, place: "local_readonly" }),
          call("task_propose_graph", "t4", { nodes: NODES, edges: [], note: "one step", guide: "research" }),
          say("A rule for every night at 2:00."),
        ],
      },
      { startsWith: SOURCE_PROMPT, replies: [say("Understood.")] },
    ],
  });
  const scene = await createGitScene("e2e-schedules");
  const launched = await launchApp(pi.env);
  try {
    const { window, app } = launched;
    const repo = await realpath(scene.repo);
    await addProject(app, window, repo);

    await window.getByTestId("workspace-row").click({ timeout: 30_000 });
    await window.keyboard.press("Meta+T");
    await expect(window.getByRole("tab")).toHaveText(["新会话"], { timeout: 30_000 });
    await send(window, SOURCE_PROMPT);
    await expect(window.getByText("Understood.")).toBeVisible({ timeout: 60_000 });
    await send(window, "/task");
    await expect(window.getByTestId("task-tab")).toBeVisible({ timeout: 60_000 });
    await expect(window.getByTestId("graph-node")).toHaveCount(1, { timeout: 60_000 });

    // The template's start page: the button saves the rule, and nothing starts.
    await expect(window.getByRole("button", { name: "确认并启动" })).toHaveCount(0);
    await window.getByRole("button", { name: "确认并保存规则" }).click();
    await expect(window.getByTestId("task-bar-status")).toContainText("设计中");

    // The template is no task in the list; the rule is in 定时.
    await window.getByRole("tab", { name: "任务", exact: true }).click();
    await expect(window.getByTestId("task-row")).toHaveCount(0);
    await window.getByRole("tab", { name: "定时", exact: true }).click();
    const row = window.getByTestId("rule-row");
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row).toContainText(RULE_NAME);
    await expect(window.getByTestId("rule-when")).toHaveText("每天凌晨 2:00");
    await expect(row).toContainText("只读，在本地目录跑");
    await expect(window.getByTestId("rule-result")).toHaveText("—");

    // 立即跑一次 makes an ordinary task, marked as a schedule's, which runs to the end.
    await window.getByRole("button", { name: "立即跑一次" }).click();
    await expect(window.getByTestId("rule-result")).not.toHaveText("—", { timeout: 60_000 });
    await window.getByRole("tab", { name: "任务", exact: true }).click();
    const made = window.getByTestId("task-row");
    await expect(made).toHaveCount(1, { timeout: 30_000 });
    await expect(made).toContainText(`${RULE_NAME} · `);
    await expect(made.getByLabel("定时触发的任务")).toBeVisible();
    await expect(made.getByTestId("task-status")).toHaveText("已完成", { timeout: 120_000 });

    // Paused: dim, 已暂停; resumed; paused again and deleted after the second question.
    await window.getByRole("tab", { name: "定时", exact: true }).click();
    await expect(window.getByTestId("rule-result")).toHaveText("上次完成");
    await window.getByRole("button", { name: "暂停" }).click();
    await expect(window.getByTestId("rule-result")).toHaveText("已暂停");
    await expect(window.getByTestId("rule-next")).toHaveText("—");
    await window.getByRole("button", { name: "恢复" }).click();
    await expect(window.getByTestId("rule-result")).toHaveText("上次完成");
    await expect(window.getByTestId("rule-next")).toContainText("下次");
    await window.getByRole("button", { name: "暂停" }).click();
    await window.getByRole("button", { name: "删除" }).click();
    await window.getByRole("button", { name: "不了" }).click();
    await expect(row).toHaveCount(1);
    await window.getByRole("button", { name: "删除" }).click();
    await window.getByRole("button", { name: "确定" }).click();
    await expect(row).toHaveCount(0, { timeout: 30_000 });
    await expect(window.getByText("还没有定时规则")).toBeVisible();
    // The task it made stays.
    await window.getByRole("tab", { name: "任务", exact: true }).click();
    await expect(window.getByTestId("task-row")).toHaveCount(1);
  } finally {
    await launched.close();
    await pi.cleanup();
    await scene.cleanup();
  }
});
