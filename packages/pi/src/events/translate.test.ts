import { parseFixture } from "@atrium/testkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../../test/contract";
import type { AssistantPart, LogMessage } from "../history/log-entry";
import type { PiEvent } from "../process/pi-process";
import { type TranslatedEvent, createEventTranslator } from "./translate";

/** Translates every event pi printed in a recorded scenario. */
function translateFixture(scenario: string): TranslatedEvent[] {
  const fixture = parseFixture(readFileSync(join(FIXTURES_DIR, "pi-1.0.2", `${scenario}.jsonl`), "utf8"));
  return translateAll(
    fixture.flatMap((record) =>
      record.kind === "stdout" && record.record["type"] !== "response" ? [record.record as unknown as PiEvent] : [],
    ),
  );
}

/** Translates events with a translator whose clock reads 99. */
function translateAll(events: readonly PiEvent[]): TranslatedEvent[] {
  const translate = createEventTranslator(() => 99);
  return events.flatMap((event) => translate(event));
}

/** A finished message. */
function finished(message: LogMessage): TranslatedEvent {
  return { kind: "message_finished", message };
}

/** A finished user message with only text, sent at 0. */
function user(text: string): TranslatedEvent {
  return finished({ kind: "user", text, images: 0, timestamp: 0 });
}

/** A finished assistant message sent at 0 that used no tokens (the fixtures' usage is normalized). */
function reply(
  parts: AssistantPart[],
  stopReason: "stop" | "toolUse" | "error" | "aborted" = "stop",
  errorMessage: string | null = null,
): TranslatedEvent {
  return finished({ kind: "assistant", parts, stopReason, errorMessage, usage: { input: 0, output: 0 }, timestamp: 0 });
}

/** A text or thinking block starting. */
function start(index: number, type: "text" | "thinking"): TranslatedEvent {
  return { kind: "part_started", index, part: { type, text: "" } };
}

/** A block growing. */
function delta(index: number, text: string): TranslatedEvent {
  return { kind: "part_delta", index, delta: text };
}

/** A tool call arriving complete. */
function call(index: number, callId: string, tool: string, args: Record<string, unknown>): TranslatedEvent {
  return { kind: "part_started", index, part: { type: "toolCall", callId, tool, args } };
}

/** A finished tool result sent at 0 without details. */
function result(callId: string, tool: string, text: string, details?: unknown): TranslatedEvent {
  return finished({ kind: "toolResult", callId, tool, text, isError: false, details, timestamp: 0 });
}

/** A pi assistant message with the given content and stop reason. */
function assistant(content: unknown[], stopReason: string): never {
  return { role: "assistant", content, stopReason, usage: { input: 3, output: 4 }, timestamp: 5 } as never;
}

/** A pi streaming update. */
function update(type: string, contentIndex: number, text?: string): PiEvent {
  return {
    type: "message_update",
    message: assistant([], "pending"),
    assistantMessageEvent: { type, contentIndex, delta: text },
  } as never;
}

const started = { kind: "assistant_started" } as const;

/** What the translator makes of one live output of tool call `c`. */
function toolOutput(partialResult: unknown): TranslatedEvent[] {
  return translateAll([
    { type: "tool_execution_update", toolCallId: "c", toolName: "x", args: {}, partialResult } as never,
  ]);
}
const run = { kind: "agent_started" } as const;
const settled = { kind: "agent_settled" } as const;
const unavailable = "upstream returned 503 service unavailable";

describe("createEventTranslator against recorded pi output", () => {
  it("streams thinking and text by their place in the message, then the finished message", () => {
    expect(translateFixture("prompt-started")).toStrictEqual([
      run,
      user("hi"),
      started,
      start(0, "thinking"),
      delta(0, "Plan fir"),
      delta(0, "st."),
      start(1, "text"),
      delta(1, "Hello fr"),
      delta(1, "om faux."),
      reply([
        { type: "thinking", text: "Plan first." },
        { type: "text", text: "Hello from faux." },
      ]),
      settled,
    ]);
  });

  it("reports a failed attempt, the retry pi starts, and a failure it does not retry", () => {
    expect(translateFixture("error-retry")).toStrictEqual([
      run,
      user("one"),
      started,
      reply([], "error", unavailable),
      { kind: "retry_started", attempt: 1, error: unavailable },
      // The automatic retry starts the agent again.
      run,
      started,
      start(0, "text"),
      delta(0, "recovere"),
      delta(0, "d"),
      reply([{ type: "text", text: "recovered" }]),
      settled,
      run,
      user("two"),
      started,
      reply([], "error", "scripted failure"),
      settled,
    ]);
  });

  it("reports an aborted reply as an empty message stopped by abort, with pi's text", () => {
    expect(translateFixture("abort")).toStrictEqual([
      run,
      user("one"),
      started,
      reply([], "aborted", "Request was aborted"),
      settled,
    ]);
  });

  it("reports tool calls once complete, live output, results, retries and the end of a compaction", () => {
    expect(translateFixture("history")).toStrictEqual([
      run,
      user("one"),
      started,
      start(0, "thinking"),
      delta(0, "Look fir"),
      delta(0, "st."),
      call(1, "call-1", "bash", { command: "printf 'tool-%s' ok" }),
      reply(
        [
          { type: "thinking", text: "Look first." },
          { type: "toolCall", callId: "call-1", tool: "bash", args: { command: "printf 'tool-%s' ok" } },
        ],
        "toolUse",
      ),
      { kind: "tool_output", callId: "call-1", text: "" },
      { kind: "tool_output", callId: "call-1", text: "tool-ok" },
      result("call-1", "bash", "tool-ok"),
      started,
      call(0, "call-2", "write", { path: "notes.txt", content: "a\nb\n" }),
      reply(
        [{ type: "toolCall", callId: "call-2", tool: "write", args: { path: "notes.txt", content: "a\nb\n" } }],
        "toolUse",
      ),
      result("call-2", "write", "Successfully wrote to notes.txt"),
      started,
      call(0, "call-3", "edit", { path: "notes.txt", edits: [{ oldText: "b", newText: "c\nd" }] }),
      reply(
        [
          {
            type: "toolCall",
            callId: "call-3",
            tool: "edit",
            args: { path: "notes.txt", edits: [{ oldText: "b", newText: "c\nd" }] },
          },
        ],
        "toolUse",
      ),
      result("call-3", "edit", "Successfully replaced 1 block(s) in notes.txt.", {
        diff: " 1 a\n-2 b\n+2 c\n+3 d",
        patch: "--- notes.txt\n+++ notes.txt\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n",
        firstChangedLine: 2,
      }),
      started,
      call(0, "call-4", "read", { path: "notes.txt", offset: 2, limit: 1 }),
      reply(
        [{ type: "toolCall", callId: "call-4", tool: "read", args: { path: "notes.txt", offset: 2, limit: 1 } }],
        "toolUse",
      ),
      result("call-4", "read", "c\n\n[2 more lines in file. Use offset=3 to continue.]"),
      started,
      start(0, "text"),
      delta(0, "first an"),
      delta(0, "swer"),
      reply([{ type: "text", text: "first answer" }]),
      settled,
      run,
      user("two"),
      started,
      reply([], "error", unavailable),
      { kind: "retry_started", attempt: 1, error: unavailable },
      run,
      started,
      start(0, "text"),
      delta(0, "second a"),
      delta(0, "nswer"),
      reply([{ type: "text", text: "second answer" }]),
      settled,
      { kind: "compaction_finished" },
      run,
      user("three"),
      started,
      start(0, "text"),
      delta(0, "third an"),
      delta(0, "swer"),
      reply([{ type: "text", text: "third answer" }]),
      settled,
      run,
      user("two, differently"),
      started,
      start(0, "text"),
      delta(0, "branch a"),
      delta(0, "nswer"),
      reply([{ type: "text", text: "branch answer" }]),
      settled,
      run,
      user("four"),
      started,
      start(0, "text"),
      delta(0, "fourth a"),
      delta(0, "nswer"),
      reply([{ type: "text", text: "fourth answer" }]),
      settled,
    ]);
  });
});

describe("createEventTranslator on cases the fixtures do not show", () => {
  it("reports a block whose start it missed before its first growth, once", () => {
    expect(
      translateAll([
        { type: "message_start", message: assistant([], "pending") } as never,
        update("text_delta", 3, "x"),
        update("thinking_delta", 7, "y"),
        update("text_delta", 3, "z"),
      ]),
    ).toStrictEqual([started, start(3, "text"), delta(3, "x"), start(7, "thinking"), delta(7, "y"), delta(3, "z")]);
  });

  it("reports a start once even if pi repeats it, and forgets started blocks with each new message", () => {
    expect(
      translateAll([
        { type: "message_start", message: assistant([], "pending") } as never,
        update("text_start", 0),
        update("text_start", 0),
        { type: "message_end", message: assistant([], "stop") } as never,
        update("text_delta", 0, "a"),
        { type: "message_start", message: assistant([], "pending") } as never,
        update("thinking_delta", 0, "b"),
      ]),
    ).toStrictEqual([
      started,
      start(0, "text"),
      finished({
        kind: "assistant",
        parts: [],
        stopReason: "stop",
        errorMessage: null,
        usage: { input: 3, output: 4 },
        timestamp: 5,
      }),
      start(0, "text"),
      delta(0, "a"),
      started,
      start(0, "thinking"),
      delta(0, "b"),
    ]);
  });

  it("ignores partial tool call arguments and other streaming updates", () => {
    expect(
      translateAll([
        update("toolcall_start", 0),
        update("toolcall_delta", 0, "{"),
        update("text_end", 1),
        update("thinking_end", 2),
      ]),
    ).toStrictEqual([]);
  });

  it("dates a message pi sent without a time by the translator's clock", () => {
    expect(translateAll([{ type: "message_end", message: { role: "user", content: "plain" } } as never])).toStrictEqual(
      [finished({ kind: "user", text: "plain", images: 0, timestamp: 99 })],
    );
  });

  it("starts a thinking block that streams nothing", () => {
    expect(
      translateAll([
        { type: "message_start", message: assistant([], "pending") } as never,
        update("thinking_start", 0),
        update("text_start", 1),
      ]),
    ).toStrictEqual([started, start(0, "thinking"), start(1, "text")]);
  });

  it("reads a tool's output only from text blocks in a content list, and none from anything else", () => {
    expect(toolOutput({ content: [null, "x", 3, {}, { type: 1 }, { type: "text", text: "a" }] })).toStrictEqual([
      { kind: "tool_output", callId: "c", text: "a" },
    ]);
    expect(toolOutput(null)).toStrictEqual([{ kind: "tool_output", callId: "c", text: "" }]);
    expect(toolOutput("text")).toStrictEqual([{ kind: "tool_output", callId: "c", text: "" }]);
    expect(toolOutput({ content: "not a list" })).toStrictEqual([{ kind: "tool_output", callId: "c", text: "" }]);
  });

  it("passes on a tool's output with no content as empty, and drops nested tool calls' output", () => {
    expect(
      translateAll([
        { type: "tool_execution_update", toolCallId: "c1", toolName: "x", args: {}, partialResult: {} } as never,
        { type: "tool_execution_update", toolCallId: "c2", toolName: "x", args: {}, partialResult: undefined } as never,
        {
          type: "tool_execution_update",
          toolCallId: "c3",
          toolName: "bash",
          args: {},
          partialResult: { content: [{ type: "text", text: "inner" }] },
          parentToolCallId: "c0",
        } as never,
      ]),
    ).toStrictEqual([
      { kind: "tool_output", callId: "c1", text: "" },
      { kind: "tool_output", callId: "c2", text: "" },
    ]);
  });

  it("drops system messages, a user's message start and events it does not show", () => {
    expect(
      translateAll([
        { type: "message_start", message: { role: "system", content: "" } } as never,
        { type: "message_end", message: { role: "system", content: "" } } as never,
        { type: "message_start", message: { role: "user", content: "", timestamp: 0 } } as never,
        { type: "turn_start" } as never,
        { type: "queue_update", steering: [], followUp: [] } as never,
        { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} } as never,
        { type: "extension_ui_request", id: "x", method: "notify", message: "hi" } as never,
      ]),
    ).toStrictEqual([]);
  });
});
