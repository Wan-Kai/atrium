import type { AtriumClient, ConnectionState, SessionView } from "@atrium/client";
import { CommandError, ConnectionLostError } from "@atrium/client";
import type { RecentSession, TranscriptItem, Turn } from "@atrium/protocol";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { type StoreApi, createStore } from "zustand/vanilla";
import "../styles.css";
import { ChatScreen, describeSendError } from "./chat-screen";
import { Composer } from "./composer";
import { UserBubble } from "./messages";
import { formatElapsed } from "./run-status";
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
      <Transcript view={view({ items, ...fields })} onLoadOlder={onLoadOlder} />
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

/** A client that records commands, creates chats s1, s2, … and answers as the test says. */
function fakeClient(
  answers: {
    createChat?: () => Promise<void>;
    prompt?: () => Promise<never>;
    recent?: RecentSession[];
    openSession?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const listed: number[] = [];
  const stores = new Map<string, StoreApi<SessionView>>();
  const connection = createStore<ConnectionState>(() => ({
    status: "connected",
    traceId: "t",
    hostVersion: "0",
    hostInstanceId: "h1",
  }));
  const client = {
    connection,
    listRecentSessions: async (limit: number) => {
      listed.push(limit);
      return { sessions: answers.recent ?? [] };
    },
    openSession: async (sessionId: string) => {
      calls.push(`openSession ${sessionId}`);
      await answers.openSession?.();
      stores.set(
        sessionId,
        createStore<SessionView>(() => view({ sessionId, items: [turn("t1", "以前的回答")] })),
      );
      return { sessionId };
    },
    createChat: async () => {
      calls.push("createChat");
      await answers.createChat?.();
      const sessionId = `s${stores.size + 1}`;
      stores.set(
        sessionId,
        createStore<SessionView>(() => view({ sessionId })),
      );
      return { sessionId };
    },
    watch: async (ids: readonly string[]) => {
      calls.push(`watch ${ids.join(",")}`);
    },
    session: (id: string) => stores.get(id),
    loadOlder: async () => undefined,
    prompt: (sessionId: string, text: string) => {
      calls.push(`prompt ${sessionId} ${text}`);
      const store = stores.get(sessionId);
      store?.setState({
        pending: [...(store.getState().pending ?? []), { clientMessageId: `q${calls.length}`, text }],
      });
      return answers.prompt?.() ?? Promise.resolve({ disposition: "started" as const });
    },
  } as unknown as AtriumClient;
  return { client, calls, listed, stores, connection };
}

describe("ChatScreen", () => {
  it("creates and watches a chat on the first message, and sends later ones to it", async () => {
    const { client, calls } = fakeClient();
    const screen = await render(<ChatScreen client={client} />);
    const box = screen.getByRole("textbox", { name: "消息" });

    await userEvent.type(box, "你好{Enter}");
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    await userEvent.type(box, "再说一句{Enter}");
    await vi.waitFor(() => expect(calls).toHaveLength(4));

    expect(calls).toStrictEqual(["createChat", "watch s1", "prompt s1 你好", "prompt s1 再说一句"]);
    await vi.waitFor(() =>
      expect(screen.container.querySelectorAll('[data-testid="user-message"][data-pending="true"]')).toHaveLength(2),
    );
  });

  it("waits for the chat being created instead of creating a second one", async () => {
    const gate = Promise.withResolvers<void>();
    const { client, calls } = fakeClient({ createChat: () => gate.promise });
    const screen = await render(<ChatScreen client={client} />);
    const box = screen.getByRole("textbox", { name: "消息" });

    await userEvent.type(box, "一{Enter}");
    await userEvent.type(box, "二{Enter}");
    gate.resolve();

    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls).toStrictEqual(["createChat", "watch s1", "prompt s1 一", "prompt s1 二"]);
  });

  it.each(["exited", "lost"] as const)("starts a new chat once the current one is %s", async (status) => {
    const { client, calls, stores } = fakeClient();
    const screen = await render(<ChatScreen client={client} />);
    const box = screen.getByRole("textbox", { name: "消息" });
    await userEvent.type(box, "一{Enter}");
    await vi.waitFor(() => expect(calls).toHaveLength(3));

    stores.get("s1")?.setState({ status });
    await userEvent.type(box, "二{Enter}");

    await vi.waitFor(() => expect(calls).toHaveLength(6));
    expect(calls.slice(3)).toStrictEqual(["createChat", "watch s2", "prompt s2 二"]);
  });

  it("does not send while a run is in progress", async () => {
    const { client, calls, stores } = fakeClient();
    const screen = await render(<ChatScreen client={client} />);
    const box = screen.getByRole("textbox", { name: "消息" });
    await userEvent.type(box, "一{Enter}");
    await vi.waitFor(() => expect(calls).toHaveLength(3));

    stores.get("s1")?.setState({ run: { runId: "r1", startedAt: Date.now() } });
    await userEvent.type(box, "二{Enter}");

    await expect.element(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(calls).toHaveLength(3);
    stores.get("s1")?.setState({ run: null });
    await screen.getByRole("button", { name: "发送" }).click();
    await vi.waitFor(() => expect(calls).toStrictEqual(["createChat", "watch s1", "prompt s1 一", "prompt s1 二"]));
  });

  it("lists the recent sessions once connected, and opens one", async () => {
    const recent: RecentSession[] = [
      { sessionId: "old", firstPrompt: "以前问的", modifiedAt: Date.now() - 60_000 },
      { sessionId: "blank", firstPrompt: null, modifiedAt: Date.UTC(2026, 0, 2) },
    ];
    const { client, calls, listed, connection } = fakeClient({ recent });
    connection.setState({ status: "connecting", traceId: "t" }, true);
    const screen = await render(<ChatScreen client={client} />);
    expect(listed).toStrictEqual([]);

    connection.setState({ status: "connected", traceId: "t", hostVersion: "0", hostInstanceId: "h1" }, true);
    const list = screen.getByRole("region", { name: "最近的会话" });
    await expect.element(list).toMatchTextContent(/^最近的会话以前问的今天 \d{2}:\d{2}（没有提问）1月2日$/);
    expect(listed).toStrictEqual([20]);
    await list.getByRole("button", { name: /以前问的/ }).click();

    await vi.waitFor(() => expect(calls).toStrictEqual(["openSession old", "watch old"]));
    await expect.element(screen.getByTestId("reply")).toHaveTextContent("以前的回答");
    await expect.element(screen.getByRole("region", { name: "最近的会话" })).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "最近会话" }).click();
    await expect.element(screen.getByRole("region", { name: "最近的会话" })).toBeVisible();
    expect(calls.at(-1)).toBe("watch ");
  });

  it("explains a session that could not be opened", async () => {
    const { client } = fakeClient({
      recent: [{ sessionId: "gone", firstPrompt: "x", modifiedAt: 0 }],
      openSession: () => Promise.reject(new CommandError("session_not_found", { sessionId: "gone" })),
    });
    const screen = await render(<ChatScreen client={client} />);

    await screen.getByRole("button", { name: /^x/ }).click();

    await expect.element(screen.getByRole("alert")).toHaveTextContent("这个会话已经不存在了");
  });

  it("switches the display mode with Ctrl+O and from its menu", async () => {
    const { client, calls } = fakeClient();
    const screen = await render(<ChatScreen client={client} />);
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "一{Enter}");
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    const menu = screen.getByRole("button", { name: "显示模式（Ctrl+O 切换）" });
    await expect.element(menu).toHaveTextContent("摘要模式");

    await userEvent.keyboard("{Control>}o{/Control}");
    await expect.element(menu).toHaveTextContent("思考模式");
    await userEvent.keyboard("{Meta>}{Control>}o{/Control}{/Meta}");
    await expect.element(menu).toHaveTextContent("思考模式");
    await menu.click();
    await screen.getByRole("menuitemradio", { name: /详细/ }).click();

    await expect.element(menu).toHaveTextContent("详细模式");
    await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
  });

  it("explains a failed send above the input box", async () => {
    const { client } = fakeClient({
      createChat: () => Promise.reject(new CommandError("pi_unavailable", { status: "missing" })),
    });
    const screen = await render(<ChatScreen client={client} />);

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
    [new CommandError("internal_error"), "宿主出错了，消息没有发出"],
    [new Error("other"), "发送失败"],
  ])("describes %s", (error, text) => {
    expect(describeSendError(error)).toBe(text);
  });
});
