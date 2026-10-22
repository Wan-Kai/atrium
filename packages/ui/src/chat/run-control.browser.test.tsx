import type { SessionView } from "@atrium/client";
import { type Control, IDLE_CONTROL, type Interaction, type Turn, UNKNOWN_METRICS } from "@atrium/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { Composer } from "./composer";
import { CapsuleUnit, ControlCards, ControlTrack, type RunActions } from "./run-control";
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
    removeDelivery: (deliveryId) => calls.push(["removeDelivery", deliveryId]),
    resumeDeliveries: () => calls.push(["resumeDeliveries"]),
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

  it("lists the deliveries with the messages: one waiting can be removed, one handed to pi cannot", async () => {
    const { calls, actions } = recording();
    const control: Control = {
      ...queued("再看一下 CSRF"),
      deliveries: [
        { id: "d1", kind: "report", fromTitle: "安全审查", event: "finished", state: "sending" },
        { id: "d2", kind: "report", fromTitle: "补测试", event: "question", state: "waiting" },
        { id: "d3", kind: "task", fromTitle: "修复", event: null, state: "waiting" },
      ],
    };
    const screen = await render(track(control, true, actions));
    await screen.getByRole("button", { name: "排队 4" }).click();
    const rows = screen.getByTestId("delivery");

    expect(rows.elements().map((row) => [row.textContent, row.getAttribute("data-state")])).toStrictEqual([
      ["来自子对话「安全审查」：完成已交给 pi", "sending"],
      ["来自子对话「补测试」：在问你的 agent待送", "waiting"],
      ["来自主对话的 agent待送", "waiting"],
    ]);
    await expect.element(rows.nth(0).getByRole("button")).not.toBeInTheDocument();
    await expect.element(rows.nth(0).getByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    await rows.nth(1).getByRole("button", { name: "删除" }).click();
    await rows.nth(2).getByRole("button", { name: "删除" }).click();
    expect(calls).toStrictEqual([
      ["removeDelivery", "d2"],
      ["removeDelivery", "d3"],
    ]);
  });

  it("does not open the queue as a delivery arrives, and says the held ones wait until you go on", async () => {
    const { calls, actions } = recording();
    const delivery = { id: "d1", kind: "report", fromTitle: "安全审查", event: "finished", state: "waiting" } as const;
    const screen = await render(track(IDLE_CONTROL, true, actions));
    await screen.rerender(track({ ...IDLE_CONTROL, deliveries: [delivery] }, true, actions));
    await expect.element(screen.getByRole("dialog", { name: "排队" })).not.toBeInTheDocument();

    await screen.rerender(track({ ...IDLE_CONTROL, deliveries: [delivery], deliveriesHeld: "restart" }, true, actions));
    await screen.getByRole("button", { name: "排队 1 · 已暂停" }).click();
    await expect.element(screen.getByRole("dialog", { name: "排队" }).getByText("排队 1 · 已暂停")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "清空" })).not.toBeInTheDocument();
    await screen.getByTestId("deliveries-held").getByRole("button", { name: "继续" }).click();

    expect(calls).toStrictEqual([["resumeDeliveries"]]);
  });

  it("says deliveries pi did not take were not sent, with 重试 that lets them go again", async () => {
    const { calls, actions } = recording();
    const delivery = { id: "d1", kind: "report", fromTitle: "安全审查", event: "finished", state: "waiting" } as const;
    const screen = await render(
      track({ ...IDLE_CONTROL, deliveries: [delivery], deliveriesHeld: "stalled" }, false, actions),
    );
    await screen.getByRole("button", { name: "排队 1 · 已暂停" }).click();
    const held = screen.getByTestId("deliveries-held");

    await expect.element(held).toHaveTextContent("没送出去重试");
    await held.getByRole("button", { name: "重试" }).click();

    expect(calls).toStrictEqual([["resumeDeliveries"]]);
  });

  it("offers 继续发送 for a stopped queue that holds only deliveries, and nothing to clear", async () => {
    const { calls, actions } = recording();
    const delivery = { id: "d1", kind: "task", fromTitle: "修复", event: null, state: "waiting" } as const;
    const screen = await render(track({ ...IDLE_CONTROL, deliveries: [delivery], paused: "stopped" }, false, actions));
    await screen.getByRole("button", { name: "排队 1 · 已暂停" }).click();

    await expect.element(screen.getByRole("button", { name: "清空" })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "继续发送" }).click();

    expect(calls).toStrictEqual([["resume"]]);
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

/** What a capsule's panel was doing when the capsule said it opened or closed. */
interface Moment {
  /** Whether the panel was there. */
  readonly shown: boolean;
  /** The panel's and each row's first animation: its duration, delay and easing. */
  readonly motion: readonly (readonly [unknown, unknown, unknown])[];
  /** The panel's clip at the start and the end of its animation, if it has one. */
  readonly clip: readonly unknown[];
}

/**
 * Notes what a capsule's panel and rows are doing now.
 *
 * @remarks
 * Read from the capsule's parent, the unit that holds the capsule and its panel.
 *
 * @sideEffects none
 * @param capsule - The capsule.
 * @returns The moment.
 */
function momentOf(capsule: Element): Moment {
  const panel = capsule.parentElement?.querySelector('[role="dialog"]') ?? null;
  const parts = [panel, ...(panel?.querySelectorAll("[data-panel-row]") ?? [])];
  const effect = panel?.getAnimations()[0]?.effect;
  return {
    shown: panel !== null,
    clip: effect instanceof KeyframeEffect ? effect.getKeyframes().map((frame) => frame["clipPath"]) : [],
    motion: parts.map((part) => {
      const timing = part?.getAnimations()[0]?.effect?.getTiming();
      return [timing?.duration, timing?.delay, timing?.easing] as const;
    }),
  };
}

/**
 * Waits for a capsule to say it opened or closed, and notes then what its panel does.
 *
 * @remarks
 * Noted in the same turn as React's commit, so the time the motion takes cannot make it flaky.
 *
 * @sideEffects Observes the capsule's attributes until it says so.
 * @param capsule - The capsule.
 * @param expanded - Whether to wait for it to open or to close.
 * @returns The moment it said so.
 */
function whenExpanded(capsule: Element, expanded: boolean): Promise<Moment> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (capsule.getAttribute("aria-expanded") !== String(expanded)) return;
      observer.disconnect();
      resolve(momentOf(capsule));
    });
    observer.observe(capsule, { attributes: true, attributeFilter: ["aria-expanded"] });
  });
}

/**
 * Where an element is on the page, in whole pixels.
 *
 * @remarks
 * The edges the tests compare; rounding keeps sub-pixel layout from mattering.
 *
 * @sideEffects none
 * @param element - The element.
 * @returns Its top, right, bottom and left.
 */
function edges(element: Element) {
  const box = element.getBoundingClientRect();
  return {
    top: Math.round(box.top),
    right: Math.round(box.right),
    bottom: Math.round(box.bottom),
    left: Math.round(box.left),
  };
}

/**
 * How far a capsule's caret is turned.
 *
 * @remarks
 * The caret is the capsule's only drawing.
 *
 * @sideEffects none
 * @param capsule - The capsule.
 * @returns The caret's computed `rotate`, or `null` without a caret.
 */
function caretTurn(capsule: Element): string | null {
  const caret = capsule.querySelector("svg");
  return caret === null ? null : getComputedStyle(caret).rotate;
}

/**
 * Makes the page say the user asked for less motion, until the mocks are restored.
 *
 * @remarks
 * Answers with real media query lists, matching everything for less motion and nothing else.
 *
 * @sideEffects Replaces `window.matchMedia` with a spy.
 */
function askForLessMotion(): void {
  const real = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    real(query === "(prefers-reduced-motion: reduce)" ? "all" : "not all"),
  );
}

/** The motion's curve (design-language, "胶囊点开的面板"). */
const EASE = "cubic-bezier(0.45, 0, 0.15, 1)";

/** No animation. */
const STILL = [undefined, undefined, undefined];

/**
 * The bar with a child capsule of the same kind, and a button outside the bar.
 *
 * @remarks
 * The child capsule is a `CapsuleUnit` of its own, so a press on it is one on another capsule.
 *
 * @sideEffects none
 * @param control - The run control.
 * @returns The page.
 */
function scene(control: Control) {
  return (
    <div>
      <button type="button">外面</button>
      <div style={{ position: "relative", marginTop: 400, width: 600 }}>
        <ControlTrack
          control={control}
          running
          actions={recording().actions}
          renderChildCapsule={({ open, onToggle }) => (
            <CapsuleUnit
              open={open}
              onToggle={onToggle}
              onClose={onToggle}
              label="子对话"
              span="content"
              capsule="子对话"
            >
              <div data-panel-row>一个子对话</div>
            </CapsuleUnit>
          )}
        />
      </div>
    </div>
  );
}

describe("ControlTrack's panels on their capsules", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("floats the queue 8px above its capsule, from the capsule's left to the bar's right edge, its caret turned", async () => {
    const screen = await render(scene(queued("one", "two")));
    const capsule = screen.getByRole("button", { name: "排队 2" });
    await capsule.click();
    const panel = edges(screen.getByRole("dialog", { name: "排队" }).element());
    const bar = edges(screen.getByTestId("capsule-bar").element());
    const cap = edges(capsule.element());

    expect([cap.top - panel.bottom, panel.left - cap.left, panel.right - bar.right]).toStrictEqual([8, 0, 0]);
    await expect.poll(() => caretTurn(capsule.element())).toBe("180deg");
  });

  it("closes the queue on a press outside it, the panel going at once", async () => {
    const screen = await render(scene(queued("one", "two")));
    const capsule = screen.getByRole("button", { name: "排队 2" });
    await capsule.click();
    await expect.element(screen.getByRole("dialog", { name: "排队" })).toBeInTheDocument();
    const closed = whenExpanded(capsule.element(), false);

    await screen.getByRole("button", { name: "外面" }).click();

    expect((await closed).shown).toBe(false);
  });

  it("keeps the queue open on a press in the input box or on its stop button, and closes it on blank space", async () => {
    const stops: string[] = [];
    const screen = await render(
      <div>
        <button type="button">外面</button>
        <div style={{ marginTop: 400, width: 680 }}>
          <Composer
            onSend={() => undefined}
            draftKey="queue-panel"
            running
            onStop={() => stops.push("stop")}
            above={<ControlTrack control={queued("one")} running actions={recording().actions} />}
          />
        </div>
      </div>,
    );
    const capsule = screen.getByRole("button", { name: "排队 1" });
    await capsule.click();

    await screen.getByRole("textbox", { name: "消息" }).click();
    await screen.getByRole("button", { name: "停止" }).click();
    await expect.element(capsule).toHaveAttribute("aria-expanded", "true");
    await screen.getByRole("button", { name: "外面" }).click();

    await expect.element(capsule).toHaveAttribute("aria-expanded", "false");
    expect(stops).toStrictEqual(["stop"]);
  });

  it("closes the queue on Escape, but not on the one that gives up an edit", async () => {
    const screen = await render(scene(queued("one")));
    const capsule = screen.getByRole("button", { name: "排队 1" });
    await capsule.click();
    await screen.getByRole("button", { name: "编辑" }).click();

    await userEvent.type(screen.getByRole("textbox", { name: "编辑排队的消息" }), "{Escape}");
    await expect.element(screen.getByRole("button", { name: "编辑" })).toBeVisible();
    await expect.element(capsule).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");

    await expect.element(capsule).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => screen.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("switches to the other capsule's panel on a press there", async () => {
    const screen = await render(scene(queued("one")));
    const queue = screen.getByRole("button", { name: "排队 1" });
    const children = screen.getByRole("button", { name: "子对话" });
    await queue.click();

    await children.click();

    await expect.element(children).toHaveAttribute("aria-expanded", "true");
    await expect.element(queue).toHaveAttribute("aria-expanded", "false");
    await expect.element(screen.getByRole("dialog", { name: "子对话" })).toBeInTheDocument();
    await expect.element(screen.getByRole("dialog", { name: "排队" })).not.toBeInTheDocument();
  });

  it("grows the panel from its bottom edge, the rows one by one after it, and closes it at once", async () => {
    const screen = await render(scene(queued("one", "two")));
    const capsule = screen.getByRole("button", { name: "排队 2" });
    const opened = whenExpanded(capsule.element(), true);
    await capsule.click();

    expect(await opened).toStrictEqual({
      shown: true,
      clip: ["inset(100% -64px -64px)", "inset(-64px)"],
      motion: [
        [280, 0, EASE],
        [220, 60, EASE],
        [220, 90, EASE],
      ],
    });
    await expect.poll(() => screen.getByRole("dialog", { name: "排队" }).element().getAnimations()).toStrictEqual([]);
    const closed = whenExpanded(capsule.element(), false);
    await capsule.click();
    expect(await closed).toStrictEqual({ shown: false, clip: [], motion: [STILL] });
  });

  it("opens and closes at once when less motion is asked for", async () => {
    askForLessMotion();
    const screen = await render(scene(queued("one")));
    const capsule = screen.getByRole("button", { name: "排队 1" });
    const opened = whenExpanded(capsule.element(), true);
    await capsule.click();
    expect(await opened).toStrictEqual({ shown: true, clip: [], motion: [STILL, STILL] });

    const closed = whenExpanded(capsule.element(), false);
    await capsule.click();

    expect(await closed).toStrictEqual({ shown: false, clip: [], motion: [STILL] });
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
    source: null,
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
