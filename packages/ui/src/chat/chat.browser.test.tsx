import type { AtriumClient, SessionView } from "@atrium/client";
import { CommandError, ConnectionLostError } from "@atrium/client";
import { type ThinkingLevel, type TranscriptItem, type Turn, IDLE_CONTROL, UNKNOWN_METRICS } from "@atrium/protocol";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { pageDrafts } from "../state/use-draft";
import { pageNotices } from "../state/session-notices";
import { fakeClient, session } from "../test/fake-client";
import { ConversationArea, describeModelError, describeSendError } from "./conversation-area";
import { Composer } from "./composer";
import { UserBubble } from "./messages";
import { ClockContext, type UiClock } from "../state/clock";
import { RunStatus, formatElapsed } from "./run-status";
import { type MessageImages, MessageImagesContext } from "./message-images";
import { Transcript } from "./transcript";

/** The chat the area shows in most tests. */
const CHAT = "cht_a";

// Drafts are kept per session in the page's storage; each test starts without any.
afterEach(() => localStorage.clear());

/** A ready view of session s1 with the given fields. */
function view(fields: Partial<SessionView> = {}): SessionView {
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

/** A turn answered with `text`. */
function turn(id: string, text: string, fields: Partial<Turn> = {}): Turn {
  return {
    kind: "turn",
    id,
    user: {
      text: `问 ${id}`,
      images: 0,
      clientMessageId: null,
      auto: false,
      command: null,
      timestamp: Date.UTC(2026, 9, 7, 14, 31),
    },
    steps: [{ kind: "text", id: "0", text }],
    outcome: "done",
    error: null,
    startedAt: Date.UTC(2026, 9, 7, 14, 31),
    durationMs: 1000,
    usage: null,
    changes: [],
    ...fields,
  };
}

describe("Composer", () => {
  it("sends on Enter, keeps Shift+Enter as a new line, and clears the box", async () => {
    const sent: string[] = [];
    const screen = await render(<Composer draftKey="composer-1" onSend={(text) => sent.push(text)} />);
    const box = screen.getByRole("textbox", { name: "消息" });

    await userEvent.type(box, "第一行{Shift>}{Enter}{/Shift}第二行{Enter}");

    expect(sent).toStrictEqual(["第一行\n第二行"]);
    expect((box.element() as HTMLTextAreaElement).value).toBe("");
  });

  it("does not send while an input method is composing, nor when empty", async () => {
    const sent: string[] = [];
    const screen = await render(<Composer draftKey="composer-2" onSend={(text) => sent.push(text)} />);
    const box = screen.getByRole("textbox", { name: "消息" }).element() as HTMLTextAreaElement;

    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "   {Enter}");

    expect(sent).toStrictEqual([]);
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("sends with the button", async () => {
    const sent: string[] = [];
    const screen = await render(<Composer draftKey="composer-3" onSend={(text) => sent.push(text)} />);
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "你好");

    await screen.getByRole("button", { name: "发送" }).click();

    expect(sent).toStrictEqual(["你好"]);
  });

  it("keeps the text while a stop waits for pi, and sends it once the stop ends", async () => {
    const sent: string[] = [];
    const screen = await render(<Composer draftKey="composer-4" onSend={(text) => sent.push(text)} stopping />);
    const box = screen.getByRole("textbox", { name: "消息" });

    await userEvent.type(box, "下一步{Enter}");
    expect(sent).toStrictEqual([]);
    await expect.element(box).toHaveValue("下一步");
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await screen.rerender(<Composer draftKey="composer-4" onSend={(text) => sent.push(text)} />);
    await userEvent.type(box, "{Enter}");

    expect(sent).toStrictEqual(["下一步"]);
  });
});

describe("messages", () => {
  it("shows a pending message without a time, and a confirmed one with it", async () => {
    const screen = await render(
      <>
        <UserBubble text="还没确认" />
        <UserBubble text="已确认" timestamp={Date.UTC(2026, 9, 7, 14, 31)} />
      </>,
    );
    const [pending, confirmed] = screen.container.querySelectorAll('[data-testid="user-message"]');

    expect(pending?.getAttribute("data-pending")).toBe("true");
    expect(pending?.textContent).toBe("还没确认");
    expect(confirmed?.getAttribute("data-pending")).toBe("false");
    expect(confirmed?.textContent).toMatch(/^已确认\d{2}:31$/);
  });

  it("folds a message longer than about 12 lines, with a way to open and close it", async () => {
    const long = Array.from({ length: 30 }, (_, index) => `第 ${index} 行`).join("\n");
    const screen = await render(
      <>
        <UserBubble text={long} images={2} />
        <UserBubble text="短" />
      </>,
    );
    const body = screen.getByTestId("user-text").nth(0).element() as HTMLElement;
    const short = screen.getByTestId("user-text").nth(1).element();

    await vi.waitFor(() => expect(body.scrollHeight).toBeGreaterThan(body.clientHeight));
    expect(screen.getByRole("img", { name: "正在加载图片" }).elements()).toHaveLength(2);
    await screen.getByRole("button", { name: "展开" }).click();
    expect(body.scrollHeight).toBe(body.clientHeight);
    await screen.getByRole("button", { name: "收起" }).click();
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    expect(short.parentElement?.querySelectorAll("button")).toHaveLength(0);
  });

  it("counts the run's time by the injected clock", async () => {
    let now = 100_000;
    const ticks: (() => void)[] = [];
    const clock: UiClock = {
      now: () => now,
      every: (_ms, tick) => {
        ticks.push(tick);
        return () => ticks.splice(ticks.indexOf(tick), 1);
      },
      after: () => () => undefined,
    };
    const screen = await render(
      <ClockContext value={clock}>
        <RunStatus startedAt={88_000} />
      </ClockContext>,
    );
    await expect.element(screen.getByTestId("run-status")).toHaveTextContent("进行中 · 12s");
    const cat = screen.getByTestId("run-cat").element();
    expect(cat.getAttribute("aria-hidden")).toBe("true");
    expect(cat.querySelectorAll(".atrium-run-cat-eyes ellipse")).toHaveLength(2);

    now = 101_000;
    for (const tick of ticks) tick();

    await expect.element(screen.getByTestId("run-status")).toHaveTextContent("进行中 · 13s");
    await screen.unmount();
    expect(ticks).toStrictEqual([]);
  });

  it("formats run times compactly", () => {
    expect([0, 12_400, 59_999, 133_000, 3_840_000].map(formatElapsed)).toStrictEqual([
      "0s",
      "12s",
      "59s",
      "2m 13s",
      "1h 4m",
    ]);
  });
});

/** The transcript with the given items in a 300 px box. */
function at(items: TranscriptItem[], fields: Partial<SessionView> = {}, onLoadOlder = () => undefined) {
  return (
    <div style={{ height: 300, display: "flex", flexDirection: "column" }}>
      <Transcript view={view({ items, ...fields })} onLoadOlder={onLoadOlder} onLoadStep={() => undefined} />
    </div>
  );
}

/**
 * The transcript in the same 300px column, with a box of some height under it, as the composer is.
 *
 * @remarks
 * Growing the box shrinks the transcript without changing its content.
 */
function above(items: TranscriptItem[], below: number) {
  return (
    <div style={{ height: 300, display: "flex", flexDirection: "column" }}>
      <Transcript view={view({ items })} onLoadOlder={() => undefined} onLoadStep={() => undefined} />
      <div style={{ height: below, flex: "none" }} />
    </div>
  );
}

/**
 * How far a scroller's view is from its end, in whole pixels.
 *
 * @sideEffects none
 * @param scroller - The scroller.
 * @returns The distance; 0 at the bottom.
 */
function fromEnd(scroller: HTMLElement): number {
  return Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
}

/**
 * The farthest a scroller's view gets from its end over some time, as each frame is painted.
 *
 * @remarks
 * Checked in a size observer made after the transcript's, so after the view's own scrolling in
 * each frame; whenever the content or the scroller changes size.
 *
 * @sideEffects Observes the scroller and its content; waits.
 * @param scroller - The scroller.
 * @param ms - How long to watch.
 * @returns The largest distance seen.
 */
async function farthestFromEnd(scroller: HTMLElement, ms: number): Promise<number> {
  let farthest = 0;
  const observer = new ResizeObserver(() => {
    farthest = Math.max(farthest, fromEnd(scroller));
  });
  observer.observe(scroller);
  for (const child of scroller.children) observer.observe(child);
  await new Promise((resolve) => setTimeout(resolve, ms));
  observer.disconnect();
  return Math.max(farthest, fromEnd(scroller));
}

/**
 * Makes an element taller, as content streaming or unfolding into it does.
 *
 * @sideEffects Appends a block to the element.
 * @param element - The element.
 * @param px - How much taller.
 */
function grow(element: HTMLElement | undefined, px: number): void {
  const block = document.createElement("div");
  block.style.height = `${px}px`;
  element?.append(block);
}

/**
 * Waits until just after the next frame is painted.
 *
 * @remarks
 * A timer set in a frame's callback runs after that frame's layout, size observers and paint.
 *
 * @sideEffects Waits.
 */
async function afterFrame(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** A command that passed, as a step. */
function passedCommand(stepId: string): Turn["steps"][number] {
  return {
    kind: "tool",
    id: stepId,
    callId: `c${stepId}`,
    tool: "bash",
    args: { command: "pnpm test" },
    status: "done",
    output: "ok\n".repeat(8),
    details: { tool: "bash", command: "pnpm test" },
    partial: false,
  };
}

/**
 * A running turn after some commands, the last of them still going on.
 *
 * @remarks
 * Its thinking and each command's output grow with the count, as a live process does.
 *
 * @sideEffects none
 * @param count - How many commands it has run.
 * @returns The turn.
 */
function liveTurn(count: number): Turn {
  const done = Array.from({ length: count - 1 }, (_, index) => ({
    ...passedCommand(String(index)),
    output: "ok\n".repeat(index + 2),
  }));
  const current = { ...passedCommand(String(count - 1)), status: "running" as const, output: "ok\n" };
  return turn("live", "", {
    steps: [{ kind: "thinking", id: "t", text: "想一想。".repeat(count * 4), durationMs: null }, ...done, current],
    outcome: "running",
    durationMs: null,
  });
}

/**
 * Images where the message `q1` was sent from this page, and the host has a turn's image only
 * once `ended` is set.
 *
 * @remarks
 * Records each load as `turn/place`.
 *
 * @sideEffects none until loaded; loads are recorded.
 * @returns The images, the loads asked for, and the switch.
 */
function turnImages() {
  const loads: string[] = [];
  const host = { ended: false };
  const images: MessageImages = {
    sent: (clientMessageId) => (clientMessageId === "q1" ? ["data:image/png;base64,a"] : null),
    load: (turnId, index) => {
      loads.push(`${turnId}/${index}`);
      return host.ended ? Promise.resolve("data:image/png;base64,b") : Promise.reject(new Error("image_unavailable"));
    },
  };
  return { host, images, loads };
}

/** A finished turn whose process has two commands, before its reply. */
function worked(id: string): Turn {
  return turn(id, "", { steps: [passedCommand("0"), passedCommand("1"), { kind: "text", id: "2", text: "好了" }] });
}

describe("Transcript", () => {
  it("shows turns and notices, then pending sends, then the run until its turn arrives", async () => {
    const screen = await render(
      at(
        [
          turn("t1", "答"),
          { kind: "notice", id: "n1", notice: "compacted", tokensBefore: 1, summary: "", timestamp: 0 },
        ],
        { pending: [{ clientMessageId: "q2", text: "再问" }], run: { runId: "r1", startedAt: Date.now() - 12_000 } },
      ),
    );
    const shown = [
      ...screen.container.querySelectorAll(
        '[data-testid="turn"], [data-testid="notice"], [data-testid="user-message"], [data-testid="run-status"]',
      ),
    ].map((item) => item.getAttribute("data-testid"));

    expect(shown).toStrictEqual(["turn", "user-message", "notice", "user-message", "run-status"]);
    expect(screen.container.querySelector('[data-testid="run-status"]')?.textContent).toMatch(/^进行中 · 1[23]s$/);
  });

  it("shows the run line, without a timer, under a message sent while idle until the run starts", async () => {
    const screen = await render(at([turn("t1", "答")], { pending: [{ clientMessageId: "q2", text: "再问" }] }));
    const shown = [
      ...screen.container.querySelectorAll(
        '[data-testid="turn"], [data-testid="user-message"], [data-testid="run-status"]',
      ),
    ].map((item) => item.getAttribute("data-testid"));

    expect(shown).toStrictEqual(["turn", "user-message", "user-message", "run-status"]);
    expect(screen.container.querySelector('[data-testid="run-status"]')?.textContent).toBe("进行中");
  });

  it("shows no run line for a message sent while its turn runs, which goes into the queue", async () => {
    const running = turn("t1", "答到一半", { outcome: "running" });
    const screen = await render(
      at([running], {
        pending: [{ clientMessageId: "q2", text: "再问" }],
        run: { runId: "r1", startedAt: Date.now() - 3_000 },
      }),
    );

    expect(screen.container.querySelectorAll('[data-testid="user-message"]')).toHaveLength(2);
    expect(screen.container.querySelectorAll('[data-testid="run-status"]')).toHaveLength(0);
  });

  it("keeps the run line in a running turn with nothing to show yet, and drops it once the reply begins", async () => {
    const run = { runId: "r1", startedAt: Date.now() - 3_000 };
    const screen = await render(at([turn("t1", "", { outcome: "running" })], { run }));

    expect(screen.container.querySelectorAll('[data-testid="run-status"]')).toHaveLength(1);
    expect(
      screen.container.querySelector('[data-testid="run-waiting"] [data-testid="run-status"]')?.textContent,
    ).toMatch(/^进行中 · [34]s$/);
    expect(screen.container.querySelectorAll('[data-testid="process-header"]')).toHaveLength(0);

    await screen.rerender(at([turn("t1", "答", { outcome: "running" })], { run }));

    expect(screen.container.querySelectorAll('[data-testid="run-status"]')).toHaveLength(0);
    await expect.element(screen.getByTestId("reply")).toHaveAttribute("data-streaming", "true");
  });

  it("shows no run line in a turn stopped before it had anything to show", async () => {
    const screen = await render(at([turn("t1", "", { outcome: "stopped" })]));

    await expect.element(screen.getByText("已停止")).toBeVisible();
    expect(screen.container.querySelectorAll('[data-testid="run-status"]')).toHaveLength(0);
  });

  it("shows the run's timer in its turn once the turn arrives", async () => {
    const running = turn("t1", "", {
      steps: [{ kind: "thinking", id: "0", text: "嗯", durationMs: null }],
      outcome: "running",
    });
    const screen = await render(at([running], { run: { runId: "r1", startedAt: Date.now() - 3_000 } }));

    expect(screen.container.querySelectorAll('[data-testid="run-status"]')).toHaveLength(1);
    expect(
      screen.container.querySelector('[data-testid="process-header"] [data-testid="run-status"]')?.textContent,
    ).toMatch(/^进行中 · [34]s$/);
  });

  it("asks for older items when the top comes into view, and keeps the place it was reading", async () => {
    const asked: number[] = [];
    const later = Array.from({ length: 30 }, (_, index) => turn(`t${index + 10}`, `第 ${index + 10} 段`));
    const screen = await render(
      at(later, { hasOlder: true }, () => {
        asked.push(1);
      }),
    );
    const scroller = screen.getByTestId("transcript").element() as HTMLElement;
    await vi.waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
    expect(asked).toStrictEqual([]);

    scroller.scrollTop = 0;
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));
    const reading = screen.container.querySelector('[data-turn-id="t10"]') as HTMLElement;
    const before = reading.getBoundingClientRect().top;
    const earlier = Array.from({ length: 10 }, (_, index) => turn(`t${index}`, `第 ${index} 段`));
    await screen.rerender(
      at([...earlier, ...later], { hasOlder: false }, () => {
        asked.push(1);
      }),
    );

    await vi.waitFor(() => expect(Math.abs(reading.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1));
    expect(screen.container.textContent).not.toContain("正在加载更早的记录");
  });

  it("lists the questions along the edge and jumps to one", async () => {
    // The bar only shows in a wide window.
    await page.viewport(1280, 800);
    const turns = Array.from({ length: 12 }, (_, index) => turn(`t${index}`, `第 ${index} 段`));
    const screen = await render(at(turns));
    const nav = screen.getByRole("navigation", { name: "提问导航" });
    await expect.element(nav).toBeVisible();

    await nav.getByRole("button", { name: "问 t2" }).click();

    await vi.waitFor(() =>
      expect(nav.getByRole("button", { name: "问 t2" }).element().getAttribute("aria-current")).toBe("true"),
    );
  });

  it("names a question that started with a skill as it was typed", async () => {
    await page.viewport(1280, 800);
    const skilled = turn("t1", "看过了");
    const screen = await render(
      at([turn("t0", "好"), { ...skilled, user: { ...skilled.user, command: { kind: "skill", name: "review" } } }]),
    );
    const nav = screen.getByRole("navigation", { name: "提问导航" });

    expect(
      nav
        .getByRole("button")
        .elements()
        .map((button) => [button.getAttribute("aria-label"), button.textContent]),
    ).toStrictEqual([
      ["问 t0", "问 t0"],
      ["/skill:review 问 t1", "/skill:review 问 t1"],
    ]);
  });

  it("stays at the bottom as what is under it grows", async () => {
    const long = Array.from({ length: 20 }, (_, index) => turn(`a${index}`, `第 ${index} 段`));
    const screen = await render(above(long, 40));
    const scroller = screen.getByTestId("transcript").element() as HTMLElement;
    await vi.waitFor(() => expect(fromEnd(scroller)).toBe(0));

    await screen.rerender(above(long, 140));

    expect(await farthestFromEnd(scroller, 100)).toBe(0);
    expect(scroller.clientHeight).toBe(160);
  });

  it("stays at the bottom through every frame of the last process unfolding, a detail opening, and the fold", async () => {
    const items = [...Array.from({ length: 10 }, (_, index) => turn(`a${index}`, `第 ${index} 段`)), worked("w")];
    const screen = await render(at(items));
    const scroller = screen.getByTestId("transcript").element() as HTMLElement;
    await vi.waitFor(() => expect(fromEnd(scroller)).toBe(0));
    // Clicked in place: the page's own clicks scroll their target into view first.
    const header = screen.getByTestId("process-header").element() as HTMLElement;

    header.click();
    const unfolding = await farthestFromEnd(scroller, 700);
    (
      screen
        .getByRole("button", { name: /^运行了 pnpm test/ })
        .first()
        .element() as HTMLElement
    ).click();
    const opened = await farthestFromEnd(scroller, 100);
    header.click();
    const folding = await farthestFromEnd(scroller, 700);

    expect([unfolding, opened, folding]).toStrictEqual([0, 0, 0]);
  });

  it("stays at the bottom through every frame of a run whose process grows step by step", async () => {
    const earlier = Array.from({ length: 10 }, (_, index) => turn(`a${index}`, `第 ${index} 段`));
    const run = { runId: "r1", startedAt: Date.now() };
    const screen = await render(at([...earlier, liveTurn(1)], { run }));
    const scroller = screen.getByTestId("transcript").element() as HTMLElement;
    await vi.waitFor(() => expect(fromEnd(scroller)).toBe(0));

    const watching = farthestFromEnd(scroller, 1600);
    for (let count = 2; count <= 12; count += 1) {
      await screen.rerender(at([...earlier, liveTurn(count)], { run }));
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    expect(await watching).toBe(0);
    await expect.element(screen.getByRole("button", { name: "回到底部" })).not.toBeInTheDocument();
  });

  it("shows each turn's images: kept for a message sent from here, fetched by turn for others, again once a run ends", async () => {
    const shown = turnImages();
    const { images, loads } = shown;
    const user = { text: "看图", images: 1, auto: false, command: null, timestamp: 0 };
    const items = (outcome: Turn["outcome"]) => [
      turn("t1", "答", { user: { ...user, clientMessageId: "q1" } }),
      turn("t2", "", { user: { ...user, clientMessageId: null }, outcome }),
    ];
    const screen = await render(<MessageImagesContext value={images}>{at(items("running"))}</MessageImagesContext>);
    const second = screen.getByTestId("turn").nth(1);
    await expect.element(second.getByRole("img", { name: "图片不可用" })).toBeVisible();

    shown.host.ended = true;
    await screen.rerender(<MessageImagesContext value={images}>{at(items("done"))}</MessageImagesContext>);

    await expect.element(second.getByRole("img", { name: "图片 1" })).toHaveAttribute("src", "data:image/png;base64,b");
    await expect
      .element(screen.getByTestId("turn").nth(0).getByRole("img", { name: "图片 1" }))
      .toHaveAttribute("src", "data:image/png;base64,a");
    expect(loads).toStrictEqual(["t2/0", "t2/0"]);
  });

  it("stays at the bottom when content grows above the view and below it between frames", async () => {
    const screen = await render(at(Array.from({ length: 12 }, (_, index) => turn(`a${index}`, `第 ${index} 段`))));
    const scroller = screen.getByTestId("transcript").element() as HTMLElement;
    await vi.waitFor(() => expect(fromEnd(scroller)).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const replies = scroller.querySelectorAll<HTMLElement>('[data-testid="reply"]');

    // Something far above the view grows and the page reads its layout; the view follows in the
    // next frame, and that scroll's event is due a frame later.
    grow(replies[0], 400);
    expect(scroller.scrollHeight).toBeGreaterThan(0);
    await afterFrame();
    // Before that event, more grows above and the page reads its layout again: the browser's
    // scroll anchoring, if on, moves the view here, so the event finds a position the view did
    // not scroll to, and the last reply grows too, so that position is off the bottom.
    grow(replies[0], 400);
    expect(scroller.scrollHeight).toBeGreaterThan(0);
    grow(replies[replies.length - 1], 200);

    expect(await farthestFromEnd(scroller, 200)).toBe(0);
    await expect.element(screen.getByRole("button", { name: "回到底部" })).not.toBeInTheDocument();
  });

  it("leaves the view where it is, scrolled up, as a process unfolds or what is under it grows", async () => {
    const items = [worked("w"), ...Array.from({ length: 10 }, (_, index) => turn(`a${index}`, `第 ${index} 段`))];
    const screen = await render(above(items, 40));
    const scroller = screen.getByTestId("transcript").element() as HTMLElement;
    await vi.waitFor(() => expect(fromEnd(scroller)).toBe(0));
    scroller.scrollTop = 0;
    await expect.element(screen.getByRole("button", { name: "回到底部" })).toBeVisible();

    (screen.getByTestId("process-header").element() as HTMLElement).click();
    await screen.rerender(above(items, 140));
    await farthestFromEnd(scroller, 700);

    expect(scroller.scrollTop).toBe(0);
  });

  it("follows new content at the bottom; scrolled up it stops and offers a way back, with a dot for news", async () => {
    const long = Array.from({ length: 40 }, (_, index) => turn(`a${index}`, `第 ${index} 段`));
    const screen = await render(at(long));
    const scroller = screen.getByTestId("transcript").element() as HTMLElement;
    await vi.waitFor(() =>
      expect(scroller.scrollTop + scroller.clientHeight).toBeGreaterThanOrEqual(scroller.scrollHeight - 1),
    );

    scroller.scrollTop = 0;
    const back = screen.getByRole("button", { name: "回到底部" });
    await expect.element(back).toBeVisible();
    expect(screen.container.querySelector('[data-testid="unseen-dot"]')).toBeNull();
    await screen.rerender(at([...long, turn("new", "新的回复")]));
    await vi.waitFor(() => expect(screen.container.querySelector('[data-testid="unseen-dot"]')).not.toBeNull());
    expect(scroller.scrollTop).toBe(0);

    await back.click();

    await vi.waitFor(() =>
      expect(scroller.scrollTop + scroller.clientHeight).toBeGreaterThanOrEqual(scroller.scrollHeight - 1),
    );
    await expect.element(screen.getByRole("button", { name: "回到底部" })).not.toBeInTheDocument();
    await screen.rerender(at([...long, turn("new", "新的回复"), turn("newer", "更新的回复")]));
    await vi.waitFor(() =>
      expect(scroller.scrollTop + scroller.clientHeight).toBeGreaterThanOrEqual(scroller.scrollHeight - 1),
    );
  });
});

/**
 * A creation that never happens.
 *
 * @remarks
 * For tests where a session is active, so nothing is created.
 *
 * @sideEffects none
 * @returns An empty id.
 */
async function noCreate(): Promise<string> {
  return "";
}

describe("ConversationArea", () => {
  it("opens the active session when it shows, and explains when it cannot start", async () => {
    const { client, calls } = fakeClient(
      {},
      { openSession: () => Promise.reject(new CommandError("session_cwd_missing", { cwd: "/gone/work" })) },
    );

    const screen = await render(
      <ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />,
    );

    await expect.element(screen.getByRole("alert")).toHaveTextContent("恢复失败：会话的目录 /gone/work 不存在");
    expect(calls).toStrictEqual(["watch s1", "openSession s1"]);
  });

  it("keeps a session being created to its own container, so a message sent after moving goes elsewhere", async () => {
    const gate = Promise.withResolvers<void>();
    const { client, calls } = fakeClient({}, { createSession: () => gate.promise });
    const createIn = (workspaceId: string) => async () => (await client.createSession(workspaceId)).sessionId;
    const screen = await render(
      <ConversationArea client={client} containerId="wks_a" sessionId={null} create={createIn("wks_a")} />,
    );
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "给 A{Enter}");

    await screen.rerender(
      <ConversationArea client={client} containerId="wks_b" sessionId={null} create={createIn("wks_b")} />,
    );
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "给 B{Enter}");
    gate.resolve();

    await vi.waitFor(() =>
      expect(calls.filter((call) => call.startsWith("prompt")).toSorted()).toStrictEqual([
        "prompt new1 给 A",
        "prompt new2 给 B",
      ]),
    );
    expect(calls.filter((call) => call.startsWith("createSession"))).toStrictEqual([
      "createSession wks_a",
      "createSession wks_b",
    ]);
  });

  it("creates a session where the client is on the first message, watches it, and waits for it", async () => {
    const gate = Promise.withResolvers<void>();
    const { client, calls } = fakeClient({}, { createChat: () => gate.promise });
    const create = async () => (await client.createChat()).sessionId;
    const screen = await render(
      <ConversationArea client={client} containerId={null} sessionId={null} create={create} />,
    );
    await expect.element(screen.getByText("开始一段对话")).toBeVisible();
    const box = screen.getByRole("textbox", { name: "消息" });

    await userEvent.type(box, "一{Enter}");
    await userEvent.type(box, "二{Enter}");
    gate.resolve();

    await vi.waitFor(() =>
      expect(calls.filter((call) => !call.startsWith("watch"))).toStrictEqual([
        "createChat",
        "prompt new1 一",
        "prompt new1 二",
      ]),
    );
    expect(calls).toContain("watch new1");
  });

  it("creates the session as soon as something is typed, once, before anything is sent", async () => {
    const { client, calls, index } = fakeClient();
    const create = async () => (await client.createSession(CHAT)).sessionId;
    const screen = await render(
      <ConversationArea client={client} containerId={CHAT} sessionId={null} create={create} />,
    );

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "你好");

    await vi.waitFor(() => expect(index.getState().layout.tabs[CHAT]?.active).toBe("new1"));
    expect(calls.filter((call) => !call.startsWith("watch"))).toStrictEqual(["createSession cht_a"]);
    pageDrafts().drop(["new1"]);
  });

  it.each([
    [null, "不绑定项目和工作区，直接输入就开始"],
    [CHAT, "在这个对话里开始，直接输入就会新建会话"],
    ["wks_000000000000000a", "在这个工作区里开始，直接输入就会新建会话"],
  ])("says where a new session goes in %s when none is open", async (containerId, hint) => {
    const { client } = fakeClient();

    const screen = await render(
      <ConversationArea client={client} containerId={containerId} sessionId={null} create={async () => ""} />,
    );

    await expect.element(screen.getByText(hint)).toBeVisible();
  });

  it("watches the active session and sends to it", async () => {
    const { client, calls } = fakeClient();
    const screen = await render(
      <ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />,
    );

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "你好{Enter}");

    await vi.waitFor(() => expect(calls).toStrictEqual(["watch s1", "openSession s1", "prompt s1 你好"]));
    await expect.element(screen.getByTestId("user-message")).toHaveAttribute("data-pending", "true");
    await expect.element(screen.getByTestId("user-message")).toHaveTextContent("你好");
  });

  it("sends a tagged message as /name and its text, the pending bubble starting with the tag", async () => {
    const { client, calls } = fakeClient();
    const screen = await render(
      <ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />,
    );
    const box = screen.getByRole("textbox", { name: "消息" });
    await userEvent.type(box, "/rev");
    await expect.element(screen.getByRole("option", { name: /review/ })).toBeVisible();

    await userEvent.keyboard("{Enter}src{Enter}");

    await vi.waitFor(() => expect(calls.at(-1)).toBe("prompt s1 /review src"));
    await expect.element(screen.getByTestId("user-message")).toHaveAttribute("data-pending", "true");
    expect(screen.getByTestId("user-text").element().textContent).toBe("reviewsrc");
    await expect.element(screen.getByTestId("user-text").getByTestId("command-tag")).toHaveTextContent("review");
  });

  it.each(["exited", "lost"] as const)("opens a session that is %s again before sending to it", async (status) => {
    const { client, calls, views } = fakeClient();
    const screen = await render(
      <ConversationArea client={client} containerId={CHAT} sessionId="s1" create={async () => ""} />,
    );
    await vi.waitFor(() => expect(views.has("s1")).toBe(true));
    views.get("s1")?.setState({ status });

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "再来{Enter}");

    await vi.waitFor(() =>
      expect(calls).toStrictEqual(["watch s1", "openSession s1", "openSession s1", "watch s1", "prompt s1 再来"]),
    );
  });

  it("queues on Enter while a run goes on, steers on ⌘Enter, and stops with Esc or the button", async () => {
    const { client, calls, views } = fakeClient();
    const screen = await render(
      <ConversationArea client={client} containerId={CHAT} sessionId="s1" create={async () => ""} />,
    );
    await vi.waitFor(() => expect(views.has("s1")).toBe(true));
    views.get("s1")?.setState({ run: { runId: "r1", startedAt: Date.now() } });
    const box = screen.getByRole("textbox", { name: "消息" });

    await userEvent.type(box, "二{Enter}");
    await userEvent.type(box, "三{Meta>}{Enter}{/Meta}");
    await userEvent.type(box, "{Escape}");
    await screen.getByRole("button", { name: "停止" }).click();

    await expect.element(box).toHaveAttribute("placeholder", "回车排队 · ⌘回车插话 · Esc 停止");
    await expect.element(screen.getByText("回车排队 · ⌘回车插话 · Esc 停止")).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(calls).toStrictEqual(["watch s1", "openSession s1", "prompt s1 二", "steer s1 三", "stop s1", "stop s1"]),
    );
  });

  it("shows a stop waiting for pi as stopping, and takes no stop meanwhile", async () => {
    const { client, calls, views } = fakeClient();
    const screen = await render(
      <ConversationArea client={client} containerId={CHAT} sessionId="s1" create={async () => ""} />,
    );
    await vi.waitFor(() => expect(views.has("s1")).toBe(true));
    views.get("s1")?.setState({
      run: { runId: "r1", startedAt: Date.now() },
      control: { ...IDLE_CONTROL, stopping: true },
    });

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "{Escape}");

    await expect.element(screen.getByRole("button", { name: "停止中" })).toBeDisabled();
    await expect.element(screen.getByRole("textbox", { name: "消息" })).toHaveAttribute("placeholder", "正在停止…");
    expect(calls).toStrictEqual(["watch s1", "openSession s1"]);
  });

  it("stops watching when no session is active, and drops an old failure on switching", async () => {
    const { client, calls } = fakeClient({}, { prompt: () => Promise.reject(new CommandError("session_busy")) });
    const screen = await render(
      <ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />,
    );
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "一{Enter}");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("pi 正在忙，等这一轮结束再发");
    // The message did not go, so it is back in the box.
    await expect.element(screen.getByRole("textbox", { name: "消息" })).toHaveValue("一");
    pageDrafts().drop(["s1"]);

    await screen.rerender(<ConversationArea client={client} containerId={CHAT} sessionId={null} create={noCreate} />);

    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    expect(calls.at(-1)).toBe("watch ");
  });

  it("explains a failed creation above the input box", async () => {
    const { client } = fakeClient(
      {},
      { createChat: () => Promise.reject(new CommandError("pi_unavailable", { status: "missing" })) },
    );
    const create = async () => (await client.createChat()).sessionId;
    const screen = await render(
      <ConversationArea client={client} containerId={null} sessionId={null} create={create} />,
    );

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "你好{Enter}");

    await expect.element(screen.getByRole("alert")).toHaveTextContent("没有找到 pi，请先安装 pi");
  });

  it("explains a creation that failed as the first words were typed, before anything is sent", async () => {
    const { client, calls } = fakeClient(
      {},
      { createSession: () => Promise.reject(new CommandError("workspace_not_found", { workspaceId: "wks_a" })) },
    );
    const create = async () => (await client.createSession("wks_a")).sessionId;
    const screen = await render(
      <ConversationArea client={client} containerId="wks_a" sessionId={null} create={create} />,
    );

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "你");

    await expect.element(screen.getByRole("alert")).toHaveTextContent("这个工作区已经不在了");
    expect(calls.filter((call) => !call.startsWith("watch"))).toStrictEqual(["createSession wks_a"]);
  });

  it.each([
    [new ConnectionLostError("prompt"), "与宿主的连接断开了，这条消息可能没有发出"],
    [new CommandError("pi_unavailable", { status: "outdated" }), "pi 的版本过低，请先更新"],
    [new CommandError("pi_unavailable", { status: "unusable" }), "pi 无法运行，请在终端里检查 pi 能否启动"],
    [new CommandError("pi_unavailable", { status: "exited" }), "pi 已经退出了，可能还没有登录模型服务"],
    [new CommandError("pi_unavailable", { status: "unresponsive" }), "pi 没有响应，请稍后再试"],
    [new CommandError("session_busy"), "pi 正在忙，等这一轮结束再发"],
    [new CommandError("pi_rejected", { detail: "No model" }), "pi 拒绝了这条消息：No model"],
    [new CommandError("pi_unavailable", { status: "unknown" }), "还在查找 pi，请稍后再试"],
    [new CommandError("pi_unavailable"), "还在查找 pi，请稍后再试"],
    [new CommandError("session_not_found", { sessionId: "s1" }), "这个会话已经不存在了"],
    [new CommandError("transcript_changed"), "对话记录刚刚更新了，请再试一次"],
    [new CommandError("session_cwd_missing", { cwd: "/gone/work" }), "恢复失败：会话的目录 /gone/work 不存在"],
    [new CommandError("session_cwd_missing"), "恢复失败：会话的目录  不存在"],
    [new CommandError("workspace_not_found"), "这个工作区已经不在了"],
    [new CommandError("chat_not_found"), "这个对话已经不在了"],
    [new CommandError("session_stopping"), "正在等 pi 停下，停下后再发"],
    [new CommandError("queue_item_not_found"), "这条排队的消息已经发出或删掉了"],
    [new CommandError("interaction_closed"), "这个问题已经回答过、超时或作废了"],
    [new CommandError("internal_error"), "宿主出错了，消息没有发出"],
    [new Error("other"), "发送失败"],
  ])("describes %s", (error, text) => {
    expect(describeSendError(error)).toBe(text);
  });
});

/**
 * Lays the area out as the window does, the input box at the bottom.
 *
 * @remarks
 * The model panel opens upward, as it does above the input box.
 *
 * @sideEffects none
 * @param area - The area.
 * @returns The area in a full-height column.
 */
function tall(area: ReactNode) {
  return (
    <div data-testid="area" style={{ display: "flex", flexDirection: "column", height: 760 }}>
      {area}
    </div>
  );
}

/** Opus, which thinks at four levels. */
const BUILTIN_OPUS = {
  providerId: "anthropic",
  modelId: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  contextWindow: 1_000_000,
  maxOutput: 128_000,
  supportsImage: true,
  thinkingLevels: ["off", "low", "medium", "high"] as ThinkingLevel[],
  fast: null,
};
/** Haiku, which does not think. */
const BUILTIN_HAIKU = { ...BUILTIN_OPUS, modelId: "haiku", name: "Haiku", thinkingLevels: ["off"] as ThinkingLevel[] };
/** The list of both. */
const BUILTIN_MODELS = {
  status: "ready" as const,
  models: [BUILTIN_OPUS, BUILTIN_HAIKU],
  defaultModel: null,
  error: null,
};

/**
 * Renders the area on session s1 with Opus at a low level, and its box.
 *
 * @sideEffects Renders.
 * @param client - The client.
 * @returns The screen and the box.
 */
async function onOpus(client: AtriumClient) {
  const screen = await render(
    tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
  );
  client
    .session("s1")
    ?.setState({ model: { providerId: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "low" } });
  return { screen, box: screen.getByRole("textbox", { name: "消息" }) };
}

describe("ConversationArea's built-in commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    pageNotices().setState(null, true);
  });
  it("opens the model list for /model, and the thinking level, focused, for /thinking, emptying the box", async () => {
    const { client } = fakeClient({}, { models: BUILTIN_MODELS });
    const { screen, box } = await onOpus(client);

    await userEvent.type(box, "/model{Enter}");
    await expect.element(screen.getByRole("dialog", { name: "模型与推理强度" })).toBeVisible();
    expect(screen.getByRole("menuitemradio").elements()).toHaveLength(2);
    await expect.element(screen.getByRole("slider")).not.toBeInTheDocument();
    await expect.element(box).toHaveValue("");
    await userEvent.keyboard("{Escape}");

    await userEvent.type(box, "/thinking{Enter}");
    await expect.element(screen.getByRole("slider")).toHaveFocus();
    expect(screen.getByRole("menuitemradio").elements()).toHaveLength(0);
  });

  it("switches to the model named, reading the list first when it is not ready", async () => {
    const { client, modelCalls } = fakeClient({}, { models: BUILTIN_MODELS });
    const { box } = await onOpus(client);
    await vi.waitFor(() => expect(modelCalls).toStrictEqual(["loadModels null"]));

    await userEvent.type(box, "/model anthropic/haiku{Enter}");
    await vi.waitFor(() => expect(modelCalls).toStrictEqual(["loadModels null", "setModel s1 anthropic/haiku"]));
    await expect.element(box).toHaveValue("");

    client.models(null).setState({ status: "loading" });
    await userEvent.type(box, "/model anthropic/claude-opus-5-5{Enter}");
    await vi.waitFor(() =>
      expect(modelCalls.slice(2)).toStrictEqual(["loadModels null", "setModel s1 anthropic/claude-opus-5-5"]),
    );
  });

  it("says when no model is called that, or the switch is refused, leaving the box", async () => {
    const { client, modelCalls } = fakeClient(
      {},
      { models: BUILTIN_MODELS, setModel: () => Promise.reject(new CommandError("pi_rejected", { detail: "nope" })) },
    );
    const { screen, box } = await onOpus(client);

    await userEvent.type(box, "/model haiku{Enter}");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("没有这个模型");
    await expect.element(box).toHaveValue("/model haiku");

    await userEvent.clear(box);
    await userEvent.type(box, "/model anthropic/haiku{Enter}");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("pi 没有接受这个设置：nope");
    await expect.element(box).toHaveValue("/model anthropic/haiku");
    expect(modelCalls).toContain("setModel s1 anthropic/haiku");
  });

  it("sets the thinking level named, or says it has no such level or the model does not support it", async () => {
    const { client, modelCalls } = fakeClient({}, { models: BUILTIN_MODELS });
    const { screen, box } = await onOpus(client);

    await userEvent.type(box, "/thinking max{Enter}");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("当前模型不支持这个档位");
    await userEvent.clear(box);
    await userEvent.type(box, "/thinking hard{Enter}");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("没有这个档位");
    await userEvent.clear(box);
    await userEvent.type(box, "/thinking high{Enter}");

    await vi.waitFor(() => expect(modelCalls).toContain("setThinkingLevel s1 high"));
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(box).toHaveValue("");
  });

  it("copies the last reply's Markdown with /copy and says so beside the tab bar", async () => {
    const copied: string[] = [];
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      copied.push(text);
    });
    const { client } = fakeClient();
    const { box } = await onOpus(client);
    client.session("s1")?.setState({ items: [turn("t1", "第一"), turn("t2", "**第二**")] });

    await userEvent.type(box, "/copy{Enter}");

    await vi.waitFor(() => expect(copied).toStrictEqual(["**第二**"]));
    expect(pageNotices().getState()).toStrictEqual({ sessionId: "s1", text: "已复制最后一条回复" });
    await expect.element(box).toHaveValue("");
  });

  it("says when there is no reply to copy yet, or the clipboard refuses it", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(() => Promise.reject(new Error("denied")));
    const { client } = fakeClient();
    const { screen, box } = await onOpus(client);

    await userEvent.type(box, "/copy{Enter}");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("还没有回复可复制");
    client.session("s1")?.setState({ items: [turn("t1", "第一")] });
    await userEvent.type(box, "{Enter}");

    await expect.element(screen.getByRole("alert")).toHaveTextContent("复制失败");
    await expect.element(box).toHaveValue("/copy");
    expect(pageNotices().getState()).toBeNull();
  });

  it("runs built-ins before a session exists, creating it to switch the model", async () => {
    const { client, calls, modelCalls } = fakeClient({}, { models: BUILTIN_MODELS });
    const create = async () => (await client.createSession(CHAT)).sessionId;
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId={null} create={create} />),
    );
    const box = screen.getByRole("textbox", { name: "消息" });

    await userEvent.type(box, "/copy{Enter}");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("还没有回复可复制");
    await userEvent.clear(box);
    await userEvent.type(box, "/model anthropic/haiku{Enter}");

    await vi.waitFor(() => expect(modelCalls).toContain("setModel new1 anthropic/haiku"));
    expect(calls).toContain("createSession cht_a");
  });
});

/** Session s1 on file in the chat, so commands that wait for the first message can run. */
const ON_FILE = { sessions: [session({ sessionId: "s1", containerId: CHAT })] };

describe("ConversationArea's /compact", () => {
  it("has the host compact the session, with what followed as what to keep in mind", async () => {
    const { client, calls } = fakeClient(ON_FILE);
    const { box } = await onOpus(client);

    await userEvent.type(box, "/compact 保留接口的讨论{Enter}");
    await vi.waitFor(() => expect(calls).toContain("compactSession s1 保留接口的讨论"));
    await expect.element(box).toHaveValue("");
    await userEvent.type(box, "/compact{Enter}");

    await vi.waitFor(() => expect(calls).toContain("compactSession s1"));
  });

  it.each([
    ["nothing_to_compact", "对话还太短，不用压缩"],
    ["already_compacted", "刚压缩过，没有新内容"],
    ["compact_failed", "没能压缩：pi 出错了"],
  ] as const)("says why the host did not compact (%s), leaving the box", async (code, why) => {
    const { client } = fakeClient(ON_FILE, { compactSession: () => Promise.reject(new CommandError(code)) });
    const { screen, box } = await onOpus(client);

    await userEvent.type(box, "/compact{Enter}");

    await expect.element(screen.getByRole("alert")).toHaveTextContent(why);
    await expect.element(box).toHaveValue("/compact");
  });

  it.each([
    ["a run", { run: { runId: "r1", startedAt: 0 } }],
    ["a stop", { control: { ...IDLE_CONTROL, stopping: true } }],
    ["a compaction", { control: { ...IDLE_CONTROL, compacting: true } }],
  ])("does not compact during %s, saying so", async (_when, state) => {
    const { client, calls } = fakeClient(ON_FILE);
    const { screen, box } = await onOpus(client);
    client.session("s1")?.setState(state);

    await userEvent.type(box, "/compact{Enter}");

    await expect.element(screen.getByRole("alert")).toHaveTextContent("运行中不能用，先停止");
    await expect.element(box).toHaveValue("/compact");
    expect(calls.filter((call) => call.startsWith("compactSession"))).toStrictEqual([]);
  });

  it("does not compact before the first message, saying so", async () => {
    const { client, calls } = fakeClient();
    const { screen, box } = await onOpus(client);

    await userEvent.type(box, "/compact{Enter}");

    await expect.element(screen.getByRole("alert")).toHaveTextContent("发出第一条消息后才能用");
    expect(calls.filter((call) => call.startsWith("compactSession"))).toStrictEqual([]);
  });

  it("says at the bottom of the conversation while pi compacts", async () => {
    const { client } = fakeClient(ON_FILE);
    const { screen } = await onOpus(client);
    const line = screen.getByText("正在压缩上下文…");

    client.session("s1")?.setState({ control: { ...IDLE_CONTROL, compacting: true } });
    await expect.element(line).toBeVisible();
    expect(line.element().className).toBe("atrium-shimmer");
    client.session("s1")?.setState({ control: IDLE_CONTROL });

    await expect.element(line).not.toBeInTheDocument();
  });
});

describe("ConversationArea's model button", () => {
  const OPUS = {
    providerId: "anthropic",
    modelId: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsImage: true,
    thinkingLevels: ["off", "low", "medium", "high"] as const,
    fast: null,
  };
  const HAIKU = { ...OPUS, modelId: "haiku", name: "Haiku", thinkingLevels: ["off"] as const };
  const LIST = {
    status: "ready" as const,
    models: [
      { ...OPUS, thinkingLevels: [...OPUS.thinkingLevels] },
      { ...HAIKU, thinkingLevels: [...HAIKU.thinkingLevels] },
    ],
    defaultModel: { providerId: "anthropic", modelId: "haiku" },
    error: null,
  };

  it("asks for the container's models, and shows the session's model and level", async () => {
    const { client, modelCalls } = fakeClient({}, { models: LIST });
    const screen = await render(
      tall(<ConversationArea client={client} containerId="wks_000000000000000a" sessionId="s1" create={noCreate} />),
    );
    client
      .session("s1")
      ?.setState({ model: { providerId: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" } });

    const chip = screen.getByRole("button", { name: /模型与推理强度/ });
    await expect.element(chip).toHaveTextContent("Claude Opus 5.5高");
    await expect.element(chip).toHaveAttribute("data-full");
    expect(modelCalls).toStrictEqual(["loadModels wks_000000000000000a"]);
  });

  it("switches the session's model and thinking level", async () => {
    const { client, modelCalls } = fakeClient({}, { models: LIST });
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    client
      .session("s1")
      ?.setState({ model: { providerId: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "low" } });

    await userEvent.click(screen.getByRole("button", { name: /模型与推理强度/ }));
    (screen.getByRole("slider").element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Haiku/ }));

    await vi.waitFor(() =>
      expect(modelCalls).toStrictEqual([
        "loadModels null",
        "loadModels null",
        "setThinkingLevel s1 medium",
        "setModel s1 anthropic/haiku",
      ]),
    );
  });

  it("shows the model chosen last before a session exists, and creates the session to switch it", async () => {
    const { client, calls, modelCalls } = fakeClient(
      {
        preferences: {
          setupDone: true,
          appearance: "system",
          lastModel: { providerId: "anthropic", modelId: "claude-opus-5-5" },
          thinkingByModel: { "anthropic/claude-opus-5-5": "medium" },
          lastFast: false,
          statusBar: {},
          titleModel: null,
          proxy: null,
          inbox: true,
        },
      },
      { models: LIST },
    );
    const create = async () => (await client.createSession(CHAT)).sessionId;
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId={null} create={create} />),
    );
    const chip = screen.getByRole("button", { name: /模型与推理强度/ });
    await expect.element(chip).toHaveTextContent("Claude Opus 5.5中");

    await userEvent.click(chip);
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Haiku/ }));

    await vi.waitFor(() => expect(modelCalls).toContain("setModel new1 anthropic/haiku"));
    expect(calls).toContain("createSession cht_a");
  });

  it("cannot change the model while a stop waits for pi", async () => {
    const { client } = fakeClient({}, { models: LIST });
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );

    client.session("s1")?.setState({
      run: { runId: "r1", startedAt: 0 },
      control: { ...IDLE_CONTROL, stopping: true },
    });

    await expect.element(screen.getByRole("button", { name: /模型与推理强度/ })).toBeDisabled();
  });

  it("explains a model switch pi refused", async () => {
    const { client } = fakeClient({}, { models: LIST });
    client.setModel = () => Promise.reject(new CommandError("pi_rejected", { detail: "Model not found" }));
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );

    await userEvent.click(screen.getByRole("button", { name: /模型与推理强度/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Haiku/ }));

    await expect.element(screen.getByRole("alert")).toHaveTextContent("pi 没有接受这个设置：Model not found");
  });
});

/**
 * The animations the Fast button's bolt and speed lines run.
 *
 * @remarks
 * Turning Fast on plays the acceleration (design-language, "Fast 按钮").
 *
 * @sideEffects none
 * @param button - The Fast button.
 * @returns The bolt's animation name and each speed line's.
 */
function motionOf(button: Element): { bolt: string; streaks: string[] } {
  const bolt = button.querySelector("svg");
  if (bolt === null) throw new Error("the Fast button has no bolt");
  return {
    bolt: getComputedStyle(bolt).animationName,
    streaks: [...button.querySelectorAll(".atrium-fast-streak")].map((line) => getComputedStyle(line).animationName),
  };
}

/**
 * What draws a frame around an element: its background, shadow and border.
 *
 * @remarks
 * The Fast button is the bolt alone (design-language.md, "Fast 按钮").
 *
 * @sideEffects none
 * @param element - The element.
 * @returns Its computed background colour, box shadow and border width.
 */
function frameOf(element: Element): { background: string; shadow: string; border: string } {
  const style = getComputedStyle(element);
  return { background: style.backgroundColor, shadow: style.boxShadow, border: style.borderTopWidth };
}

/**
 * Where the bolt is drawn inside the Fast button.
 *
 * @remarks
 * The button is a larger target than the bolt it draws (design-language.md, "Fast 按钮").
 *
 * @sideEffects none
 * @param button - The Fast button.
 * @returns The bolt's box.
 * @throws When the button draws no bolt.
 */
function boltOf(button: Element): DOMRect {
  const bolt = button.querySelector("svg");
  if (bolt === null) throw new Error("the Fast button draws no bolt");
  return bolt.getBoundingClientRect();
}

describe("ConversationArea's Fast button", () => {
  const GPT = {
    providerId: "openai-codex",
    modelId: "gpt-5.5",
    name: "GPT-5.5",
    contextWindow: 400_000,
    maxOutput: 128_000,
    supportsImage: true,
    thinkingLevels: ["low", "medium", "high"],
    fast: { speed: 2, moreUsage: true },
  } as const;
  const OPUS = {
    ...GPT,
    providerId: "anthropic",
    modelId: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    fast: null,
  };
  const LIST = {
    status: "ready" as const,
    models: [
      { ...GPT, thinkingLevels: [...GPT.thinkingLevels] },
      { ...OPUS, thinkingLevels: [...OPUS.thinkingLevels] },
    ],
    defaultModel: null,
    error: null,
  };
  const ON_GPT = { providerId: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "high" } as const;

  it("shows only for a model with Fast, as the session has it, and switches it", async () => {
    const { client, modelCalls } = fakeClient({}, { models: LIST });
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    const fast = screen.getByRole("button", { name: "Fast", exact: true });
    client.session("s1")?.setState({ model: { ...ON_GPT, providerId: "anthropic", modelId: "claude-opus-5-5" } });
    await expect.element(screen.getByRole("button", { name: /模型与推理强度/ })).toHaveTextContent("Claude Opus 5.5高");
    await expect.element(fast).not.toBeInTheDocument();

    client.session("s1")?.setState({ model: ON_GPT });
    await expect.element(fast).toHaveAttribute("aria-pressed", "false");
    await userEvent.hover(fast);
    await expect.element(screen.getByRole("tooltip")).toBeVisible();
    expect(screen.getByRole("tooltip").element().textContent).toBe(
      "Fast 未开启约 2 倍速度，额度消耗增加从下一次请求开始生效",
    );
    await userEvent.click(fast);

    await expect.element(fast).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("tooltip").element().textContent).toMatch(/^Fast 已开启约/);
    await userEvent.click(fast);
    await expect.element(fast).toHaveAttribute("aria-pressed", "false");
    expect(modelCalls.filter((call) => call.startsWith("setFast"))).toStrictEqual(["setFast s1 on", "setFast s1 off"]);
  });

  it("hides its card once the pointer leaves, though the click left the button focused, and shows it on keyboard focus", async () => {
    const { client } = fakeClient({}, { models: LIST });
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    const fast = screen.getByRole("button", { name: "Fast", exact: true });
    const card = screen.getByRole("tooltip", { includeHidden: true }).filter({ hasText: "从下一次请求开始生效" });
    const box = screen.getByRole("textbox", { name: "消息" });
    client.session("s1")?.setState({ model: ON_GPT });
    await userEvent.click(fast);
    await expect.element(fast).toHaveAttribute("aria-pressed", "true");
    await expect.element(card).toBeVisible();

    await userEvent.hover(screen.getByRole("button", { name: /模型与推理强度/ }));
    await expect.element(fast).toHaveFocus();
    await expect.element(card).not.toBeVisible();

    await userEvent.click(box);
    await userEvent.keyboard("{Tab}{Tab}{Tab}");
    await expect.element(fast).toHaveFocus();
    await expect.element(card).toBeVisible();
  });

  it("draws the bolt alone, with no circle, background or outline, off, hovered or on, under a pointing hand", async () => {
    const { client } = fakeClient({}, { models: LIST });
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    client.session("s1")?.setState({ model: ON_GPT });
    const fast = screen.getByRole("button", { name: "Fast", exact: true });
    await expect.element(fast).toHaveAttribute("aria-pressed", "false");

    const off = frameOf(fast.element());
    await userEvent.hover(fast);
    const hovered = frameOf(fast.element());
    await userEvent.click(fast);
    await expect.element(fast).toHaveAttribute("aria-pressed", "true");

    const none = { background: "rgba(0, 0, 0, 0)", shadow: "none", border: "0px" };
    expect([off, hovered, frameOf(fast.element())]).toStrictEqual([none, none, none]);
    expect(getComputedStyle(fast.element()).cursor).toBe("pointer");
  });

  it("sits close to the model button: the bolt 10.5 px from it, its target still 32 px square", async () => {
    const { client } = fakeClient({}, { models: LIST });
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    client.session("s1")?.setState({ model: ON_GPT });
    const fast = screen.getByRole("button", { name: "Fast", exact: true });
    await expect.element(fast).toHaveAttribute("aria-pressed", "false");
    const target = fast.element().getBoundingClientRect();
    const bolt = boltOf(fast.element());
    const model = screen
      .getByRole("button", { name: /模型与推理强度/ })
      .element()
      .getBoundingClientRect();

    expect([target.width, target.height, model.left - bolt.right]).toStrictEqual([32, 32, 10.5]);
  });

  it("plays the acceleration when switched on, and not when shown already on or switched off", async () => {
    const { client } = fakeClient({}, { models: LIST });
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    client.session("s1")?.setState({ model: ON_GPT, fast: true });
    const fast = screen.getByRole("button", { name: "Fast", exact: true });
    await expect.element(fast).toHaveAttribute("aria-pressed", "true");

    const shownOn = motionOf(fast.element());
    await userEvent.click(fast);
    await expect.element(fast).toHaveAttribute("aria-pressed", "false");
    const off = motionOf(fast.element());
    await userEvent.click(fast);
    await expect.element(fast).toHaveAttribute("aria-pressed", "true");

    const still = { bolt: "none", streaks: ["none", "none", "none"] };
    expect([shownOn, off, motionOf(fast.element())]).toStrictEqual([
      still,
      still,
      { bolt: "atrium-fast-dash", streaks: ["atrium-fast-streak", "atrium-fast-streak", "atrium-fast-streak"] },
    ]);
  });

  it.each([
    [{ speed: 1.5, moreUsage: false }, "约 1.5 倍速度"],
    [{ speed: null, moreUsage: true }, "更快，额度消耗增加"],
    [{ speed: null, moreUsage: false }, "更快"],
  ])("says what Fast does for the model, as Codex's list says: %o", async (fast, says) => {
    const { client } = fakeClient(
      {},
      { models: { ...LIST, models: [{ ...GPT, modelId: "gpt-6-sol", thinkingLevels: [], fast }] } },
    );
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );

    client.session("s1")?.setState({ model: { ...ON_GPT, modelId: "gpt-6-sol" }, fast: true });

    const button = screen.getByRole("button", { name: "Fast", exact: true });
    await expect.element(button).toHaveAttribute("aria-pressed", "true");
    await userEvent.hover(button);
    await expect.element(screen.getByRole("tooltip")).toBeVisible();
    expect(screen.getByRole("tooltip").element().textContent).toBe(`Fast 已开启${says}从下一次请求开始生效`);
  });

  it("shows Fast as chosen last before a session exists, and creates the session to switch it", async () => {
    const { client, calls, modelCalls } = fakeClient(
      {
        preferences: {
          setupDone: true,
          appearance: "system",
          lastModel: { providerId: "openai-codex", modelId: "gpt-5.5" },
          thinkingByModel: {},
          lastFast: true,
          statusBar: {},
          titleModel: null,
          proxy: null,
          inbox: true,
        },
      },
      { models: LIST },
    );
    const create = async () => (await client.createSession(CHAT)).sessionId;
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId={null} create={create} />),
    );
    const fast = screen.getByRole("button", { name: "Fast", exact: true });
    await expect.element(fast).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(fast);

    await vi.waitFor(() => expect(modelCalls).toContain("setFast new1 off"));
    expect(calls).toContain("createSession cht_a");
  });

  it("cannot switch Fast while a stop waits for pi, and shows no pointing hand then", async () => {
    const { client } = fakeClient({}, { models: LIST });
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );

    client.session("s1")?.setState({
      model: ON_GPT,
      run: { runId: "r1", startedAt: 0 },
      control: { ...IDLE_CONTROL, stopping: true },
    });

    const fast = screen.getByRole("button", { name: "Fast", exact: true });
    await expect.element(fast).toBeDisabled();
    expect(getComputedStyle(fast.element()).cursor).toBe("default");
  });

  it("explains a session whose pi has no Fast", async () => {
    const { client } = fakeClient(
      {},
      { models: LIST, setFast: () => Promise.reject(new CommandError("fast_unavailable")) },
    );
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    client.session("s1")?.setState({ model: ON_GPT });

    await userEvent.click(screen.getByRole("button", { name: "Fast", exact: true }));

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("这个会话的 pi 没有加载 Atrium 的 Fast 扩展，开关不了 Fast");
    await expect
      .element(screen.getByRole("button", { name: "Fast", exact: true }))
      .toHaveAttribute("aria-pressed", "false");
  });
});

describe("describeModelError", () => {
  it("names what pi refused, and words other failures as a send", () => {
    expect(describeModelError(new CommandError("pi_rejected", { detail: "Model not found: x/y" }))).toBe(
      "pi 没有接受这个设置：Model not found: x/y",
    );
    expect(describeModelError(new CommandError("session_stopping"))).toBe(
      describeSendError(new CommandError("session_stopping")),
    );
  });
});

describe("ConversationArea's composer", () => {
  it("lists the session's commands and files, and keeps the draft per session", async () => {
    localStorage.clear();
    const { client, calls } = fakeClient();
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    const box = screen.getByRole("textbox", { name: "消息" });

    await userEvent.type(box, "/rev");
    await expect.element(screen.getByRole("option", { name: /review/ })).toBeVisible();
    await userEvent.keyboard("{Enter}看看 @a");
    await expect.element(screen.getByRole("option", { name: "src/a.ts" })).toBeVisible();
    await userEvent.keyboard("{Enter}");

    expect(calls).toContain("listCommands s1");
    expect(calls).toContain("searchFiles s1 a");
    await vi.waitFor(() =>
      expect(pageDrafts().read("s1")).toStrictEqual({
        text: "看看 ",
        pastes: [],
        files: ["src/a.ts"],
        command: { source: "prompt", name: "review" },
        images: [],
      }),
    );
  });

  it("goes back through the session's own messages with ↑", async () => {
    const { client } = fakeClient();
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    client.session("s1")?.setState({
      items: [
        { ...turnOf("t1", "第一问"), kind: "turn" },
        { ...turnOf("t2", "第二问"), kind: "turn" },
      ],
    });
    const box = screen.getByRole("textbox", { name: "消息" });

    await userEvent.type(box, "{ArrowUp}");

    await expect.element(box).toHaveValue("第二问");
  });

  it("creates the session first when / is typed before there is one", async () => {
    const { client, calls } = fakeClient();
    const create = async () => (await client.createSession(CHAT)).sessionId;
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId={null} create={create} />),
    );

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "/");

    await expect.element(screen.getByRole("option", { name: /review/ })).toBeVisible();
    expect(calls.filter((call) => !call.startsWith("watch"))).toStrictEqual([
      "createSession cht_a",
      "listCommands new1",
    ]);
  });
});

/** A finished turn opened by `text`. */
function turnOf(id: string, text: string): Turn {
  return {
    kind: "turn",
    id,
    user: { text, images: 0, clientMessageId: null, auto: false, command: null, timestamp: 0 },
    steps: [],
    outcome: "done",
    error: null,
    startedAt: 0,
    durationMs: 1,
    usage: null,
    changes: [],
  };
}

/**
 * Answers with `first` once, then as started.
 *
 * @remarks
 * For a send that fails, then goes through.
 *
 * @sideEffects none
 * @param first - The first answer.
 * @returns The answers.
 */
function inTurn(
  first: () => Promise<{ disposition: "started" | "queued" | "handled" }>,
): () => Promise<{ disposition: "started" | "queued" | "handled" }> {
  let used = false;
  return () => {
    if (used) return Promise.resolve({ disposition: "started" });
    used = true;
    return first();
  };
}

/** Fails a prompt with `first`, then every later one with `then`. */
function failing(first: Error, then: Error): () => Promise<never> {
  let used = false;
  return () => {
    const error = used ? then : first;
    used = true;
    return Promise.reject(error);
  };
}

/** Holds back the upload numbered `number` until `until` settles. */
function holding(number: number, until: Promise<void>): (uploaded: number) => Promise<void> {
  return (uploaded) => (uploaded === number ? until : Promise.resolve());
}

/** A small PNG, as a pasted screenshot. */
async function shot(): Promise<File> {
  const canvas = new OffscreenCanvas(20, 20);
  canvas.getContext("2d")?.fillRect(0, 0, 20, 20);
  return new File([await canvas.convertToBlob({ type: "image/png" })], "shot.png", { type: "image/png" });
}

/** Pastes a file into an element as the clipboard would. */
function pasteFile(target: Element, file: File): void {
  const data = new DataTransfer();
  data.items.add(file);
  target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

describe("ConversationArea's images", () => {
  it("sends a pasted image with the message, uploading it again once when the host has let it go", async () => {
    const { client, calls } = fakeClient(
      {},
      { prompt: inTurn(() => Promise.reject(new CommandError("attachment_missing", { attachmentId: "u1" }))) },
    );
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    const box = screen.getByRole("textbox", { name: "消息" });

    pasteFile(box.element(), await shot());
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    await userEvent.type(box, "看图{Enter}");

    await vi.waitFor(() =>
      expect(calls.filter((call) => /^(upload|prompt)/.test(call))).toStrictEqual([
        "uploadAttachment image/webp",
        "prompt s1 看图 +u1",
        "uploadAttachment image/webp",
        "prompt s1 看图 +u2",
      ]),
    );
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the images of a message it sent as thumbnails at once, from what was pasted", async () => {
    const { client, calls } = fakeClient();
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    const box = screen.getByRole("textbox", { name: "消息" });
    pasteFile(box.element(), await shot());
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeEnabled();

    await userEvent.type(box, "看图{Enter}");

    const sent = screen.getByTestId("user-message").getByRole("img", { name: "图片 1" });
    await expect.element(sent).toHaveAttribute("src", expect.stringMatching(/^data:image\/webp;base64,./));
    expect(calls.filter((call) => call.startsWith("fetchImage"))).toStrictEqual([]);
  });

  it("uploads the images again one at a time, and puts the message back with the new uploads when it still fails", async () => {
    const third = Promise.withResolvers<void>();
    const { client, calls } = fakeClient(
      {},
      {
        prompt: failing(
          new CommandError("attachment_missing", { attachmentId: "u1" }),
          new CommandError("session_busy"),
        ),
        upload: holding(3, third.promise),
      },
    );
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    const box = screen.getByRole("textbox", { name: "消息" });
    pasteFile(box.element(), await shot());
    pasteFile(box.element(), await shot());
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeEnabled();

    await userEvent.type(box, "两张{Enter}");
    await vi.waitFor(() => expect(calls.filter((call) => call.startsWith("upload"))).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((call) => call.startsWith("upload"))).toHaveLength(3);
    third.resolve();

    await expect.element(screen.getByRole("alert")).toHaveTextContent("pi 正在忙，等这一轮结束再发");
    await expect.element(box).toHaveValue("两张");
    await expect.element(screen.getByRole("img", { name: "图片 2" })).toBeVisible();
    await userEvent.type(box, "{Enter}");
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.startsWith("prompt"))).toStrictEqual([
        "prompt s1 两张 +u1 +u2",
        "prompt s1 两张 +u3 +u4",
        "prompt s1 两张 +u3 +u4",
      ]),
    );
    pageDrafts().drop(["s1"]);
  });

  it("refuses images while the session's model takes none", async () => {
    const { client, calls } = fakeClient(
      {},
      {
        models: {
          status: "ready",
          models: [
            {
              providerId: "x",
              modelId: "text-only",
              name: "Text Only",
              contextWindow: 1,
              maxOutput: 1,
              supportsImage: false,
              thinkingLevels: ["off"],
              fast: null,
            },
          ],
          defaultModel: null,
          error: null,
        },
      },
    );
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    client.session("s1")?.setState({ model: { providerId: "x", modelId: "text-only", thinkingLevel: "off" } });
    await expect.element(screen.getByRole("button", { name: /Text Only/ })).toBeVisible();

    pasteFile(screen.getByRole("textbox", { name: "消息" }).element(), await shot());

    await expect.element(screen.getByText("当前模型不支持图片")).toBeVisible();
    expect(calls.filter((call) => call.startsWith("upload"))).toStrictEqual([]);
  });
});

describe("ConversationArea's workspace changes", () => {
  const W = "wks_0000000000000001";
  const changed = { stat: { added: 1234, removed: 3 }, dirty: true, ahead: 0, branch: "feat", base: "origin/main" };

  it("watches the shown workspace's changes, none for the chats, and shows them in a capsule that opens the panel", async () => {
    const { client, changeCalls } = fakeClient();
    const screen = await render(
      tall(<ConversationArea client={client} containerId={W} sessionId="s1" create={noCreate} />),
    );
    await vi.waitFor(() => expect(changeCalls).toStrictEqual([`watchChanges ${W}`]));
    await expect.element(screen.getByRole("button", { name: "查看改动" })).not.toBeInTheDocument();

    client.changes(W).setState(changed);
    const capsule = screen.getByRole("button", { name: "查看改动" });
    await expect.element(capsule).toHaveTextContent("+1.2k−3");
    await capsule.click();
    await expect.element(screen.getByRole("complementary", { name: "改动" })).toBeVisible();
    await expect.element(capsule).toHaveAttribute("aria-expanded", "true");
    await capsule.click();
    await expect.element(screen.getByRole("complementary", { name: "改动" })).not.toBeInTheDocument();

    await screen.rerender(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    await vi.waitFor(() =>
      expect(changeCalls).toStrictEqual([
        `watchChanges ${W}`,
        `watchDiff ${W} uncommitted`,
        "watchDiff null",
        "watchChanges ",
      ]),
    );
  });

  it("shows the capsule in the empty state too, with no session open", async () => {
    const { client } = fakeClient();
    client.changes(W).setState(changed);
    const screen = await render(
      tall(<ConversationArea client={client} containerId={W} sessionId={null} create={noCreate} />),
    );

    await screen.getByRole("button", { name: "查看改动" }).click();

    await expect.element(screen.getByRole("complementary", { name: "改动" })).toBeVisible();
  });

  it("closes the panel on going to another container, and with its own button", async () => {
    const { client } = fakeClient();
    client.changes(W).setState(changed);
    const screen = await render(
      tall(<ConversationArea client={client} containerId={W} sessionId="s1" create={noCreate} />),
    );
    await screen.getByRole("button", { name: "查看改动" }).click();
    await screen.getByRole("button", { name: "关闭改动" }).click();
    await expect.element(screen.getByRole("complementary", { name: "改动" })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "查看改动" }).click();

    await screen.rerender(
      tall(<ConversationArea client={client} containerId="wks_0000000000000002" sessionId="s1" create={noCreate} />),
    );
    await screen.rerender(tall(<ConversationArea client={client} containerId={W} sessionId="s1" create={noCreate} />));

    await expect.element(screen.getByRole("complementary", { name: "改动" })).not.toBeInTheDocument();
  });
});

describe("ConversationArea's status bar", () => {
  it("shows the open session's figures under the input box, none in the empty state, and saves the groups chosen", async () => {
    const { client, calls, views } = fakeClient();
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    await vi.waitFor(() => expect(views.has("s1")).toBe(true));

    views.get("s1")?.setState({ metrics: { ...UNKNOWN_METRICS, turns: 2, steps: 5 } });
    await expect.element(screen.getByRole("button", { name: /^2 轮 5 步/ })).toBeVisible();
    await screen.getByRole("button", { name: "自定义状态栏" }).click();
    await screen.getByRole("switch", { name: "费用" }).click();

    expect(calls.filter((call) => call.startsWith("setPreferences"))).toStrictEqual([
      'setPreferences {"statusBar":{"cost":true}}',
    ]);
    await expect.element(screen.getByRole("switch", { name: "费用" })).toHaveAttribute("aria-checked", "true");
    await screen.rerender(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId={null} create={noCreate} />),
    );
    await expect.element(screen.getByRole("group", { name: "状态栏" })).not.toBeInTheDocument();
  });

  it("sits just under the input box, whose text keeps off its rounded edge and which stays put without a session", async () => {
    const { client, views } = fakeClient();
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />),
    );
    await vi.waitFor(() => expect(views.has("s1")).toBe(true));
    const card = screen.getByTestId("composer-card");
    const bar = screen.getByRole("group", { name: "状态栏" });
    await expect.element(bar).toBeVisible();
    const area = screen.getByTestId("area").element().getBoundingClientRect();
    const box = card.element().getBoundingClientRect();
    const textbox = screen.getByRole("textbox", { name: "消息" }).element().getBoundingClientRect();
    const barBox = bar.element().getBoundingClientRect();

    expect(textbox.left - box.left).toBe(20);
    expect(textbox.top - box.top).toBe(20);
    expect(barBox.top - box.bottom).toBe(4);
    expect(barBox.height).toBe(28);
    expect(area.bottom).toBe(barBox.bottom + 8);
    await screen.rerender(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId={null} create={noCreate} />),
    );
    await expect.element(bar).not.toBeInTheDocument();
    expect(card.element().getBoundingClientRect().bottom).toBe(box.bottom);
  });
});

describe("ConversationArea before it is connected", () => {
  it("asks for the models once connected, and again after a reconnect", async () => {
    const { client, connection, modelCalls } = fakeClient();
    connection.setState({ status: "connecting" });
    await render(tall(<ConversationArea client={client} containerId={CHAT} sessionId={null} create={noCreate} />));
    expect(modelCalls).toStrictEqual([]);

    connection.setState({
      status: "connected",
      traceId: "t",
      hostVersion: "0",
      hostInstanceId: "h1",
      installSeed: 1,
      logDir: "/l",
    });
    await vi.waitFor(() => expect(modelCalls).toStrictEqual(["loadModels null"]));
    connection.setState({ status: "connecting" });
    connection.setState({
      status: "connected",
      traceId: "t2",
      hostVersion: "0",
      hostInstanceId: "h1",
      installSeed: 1,
      logDir: "/l",
    });

    await vi.waitFor(() => expect(modelCalls).toStrictEqual(["loadModels null", "loadModels null"]));
  });
});

describe("ConversationArea after the host restarted", () => {
  it("opens and watches the session shown again under a new host, but not after a reconnect to the same one", async () => {
    const { client, connection, calls, index } = fakeClient({
      sessions: [session({ sessionId: "s1", containerId: CHAT })],
    });
    await render(tall(<ConversationArea client={client} containerId={CHAT} sessionId="s1" create={noCreate} />));
    await vi.waitFor(() => expect(calls).toStrictEqual(["watch s1", "openSession s1"]));

    connection.setState({ status: "connecting" });
    connection.setState({
      status: "connected",
      traceId: "t2",
      hostVersion: "0",
      hostInstanceId: "h1",
      installSeed: 1,
      logDir: "/l",
    });
    connection.setState({ status: "connecting" });
    connection.setState({
      status: "connected",
      traceId: "t3",
      hostVersion: "0",
      hostInstanceId: "h2",
      installSeed: 1,
      logDir: "/l",
    });

    await vi.waitFor(() => expect(calls).toStrictEqual(["watch s1", "openSession s1", "openSession s1", "watch s1"]));
    expect(index.getState().layout.tabs[CHAT]?.active).toBe("s1");
  });
});

describe("ConversationArea handing the first words to a new session", () => {
  it("keeps what was typed before / created the session, in its box, focused, with the list open", async () => {
    const { client, index } = fakeClient();
    const create = async () => (await client.createSession(CHAT)).sessionId;
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId={null} create={create} />),
    );
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "/");
    await vi.waitFor(() => expect(index.getState().layout.tabs[CHAT]?.active).toBe("new1"));

    await screen.rerender(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="new1" create={create} />),
    );

    const box = screen.getByRole("textbox", { name: "消息" });
    await expect.element(box).toHaveValue("/");
    await expect.element(box).toHaveFocus();
    await expect.element(screen.getByRole("option", { name: /review/ })).toBeVisible();
    await userEvent.keyboard("rev");
    await expect.element(box).toHaveValue("/rev");
    pageDrafts().drop(["new1"]);
  });

  it("keeps the words typed after the session was created but before it shows, and focuses only once", async () => {
    const { client, index } = fakeClient();
    const create = async () => (await client.createSession(CHAT)).sessionId;
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId={null} create={create} />),
    );
    const box = screen.getByRole("textbox", { name: "消息" });
    await userEvent.type(box, "/");
    await vi.waitFor(() => expect(index.getState().layout.tabs[CHAT]?.active).toBe("new1"));

    await userEvent.keyboard("rev");
    await screen.rerender(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="new1" create={create} />),
    );
    await expect.element(box).toHaveValue("/rev");
    await expect.element(box).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    (document.activeElement as HTMLElement | null)?.blur();
    await screen.rerender(tall(<ConversationArea client={client} containerId={CHAT} sessionId="s9" create={create} />));
    await screen.rerender(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="new1" create={create} />),
    );

    await expect.element(screen.getByRole("textbox", { name: "消息" })).toHaveValue("/rev");
    await expect.element(screen.getByRole("textbox", { name: "消息" })).not.toHaveFocus();
    pageDrafts().drop(["new1"]);
  });

  it("forgets the session the words went to once the area goes to another container before it shows", async () => {
    const { client, calls, index } = fakeClient();
    const create = async () => (await client.createSession(CHAT)).sessionId;
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId={null} create={create} />),
    );
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "/");
    await vi.waitFor(() => expect(index.getState().layout.tabs[CHAT]?.active).toBe("new1"));

    await screen.rerender(
      tall(<ConversationArea client={client} containerId="wks_0000000000000002" sessionId={null} create={create} />),
    );
    await screen.rerender(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId={null} create={create} />),
    );
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "新的{Enter}");

    await vi.waitFor(() =>
      expect(calls.filter((call) => /^(createSession|prompt)/.test(call))).toStrictEqual([
        "createSession cht_a",
        "createSession cht_a",
        "prompt new2 新的",
      ]),
    );
    pageDrafts().drop(["new1", "new2"]);
  });

  it("hands the words over even when the new session shows before its creation is answered", async () => {
    const { client } = fakeClient();
    const answered = Promise.withResolvers<void>();
    const create = async () => {
      await answered.promise;
      return (await client.createSession(CHAT)).sessionId;
    };
    const screen = await render(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId={null} create={create} />),
    );
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "/");

    await screen.rerender(
      tall(<ConversationArea client={client} containerId={CHAT} sessionId="new1" create={create} />),
    );
    answered.resolve();

    await expect.element(screen.getByRole("textbox", { name: "消息" })).toHaveValue("/");
    await expect.element(screen.getByRole("textbox", { name: "消息" })).toHaveFocus();
    pageDrafts().drop(["new1"]);
  });
});
