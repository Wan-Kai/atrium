import { CommandError, type ScheduleSummary } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { PROJECT, fakeClient, session, workspace } from "../test/fake-client";
import { Workbench } from "../app/workbench";
import { node, view } from "./task-fixtures";

const LOCAL = "wks_000000000000000a";

const RULE: ScheduleSummary = {
  id: "rul_a",
  name: "全量变异测试",
  projectId: PROJECT.id,
  place: "new_worktree",
  when: { every: "day", at: "2:00" },
  paused: false,
  nextAt: new Date(2030, 0, 1, 2, 0).getTime(),
  last: { taskId: "tsk_1", status: "stopped", failed: true },
  skipped: 0,
  templateTaskId: "tsk_t",
  createdAt: 1,
};

/**
 * The workbench on the 定时 tab, over a fake client with rules.
 *
 * @sideEffects Renders.
 * @param rules - The rows.
 * @param answers - The fake's answers to commands.
 * @returns The screen and the fake.
 */
async function schedules(rules: readonly ScheduleSummary[], answers: Parameters<typeof fakeClient>[1] = {}) {
  await page.viewport(1360, 820);
  const fake = fakeClient(
    {
      projects: [PROJECT],
      workspaces: [
        workspace({
          id: LOCAL,
          kind: "local",
          branch: "main",
          dir: "/work/atrium",
          createdAt: null,
          external: false,
          merge: null,
        }),
      ],
      sessions: [session({ sessionId: "s1", containerId: LOCAL, prompt: "语音输入方案" })],
      layout: { container: LOCAL, tabs: { [LOCAL]: { open: ["s1"], active: "s1" } } },
    },
    answers,
  );
  fake.schedules.setState({ status: "ready", schedules: [...rules], seq: 1 });
  const screen = await render(
    <Workbench
      client={fake.client}
      status={<span>已连接宿主</span>}
      pickDirectory={undefined}
      setNativeAppearance={() => undefined}
      openUrl={() => undefined}
      reveal={() => undefined}
      pathForFile={undefined}
    />,
  );
  await screen.getByRole("button", { name: "任务", exact: true }).click();
  await screen.getByRole("tab", { name: "定时" }).click();
  return { screen, ...fake };
}

describe("the 定时 tab (SPEC-0006, 界面 · 定时标签; 设计稿第 3 屏)", () => {
  it("shows one rule to a row: name, project and place, time in words, next time, last result, and the actions", async () => {
    const { screen, calls } = await schedules([RULE]);

    await expect.element(screen.getByText("全量变异测试")).toBeVisible();
    const row = screen.getByTestId("rule-row");
    expect(row.element().textContent).toContain("atrium · 每次新建 worktree");
    await expect.element(screen.getByTestId("rule-when")).toHaveTextContent("每天凌晨 2:00");
    await expect.element(screen.getByTestId("rule-next")).toHaveTextContent("下次 1 月 1 日 2:00");
    await expect.element(screen.getByTestId("rule-result")).toHaveTextContent("上次失败");
    const actions = screen.getByTestId("rule-actions").element().textContent;
    expect(actions).toBe("立即跑一次暂停修改");
    // No 新建 anywhere, and no cron.
    expect(screen.container.textContent).not.toContain("新建规则");
    expect(calls).toContain("watchSchedules true");
  });

  it("counts the rules, and says how rules come when there are none", async () => {
    const { screen } = await schedules([RULE, { ...RULE, id: "rul_b", name: "巡检" }]);
    await expect.element(screen.getByRole("heading", { name: "定时" })).toBeVisible();
    expect(screen.getByRole("region", { name: "定时" }).element().textContent).toContain("2");
  });

  it("shows a paused rule dim with 已暂停, 恢复, 修改 and 删除; and the skipped triggers under its name", async () => {
    const { screen } = await schedules([{ ...RULE, paused: true, nextAt: null, skipped: 1, place: "local_readonly" }]);
    await expect.element(screen.getByTestId("rule-result")).toHaveTextContent("已暂停");
    await expect.element(screen.getByTestId("rule-next")).toHaveTextContent("—");
    expect(screen.getByTestId("rule-row").element().textContent).toContain(
      "atrium · 只读，在本地目录跑 · 跳过 1 次 · 上次还在跑",
    );
    expect(screen.getByTestId("rule-actions").element().textContent).toBe("恢复修改删除");
  });

  it("sends 立即跑一次, 暂停 and 恢复 for the rule", async () => {
    const { screen, calls } = await schedules([RULE]);
    await screen.getByRole("button", { name: "立即跑一次" }).click();
    await screen.getByRole("button", { name: "暂停" }).click();
    expect(calls.filter((call) => /^(run|pause|resume|delete|edit)Schedule/u.test(call))).toStrictEqual([
      "runScheduleNow rul_a",
      "pauseSchedule rul_a",
    ]);
  });

  it("sends 恢复 for a paused rule", async () => {
    const { screen, calls } = await schedules([{ ...RULE, paused: true, nextAt: null }]);
    await screen.getByRole("button", { name: "恢复" }).click();
    expect(calls).toContain("resumeSchedule rul_a");
  });

  it("opens the rule's template task for 修改", async () => {
    const { screen, calls } = await schedules([RULE]);
    await screen.getByRole("button", { name: "修改" }).click();
    expect(calls).toContain("editSchedule rul_a");
    await expect.element(screen.getByRole("tab", { name: /tsk_new|任务/ }).first()).toBeVisible();
    expect(calls).toContain("openTask tsk_new");
  });

  it("asks again before deleting, in the row: 不了 goes back and sends nothing, 确定 deletes", async () => {
    const { screen, calls } = await schedules([{ ...RULE, paused: true, nextAt: null }]);
    await screen.getByRole("button", { name: "删除" }).click();
    await expect.element(screen.getByText("删除这条规则？")).toBeVisible();
    expect(calls.some((call) => call.startsWith("deleteSchedule"))).toBe(false);
    await screen.getByRole("button", { name: "不了" }).click();
    expect(screen.container.textContent).not.toContain("删除这条规则？");
    await screen.getByRole("button", { name: "删除" }).click();
    await screen.getByRole("button", { name: "确定" }).click();
    expect(calls).toContain("deleteSchedule rul_a");
  });

  it("words a failed command under the row", async () => {
    const { screen } = await schedules([RULE], {
      taskCommand: async () => {
        throw new CommandError("schedule_not_found");
      },
    });
    await screen.getByRole("button", { name: "立即跑一次" }).click();
    await expect.element(screen.getByTestId("rule-failure")).toHaveTextContent("这条规则已经不在了");
  });

  it.each([
    { saved: false, discard: true },
    { saved: true, discard: false },
  ])(
    "the template's start button says 确认并保存规则 and saves the rule (saved: $saved)",
    async ({ saved, discard }) => {
      const { screen, calls, taskStateOf } = await schedules([RULE]);
      await screen.getByRole("button", { name: "修改" }).click();
      taskStateOf("tsk_new").setState({
        status: "ready",
        task: view("new", [node("N1", { name: "查日志" })], [], {
          status: "designing",
          scheduleDraft: { when: RULE.when, place: "new_worktree", saved },
        }),
      });
      await expect.element(screen.getByRole("button", { name: "确认并保存规则" })).toBeVisible();
      expect(screen.container.textContent).not.toContain("确认并启动");
      expect(screen.container.textContent?.includes("放弃任务")).toBe(discard);
      await screen.getByRole("button", { name: "确认并保存规则" }).click();
      await expect.poll(() => calls).toContain("startTask tsk_new");
    },
  );

  it("asks about deleting on its own line below the row, so the name column keeps its width", async () => {
    const { screen } = await schedules([{ ...RULE, paused: true, nextAt: null, place: "local_readonly", skipped: 1 }]);
    const name = () => screen.getByTestId("rule-name").element().getBoundingClientRect().width;
    const before = name();
    await screen.getByRole("button", { name: "删除" }).click();
    const asking = screen.getByTestId("confirm-asking").element().getBoundingClientRect();
    const row = screen.getByTestId("rule-row").element().getBoundingClientRect();
    expect(name()).toBe(before);
    // Below the row, inside the same card.
    expect(asking.top).toBeGreaterThanOrEqual(row.bottom);
    expect(asking.bottom).toBeLessThanOrEqual(screen.getByTestId("rule-card").element().getBoundingClientRect().bottom);
  });

  it("puts the focus on 确定 when it asks, and Esc goes back", async () => {
    const { screen, calls } = await schedules([{ ...RULE, paused: true, nextAt: null }]);
    await screen.getByRole("button", { name: "删除" }).click();
    expect(document.activeElement?.textContent).toBe("确定");
    await userEvent.keyboard("{Escape}");
    expect(screen.container.textContent).not.toContain("删除这条规则？");
    expect(calls.some((call) => call.startsWith("deleteSchedule"))).toBe(false);
  });
});
