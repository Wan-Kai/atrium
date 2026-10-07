import { parseFixture } from "@atrium/testkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../../test/contract";
import type { PiEvent } from "../process/pi-process";
import { type TranslatedEvent, createEventTranslator } from "./translate";

/** Translates every event pi printed in a recorded scenario, with ids m1, m2, … */
function translateFixture(scenario: string): TranslatedEvent[] {
  const fixture = parseFixture(readFileSync(join(FIXTURES_DIR, "pi-1.0.2", `${scenario}.jsonl`), "utf8"));
  return translateAll(
    fixture.flatMap((record) =>
      record.kind === "stdout" && record.record["type"] !== "response" ? [record.record as unknown as PiEvent] : [],
    ),
  );
}

/** Translates events with ids m1, m2, … */
function translateAll(events: readonly PiEvent[]): TranslatedEvent[] {
  let next = 0;
  const translate = createEventTranslator(() => `m${++next}`);
  return events.flatMap((event) => translate(event));
}

/** A finished user message as the translator reports it. */
function user(id: string, text: string): TranslatedEvent {
  return {
    kind: "message_finished",
    message: { id, role: "user", text, clientMessageId: null, timestamp: 0 },
  };
}

/** An assistant message that failed with `errorMessage`. */
function failed(id: string, errorMessage: string): TranslatedEvent {
  return {
    kind: "message_finished",
    message: { id, role: "assistant", content: [], stopReason: "error", errorMessage, timestamp: 0 },
  };
}

/** A pi assistant message with the given content and stop reason. */
function assistant(content: unknown[], stopReason: string): never {
  return { role: "assistant", content, stopReason, timestamp: 5 } as never;
}

/** A pi streaming update. */
function update(type: string, contentIndex: number, delta?: string): PiEvent {
  return {
    type: "message_update",
    message: assistant([], "pending"),
    assistantMessageEvent: { type, contentIndex, delta },
  } as never;
}

describe("createEventTranslator against recorded pi output", () => {
  it("streams reasoning and text with their own ids and indexes, then the finished message", () => {
    expect(translateFixture("prompt-started")).toStrictEqual([
      { kind: "agent_started" },
      user("m1", "hi"),
      { kind: "message_started", messageId: "m2" },
      { kind: "reasoning_delta", messageId: "m2", contentIndex: 0, delta: "Plan fir" },
      { kind: "reasoning_delta", messageId: "m2", contentIndex: 0, delta: "st." },
      { kind: "text_delta", messageId: "m2", contentIndex: 1, delta: "Hello fr" },
      { kind: "text_delta", messageId: "m2", contentIndex: 1, delta: "om faux." },
      {
        kind: "message_finished",
        message: {
          id: "m2",
          role: "assistant",
          content: [
            { type: "reasoning", text: "Plan first." },
            { type: "text", text: "Hello from faux." },
          ],
          stopReason: "stop",
          errorMessage: null,
          timestamp: 0,
        },
      },
      { kind: "agent_settled" },
    ]);
  });

  it("keeps a failed attempt and its retry as separate messages within one run, and pi's error text", () => {
    expect(translateFixture("error-retry")).toStrictEqual([
      { kind: "agent_started" },
      user("m1", "one"),
      { kind: "message_started", messageId: "m2" },
      failed("m2", "upstream returned 503 service unavailable"),
      // The automatic retry starts the agent again.
      { kind: "agent_started" },
      { kind: "message_started", messageId: "m3" },
      { kind: "text_delta", messageId: "m3", contentIndex: 0, delta: "recovere" },
      { kind: "text_delta", messageId: "m3", contentIndex: 0, delta: "d" },
      {
        kind: "message_finished",
        message: {
          id: "m3",
          role: "assistant",
          content: [{ type: "text", text: "recovered" }],
          stopReason: "stop",
          errorMessage: null,
          timestamp: 0,
        },
      },
      { kind: "agent_settled" },
      { kind: "agent_started" },
      user("m4", "two"),
      { kind: "message_started", messageId: "m5" },
      failed("m5", "scripted failure"),
      { kind: "agent_settled" },
    ]);
  });

  it("reports an aborted reply as an empty message stopped by abort, with pi's text", () => {
    expect(translateFixture("abort")).toStrictEqual([
      { kind: "agent_started" },
      user("m1", "one"),
      { kind: "message_started", messageId: "m2" },
      {
        kind: "message_finished",
        message: {
          id: "m2",
          role: "assistant",
          content: [],
          stopReason: "aborted",
          errorMessage: "Request was aborted",
          timestamp: 0,
        },
      },
      { kind: "agent_settled" },
    ]);
  });
});

describe("createEventTranslator on cases the fixtures do not show", () => {
  it("leaves tool calls out and counts only the blocks it keeps", () => {
    const content = [
      { type: "thinking", thinking: "a" },
      { type: "toolCall", id: "t1", name: "bash", arguments: {} },
      { type: "text", text: "b" },
    ];

    expect(
      translateAll([
        { type: "message_start", message: assistant([], "pending") } as never,
        update("thinking_start", 0),
        update("toolcall_start", 1),
        update("toolcall_delta", 1, "{"),
        update("text_start", 2),
        update("text_delta", 2, "b"),
        { type: "message_end", message: assistant(content, "toolUse") } as never,
      ]),
    ).toStrictEqual([
      { kind: "message_started", messageId: "m1" },
      { kind: "text_delta", messageId: "m1", contentIndex: 1, delta: "b" },
      {
        kind: "message_finished",
        message: {
          id: "m1",
          role: "assistant",
          content: [
            { type: "reasoning", text: "a" },
            { type: "text", text: "b" },
          ],
          stopReason: "toolUse",
          errorMessage: null,
          timestamp: 5,
        },
      },
    ]);
  });

  it("counts a block that starts but streams nothing, so later blocks keep their place", () => {
    expect(
      translateAll([
        { type: "message_start", message: assistant([], "pending") } as never,
        update("text_start", 0),
        update("thinking_start", 1),
        update("thinking_delta", 1, "hm"),
      ]),
    ).toStrictEqual([
      { kind: "message_started", messageId: "m1" },
      { kind: "reasoning_delta", messageId: "m1", contentIndex: 1, delta: "hm" },
    ]);
  });

  it("gives a block whose start it missed an index of its own, and ignores updates outside a message", () => {
    expect(
      translateAll([
        update("text_delta", 0, "lost"),
        { type: "message_start", message: assistant([], "pending") } as never,
        update("text_delta", 3, "x"),
        update("thinking_delta", 7, "y"),
        update("text_delta", 3, "z"),
      ]),
    ).toStrictEqual([
      { kind: "message_started", messageId: "m1" },
      { kind: "text_delta", messageId: "m1", contentIndex: 0, delta: "x" },
      { kind: "reasoning_delta", messageId: "m1", contentIndex: 1, delta: "y" },
      { kind: "text_delta", messageId: "m1", contentIndex: 0, delta: "z" },
    ]);
  });

  it.each([
    ["pending", "stop"],
    ["deferred", "stop"],
    ["length", "length"],
  ])("maps a finished %s message to %s", (reason, expected) => {
    const [finished] = translateAll([{ type: "message_end", message: assistant([], reason) } as never]);

    expect(finished).toMatchObject({ message: { id: "m1", stopReason: expected } });
  });

  it("reads a user message given as a string or as parts, skipping images", () => {
    expect(
      translateAll([
        { type: "message_end", message: { role: "user", content: "plain", timestamp: 1 } } as never,
        {
          type: "message_end",
          message: {
            role: "user",
            content: [
              { type: "text", text: "a" },
              { type: "image", data: "", mimeType: "image/png" },
              { type: "text", text: "b" },
            ],
            timestamp: 2,
          },
        } as never,
      ]),
    ).toStrictEqual([
      {
        kind: "message_finished",
        message: { id: "m1", role: "user", text: "plain", clientMessageId: null, timestamp: 1 },
      },
      {
        kind: "message_finished",
        message: { id: "m2", role: "user", text: "a\nb", clientMessageId: null, timestamp: 2 },
      },
    ]);
  });

  it("drops system messages and events it does not show yet", () => {
    expect(
      translateAll([
        { type: "message_start", message: { role: "system", content: "" } } as never,
        { type: "message_end", message: { role: "system", content: "" } } as never,
        { type: "turn_start" } as never,
        { type: "queue_update", steering: [], followUp: [] } as never,
        { type: "extension_ui_request", id: "x", method: "notify", message: "hi" } as never,
      ]),
    ).toStrictEqual([]);
  });
});
