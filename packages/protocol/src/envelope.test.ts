import { describe, expect, it } from "vitest";
import { COMMAND_TYPES, type Command, CommandResult } from "./commands";
import { CommandError, ErrorCode } from "./errors";
import { ClientMessage, HostMessage, parseClientMessage } from "./envelope";
import type { SessionEvent } from "./events";
import type { Step, Turn } from "./transcript";
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
  { type: "fetch_transcript", requestId: "r8", traceparent, sessionId: "s1", epoch: 2, before: "s1:e7", limit: 100 },
  { type: "list_recent_sessions", requestId: "r9", traceparent, limit: 50 },
  { type: "fetch_step", requestId: "r11", traceparent, sessionId: "s1", epoch: 1, turnId: "s1:e1", stepId: "12" },
  { type: "open_session", requestId: "r10", traceparent, sessionId: "019a-session" },
];

/** A finished command. */
const bashStep: Step = {
  kind: "tool",
  id: "2",
  callId: "call-1",
  tool: "bash",
  args: { command: "ls" },
  status: "done",
  output: "a.ts",
  details: { tool: "bash", command: "ls" },
  partial: false,
};

/** One step of every kind, and a tool step with every kind of details. */
const steps: Step[] = [
  { kind: "thinking", id: "0", text: "plan", durationMs: 1200 },
  { kind: "thinking", id: "1", text: "", durationMs: null },
  bashStep,
  {
    kind: "tool",
    id: "3",
    callId: "call-2",
    tool: "read",
    args: { path: "a.ts" },
    status: "failed",
    output: "…",
    details: { tool: "read", path: "a.ts", offset: 10, limit: null },
    partial: false,
  },
  {
    kind: "tool",
    id: "4",
    callId: "call-3",
    tool: "edit",
    args: {},
    status: "running",
    output: null,
    details: { tool: "edit", path: "a.ts", diff: "+1 x", added: 1, removed: 0 },
    partial: false,
  },
  {
    kind: "tool",
    id: "5",
    callId: "call-4",
    tool: "write",
    args: {},
    status: "unfinished",
    output: null,
    details: { tool: "write", path: "b.ts", content: "x" },
    partial: false,
  },
  {
    kind: "tool",
    id: "6",
    callId: "call-5",
    tool: "grep",
    args: {},
    status: "done",
    output: null,
    details: null,
    partial: true,
  },
  { kind: "steer", id: "7", text: "also b" },
  { kind: "retry", id: "8", attempt: 1, error: "503" },
  { kind: "text", id: "9", text: "done" },
];

/** A finished turn holding every kind of step. */
const turn: Turn = {
  kind: "turn",
  id: "s1:e1",
  user: { text: "hi", images: 1, clientMessageId: "r4", timestamp: 1 },
  steps,
  outcome: "done",
  error: null,
  startedAt: 1,
  durationMs: 2000,
  usage: { input: 10, output: 5 },
  changes: [
    { path: "a.ts", added: 1, removed: 0 },
    { path: "b.ts", added: null, removed: null },
  ],
};

/** Where an event sits in a session's stream. */
const at = { sessionId: "s1", epoch: 1, seq: 7, traceId };

/** One valid example of every session event. */
const events: SessionEvent[] = [
  {
    type: "session_snapshot",
    ...at,
    traceId: null,
    items: [
      turn,
      { kind: "notice", id: "s1:e9", notice: "compacted", tokensBefore: 152_000, summary: "so far", timestamp: 3 },
      { ...turn, id: "live-2", steps: [], outcome: "running", durationMs: null, usage: null, changes: [] },
    ],
    hasOlder: true,
    run: { runId: "run-1", startedAt: 3 },
    exited: false,
  },
  { type: "run_started", ...at, runId: "run-1", startedAt: 3 },
  { type: "turn_started", ...at, turn: { ...turn, steps: [], outcome: "running", durationMs: null, usage: null } },
  { type: "step_added", ...at, turnId: "s1:e1", step: { kind: "text", id: "0", text: "" } },
  { type: "step_delta", ...at, turnId: "s1:e1", stepId: "10", delta: "par" },
  { type: "step_updated", ...at, turnId: "s1:e1", step: bashStep },
  {
    type: "turn_finished",
    ...at,
    turnId: "s1:e1",
    outcome: "failed",
    error: "429 rate limited",
    durationMs: 4,
    usage: null,
    changes: [],
  },
  {
    type: "notice_added",
    ...at,
    notice: { kind: "notice", id: "s1:e9", notice: "compacted", tokensBefore: 0, summary: "", timestamp: 3 },
    before: "s1:e1",
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
      "fetch_step",
      "fetch_transcript",
      "list_recent_sessions",
      "open_session",
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
    ["no recent sessions asked for", { type: "list_recent_sessions", requestId: "r1", traceparent, limit: 0 }, "r1"],
    ["more than 50 recent sessions", { type: "list_recent_sessions", requestId: "r1", traceparent, limit: 51 }, "r1"],
    ["opening no session", { type: "open_session", requestId: "r1", traceparent }, "r1"],
    [
      "a step fetch without a step",
      { type: "fetch_step", requestId: "r1", traceparent, sessionId: "s1", epoch: 1, turnId: "t" },
      "r1",
    ],
    [
      "a fetch of no items",
      { type: "fetch_transcript", requestId: "r1", traceparent, sessionId: "s1", epoch: 1, before: "x", limit: 0 },
      "r1",
    ],
    [
      "a fetch of more than 100 items",
      { type: "fetch_transcript", requestId: "r1", traceparent, sessionId: "s1", epoch: 1, before: "x", limit: 101 },
      "r1",
    ],
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
    const recent = { sessionId: "s1", firstPrompt: null, modifiedAt: 5 };
    expect(CommandResult.list_recent_sessions.parse({ sessions: [recent] })).toStrictEqual({ sessions: [recent] });
    expect(CommandResult.list_recent_sessions.safeParse({ sessions: [{ ...recent, path: "/x" }] }).success).toBe(false);
    expect(CommandResult.open_session.parse({ sessionId: "s1" })).toStrictEqual({ sessionId: "s1" });
    expect(CommandResult.fetch_step.parse({ step: bashStep })).toStrictEqual({ step: bashStep });
    expect(CommandResult.fetch_transcript.parse({ items: [turn], hasOlder: false })).toStrictEqual({
      items: [turn],
      hasOlder: false,
    });
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

  it("accepts every error code, turn and run outcome and exit reason", () => {
    const variants: unknown[] = [
      ...ErrorCode.options.map((code) => ({ type: "response", requestId: "r1", ok: false, error: { code } })),
      ...["running", "done", "stopped", "failed"].map((outcome) => ({ ...events[2], turn: { ...turn, outcome } })),
      ...["done", "stopped", "failed"].map((outcome) => ({ ...events[6], outcome })),
      ...["completed", "stopped", "failed"].map((outcome) => ({ ...events[8], outcome })),
      ...["requested", "crashed"].map((reason) => ({ ...events[9], reason })),
    ];

    expect(ErrorCode.options).toStrictEqual([
      "invalid_message",
      "unknown_command",
      "session_not_found",
      "pi_unavailable",
      "session_busy",
      "transcript_changed",
      "session_cwd_missing",
      "pi_rejected",
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
    ["a turn that finishes still running", { ...events[6], outcome: "running" }],
    ["a finished turn without a duration", { ...events[6], durationMs: null }],
    ["a step without an id", { ...events[3], step: { kind: "text", id: "", text: "" } }],
    ["an unknown step kind", { ...events[3], step: { kind: "image", id: "0" } }],
    ["a retry numbered 0", { ...events[3], step: { kind: "retry", id: "0", attempt: 0, error: "" } }],
    ["an unknown tool status", { ...events[5], step: { ...bashStep, status: "queued" } }],
    ["details of an unknown tool", { ...events[5], step: { ...bashStep, details: { tool: "grep" } } }],
    ["a notice without where it goes", { ...events[7], before: undefined }],
    ["an unknown notice", { ...events[7], notice: { ...(events[7] as { notice: object }).notice, notice: "retried" } }],
    ["a snapshot with messages", { ...events[0], messages: [] }],
    ["an unknown run outcome", { ...events[8], outcome: "paused" }],
    ["an unknown event", { type: "message_started", ...at, messageId: "a1" }],
    ["a welcome without heartbeat", { type: "welcome", protocolVersion: 2, hostVersion: "0", hostInstanceId: "h1" }],
  ])("rejects %s", (_case, message) => {
    expect(HostMessage.safeParse(message).success).toBe(false);
  });
});

describe("CommandError", () => {
  it("names itself and its code, never user-facing text", () => {
    expect(new CommandError("session_busy", { a: 1 })).toMatchObject({
      name: "CommandError",
      message: "command failed: session_busy",
      code: "session_busy",
      params: { a: 1 },
    });
  });
});
