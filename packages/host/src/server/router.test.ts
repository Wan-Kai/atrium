import { type Command, CommandError, type HostMessage, type PromptCommand } from "@atrium/protocol";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
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

/** Session commands that record their calls and answer as the prompt's text says. */
function fakeSessions() {
  const calls: unknown[][] = [];
  const sessions: SessionCommands = {
    createChat: async (connectionId) => {
      calls.push(["createChat", connectionId]);
      return { sessionId: "s1" };
    },
    subscribe: async (connectionId, sessionIds) => {
      calls.push(["subscribe", connectionId, sessionIds]);
      return {};
    },
    prompt: async (command: PromptCommand) => {
      calls.push(["prompt", command.sessionId, command.text]);
      if (command.text === "missing") throw new CommandError("session_not_found", { sessionId: command.sessionId });
      if (command.text === "crash") throw new Error("secret detail");
      return { disposition: "started" };
    },
    listRecentSessions: async (limit) => {
      calls.push(["listRecentSessions", limit]);
      return { sessions: [{ sessionId: "s2", firstPrompt: "hi", modifiedAt: 3 }] };
    },
    openSession: async (sessionId) => {
      calls.push(["openSession", sessionId]);
      return { sessionId };
    },
    fetchStep: async (command) => {
      calls.push(["fetchStep", command.sessionId, command.epoch, command.turnId, command.stepId]);
      return { step: { kind: "text", id: command.stepId, text: "whole" } };
    },
    fetchTranscript: async (command) => {
      calls.push(["fetchTranscript", command.sessionId, command.epoch, command.before, command.limit]);
      return { items: [], hasOlder: true };
    },
  };
  return { sessions, calls };
}

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
  const { sessions, calls } = fakeSessions();
  const route = createRouter({ sessions, tracer: recording.tracer, logger: recording.logger });
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

  it("hands session commands to the session layer with the connection's id and returns their results", async () => {
    const { route, connection, sent, calls } = setUp();

    await route(connection, withTrace({ type: "create_chat", requestId: "r1" }));
    await route(connection, withTrace({ type: "subscribe_sessions", requestId: "r2", sessionIds: ["s1"] }));
    await route(connection, withTrace({ type: "prompt", requestId: "r3", sessionId: "s1", text: "hi" }));
    await route(
      connection,
      withTrace({ type: "fetch_transcript", requestId: "r4", sessionId: "s1", epoch: 2, before: "t9", limit: 50 }),
    );
    await route(connection, withTrace({ type: "list_recent_sessions", requestId: "r5", limit: 20 }));
    await route(
      connection,
      withTrace({ type: "fetch_step", requestId: "r7", sessionId: "s1", epoch: 2, turnId: "t9", stepId: "3" }),
    );
    await route(connection, withTrace({ type: "open_session", requestId: "r6", sessionId: "s2" }));

    expect(calls).toStrictEqual([
      ["createChat", "connection-7"],
      ["subscribe", "connection-7", ["s1"]],
      ["prompt", "s1", "hi"],
      ["fetchTranscript", "s1", 2, "t9", 50],
      ["listRecentSessions", 20],
      ["fetchStep", "s1", 2, "t9", "3"],
      ["openSession", "s2"],
    ]);
    expect(sent).toStrictEqual([
      { type: "response", requestId: "r1", ok: true, result: { sessionId: "s1" } },
      { type: "response", requestId: "r2", ok: true, result: {} },
      { type: "response", requestId: "r3", ok: true, result: { disposition: "started" } },
      { type: "response", requestId: "r4", ok: true, result: { items: [], hasOlder: true } },
      {
        type: "response",
        requestId: "r5",
        ok: true,
        result: { sessions: [{ sessionId: "s2", firstPrompt: "hi", modifiedAt: 3 }] },
      },
      {
        type: "response",
        requestId: "r7",
        ok: true,
        result: { step: { kind: "text", id: "3", text: "whole" } },
      },
      { type: "response", requestId: "r6", ok: true, result: { sessionId: "s2" } },
    ]);
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
