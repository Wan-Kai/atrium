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

/**
 * A dialog request as the translator reports it.
 *
 * @remarks
 * Fields a request lacks are null; a timeout of 0 or none is no deadline.
 *
 * @sideEffects none
 * @param fields - The id, kind and title, and what else the dialog has.
 * @returns The event.
 */
function dialog(fields: { id: string; method: string; title: string } & Record<string, unknown>): TranslatedEvent {
  return {
    kind: "dialog_requested",
    dialog: { message: null, options: null, placeholder: null, prefill: null, timeoutMs: null, ...fields },
  } as TranslatedEvent;
}

/** A finished message. */
function finished(message: LogMessage): TranslatedEvent {
  return { kind: "message_finished", message };
}

/** A finished user message with only text, sent at 0. */
function user(text: string): TranslatedEvent {
  return finished({ kind: "user", text, images: 0, skill: null, timestamp: 0 });
}

/** A finished assistant message sent at 0 that used no tokens (the fixtures' usage is normalized). */
function reply(
  parts: AssistantPart[],
  stopReason: "stop" | "toolUse" | "error" | "aborted" = "stop",
  errorMessage: string | null = null,
): TranslatedEvent {
  return finished({
    kind: "assistant",
    parts,
    stopReason,
    errorMessage,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null },
    timestamp: 0,
  });
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
  return {
    role: "assistant",
    content,
    stopReason,
    usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2 },
    timestamp: 5,
  } as never;
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
/** pi's `turn_start`: a request about to go out. */
const request = { kind: "request_started" } as const;
/** An assistant message's first output. */
const output = { kind: "output_started" } as const;
const settled = { kind: "agent_settled" } as const;
const unavailable = "upstream returned 503 service unavailable";

describe("createEventTranslator against recorded pi output", () => {
  it("streams thinking and text by their place in the message, then the finished message", () => {
    expect(translateFixture("prompt-started")).toStrictEqual([
      run,
      request,
      user("hi"),
      started,
      start(0, "thinking"),
      output,
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
      request,
      user("one"),
      started,
      reply([], "error", unavailable),
      { kind: "retry_started", attempt: 1, maxAttempts: 3, error: unavailable },
      // The automatic retry starts the agent again.
      run,
      request,
      started,
      start(0, "text"),
      output,
      delta(0, "recovere"),
      delta(0, "d"),
      reply([{ type: "text", text: "recovered" }]),
      settled,
      run,
      request,
      user("two"),
      started,
      reply([], "error", "scripted failure"),
      settled,
    ]);
  });

  it("reports an aborted reply as an empty message stopped by abort, with pi's text", () => {
    expect(translateFixture("abort")).toStrictEqual([
      run,
      request,
      user("one"),
      // The queue pi reports emptied as the run stops, once for the test's queued follow-up and once
      // for clear_queue.
      { kind: "steering_changed", steering: [] },
      { kind: "steering_changed", steering: [] },
      started,
      reply([], "aborted", "Request was aborted"),
      settled,
    ]);
  });

  it("reports tool calls once complete, live output, results, retries and a compaction", () => {
    expect(translateFixture("history")).toStrictEqual([
      run,
      request,
      user("one"),
      started,
      start(0, "thinking"),
      output,
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
      request,
      started,
      output,
      call(0, "call-2", "write", { path: "notes.txt", content: "a\nb\n" }),
      reply(
        [{ type: "toolCall", callId: "call-2", tool: "write", args: { path: "notes.txt", content: "a\nb\n" } }],
        "toolUse",
      ),
      result("call-2", "write", "Successfully wrote to notes.txt"),
      request,
      started,
      output,
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
      request,
      started,
      output,
      call(0, "call-4", "read", { path: "notes.txt", offset: 2, limit: 1 }),
      reply(
        [{ type: "toolCall", callId: "call-4", tool: "read", args: { path: "notes.txt", offset: 2, limit: 1 } }],
        "toolUse",
      ),
      result("call-4", "read", "c\n\n[2 more lines in file. Use offset=3 to continue.]"),
      request,
      started,
      start(0, "text"),
      output,
      delta(0, "first an"),
      delta(0, "swer"),
      reply([{ type: "text", text: "first answer" }]),
      settled,
      run,
      request,
      user("two"),
      started,
      reply([], "error", unavailable),
      { kind: "retry_started", attempt: 1, maxAttempts: 3, error: unavailable },
      run,
      request,
      started,
      start(0, "text"),
      output,
      delta(0, "second a"),
      delta(0, "nswer"),
      reply([{ type: "text", text: "second answer" }]),
      settled,
      { kind: "compaction_started" },
      { kind: "compaction_finished" },
      run,
      request,
      user("three"),
      started,
      start(0, "text"),
      output,
      delta(0, "third an"),
      delta(0, "swer"),
      reply([{ type: "text", text: "third answer" }]),
      settled,
      run,
      request,
      user("two, differently"),
      started,
      start(0, "text"),
      output,
      delta(0, "branch a"),
      delta(0, "nswer"),
      reply([{ type: "text", text: "branch answer" }]),
      settled,
      run,
      request,
      user("four"),
      started,
      start(0, "text"),
      output,
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
    ).toStrictEqual([
      started,
      output,
      start(3, "text"),
      delta(3, "x"),
      start(7, "thinking"),
      delta(7, "y"),
      delta(3, "z"),
    ]);
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
        usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, reasoning: null },
        timestamp: 5,
      }),
      output,
      start(0, "text"),
      delta(0, "a"),
      started,
      output,
      start(0, "thinking"),
      delta(0, "b"),
    ]);
  });

  it("shows no partial tool call arguments or other streaming updates, but takes the arguments' first part as output", () => {
    expect(
      translateAll([
        update("toolcall_start", 0),
        update("text_end", 1),
        update("toolcall_delta", 0, "{"),
        update("toolcall_delta", 0, "}"),
        update("thinking_end", 2),
      ]),
    ).toStrictEqual([output]);
  });

  it("reports each message's first output once, and each request pi is about to send", () => {
    expect(
      translateAll([
        { type: "turn_start" } as never,
        { type: "message_start", message: assistant([], "pending") } as never,
        update("text_start", 0),
        update("text_delta", 0, "a"),
        update("text_delta", 0, "b"),
        { type: "message_end", message: assistant([], "stop") } as never,
        { type: "turn_start" } as never,
        { type: "message_start", message: assistant([], "pending") } as never,
        update("thinking_delta", 0, "c"),
      ]),
    ).toStrictEqual([
      request,
      started,
      start(0, "text"),
      output,
      delta(0, "a"),
      delta(0, "b"),
      finished({
        kind: "assistant",
        parts: [],
        stopReason: "stop",
        errorMessage: null,
        usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, reasoning: null },
        timestamp: 5,
      }),
      request,
      started,
      output,
      start(0, "thinking"),
      delta(0, "c"),
    ]);
  });

  it("dates a message pi sent without a time by the translator's clock", () => {
    expect(translateAll([{ type: "message_end", message: { role: "user", content: "plain" } } as never])).toStrictEqual(
      [finished({ kind: "user", text: "plain", images: 0, skill: null, timestamp: 99 })],
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
        { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} } as never,
        { type: "extension_ui_request", id: "s", method: "setStatus", statusKey: "k", statusText: "x" },
        { type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "k", widgetLines: ["x"] },
        { type: "extension_ui_request", id: "t", method: "setTitle", title: "x" },
        { type: "extension_ui_request", id: "e", method: "set_editor_text", text: "x" },
      ]),
    ).toStrictEqual([]);
  });

  it("reports the start of a compaction", () => {
    expect(translateAll([{ type: "compaction_start", reason: "threshold" } as never])).toStrictEqual([
      { kind: "compaction_started" },
    ]);
  });

  it("reports pi's steering queue whole each time, leaving out its follow-ups", () => {
    expect(
      translateAll([
        { type: "queue_update", steering: ["a", "b"], followUp: ["later"] },
        { type: "queue_update", steering: [], followUp: [] },
      ]),
    ).toStrictEqual([
      { kind: "steering_changed", steering: ["a", "b"] },
      { kind: "steering_changed", steering: [] },
    ]);
  });

  it("reports a change of thinking level", () => {
    expect(translateAll([{ type: "thinking_level_changed", level: "xhigh" }])).toStrictEqual([
      { kind: "thinking_changed", level: "xhigh" },
    ]);
  });

  it("reports the four kinds of dialog with what each shows and its timeout", () => {
    expect(
      translateAll([
        { type: "extension_ui_request", id: "d1", method: "select", title: "Pick", options: ["a", "b"], timeout: 5000 },
        { type: "extension_ui_request", id: "d2", method: "confirm", title: "Sure?", message: "It deletes" },
        { type: "extension_ui_request", id: "d3", method: "input", title: "Name", placeholder: "app", timeout: 0 },
        { type: "extension_ui_request", id: "d4", method: "editor", title: "Edit", prefill: "text" },
        { type: "extension_ui_request", id: "d5", method: "input", title: "Bare" },
      ]),
    ).toStrictEqual([
      dialog({ id: "d1", method: "select", title: "Pick", options: ["a", "b"], timeoutMs: 5000 }),
      dialog({ id: "d2", method: "confirm", title: "Sure?", message: "It deletes" }),
      dialog({ id: "d3", method: "input", title: "Name", placeholder: "app" }),
      dialog({ id: "d4", method: "editor", title: "Edit", prefill: "text" }),
      dialog({ id: "d5", method: "input", title: "Bare" }),
    ]);
  });

  it("passes on an extension's notification and its level, info when pi gives none", () => {
    expect(
      translateAll([
        { type: "extension_ui_request", id: "n1", method: "notify", message: "careful", notifyType: "warning" },
        { type: "extension_ui_request", id: "n2", method: "notify", message: "done" },
      ]),
    ).toStrictEqual([
      { kind: "notified", level: "warning", text: "careful" },
      { kind: "notified", level: "info", text: "done" },
    ]);
  });
});
