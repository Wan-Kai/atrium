import { describe, expect, it } from "vitest";
import { COMMAND_TYPES, type Command, CommandResult } from "./commands";
import { type Control, IDLE_CONTROL, type Interaction } from "./control";
import { CommandError, ErrorCode } from "./errors";
import { ClientMessage, HostMessage, parseClientMessage } from "./envelope";
import type { SessionEvent } from "./events";
import type { IndexSnapshotEvent } from "./listing";
import { type CatalogModel, ThinkingLevel } from "./models";
import type { Step, Turn } from "./transcript";
import { PROTOCOL_VERSION } from "./version";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const PROJECT = "prj_0123456789abcdef";
const WORKSPACE = "wks_0123456789abcdef";

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
  { type: "fetch_step", requestId: "r11", traceparent, sessionId: "s1", epoch: 1, turnId: "s1:e1", stepId: "12" },
  { type: "open_session", requestId: "r10", traceparent, sessionId: "019a-session" },
  { type: "subscribe_index", requestId: "r12", traceparent },
  { type: "add_project", requestId: "r13", traceparent, path: "/work/app" },
  { type: "remove_project", requestId: "r14", traceparent, projectId: PROJECT },
  { type: "rename_project", requestId: "r15", traceparent, projectId: PROJECT, name: "app" },
  { type: "rename_workspace", requestId: "r16", traceparent, workspaceId: WORKSPACE, name: "侧栏" },
  { type: "rename_workspace", requestId: "r17", traceparent, workspaceId: WORKSPACE, name: null },
  { type: "window_focused", requestId: "r18", traceparent },
  { type: "create_session", requestId: "r19", traceparent, workspaceId: WORKSPACE },
  { type: "close_tab", requestId: "r20", traceparent, sessionId: "s1" },
  { type: "select_container", requestId: "r21", traceparent, containerId: WORKSPACE },
  { type: "select_container", requestId: "r22", traceparent, containerId: "chats" },
  { type: "select_container", requestId: "r23", traceparent, containerId: null },
  { type: "archive_session", requestId: "r24", traceparent, sessionId: "s1" },
  { type: "rename_session", requestId: "r25", traceparent, sessionId: "s1", name: "重构" },
  { type: "set_preferences", requestId: "r26", traceparent, appearance: "dark" },
  { type: "set_preferences", requestId: "r27", traceparent, displayMode: "detailed" },
  { type: "steer", requestId: "r28", traceparent, sessionId: "s1", text: "also b" },
  { type: "stop", requestId: "r29", traceparent, sessionId: "s1" },
  { type: "resume_queue", requestId: "r30", traceparent, sessionId: "s1" },
  { type: "clear_queue", requestId: "r31", traceparent, sessionId: "s1" },
  { type: "update_queued", requestId: "r32", traceparent, sessionId: "s1", itemId: "q1", text: "later" },
  { type: "remove_queued", requestId: "r33", traceparent, sessionId: "s1", itemId: "q1" },
  { type: "steer_queued", requestId: "r34", traceparent, sessionId: "s1", itemId: "q1" },
  {
    type: "answer_interaction",
    requestId: "r35",
    traceparent,
    sessionId: "s1",
    interactionId: "d1",
    answer: { value: "b" },
  },
  {
    type: "answer_interaction",
    requestId: "r36",
    traceparent,
    sessionId: "s1",
    interactionId: "d1",
    answer: { confirmed: false },
  },
  {
    type: "answer_interaction",
    requestId: "r37",
    traceparent,
    sessionId: "s1",
    interactionId: "d1",
    answer: { cancelled: true },
  },
  { type: "retry_run", requestId: "r38", traceparent, sessionId: "s1" },
  {
    type: "answer_interaction",
    requestId: "r39",
    traceparent,
    sessionId: "s1",
    interactionId: "d1",
    answer: { value: "v".repeat(1024 * 1024) },
  },
  { type: "list_models", requestId: "r40", traceparent, containerId: WORKSPACE },
  { type: "list_models", requestId: "r41", traceparent, containerId: "chats", refresh: true },
  {
    type: "set_model",
    requestId: "r42",
    traceparent,
    sessionId: "s1",
    providerId: "openrouter",
    modelId: "anthropic/claude-opus-5.5",
  },
  { type: "set_thinking_level", requestId: "r43", traceparent, sessionId: "s1", level: "xhigh" },
  { type: "list_commands", requestId: "r44", traceparent, sessionId: "s1" },
  { type: "search_files", requestId: "r45", traceparent, sessionId: "s1", query: "src/ses" },
  { type: "search_files", requestId: "r46", traceparent, sessionId: "s1", query: "" },
  { type: "upload_attachment", requestId: "r47", traceparent, mimeType: "image/webp", data: "UklGRg==" },
  { type: "prompt", requestId: "r48", traceparent, sessionId: "s1", text: "看图", attachmentIds: ["a1", "a2"] },
  { type: "prompt", requestId: "r49", traceparent, sessionId: "s1", text: "", attachmentIds: ["a1"] },
  { type: "steer", requestId: "r50", traceparent, sessionId: "s1", text: "这张", attachmentIds: ["a3"] },
  { type: "upload_attachment", requestId: "r51", traceparent, mimeType: "image/png", data: "a".repeat(1_000_000) },
];

/** A model as the catalog lists it. */
const model: CatalogModel = {
  providerId: "anthropic",
  modelId: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  contextWindow: 1_000_000,
  maxOutput: 128_000,
  supportsImage: true,
  thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

/** An extension's selection. */
const pick: Interaction = {
  id: "d1",
  kind: "select",
  title: "Pick",
  message: null,
  options: ["a", "b"],
  placeholder: null,
  prefill: null,
  deadline: 9,
};

/** Run control with something of everything. */
const control: Control = {
  queue: [{ id: "q1", text: "later", createdAt: 4, images: 2 }],
  paused: "stopped",
  steers: [{ id: "r28", text: "also b" }],
  stopping: true,
  restarting: false,
  interactions: [pick],
  failure: { reason: "crashed", attempts: 3 },
};

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
  { kind: "retry", id: "8", attempt: 1, maxAttempts: 3, error: "503" },
  { kind: "text", id: "9", text: "done" },
];

/** A finished turn holding every kind of step. */
const turn: Turn = {
  kind: "turn",
  id: "s1:e1",
  user: { text: "hi", images: 1, clientMessageId: "r4", auto: false, timestamp: 1 },
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
/** How an extension's question ended. */
const asked = {
  kind: "notice",
  id: "ask-1",
  notice: "interaction",
  title: "用哪个？",
  outcome: "answered",
  value: "vitest",
  confirmed: null,
  timestamp: 5,
} as const;

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
    control,
    model: { providerId: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" },
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
  { type: "control_updated", ...at, control: IDLE_CONTROL },
  { type: "prompt_handled", ...at, clientMessageId: "r4" },
  {
    type: "notice_added",
    ...at,
    notice: { kind: "notice", id: "restart-1", notice: "restarted", attempt: 2, timestamp: 4 },
    before: null,
  },
  { type: "notice_added", ...at, notice: asked, before: null },
  { type: "model_updated", ...at, model: { providerId: "faux", modelId: "faux-1", thinkingLevel: "off" } },
  { type: "model_updated", ...at, model: null },
];

describe("parseClientMessage", () => {
  it("accepts every command as it is sent over the wire", () => {
    for (const command of commands) {
      expect(parseClientMessage(JSON.parse(JSON.stringify(command)))).toStrictEqual({ ok: true, command });
    }
  });

  it("knows exactly the commands it accepts", () => {
    expect([...COMMAND_TYPES].toSorted()).toStrictEqual([
      "add_project",
      "answer_interaction",
      "archive_session",
      "clear_queue",
      "close_tab",
      "create_chat",
      "create_session",
      "fetch_step",
      "fetch_transcript",
      "list_commands",
      "list_models",
      "open_session",
      "ping",
      "prompt",
      "remove_project",
      "remove_queued",
      "rename_project",
      "rename_session",
      "rename_workspace",
      "report_client_issue",
      "resume_queue",
      "retry_run",
      "search_files",
      "select_container",
      "set_model",
      "set_preferences",
      "set_thinking_level",
      "steer",
      "steer_queued",
      "stop",
      "subscribe_index",
      "subscribe_sessions",
      "update_queued",
      "upload_attachment",
      "window_focused",
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
    ["a project id of another shape", { type: "remove_project", requestId: "r1", traceparent, projectId: "p1" }, "r1"],
    [
      "a project id where a workspace id belongs",
      { type: "create_session", requestId: "r1", traceparent, workspaceId: PROJECT },
      "r1",
    ],
    [
      "a workspace id with something before it",
      { type: "create_session", requestId: "r1", traceparent, workspaceId: `x${WORKSPACE}` },
      "r1",
    ],
    [
      "a workspace id with something after it",
      { type: "create_session", requestId: "r1", traceparent, workspaceId: `${WORKSPACE}0` },
      "r1",
    ],
    ["an empty project path", { type: "add_project", requestId: "r1", traceparent, path: "" }, "r1"],
    ["an empty steer", { type: "steer", requestId: "r1", traceparent, sessionId: "s1", text: "" }, "r1"],
    [
      "an empty queued message",
      { type: "update_queued", requestId: "r1", traceparent, sessionId: "s1", itemId: "q1", text: "" },
      "r1",
    ],
    [
      "an answer that keeps the dialog open",
      {
        type: "answer_interaction",
        requestId: "r1",
        traceparent,
        sessionId: "s1",
        interactionId: "d1",
        answer: { cancelled: false },
      },
      "r1",
    ],
    [
      "an answer of two kinds at once",
      {
        type: "answer_interaction",
        requestId: "r1",
        traceparent,
        sessionId: "s1",
        interactionId: "d1",
        answer: { value: "a", confirmed: true },
      },
      "r1",
    ],
    [
      "a blank project name",
      { type: "rename_project", requestId: "r1", traceparent, projectId: PROJECT, name: "  " },
      "r1",
    ],
    [
      "a project id with something in front",
      { type: "rename_project", requestId: "r1", traceparent, projectId: `x${PROJECT}`, name: "n" },
      "r1",
    ],
    [
      "a project id with something after",
      { type: "rename_project", requestId: "r1", traceparent, projectId: `${PROJECT}0`, name: "n" },
      "r1",
    ],
    [
      "an answer over 1 MiB",
      {
        type: "answer_interaction",
        requestId: "r1",
        traceparent,
        sessionId: "s1",
        interactionId: "d1",
        answer: { value: "v".repeat(1024 * 1024 + 1) },
      },
      "r1",
    ],
    [
      "a project name over 256 characters",
      { type: "rename_project", requestId: "r1", traceparent, projectId: PROJECT, name: "n".repeat(257) },
      "r1",
    ],
    ["an unknown container", { type: "select_container", requestId: "r1", traceparent, containerId: "inbox" }, "r1"],
    ["an unknown appearance", { type: "set_preferences", requestId: "r1", traceparent, appearance: "sepia" }, "r1"],
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
    [
      "an unknown thinking level",
      { type: "set_thinking_level", requestId: "r1", traceparent, sessionId: "s1", level: "extreme" },
      "r1",
    ],
    [
      "a model without a provider",
      { type: "set_model", requestId: "r1", traceparent, sessionId: "s1", providerId: "", modelId: "m" },
      "r1",
    ],
    ["models of no container", { type: "list_models", requestId: "r1", traceparent }, "r1"],
    ["commands of no session", { type: "list_commands", requestId: "r1", traceparent }, "r1"],
    [
      "an attachment that is not an image",
      { type: "upload_attachment", requestId: "r1", traceparent, mimeType: "text/plain", data: "aGk=" },
      "r1",
    ],
    [
      "an attachment over a million characters",
      { type: "upload_attachment", requestId: "r1", traceparent, mimeType: "image/png", data: "a".repeat(1_000_001) },
      "r1",
    ],
    [
      "an empty attachment",
      { type: "upload_attachment", requestId: "r1", traceparent, mimeType: "image/png", data: "" },
      "r1",
    ],
    [
      "more than 20 images",
      {
        type: "prompt",
        requestId: "r1",
        traceparent,
        sessionId: "s1",
        text: "x",
        attachmentIds: Array.from({ length: 21 }, (_, index) => `a${index}`),
      },
      "r1",
    ],
    [
      "a file search over 1024 characters",
      { type: "search_files", requestId: "r1", traceparent, sessionId: "s1", query: "q".repeat(1025) },
      "r1",
    ],
    ["models of a project", { type: "list_models", requestId: "r1", traceparent, containerId: PROJECT }, "r1"],
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
    expect(CommandResult.prompt.parse({ disposition: "queued", itemId: "q1" })).toStrictEqual({
      disposition: "queued",
      itemId: "q1",
    });
    expect(CommandResult.prompt.safeParse({ disposition: "queued" }).success).toBe(false);
    expect(CommandResult.prompt.safeParse({ disposition: "started", itemId: "q1" }).success).toBe(false);
    expect(CommandResult.steer.parse({ disposition: "queued" })).toStrictEqual({ disposition: "queued" });
    expect(CommandResult.stop.parse({ confirmed: false })).toStrictEqual({ confirmed: false });
    expect(CommandResult.stop.safeParse({}).success).toBe(false);
    expect(CommandResult.open_session.parse({})).toStrictEqual({});
    expect(CommandResult.add_project.parse({ projectId: PROJECT })).toStrictEqual({ projectId: PROJECT });
    expect(CommandResult.add_project.safeParse({ projectId: "p1" }).success).toBe(false);
    expect(CommandResult.create_session.parse({ sessionId: "s1" })).toStrictEqual({ sessionId: "s1" });
    expect(CommandResult.fetch_step.parse({ step: bashStep })).toStrictEqual({ step: bashStep });
    expect(CommandResult.fetch_transcript.parse({ items: [turn], hasOlder: false })).toStrictEqual({
      items: [turn],
      hasOlder: false,
    });
    expect(CommandResult.list_models.parse({ models: [model], defaultModel: null })).toStrictEqual({
      models: [model],
      defaultModel: null,
    });
    expect(
      CommandResult.list_models.parse({ models: [], defaultModel: { providerId: "faux", modelId: "faux-1" } }),
    ).toStrictEqual({ models: [], defaultModel: { providerId: "faux", modelId: "faux-1" } });
    expect(
      CommandResult.list_models.safeParse({ models: [{ ...model, thinkingLevels: [] }], defaultModel: null }).success,
    ).toBe(false);
    expect(
      CommandResult.list_models.safeParse({ models: [{ ...model, contextWindow: -1 }], defaultModel: null }).success,
    ).toBe(false);
    const slashCommands = [
      { name: "review", description: "Reviews the change", source: "prompt" },
      { name: "skill:tdd", description: null, source: "skill" },
      { name: "mcp", description: "MCP servers", source: "extension" },
    ];
    expect(CommandResult.list_commands.parse({ commands: slashCommands })).toStrictEqual({ commands: slashCommands });
    expect(
      CommandResult.list_commands.safeParse({ commands: [{ name: "x", description: null, source: "builtin" }] })
        .success,
    ).toBe(false);
    const files = [
      { path: "src/sessions/", directory: true },
      { path: "src/session.ts", directory: false },
    ];
    expect(CommandResult.search_files.parse({ files })).toStrictEqual({ files });
    expect(CommandResult.search_files.safeParse({ files: [{ path: "", directory: false }] }).success).toBe(false);
    expect(CommandResult.upload_attachment.parse({ attachmentId: "a1" })).toStrictEqual({ attachmentId: "a1" });
    expect(CommandResult.upload_attachment.safeParse({}).success).toBe(false);
    expect(CommandResult.set_model.parse({})).toStrictEqual({});
    expect(CommandResult.set_thinking_level.parse({})).toStrictEqual({});
    expect(Object.keys(CommandResult).toSorted()).toStrictEqual([...COMMAND_TYPES].toSorted());
  });
});

/** A list with one of everything. */
const snapshot: IndexSnapshotEvent = {
  type: "index_snapshot",
  generation: "h1",
  seq: 3,
  projects: [{ id: PROJECT, path: "/work/app", name: "app" }],
  workspaces: [
    {
      id: WORKSPACE,
      projectId: PROJECT,
      kind: "local",
      dir: "/work/app",
      alias: null,
      branch: "main",
      head: null,
      external: false,
      createdAt: null,
      merge: null,
    },
    {
      id: "wks_fedcba9876543210",
      projectId: PROJECT,
      kind: "worktree",
      dir: "/work/app-sidebar",
      alias: "侧栏",
      branch: null,
      head: "1a2b3c4",
      external: true,
      createdAt: 1_700_000_000_000,
      merge: { dirty: true, ahead: 3, verdict: "unknown", reason: "no_main_branch" },
    },
  ],
  sessions: [
    {
      sessionId: "s1",
      containerId: WORKSPACE,
      name: null,
      prompt: "重构宿主进程管理",
      file: "/pi/sessions/s1.jsonl",
      state: "persisted",
      updatedAt: 5,
      archived: false,
      running: true,
      failed: false,
    },
    {
      sessionId: "s2",
      containerId: "chats",
      name: "解释 merge-tree",
      prompt: null,
      file: null,
      state: "draft",
      updatedAt: 6,
      archived: true,
      running: false,
      failed: true,
    },
  ],
  layout: {
    container: WORKSPACE,
    tabs: { [WORKSPACE]: { open: ["s1"], active: "s1" }, chats: { open: [], active: null } },
  },
  preferences: {
    appearance: "system",
    displayMode: "summary",
    lastModel: { providerId: "anthropic", modelId: "claude-opus-5-5" },
    thinkingByModel: { "anthropic/claude-opus-5-5": "high", "faux/faux-1": "off" },
  },
  resets: ["layouts"],
};

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
      snapshot,
    ];

    for (const message of messages) {
      expect(HostMessage.parse(JSON.parse(JSON.stringify(message)))).toStrictEqual(message);
    }
  });

  it("accepts every error code, turn and run outcome, exit reason and list variant", () => {
    const [local, worktree] = snapshot.workspaces;
    const [session] = snapshot.sessions;
    const variants: unknown[] = [
      ...["noChange", "pending", "merged", "removed"].map((verdict) => ({
        ...snapshot,
        workspaces: [{ ...worktree, merge: { dirty: false, ahead: 0, verdict, reason: null } }],
      })),
      ...["git_too_old", "git_failed", "base_unknown"].map((reason) => ({
        ...snapshot,
        workspaces: [{ ...worktree, merge: { dirty: false, ahead: 0, verdict: "unknown", reason } }],
      })),
      ...["missing"].map((state) => ({ ...snapshot, sessions: [{ ...session, state }] })),
      ...["light", "dark"].map((appearance) => ({ ...snapshot, preferences: { ...snapshot.preferences, appearance } })),
      ...["thinking", "detailed"].map((displayMode) => ({
        ...snapshot,
        preferences: { ...snapshot.preferences, displayMode },
      })),
      { ...snapshot, layout: { container: null, tabs: {} }, resets: ["projects", "sessions", "preferences"] },
      { ...snapshot, preferences: { ...snapshot.preferences, lastModel: null, thinkingByModel: {} } },
      ...ThinkingLevel.options.map((thinkingLevel) => ({
        type: "model_updated",
        ...at,
        model: { providerId: "faux", modelId: "faux-1", thinkingLevel },
      })),
      { ...snapshot, workspaces: [local] },
      ...ErrorCode.options.map((code) => ({ type: "response", requestId: "r1", ok: false, error: { code } })),
      ...["running", "done", "stopped", "failed"].map((outcome) => ({ ...events[2], turn: { ...turn, outcome } })),
      ...["done", "stopped", "failed"].map((outcome) => ({ ...events[6], outcome })),
      ...["completed", "stopped", "failed"].map((outcome) => ({ ...events[8], outcome })),
      ...["requested", "crashed"].map((reason) => ({ ...events[9], reason })),
      {
        type: "control_updated",
        ...at,
        control: {
          ...control,
          paused: "crashed",
          interactions: (["select", "confirm", "input", "editor"] as const).map((kind) => ({
            ...pick,
            id: kind,
            kind,
          })),
        },
      },
      ...["answered", "cancelled", "timed_out", "stale"].map((outcome) => ({
        type: "notice_added",
        ...at,
        notice: { ...asked, outcome },
        before: null,
      })),
    ];

    expect(ErrorCode.options).toStrictEqual([
      "invalid_message",
      "unknown_command",
      "session_not_found",
      "pi_unavailable",
      "session_busy",
      "transcript_changed",
      "session_cwd_missing",
      "project_not_found",
      "workspace_not_found",
      "project_exists",
      "name_taken",
      "path_not_found",
      "session_is_draft",
      "session_stopping",
      "queue_item_not_found",
      "interaction_closed",
      "models_unavailable",
      "fd_missing",
      "attachment_limit",
      "attachment_missing",
      "pi_rejected",
      "internal_error",
    ]);
    expect(ThinkingLevel.options).toStrictEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
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
    ["a workspace of an unknown kind", { ...snapshot, workspaces: [{ ...snapshot.workspaces[0], kind: "clone" }] }],
    [
      "an unknown merge verdict",
      {
        ...snapshot,
        workspaces: [
          { ...snapshot.workspaces[1], merge: { dirty: false, ahead: 0, verdict: "rebased", reason: null } },
        ],
      },
    ],
    [
      "a negative ahead count",
      {
        ...snapshot,
        workspaces: [
          { ...snapshot.workspaces[1], merge: { dirty: false, ahead: -1, verdict: "pending", reason: null } },
        ],
      },
    ],
    ["an unknown session state", { ...snapshot, sessions: [{ ...snapshot.sessions[0], state: "closed" }] }],
    [
      "a session prompt over 200 characters",
      { ...snapshot, sessions: [{ ...snapshot.sessions[0], prompt: "x".repeat(201) }] },
    ],
    [
      "a session in an unknown container",
      { ...snapshot, sessions: [{ ...snapshot.sessions[0], containerId: "inbox" }] },
    ],
    [
      "tabs of an unknown container",
      { ...snapshot, layout: { container: null, tabs: { inbox: { open: [], active: null } } } },
    ],
    ["an unknown reset file", { ...snapshot, resets: ["turns"] }],
    ["a snapshot without preferences", { ...snapshot, preferences: undefined }],
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
