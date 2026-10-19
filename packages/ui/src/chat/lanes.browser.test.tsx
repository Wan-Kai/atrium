import type { AgentEventKind, AgentNoticeEvent, AgentStatus, SessionSummary, Step, Turn } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import "../styles.css";
import { ClockContext, type UiClock } from "../state/clock";
import { session } from "../test/fake-client";
import { type AgentLinks, AgentLinksContext } from "./agent-links";
import { TurnView } from "./turn-view";

const at = Date.UTC(2026, 9, 17, 9, 0);

/**
 * A finished turn with these steps, opened by you unless `fields` say otherwise.
 *
 * @sideEffects none
 * @param steps - Its steps.
 * @param fields - Its other fields.
 * @returns The turn.
 */
function turn(steps: Step[], fields: Partial<Turn> = {}): Turn {
  return {
    kind: "turn",
    id: "t1",
    source: null,
    user: { text: "查一遍登录", images: 0, clientMessageId: null, auto: false, command: null, timestamp: at },
    steps,
    outcome: "running",
    error: null,
    startedAt: at,
    durationMs: null,
    usage: null,
    changes: [],
    ...fields,
  };
}

/**
 * An event of a child's task; the child is named after the task.
 *
 * @sideEffects none
 * @param taskId - The task.
 * @param kind - What happened.
 * @param fields - Its other fields.
 * @returns The event.
 */
function event(taskId: string, kind: AgentEventKind, fields: Partial<AgentNoticeEvent> = {}): AgentNoticeEvent {
  return {
    sessionId: `s-${taskId}`,
    name: taskId,
    title: taskId,
    taskId,
    event: kind,
    reason: null,
    elapsedMs: null,
    question: null,
    branch: null,
    changes: null,
    ...fields,
  };
}

/**
 * An `agent_spawn` call that started a child on a task.
 *
 * @sideEffects none
 * @param id - The step's id.
 * @param taskId - The task; the child is named after it.
 * @param branch - Its worktree's branch; `null` in the same place.
 * @returns The step.
 */
function spawn(id: string, taskId: string, branch: string | null = null): Step {
  return {
    kind: "tool",
    id,
    callId: `c${id}`,
    tool: "agent_spawn",
    args: { name: taskId },
    status: "done",
    output: null,
    details: {
      tool: "agent",
      spawned: { sessionId: `s-${taskId}`, name: taskId, taskId, role: branch === null ? "explore" : "work", branch },
      events: [],
    },
    partial: false,
  };
}

/**
 * Renders a turn with links that record what they opened, the list holding these sessions.
 *
 * @sideEffects Renders into the page.
 * @param value - The turn.
 * @param sessions - The sessions the list has.
 * @param parentId - The conversation's own parent.
 * @returns The screen, and the sessions opened so far.
 */
async function show(value: Turn, sessions: readonly SessionSummary[] = [], parentId: string | null = null) {
  const opened: string[] = [];
  const links: AgentLinks = {
    open: (sessionId) => opened.push(sessionId),
    session: (sessionId) => sessions.find((one) => one.sessionId === sessionId),
    parentId,
  };
  const screen = await render(
    <AgentLinksContext value={links}>
      <TurnView turn={value} runStartedAt={at} />
    </AgentLinksContext>,
  );
  return { screen, opened };
}

/**
 * A child the agent opened, named after its task, as the list has it.
 *
 * @sideEffects none
 * @param taskId - The task it was started on.
 * @param status - Its status.
 * @param taskStartedAt - When the task it has open was handed down.
 * @param openTask - The task it has open; the one it was started on unless said.
 * @returns The session.
 */
function spawnedChild(
  taskId: string,
  status: AgentStatus,
  taskStartedAt: number | null,
  openTask: string | null = taskId,
): SessionSummary {
  return session({
    sessionId: `s-${taskId}`,
    containerId: "wks_000000000000000a",
    name: taskId,
    agent: { handle: taskId, role: "explore", status, progress: null, question: null, taskId: openTask, taskStartedAt },
  });
}

/**
 * A clock that stands still until moved, and ticks only when told.
 *
 * @remarks
 * What the lanes read the time from, so a test sets it and runs a second's tick.
 *
 * @sideEffects none
 * @param start - The time it starts at.
 * @returns The clock, a way to move it, and how many ticks are set.
 */
function standingClock(start: number) {
  let now = start;
  const ticks = new Set<() => void>();
  const clock: UiClock = {
    now: () => now,
    every: (_ms, tick) => {
      ticks.add(tick);
      return () => ticks.delete(tick);
    },
    after: () => () => undefined,
  };
  return {
    clock,
    /** Moves the time on, and runs every tick set. */
    advance: (ms: number) => {
      now += ms;
      for (const tick of ticks) tick();
    },
    ticking: () => ticks.size,
  };
}

/**
 * A command that ran, done.
 *
 * @sideEffects none
 * @param id - The step's id.
 * @returns The step.
 */
function bash(id: string): Step {
  return {
    kind: "tool",
    id,
    callId: `c${id}`,
    tool: "bash",
    args: { command: "ls" },
    status: "done",
    output: null,
    details: null,
    partial: false,
  };
}

/**
 * Notices that came in during the run.
 *
 * @sideEffects none
 * @param id - The step's id.
 * @param events - The events.
 * @returns The step.
 */
function notices(id: string, events: AgentNoticeEvent[]): Step {
  return { kind: "agent", id, source: { kind: "report", events } };
}

/**
 * The dashes of the lanes running past a row.
 *
 * @sideEffects none
 * @param row - The row.
 * @returns Each lane's dash array; `null` for a solid one.
 */
function dashes(row: Element): (string | null)[] {
  return [...row.querySelectorAll('[data-mark="through"]')].map((line) => line.getAttribute("stroke-dasharray"));
}

/**
 * The colour a CSS variable comes to, as the page computes it.
 *
 * @sideEffects Adds an element to the page and removes it.
 * @param value - The colour, such as `var(--ok-text)`.
 * @returns The computed colour.
 */
function colorOf(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/**
 * Each lane mark a row draws, as `lane:mark`.
 *
 * @sideEffects none
 * @param row - The row.
 * @returns The marks.
 */
function marks(row: Element): string[] {
  return [...row.querySelectorAll('[data-testid="lanes"] [data-mark]')].map(
    (mark) => `${mark.getAttribute("data-lane") ?? ""}:${mark.getAttribute("data-mark") ?? ""}`,
  );
}

describe("lanes", () => {
  it("opens a lane beside the main line for each child, merges one back where its task ends, and touches one that asks", async () => {
    const steps = [
      spawn("0", "audit"),
      spawn("1", "tests", "agent/tests"),
      {
        kind: "tool",
        id: "2",
        callId: "c2",
        tool: "agent_wait",
        args: {},
        status: "done",
        output: null,
        details: {
          tool: "agent",
          spawned: null,
          events: [
            event("tests", "question", { question: "vitest 还是 jest？\n两种都有" }),
            event("audit", "finished", { elapsedMs: 192_000 }),
          ],
        },
        partial: false,
      },
    ] satisfies Step[];
    const tests = session({
      sessionId: "s-tests",
      containerId: "wks_000000000000000a",
      name: "补测试",
      agent: {
        handle: "tests",
        role: "work",
        status: "waiting_for_parent",
        progress: null,
        question: "vitest?",
        taskId: null,
        taskStartedAt: null,
      },
    });
    const { screen, opened } = await show(turn(steps), [tests]);
    const rows = [...screen.container.querySelectorAll('[data-testid="step"]')];

    expect(rows.map(marks)).toStrictEqual([
      ["0:open"],
      ["0:through", "1:open"],
      ["0:through", "1:through"],
      ["0:through", "1:touch"],
      ["0:merge", "1:through"],
    ]);
    expect(rows.map((row) => row.textContent)).toStrictEqual([
      "开子对话audit只读用时 3 分 12 秒",
      "开子对话补测试可写· agent/tests在问",
      "等了子对话 · 所有子对话 ",
      "子对话「tests」在问 · vitest 还是 jest？打开",
      "audit 完成 · 用时 3 分 12 秒打开",
    ]);
    // The lane of a task not ended in the turn is dashed: the child goes on after it.
    const through = screen.container.querySelectorAll('[data-testid="step"]:nth-child(3) [data-mark="through"]');
    expect([...through].map((line) => line.getAttribute("stroke-dasharray"))).toStrictEqual([null, "2 3"]);
    expect(rows.map((row) => Number.parseFloat(getComputedStyle(row).paddingLeft))).toStrictEqual([46, 46, 46, 46, 46]);
    await screen.getByRole("button", { name: "打开子对话「补测试」" }).click();
    await screen.getByRole("button", { name: "打开子对话「audit」" }).nth(1).click();
    await screen.getByRole("button", { name: "打开子对话「tests」" }).click();

    expect(opened).toStrictEqual(["s-tests", "s-audit", "s-tests"]);
  });

  it("dashes only the part of a lane whose task goes on after the turn, not a freed lane's earlier child", async () => {
    const { screen } = await show(
      turn([
        spawn("0", "audit"),
        bash("1"),
        notices("2", [event("audit", "finished")]),
        spawn("3", "tests"),
        bash("4"),
      ]),
    );
    const rows = screen.getByTestId("step");

    expect([dashes(rows.nth(1).element()), dashes(rows.nth(4).element())]).toStrictEqual([[null], ["2 3"]]);
  });

  it("says on the merge what a work child changed, as the changes capsule does, and on a notice too", async () => {
    const changes = { files: 2, added: 10, removed: 3 };
    const merged = {
      kind: "tool",
      id: "1",
      callId: "c1",
      tool: "agent_wait",
      args: {},
      status: "done",
      output: null,
      details: {
        tool: "agent",
        spawned: null,
        events: [event("tests", "finished", { elapsedMs: 4000, branch: "agent/tests", changes })],
      },
      partial: false,
    } satisfies Step;
    const { screen } = await show(
      turn([spawn("0", "tests", "agent/tests"), merged], {
        source: { kind: "report", events: [event("lint", "finished", { changes })] },
      }),
    );
    const merge = screen.getByTestId("step").nth(2);
    const added = merge.getByText("+10");

    await expect.element(merge).toHaveTextContent("tests 完成 · 用时 4 秒 +10 −3打开");
    expect([
      getComputedStyle(added.element()).color,
      getComputedStyle(merge.getByText("−3").element()).color,
    ]).toStrictEqual([colorOf("var(--ok-text)"), colorOf("var(--danger)")]);
    await expect.element(screen.getByTestId("source-line")).toHaveTextContent("来自子对话「lint」· 完成 +10 −3打开");
  });

  it("draws no lanes in a turn that started no child, and an event of another turn's child as a notice", async () => {
    const step: Step = { kind: "agent", id: "0", source: { kind: "report", events: [event("old", "failed")] } };
    const { screen } = await show(turn([step]));
    const row = screen.getByTestId("step").element();

    expect(screen.container.querySelector('[data-testid="lanes"]')).toBeNull();
    expect(Number.parseFloat(getComputedStyle(row).paddingLeft)).toBe(30);
    expect(row.querySelector('[data-testid="source-line"]')?.textContent).toBe("来自子对话「old」· 出错打开");
  });
});

describe("the time of a child's task going on", () => {
  it("counts beside a child still on its task the time since it was handed down, a second at a time", async () => {
    const time = standingClock(at + 72_000);
    const merged = {
      kind: "tool",
      id: "4",
      callId: "c4",
      tool: "agent_wait",
      args: {},
      status: "done",
      output: null,
      details: { tool: "agent", spawned: null, events: [event("lint", "finished", { elapsedMs: 4000 })] },
      partial: false,
    } satisfies Step;
    const sessions = [
      spawnedChild("audit", "running", at),
      spawnedChild("tests", "waiting_for_you", at + 12_000),
      spawnedChild("lint", "running", at + 60_000),
      spawnedChild("docs", "idle", null),
      spawnedChild("plan", "running", at + 75_000),
      spawnedChild("next", "running", at + 30_000, "t-later"),
    ];
    const links: AgentLinks = {
      open: () => undefined,
      session: (id) => sessions.find((one) => one.sessionId === id),
      parentId: null,
    };
    const screen = await render(
      <ClockContext value={time.clock}>
        <AgentLinksContext value={links}>
          <TurnView
            turn={turn([
              spawn("0", "audit"),
              spawn("1", "tests"),
              spawn("2", "lint"),
              spawn("3", "docs"),
              spawn("5", "plan"),
              spawn("6", "next"),
              merged,
            ])}
            runStartedAt={at}
          />
        </AgentLinksContext>
      </ClockContext>,
    );
    const statuses = screen.getByTestId("child-status");
    const before = statuses.elements().map((status) => status.textContent);

    time.advance(1000);

    await expect.element(statuses.nth(0)).toHaveTextContent("运行中· 用时 1 分 13 秒");
    expect([before, statuses.elements().map((status) => status.textContent)]).toStrictEqual([
      ["运行中· 用时 1 分 12 秒", "在等你· 用时 1 分 0 秒", "运行中· 用时 4 秒", "完成", "运行中· 用时 0 秒", "运行中"],
      ["运行中· 用时 1 分 13 秒", "在等你· 用时 1 分 1 秒", "运行中· 用时 4 秒", "完成", "运行中· 用时 0 秒", "运行中"],
    ]);
    await screen.unmount();
    expect(time.ticking()).toBe(0);
  });
});

describe("a turn not opened by you", () => {
  it("opens with a line for each notice, a question in its colour, each opening its child", async () => {
    const source = {
      kind: "report" as const,
      events: [event("audit", "finished", { elapsedMs: 5_000 }), event("tests", "question", { question: "哪个？" })],
    };
    const { screen, opened } = await show(turn([], { source }));
    const lines = screen.getByTestId("source-line");

    expect(lines.elements().map((line) => [line.textContent, line.getAttribute("data-event")])).toStrictEqual([
      ["来自子对话「audit」· 完成 · 用时 5 秒打开", "finished"],
      ["来自子对话「tests」· 在问 · 哪个？打开", "question"],
    ]);
    expect(getComputedStyle(lines.nth(1).element()).color).not.toBe(getComputedStyle(lines.nth(0).element()).color);
    expect(screen.container.querySelector('[data-testid="user-message"]')).toBeNull();
    await lines.nth(1).getByRole("button", { name: "打开子对话「tests」" }).click();

    expect(opened).toStrictEqual(["s-tests"]);
  });

  it("opens a child's task with where it came from, the task whole below it, and the way back to the parent", async () => {
    const source = { kind: "task" as const, fromTitle: "修复", taskId: "t", text: "补测试\n跑一遍" };
    const { screen, opened } = await show(turn([], { source }), [], "main");

    await expect.element(screen.getByTestId("source-line")).toHaveTextContent("来自主对话的 agent · 交代的事主对话");
    expect(screen.getByTestId("task-text").element().textContent).toBe("补测试\n跑一遍");
    await screen.getByRole("button", { name: "主对话" }).click();

    expect(opened).toStrictEqual(["main"]);
  });
});
