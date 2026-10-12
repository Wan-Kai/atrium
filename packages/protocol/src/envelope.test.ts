import { describe, expect, it } from "vitest";
import { COMMAND_TYPES, type Command, CommandResult } from "./commands";
import { type Control, IDLE_CONTROL, type Interaction } from "./control";
import { CommandError, ErrorCode } from "./errors";
import { ClientMessage, HostMessage, parseClientMessage } from "./envelope";
import type { SessionEvent } from "./events";
import type { IndexChangesEvent, IndexSnapshotEvent } from "./listing";
import { type CatalogModel, ThinkingLevel } from "./models";
import type { Step, Turn } from "./transcript";
import { isChatId } from "./ids";
import { PROTOCOL_VERSION } from "./version";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const PROJECT = "prj_0123456789abcdef";
const WORKSPACE = "wks_0123456789abcdef";
const CHAT = "cht_0f3c2a1e-5b6d-4c7e-8f90-123456789abc";

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
  { type: "subscribe_index", requestId: "r12b", traceparent, cursor: { generation: "h1", seq: 7 } },
  { type: "add_project", requestId: "r13", traceparent, path: "/work/app" },
  { type: "remove_project", requestId: "r14", traceparent, projectId: PROJECT },
  { type: "rename_project", requestId: "r15", traceparent, projectId: PROJECT, name: "app" },
  { type: "rename_workspace", requestId: "r16", traceparent, workspaceId: WORKSPACE, name: "侧栏" },
  { type: "rename_workspace", requestId: "r17", traceparent, workspaceId: WORKSPACE, name: null },
  { type: "window_focused", requestId: "r18", traceparent },
  { type: "create_session", requestId: "r19", traceparent, containerId: WORKSPACE },
  { type: "create_session", requestId: "r19", traceparent, containerId: CHAT },
  { type: "rename_chat", requestId: "r19", traceparent, chatId: CHAT, name: "合并原理" },
  { type: "rename_chat", requestId: "r19", traceparent, chatId: CHAT, name: null },
  { type: "close_tab", requestId: "r20", traceparent, sessionId: "s1" },
  { type: "select_container", requestId: "r21", traceparent, containerId: WORKSPACE },
  { type: "select_container", requestId: "r22", traceparent, containerId: CHAT },
  { type: "select_container", requestId: "r23", traceparent, containerId: null },
  { type: "archive_session", requestId: "r24", traceparent, sessionId: "s1" },
  { type: "clear_attention", requestId: "r24a", traceparent, sessionId: "s1" },
  { type: "hand_off", requestId: "r24b", traceparent, sessionId: "s1" },
  { type: "take_back", requestId: "r24c", traceparent, sessionId: "s1" },
  { type: "rename_session", requestId: "r25", traceparent, sessionId: "s1", name: "重构" },
  { type: "set_preferences", requestId: "r26", traceparent, appearance: "dark" },
  { type: "set_preferences", requestId: "r27", traceparent, displayMode: "detailed" },
  { type: "set_preferences", requestId: "r60", traceparent, statusBar: { session: false, cost: true } },
  {
    type: "set_preferences",
    requestId: "r63",
    traceparent,
    setupDone: true,
    titleModel: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
  },
  { type: "set_preferences", requestId: "r64", traceparent, titleModel: null },
  {
    type: "set_preferences",
    requestId: "r65",
    traceparent,
    proxy: { url: "http://127.0.0.1:7897", noProxy: [".example.com", "b".repeat(255)] },
  },
  { type: "set_preferences", requestId: "r66", traceparent, proxy: null },
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
  { type: "list_models", requestId: "r40", traceparent, workspaceId: WORKSPACE },
  { type: "list_models", requestId: "r41", traceparent, workspaceId: null, refresh: true },
  {
    type: "set_model",
    requestId: "r42",
    traceparent,
    sessionId: "s1",
    providerId: "openrouter",
    modelId: "anthropic/claude-opus-5.5",
  },
  { type: "set_thinking_level", requestId: "r43", traceparent, sessionId: "s1", level: "xhigh" },
  { type: "set_fast", requestId: "r43", traceparent, sessionId: "s1", enabled: true },
  { type: "list_commands", requestId: "r44", traceparent, sessionId: "s1" },
  { type: "search_files", requestId: "r45", traceparent, sessionId: "s1", query: "src/ses" },
  { type: "search_files", requestId: "r46", traceparent, sessionId: "s1", query: "" },
  { type: "upload_attachment", requestId: "r47", traceparent, mimeType: "image/webp", data: "UklGRg==" },
  { type: "prompt", requestId: "r48", traceparent, sessionId: "s1", text: "看图", attachmentIds: ["a1", "a2"] },
  { type: "prompt", requestId: "r49", traceparent, sessionId: "s1", text: "", attachmentIds: ["a1"] },
  { type: "steer", requestId: "r50", traceparent, sessionId: "s1", text: "这张", attachmentIds: ["a3"] },
  { type: "upload_attachment", requestId: "r51", traceparent, mimeType: "image/png", data: "a".repeat(1_000_000) },
  { type: "upload_attachment", requestId: "r57", traceparent, mimeType: "image/jpeg", data: "/9j/" },
  { type: "upload_attachment", requestId: "r58", traceparent, mimeType: "image/gif", data: "R0lG" },
  { type: "watch_changes", requestId: "r52", traceparent, workspaceIds: [WORKSPACE] },
  { type: "watch_changes", requestId: "r53", traceparent, workspaceIds: [] },
  { type: "watch_diff", requestId: "r54", traceparent, target: { workspaceId: WORKSPACE, mode: "uncommitted" } },
  { type: "watch_diff", requestId: "r55", traceparent, target: { workspaceId: WORKSPACE, mode: "base" } },
  { type: "watch_diff", requestId: "r56", traceparent, target: null },
  { type: "check_setup", requestId: "r61", traceparent },
  { type: "check_setup", requestId: "r62", traceparent, refresh: true },
  { type: "login", requestId: "r65", traceparent, providerId: "anthropic", method: "oauth" },
  { type: "login", requestId: "r66", traceparent, providerId: "deepseek", method: "api_key", key: "sk-test" },
  { type: "answer_login", requestId: "r67", traceparent, loginId: "l1", promptId: 0, value: "code#state" },
  { type: "cancel_login", requestId: "r68", traceparent, loginId: "l1" },
  { type: "logout", requestId: "r69", traceparent, providerId: "anthropic" },
  { type: "install_pi", requestId: "r70", traceparent },
  { type: "install_node", requestId: "r71", traceparent },
  { type: "update_pi", requestId: "r72", traceparent },
  { type: "cancel_install", requestId: "r73", traceparent, jobId: "j1" },
  { type: "check_pi_update", requestId: "r74", traceparent },
  { type: "discover_projects", requestId: "r75", traceparent },
  { type: "list_branches", requestId: "r76", traceparent, projectId: PROJECT },
  { type: "set_main_branch", requestId: "r77", traceparent, projectId: PROJECT, branch: "release/1.0" },
  { type: "set_main_branch", requestId: "r78", traceparent, projectId: PROJECT, branch: null },
];

/** An update waiting for two sessions to finish. */
const installUpdated = {
  type: "install_updated",
  jobId: "j1",
  kind: "update_pi",
  state: "waiting",
  running: 2,
  exitCode: null,
  reason: null,
};

/** A login under way with everything pi can show. */
const loginUpdated = {
  type: "login_updated",
  loginId: "l1",
  providerId: "anthropic",
  method: "oauth",
  state: "running",
  authUrl: { url: "https://claude.ai/oauth/authorize?code=true", instructions: "Paste the code" },
  deviceCode: { userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresInSeconds: 900 },
  questions: [
    { promptId: 2, kind: "manual_code", message: "Paste the authorization code:", placeholder: null, options: [] },
    {
      promptId: 3,
      kind: "select",
      message: "Region",
      placeholder: null,
      options: [{ id: "us", label: "United States" }],
    },
  ],
  progress: "Waiting for the browser…",
  error: null,
};

/** A workspace's changes, as the host sends them. */
const changesUpdated = {
  type: "changes_updated",
  workspaceId: WORKSPACE,
  stat: { added: 12, removed: 3 },
  dirty: true,
  ahead: 2,
  branch: "feat/x",
  base: "origin/main",
};

/** The changes panel's files: an edit, a rename, a binary file and one too large. */
const diffUpdated = {
  type: "diff_updated",
  workspaceId: WORKSPACE,
  mode: "uncommitted",
  files: [
    {
      path: "src/a.ts",
      oldPath: null,
      status: "modified",
      added: 1,
      removed: 1,
      content: "text",
      hunks: [
        {
          oldStart: 1,
          oldCount: 2,
          newStart: 1,
          newCount: 2,
          lines: [
            { kind: "context", oldNumber: 1, newNumber: 1, text: "keep" },
            { kind: "del", oldNumber: 2, newNumber: null, text: "old" },
            { kind: "add", oldNumber: null, newNumber: 2, text: "new" },
          ],
        },
      ],
    },
    { path: "b.ts", oldPath: "a.ts", status: "renamed", added: 0, removed: 0, content: "text", hunks: [] },
    { path: "logo.png", oldPath: null, status: "added", added: 0, removed: 0, content: "binary", hunks: [] },
    { path: "big.json", oldPath: null, status: "deleted", added: 0, removed: 90_000, content: "too_large", hunks: [] },
  ],
  tooLarge: false,
  error: null,
};

/** A model as the catalog lists it. */
const model: CatalogModel = {
  providerId: "anthropic",
  modelId: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  contextWindow: 1_000_000,
  maxOutput: 128_000,
  supportsImage: true,
  thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  fastCredits: null,
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

/** A session's status bar figures with every one known (SPEC-0001, "状态栏（M1.8）"). */
const metrics = {
  turns: 3,
  steps: 7,
  tokens: { input: 1200, output: 340, cacheRead: 9000, cacheWrite: 500 },
  cost: 0.45,
  reasoning: 120,
  branchTokens: 8000,
  context: { tokens: 84_000, window: 200_000, system: 3000, tools: 2500 },
  timing: { modelMs: 4200, ttftMs: 800, tps: 48.5 },
} as const;

/** The same figures with none known yet. */
const unknownMetrics = {
  turns: null,
  steps: null,
  tokens: null,
  cost: null,
  reasoning: null,
  branchTokens: 0,
  context: null,
  timing: null,
} as const;

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
    fast: true,
    metrics,
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
  { type: "fast_updated", ...at, fast: false },
  { type: "metrics_updated", ...at, traceId: null, metrics },
  { type: "metrics_updated", ...at, metrics: unknownMetrics },
  {
    type: "metrics_updated",
    ...at,
    metrics: {
      ...metrics,
      reasoning: null,
      context: { tokens: null, window: 200_000, system: null, tools: null },
      timing: { modelMs: 0, ttftMs: null, tps: null },
    },
  },
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
      "answer_login",
      "archive_session",
      "cancel_install",
      "cancel_login",
      "check_pi_update",
      "check_setup",
      "clear_attention",
      "clear_queue",
      "close_tab",
      "create_chat",
      "create_session",
      "discover_projects",
      "fetch_step",
      "fetch_transcript",
      "hand_off",
      "install_node",
      "install_pi",
      "list_branches",
      "list_commands",
      "list_models",
      "login",
      "logout",
      "open_session",
      "ping",
      "prompt",
      "remove_project",
      "remove_queued",
      "rename_chat",
      "rename_project",
      "rename_session",
      "rename_workspace",
      "report_client_issue",
      "resume_queue",
      "retry_run",
      "search_files",
      "select_container",
      "set_fast",
      "set_main_branch",
      "set_model",
      "set_preferences",
      "set_thinking_level",
      "steer",
      "steer_queued",
      "stop",
      "subscribe_index",
      "subscribe_sessions",
      "take_back",
      "update_pi",
      "update_queued",
      "upload_attachment",
      "watch_changes",
      "watch_diff",
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
      { type: "create_session", requestId: "r1", traceparent, containerId: PROJECT },
      "r1",
    ],
    [
      "a workspace id with something before it",
      { type: "create_session", requestId: "r1", traceparent, containerId: `x${WORKSPACE}` },
      "r1",
    ],
    [
      "a workspace id with something after it",
      { type: "create_session", requestId: "r1", traceparent, containerId: `${WORKSPACE}0` },
      "r1",
    ],
    ["the old chats' container", { type: "create_session", requestId: "r1", traceparent, containerId: "chats" }, "r1"],
    [
      "a chat id with a path in it",
      { type: "rename_chat", requestId: "r1", traceparent, chatId: "cht_../x", name: null },
      "r1",
    ],
    [
      "a chat id with something before it",
      { type: "rename_chat", requestId: "r1", traceparent, chatId: "x/cht_a", name: null },
      "r1",
    ],
    [
      "a chat id over 68 characters",
      { type: "rename_chat", requestId: "r1", traceparent, chatId: `cht_${"a".repeat(65)}`, name: null },
      "r1",
    ],
    [
      "a workspace id where a chat id belongs",
      { type: "rename_chat", requestId: "r1", traceparent, chatId: WORKSPACE, name: null },
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
      "an empty main branch",
      { type: "set_main_branch", requestId: "r1", traceparent, projectId: PROJECT, branch: "" },
      "r1",
    ],
    [
      "a main branch over 1024 characters",
      { type: "set_main_branch", requestId: "r1", traceparent, projectId: PROJECT, branch: "b".repeat(1025) },
      "r1",
    ],
    [
      "a project name over 256 characters",
      { type: "rename_project", requestId: "r1", traceparent, projectId: PROJECT, name: "n".repeat(257) },
      "r1",
    ],
    ["an unknown container", { type: "select_container", requestId: "r1", traceparent, containerId: "inbox" }, "r1"],
    ["an unknown appearance", { type: "set_preferences", requestId: "r1", traceparent, appearance: "sepia" }, "r1"],
    [
      "a status bar group id over 64 characters",
      { type: "set_preferences", requestId: "r1", traceparent, statusBar: { ["g".repeat(65)]: true } },
      "r1",
    ],
    [
      "a proxy address over 2048 characters",
      { type: "set_preferences", requestId: "r1", traceparent, proxy: { url: "h".repeat(2049), noProxy: [] } },
      "r1",
    ],
    [
      "a host that goes direct over 255 characters",
      { type: "set_preferences", requestId: "r1", traceparent, proxy: { url: "http://p", noProxy: ["h".repeat(256)] } },
      "r1",
    ],
    [
      "more than 100 hosts that go direct",
      {
        type: "set_preferences",
        requestId: "r1",
        traceparent,
        proxy: { url: "http://p", noProxy: Array.from({ length: 101 }, () => "h") },
      },
      "r1",
    ],
    [
      "a proxy without the hosts that go direct",
      { type: "set_preferences", requestId: "r1", traceparent, proxy: { url: "http://p" } },
      "r1",
    ],
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
      "Fast neither on nor off",
      { type: "set_fast", requestId: "r1", traceparent, sessionId: "s1", enabled: "on" },
      "r1",
    ],
    [
      "a model without a provider",
      { type: "set_model", requestId: "r1", traceparent, sessionId: "s1", providerId: "", modelId: "m" },
      "r1",
    ],
    ["models of nowhere said", { type: "list_models", requestId: "r1", traceparent }, "r1"],
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
    ["models of a project", { type: "list_models", requestId: "r1", traceparent, workspaceId: PROJECT }, "r1"],
    ["models of a chat", { type: "list_models", requestId: "r1", traceparent, workspaceId: CHAT }, "r1"],
    ["changes of a chat", { type: "watch_changes", requestId: "r1", traceparent, workspaceIds: [CHAT] }, "r1"],
    [
      "changes of more than 64 workspaces",
      {
        type: "watch_changes",
        requestId: "r1",
        traceparent,
        workspaceIds: Array.from({ length: 65 }, () => WORKSPACE),
      },
      "r1",
    ],
    [
      "a diff of an unknown mode",
      { type: "watch_diff", requestId: "r1", traceparent, target: { workspaceId: WORKSPACE, mode: "staged" } },
      "r1",
    ],
    ["a diff without a target", { type: "watch_diff", requestId: "r1", traceparent }, "r1"],
    ["a cancel without the job", { type: "cancel_install", requestId: "r1", traceparent }, "r1"],
    ["an install of a given command", { type: "install_pi", requestId: "r1", traceparent, command: "sh" }, "r1"],
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
    expect(
      CommandResult.list_models.parse({ models: [{ ...model, fastCredits: 2.5 }], defaultModel: null }),
    ).toStrictEqual({ models: [{ ...model, fastCredits: 2.5 }], defaultModel: null });
    expect(
      CommandResult.list_models.safeParse({ models: [{ ...model, fastCredits: 0 }], defaultModel: null }).success,
    ).toBe(false);
    const setup = {
      pi: {
        state: "broken",
        path: "/opt/bin/pi",
        version: null,
        minimum: "1.0.1",
        detail: "node: not found",
        latest: "1.2.0-beta.1",
        checkedAt: 1_760_000_000_000,
      },
      node: { state: "outdated", version: "20.11.0" },
      homebrew: true,
      fd: false,
      login: {
        state: "ready",
        providers: [
          {
            providerId: "anthropic",
            name: "Anthropic",
            oauth: { label: "Anthropic (Claude Pro/Max)", subscription: true },
            apiKey: true,
            signedIn: { method: "oauth", stored: true },
          },
          { providerId: "deepseek", name: "DeepSeek", oauth: null, apiKey: true, signedIn: null },
        ],
      },
      projects: 2,
    };
    expect(CommandResult.check_setup.parse(setup)).toStrictEqual(setup);
    expect(CommandResult.check_setup.parse({ ...setup, login: { state: "unavailable" } })).toStrictEqual({
      ...setup,
      login: { state: "unavailable" },
    });
    expect(CommandResult.check_setup.safeParse({ ...setup, node: { state: "ready", version: "22.19" } }).success).toBe(
      false,
    );
    const [anthropic] = setup.login.providers;
    const others = [
      ...["missing", "outdated", "ready"].map((state) => ({ ...setup, pi: { ...setup.pi, state } })),
      ...["missing", "ready"].map((state) => ({ ...setup, node: { ...setup.node, state } })),
      { ...setup, pi: { ...setup.pi, version: "10.20.30", minimum: "1.0.12", latest: "10.20.30" } },
      {
        ...setup,
        login: { state: "ready", providers: [{ ...anthropic, signedIn: { method: "api_key", stored: false } }] },
      },
    ];
    for (const other of others) expect(CommandResult.check_setup.parse(other)).toStrictEqual(other);
    expect(CommandResult.check_setup.safeParse({ ...setup, projects: -1 }).success).toBe(false);
    for (const wrong of [
      { version: "v1.0.1" },
      { version: "1.0.1-beta" },
      { minimum: "1.0.1.2" },
      { latest: "latest" },
      { latest: "v1.2.0" },
      { latest: "1.2.0 beta" },
    ]) {
      expect(CommandResult.check_setup.safeParse({ ...setup, pi: { ...setup.pi, ...wrong } }).success).toBe(false);
    }
    expect(CommandResult.check_pi_update.parse({ latest: null, checkedAt: null })).toStrictEqual({
      latest: null,
      checkedAt: null,
    });
    expect(CommandResult.check_pi_update.parse({ latest: "1.1.0", checkedAt: 5 })).toStrictEqual({
      latest: "1.1.0",
      checkedAt: 5,
    });
    expect(CommandResult.check_pi_update.safeParse({ latest: "1.1.0" }).success).toBe(false);
    const discovered = { path: "/Users/me/work", sessions: 3, lastUsedAt: 1_700_000_000_000 };
    expect(CommandResult.discover_projects.parse({ directories: [discovered] })).toStrictEqual({
      directories: [discovered],
    });
    expect(CommandResult.list_branches.parse({ branches: ["main", "release/1.0"], head: "main" })).toStrictEqual({
      branches: ["main", "release/1.0"],
      head: "main",
    });
    expect(CommandResult.list_branches.parse({ branches: [], head: null })).toStrictEqual({ branches: [], head: null });
    expect(CommandResult.list_branches.safeParse({ branches: [""], head: null }).success).toBe(false);
    expect(CommandResult.set_main_branch.parse({})).toStrictEqual({});
    for (const wrong of [
      { ...discovered, path: "" },
      { ...discovered, sessions: 0 },
      { ...discovered, lastUsedAt: -1 },
    ]) {
      expect(CommandResult.discover_projects.safeParse({ directories: [wrong] }).success).toBe(false);
    }
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
    expect(CommandResult.watch_changes.parse({})).toStrictEqual({});
    expect(CommandResult.watch_diff.safeParse({ files: [] }).success).toBe(false);
    expect(CommandResult.set_model.parse({})).toStrictEqual({});
    expect(CommandResult.set_thinking_level.parse({})).toStrictEqual({});
    expect(CommandResult.hand_off.parse({ file: "/pi/sessions/s1.jsonl" })).toStrictEqual({
      file: "/pi/sessions/s1.jsonl",
    });
    expect(CommandResult.hand_off.safeParse({}).success).toBe(false);
    expect(CommandResult.take_back.parse({})).toStrictEqual({});
    expect(CommandResult.clear_attention.parse({})).toStrictEqual({});
    expect(CommandResult.login.parse({ loginId: "l1" })).toStrictEqual({ loginId: "l1" });
    expect(CommandResult.login.safeParse({ loginId: "" }).success).toBe(false);
    expect(CommandResult.answer_login.parse({})).toStrictEqual({});
    expect(CommandResult.cancel_login.parse({})).toStrictEqual({});
    expect(CommandResult.logout.parse({})).toStrictEqual({});
    for (const kind of ["install_pi", "install_node", "update_pi"] as const) {
      expect(CommandResult[kind].parse({ jobId: "j1" })).toStrictEqual({ jobId: "j1" });
      expect(CommandResult[kind].safeParse({}).success).toBe(false);
    }
    expect(CommandResult.cancel_install.parse({})).toStrictEqual({});
    expect(Object.keys(CommandResult).toSorted()).toStrictEqual([...COMMAND_TYPES].toSorted());
  });
});

/** A list with one of everything. */
const snapshot: IndexSnapshotEvent = {
  type: "index_snapshot",
  generation: "h1",
  seq: 3,
  reason: "no_cursor",
  projects: [{ id: PROJECT, path: "/work/app", name: "app", mainBranch: "trunk" }],
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
  chats: [
    {
      id: CHAT,
      dir: "/Users/test/.atrium/chats/0f3c2a1e-5b6d-4c7e-8f90-123456789abc",
      alias: null,
      firstSessionId: "s2",
    },
    { id: "cht_x", dir: "/Users/test/.atrium/chats/x", alias: "合并原理", firstSessionId: null },
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
      attention: null,
      asking: null,
      handedOff: false,
    },
    {
      sessionId: "s2",
      containerId: CHAT,
      name: "解释 merge-tree",
      prompt: null,
      file: null,
      state: "draft",
      updatedAt: 6,
      archived: true,
      running: false,
      attention: { reason: "error", at: 7, cleared: false },
      asking: 8,
      handedOff: true,
    },
  ],
  layout: {
    container: WORKSPACE,
    tabs: { [WORKSPACE]: { open: ["s1"], active: "s1" }, [CHAT]: { open: [], active: null } },
  },
  preferences: {
    setupDone: true,
    appearance: "system",
    displayMode: "summary",
    lastModel: { providerId: "anthropic", modelId: "claude-opus-5-5" },
    thinkingByModel: { "anthropic/claude-opus-5-5": "high", "faux/faux-1": "off" },
    lastFast: true,
    statusBar: { cost: true, session: false },
    titleModel: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
    proxy: { url: "http://127.0.0.1:7897", noProxy: Array.from({ length: 100 }, () => "h") },
  },
  resets: ["layouts"],
};

/** Changes to the list with one of everything. */
const changes: IndexChangesEvent = {
  type: "index_changes",
  generation: "h1",
  seq: 4,
  projects: { upsert: snapshot.projects, remove: ["prj_fedcba9876543210"] },
  workspaces: { upsert: snapshot.workspaces, remove: [WORKSPACE] },
  chats: { upsert: snapshot.chats, remove: ["cht_gone"] },
  sessions: { upsert: snapshot.sessions, remove: ["s3"] },
  layout: snapshot.layout,
  preferences: snapshot.preferences,
};

describe("HostMessage: changes", () => {
  it.each([
    ["a negative count", { ...changesUpdated, stat: { added: -1, removed: 0 } }],
    ["a chat as a workspace", { ...changesUpdated, workspaceId: CHAT }],
    ["an unknown error", { ...diffUpdated, error: "denied" }],
    ["an unknown file status", { ...diffUpdated, files: [{ ...diffUpdated.files[1], status: "copied" }] }],
    [
      "an unknown line kind",
      {
        ...diffUpdated,
        files: [
          {
            ...diffUpdated.files[0],
            hunks: [
              { ...diffUpdated.files[0]?.hunks[0], lines: [{ kind: "same", oldNumber: 1, newNumber: 1, text: "" }] },
            ],
          },
        ],
      },
    ],
    [
      "a line numbered 0",
      {
        ...diffUpdated,
        files: [
          {
            ...diffUpdated.files[0],
            hunks: [
              { ...diffUpdated.files[0]?.hunks[0], lines: [{ kind: "add", oldNumber: null, newNumber: 0, text: "" }] },
            ],
          },
        ],
      },
    ],
  ])("rejects changes with %s", (_case, message) => {
    expect(HostMessage.safeParse(message).success).toBe(false);
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
        installSeed: 1,
        logDir: "/Users/test/.atrium/logs",
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
      changes,
      {
        ...changes,
        projects: { upsert: [], remove: [] },
        workspaces: { upsert: [], remove: [] },
        chats: { upsert: [], remove: [] },
        sessions: { upsert: [], remove: [] },
        layout: null,
        preferences: null,
      },
      changesUpdated,
      { ...changesUpdated, stat: null, dirty: false, ahead: 0, branch: null, base: null },
      diffUpdated,
      { ...diffUpdated, mode: "base", files: [], tooLarge: true, error: null },
      { ...diffUpdated, files: [], error: "not_git" },
      { ...diffUpdated, files: [], error: "failed" },
      loginUpdated,
      {
        ...loginUpdated,
        method: "api_key",
        state: "failed",
        authUrl: null,
        deviceCode: { ...loginUpdated.deviceCode, expiresInSeconds: null },
        questions: [],
        progress: null,
        error: { reason: "insecure_url", detail: null },
      },
      { ...loginUpdated, state: "ok", error: null },
      { ...loginUpdated, state: "cancelled", error: { reason: "failed", detail: "auth.json is corrupt" } },
      installUpdated,
      { ...installUpdated, kind: "install_pi", state: "running", running: null },
      { ...installUpdated, kind: "install_node", state: "failed", running: null, exitCode: 1, reason: "exit" },
      { ...installUpdated, state: "failed", running: null, reason: "exit" },
      { ...installUpdated, state: "failed", running: null, reason: "download_failed" },
      { ...installUpdated, state: "failed", running: null, reason: "spawn_failed" },
      { ...installUpdated, state: "ok", running: null },
      { ...installUpdated, state: "cancelled", running: null },
      { type: "install_output", jobId: "j1", text: "\u001b[1m  Pi Installer\u001b[0m\r\n" },
      { type: "pi_latest", latest: "1.1.0", checkedAt: 1_760_000_000_000 },
      { type: "pi_latest", latest: "2.0.0-rc.1+build.5", checkedAt: 0 },
      { type: "pi_latest", latest: null, checkedAt: null },
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
      ...["generation_changed", "cursor_expired", "too_many_changes"].map((reason) => ({ ...snapshot, reason })),
      { ...snapshot, sessions: [{ ...session, attention: { reason: "auth", at: 0, cleared: true } }] },
      ...["light", "dark"].map((appearance) => ({ ...snapshot, preferences: { ...snapshot.preferences, appearance } })),
      ...["thinking", "detailed"].map((displayMode) => ({
        ...snapshot,
        preferences: { ...snapshot.preferences, displayMode },
      })),
      { ...snapshot, layout: { container: null, tabs: {} }, resets: ["projects", "chats", "sessions", "preferences"] },
      {
        ...snapshot,
        preferences: {
          ...snapshot.preferences,
          lastModel: null,
          thinkingByModel: {},
          lastFast: false,
          statusBar: {},
          proxy: null,
        },
      },
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
      ...["unavailable", "failed", "timed_out", "insecure_url"].map((reason) => ({
        ...loginUpdated,
        state: "failed",
        error: { reason, detail: null },
      })),
      ...["text", "secret", "select", "manual_code"].map((kind) => ({
        ...loginUpdated,
        questions: [{ promptId: 1, kind, message: "Key", placeholder: null, options: [] }],
      })),
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
      "chat_not_found",
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
      "fast_unavailable",
      "pi_rejected",
      "session_handed_off",
      "login_unavailable",
      "login_not_found",
      "logout_failed",
      "install_busy",
      "install_unavailable",
      "install_not_found",
      "branch_not_found",
      "proxy_invalid",
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
    ["a snapshot without a reason", { ...snapshot, reason: undefined }],
    ["an unknown snapshot reason", { ...snapshot, reason: "asked" }],
    [
      "an unknown attention reason",
      {
        ...snapshot,
        sessions: [{ ...snapshot.sessions[0], attention: { reason: "finished", at: 1, cleared: false } }],
      },
    ],
    ["a session still marked failed", { ...snapshot, sessions: [{ ...snapshot.sessions[0], failed: false }] }],
    ["changes without a layout", { ...changes, layout: undefined }],
    ["changes that remove a session by an empty id", { ...changes, sessions: { upsert: [], remove: [""] } }],
    ["a snapshot without preferences", { ...snapshot, preferences: undefined }],
    [
      "a status bar group without a name",
      { ...snapshot, preferences: { ...snapshot.preferences, statusBar: { "": true } } },
    ],
    ["a session snapshot without metrics", { ...events[0], metrics: undefined }],
    [
      "a negative token count",
      { type: "metrics_updated", ...at, metrics: { ...metrics, tokens: { ...metrics.tokens, input: -1 } } },
    ],
    [
      "a context window of no tokens",
      { type: "metrics_updated", ...at, metrics: { ...metrics, context: { ...metrics.context, window: 0 } } },
    ],
    ["a fractional step count", { type: "metrics_updated", ...at, metrics: { ...metrics, steps: 1.5 } }],
    ["a negative cost", { type: "metrics_updated", ...at, metrics: { ...metrics, cost: -0.01 } }],
    [
      "a welcome without heartbeat",
      { type: "welcome", protocolVersion: 2, hostVersion: "0", hostInstanceId: "h1", installSeed: 1, logDir: "/l" },
    ],
    [
      "a welcome with a seed of 0",
      {
        type: "welcome",
        protocolVersion: 2,
        hostVersion: "0",
        hostInstanceId: "h1",
        heartbeatMs: 15_000,
        installSeed: 0,
        logDir: "/l",
      },
    ],
    [
      "a welcome without the log folder",
      {
        type: "welcome",
        protocolVersion: 2,
        hostVersion: "0",
        hostInstanceId: "h1",
        heartbeatMs: 15_000,
        installSeed: 1,
      },
    ],
    [
      "a sign-in address that is not https",
      { ...loginUpdated, authUrl: { url: "http://x.test/", instructions: null } },
    ],
    [
      "a device code page that is not https",
      { ...loginUpdated, deviceCode: { ...loginUpdated.deviceCode, verificationUri: "javascript:alert(1)" } },
    ],
    ["a login in a state it cannot be in", { ...loginUpdated, state: "waiting" }],
    ["an install job of a kind there is not", { ...installUpdated, kind: "install_fd" }],
    ["an install job in a state it cannot be in", { ...installUpdated, state: "starting" }],
    ["a failure for a reason there is not", { ...installUpdated, state: "failed", reason: "timeout" }],
    ["a negative number of running sessions", { ...installUpdated, running: -1 }],
    ["empty install output", { type: "install_output", jobId: "j1", text: "" }],
    ["a latest pi that is not a version", { type: "pi_latest", latest: "v1.1.0", checkedAt: 1 }],
    ["a check at a time before 1970", { type: "pi_latest", latest: "1.1.0", checkedAt: -1 }],
    [
      "a question of a kind pi does not ask",
      { ...loginUpdated, questions: [{ ...loginUpdated.questions[0], kind: "file" }] },
    ],
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

describe("isChatId", () => {
  it("tells a chat's id from a workspace's and from the old chats' container", () => {
    expect([CHAT, "cht_a", WORKSPACE, "chats", "x/cht_a"].map(isChatId)).toStrictEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
