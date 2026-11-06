import type { SessionView } from "@atrium/client";
import type { Notice, TaskNode, TaskNodeState, TaskSummary, TaskView, TranscriptItem } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { PROJECT, fakeClient, session, workspace } from "../test/fake-client";
import { Workbench } from "../app/workbench";
import { MINUTE, node, summary, view } from "./task-fixtures";

const LOCAL = "wks_000000000000000a";
const FEATURE = "wks_000000000000000b";

/** A list with the project, its local workspace and a feature worktree, and a conversation to come back to. */
function list() {
  return {
    projects: [PROJECT],
    workspaces: [
      workspace({ id: FEATURE, branch: "首页首屏加载提速", createdAt: 5 }),
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
    sessions: [
      session({ sessionId: "s1", containerId: LOCAL, prompt: "语音输入方案" }),
      session({ sessionId: "s2", containerId: LOCAL, prompt: "需求对话" }),
    ],
    layout: { container: LOCAL, tabs: { [LOCAL]: { open: ["s1"], active: "s1" } } },
  };
}

/**
 * Renders the workbench over a fake client with tasks.
 *
 * @sideEffects Renders.
 * @param tasks - The task rows.
 * @returns The screen and the fake.
 */
async function board(tasks: readonly TaskSummary[] = []) {
  await page.viewport(1360, 820);
  const fake = fakeClient(list());
  fake.tasks.setState({ status: "ready", tasks: [...tasks], seq: 1 });
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
  return { screen, ...fake };
}

/** Opens the task area from the sidebar. */
async function openArea(screen: Awaited<ReturnType<typeof board>>["screen"]) {
  await screen.getByRole("button", { name: "任务", exact: true }).click();
}

const GROUPS = (screen: Awaited<ReturnType<typeof board>>["screen"]) =>
  [...screen.container.querySelectorAll('[data-testid="task-group"]')].map((group) => [
    (group as HTMLElement).dataset["group"],
    [...group.querySelectorAll('[data-testid="task-row"]')].map((row) => (row as HTMLElement).dataset["task"]),
  ]);

describe("the sidebar's task entry (SPEC-0006, 界面 · 入口)", () => {
  it("sits under the search with the number of tasks that want you, and shows the task area when pressed", async () => {
    const { screen } = await board([
      summary("a", { status: "waiting", attention: "human" }),
      summary("b", { status: "designing" }),
      summary("c", { status: "running" }),
    ]);

    await expect.element(screen.getByTestId("tasks-attention")).toHaveTextContent("2");
    const entry = screen.getByRole("button", { name: "任务", exact: true });
    expect(entry.element().compareDocumentPosition(screen.getByLabelText("搜索工作区、对话和会话").element())).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
    await entry.click();

    await expect.element(screen.getByTestId("task-tab-bar")).toBeVisible();
    await expect.element(entry).toHaveAttribute("aria-current", "true");
    expect(screen.container.querySelector('[data-testid="tab-bar"]')).toBeNull();
  });

  it("shows no count when no task wants you, and leaves the area when a conversation is chosen", async () => {
    const { screen } = await board([summary("c", { status: "running" })]);
    expect(screen.container.querySelector('[data-testid="tasks-attention"]')).toBeNull();

    await openArea(screen);
    await screen.getByText("main", { exact: true }).click();

    expect(screen.container.querySelector('[data-testid="task-tab-bar"]')).toBeNull();
    await expect.element(screen.getByTestId("tab-bar")).toBeVisible();
  });
});

describe("the task area's tabs (SPEC-0006, 界面 · 入口)", () => {
  it("has 任务 and 定时 first, with no close button on either, and the task list showing", async () => {
    const { screen } = await board([summary("a")]);
    await openArea(screen);

    const tabs = screen.getByRole("tablist", { name: "任务区" }).element();
    expect([...tabs.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toStrictEqual(["任务", "定时"]);
    expect(tabs.querySelector("button")).toBeNull();
    await expect.element(screen.getByRole("tab", { name: "任务" })).toHaveAttribute("aria-selected", "true");
    await expect.element(screen.getByRole("region", { name: "任务列表" })).toBeVisible();
  });

  it("shows the schedules' empty state under 定时", async () => {
    const { screen } = await board([summary("a")]);
    await openArea(screen);
    await screen.getByRole("tab", { name: "定时" }).click();

    await expect.element(screen.getByText("还没有定时规则", { exact: false })).toBeVisible();
    await expect.element(screen.getByRole("tab", { name: "定时" })).toHaveAttribute("aria-selected", "true");
  });

  it("opens a task as a tab after them with a close button, closing it leaves the list and the task alone", async () => {
    const { screen, tasks } = await board([summary("a", { name: "首页首屏加载提速" })]);
    await openArea(screen);
    await screen.getByTestId("task-row").click();

    const tab = screen.getByRole("tab", { name: /首页首屏加载提速/ });
    await expect.element(tab).toHaveAttribute("aria-selected", "true");
    await screen.getByRole("button", { name: "关闭 首页首屏加载提速" }).click();

    await expect.element(screen.getByRole("tab", { name: "任务" })).toHaveAttribute("aria-selected", "true");
    expect(tasks.getState().tasks).toHaveLength(1);
    expect(screen.container.querySelectorAll('[role="tab"]')).toHaveLength(2);
  });
});

describe("the task list (SPEC-0006, 界面 · 任务列表; 设计稿第 2 屏)", () => {
  it("lists attention first, then running, then done, each row with name, place, node, time and state", async () => {
    const { screen } = await board([
      summary("done", {
        status: "done",
        endedAt: Date.now() - 60 * MINUTE,
        name: "README 截图刷新",
        projectId: PROJECT.id,
        workspaceId: FEATURE,
      }),
      summary("run", {
        name: "Worktree 中文命名失败时回退分支名",
        projectId: PROJECT.id,
        workspaceId: FEATURE,
        activeAt: Date.now() - 2 * MINUTE,
        current: { id: "N2", name: "实现", state: "running" },
      }),
      summary("ask", {
        status: "waiting",
        attention: "question",
        name: "首页首屏加载提速",
        projectId: PROJECT.id,
        workspaceId: FEATURE,
        activeAt: Date.now() - 4 * MINUTE,
        current: { id: "N2", name: "实现", state: "waiting" },
      }),
      summary("design", { status: "designing", name: "手机端支持语音输入", projectId: PROJECT.id }),
      summary("chat", {
        name: "竞品语音输入方案调研",
        projectId: null,
        current: { id: "N2", name: "写报告", state: "running" },
      }),
    ]);
    await openArea(screen);

    expect(GROUPS(screen)).toStrictEqual([
      ["attention", ["tsk_ask", "tsk_design"]],
      ["running", ["tsk_chat", "tsk_run"]],
      ["done", ["tsk_done"]],
    ]);
    const ask = screen.container.querySelector('[data-task="tsk_ask"]') as HTMLElement;
    expect(ask.textContent).toContain("首页首屏加载提速");
    expect(ask.textContent).toContain("atrium · 首页首屏加载提速");
    expect(ask.textContent).toContain("N2 实现");
    expect(ask.textContent).toContain("4 分钟前");
    expect(ask.textContent).toContain("等你回答");
    expect(ask.dataset["attention"]).toBe("question");
    const design = screen.container.querySelector('[data-task="tsk_design"]') as HTMLElement;
    expect(design.textContent).toContain("设计中");
    expect(design.textContent).toContain("等你确认初始图");
    expect((screen.container.querySelector('[data-task="tsk_chat"]') as HTMLElement).textContent).toContain(
      "对话 · 不属于项目",
    );
    const headings = [...screen.container.querySelectorAll("h3")].map((heading) =>
      heading.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(headings).toStrictEqual(["待我介入 · 2", "运行中 · 2", "已完成 · 1"]);
  });

  it("words each way a task stops or waits: failed, blocked merge, human, paused, graph change", async () => {
    const { screen } = await board([
      summary("f", { status: "stopped", attention: "failed", current: { id: "N4b", name: "审查", state: "failed" } }),
      summary("m", { status: "waiting", attention: "merge_blocked" }),
      summary("h", { status: "waiting", attention: "human" }),
      summary("p", { status: "stopped", paused: true }),
      summary("g", { status: "waiting", attention: "graph_change" }),
    ]);
    await openArea(screen);

    const words = [...screen.container.querySelectorAll('[data-testid="task-row"]')].map((row) => [
      (row as HTMLElement).dataset["task"],
      row.querySelector('[data-testid="task-status"]')?.textContent,
    ]);
    expect(words).toStrictEqual([
      ["tsk_f", "N4b 失败 · 已停下"],
      ["tsk_m", "合并被挡住"],
      ["tsk_h", "等你验收"],
      ["tsk_g", "等你批准改图"],
      ["tsk_p", "已暂停"],
    ]);
  });

  it("shows the last seven days of finished tasks, five at most, and the rest behind 显示全部", async () => {
    const done = Array.from({ length: 7 }, (_, index) =>
      summary(`d${index}`, { status: "done", name: `完成 ${index}`, endedAt: Date.now() - (index + 1) * 60 * MINUTE }),
    );
    const { screen } = await board([
      ...done,
      summary("old", { status: "done", name: "旧的", endedAt: Date.now() - 9 * 86_400_000 }),
    ]);
    await openArea(screen);

    expect(GROUPS(screen)[0]?.[1]).toHaveLength(5);
    await screen.getByRole("button", { name: "显示全部 8 个" }).click();
    expect(GROUPS(screen)[0]?.[1]).toHaveLength(8);
    await screen.getByRole("button", { name: "收起" }).click();
    expect(GROUPS(screen)[0]?.[1]).toHaveLength(5);
  });

  it("draws the list inside a card, with the waiting icon before what you are wanted for and the failed icon before a failure", async () => {
    const { screen } = await board([
      summary("q", { status: "waiting", attention: "question" }),
      summary("f", { status: "stopped", attention: "failed", current: { id: "N4b", name: "审查", state: "failed" } }),
      summary("r", { status: "running" }),
      summary("x", { status: "done", endedAt: Date.now() - MINUTE }),
    ]);
    await openArea(screen);
    const iconOf = (task: string) =>
      screen.container
        .querySelector(`[data-task="${task}"] [data-testid="task-status"]`)
        ?.parentElement?.querySelector("[data-state]")
        ?.getAttribute("data-state");

    expect(screen.container.querySelector('[data-testid="task-card"] [data-testid="task-group"]')).not.toBeNull();
    expect([iconOf("tsk_q"), iconOf("tsk_f"), iconOf("tsk_r"), iconOf("tsk_x")]).toStrictEqual([
      "waiting",
      "failed",
      undefined,
      undefined,
    ]);
  });

  it("filters by project, and by no project", async () => {
    const { screen } = await board([
      summary("a", { name: "项目里的", projectId: PROJECT.id }),
      summary("b", { name: "对话里的", projectId: null }),
    ]);
    await openArea(screen);

    await screen.getByRole("button", { name: "按项目筛选" }).click();
    await page.getByRole("menuitemradio", { name: "atrium" }).click();
    expect(GROUPS(screen).flatMap(([, rows]) => rows)).toStrictEqual(["tsk_a"]);

    await screen.getByRole("button", { name: "按项目筛选" }).click();
    await page.getByRole("menuitemradio", { name: "不属于项目" }).click();
    expect(GROUPS(screen).flatMap(([, rows]) => rows)).toStrictEqual(["tsk_b"]);

    await screen.getByRole("button", { name: "按项目筛选" }).click();
    await page.getByRole("menuitemradio", { name: "全部" }).click();
    expect(GROUPS(screen).flatMap(([, rows]) => rows)).toHaveLength(2);
  });

  it("says so when there is no task, and when the filter leaves none", async () => {
    const { screen } = await board([]);
    await openArea(screen);
    await expect.element(screen.getByText("还没有任务", { exact: false })).toBeVisible();
  });

  it("marks a task a schedule made with the clock", async () => {
    const { screen } = await board([summary("s", { scheduled: true, name: "全量变异测试 · 11 月 4 日" })]);
    await openArea(screen);

    expect(screen.container.querySelector('[data-task="tsk_s"] [aria-label="定时触发的任务"]')).not.toBeNull();
  });
});

/** Opens the task by pressing its row, after giving the fake the whole task the host would answer. */
async function openTask(
  task: TaskView,
  rows: readonly TaskSummary[] = [summary(task.id.slice(4), { name: task.name })],
) {
  const shown = await board(rows);
  shown.taskStateOf(task.id).setState({ status: "ready", task });
  await openArea(shown.screen);
  await shown.screen.getByTestId("task-row").click();
  return shown;
}

const T0 = new Date(2026, 10, 6, 10, 2).getTime();
const at = (minutes: number) => T0 + minutes * MINUTE;
const hhmm = (time: number) =>
  new Date(time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

/** Opens a task whose conversation holds `items`. */
async function conversation(items: readonly TranscriptItem[]) {
  const task = view(
    "conv",
    [node("N1", { name: "调研与方案" }), node("N2", { name: "核心实现与自检" })],
    [["N1", "N2"]],
    {
      taskSessionId: "ses_conv",
    },
  );
  const shown = await board([summary("conv", { name: "任务" })]);
  shown.taskStateOf("tsk_conv").setState({ status: "ready", task });
  await openArea(shown.screen);
  await shown.screen.getByTestId("task-row").click();
  await expect.poll(() => shown.client.session("ses_conv")).toBeDefined();
  shown.client.session("ses_conv")?.setState({ items: [...items] } as Partial<SessionView>);
  return shown;
}

const mark = (id: string, state: "converted" | "abandoned"): Notice => ({
  kind: "notice",
  id,
  notice: "task_mark",
  taskId: "tsk_made",
  state,
  timestamp: 1,
});

/** Shows conversation s1 with `items`. */
async function source(items: readonly Notice[], tasks: readonly TaskSummary[]) {
  const shown = await board(tasks);
  await expect.poll(() => shown.client.session("s1")).toBeDefined();
  shown.client.session("s1")?.setState({ items: [...items] } as Partial<SessionView>);
  return shown;
}

/** One node of each state, a human node last, with its send-back edge. */
const EVERY_STATE: readonly TaskNode[] = (
  ["pending", "running", "waiting", "passed", "held", "stopped", "failed"] as const satisfies readonly TaskNodeState[]
).map((state, index) => node(`N${index + 1}`, { name: `节点${state}`, state }));

describe("a task's tab (SPEC-0006, 界面 · 任务标签; 设计稿第 4、5 屏)", () => {
  it("draws each node with its state's own icon, name, role and place, and the legend names every state", async () => {
    const task = view(
      "run",
      EVERY_STATE,
      EVERY_STATE.slice(1).map((one, index) => [`N${index + 1}`, one.id]),
      { name: "运行中的任务" },
    );
    const { screen } = await openTask(task);

    const states = [...screen.container.querySelectorAll('[data-testid="graph-node"]')].map(
      (one) => (one as HTMLElement).dataset["state"],
    );
    expect(states).toStrictEqual(["pending", "running", "waiting", "passed", "held", "stopped", "failed"]);
    const first = screen.container.querySelector('[data-node="N1"]') as HTMLElement;
    expect(first.textContent).toContain("N1");
    expect(first.textContent).toContain("节点pending");
    expect(first.textContent).toContain("work · 任务 worktree");
    const legend = [...screen.container.querySelectorAll("ul li")].map((one) => one.textContent);
    expect(legend).toStrictEqual(["未开始", "运转中", "等你", "通过", "已挂起", "你停下的", "失败，任务停下"]);
    expect(screen.container.querySelectorAll('[data-testid="graph-edge"]')).toHaveLength(6);
  });

  it("writes a node's own model in the tint colour and one it follows grey with 继承, and a human node none", async () => {
    const task = view("m", [
      node("N1", { model: null }),
      node("N2", { model: { providerId: "x", modelId: "gpt-6-astra" } }),
      node("N3", { kind: "human", role: undefined, place: undefined }),
    ]);
    const { screen } = await openTask(task);

    const own = (id: string) =>
      screen.container.querySelector(`[data-node="${id}"] [data-testid="graph-node-model"]`) as HTMLElement | null;
    expect(own("N1")?.textContent).toBe("继承 · opus-5.5 · 高");
    expect(own("N1")?.dataset["own"]).toBe("false");
    expect(own("N2")?.textContent).toBe("gpt-6-astra");
    expect(own("N2")?.dataset["own"]).toBe("true");
    expect(getComputedStyle(own("N2") as Element).color).not.toBe(getComputedStyle(own("N1") as Element).color);
    expect(own("N3")).toBeNull();
    expect(screen.container.querySelector('[data-node="N3"]')?.textContent).toContain("由你来做");
  });

  it("outlines the node pressed, moves the outline to another, and clears it on the blank", async () => {
    const task = view("sel", [node("N1"), node("N2")], [["N1", "N2"]]);
    const { screen } = await openTask(task);
    const pressed = (id: string) =>
      (screen.container.querySelector(`[data-node="${id}"]`) as HTMLElement).getAttribute("aria-pressed");

    await userEvent.click(screen.container.querySelector('[data-node="N1"]') as HTMLElement);
    expect([pressed("N1"), pressed("N2")]).toStrictEqual(["true", "false"]);
    await userEvent.click(screen.container.querySelector('[data-node="N2"]') as HTMLElement);
    expect([pressed("N1"), pressed("N2")]).toStrictEqual(["false", "true"]);
    await userEvent.click(screen.getByTestId("graph-pane"), { position: { x: 4, y: 4 } });
    expect([pressed("N1"), pressed("N2")]).toStrictEqual(["false", "false"]);
  });

  it("floats what a node does and what counts as done on hover, with why it failed or waits", async () => {
    const task = view("hover", [
      node("N1", {
        job: "把 BranchNamer 的回退改成英文分支名",
        done: ["回退名全是 ASCII", "测试通过"],
        state: "failed",
        failure: "no_done",
      }),
      node("N2", {
        kind: "human",
        state: "waiting",
        waitingFor: "merge_blocked",
        blocked: "merge_conflict",
        blockedFiles: ["a.ts", "b.ts"],
      }),
    ]);
    const { screen } = await openTask(task);
    await userEvent.hover(screen.container.querySelector('[data-node="N1"]') as HTMLElement);

    const card = screen.container
      .querySelector('[data-node="N1"]')
      ?.parentElement?.querySelector('[role="tooltip"]') as HTMLElement;
    await expect.element(card).toBeVisible();
    expect(card.textContent).toContain("把 BranchNamer 的回退改成英文分支名");
    expect(card.textContent).toContain("回退名全是 ASCII");
    expect(card.textContent).toContain("测试通过");
    expect(card.textContent).toContain("失败：没有交 node_done 就结束了");
    const blocked = screen.container
      .querySelector('[data-node="N2"]')
      ?.parentElement?.querySelector('[role="tooltip"]') as HTMLElement;
    expect(blocked.textContent).toContain("合并被挡住：有文件冲突（2 个文件）");
  });

  it("shows a designing task's draft graph with its version, the model of the task, the place and the link to the source", async () => {
    const task = view(
      "design",
      [node("N1", { name: "调研与原型", role: "explore", place: "readonly" }), node("N2")],
      [["N1", "N2"]],
      {
        name: "手机端支持语音输入",
        status: "designing",
        graphVersion: 2,
        projectId: PROJECT.id,
        workspaceId: FEATURE,
      },
    );
    const { screen } = await openTask(task, [summary("design", { name: "手机端支持语音输入", status: "designing" })]);

    await expect.element(screen.getByTestId("task-name")).toHaveTextContent("手机端支持语音输入");
    await expect.element(screen.getByTestId("task-bar-status")).toHaveTextContent("设计中");
    await expect.element(screen.getByTestId("task-model")).toHaveTextContent("任务模型 opus-5.5 · 高");
    await expect.element(screen.getByTestId("graph-version")).toHaveTextContent("图 v2");
    await expect.element(screen.getByText("atrium · 首页首屏加载提速")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "需求对话 ›" })).toBeVisible();
    expect(screen.container.querySelectorAll('[data-testid="graph-node"]')).toHaveLength(2);
  });

  it("fits a graph three nodes wide in the pane at the default window width, shrunk but not below its floor, and shows the version once", async () => {
    const wide = view(
      "wide",
      [
        node("N1"),
        node("N2"),
        node("N3"),
        node("N4"),
        node("N5", { kind: "human", role: undefined, place: undefined }),
      ],
      [
        ["N1", "N2"],
        ["N1", "N3"],
        ["N1", "N4"],
        ["N2", "N5"],
        ["N3", "N5"],
        ["N4", "N5"],
        ["N5", "N2", "back"],
      ],
      { graphVersion: 2 },
    );
    const { screen } = await openTask(wide);
    await page.viewport(1280, 820);
    const paneRight = () => screen.getByTestId("graph-pane").element().getBoundingClientRect().right;
    const nodes = () => [...screen.container.querySelectorAll('[data-testid="graph-node"]')];
    const canvas = screen.getByTestId("graph-canvas").element() as HTMLElement;

    await expect
      .poll(() => Math.max(...nodes().map((one) => one.getBoundingClientRect().right)) <= paneRight())
      .toBe(true);
    expect(Number(canvas.dataset["scale"])).toBeLessThan(1);
    expect(Number(canvas.dataset["scale"])).toBeGreaterThanOrEqual(0.7);
    expect(Math.min(...nodes().map((one) => one.getBoundingClientRect().left))).toBeGreaterThanOrEqual(
      screen.getByTestId("graph-pane").element().getBoundingClientRect().left,
    );
    expect(screen.container.querySelectorAll('[data-testid="graph-version"]')).toHaveLength(1);
    expect(screen.container.textContent.split("图 v2")).toHaveLength(2);
  });

  it("stops shrinking a graph at its floor and scrolls the pane sideways below it", async () => {
    const wide = view(
      "floor",
      [
        node("N1"),
        node("N2"),
        node("N3"),
        node("N4"),
        node("N5", { kind: "human", role: undefined, place: undefined }),
      ],
      [
        ["N1", "N2"],
        ["N1", "N3"],
        ["N1", "N4"],
        ["N2", "N5"],
        ["N3", "N5"],
        ["N4", "N5"],
        ["N5", "N2", "back"],
      ],
    );
    const { screen } = await openTask(wide);
    await page.viewport(900, 820);
    const canvas = screen.getByTestId("graph-canvas").element() as HTMLElement;
    const pane = screen.getByTestId("graph-pane").element();

    await expect.poll(() => Number(canvas.dataset["scale"])).toBe(0.7);
    expect(pane.scrollWidth).toBeGreaterThan(pane.clientWidth);
  });

  it("goes back to the source conversation from the link, leaving the task area", async () => {
    const task = view("src", [node("N1")], [], { sourceSessionId: "s2" });
    const { screen, calls } = await openTask(task);
    await screen.getByRole("button", { name: "需求对话 ›" }).click();

    expect(calls).toContain("openSession s2");
    expect(screen.container.querySelector('[data-testid="task-tab-bar"]')).toBeNull();
  });

  it("opens the task on the client and watches its conversation by id, with no input box and no task buttons", async () => {
    const task = view("ro", [node("N1")], [], { taskSessionId: "ses_conv" });
    const { screen, calls } = await openTask(task);

    expect(calls).toContain("openTask tsk_ro");
    expect(calls).toContain("watch ses_conv");
    expect(screen.container.querySelector("textarea, [role=textbox]")).toBeNull();
    for (const name of ["确认并启动", "放弃任务", "暂停任务", "取消任务"]) {
      expect(screen.container.querySelector(`button[aria-label="${name}"]`)).toBeNull();
      expect([...screen.container.querySelectorAll("button")].some((button) => button.textContent === name)).toBe(
        false,
      );
    }
  });

  it("says a followed task is read-only in the conversation pane instead of waiting to read, and does not watch its conversation", async () => {
    const task = view("fol", [node("N1")], [], { taskSessionId: "ses_followed", followed: true });
    const { screen, calls } = await openTask(task);

    await expect.element(screen.getByText("这个任务是别的进程在跑的，Atrium 只读它的图和节点状态。")).toBeVisible();
    await expect.element(screen.getByText("任务对话和各节点的对话不在 Atrium 里，这里看不到。")).toBeVisible();
    expect(screen.container.textContent).not.toContain("正在读取任务对话");
    expect(calls).not.toContain("watch ses_followed");
    expect(screen.container.querySelector("textarea, [role=textbox]")).toBeNull();
  });

  it("says in words that a task is not there when the host does not know it, and reads while it asks", async () => {
    const shown = await board([summary("gone", { name: "没了的任务" })]);
    await openArea(shown.screen);
    await shown.screen.getByTestId("task-row").click();
    await expect.element(shown.screen.getByText("正在读取任务…")).toBeVisible();

    shown.taskStateOf("tsk_gone").setState({ status: "missing", task: null });
    await expect.element(shown.screen.getByText("这个任务已经不在了")).toBeVisible();
  });

  it("follows the host: a node turns from running to passed and the next begins, without a reload", async () => {
    const task = view("live", [node("N1", { state: "running" }), node("N2")], [["N1", "N2"]]);
    const { screen, taskStateOf } = await openTask(task);
    const states = () =>
      [...screen.container.querySelectorAll('[data-testid="graph-node"]')].map(
        (one) => (one as HTMLElement).dataset["state"],
      );
    expect(states()).toStrictEqual(["running", "pending"]);

    taskStateOf("tsk_live").setState({
      status: "ready",
      task: view("live", [node("N1", { state: "passed" }), node("N2", { state: "running" })], [["N1", "N2"]]),
    });

    await expect.poll(states).toStrictEqual(["passed", "running"]);
  });

  it("asks for the worktree's changes while a human node waits and shows them on its card", async () => {
    const task = view(
      "human",
      [node("N1", { state: "passed" }), node("N2", { kind: "human", state: "waiting", waitingFor: "human" })],
      [["N1", "N2"]],
      {
        workspaceId: FEATURE,
      },
    );
    const { screen, changeCalls, client } = await openTask(task);
    client
      .changes(FEATURE)
      .setState({ stat: { added: 48, removed: 8 }, dirty: false, ahead: 2, branch: "x", base: "origin/main" });
    await userEvent.hover(screen.container.querySelector('[data-node="N2"]') as HTMLElement);

    expect(changeCalls).toContain(`watchChanges ${FEATURE}`);
    await expect.element(screen.getByTestId("graph-node-stat")).toHaveTextContent("改动 +48 −8");
  });
});

/** A progress line the host wrote. */
function progress(id: string, time: number, what: string, nodeId: string | null): Notice {
  return { kind: "notice", id, notice: "task_progress", what, node: nodeId, timestamp: time };
}

/** A turn the user opened. */
function turn(id: string, text: string, time: number): TranscriptItem {
  return {
    kind: "turn",
    id,
    source: null,
    user: { text, images: 0, clientMessageId: null, auto: false, command: null, timestamp: time },
    steps: [{ kind: "text", id: `${id}-t`, text: `回答 ${id}` }],
    outcome: "done",
    error: null,
    startedAt: time,
    durationMs: 1000,
    usage: null,
    changes: [],
  };
}

describe("the task conversation's progress and records (SPEC-0006, 任务对话的进度和记录折叠)", () => {
  it("keeps the latest group of progress lines open as steps on the rail, and folds an earlier group to one grey line", async () => {
    const { screen } = await conversation([
      progress("p1", at(0), "node_started", "N1"),
      progress("p2", at(20), "node_passed", "N1"),
      progress("p3", at(30), "node_started", "N2"),
      turn("t1", "现在到哪一步了？", at(35)),
      progress("p4", at(40), "node_failed", "N2"),
      progress("p5", at(41), "node_waiting", "N2"),
    ]);

    await expect.poll(() => screen.container.querySelectorAll('[data-testid="task-progress"]').length).toBe(2);
    const groups = [...screen.container.querySelectorAll('[data-testid="task-progress"]')] as HTMLElement[];
    expect(groups.map((group) => group.dataset["open"])).toStrictEqual(["false", "true"]);
    expect(groups[0]?.textContent).toBe(`任务进度 · 1 个节点通过 · ${hhmm(at(0))}–${hhmm(at(30))}`);
    const rows = [...(groups[1] as HTMLElement).querySelectorAll<HTMLElement>('[data-testid="task-progress-row"]')];
    expect(rows.map((row) => [row.dataset["tone"], row.textContent])).toStrictEqual([
      ["fail", `N2 核心实现与自检 失败${hhmm(at(40))}`],
      ["wait", `N2 核心实现与自检 等你${hhmm(at(41))}`],
    ]);
    expect(groups[1]?.querySelector('[data-node="fail"]')).not.toBeNull();
    expect(groups[1]?.querySelector('[data-node="ask"]')).not.toBeNull();
  });

  it("opens a folded group when pressed and folds it again, and keeps the choice when a line is added", async () => {
    const { screen, client } = await conversation([
      progress("p1", at(0), "node_started", "N1"),
      turn("t1", "进度？", at(5)),
      progress("p2", at(6), "node_passed", "N1"),
    ]);
    const first = () => screen.container.querySelectorAll('[data-testid="task-progress"]')[0] as HTMLElement;
    await expect.poll(() => first()?.dataset["open"]).toBe("false");

    await userEvent.click(first().querySelector("button") as HTMLElement);
    expect(first().dataset["open"]).toBe("true");
    expect(first().querySelectorAll('[data-testid="task-progress-row"]')).toHaveLength(1);

    client.session("ses_conv")?.setState((state: SessionView) => ({
      ...state,
      items: [...state.items, progress("p3", at(7), "merged", null)],
    }));
    expect(first().dataset["open"]).toBe("true");
    await userEvent.click(first().querySelector("button") as HTMLElement);
    await expect.poll(() => first().dataset["open"]).toBe("false");
  });

  it("folds the group that was going on when a newer one begins after a turn", async () => {
    const { screen, client } = await conversation([progress("p1", at(0), "node_started", "N1")]);
    const open = () =>
      [...screen.container.querySelectorAll('[data-testid="task-progress"]')].map(
        (group) => (group as HTMLElement).dataset["open"],
      );
    await expect.poll(open).toStrictEqual(["true"]);

    client.session("ses_conv")?.setState((state: SessionView) => ({
      ...state,
      items: [...state.items, turn("t1", "好", at(3)), progress("p2", at(4), "node_passed", "N1")],
    }));

    await expect.poll(open).toStrictEqual(["false", "true"]);
  });

  it("draws a node's hover card above the conversation, not under its copy icons", async () => {
    const { screen } = await conversation([turn("t1", "进度？", at(1))]);
    await userEvent.hover(screen.container.querySelector('[data-node="N1"]') as HTMLElement);
    const card = screen.container
      .querySelector('[data-node="N1"]')
      ?.parentElement?.querySelector('[role="tooltip"]') as HTMLElement;
    await expect.element(card).toBeVisible();
    const box = card.getBoundingClientRect();

    for (const [x, y] of [
      [box.left + 20, box.top + 12],
      [box.right - 20, box.top + 12],
      [box.right - 20, box.bottom - 12],
    ] as const) {
      expect(document.elementFromPoint(x, y)?.closest('[role="tooltip"]')).toBe(card);
    }
  });

  it("shows the host's long instruction for designing as one line, not as the user's message", async () => {
    const { screen } = await conversation([
      turn("t0", `<atrium-task-design>\n很长的引导词\n</atrium-task-design>`, at(0)),
    ]);

    await expect.element(screen.getByText("（设计任务的指示：整理需求摘要，选引导词，画初始图）")).toBeVisible();
    expect(screen.container.textContent).not.toContain("很长的引导词");
  });
});

describe("the line a conversation shows once it became a task (SPEC-0006, /task 与创建)", () => {
  it("says 已转为任务 with its name and state and opens the task's tab from 打开", async () => {
    const { screen } = await source(
      [mark("m1", "converted")],
      [summary("made", { name: "手机端支持语音输入", status: "designing" })],
    );
    const line = screen.container.querySelector('[data-mark="converted"]') as HTMLElement;

    expect(line.textContent).toContain("已转为任务「手机端支持语音输入」");
    expect(line.textContent).toContain("等你确认初始图");
    await screen.getByRole("button", { name: "打开 ›" }).click();

    await expect
      .element(screen.getByRole("tab", { name: /手机端支持语音输入/ }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("shows only the latest mark of a task: 任务已放弃 after 已转为任务", async () => {
    const { screen } = await source([mark("m1", "converted"), mark("m2", "abandoned")], []);

    const lines = [...screen.container.querySelectorAll("[data-mark]")] as HTMLElement[];
    expect(lines.map((line) => [line.dataset["mark"], line.textContent])).toStrictEqual([["abandoned", "任务已放弃"]]);
  });
});
