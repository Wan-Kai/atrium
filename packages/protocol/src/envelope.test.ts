import { describe, expect, it } from "vitest";
import { COMMAND_TYPES, type Command, CommandResult } from "./commands";
import { ErrorCode } from "./errors";
import { ClientMessage, HostMessage, parseClientMessage } from "./envelope";
import type { SessionEvent } from "./events";
import { PROTOCOL_VERSION } from "./version";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

/** One valid example of every command. */
const commands: Command[] = [
  { type: "ping", requestId: "r1", traceparent },
  { type: "create_chat", requestId: "r2", traceparent },
  { type: "subscribe_sessions", requestId: "r3", traceparent, sessionIds: ["s1", "s2"] },
  { type: "prompt", requestId: "r4", traceparent, sessionId: "s1", text: "你好" },
  { type: "report_client_issue", requestId: "r5", traceparent, kind: "long_task", message: "took 80 ms" },
  {
    type: "report_client_issue",
    requestId: "r6",
    traceparent,
    kind: "error",
    message: "TypeError",
    details: "at render",
  },
  { type: "report_client_issue", requestId: "r7", traceparent, kind: "slow_frames", message: "p95 40 ms" },
];

/** Where an event sits in a session's stream. */
const at = { sessionId: "s1", epoch: 1, seq: 7, traceId };

/** One valid example of every session event. */
const events: SessionEvent[] = [
  {
    type: "session_snapshot",
    ...at,
    traceId: null,
    messages: [
      { id: "u1", role: "user", text: "hi", clientMessageId: "r4", timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "hello" },
        ],
        stopReason: "stop",
        errorMessage: null,
        timestamp: 2,
      },
    ],
    streaming: { messageId: "a2", content: [{ type: "text", text: "par" }] },
    run: { runId: "run-1", startedAt: 3 },
  },
  { type: "run_started", ...at, runId: "run-1", startedAt: 3 },
  { type: "message_started", ...at, messageId: "a2" },
  { type: "text_delta", ...at, messageId: "a2", contentIndex: 0, delta: "tial" },
  { type: "reasoning_delta", ...at, messageId: "a2", contentIndex: 1, delta: "hmm" },
  {
    type: "message_finished",
    ...at,
    message: {
      id: "a2",
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "429 rate limited",
      timestamp: 4,
    },
  },
  { type: "run_settled", ...at, runId: "run-1", outcome: "failed", settledAt: 5 },
  { type: "session_exited", ...at, traceId: null, reason: "crashed", code: null, signal: "SIGKILL" },
];

describe("parseClientMessage", () => {
  it("accepts every command as it is sent over the wire", () => {
    for (const command of commands) {
      expect(parseClientMessage(JSON.parse(JSON.stringify(command)))).toStrictEqual({ ok: true, command });
    }
  });

  it("knows exactly the commands it accepts", () => {
    expect([...COMMAND_TYPES].toSorted()).toStrictEqual([
      "create_chat",
      "ping",
      "prompt",
      "report_client_issue",
      "subscribe_sessions",
    ]);
  });

  it("calls a well-formed message with an unknown type an unknown command, keeping its request id", () => {
    expect(parseClientMessage({ type: "fly", requestId: "r9", traceparent })).toStrictEqual({
      ok: false,
      requestId: "r9",
      code: "unknown_command",
    });
    // `hello` is only valid as the first message; afterwards it is not a command.
    expect(parseClientMessage({ type: "hello", requestId: "r10" })).toStrictEqual({
      ok: false,
      requestId: "r10",
      code: "unknown_command",
    });
  });

  it.each([
    ["no request id", { type: "ping", traceparent }, null],
    ["an empty request id", { type: "ping", requestId: "", traceparent }, null],
    ["a request id over 128 characters", { type: "ping", requestId: "r".repeat(129), traceparent }, null],
    ["a malformed traceparent", { type: "ping", requestId: "r1", traceparent: "00-xyz" }, "r1"],
    [
      "an all-zero trace id",
      { type: "ping", requestId: "r1", traceparent: `00-${"0".repeat(32)}-00f067aa0ba902b7-01` },
      "r1",
    ],
    ["an unexpected field", { type: "ping", requestId: "r1", traceparent, extra: 1 }, "r1"],
    ["a prompt without a session", { type: "prompt", requestId: "r1", traceparent, text: "hi" }, "r1"],
    ["an empty prompt", { type: "prompt", requestId: "r1", traceparent, sessionId: "s1", text: "" }, "r1"],
    [
      "more than 64 subscriptions",
      {
        type: "subscribe_sessions",
        requestId: "r1",
        traceparent,
        sessionIds: Array.from({ length: 65 }, (_, i) => `s${i}`),
      },
      "r1",
    ],
    [
      "an issue message over 4 KB",
      { type: "report_client_issue", requestId: "r1", traceparent, kind: "error", message: "x".repeat(4097) },
      "r1",
    ],
    [
      "an unknown issue kind",
      { type: "report_client_issue", requestId: "r1", traceparent, kind: "x", message: "" },
      "r1",
    ],
    ["a non-string type", { type: 3, requestId: "r1", traceparent }, "r1"],
  ])("calls a message with %s invalid", (_case, message, requestId) => {
    expect(parseClientMessage(message)).toStrictEqual({ ok: false, requestId, code: "invalid_message" });
  });

  it.each([
    ["undefined (not JSON)", undefined],
    ["null", null],
    ["a string", "ping"],
    ["an array", [{ type: "ping" }]],
  ])("calls %s invalid, without a request id", (_case, value) => {
    expect(parseClientMessage(value)).toStrictEqual({ ok: false, requestId: null, code: "invalid_message" });
  });
});

describe("ClientMessage", () => {
  it("covers the handshake and every command", () => {
    const hello = { type: "hello", protocolVersion: PROTOCOL_VERSION, clientId: "c1", token: "t", traceparent };

    for (const message of [hello, ...commands]) expect(ClientMessage.parse(message)).toStrictEqual(message);
  });
});

describe("CommandResult", () => {
  it("describes each command's result and rejects anything else", () => {
    expect(CommandResult.create_chat.parse({ sessionId: "s1" })).toStrictEqual({ sessionId: "s1" });
    expect(CommandResult.prompt.parse({ disposition: "handled" })).toStrictEqual({ disposition: "handled" });
    expect(CommandResult.ping.safeParse({ extra: 1 }).success).toBe(false);
    expect(CommandResult.prompt.safeParse({ disposition: "paused" }).success).toBe(false);
    expect(Object.keys(CommandResult).toSorted()).toStrictEqual([...COMMAND_TYPES].toSorted());
  });
});

describe("HostMessage", () => {
  it("accepts the welcome, both kinds of response and every session event", () => {
    const messages: unknown[] = [
      {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        hostVersion: "0.0.0",
        hostInstanceId: "h1",
        heartbeatMs: 15_000,
      },
      { type: "response", requestId: "r2", ok: true, result: { sessionId: "s1" } },
      { type: "response", requestId: "r1", ok: true },
      { type: "response", requestId: null, ok: false, error: { code: "invalid_message" } },
      {
        type: "response",
        requestId: "r4",
        ok: false,
        error: { code: "pi_unavailable", params: { status: "missing" } },
      },
      ...events,
    ];

    for (const message of messages) {
      expect(HostMessage.parse(JSON.parse(JSON.stringify(message)))).toStrictEqual(message);
    }
  });

  it("accepts every error code, stop reason, run outcome and exit reason", () => {
    const variants: unknown[] = [
      ...ErrorCode.options.map((code) => ({ type: "response", requestId: "r1", ok: false, error: { code } })),
      ...["stop", "length", "toolUse", "error", "aborted"].map((stopReason) => ({
        ...events[5],
        message: { ...(events[5] as { message: object }).message, stopReason },
      })),
      ...["completed", "stopped", "failed"].map((outcome) => ({ ...events[6], outcome })),
      ...["requested", "crashed"].map((reason) => ({ ...events[7], reason })),
    ];

    expect(ErrorCode.options).toStrictEqual([
      "invalid_message",
      "unknown_command",
      "session_not_found",
      "pi_unavailable",
      "internal_error",
    ]);
    for (const variant of variants) expect(HostMessage.parse(variant)).toStrictEqual(variant);
  });

  it.each([
    ["a trace id with a character in front", { ...events[1], traceId: `a${traceId}` }],
    ["a trace id with a character after it", { ...events[1], traceId: `${traceId}a` }],
    ["a successful response without a request id", { type: "response", requestId: null, ok: true }],
    ["an unknown error code", { type: "response", requestId: "r1", ok: false, error: { code: "oops" } }],
    [
      "an error parameter that is an object",
      { type: "response", requestId: "r1", ok: false, error: { code: "internal_error", params: { a: {} } } },
    ],
    ["a negative seq", { ...events[1], seq: -1 }],
    ["a fractional epoch", { ...events[1], epoch: 1.5 }],
    ["an uppercase trace id", { ...events[1], traceId: traceId.toUpperCase() }],
    ["a negative content index", { ...events[3], contentIndex: -1 }],
    [
      "an unknown stop reason",
      { ...events[5], message: { ...(events[5] as { message: object }).message, stopReason: "pending" } },
    ],
    ["an unknown run outcome", { ...events[6], outcome: "paused" }],
    ["an unknown event", { type: "tool_started", ...at }],
    ["a welcome without heartbeat", { type: "welcome", protocolVersion: 2, hostVersion: "0", hostInstanceId: "h1" }],
  ])("rejects %s", (_case, message) => {
    expect(HostMessage.safeParse(message).success).toBe(false);
  });
});
