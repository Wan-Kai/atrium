import { ConnectionLostError } from "@atrium/client";
import { type CommandResult, CommandError, type Turn } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import "../styles.css";
import { fakeClient } from "../test/fake-client";
import { ReplyTranslationContext } from "./reply-translation";
import { TurnView } from "./turn-view";

const MODEL = { providerId: "faux", modelId: "translator" };
const RESULT: CommandResult<"translate_reply"> = { text: "保留 **原文**。", language: "简体中文", model: MODEL };

/**
 * Makes a completed reply with a process that must never be translated.
 * @remarks The footer reads only the final text from the existing layout.
 * @sideEffects none
 * @param fields - Any changed fields.
 * @returns The turn.
 */
function turn(fields: Partial<Turn> = {}): Turn {
  return {
    kind: "turn",
    id: "t1",
    source: null,
    user: { text: "Explain cancellation", images: 0, clientMessageId: null, auto: false, command: null, timestamp: 1 },
    steps: [
      { kind: "thinking", id: "think", text: "private process", durationMs: 1 },
      { kind: "text", id: "reply", text: "Keep the **original**." },
    ],
    outcome: "done",
    error: null,
    startedAt: 1,
    durationMs: 1,
    usage: null,
    changes: [],
    ...fields,
  };
}

/**
 * Returns one declared command answer per call.
 * @remarks Branching stays in the fixture, not in behavior assertions or test scenarios.
 * @sideEffects Advances the fixture's response cursor.
 * @param answers - Lazy promises, so a rejection exists only when requested.
 * @returns The command fixture.
 */
function scripted<T>(answers: readonly (() => Promise<T>)[]): () => Promise<T> {
  let index = 0;
  return () => {
    const answer = answers[index++];
    if (answer === undefined) throw new Error("Unexpected extra command");
    return answer();
  };
}

describe("reply translation", () => {
  it("cancels the request, restores focus, ignores its late reply and retries with a fresh id", async () => {
    const fake = fakeClient();
    const first = Promise.withResolvers<CommandResult<"translate_reply">>();
    const second = Promise.withResolvers<CommandResult<"translate_reply">>();
    const requested: string[] = [];
    const cancelled: string[] = [];
    const answer = scripted([() => first.promise, () => second.promise]);
    const client = {
      ...fake.client,
      translateReply: (_sessionId: string, _turnId: string, id: string) => {
        requested.push(id);
        return answer();
      },
      cancelTranslation: async (id: string) => {
        cancelled.push(id);
        return {};
      },
    };
    const screen = await render(
      <ReplyTranslationContext value={{ client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn()} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    const button = screen.getByRole("button", { name: "翻译回复" });
    await button.click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("正在翻译成简体中文取消");
    await screen.getByRole("button", { name: "取消", exact: true }).click();
    expect(cancelled).toStrictEqual(requested);
    await expect.element(button).toHaveFocus();
    await button.click();
    expect(requested).toHaveLength(2);
    expect(requested[0]).not.toBe(requested[1]);
    first.resolve({ ...RESULT, text: "过期译文" });
    await first.promise;
    // Flush the settled request's React update before asserting that the newer request still owns the status.
    await screen.rerender(
      <ReplyTranslationContext value={{ client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn()} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("正在翻译成简体中文取消");
    await expect.element(screen.getByRole("region", { name: "回复译文" })).not.toBeInTheDocument();
    second.resolve(RESULT);
    await expect
      .element(screen.getByRole("region", { name: "回复译文" }).getByText("保留", { exact: false }))
      .toBeVisible();
    await expect.element(screen.getByText("过期译文")).not.toBeInTheDocument();
  });

  it("treats a disconnected cancellation as cancelled without a confirmation error", async () => {
    const fake = fakeClient();
    const pending = Promise.withResolvers<CommandResult<"translate_reply">>();
    const cancellation = Promise.withResolvers<{}>();
    const requested: string[] = [];
    const cancelled: string[] = [];
    const client = {
      ...fake.client,
      translateReply: (_sessionId: string, _turnId: string, id: string) => {
        requested.push(id);
        return pending.promise;
      },
      cancelTranslation: (id: string) => {
        cancelled.push(id);
        return cancellation.promise;
      },
    };
    const screen = await render(
      <ReplyTranslationContext value={{ client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn()} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await screen.getByRole("button", { name: "翻译回复" }).click();
    await screen.getByRole("button", { name: "取消", exact: true }).click();
    cancellation.reject(new ConnectionLostError("cancel_translation"));
    pending.reject(new ConnectionLostError("translate_reply"));
    await Promise.allSettled([cancellation.promise, pending.promise]);
    await screen.rerender(
      <ReplyTranslationContext value={{ client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn()} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    expect(cancelled).toStrictEqual(requested);
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("region", { name: "回复译文" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "翻译回复" })).toHaveTextContent("翻译");
  });

  it("keeps a confirmation error when cancellation fails without disconnecting", async () => {
    const fake = fakeClient();
    const pending = Promise.withResolvers<CommandResult<"translate_reply">>();
    const cancellation = Promise.withResolvers<{}>();
    const client = {
      ...fake.client,
      translateReply: () => pending.promise,
      cancelTranslation: () => cancellation.promise,
    };
    const screen = await render(
      <ReplyTranslationContext value={{ client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn()} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await screen.getByRole("button", { name: "翻译回复" }).click();
    await screen.getByRole("button", { name: "取消", exact: true }).click();
    cancellation.reject(new CommandError("internal_error"));
    pending.reject(new CommandError("translation_failed", { reason: "aborted" }));
    await Promise.allSettled([cancellation.promise, pending.promise]);
    await screen.rerender(
      <ReplyTranslationContext value={{ client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn()} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await expect.element(screen.getByRole("alert")).toHaveTextContent("没能确认翻译已取消，请稍后重试重试");
    await expect.element(screen.getByRole("button", { name: "重试", exact: true })).toBeVisible();
    await expect.element(screen.getByTestId("reply")).toHaveTextContent("Keep the original.");
  });

  it("puts the translation immediately below the info row and before open file changes, preserving their state", async () => {
    const fake = fakeClient();
    const value = turn({ changes: [{ path: "src/a.ts", added: 1, removed: 0 }] });
    const screen = await render(
      <ReplyTranslationContext value={{ client: fake.client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={value} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    const changeButton = screen.getByRole("button", { name: /^改了 1 个文件/ });
    await changeButton.click();
    const fileButton = screen.getByTestId("files").getByRole("button", { name: /src\/a.ts/ });
    await fileButton.click();
    await expect.element(fileButton).toHaveAttribute("aria-expanded", "true");
    await screen.getByRole("button", { name: "翻译回复" }).click();
    await expect.element(screen.getByRole("region", { name: "回复译文" })).toBeVisible();
    const footer = screen.getByTestId("turn-footer").element();
    const translation = screen.getByRole("region", { name: "回复译文" }).element();
    const files = screen.getByTestId("files").element();
    expect(Boolean(footer.compareDocumentPosition(translation) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(translation.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    await screen.getByRole("button", { name: "收起译文" }).click();
    await expect.element(fileButton).toHaveAttribute("aria-expanded", "true");
    await expect.element(changeButton).toHaveAttribute("aria-expanded", "true");
    await screen.rerender(
      <ReplyTranslationContext value={{ client: fake.client, sessionId: "s1", language: "日本語" }}>
        <TurnView turn={value} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await expect.element(fileButton).toHaveAttribute("aria-expanded", "true");
    await expect.element(changeButton).toHaveAttribute("aria-expanded", "true");
  });

  it("does not let a cancelled request's late reply overwrite a newer completed translation", async () => {
    const fake = fakeClient();
    const first = Promise.withResolvers<CommandResult<"translate_reply">>();
    const requested: string[] = [];
    const cancelled: string[] = [];
    const answer = scripted([() => first.promise, () => Promise.resolve(RESULT)]);
    const client = {
      ...fake.client,
      translateReply: (_sessionId: string, _turnId: string, id: string) => {
        requested.push(id);
        return answer();
      },
      cancelTranslation: async (id: string) => {
        cancelled.push(id);
        return {};
      },
    };
    const screen = await render(
      <ReplyTranslationContext value={{ client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn()} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await screen.getByRole("button", { name: "翻译回复" }).click();
    await screen.getByRole("button", { name: "取消", exact: true }).click();
    await screen.getByRole("button", { name: "翻译回复" }).click();
    const result = screen.getByRole("region", { name: "回复译文" });
    await expect.element(result.getByText("原文", { exact: true })).toBeVisible();
    expect(requested).toHaveLength(2);
    expect(cancelled).toStrictEqual([requested[0]]);
    first.resolve({ ...RESULT, text: "过期译文覆盖了新结果" });
    await first.promise;
    await screen.rerender(
      <ReplyTranslationContext value={{ client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn()} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await expect.element(result.getByText("原文", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("过期译文覆盖了新结果")).not.toBeInTheDocument();
    await expect.element(screen.getByTestId("reply")).toHaveTextContent("Keep the original.");
  });

  it("does not let an old cancellation failure replace a newer completed translation", async () => {
    const fake = fakeClient();
    const first = Promise.withResolvers<CommandResult<"translate_reply">>();
    const cancellation = Promise.withResolvers<{}>();
    const client = {
      ...fake.client,
      translateReply: scripted([() => first.promise, () => Promise.resolve(RESULT)]),
      cancelTranslation: () => cancellation.promise,
    };
    const screen = await render(
      <ReplyTranslationContext value={{ client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn()} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await screen.getByRole("button", { name: "翻译回复" }).click();
    await screen.getByRole("button", { name: "取消", exact: true }).click();
    await screen.getByRole("button", { name: "翻译回复" }).click();
    await expect.element(screen.getByRole("region", { name: "回复译文" })).toBeVisible();
    cancellation.reject(new Error("old failure"));
    first.reject(new Error("old translation failure"));
    await Promise.allSettled([cancellation.promise, first.promise]);
    await screen.rerender(
      <ReplyTranslationContext value={{ client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn()} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await expect.element(screen.getByRole("region", { name: "回复译文" })).toBeVisible();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the original on a failed command and retries without exposing the raw error", async () => {
    const fake = fakeClient();
    const requested: string[] = [];
    const answer = scripted([
      () =>
        Promise.reject(new CommandError("translation_failed", { reason: "timed_out", detail: "private model error" })),
      () => Promise.resolve(RESULT),
    ]);
    const client = {
      ...fake.client,
      translateReply: (_sessionId: string, _turnId: string, id: string) => {
        requested.push(id);
        return answer();
      },
    };
    const screen = await render(
      <ReplyTranslationContext value={{ client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn()} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await screen.getByRole("button", { name: "翻译回复" }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("翻译超时了，可以重试重试");
    await expect.element(screen.getByTestId("reply")).toHaveTextContent("Keep the original.");
    await expect.element(screen.getByText("private model error")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "重试", exact: true }).click();
    await expect.element(screen.getByRole("region", { name: "回复译文" })).toBeVisible();
    expect(requested).toHaveLength(2);
  });

  it.each([
    { change: "source", sessionId: "s1", language: "简体中文", reply: "New original.", turnId: "t1" },
    { change: "language", sessionId: "s1", language: "日本語", reply: "Keep the **original**.", turnId: "t1" },
    { change: "session", sessionId: "s2", language: "简体中文", reply: "Keep the **original**.", turnId: "t1" },
    { change: "turn", sessionId: "s1", language: "简体中文", reply: "Keep the **original**.", turnId: "t2" },
  ])("cancels and clears translation when the $change changes, ignoring the old completion", async (next) => {
    const fake = fakeClient();
    const pending = Promise.withResolvers<CommandResult<"translate_reply">>();
    const requested: string[] = [];
    const cancelled: string[] = [];
    const client = {
      ...fake.client,
      translateReply: (_sessionId: string, _turnId: string, id: string) => {
        requested.push(id);
        return pending.promise;
      },
      cancelTranslation: async (id: string) => {
        cancelled.push(id);
        return {};
      },
    };
    const screen = await render(
      <ReplyTranslationContext value={{ client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn()} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await screen.getByRole("button", { name: "翻译回复" }).click();
    const updated = (
      <ReplyTranslationContext value={{ client, sessionId: next.sessionId, language: next.language }}>
        <TurnView
          turn={turn({ id: next.turnId, steps: [{ kind: "text", id: "reply", text: next.reply }] })}
          runStartedAt={null}
        />
      </ReplyTranslationContext>
    );
    await screen.rerender(updated);
    expect(cancelled).toStrictEqual(requested);
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
    pending.resolve({ ...RESULT, text: "过期的旧译文" });
    await pending.promise;
    await screen.rerender(updated);
    await expect.element(screen.getByRole("region", { name: "回复译文" })).not.toBeInTheDocument();
    await expect.element(screen.getByText("过期的旧译文")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "翻译回复" })).toHaveTextContent("翻译");
  });

  it("cancels once on unmount and creates no saved translation", async () => {
    const fake = fakeClient();
    const pending = Promise.withResolvers<CommandResult<"translate_reply">>();
    const requested: string[] = [];
    const cancelled: string[] = [];
    const client = {
      ...fake.client,
      translateReply: (_sessionId: string, _turnId: string, id: string) => {
        requested.push(id);
        return pending.promise;
      },
      cancelTranslation: async (id: string) => {
        cancelled.push(id);
        return {};
      },
    };
    const before = JSON.stringify(localStorage);
    const screen = await render(
      <ReplyTranslationContext value={{ client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn()} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await screen.getByRole("button", { name: "翻译回复" }).click();
    await screen.unmount();
    pending.resolve(RESULT);
    await pending.promise;
    expect(cancelled).toStrictEqual(requested);
    expect(cancelled).toHaveLength(1);
    expect(JSON.stringify(localStorage)).toBe(before);
    expect(fake.calls).toStrictEqual([]);
  });

  it.each(["stopped", "failed"] as const)("offers translation for a %s reply with remaining text", async (outcome) => {
    const fake = fakeClient();
    const screen = await render(
      <ReplyTranslationContext value={{ client: fake.client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn({ outcome })} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await screen.getByRole("button", { name: "翻译回复" }).click();
    await expect.element(screen.getByRole("region", { name: "回复译文" })).toBeVisible();
    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    { case: "running", value: turn({ outcome: "running" }) },
    {
      case: "process only",
      value: turn({ steps: [{ kind: "thinking", id: "think", text: "private process", durationMs: 1 }] }),
    },
    { case: "blank reply", value: turn({ steps: [{ kind: "text", id: "blank", text: "  \n " }] }) },
  ])("does not offer translation for a $case turn", async ({ value }) => {
    const fake = fakeClient();
    const screen = await render(
      <ReplyTranslationContext value={{ client: fake.client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={value} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await expect.element(screen.getByRole("button", { name: "翻译回复" })).not.toBeInTheDocument();
    expect(fake.calls).toStrictEqual([]);
  });

  it("keeps the original, expands translated Markdown below the footer and reopens without another call", async () => {
    const fake = fakeClient();
    const calls: string[][] = [];
    const client = {
      ...fake.client,
      translateReply: async (sessionId: string, turnId: string, translationId: string) => {
        calls.push([sessionId, turnId, translationId]);
        return RESULT;
      },
      cancelTranslation: async () => ({}),
    };
    const screen = await render(
      <ReplyTranslationContext value={{ client, sessionId: "s1", language: "简体中文" }}>
        <TurnView turn={turn()} runStartedAt={null} />
      </ReplyTranslationContext>,
    );
    await screen.getByRole("button", { name: "翻译回复" }).click();
    await expect.element(screen.getByRole("region", { name: "回复译文" })).toBeVisible();
    await expect.element(screen.getByTestId("reply")).toHaveTextContent("Keep the original.");
    await expect
      .element(screen.getByRole("region", { name: "回复译文" }).getByText("原文", { exact: true }))
      .toBeVisible();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toStrictEqual(["s1", "t1"]);
    expect(calls[0]?.[2]).toMatch(/^[0-9a-f-]{36}$/);
    const footer = screen.getByTestId("turn-footer").element();
    const result = screen.getByRole("region", { name: "回复译文" }).element();
    expect(Boolean(footer.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    await screen.getByRole("button", { name: "收起译文" }).click();
    await expect.element(screen.getByRole("region", { name: "回复译文" })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "翻译回复" }).click();
    await expect.element(screen.getByRole("region", { name: "回复译文" })).toBeVisible();
    expect(calls).toHaveLength(1);
  });
});
