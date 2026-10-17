import type { SessionView } from "@atrium/client";
import { type Control, IDLE_CONTROL, type Interaction, type Turn, UNKNOWN_METRICS } from "@atrium/protocol";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { ControlCards, ControlTrack, type RunActions } from "./run-control";
import { Transcript } from "./transcript";

/** Actions that record what was asked of them. */
function recording() {
  const calls: unknown[][] = [];
  const actions: RunActions = {
    resume: () => calls.push(["resume"]),
    clear: () => calls.push(["clear"]),
    update: (itemId, text) => calls.push(["update", itemId, text]),
    remove: (itemId) => calls.push(["remove", itemId]),
    steerQueued: (itemId) => calls.push(["steerQueued", itemId]),
    answer: (interactionId, answer) => calls.push(["answer", interactionId, answer]),
    retry: () => calls.push(["retry"]),
  };
  return { calls, actions };
}

/** Run control with these queued texts. */
function queued(...texts: string[]): Control {
  return {
    ...IDLE_CONTROL,
    queue: texts.map((text, index) => ({ id: `i${index + 1}`, text, createdAt: 0, images: 0 })),
  };
}

/** The capsule bar where it floats: above a box of the input's width. */
function track(control: Control, running: boolean, actions: RunActions) {
  return (
    <div style={{ position: "relative", marginTop: 400, width: 600 }}>
      <ControlTrack control={control} running={running} actions={actions} />
    </div>
  );
}

describe("ControlTrack", () => {
  it("shows nothing while nothing waits", async () => {
    const { actions } = recording();
    const screen = await render(track(IDLE_CONTROL, true, actions));

    expect(screen.container.textContent).toBe("");
  });

  it("opens the queue as a message joins it, and edits, removes and steers its messages", async () => {
    const { calls, actions } = recording();
    const screen = await render(track(queued("one"), true, actions));
    await expect.element(screen.getByRole("button", { name: "排队 1" })).toBeVisible();
    await expect.element(screen.getByRole("dialog", { name: "排队" })).not.toBeInTheDocument();

    await screen.rerender(track(queued("one", "two"), true, actions));
    await expect.element(screen.getByText("排队 2 · 本次运行结束后依次发送")).toBeVisible();
    await screen.getByRole("button", { name: "编辑" }).first().click();
    const field = screen.getByRole("textbox", { name: "编辑排队的消息" });
    await userEvent.clear(field);
    await userEvent.type(field, "ONE{Enter}");
    await screen.getByRole("button", { name: "插话" }).nth(1).click();
    await screen.getByRole("button", { name: "删除" }).first().click();
    await screen.getByRole("button", { name: "清空" }).click();
    await screen.getByRole("button", { name: "排队 2" }).click();

    await expect.element(screen.getByRole("dialog", { name: "排队" })).not.toBeInTheDocument();
    expect(calls).toStrictEqual([["update", "i1", "ONE"], ["steerQueued", "i2"], ["remove", "i1"], ["clear"]]);
  });

  it("floats one list at a time: the queue's or the child conversations'", async () => {
    const { actions } = recording();
    /** The bar with a child capsule that only says whether its list is open. */
    const bar = (control: Control) => (
      <div style={{ position: "relative", marginTop: 400, width: 600 }}>
        <ControlTrack
          control={control}
          running
          actions={actions}
          renderChildCapsule={({ open, onToggle }) => (
            <button type="button" className="pointer-events-auto" aria-expanded={open} onClick={onToggle}>
              子对话
            </button>
          )}
        />
      </div>
    );
    const screen = await render(bar(queued("one")));
    await screen.rerender(bar(queued("one", "two")));
    const children = screen.getByRole("button", { name: "子对话" });
    await expect.element(screen.getByRole("dialog", { name: "排队" })).toBeVisible();
    await expect.element(children).toHaveAttribute("aria-expanded", "false");

    await children.click();
    await expect.element(children).toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByRole("dialog", { name: "排队" })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "排队 2" }).click();

    await expect.element(screen.getByRole("dialog", { name: "排队" })).toBeVisible();
    await expect.element(children).toHaveAttribute("aria-expanded", "false");
  });

  it("says how many images a queued message has, and names one that is only images", async () => {
    const { actions } = recording();
    const control: Control = {
      ...IDLE_CONTROL,
      queue: [
        { id: "i1", text: "看图", createdAt: 0, images: 2 },
        { id: "i2", text: "", createdAt: 0, images: 1 },
      ],
    };

    const screen = await render(track(control, true, actions));
    await screen.getByRole("button", { name: "排队 2" }).click();

    expect(
      screen
        .getByTestId("queued")
        .elements()
        .map((row) => row.textContent?.replace(/插话|编辑|删除/g, "")),
    ).toStrictEqual(["看图2 张图片", "图片1 张图片"]);
  });

  it("keeps an edit unchanged when given up or emptied, and offers no steer while idle", async () => {
    const { calls, actions } = recording();
    const screen = await render(track(queued("one"), false, actions));
    await screen.getByRole("button", { name: "排队 1" }).click();

    await screen.getByRole("button", { name: "编辑" }).click();
    await userEvent.type(screen.getByRole("textbox", { name: "编辑排队的消息" }), "{Escape}");
    await screen.getByRole("button", { name: "编辑" }).click();
    await userEvent.clear(screen.getByRole("textbox", { name: "编辑排队的消息" }));
    await screen.getByRole("button", { name: "完成" }).click();

    await expect.element(screen.getByRole("button", { name: "插话" })).not.toBeInTheDocument();
    expect(calls).toStrictEqual([]);
  });

  it("says a paused queue is paused and offers to go on, and counts the steers on their way", async () => {
    const { calls, actions } = recording();
    const control: Control = {
      ...queued("one"),
      paused: "stopped",
      steers: [
        { id: "s1", text: "a" },
        { id: "s2", text: "b" },
      ],
    };
    const screen = await render(track(control, false, actions));

    await screen.getByRole("button", { name: "排队 1 · 已暂停" }).click();
    await screen.getByRole("button", { name: "继续发送" }).click();

    await expect.element(screen.getByTestId("steers")).toHaveTextContent("2 条插话将在下一步前送达");
    expect(calls).toStrictEqual([["resume"]]);
  });
});

/** A question from an extension. */
function question(fields: Partial<Interaction> & Pick<Interaction, "id" | "kind">): Interaction {
  return {
    title: "问题",
    message: null,
    options: null,
    placeholder: null,
    prefill: null,
    deadline: null,
    ...fields,
  };
}

describe("ControlCards", () => {
  it("answers each kind of question on its card, and cancels any", async () => {
    const { calls, actions } = recording();
    const control: Control = {
      ...IDLE_CONTROL,
      interactions: [
        question({ id: "d1", kind: "select", title: "用哪个？", options: ["vitest", "jest"] }),
        question({ id: "d2", kind: "confirm", title: "删掉吗？", message: "会删除 dist" }),
        question({ id: "d3", kind: "input", title: "名字", placeholder: "app" }),
        question({ id: "d4", kind: "editor", title: "改一下", prefill: "旧的" }),
      ],
    };
    const screen = await render(<ControlCards control={control} actions={actions} />);

    await screen.getByRole("button", { name: "jest" }).click();
    await expect.element(screen.getByText("会删除 dist")).toBeVisible();
    await screen.getByRole("button", { name: "否" }).click();
    await userEvent.type(screen.getByRole("textbox", { name: "名字" }), "atrium{Enter}");
    const editor = screen.getByRole("textbox", { name: "改一下" });
    await expect.element(editor).toHaveValue("旧的");
    await userEvent.clear(editor);
    await userEvent.type(editor, "新的");
    await screen.getByRole("button", { name: "提交" }).nth(1).click();
    await screen.getByRole("button", { name: "取消" }).first().click();

    expect(calls).toStrictEqual([
      ["answer", "d1", { value: "jest" }],
      ["answer", "d2", { confirmed: false }],
      ["answer", "d3", { value: "atrium" }],
      ["answer", "d4", { value: "新的" }],
      ["answer", "d1", { cancelled: true }],
    ]);
  });

  it("counts down to a question's deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(10_000);
    const { actions } = recording();
    const control = { ...IDLE_CONTROL, interactions: [question({ id: "d1", kind: "confirm", deadline: 15_000 })] };
    const screen = await render(<ControlCards control={control} actions={actions} />);
    await expect.element(screen.getByText("来自 extension · 5 秒后超时")).toBeVisible();

    await vi.advanceTimersByTimeAsync(2000);

    await expect.element(screen.getByText("来自 extension · 3 秒后超时")).toBeVisible();
    vi.useRealTimers();
  });

  it("offers to retry a session pi keeps crashing in", async () => {
    const { calls, actions } = recording();
    const control: Control = { ...IDLE_CONTROL, failure: { reason: "crashed", attempts: 3 } };
    const screen = await render(<ControlCards control={control} actions={actions} />);

    await expect.element(screen.getByText("pi 连续崩溃，自动重启 3 次都没有成功")).toBeVisible();
    await screen.getByRole("button", { name: "重试" }).click();

    expect(calls).toStrictEqual([["retry"]]);
  });
});

/** A finished turn of session s1. */
function turn(id: string, fields: Partial<Turn> = {}): Turn {
  return {
    kind: "turn",
    id,
    user: { text: `问 ${id}`, images: 0, clientMessageId: null, auto: false, command: null, timestamp: 0 },
    steps: [],
    outcome: "done",
    error: null,
    startedAt: 0,
    durationMs: 1000,
    usage: null,
    changes: [],
    ...fields,
  };
}

/** A ready view of session s1. */
function view(fields: Partial<SessionView>): SessionView {
  return {
    sessionId: "s1",
    status: "ready",
    epoch: 1,
    seq: 0,
    items: [],
    hasOlder: false,
    run: null,
    pending: [],
    control: IDLE_CONTROL,
    model: null,
    fast: false,
    metrics: UNKNOWN_METRICS,
    ...fields,
  };
}

describe("Transcript after an interruption", () => {
  it("offers 重试 on the last turn only when it failed and nothing runs", async () => {
    const retried: string[] = [];
    const failed = { outcome: "failed", error: "overloaded" } as const;
    const items = [turn("t1", failed), turn("t2", failed)];
    const screen = await render(
      <div style={{ height: 600, display: "flex" }}>
        <Transcript
          view={view({ items })}
          onLoadOlder={() => undefined}
          onLoadStep={() => undefined}
          onRetry={() => retried.push("retry")}
        />
      </div>,
    );

    await screen.getByRole("button", { name: "重试" }).click();
    expect(retried).toStrictEqual(["retry"]);
    await screen.rerender(
      <div style={{ height: 600, display: "flex" }}>
        <Transcript
          view={view({ items, run: { runId: "r", startedAt: 0 } })}
          onLoadOlder={() => undefined}
          onLoadStep={() => undefined}
          onRetry={() => retried.push("retry")}
        />
      </div>,
    );

    await expect.element(screen.getByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });

  it("offers no 重试 while pi starts again", async () => {
    const screen = await render(
      <div style={{ height: 600, display: "flex" }}>
        <Transcript
          view={view({
            items: [turn("t1", { outcome: "failed", error: "pi exited" })],
            control: { ...IDLE_CONTROL, restarting: true },
          })}
          onLoadOlder={() => undefined}
          onLoadStep={() => undefined}
          onRetry={() => undefined}
        />
      </div>,
    );

    await expect.element(screen.getByText("回复出错")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "重试" })).not.toBeInTheDocument();
  });

  it("notes how an extension's question ended", async () => {
    const screen = await render(
      <div style={{ height: 600, display: "flex" }}>
        <Transcript
          view={view({
            items: [
              turn("t1"),
              {
                kind: "notice",
                id: "n1",
                notice: "interaction",
                title: "用哪个？",
                outcome: "answered",
                value: "vitest",
                confirmed: null,
                timestamp: 0,
              },
            ],
          })}
          onLoadOlder={() => undefined}
          onLoadStep={() => undefined}
        />
      </div>,
    );

    await expect.element(screen.getByTestId("notice")).toHaveTextContent("用哪个？ → vitest");
  });

  it("notes a restart between turns and marks the message the host sent", async () => {
    const screen = await render(
      <div style={{ height: 600, display: "flex" }}>
        <Transcript
          view={view({
            items: [
              turn("t1", { outcome: "failed" }),
              { kind: "notice", id: "n1", notice: "restarted", attempt: 2, timestamp: 0 },
              turn("t2", {
                user: { text: "接着做", images: 0, clientMessageId: null, auto: true, command: null, timestamp: 0 },
              }),
            ],
          })}
          onLoadOlder={() => undefined}
          onLoadStep={() => undefined}
        />
      </div>,
    );

    await expect.element(screen.getByTestId("notice")).toHaveTextContent("进程已自动重启（第 2 / 3 次）");
    await expect.element(screen.getByTestId("user-message").nth(1)).toMatchTextContent(/系统自动发出/);
    await expect.element(screen.getByTestId("user-message").nth(0)).not.toMatchTextContent(/系统自动发出/);
  });
});
