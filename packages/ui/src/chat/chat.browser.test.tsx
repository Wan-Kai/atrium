import type { SessionView } from "@atrium/client";
import { CommandError, ConnectionLostError } from "@atrium/client";
import type { TranscriptItem, Turn } from "@atrium/protocol";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../styles.css";
import { fakeClient } from "../test/fake-client";
import { ConversationArea, describeSendError } from "./conversation-area";
import { Composer } from "./composer";
import { UserBubble } from "./messages";
import { ClockContext, type UiClock } from "../state/clock";
import { RunStatus, formatElapsed } from "./run-status";
import { Transcript } from "./transcript";

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
    ...fields,
  };
}

/** A turn answered with `text`. */
function turn(id: string, text: string, fields: Partial<Turn> = {}): Turn {
  return {
    kind: "turn",
    id,
    user: { text: `问 ${id}`, images: 0, clientMessageId: null, timestamp: Date.UTC(2026, 9, 7, 14, 31) },
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
    const screen = await render(<Composer onSend={(text) => sent.push(text)} />);
    const box = screen.getByRole("textbox", { name: "消息" });

    await userEvent.type(box, "第一行{Shift>}{Enter}{/Shift}第二行{Enter}");

    expect(sent).toStrictEqual(["第一行\n第二行"]);
    expect((box.element() as HTMLTextAreaElement).value).toBe("");
  });

  it("does not send while an input method is composing, nor when empty", async () => {
    const sent: string[] = [];
    const screen = await render(<Composer onSend={(text) => sent.push(text)} />);
    const box = screen.getByRole("textbox", { name: "消息" }).element() as HTMLTextAreaElement;

    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "   {Enter}");

    expect(sent).toStrictEqual([]);
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("sends with the button", async () => {
    const sent: string[] = [];
    const screen = await render(<Composer onSend={(text) => sent.push(text)} />);
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "你好");

    await screen.getByRole("button", { name: "发送" }).click();

    expect(sent).toStrictEqual(["你好"]);
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
    expect(screen.container.textContent).toContain("2 张图片");
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
    };
    const screen = await render(
      <ClockContext value={clock}>
        <RunStatus startedAt={88_000} />
      </ClockContext>,
    );
    await expect.element(screen.getByTestId("run-status")).toHaveTextContent("进行中 · 12s");

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

  it.each([
    ["chats", "不绑定项目和工作区，直接输入就开始"],
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
      <ConversationArea client={client} containerId="chats" sessionId="s1" create={noCreate} />,
    );

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "你好{Enter}");

    await vi.waitFor(() => expect(calls).toStrictEqual(["watch s1", "prompt s1 你好"]));
    await expect.element(screen.getByTestId("user-message")).toHaveAttribute("data-pending", "true");
    await expect.element(screen.getByTestId("user-message")).toHaveTextContent("你好");
  });

  it.each(["exited", "lost"] as const)("opens a session that is %s again before sending to it", async (status) => {
    const { client, calls, views } = fakeClient();
    const screen = await render(
      <ConversationArea client={client} containerId="chats" sessionId="s1" create={async () => ""} />,
    );
    await vi.waitFor(() => expect(views.has("s1")).toBe(true));
    views.get("s1")?.setState({ status });

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "再来{Enter}");

    await vi.waitFor(() => expect(calls).toStrictEqual(["watch s1", "openSession s1", "watch s1", "prompt s1 再来"]));
  });

  it("does not send while a run is in progress", async () => {
    const { client, calls, views } = fakeClient();
    const screen = await render(
      <ConversationArea client={client} containerId="chats" sessionId="s1" create={async () => ""} />,
    );
    await vi.waitFor(() => expect(views.has("s1")).toBe(true));
    views.get("s1")?.setState({ run: { runId: "r1", startedAt: Date.now() } });

    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "二{Enter}");
    await expect.element(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    views.get("s1")?.setState({ run: null });
    await screen.getByRole("button", { name: "发送" }).click();

    await vi.waitFor(() => expect(calls).toStrictEqual(["watch s1", "prompt s1 二"]));
  });

  it("stops watching when no session is active, and drops an old failure on switching", async () => {
    const { client, calls } = fakeClient({}, { prompt: () => Promise.reject(new CommandError("session_busy")) });
    const screen = await render(
      <ConversationArea client={client} containerId="chats" sessionId="s1" create={noCreate} />,
    );
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "一{Enter}");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("pi 正在忙，等这一轮结束再发");

    await screen.rerender(<ConversationArea client={client} containerId="chats" sessionId={null} create={noCreate} />);

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
    [new CommandError("internal_error"), "宿主出错了，消息没有发出"],
    [new Error("other"), "发送失败"],
  ])("describes %s", (error, text) => {
    expect(describeSendError(error)).toBe(text);
  });
});
