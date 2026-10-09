import { type Command, CommandError, type HostMessage, type PromptCommand } from "@atrium/protocol";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import type { IndexCommands } from "../sessions/index-commands";
import type { SessionCommands } from "../sessions/session-commands";
import { type Connection, createConnection } from "./connection";
import { createRouter } from "./router";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentSpanId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${parentSpanId}-01`;
const shutdowns: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
});

/** Session and list commands that record their calls and answer as the prompt's text says. */
function fakeCommands() {
  const calls: unknown[][] = [];
  /** Records a call and answers with `result`. */
  const record =
    <R>(name: string, result: R) =>
    async (...args: unknown[]): Promise<R> => {
      calls.push([name, ...args]);
      return result;
    };
  const sessions: SessionCommands = {
    createChat: record("createChat", { sessionId: "s1" }),
    createSession: record("createSession", { sessionId: "s3" }),
    openSession: record("openSession", {}),
    closeTab: record("closeTab", {}),
    selectContainer: record("selectContainer", {}),
    archiveSession: record("archiveSession", {}),
    renameSession: record("renameSession", {}),
    subscribe: record("subscribe", {}),
    prompt: async (command: PromptCommand) => {
      calls.push(["prompt", command.sessionId, command.text]);
      if (command.text === "missing") throw new CommandError("session_not_found", { sessionId: command.sessionId });
      if (command.text === "crash") throw new Error("secret detail");
      return { disposition: "started" };
    },
    fetchStep: async (command) => {
      calls.push(["fetchStep", command.sessionId, command.epoch, command.turnId, command.stepId]);
      return { step: { kind: "text", id: command.stepId, text: "whole" } };
    },
    fetchTranscript: async (command) => {
      calls.push(["fetchTranscript", command.sessionId, command.epoch, command.before, command.limit]);
      return { items: [], hasOlder: true };
    },
    steer: async (command) => {
      calls.push(["steer", command.sessionId, command.text]);
      return { disposition: "queued" };
    },
    stop: record("stop", { confirmed: false }),
    resumeQueue: record("resumeQueue", {}),
    clearQueue: record("clearQueue", {}),
    updateQueued: record("updateQueued", {}),
    removeQueued: record("removeQueued", {}),
    steerQueued: record("steerQueued", { disposition: "handled" }),
    answerInteraction: record("answerInteraction", {}),
    retryRun: record("retryRun", {}),
    setModel: record("setModel", {}),
    setThinkingLevel: record("setThinkingLevel", {}),
    listCommands: record("listCommands", { commands: [] }),
    searchFiles: record("searchFiles", { files: [] }),
  };
  const index: IndexCommands = {
    subscribeIndex: record("subscribeIndex", {}),
    addProject: record("addProject", { projectId: PROJECT }),
    removeProject: record("removeProject", {}),
    renameProject: record("renameProject", {}),
    renameWorkspace: record("renameWorkspace", {}),
    windowFocused: record("windowFocused", {}),
    setPreferences: record("setPreferences", {}),
    listModels: record("listModels", { models: [], defaultModel: null }),
  };
  return { sessions, index, calls };
}

const PROJECT = "prj_0123456789abcdef";
const WORKSPACE = "wks_0123456789abcdef";

/** A router over fake sessions, a connection whose handshake span is recorded, and what it sends. */
function setUp() {
  const recording = recordingTracing();
  shutdowns.push(recording.shutdown);
  const handshake = recording.tracer.startSpan("ws.connect");
  handshake.end();
  const sent: HostMessage[] = [];
  const connection: Connection = createConnection(
    { bufferedAmount: 0, send: (data) => sent.push(JSON.parse(data) as HostMessage), close: () => undefined },
    {
      id: "connection-7",
      clientId: "client-1",
      trace: trace.setSpan(ROOT_CONTEXT, handshake),
      maxBufferedBytes: 1024,
      logger: recording.logger,
    },
  );
  const { sessions, index, calls } = fakeCommands();
  const route = createRouter({ sessions, index, tracer: recording.tracer, logger: recording.logger });
  return {
    route,
    connection,
    sent,
    calls,
    records: recording.records,
    logger: recording.logger,
    handshake: handshake.spanContext(),
  };
}

/** A command with the shared trace context. */
function withTrace(fields: Record<string, unknown>): Command {
  return { requestId: "r1", traceparent, ...fields } as Command;
}

describe("createRouter", () => {
  it("answers ping in a command span under the command's trace, linked to the connection's", async () => {
    const { route, connection, sent, records, handshake } = setUp();

    await route(connection, withTrace({ type: "ping" }));

    expect(sent).toStrictEqual([{ type: "response", requestId: "r1", ok: true, result: {} }]);
    await vi.waitFor(() =>
      expect(records).toContainEqual(
        expect.objectContaining({
          kind: "span",
          name: "command ping",
          trace_id: traceId,
          parent_span_id: parentSpanId,
          status: "ok",
          attributes: { "client.id": "client-1" },
          links: [{ trace_id: handshake.traceId, span_id: handshake.spanId }],
        }),
      ),
    );
    expect(records.filter((record) => record["msg"] === "client issue")).toStrictEqual([]);
  });

  it("links a command to nothing when the connection has no trace", async () => {
    const { route, records, logger } = setUp();
    const untraced = createConnection(
      { bufferedAmount: 0, send: () => undefined, close: () => undefined },
      { id: "c2", clientId: "client-2", trace: ROOT_CONTEXT, maxBufferedBytes: 1024, logger },
    );

    await route(untraced, withTrace({ type: "ping" }));

    await vi.waitFor(() =>
      expect(records).toContainEqual(expect.objectContaining({ kind: "span", name: "command ping", links: [] })),
    );
  });

  it("hands session commands to the session layer, with the client for layout changes, and returns their results", async () => {
    const { route, connection, sent, calls } = setUp();

    await route(connection, withTrace({ type: "create_chat", requestId: "r1" }));
    await route(connection, withTrace({ type: "subscribe_sessions", requestId: "r2", sessionIds: ["s1"] }));
    await route(connection, withTrace({ type: "prompt", requestId: "r3", sessionId: "s1", text: "hi" }));
    await route(
      connection,
      withTrace({ type: "fetch_transcript", requestId: "r4", sessionId: "s1", epoch: 2, before: "t9", limit: 50 }),
    );
    await route(
      connection,
      withTrace({ type: "fetch_step", requestId: "r5", sessionId: "s1", epoch: 2, turnId: "t9", stepId: "3" }),
    );
    await route(connection, withTrace({ type: "open_session", requestId: "r6", sessionId: "s2" }));
    await route(connection, withTrace({ type: "create_session", requestId: "r7", workspaceId: WORKSPACE }));
    await route(connection, withTrace({ type: "close_tab", requestId: "r8", sessionId: "s2" }));
    await route(connection, withTrace({ type: "select_container", requestId: "r9", containerId: "chats" }));
    await route(connection, withTrace({ type: "archive_session", requestId: "r10", sessionId: "s2" }));
    await route(connection, withTrace({ type: "rename_session", requestId: "r11", sessionId: "s2", name: "名字" }));

    expect(calls).toStrictEqual([
      ["createChat", "client-1"],
      ["subscribe", "connection-7", ["s1"]],
      ["prompt", "s1", "hi"],
      ["fetchTranscript", "s1", 2, "t9", 50],
      ["fetchStep", "s1", 2, "t9", "3"],
      ["openSession", "client-1", "s2"],
      ["createSession", "client-1", WORKSPACE],
      ["closeTab", "client-1", "s2"],
      ["selectContainer", "client-1", "chats"],
      ["archiveSession", "s2"],
      ["renameSession", "s2", "名字"],
    ]);
    expect(sent).toStrictEqual([
      { type: "response", requestId: "r1", ok: true, result: { sessionId: "s1" } },
      { type: "response", requestId: "r2", ok: true, result: {} },
      { type: "response", requestId: "r3", ok: true, result: { disposition: "started" } },
      { type: "response", requestId: "r4", ok: true, result: { items: [], hasOlder: true } },
      { type: "response", requestId: "r5", ok: true, result: { step: { kind: "text", id: "3", text: "whole" } } },
      { type: "response", requestId: "r6", ok: true, result: {} },
      { type: "response", requestId: "r7", ok: true, result: { sessionId: "s3" } },
      ...["r8", "r9", "r10", "r11"].map((requestId) => ({ type: "response", requestId, ok: true, result: {} })),
    ]);
  });

  it("hands run control commands to the session layer and returns their results", async () => {
    const { route, connection, sent, calls } = setUp();
    const session = { sessionId: "s1" };

    await route(connection, withTrace({ type: "steer", requestId: "r1", ...session, text: "also" }));
    await route(connection, withTrace({ type: "stop", requestId: "r2", ...session }));
    await route(connection, withTrace({ type: "resume_queue", requestId: "r3", ...session }));
    await route(connection, withTrace({ type: "clear_queue", requestId: "r4", ...session }));
    await route(connection, withTrace({ type: "update_queued", requestId: "r5", ...session, itemId: "q1", text: "t" }));
    await route(connection, withTrace({ type: "remove_queued", requestId: "r6", ...session, itemId: "q2" }));
    await route(connection, withTrace({ type: "steer_queued", requestId: "r7", ...session, itemId: "q3" }));
    await route(
      connection,
      withTrace({
        type: "answer_interaction",
        requestId: "r8",
        ...session,
        interactionId: "d1",
        answer: { value: "a" },
      }),
    );
    await route(connection, withTrace({ type: "retry_run", requestId: "r9", ...session }));
    await route(
      connection,
      withTrace({ type: "set_model", requestId: "r10", ...session, providerId: "anthropic", modelId: "haiku" }),
    );
    await route(connection, withTrace({ type: "set_thinking_level", requestId: "r11", ...session, level: "max" }));
    await route(connection, withTrace({ type: "list_commands", requestId: "r12", ...session }));
    await route(connection, withTrace({ type: "search_files", requestId: "r13", ...session, query: "src/" }));

    expect(calls).toStrictEqual([
      ["steer", "s1", "also"],
      ["stop", "s1"],
      ["resumeQueue", "s1"],
      ["clearQueue", "s1"],
      ["updateQueued", "s1", "q1", "t"],
      ["removeQueued", "s1", "q2"],
      ["steerQueued", "s1", "q3"],
      ["answerInteraction", "s1", "d1", { value: "a" }],
      ["retryRun", "s1"],
      ["setModel", "s1", { providerId: "anthropic", modelId: "haiku" }],
      ["setThinkingLevel", "s1", "max"],
      ["listCommands", "s1"],
      ["searchFiles", "s1", "src/"],
    ]);
    expect(sent).toStrictEqual([
      { type: "response", requestId: "r1", ok: true, result: { disposition: "queued" } },
      { type: "response", requestId: "r2", ok: true, result: { confirmed: false } },
      ...["r3", "r4", "r5", "r6"].map((requestId) => ({ type: "response", requestId, ok: true, result: {} })),
      { type: "response", requestId: "r7", ok: true, result: { disposition: "handled" } },
      ...["r8", "r9", "r10", "r11"].map((requestId) => ({ type: "response", requestId, ok: true, result: {} })),
      { type: "response", requestId: "r12", ok: true, result: { commands: [] } },
      { type: "response", requestId: "r13", ok: true, result: { files: [] } },
    ]);
  });

  it("hands list commands to the index commands", async () => {
    const { route, connection, sent, calls } = setUp();

    await route(connection, withTrace({ type: "subscribe_index", requestId: "r1" }));
    await route(connection, withTrace({ type: "add_project", requestId: "r2", path: "/work/app" }));
    await route(connection, withTrace({ type: "remove_project", requestId: "r3", projectId: PROJECT }));
    await route(connection, withTrace({ type: "rename_project", requestId: "r4", projectId: PROJECT, name: "app" }));
    await route(
      connection,
      withTrace({ type: "rename_workspace", requestId: "r5", workspaceId: WORKSPACE, name: null }),
    );
    await route(connection, withTrace({ type: "window_focused", requestId: "r6" }));
    await route(connection, withTrace({ type: "set_preferences", requestId: "r7", appearance: "dark" }));
    await route(connection, withTrace({ type: "set_preferences", requestId: "r8", displayMode: "thinking" }));
    await route(connection, withTrace({ type: "set_preferences", requestId: "r9" }));
    await route(connection, withTrace({ type: "list_models", requestId: "r10", containerId: WORKSPACE }));
    await route(connection, withTrace({ type: "list_models", requestId: "r11", containerId: "chats", refresh: true }));

    expect(calls).toStrictEqual([
      ["subscribeIndex", "connection-7"],
      ["addProject", "/work/app"],
      ["removeProject", PROJECT],
      ["renameProject", PROJECT, "app"],
      ["renameWorkspace", WORKSPACE, null],
      ["windowFocused"],
      ["setPreferences", { appearance: "dark" }],
      ["setPreferences", { displayMode: "thinking" }],
      ["setPreferences", {}],
      ["listModels", WORKSPACE, false],
      ["listModels", "chats", true],
    ]);
    expect(sent[1]).toStrictEqual({ type: "response", requestId: "r2", ok: true, result: { projectId: PROJECT } });
    expect(sent[9]).toStrictEqual({
      type: "response",
      requestId: "r10",
      ok: true,
      result: { models: [], defaultModel: null },
    });
  });

  it("answers a CommandError with its code and parameters", async () => {
    const { route, connection, sent, records } = setUp();

    await route(connection, withTrace({ type: "prompt", sessionId: "s9", text: "missing" }));

    expect(sent).toStrictEqual([
      {
        type: "response",
        requestId: "r1",
        ok: false,
        error: { code: "session_not_found", params: { sessionId: "s9" } },
      },
    ]);
    await vi.waitFor(() =>
      expect(records).toContainEqual(
        expect.objectContaining({
          kind: "span",
          name: "command prompt",
          attributes: { "client.id": "client-1", "command.error": "session_not_found" },
        }),
      ),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "command failed",
        command: "prompt",
        code: "session_not_found",
        trace_id: traceId,
      }),
    );
  });

  it("answers any other failure with internal_error, logging it but never sending its text", async () => {
    const { route, connection, sent, records } = setUp();

    await route(connection, withTrace({ type: "prompt", sessionId: "s1", text: "crash" }));

    expect(sent).toStrictEqual([{ type: "response", requestId: "r1", ok: false, error: { code: "internal_error" } }]);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "command crashed",
        command: "prompt",
        trace_id: traceId,
        err: expect.objectContaining({ message: "secret detail" }),
      }),
    );
  });

  it("refuses unknown and invalid messages with a response, keeping the request id it can read", async () => {
    const { route, connection, sent, records, handshake } = setUp();

    await route(connection, { type: "fly", requestId: "r5", traceparent });
    await route(connection, undefined);
    await route(connection, { type: "ping", requestId: "r6" });

    expect(sent).toStrictEqual([
      { type: "response", requestId: "r5", ok: false, error: { code: "unknown_command" } },
      { type: "response", requestId: null, ok: false, error: { code: "invalid_message" } },
      { type: "response", requestId: "r6", ok: false, error: { code: "invalid_message" } },
    ]);
    expect(records.filter((record) => record["msg"] === "command refused")).toStrictEqual([
      expect.objectContaining({
        level: "warn",
        client_id: "client-1",
        code: "unknown_command",
        trace_id: handshake.traceId,
      }),
      expect.objectContaining({ code: "invalid_message", trace_id: handshake.traceId }),
      expect.objectContaining({ code: "invalid_message", trace_id: handshake.traceId }),
    ]);
  });

  it("writes a UI problem into the log and answers it", async () => {
    const { route, connection, sent, records } = setUp();

    await route(
      connection,
      withTrace({ type: "report_client_issue", kind: "long_task", message: "took 80 ms", details: "render" }),
    );

    expect(sent).toStrictEqual([{ type: "response", requestId: "r1", ok: true, result: {} }]);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "client issue",
        client_id: "client-1",
        kind: "long_task",
        issue: "took 80 ms",
        details: "render",
        trace_id: traceId,
      }),
    );
  });
});
