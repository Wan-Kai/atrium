import type { AtriumClient, SessionView } from "@atrium/client";
import { CommandError, ConnectionLostError } from "@atrium/client";
import type { TranscriptMessage } from "@atrium/protocol";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createStore } from "zustand/vanilla";
import "../styles.css";
import { ChatScreen, describeSendError } from "./chat-screen";
import { Composer } from "./composer";
import { AssistantReply, UserBubble } from "./messages";
import { formatElapsed } from "./run-status";
import { Transcript } from "./transcript";

/** A ready view of session s1 with the given fields. */
function view(fields: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: "s1",
    status: "ready",
    epoch: 1,
    seq: 0,
    messages: [],
    streaming: null,
    run: null,
    pending: [],
    ...fields,
  };
}

/** A finished assistant message. */
function reply(id: string, text: string, fields: Partial<Extract<TranscriptMessage, { role: "assistant" }>> = {}) {
  return {
    id,
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    stopReason: "stop" as const,
    errorMessage: null,
    timestamp: Date.UTC(2026, 9, 7, 14, 31),
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

  it("says when a reply failed, with pi's text, or was stopped", async () => {
    const screen = await render(
      <>
        <AssistantReply
          content={[]}
          streaming={false}
          finished={reply("a1", "", { stopReason: "error", errorMessage: "429" })}
        />
        <AssistantReply
          content={[{ type: "text", text: "写了一半" }]}
          streaming={false}
          finished={reply("a2", "写了一半", { stopReason: "aborted" })}
        />
      </>,
    );

    expect(screen.container.querySelector('[data-testid="reply-error"]')?.textContent).toBe("回复出错：429");
    expect(screen.container.textContent).toContain("写了一半已停止");
  });

  it("shows reasoning while it streams and folds it into a toggle afterwards", async () => {
    const content = [
      { type: "reasoning" as const, text: "先想一想" },
      { type: "text" as const, text: "答案" },
    ];
    const screen = await render(<AssistantReply content={content} streaming />);
    const toggle = screen.getByRole("button", { name: "思考中" });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.container.textContent).toContain("先想一想");

    await screen.rerender(<AssistantReply content={content} streaming={false} finished={reply("a1", "答案")} />);
    const folded = screen.getByRole("button", { name: "思考过程" });

    await expect.element(folded).toHaveAttribute("aria-expanded", "false");
    expect(screen.container.textContent).not.toContain("先想一想");
    await folded.click();
    expect(screen.container.textContent).toContain("先想一想");
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

/** The transcript with the given messages in a 300 px box. */
function at(messages: TranscriptMessage[]) {
  return (
    <div style={{ height: 300, display: "flex", flexDirection: "column" }}>
      <Transcript view={view({ messages })} />
    </div>
  );
}

describe("Transcript", () => {
  it("shows messages, pending sends, the running timer and the reply streaming, in that order", async () => {
    const screen = await render(
      <div style={{ height: 400, display: "flex", flexDirection: "column" }}>
        <Transcript
          view={view({
            messages: [{ id: "u1", role: "user", text: "问", clientMessageId: "q1", timestamp: 0 }],
            pending: [{ clientMessageId: "q2", text: "再问" }],
            run: { runId: "r1", startedAt: Date.now() - 12_000 },
            streaming: { messageId: "m1", content: [{ type: "text", text: "正在答" }] },
          })}
        />
      </div>,
    );
    const items = screen.container.querySelectorAll("[data-testid]");

    expect(
      [...items].map((item) => item.getAttribute("data-testid")).filter((id) => id !== "transcript"),
    ).toStrictEqual(["user-message", "user-message", "run-status", "assistant-message"]);
    expect(screen.container.querySelector('[data-testid="run-status"]')?.textContent).toMatch(/^进行中 · 1[23]s$/);
  });

  it("follows new content at the bottom; scrolled up it stops and offers a way back, with a dot for news", async () => {
    const long = Array.from({ length: 40 }, (_, index) => reply(`a${index}`, `第 ${index} 段`));
    const screen = await render(at(long));
    const scroller = screen.getByTestId("transcript").element() as HTMLElement;
    await vi.waitFor(() =>
      expect(scroller.scrollTop + scroller.clientHeight).toBeGreaterThanOrEqual(scroller.scrollHeight - 1),
    );

    scroller.scrollTop = 0;
    const back = screen.getByRole("button", { name: "回到底部" });
    await expect.element(back).toBeVisible();
    expect(screen.container.querySelector('[data-testid="unseen-dot"]')).toBeNull();
    await screen.rerender(at([...long, reply("new", "新的回复")]));
    await vi.waitFor(() => expect(screen.container.querySelector('[data-testid="unseen-dot"]')).not.toBeNull());
    expect(scroller.scrollTop).toBe(0);

    await back.click();

    await vi.waitFor(() =>
      expect(scroller.scrollTop + scroller.clientHeight).toBeGreaterThanOrEqual(scroller.scrollHeight - 1),
    );
    await expect.element(screen.getByRole("button", { name: "回到底部" })).not.toBeInTheDocument();
    await screen.rerender(at([...long, reply("new", "新的回复"), reply("newer", "更新的回复")]));
    await vi.waitFor(() =>
      expect(scroller.scrollTop + scroller.clientHeight).toBeGreaterThanOrEqual(scroller.scrollHeight - 1),
    );
  });
});

/** A client that records commands and answers them as the test says. */
function fakeClient(
  answers: { createChat?: () => Promise<{ sessionId: string }>; prompt?: () => Promise<never> } = {},
) {
  const calls: string[] = [];
  const store = createStore<SessionView>(() => view());
  const client = {
    createChat: () => {
      calls.push("createChat");
      return answers.createChat?.() ?? Promise.resolve({ sessionId: "s1" });
    },
    watch: async (ids: readonly string[]) => {
      calls.push(`watch ${ids.join(",")}`);
    },
    session: (id: string) => (id === "s1" ? store : undefined),
    prompt: (sessionId: string, text: string) => {
      calls.push(`prompt ${sessionId} ${text}`);
      store.setState({ pending: [...store.getState().pending, { clientMessageId: `q${calls.length}`, text }] });
      return answers.prompt?.() ?? Promise.resolve({ disposition: "started" as const });
    },
  } as unknown as AtriumClient;
  return { client, calls };
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
    [new CommandError("pi_unavailable", { status: "exited" }), "pi 启动后立即退出了，可能还没有登录模型服务"],
    [new CommandError("pi_unavailable", { status: "unknown" }), "还在查找 pi，请稍后再试"],
    [new CommandError("pi_unavailable"), "还在查找 pi，请稍后再试"],
    [new CommandError("session_not_found", { sessionId: "s1" }), "这个会话已经不存在了"],
    [new CommandError("internal_error"), "宿主出错了，消息没有发出"],
    [new Error("other"), "发送失败"],
  ])("describes %s", (error, text) => {
    expect(describeSendError(error)).toBe(text);
  });
});
