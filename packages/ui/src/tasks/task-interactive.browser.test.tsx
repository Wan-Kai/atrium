import { CommandError, type SessionView } from "@atrium/client";
import { IDLE_CONTROL, type Notice, type PendingReview, type TaskView } from "@atrium/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { FEATURE, board, openTab, refuseOn, rejectOn } from "./task-board-support";
import type { FakeAnswers } from "../test/fake-client";
import { node, summary, view } from "./task-fixtures";
import { pageDrafts } from "../state/use-draft";
import { forgetReviewDrafts } from "../chat/review-state";

/**
 * A refusal that comes after the box has been cleared, as the host's answer does over a socket.
 *
 * @sideEffects Sets a timer.
 * @param code - The error code.
 * @returns A promise that rejects.
 */
function refusedLater(code: "session_not_found"): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new CommandError(code)), 30);
  });
}

/** The connection of a host instance, as the client reports it once connected. */
const connected = (hostInstanceId: string) =>
  ({ status: "connected", traceId: "t", hostVersion: "0", hostInstanceId, installSeed: 1, logDir: "/l" }) as const;

/**
 * Waits for what was set to be drawn.
 *
 * @sideEffects Waits 30 ms.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

/** The banner's words over a task's graph, or `null` while the current graph is shown. */
const banner = (screen: { container: HTMLElement }) =>
  screen.container.querySelector('[data-testid="graph-proposed"]')?.textContent ?? null;

/** The change figures and the upstream summary a human node waits with. */
function humanReview(changes: Partial<PendingReview> = {}): PendingReview {
  return {
    id: "rv_h",
    openedAt: 10,
    source: { kind: "gate", gate: "task_human" },
    subject: { code: "task_human_node", params: { taskId: "tsk_a", node: "N4", merge: true } },
    evidence: [
      { kind: "changes", workspaceId: FEATURE, files: 3, added: 48, removed: 8 },
      { kind: "summary", by: { kind: "node", node: "N3" }, text: "12 项测试通过" },
    ],
    problem: null,
    actions: [
      { id: "pass", reason: "none", targets: [], recommended: true },
      { id: "send_back", reason: "required", targets: [{ id: "N2", remaining: 2 }], recommended: false },
    ],
    ...changes,
  };
}

const GRAPH_REVIEW: PendingReview = {
  id: "rv_g",
  openedAt: 5,
  source: { kind: "gate", gate: "task_graph" },
  subject: { code: "task_graph_change", params: { taskId: "tsk_a", version: 3 } },
  evidence: [{ kind: "graph_diff", from: 2, to: 3, added: ["N1b"], removed: ["N9"], changed: ["N2"] }],
  problem: null,
  actions: [
    { id: "approve", reason: "none", targets: [], recommended: true },
    { id: "reject", reason: "optional", targets: [], recommended: false },
  ],
};

const ARCHIVE_REVIEW: PendingReview = {
  id: "rv_a",
  openedAt: 20,
  source: { kind: "gate", gate: "task_archive" },
  subject: { code: "task_archive", params: { taskId: "tsk_a" } },
  evidence: [{ kind: "facts", facts: [{ code: "worktree_merged", params: { name: "main" }, status: "ok" }] }],
  problem: null,
  actions: [
    { id: "archive", reason: "none", targets: [], recommended: true },
    { id: "keep", reason: "none", targets: [], recommended: false },
  ],
};

/** A task with two nodes started, in the state given, its conversation `ses_conv`, and the fields given. */
function task(changes: Partial<TaskView> = {}): TaskView {
  return view(
    "a",
    [
      node("N1", { name: "调研与方案", state: "passed", sessionId: "ses_n1" }),
      node("N2", { name: "核心实现与自检", state: "running", sessionId: "ses_n2" }),
      node("N4", { name: "验收合并", kind: "human" }),
    ],
    [
      ["N1", "N2"],
      ["N2", "N4"],
    ],
    { taskSessionId: "ses_conv", name: "首页提速", ...changes },
  );
}

/** The words of the buttons in the task bar. */
function buttons(screen: { container: HTMLElement }): string[] {
  return [...screen.container.querySelectorAll('[data-testid="task-buttons"] button')].map(
    (button) => button.textContent,
  );
}

// A message that did not go comes back into its box, and the boxes are the page's: each test starts with them empty.
beforeEach(() => pageDrafts().drop(["ses_conv", "ses_n1", "ses_n2"]));

describe("the composer of the task conversation (SPEC-0006, T8)", () => {
  it("sends a message with prompt on the task conversation's id, never opening it as a session", async () => {
    const { screen, calls } = await openTab(task({ status: "running" }));
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "现在到哪一步了？{Enter}");

    expect(calls).toContain("prompt ses_conv 现在到哪一步了？");
    expect(calls.some((call) => call.startsWith("openSession ses_conv"))).toBe(false);
  });

  it("steers with ⌘+Enter while the round goes on, and stops it from the button", async () => {
    const { screen, calls, client } = await openTab(task({ status: "running" }));
    client.session("ses_conv")?.setState({
      run: { runId: "r1", startedAt: 1 },
    } as Partial<SessionView>);
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "改用另一个方案");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(calls).toContain("steer ses_conv 改用另一个方案");

    await screen.getByRole("button", { name: "停止" }).click();
    expect(calls).toContain("stop ses_conv");
  });

  it("sends the message to the conversation while a review is open, and the review stays", async () => {
    const { screen, calls, client } = await openTab(task({ status: "waiting", reviews: [humanReview()] }));
    client.session("ses_conv")?.setState((state: SessionView) => ({
      ...state,
      control: { ...IDLE_CONTROL, reviews: [humanReview()] },
    }));
    await expect.element(screen.getByTestId("review")).toBeVisible();

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "测试跑了几遍？{Enter}");

    expect(calls).toContain("prompt ses_conv 测试跑了几遍？");
    expect(calls.some((call) => call.startsWith("answerReview"))).toBe(false);
    await expect.element(screen.getByTestId("review")).toBeVisible();
  });

  it("starts the conversation's pi first when it is not running, then sends", async () => {
    // Its pi is not running, so watching it brings no snapshot, as after a restart.
    const shown = await openTab(task({ status: "waiting" }), undefined, { notRunning: ["ses_conv"] });
    await shown.screen.getByRole("tab", { name: "任务" }).click();
    await shown.screen.getByTestId("task-row").click();
    await shown.screen.getByRole("button", { name: "打开任务" }).click();

    await expect.poll(() => shown.calls).toContain("openTaskSession tsk_a ses_conv");
  });

  it("words why a message did not go, above the box", async () => {
    const { screen } = await openTab(task({ status: "running" }), undefined, {
      prompt: () => Promise.reject(new CommandError("session_not_found")),
    });
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "你好{Enter}");

    await expect.element(screen.getByTestId("conversation-failure")).toHaveTextContent("这个对话已经不存在了");
  });

  it("puts a message that did not go back in the box, whether prompt, steer or opening the session refused it (T8 review fix 6)", async () => {
    // The host answers after the box has been cleared, as over a socket.
    const prompted = await openTab(task({ status: "running" }), undefined, {
      prompt: () => refusedLater("session_not_found"),
    });
    await userEvent.type(prompted.screen.getByRole("textbox", { name: "消息" }), "你好{Enter}");
    await expect.element(prompted.screen.getByTestId("conversation-failure")).toBeVisible();
    await expect.element(prompted.screen.getByRole("textbox", { name: "消息" })).toHaveValue("你好");
    await prompted.screen.unmount();
    pageDrafts().drop(["ses_conv"]);

    const steered = await openTab(task({ status: "running" }), undefined, {
      steer: () => refusedLater("session_not_found"),
    });
    steered.client.session("ses_conv")?.setState({ run: { runId: "r1", startedAt: 1 } } as Partial<SessionView>);
    await userEvent.type(steered.screen.getByRole("textbox", { name: "消息" }), "改个方向");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await expect.element(steered.screen.getByTestId("conversation-failure")).toBeVisible();
    await expect.element(steered.screen.getByRole("textbox", { name: "消息" })).toHaveValue("改个方向");
    await steered.screen.unmount();
    pageDrafts().drop(["ses_conv"]);

    // The conversation's pi is not running and starting it is refused: the message is the user's still.
    const closed = await openTab(task({ status: "waiting" }), undefined, {
      notRunning: ["ses_conv"],
      taskCommand: refuseOn("openTaskSession", "session_not_found"),
    });
    await userEvent.type(closed.screen.getByRole("textbox", { name: "消息" }), "还在吗{Enter}");
    await expect.element(closed.screen.getByRole("textbox", { name: "消息" })).toHaveValue("还在吗");
    expect(closed.calls.some((call) => call.startsWith("prompt ses_conv"))).toBe(false);
  });
});

describe("the task conversation after the host restarted (T8 review fix 7)", () => {
  it("watches the session shown again and starts its pi under a new host, but not after a reconnect to the same one", async () => {
    const shown = await openTab(task({ status: "waiting" }));
    await expect.poll(() => shown.calls.filter((call) => call === "watch ses_conv").length).toBeGreaterThan(0);
    const before = shown.calls.length;

    // The same host again: nothing to redo. (Each step is drawn before the next: batched, the pane would not see it.)
    shown.connection.setState({ status: "connecting" });
    await settle();
    shown.connection.setState(connected("h1"));
    await settle();
    // A new one has lost every view, as the real client marks them.
    shown.connection.setState({ status: "connecting" });
    await settle();
    shown.client.session("ses_conv")?.setState({ status: "lost", run: null, pending: [] });
    shown.connection.setState(connected("h2"));

    await expect
      .poll(() => shown.calls.slice(before).filter((call) => /^(watch|openTaskSession) /u.test(call)))
      .toStrictEqual(["watch ses_conv", "openTaskSession tsk_a ses_conv"]);
  });

  it("starts the pi of a conversation whose view is lost, not only one still loading", async () => {
    const shown = await openTab(task({ status: "waiting" }));
    shown.client.session("ses_conv")?.setState({ status: "lost", run: null, pending: [] });
    await userEvent.type(shown.screen.getByRole("textbox", { name: "消息" }), "还在吗{Enter}");

    await expect.poll(() => shown.calls).toContain("openTaskSession tsk_a ses_conv");
    await expect.poll(() => shown.calls).toContain("prompt ses_conv 还在吗");
  });
});

/** Opens a task whose conversation has `reviews` pending. */
async function withReviews(reviews: readonly PendingReview[], answers: FakeAnswers = {}) {
  const shown = await openTab(task({ status: "waiting", reviews: [...reviews] }), undefined, answers);
  shown.client.session("ses_conv")?.setState((state: SessionView) => ({
    ...state,
    control: { ...IDLE_CONTROL, reviews: [...reviews] },
  }));
  return shown;
}

describe("the review cards over the task conversation (SPEC-0006, T8)", () => {
  it("answers a human node's pass through answer_review on the task conversation", async () => {
    const { screen, calls } = await withReviews([humanReview()]);
    await expect.element(screen.getByTestId("review-subject")).toHaveTextContent("N4 验收合并");
    await screen.getByRole("button", { name: "通过并合并" }).click();

    expect(calls).toContain('answerReview ses_conv rv_h {"action":"pass"}');
  });

  it("sends a human node back to a node with the reason", async () => {
    const { screen, calls } = await withReviews([humanReview()]);
    await screen.getByRole("button", { name: /^打回到/ }).click();
    await userEvent.type(screen.getByRole("textbox", { name: "原因（必填）" }), "补一个测试");
    await screen.getByTestId("review-confirm").click();

    expect(calls).toContain('answerReview ses_conv rv_h {"action":"send_back","target":"N2","reason":"补一个测试"}');
  });

  it("words review_closed when the host says the review is gone, in the card", async () => {
    const { screen } = await withReviews([humanReview()], { taskCommand: rejectOn("answerReview", "review_closed") });
    await screen.getByRole("button", { name: "通过并合并" }).click();

    await expect.element(screen.getByTestId("review-failure")).toHaveTextContent("这条审核已经处理过了");
  });

  it("words review_invalid and a back edge used up", async () => {
    const { screen } = await withReviews([humanReview()], {
      taskCommand: rejectOn("answerReview", "review_invalid", "task_back_limit"),
    });
    const pass = screen.getByRole("button", { name: "通过并合并" });
    await pass.click();
    await expect.element(screen.getByTestId("review-failure")).toHaveTextContent("这个裁决不合这条审核，刷新后再试");
    await pass.click();
    await expect.element(screen.getByTestId("review-failure")).toHaveTextContent("这条打回边已经用了两次");
  });

  it("stacks a question and a review: capsules for both, one card open", async () => {
    const { screen, client } = await withReviews([humanReview()]);
    client.session("ses_conv")?.setState((state: SessionView) => ({
      ...state,
      control: {
        ...state.control,
        question: {
          id: "call-1",
          askedAt: 30,
          questions: [
            {
              header: "范围",
              question: "改到哪为止？",
              multiSelect: false,
              options: [{ label: "只改一处", description: "", preview: null, recommended: true }],
            },
          ],
        },
      },
    }));

    await expect.element(screen.getByRole("tablist", { name: "等你处理的卡片" })).toBeVisible();
    await screen.getByRole("tab", { name: "agent 在问你" }).click();
    await expect.element(screen.getByTestId("question")).toBeVisible();
    expect(screen.container.querySelector('[data-testid="review"]')).toBeNull();
  });

  it("keeps what was written on a card while the conversation is read again, loading with no reviews first (T8 review fix 5)", async () => {
    const shown = await openTab(task({ status: "waiting", reviews: [humanReview()] }), undefined, {
      controls: { ses_conv: { ...IDLE_CONTROL, reviews: [humanReview()] } },
    });
    await shown.screen.getByRole("button", { name: /^打回到/ }).click();
    await userEvent.type(shown.screen.getByRole("textbox", { name: "原因（必填）" }), "补一个测试");

    // Another owner of the watch (a list row, a node's tab) replaces the set, and the tab is mounted again later.
    await shown.screen.getByRole("tab", { name: "任务", exact: true }).click();
    await shown.client.watch(["ses_n2"]);
    await shown.screen.getByRole("tab", { name: /首页提速/ }).click();

    await expect.element(shown.screen.getByRole("textbox", { name: "原因（必填）" })).toHaveValue("补一个测试");
  });

  it("refuses a graph change with the optional reason the host offers, left empty or written (T8 review decision 3)", async () => {
    const without = await withReviews([GRAPH_REVIEW]);
    await without.screen.getByRole("button", { name: "不批准…" }).click();
    await expect.element(without.screen.getByRole("textbox", { name: "原因（可选）" })).toBeVisible();
    await without.screen.getByTestId("review-confirm").click();
    expect(without.calls).toContain('answerReview ses_conv rv_g {"action":"reject"}');
    await without.screen.unmount();
    pageDrafts().drop(["ses_conv"]);
    forgetReviewDrafts("ses_conv", []);

    const written = await withReviews([GRAPH_REVIEW]);
    await written.screen.getByRole("button", { name: "不批准…" }).click();
    await userEvent.type(written.screen.getByRole("textbox", { name: "原因（可选）" }), "先别动旧记录");
    await written.screen.getByTestId("review-confirm").click();
    expect(written.calls).toContain('answerReview ses_conv rv_g {"action":"reject","reason":"先别动旧记录"}');
  });

  it("answers an archive question with 归档", async () => {
    const { screen, calls } = await withReviews([ARCHIVE_REVIEW]);
    await expect.element(screen.getByTestId("review-subject")).toHaveTextContent("要归档 worktree 吗");
    await screen.getByRole("button", { name: "归档" }).click();

    expect(calls).toContain('answerReview ses_conv rv_a {"action":"archive"}');
  });

  it("looks at a proposed graph on the graph: new and changed nodes marked, the removed ones named, and back", async () => {
    const proposed = task({
      status: "waiting",
      reviews: [GRAPH_REVIEW],
      pending: {
        version: 3,
        author: "agent",
        note: "多一个上游",
        nodes: [
          { id: "N1", name: "调研与方案", kind: "agent", job: "j", done: ["d"], role: "explore", model: null },
          { id: "N1b", name: "迁移旧记录", kind: "agent", job: "j", done: ["d"], role: "work", model: null },
          { id: "N2", name: "核心实现与自检", kind: "agent", job: "j", done: ["d"], role: "work", model: null },
        ],
        edges: [
          { from: "N1", to: "N1b", kind: "seq" },
          { from: "N1b", to: "N2", kind: "seq" },
        ],
        diff: { from: 2, added: ["N1b"], removed: ["N9"], changed: ["N2"] },
      },
    });
    const shown = await openTab(proposed);
    shown.client.session("ses_conv")?.setState((state: SessionView) => ({
      ...state,
      control: { ...IDLE_CONTROL, reviews: [GRAPH_REVIEW] },
    }));
    expect(shown.screen.container.querySelector('[data-testid="graph-proposed"]')).toBeNull();

    await shown.screen.getByRole("button", { name: "在图上看" }).click();

    await expect
      .poll(() => shown.screen.container.querySelector('[data-testid="graph-proposed"]')?.textContent)
      .toContain("正在看图 v3（等你批准） · 去掉 N9");
    const marked = (mark: string) =>
      [...shown.screen.container.querySelectorAll(`[data-testid="graph-node"][data-mark="${mark}"]`)].map((one) =>
        one.getAttribute("data-node"),
      );
    expect(marked("new")).toStrictEqual(["N1b"]);
    expect(marked("changed")).toStrictEqual(["N2"]);
    expect(shown.screen.container.querySelectorAll('[data-testid="graph-node-new"]')).toHaveLength(1);
    // What is in the graph now keeps how it stands in the proposed one; only N1b is not started.
    const stateOf = (id: string) =>
      shown.screen.container.querySelector(`[data-node="${id}"]`)?.getAttribute("data-state");
    expect([stateOf("N1"), stateOf("N2"), stateOf("N1b")]).toStrictEqual(["passed", "running", "pending"]);

    await shown.screen.getByRole("button", { name: "回到当前图" }).click();
    expect(shown.screen.container.querySelector('[data-testid="graph-proposed"]')).toBeNull();
    expect(shown.screen.container.querySelectorAll('[data-testid="graph-node"]')).toHaveLength(3);
  });
});

/** A task waiting for the graph change `version`, which adds N1b. */
function proposedTask(version: number): TaskView {
  return task({
    status: "waiting",
    pendingGraph: true,
    reviews: [GRAPH_REVIEW],
    pending: {
      version,
      author: "agent",
      note: "多一个上游",
      nodes: [
        { id: "N1", name: "调研与方案", kind: "agent", job: "j", done: ["d"], role: "explore", model: null },
        { id: "N1b", name: "迁移旧记录", kind: "agent", job: "j", done: ["d"], role: "work", model: null },
        { id: "N2", name: "核心实现与自检", kind: "agent", job: "j", done: ["d"], role: "work", model: null },
      ],
      edges: [
        { from: "N1", to: "N1b", kind: "seq" },
        { from: "N1b", to: "N2", kind: "seq" },
      ],
      diff: { from: 2, added: ["N1b"], removed: [], changed: [] },
    },
  });
}

describe("looking at a proposed graph follows its version (T8 review fix 8)", () => {
  it("shows the newer proposal with the banner updated when it comes while you look, not the old one and not the current graph", async () => {
    const shown = await openTab(proposedTask(3), undefined, {
      controls: { ses_conv: { ...IDLE_CONTROL, reviews: [GRAPH_REVIEW] } },
    });
    await shown.screen.getByRole("button", { name: "在图上看" }).click();
    await expect.poll(() => banner(shown.screen)).toContain("正在看图 v3");

    shown.taskStateOf("tsk_a").setState({ status: "ready", task: proposedTask(4) });

    await expect.poll(() => banner(shown.screen)).toContain("正在看图 v4（等你批准）");
    expect(banner(shown.screen)).not.toContain("v3");
  });

  it("stops looking when the proposal is decided, and does not look at the next one by itself", async () => {
    const shown = await openTab(proposedTask(3), undefined, {
      controls: { ses_conv: { ...IDLE_CONTROL, reviews: [GRAPH_REVIEW] } },
    });
    await shown.screen.getByRole("button", { name: "在图上看" }).click();
    await expect.poll(() => banner(shown.screen)).not.toBeNull();

    shown.taskStateOf("tsk_a").setState({ status: "ready", task: task({ status: "running" }) });
    await expect.poll(() => banner(shown.screen)).toBeNull();
    shown.taskStateOf("tsk_a").setState({ status: "ready", task: proposedTask(5) });

    await expect.element(shown.screen.getByTestId("task-tab")).toBeVisible();
    expect(banner(shown.screen)).toBeNull();
  });

  it("looks at nothing for a card whose version is not the one waiting any more", async () => {
    // The card still says v3 (a verdict on it would be refused) while v4 is the proposal now.
    const shown = await openTab(proposedTask(4), undefined, {
      controls: { ses_conv: { ...IDLE_CONTROL, reviews: [GRAPH_REVIEW] } },
    });

    await shown.screen.getByRole("button", { name: "在图上看" }).click();

    await expect.element(shown.screen.getByTestId("task-tab")).toBeVisible();
    expect(banner(shown.screen)).toBeNull();
  });
});

describe("the dashed frames and 新 after a change (SPEC-0006, 界面 · 任务标签)", () => {
  it("marks the nodes the last change added with 新 and the ones it changed with a dashed frame", async () => {
    const { screen } = await openTab(
      task({ graphVersion: 2, graphDiff: { from: 1, added: ["N4"], removed: [], changed: ["N2"] } }),
    );

    const frame = (id: string) => screen.container.querySelector(`[data-node="${id}"]`);
    expect(frame("N4")?.getAttribute("data-mark")).toBe("new");
    expect(frame("N2")?.getAttribute("data-mark")).toBe("changed");
    expect(frame("N1")?.hasAttribute("data-mark")).toBe(false);
    expect(frame("N2")?.className).toContain("outline-dashed");
    expect(screen.container.querySelectorAll('[data-testid="graph-node-new"]')).toHaveLength(1);
  });

  it("marks nothing for a first version", async () => {
    const { screen } = await openTab(task({ graphDiff: null }));

    expect(screen.container.querySelector("[data-mark]")).toBeNull();
  });
});

describe("the requirements summary at the top of the task conversation (设计稿第 4 屏)", () => {
  const requirements = {
    goal: "让首页首屏在冷启动时快 30%",
    decisions: ["Shiki 移进 Worker"],
    constraints: ["不改公开接口"],
    nonGoals: [],
    openQuestions: ["缓存放磁盘还是内存"],
    acceptance: ["冷启动 < 1.2s"],
  };

  it("shows the goal as a quote and opens the sections under 展开", async () => {
    const { screen } = await openTab(task({ requirements }));

    await expect.element(screen.getByTestId("requirements-goal")).toHaveTextContent("让首页首屏在冷启动时快 30%");
    expect(screen.container.querySelector('[data-testid="requirements-sections"]')).toBeNull();
    await screen.getByRole("button", { name: "展开" }).click();
    const sections = screen.getByTestId("requirements-sections").element().textContent;
    expect(sections).toContain("Shiki 移进 Worker");
    expect(sections).toContain("不改公开接口");
    expect(sections).toContain("缓存放磁盘还是内存");
    expect(sections).toContain("冷启动 < 1.2s");
    expect(sections).not.toContain("不做");
  });

  it("shows model text as text, never as markup, and leaves the card out while the summary is empty", async () => {
    const hostile = await openTab(
      task({ requirements: { ...requirements, goal: "<img src=x onerror=alert(1)> **粗**" } }),
    );
    expect(hostile.screen.container.querySelector('[data-testid="requirements"] img')).toBeNull();
    expect(hostile.screen.getByTestId("requirements-goal").element().textContent).toBe(
      "<img src=x onerror=alert(1)> **粗**",
    );
    expect(hostile.screen.container.querySelector('[data-testid="requirements"] strong')).toBeNull();
    await hostile.screen.unmount();

    const empty = await openTab(task());
    expect(empty.screen.container.querySelector('[data-testid="requirements"]')).toBeNull();
  });
});

describe("the task bar's buttons (SPEC-0006, 界面 · 任务标签)", () => {
  it("offers 放弃任务 and 确认并启动 while designing, the second only once there is a graph", async () => {
    const empty = await openTab(view("a", [], [], { status: "designing", name: "新任务" }));
    expect(buttons(empty.screen)).toStrictEqual(["放弃任务", "确认并启动"]);
    expect(empty.screen.getByRole("button", { name: "确认并启动" }).element().hasAttribute("disabled")).toBe(true);
    await empty.screen.unmount();

    const drawn = await openTab(task({ status: "designing" }));
    expect(buttons(drawn.screen)).toStrictEqual(["放弃任务", "确认并启动"]);
    await drawn.screen.getByRole("button", { name: "确认并启动" }).click();
    expect(drawn.calls).toContain("startTask tsk_a");
  });

  it("offers 暂停任务 and 取消任务 while it runs, 继续 once paused, and only 取消任务 when stopped", async () => {
    const running = await openTab(task({ status: "running" }));
    expect(buttons(running.screen)).toStrictEqual(["暂停任务", "取消任务"]);
    await running.screen.getByRole("button", { name: "暂停任务" }).click();
    expect(running.calls).toContain("pauseTask tsk_a");
    await running.screen.unmount();

    // As the host sends it: a paused task is `stopped` with `paused` set, never `running` (T8 review fix 1).
    const paused = await openTab(task({ status: "stopped", paused: true }));
    expect(buttons(paused.screen)).toStrictEqual(["继续", "取消任务"]);
    await paused.screen.getByRole("button", { name: "继续" }).click();
    expect(paused.calls).toContain("resumeTask tsk_a");
    await paused.screen.unmount();

    const stopped = await openTab(task({ status: "stopped" }));
    expect(buttons(stopped.screen)).toStrictEqual(["取消任务"]);
  });

  it("writes a finished task's status once in the bar, not 完成 and then 已完成 (T8 review fix 16)", async () => {
    const done = await openTab(task({ status: "done" }));
    await expect.poll(() => done.screen.getByTestId("task-bar-status").element().textContent).toBe("已完成");
    await done.screen.unmount();

    // A running task still says where it is, then how it goes.
    const running = await openTab(
      task({ status: "running", current: { id: "N2", name: "核心实现与自检", state: "running" } }),
    );
    await expect
      .poll(() => running.screen.getByTestId("task-bar-status").element().textContent)
      .toBe("N2 核心实现与自检 · 运转中");
  });

  it("offers nothing for a finished or cancelled task, and 归档 worktree for a kept one", async () => {
    const done = await openTab(task({ status: "done" }));
    expect(buttons(done.screen)).toStrictEqual([]);
    await done.screen.unmount();

    const kept = await openTab(task({ status: "done", archive: "kept" }));
    expect(buttons(kept.screen)).toStrictEqual(["归档 worktree"]);
    await kept.screen.getByRole("button", { name: "归档 worktree" }).click();
    expect(kept.calls).toContain("answerArchive tsk_a archive");
  });

  it("draws no button and no input box for a task another process runs", async () => {
    const { screen } = await openTab(task({ status: "running", followed: true }));

    expect(buttons(screen)).toStrictEqual([]);
    expect(screen.container.querySelector("textarea")).toBeNull();
  });

  it("asks again before abandoning or cancelling, sends nothing for 不了, and sends once for 确定", async () => {
    const designing = await openTab(task({ status: "designing" }));
    await designing.screen.getByRole("button", { name: "放弃任务" }).click();
    await expect.element(designing.screen.getByRole("group", { name: "放弃这个任务？" })).toBeVisible();
    expect(designing.calls.some((call) => call.startsWith("abandonTask"))).toBe(false);
    await designing.screen.getByRole("button", { name: "不了" }).click();
    expect(designing.screen.container.querySelector('[data-testid="confirm-asking"]')).toBeNull();
    await designing.screen.getByRole("button", { name: "放弃任务" }).click();
    await designing.screen.getByRole("button", { name: "确定" }).click();
    expect(designing.calls.filter((call) => call.startsWith("abandonTask"))).toStrictEqual(["abandonTask tsk_a"]);
    await designing.screen.unmount();

    const running = await openTab(task({ status: "running" }));
    await running.screen.getByRole("button", { name: "取消任务" }).click();
    await userEvent.keyboard("{Escape}");
    expect(running.screen.container.querySelector('[data-testid="confirm-asking"]')).toBeNull();
    await running.screen.getByRole("button", { name: "取消任务" }).click();
    await running.screen.getByRole("button", { name: "确定" }).click();
    expect(running.calls).toContain("cancelTask tsk_a");
  });

  it("words a command's failure under the bar", async () => {
    const { screen } = await openTab(task({ status: "running" }), undefined, {
      taskCommand: rejectOn("pauseTask", "task_state_invalid"),
    });
    await screen.getByRole("button", { name: "暂停任务" }).click();

    await expect.element(screen.getByTestId("task-bar-failure")).toHaveTextContent("任务的状态变了，刷新后再试");
  });
});

const record = (
  id: string,
  time: number,
  verdict: PendingReview["actions"][number]["id"],
  reason?: string,
): Notice => ({
  kind: "notice",
  id,
  notice: "review",
  review: {
    source: { kind: "gate", gate: "task_graph" },
    subject: { code: "task_graph_change", params: { taskId: "tsk_a", version: 2 } },
    evidence: [
      { kind: "graph_diff", from: 1, to: 2, added: ["N1b"], removed: [], changed: [] },
      { kind: "changes", workspaceId: FEATURE, files: 3, added: 48, removed: 8 },
    ],
    verdict: { action: verdict, ...(reason === undefined ? {} : { reason }) },
  },
  timestamp: time,
});
const progress = (id: string, time: number, what: string, nodeId: string): Notice => ({
  kind: "notice",
  id,
  notice: "task_progress",
  what,
  node: nodeId,
  timestamp: time,
});

/** Minutes past 10:00 on the day of the fixtures, as epoch milliseconds. */
const t = (minutes: number) => new Date(2026, 10, 6, 10, minutes).getTime();

describe("the review records on the rail (SPEC-0006, 任务对话的进度和记录折叠)", () => {
  it("folds a record into the progress group and names it in the folded line", async () => {
    const { screen, client } = await openTab(task({ status: "running" }));
    client.session("ses_conv")?.setState({
      items: [
        progress("p1", t(0), "node_passed", "N1"),
        record("r1", t(1), "approve"),
        {
          kind: "turn",
          id: "t1",
          source: null,
          user: { text: "进度？", images: 0, clientMessageId: null, auto: false, command: null, timestamp: t(5) },
          steps: [{ kind: "text", id: "t1-t", text: "在 N2" }],
          outcome: "done",
          error: null,
          startedAt: t(5),
          durationMs: 1,
          usage: null,
          changes: [],
        },
        progress("p2", t(6), "node_started", "N2"),
      ],
    } as Partial<SessionView>);

    await expect.poll(() => screen.container.querySelectorAll('[data-testid="task-progress"]').length).toBe(2);
    const first = screen.container.querySelectorAll('[data-testid="task-progress"]')[0] as HTMLElement;
    expect(first.textContent).toContain("1 个节点通过 · 你批准了图 v2");
    await userEvent.click(first.querySelector("button") as HTMLElement);
    const row = first.querySelector('[data-testid="review-record"]') as HTMLElement;
    expect(row.textContent).toContain("你批准了图 v2");
    await userEvent.click(row.querySelector("button") as HTMLElement);
    expect(first.querySelector('[data-testid="review-record-evidence"]')?.textContent).toContain("N1b");
  });

  it("shows the evidence of an opened record as it was, with no buttons: no 查看改动, no 在图上看 (T8 review fix 8)", async () => {
    const { screen, client } = await openTab(task({ status: "running" }));
    client
      .session("ses_conv")
      ?.setState({ items: [record("r1", t(1), "reject", "先别动旧记录")] } as Partial<SessionView>);
    await expect.poll(() => screen.container.querySelector('[data-testid="task-progress"]')).not.toBeNull();
    // The last group of the rail is open already.
    await userEvent.click(screen.container.querySelector('[data-testid="review-record"] button') as HTMLElement);

    const evidence = screen.container.querySelector('[data-testid="review-record-evidence"]') as HTMLElement;
    // The numbers and the nodes are there; nothing in it can be pressed except folding a long quote.
    expect(evidence.textContent).toContain("3 个文件");
    expect(evidence.textContent).toContain("N1b");
    expect(evidence.textContent).not.toContain("查看改动");
    expect(evidence.textContent).not.toContain("在图上看");
    expect([...evidence.querySelectorAll("button")]).toHaveLength(0);
  });

  it("writes what you decided, with the reason, and shows the evidence of the time on a press", async () => {
    const { screen, client } = await openTab(task({ status: "running" }));
    client
      .session("ses_conv")
      ?.setState({ items: [record("r1", 1, "reject", "先别动旧记录")] } as Partial<SessionView>);

    await expect
      .poll(() => screen.container.querySelector('[data-testid="review-record"]')?.textContent)
      .toContain("你没有批准图 v2：先别动旧记录");
  });
});

describe("answering in the list (SPEC-0006, 界面 · 任务列表; 设计稿第 2 屏)", () => {
  const rows = [
    summary("a", {
      name: "首页提速",
      status: "waiting",
      attention: "human",
      current: { id: "N4", name: "验收合并", state: "waiting" },
    }),
    summary("b", { name: "语音输入", status: "running" }),
  ];

  it("opens one row at a time and answers a review in the row with answer_review", async () => {
    const shown = await board(rows);
    shown
      .taskStateOf("tsk_a")
      .setState({ status: "ready", task: task({ status: "waiting", reviews: [ARCHIVE_REVIEW] }) });
    await shown.screen.getByRole("button", { name: "任务", exact: true }).click();
    const rowOf = (id: string) =>
      shown.screen.container.querySelector(`[data-testid="task-row"][data-task="${id}"]`) as HTMLElement;

    await userEvent.click(rowOf("tsk_a"));
    await expect.element(shown.screen.getByTestId("review")).toBeVisible();
    expect(shown.calls).toContain("openTask tsk_a");
    await userEvent.click(rowOf("tsk_b"));
    expect(shown.screen.container.querySelectorAll('[data-testid="task-row-panel"]')).toHaveLength(1);
    expect(shown.screen.container.querySelector('[data-testid="review"]')).toBeNull();

    await userEvent.click(rowOf("tsk_a"));
    await shown.screen.getByRole("button", { name: "归档" }).click();
    expect(shown.calls).toContain('answerReview ses_conv rv_a {"action":"archive"}');
  });

  it("gives a human node's acceptance no card in the row, only 打开任务 (T8 review decision 1)", async () => {
    const shown = await board(rows);
    shown
      .taskStateOf("tsk_a")
      .setState({ status: "ready", task: task({ status: "waiting", reviews: [humanReview()] }) });
    await shown.screen.getByRole("button", { name: "任务", exact: true }).click();
    await shown.screen.getByTestId("task-row").first().click();

    await expect.element(shown.screen.getByRole("button", { name: "打开任务" })).toBeVisible();
    expect(shown.screen.container.querySelector('[data-testid="review"]')).toBeNull();
    expect(shown.screen.container.querySelector('[data-action="pass"]')).toBeNull();
    expect(shown.screen.container.querySelector('[role="tablist"][aria-label="等你处理的卡片"]')).toBeNull();
  });

  it("stacks the cards of a row as capsules like the task conversation does, one open at a time, the acceptance left out", async () => {
    const asking = task({
      status: "waiting",
      reviews: [GRAPH_REVIEW, humanReview(), ARCHIVE_REVIEW],
      nodes: [node("N2", { name: "核心实现", state: "waiting", waitingFor: "question", sessionId: "ses_n2" })],
      edges: [],
    });
    const shown = await board([summary("a", { name: "首页提速", status: "waiting", attention: "question" })]);
    shown.taskStateOf("tsk_a").setState({ status: "ready", task: asking });
    await shown.screen.getByRole("button", { name: "任务", exact: true }).click();
    await shown.screen.getByTestId("task-row").click();
    await expect.poll(() => shown.client.session("ses_n2")).toBeDefined();
    shown.client.session("ses_n2")?.setState((state: SessionView) => ({
      ...state,
      control: {
        ...IDLE_CONTROL,
        question: {
          id: "call-9",
          askedAt: 12,
          questions: [
            {
              header: "范围",
              question: "这次做哪些？",
              multiSelect: false,
              options: [{ label: "只改一处", description: "", preview: null, recommended: true }],
            },
          ],
        },
      },
    }));

    const tabs = shown.screen.getByRole("tablist", { name: "等你处理的卡片" });
    await expect.element(tabs).toBeVisible();
    expect([...tabs.element().querySelectorAll("[role=tab]")].map((tab) => tab.textContent)).toStrictEqual([
      "图 v3 等你批准",
      "agent 在问你",
      "要归档 worktree 吗",
    ]);
    // The earliest is open, the rest are capsules; a press switches.
    expect(shown.screen.container.querySelectorAll('[data-testid="review"], [data-testid="question"]')).toHaveLength(1);
    await shown.screen.getByRole("tab", { name: "agent 在问你" }).click();
    await expect.element(shown.screen.getByTestId("question")).toBeVisible();
  });

  it("does not watch the node sessions of a followed task, nor link to their conversations", async () => {
    const followed = task({
      status: "waiting",
      followed: true,
      nodes: [
        node("N2", { name: "核心实现", state: "waiting", waitingFor: "question", sessionId: "ses_other_process" }),
      ],
      edges: [],
    });
    const shown = await board([summary("a", { name: "首页提速", status: "waiting", attention: "question" })]);
    shown.taskStateOf("tsk_a").setState({ status: "ready", task: followed });
    await shown.screen.getByRole("button", { name: "任务", exact: true }).click();
    await shown.screen.getByTestId("task-row").click();

    await expect.element(shown.screen.getByRole("button", { name: "打开任务" })).toBeVisible();
    expect(shown.calls.filter((call) => call.includes("ses_other_process"))).toStrictEqual([]);
    expect(shown.screen.container.textContent).not.toContain("的对话里讨论");
  });

  it("lets go of the node session it watched when the row folds, and does not undo the watch of what opened after it", async () => {
    const asking = task({
      status: "waiting",
      nodes: [node("N2", { name: "核心实现", state: "waiting", waitingFor: "question", sessionId: "ses_n2" })],
      edges: [],
    });
    const shown = await board([summary("a", { name: "首页提速", status: "waiting", attention: "question" })]);
    shown.taskStateOf("tsk_a").setState({ status: "ready", task: asking });
    await shown.screen.getByRole("button", { name: "任务", exact: true }).click();
    const row = shown.screen.getByTestId("task-row");
    await row.click();
    await expect.poll(() => shown.calls).toContain("watch ses_n2");

    await row.click();
    await expect.poll(() => shown.calls.filter((call) => call.startsWith("watch")).at(-1)).toBe("watch ");

    // Opened again, then the task itself: its conversation is watched last, and the row's letting go came before.
    await row.click();
    await shown.screen.getByRole("button", { name: "打开任务" }).click();
    await expect.element(shown.screen.getByTestId("task-tab")).toBeVisible();
    await expect.poll(() => shown.calls.filter((call) => call.startsWith("watch")).at(-1)).toBe("watch ses_conv");
  });

  it("folds a row on a second press and offers 打开任务 for one with nothing to answer", async () => {
    const shown = await board(rows);
    await shown.screen.getByRole("button", { name: "任务", exact: true }).click();
    const row = shown.screen.getByTestId("task-row").first();
    await row.click();
    await expect.element(shown.screen.getByRole("button", { name: "打开任务" })).toBeVisible();
    await row.click();
    expect(shown.screen.container.querySelector('[data-testid="task-row-panel"]')).toBeNull();
  });

  it("answers a node's question in the row and offers the node's conversation", async () => {
    const asking = task({
      status: "waiting",
      nodes: [node("N2", { name: "核心实现", state: "waiting", waitingFor: "question", sessionId: "ses_n2" })],
      edges: [],
    });
    const shown = await board([summary("a", { name: "首页提速", status: "waiting", attention: "question" })]);
    shown.taskStateOf("tsk_a").setState({ status: "ready", task: asking });
    await shown.screen.getByRole("button", { name: "任务", exact: true }).click();
    await shown.screen.getByTestId("task-row").click();
    await expect.poll(() => shown.client.session("ses_n2")).toBeDefined();
    shown.client.session("ses_n2")?.setState((state: SessionView) => ({
      ...state,
      control: {
        ...IDLE_CONTROL,
        question: {
          id: "call-9",
          askedAt: 1,
          questions: [
            {
              header: "范围",
              question: "这次做哪些？",
              multiSelect: false,
              options: [
                { label: "只改一处", description: "", preview: null, recommended: true },
                { label: "全改", description: "", preview: null, recommended: false },
              ],
            },
          ],
        },
      },
    }));

    await expect.element(shown.screen.getByTestId("question")).toBeVisible();
    await shown.screen.getByRole("radio", { name: /只改一处/ }).click();
    await shown.screen.getByRole("button", { name: "提交回答" }).click();

    await expect.poll(() => shown.calls.find((call) => call.startsWith("answerQuestion ses_n2 call-9"))).toBeDefined();
    await shown.screen.getByRole("button", { name: /到 N2 的对话里讨论/ }).click();
    await expect.element(shown.screen.getByTestId("node-tab")).toBeVisible();
  });

  it("runs a failed node again from the row", async () => {
    const failed = task({
      status: "stopped",
      nodes: [node("N2", { name: "核心实现", state: "failed", failure: "crashed", sessionId: "ses_n2" })],
      edges: [],
    });
    const shown = await board([summary("a", { name: "首页提速", status: "stopped", attention: "failed" })]);
    shown.taskStateOf("tsk_a").setState({ status: "ready", task: failed });
    await shown.screen.getByRole("button", { name: "任务", exact: true }).click();
    await shown.screen.getByTestId("task-row").click();
    await shown.screen.getByRole("button", { name: "重跑这个节点" }).click();

    expect(shown.calls).toContain("rerunNode tsk_a N2");
  });
});

describe("the inbox 等你处理 (SPEC-0006, 界面)", () => {
  // The card remembers it was opened; each test starts folded.
  beforeEach(() => localStorage.removeItem("atrium.inboxOpen"));

  it("lists a task that wants you with what it waits for, and opens its tab", async () => {
    const shown = await board([
      summary("a", {
        name: "首页提速",
        status: "waiting",
        attention: "human",
        current: { id: "N4", name: "验收合并", state: "waiting" },
      }),
      summary("b", { name: "语音输入", status: "running" }),
    ]);
    shown.taskStateOf("tsk_a").setState({ status: "ready", task: task({ status: "waiting" }) });
    await shown.screen.getByRole("button", { name: /等你处理/ }).click();

    const lines = [...shown.screen.container.querySelectorAll('[data-testid="inbox-task-row"]')];
    expect(lines.map((line) => line.textContent)).toStrictEqual([expect.stringContaining("首页提速")]);
    expect(lines[0]?.textContent).toContain("等你验收");
    await userEvent.click(lines[0] as HTMLElement);
    await expect.element(shown.screen.getByTestId("task-tab")).toBeVisible();
  });

  it("opens the node's conversation straight away for a question", async () => {
    const shown = await board([
      summary("a", {
        name: "首页提速",
        status: "waiting",
        attention: "question",
        current: { id: "N2", name: "核心实现", state: "waiting" },
      }),
    ]);
    shown.taskStateOf("tsk_a").setState({ status: "ready", task: task({ status: "waiting" }) });
    await shown.screen.getByRole("button", { name: /等你处理/ }).click();
    const line = shown.screen.container.querySelector('[data-testid="inbox-task-row"]') as HTMLElement;
    expect(line.textContent).toContain("N2 在问");
    await userEvent.click(line);

    await expect.element(shown.screen.getByTestId("node-tab")).toBeVisible();
  });

  it("leaves the new-workspace page that was open when a task is chosen, as a session row does (T8 review fix 17)", async () => {
    const shown = await board([
      summary("a", {
        name: "首页提速",
        status: "waiting",
        attention: "human",
        current: { id: "N4", name: "验收合并", state: "waiting" },
      }),
      summary("b", {
        name: "语音输入",
        status: "running",
        attention: "question",
        current: { id: "N2", name: "x", state: "waiting" },
      }),
    ]);
    shown.taskStateOf("tsk_a").setState({ status: "ready", task: task({ status: "waiting" }) });
    const project = shown.screen.getByTestId("project-row");
    await project.hover();
    await project.getByRole("button", { name: "在 atrium 新建工作区" }).click();
    await expect.element(shown.screen.getByText("新建工作区", { exact: true })).toBeVisible();

    await shown.screen.getByRole("button", { name: /等你处理/ }).click();
    await userEvent.click(
      shown.screen.container.querySelector('[data-testid="inbox-task-row"][data-fold-row]') as HTMLElement,
    );
    await expect.element(shown.screen.getByTestId("task-tab")).toBeVisible();

    // The page is closed, not just hidden behind the task area: the project is not marked as the one being worked on.
    await expect.element(shown.screen.getByTestId("project-row")).not.toHaveAttribute("aria-current", "true");
    await shown.screen.getByTestId("workspace-row").filter({ hasText: "main" }).click();
    await expect.element(shown.screen.getByText("新建工作区", { exact: true })).not.toBeInTheDocument();
  });

  it("is left out when no task wants you", async () => {
    const shown = await board([summary("b", { status: "running" })]);

    expect(shown.screen.container.querySelector('[data-testid="inbox-task-row"]')).toBeNull();
  });
});

/** Opens the task and then N2's conversation from the graph's hover card. */
async function atNode(answers: FakeAnswers = {}) {
  const shown = await openTab(task({ status: "running" }), undefined, answers);
  const graphNode = shown.screen.container.querySelector('[data-testid="graph-node"][data-node="N2"]') as HTMLElement;
  await userEvent.hover(graphNode);
  await userEvent.click(
    shown.screen.container.querySelector(
      '[data-node="N2"] ~ [role="tooltip"] [data-testid="graph-node-open"]',
    ) as HTMLElement,
  );
  return shown;
}

describe("a node's conversation as a tab (设计稿第 8 屏 A)", () => {
  it("opens as a tab after the task's, marked with the arrow and the node's id, and shows the node's session", async () => {
    const { screen, calls } = await atNode();

    await expect.element(screen.getByTestId("node-tab")).toBeVisible();
    const tabs = [...screen.getByRole("tablist", { name: "任务区" }).element().querySelectorAll('[role="tab"]')].map(
      (tab) => tab.textContent,
    );
    expect(tabs).toStrictEqual(["任务", "定时", "首页提速", "N2"]);
    expect(calls).toContain("watch ses_n2");
    expect(calls.some((call) => call.startsWith("openSession ses_n2"))).toBe(false);
  });

  it("interjects with prompt and stops the round on the node's session", async () => {
    const { screen, calls, client } = await atNode();
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "先别改 B 文件{Enter}");
    expect(calls).toContain("prompt ses_n2 先别改 B 文件");

    client.session("ses_n2")?.setState({ run: { runId: "r1", startedAt: 1 } } as Partial<SessionView>);
    await screen.getByRole("button", { name: "停止" }).click();
    expect(calls).toContain("stop ses_n2");
  });

  it("starts the node's pi through open_task_session when it is not running", async () => {
    const shown = await openTab(task({ status: "running" }), undefined, { notRunning: ["ses_n1"] });
    const graphNode = shown.screen.container.querySelector('[data-testid="graph-node"][data-node="N1"]') as HTMLElement;
    await userEvent.hover(graphNode);
    await userEvent.click(
      shown.screen.container.querySelector(
        '[data-node="N1"] ~ [role="tooltip"] [data-testid="graph-node-open"]',
      ) as HTMLElement,
    );

    await expect.poll(() => shown.calls).toContain("openTaskSession tsk_a ses_n1");
  });

  it("closes with its task, and going back lands on the task's tab", async () => {
    const { screen } = await atNode();
    await screen.getByRole("button", { name: "回到任务图 ›" }).click();
    await expect.element(screen.getByTestId("task-tab")).toBeVisible();

    await screen.getByRole("tab", { name: /N2/ }).click();
    await screen.getByRole("button", { name: "关闭节点对话 N2" }).click();
    await expect.element(screen.getByTestId("task-tab")).toBeVisible();

    const graphNode = screen.container.querySelector('[data-testid="graph-node"][data-node="N2"]') as HTMLElement;
    await userEvent.hover(graphNode);
    await userEvent.click(
      screen.container.querySelector(
        '[data-node="N2"] ~ [role="tooltip"] [data-testid="graph-node-open"]',
      ) as HTMLElement,
    );
    await screen.getByRole("button", { name: "关闭 首页提速" }).click();
    expect(screen.container.querySelector("[data-node-tab]")).toBeNull();
  });

  it("opens from a progress row of a node that started", async () => {
    const shown = await openTab(task({ status: "running" }));
    shown.client.session("ses_conv")?.setState({
      items: [{ kind: "notice", id: "p1", notice: "task_progress", what: "node_started", node: "N2", timestamp: 1 }],
    } as Partial<SessionView>);
    await shown.screen.getByTestId("task-progress-open").click();

    await expect.element(shown.screen.getByTestId("node-tab")).toBeVisible();
  });

  it("says a node that has not started has no conversation", async () => {
    const shown = await openTab(task({ status: "running" }));
    shown.client.session("ses_conv")?.setState({
      items: [{ kind: "notice", id: "p1", notice: "task_progress", what: "node_waiting", node: "N4", timestamp: 1 }],
    } as Partial<SessionView>);

    await expect.element(shown.screen.getByTestId("task-progress-row")).toBeVisible();
    // N4 has no session: its progress row does not link.
    expect(shown.screen.container.querySelector('[data-testid="task-progress-open"]')).toBeNull();
  });
});
