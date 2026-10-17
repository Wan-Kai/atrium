import {
  type Command,
  CommandError,
  type DiffTarget,
  type HostMessage,
  type PromptCommand,
  type SetupState,
} from "@atrium/protocol";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { FakeClock } from "@atrium/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import type { IndexCommands } from "../sessions/index-commands";
import type { SessionCommands } from "../sessions/session-commands";
import { type Connection, createConnection } from "./connection";
import { createAttachmentStore } from "./attachments";
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
    detachSession: record("detachSession", {}),
    archiveChat: record("archiveChat", {}),
    restoreChat: record("restoreChat", {}),
    renameSession: record("renameSession", {}),
    clearAttention: record("clearAttention", {}),
    handOff: record("handOff", { file: "/s.jsonl" }),
    takeBack: record("takeBack", {}),
    subscribe: record("subscribe", {}),
    prompt: async (command: PromptCommand, images = []) => {
      calls.push(["prompt", command.sessionId, command.text, ...images.map((image) => image.data)]);
      if (command.text === "missing") throw new CommandError("session_not_found", { sessionId: command.sessionId });
      if (command.text === "crash") throw new Error("secret detail");
      return { disposition: "started" };
    },
    fetchStep: async (command) => {
      calls.push(["fetchStep", command.sessionId, command.epoch, command.turnId, command.stepId]);
      return { step: { kind: "text", id: command.stepId, text: "whole" } };
    },
    fetchImage: async (command) => {
      calls.push(["fetchImage", command.sessionId, command.turnId, command.index]);
      return { mimeType: "image/png", data: "eA==" };
    },
    fetchTranscript: async (command) => {
      calls.push(["fetchTranscript", command.sessionId, command.epoch, command.before, command.limit]);
      return { items: [], hasOlder: true };
    },
    steer: async (command, images = []) => {
      calls.push(["steer", command.sessionId, command.text, ...images.map((image) => image.data)]);
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
    setFast: record("setFast", {}),
    compactSession: record("compactSession", {}),
    exportSession: record("exportSession", { html: "<html></html>" }),
    forkSession: record("forkSession", { sessionId: "s2" }),
    listCommands: record("listCommands", { commands: [] }),
    searchFiles: record("searchFiles", { files: [] }),
  };
  const index: IndexCommands = {
    subscribeIndex: record("subscribeIndex", {}),
    addProject: record("addProject", { projectId: PROJECT }),
    removeProject: record("removeProject", {}),
    renameProject: record("renameProject", {}),
    renameWorkspace: record("renameWorkspace", {}),
    archiveWorkspace: record("archiveWorkspace", {}),
    restoreWorkspace: record("restoreWorkspace", {}),
    listBases: record("listBases", { main: null, current: "main", local: ["main"], remote: [] }),
    createWorkspace: record("createWorkspace", { workspaceId: WORKSPACE }),
    nameBranch: record("nameBranch", { branch: "atrium/fix-it" }),
    renameChat: record("renameChat", {}),
    windowFocused: record("windowFocused", {}),
    setPreferences: record("setPreferences", {}),
    listModels: record("listModels", { models: [], defaultModel: null }),
    discoverProjects: record("discoverProjects", { directories: [DISCOVERED] }),
    listBranches: record("listBranches", { branches: ["main"], head: "main" }),
    setMainBranch: record("setMainBranch", {}),
    answering: () => undefined,
  };
  return { sessions, index, calls };
}

const PROJECT = "prj_0123456789abcdef";
const CHAT = "cht_0f3c2a1e-5b6d-4c7e-8f90-123456789abc";

/** A directory of pi's history, as the list commands find it. */
const DISCOVERED = { path: "/work/app", sessions: 2, lastUsedAt: 5 };

const SETUP: SetupState = {
  pi: { state: "missing", path: null, version: null, minimum: "1.0.1", detail: null, latest: null, checkedAt: null },
  node: { state: "missing", version: null },
  homebrew: false,
  fd: false,
  login: { state: "unavailable" },
  projects: 0,
};
const WORKSPACE = "wks_0123456789abcdef";
const MODEL = { providerId: "anthropic", modelId: "claude-haiku-4-5" };

/** A proxy setting, passed on as it is; the index commands check it. */
const PROXY = { url: "http://127.0.0.1:7897", noProxy: [".example.com"] };

/**
 * A router over fake sessions, a connection whose handshake span is recorded, and what it sends.
 *
 * @remarks
 * `answering` stands in for the feed's flush before each answer.
 *
 * @sideEffects Starts a recording tracer, shut down after the test.
 * @param answering - What happens before an answer goes out.
 * @returns The router, the connection, what it sent, the calls and the log.
 */
function setUp(answering: IndexCommands["answering"] = () => undefined) {
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
  const { sessions, index: fakeIndex, calls } = fakeCommands();
  const index: IndexCommands = { ...fakeIndex, answering };
  let nextAttachment = 0;
  const attachments = createAttachmentStore({
    clock: new FakeClock(),
    newId: () => `a${++nextAttachment}`,
    maxBytes: 1024,
    maxCount: 4,
    keepMs: 60_000,
  });
  const changes = {
    watchChanges: (connectionId: string, workspaceIds: readonly string[]) => {
      calls.push(["watchChanges", connectionId, ...workspaceIds]);
      if (workspaceIds.includes("wks_ffffffffffffffff")) {
        throw new CommandError("workspace_not_found", { workspaceId: "wks_ffffffffffffffff" });
      }
    },
    watchDiff: (connectionId: string, target: DiffTarget | null) => {
      calls.push(["watchDiff", connectionId, target]);
    },
  };
  const route = createRouter({
    sessions,
    index,
    setup: {
      check: async (refresh) => {
        calls.push(["checkSetup", refresh]);
        return SETUP;
      },
    },
    logins: {
      login: async (request) => {
        calls.push(["login", request]);
        return { loginId: "l1" };
      },
      answer: (loginId, promptId, value) => {
        calls.push(["answerLogin", loginId, promptId, value]);
      },
      cancel: (loginId) => {
        calls.push(["cancelLogin", loginId]);
      },
      logout: async (providerId) => {
        calls.push(["logout", providerId]);
      },
    },
    installs: {
      start: async (kind) => {
        calls.push(["install", kind]);
        return { jobId: "j1" };
      },
      cancel: (jobId) => {
        calls.push(["cancelInstall", jobId]);
      },
    },
    piLatest: {
      check: async () => {
        calls.push(["checkPiUpdate"]);
        return { latest: "1.1.0", checkedAt: 7 };
      },
    },
    attachments,
    changes,
    files: {
      listDir: async (workspaceId, path) => {
        calls.push(["listDir", workspaceId, path]);
        if (path === "gone") throw new CommandError("path_not_found");
        return { entries: [{ name: "a.ts", kind: "file" }], truncated: false };
      },
      readFile: async (workspaceId, path) => {
        calls.push(["readFile", workspaceId, path]);
        return { size: 1, content: { kind: "text", text: "a" } };
      },
    },
    tracer: recording.tracer,
    logger: recording.logger,
  });
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
    await route(connection, withTrace({ type: "create_session", requestId: "r7", containerId: WORKSPACE }));
    await route(connection, withTrace({ type: "create_session", requestId: "r7a", containerId: WORKSPACE, go: false }));
    const child = { parentSessionId: "s1", name: "补测试", place: "same" } as const;
    await route(connection, withTrace({ type: "create_session", requestId: "r7b", containerId: WORKSPACE, child }));
    await route(connection, withTrace({ type: "detach_session", requestId: "r7c", sessionId: "s4" }));
    await route(connection, withTrace({ type: "close_tab", requestId: "r8", sessionId: "s2" }));
    await route(connection, withTrace({ type: "select_container", requestId: "r9", containerId: CHAT }));
    await route(connection, withTrace({ type: "archive_session", requestId: "r10", sessionId: "s2" }));
    await route(connection, withTrace({ type: "archive_chat", requestId: "r10a", chatId: CHAT }));
    await route(connection, withTrace({ type: "restore_chat", requestId: "r10b", chatId: CHAT }));
    await route(connection, withTrace({ type: "rename_session", requestId: "r11", sessionId: "s2", name: "名字" }));
    await route(connection, withTrace({ type: "clear_attention", requestId: "r12", sessionId: "s2" }));
    await route(connection, withTrace({ type: "hand_off", requestId: "r13", sessionId: "s2" }));
    await route(connection, withTrace({ type: "take_back", requestId: "r14", sessionId: "s2" }));
    await route(
      connection,
      withTrace({ type: "fetch_image", requestId: "r15", sessionId: "s1", turnId: "t9", index: 1 }),
    );

    expect(calls).toStrictEqual([
      ["createChat", "client-1"],
      ["subscribe", "connection-7", ["s1"]],
      ["prompt", "s1", "hi"],
      ["fetchTranscript", "s1", 2, "t9", 50],
      ["fetchStep", "s1", 2, "t9", "3"],
      ["openSession", "client-1", "s2"],
      ["createSession", "client-1", WORKSPACE, true, undefined],
      ["createSession", "client-1", WORKSPACE, false, undefined],
      ["createSession", "client-1", WORKSPACE, true, { parentSessionId: "s1", name: "补测试", place: "same" }],
      ["detachSession", "s4"],
      ["closeTab", "client-1", "s2"],
      ["selectContainer", "client-1", CHAT],
      ["archiveSession", "s2"],
      ["archiveChat", CHAT],
      ["restoreChat", CHAT],
      ["renameSession", "s2", "名字"],
      ["clearAttention", "s2"],
      ["handOff", "s2"],
      ["takeBack", "s2"],
      ["fetchImage", "s1", "t9", 1],
    ]);
    expect(sent).toStrictEqual([
      { type: "response", requestId: "r1", ok: true, result: { sessionId: "s1" } },
      { type: "response", requestId: "r2", ok: true, result: {} },
      { type: "response", requestId: "r3", ok: true, result: { disposition: "started" } },
      { type: "response", requestId: "r4", ok: true, result: { items: [], hasOlder: true } },
      { type: "response", requestId: "r5", ok: true, result: { step: { kind: "text", id: "3", text: "whole" } } },
      { type: "response", requestId: "r6", ok: true, result: {} },
      { type: "response", requestId: "r7", ok: true, result: { sessionId: "s3" } },
      { type: "response", requestId: "r7a", ok: true, result: { sessionId: "s3" } },
      { type: "response", requestId: "r7b", ok: true, result: { sessionId: "s3" } },
      ...["r7c", "r8", "r9", "r10", "r10a", "r10b", "r11", "r12"].map((requestId) => ({
        type: "response",
        requestId,
        ok: true,
        result: {},
      })),
      { type: "response", requestId: "r13", ok: true, result: { file: "/s.jsonl" } },
      { type: "response", requestId: "r14", ok: true, result: {} },
      { type: "response", requestId: "r15", ok: true, result: { mimeType: "image/png", data: "eA==" } },
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
    await route(connection, withTrace({ type: "set_fast", requestId: "r14", ...session, enabled: false }));
    await route(connection, withTrace({ type: "compact_session", requestId: "r15", ...session, instructions: "API" }));
    await route(connection, withTrace({ type: "compact_session", requestId: "r16", ...session }));
    await route(connection, withTrace({ type: "export_session", requestId: "r17", ...session }));
    await route(
      connection,
      withTrace({ type: "fork_session", requestId: "r18", ...session, turnId: "t1", name: "修 bug（分叉）" }),
    );

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
      ["setFast", "s1", false],
      ["compactSession", "s1", "API"],
      ["compactSession", "s1", undefined],
      ["exportSession", "s1"],
      [
        "forkSession",
        "client-1",
        { type: "fork_session", requestId: "r18", traceparent, ...session, turnId: "t1", name: "修 bug（分叉）" },
      ],
    ]);
    expect(sent).toStrictEqual([
      { type: "response", requestId: "r1", ok: true, result: { disposition: "queued" } },
      { type: "response", requestId: "r2", ok: true, result: { confirmed: false } },
      ...["r3", "r4", "r5", "r6"].map((requestId) => ({ type: "response", requestId, ok: true, result: {} })),
      { type: "response", requestId: "r7", ok: true, result: { disposition: "handled" } },
      ...["r8", "r9", "r10", "r11"].map((requestId) => ({ type: "response", requestId, ok: true, result: {} })),
      { type: "response", requestId: "r12", ok: true, result: { commands: [] } },
      { type: "response", requestId: "r13", ok: true, result: { files: [] } },
      ...["r14", "r15", "r16"].map((requestId) => ({ type: "response", requestId, ok: true, result: {} })),
      { type: "response", requestId: "r17", ok: true, result: { html: "<html></html>" } },
      { type: "response", requestId: "r18", ok: true, result: { sessionId: "s2" } },
    ]);
  });

  it("hands list commands to the index commands", async () => {
    const { route, connection, sent, calls } = setUp();

    await route(connection, withTrace({ type: "subscribe_index", requestId: "r1" }));
    await route(
      connection,
      withTrace({ type: "subscribe_index", requestId: "r1b", cursor: { generation: "h1", seq: 4 } }),
    );
    await route(connection, withTrace({ type: "add_project", requestId: "r2", path: "/work/app" }));
    await route(connection, withTrace({ type: "remove_project", requestId: "r3", projectId: PROJECT }));
    await route(connection, withTrace({ type: "rename_project", requestId: "r4", projectId: PROJECT, name: "app" }));
    await route(
      connection,
      withTrace({ type: "rename_workspace", requestId: "r5", workspaceId: WORKSPACE, name: null }),
    );
    await route(connection, withTrace({ type: "window_focused", requestId: "r6" }));
    await route(
      connection,
      withTrace({ type: "set_preferences", requestId: "r7", appearance: "dark", titleModel: null }),
    );
    await route(
      connection,
      withTrace({ type: "set_preferences", requestId: "r8", appearance: "light", setupDone: true, proxy: PROXY }),
    );
    await route(connection, withTrace({ type: "set_preferences", requestId: "r9" }));
    await route(connection, withTrace({ type: "list_models", requestId: "r10", workspaceId: WORKSPACE }));
    await route(connection, withTrace({ type: "list_models", requestId: "r11", workspaceId: null, refresh: true }));
    await route(
      connection,
      withTrace({
        type: "set_preferences",
        requestId: "r12",
        statusBar: { cost: true },
        titleModel: MODEL,
        proxy: null,
        inbox: false,
      }),
    );
    await route(connection, withTrace({ type: "check_setup", requestId: "r13" }));
    await route(connection, withTrace({ type: "check_setup", requestId: "r14", refresh: true }));
    await route(connection, withTrace({ type: "rename_chat", requestId: "r15", chatId: CHAT, name: "合并原理" }));
    await route(connection, withTrace({ type: "archive_workspace", requestId: "r16", workspaceId: WORKSPACE }));
    await route(connection, withTrace({ type: "restore_workspace", requestId: "r17", workspaceId: WORKSPACE }));
    await route(connection, withTrace({ type: "list_bases", requestId: "r18", projectId: PROJECT }));
    await route(
      connection,
      withTrace({ type: "create_workspace", requestId: "r19", projectId: PROJECT, branch: "atrium/a", base: "main" }),
    );
    await route(
      connection,
      withTrace({ type: "name_branch", requestId: "r20", projectId: PROJECT, text: "Fix it", model: MODEL }),
    );

    expect(calls).toStrictEqual([
      ["subscribeIndex", "connection-7", undefined],
      ["subscribeIndex", "connection-7", { generation: "h1", seq: 4 }],
      ["addProject", "/work/app"],
      ["removeProject", PROJECT],
      ["renameProject", PROJECT, "app"],
      ["renameWorkspace", WORKSPACE, null],
      ["windowFocused"],
      ["setPreferences", { appearance: "dark", titleModel: null }],
      ["setPreferences", { setupDone: true, appearance: "light", proxy: PROXY }],
      ["setPreferences", {}],
      ["listModels", WORKSPACE, false],
      ["listModels", null, true],
      ["setPreferences", { statusBar: { cost: true }, titleModel: MODEL, proxy: null, inbox: false }],
      ["checkSetup", false],
      ["checkSetup", true],
      ["renameChat", CHAT, "合并原理"],
      ["archiveWorkspace", WORKSPACE],
      ["restoreWorkspace", WORKSPACE],
      ["listBases", PROJECT],
      ["createWorkspace", PROJECT, "atrium/a", "main"],
      ["nameBranch", PROJECT, "Fix it", MODEL],
    ]);
    expect(sent[20]).toStrictEqual({
      type: "response",
      requestId: "r20",
      ok: true,
      result: { branch: "atrium/fix-it" },
    });
    expect(sent[19]).toStrictEqual({
      type: "response",
      requestId: "r19",
      ok: true,
      result: { workspaceId: WORKSPACE },
    });
    expect(sent[14]).toStrictEqual({ type: "response", requestId: "r14", ok: true, result: SETUP });
    expect(sent[2]).toStrictEqual({ type: "response", requestId: "r2", ok: true, result: { projectId: PROJECT } });
    expect(sent[10]).toStrictEqual({
      type: "response",
      requestId: "r10",
      ok: true,
      result: { models: [], defaultModel: null },
    });
  });

  it("sends a connection the list changes waiting for it before answering any of its commands", async () => {
    const answered: [string, number][] = [];
    const setup = setUp((connectionId) => answered.push([connectionId, setup.sent.length]));

    await setup.route(setup.connection, withTrace({ type: "open_session", requestId: "r1", sessionId: "s1" }));
    await setup.route(
      setup.connection,
      withTrace({ type: "prompt", requestId: "r2", sessionId: "s9", text: "missing" }),
    );
    await setup.route(setup.connection, { type: "nonsense", requestId: "r3" });

    expect(answered).toStrictEqual([
      ["connection-7", 0],
      ["connection-7", 1],
    ]);
    expect(setup.sent).toMatchObject([
      { type: "response", ok: true },
      { type: "response", ok: false },
      { type: "response", ok: false },
    ]);
    expect(setup.sent).toHaveLength(3);
  });

  it("answers a command though sending the list changes waiting for it failed, logging that", async () => {
    const setup = setUp(() => {
      throw new Error("feed broke");
    });

    await setup.route(setup.connection, withTrace({ type: "open_session", requestId: "r1", sessionId: "s1" }));
    await setup.route(
      setup.connection,
      withTrace({ type: "prompt", requestId: "r2", sessionId: "s9", text: "missing" }),
    );

    expect(setup.sent).toMatchObject([
      { type: "response", requestId: "r1", ok: true },
      { type: "response", requestId: "r2", ok: false, error: { code: "session_not_found" } },
    ]);
    expect(setup.records.filter((record) => record["msg"] === "list changes not sent before an answer")).toMatchObject([
      { level: "warn", err: { message: "feed broke" } },
      { level: "warn", err: { message: "feed broke" } },
    ]);
  });

  it("hands what a connection shows of workspaces' changes to the changes service", async () => {
    const { route, connection, sent, calls } = setUp();

    await route(connection, withTrace({ type: "watch_changes", requestId: "r1", workspaceIds: [WORKSPACE] }));
    await route(
      connection,
      withTrace({ type: "watch_diff", requestId: "r2", target: { workspaceId: WORKSPACE, mode: "base" } }),
    );
    await route(connection, withTrace({ type: "watch_diff", requestId: "r3", target: null }));
    await route(
      connection,
      withTrace({ type: "watch_changes", requestId: "r4", workspaceIds: ["wks_ffffffffffffffff"] }),
    );

    expect(calls).toStrictEqual([
      ["watchChanges", "connection-7", WORKSPACE],
      ["watchDiff", "connection-7", { workspaceId: WORKSPACE, mode: "base" }],
      ["watchDiff", "connection-7", null],
      ["watchChanges", "connection-7", "wks_ffffffffffffffff"],
    ]);
    expect(sent).toStrictEqual([
      { type: "response", requestId: "r1", ok: true, result: {} },
      { type: "response", requestId: "r2", ok: true, result: {} },
      { type: "response", requestId: "r3", ok: true, result: {} },
      {
        type: "response",
        requestId: "r4",
        ok: false,
        error: { code: "workspace_not_found", params: { workspaceId: "wks_ffffffffffffffff" } },
      },
    ]);
  });

  it("hands listing a directory and reading a file to the workspace files", async () => {
    const { route, connection, sent, calls } = setUp();

    await route(connection, withTrace({ type: "list_dir", requestId: "r1", workspaceId: WORKSPACE, path: "src" }));
    await route(connection, withTrace({ type: "read_file", requestId: "r2", workspaceId: WORKSPACE, path: "a.ts" }));
    await route(connection, withTrace({ type: "list_dir", requestId: "r3", workspaceId: WORKSPACE, path: "gone" }));

    expect(calls).toStrictEqual([
      ["listDir", WORKSPACE, "src"],
      ["readFile", WORKSPACE, "a.ts"],
      ["listDir", WORKSPACE, "gone"],
    ]);
    expect(sent).toStrictEqual([
      {
        type: "response",
        requestId: "r1",
        ok: true,
        result: { entries: [{ name: "a.ts", kind: "file" }], truncated: false },
      },
      { type: "response", requestId: "r2", ok: true, result: { size: 1, content: { kind: "text", text: "a" } } },
      { type: "response", requestId: "r3", ok: false, error: { code: "path_not_found" } },
    ]);
  });

  it("hands the login commands to the logins", async () => {
    const { route, connection, sent, calls } = setUp();

    await route(connection, withTrace({ type: "login", requestId: "r1", providerId: "acme", method: "oauth" }));
    await route(
      connection,
      withTrace({ type: "login", requestId: "r2", providerId: "acme", method: "api_key", key: "sk-1" }),
    );
    await route(
      connection,
      withTrace({ type: "answer_login", requestId: "r3", loginId: "l1", promptId: 2, value: "42" }),
    );
    await route(connection, withTrace({ type: "cancel_login", requestId: "r4", loginId: "l1" }));
    await route(connection, withTrace({ type: "logout", requestId: "r5", providerId: "acme" }));

    expect(calls).toStrictEqual([
      ["login", { providerId: "acme", method: "oauth" }],
      ["login", { providerId: "acme", method: "api_key", key: "sk-1" }],
      ["answerLogin", "l1", 2, "42"],
      ["cancelLogin", "l1"],
      ["logout", "acme"],
    ]);
    expect(sent).toStrictEqual([
      { type: "response", requestId: "r1", ok: true, result: { loginId: "l1" } },
      { type: "response", requestId: "r2", ok: true, result: { loginId: "l1" } },
      { type: "response", requestId: "r3", ok: true, result: {} },
      { type: "response", requestId: "r4", ok: true, result: {} },
      { type: "response", requestId: "r5", ok: true, result: {} },
    ]);
  });

  it("hands looking for projects in pi's history and choosing the main branch to the list commands", async () => {
    const { route, connection, sent, calls } = setUp();

    await route(connection, withTrace({ type: "discover_projects", requestId: "r1" }));
    await route(connection, withTrace({ type: "list_branches", requestId: "r2", projectId: PROJECT }));
    await route(
      connection,
      withTrace({ type: "set_main_branch", requestId: "r3", projectId: PROJECT, branch: "main" }),
    );

    expect(calls).toStrictEqual([["discoverProjects"], ["listBranches", PROJECT], ["setMainBranch", PROJECT, "main"]]);
    expect(sent).toStrictEqual([
      { type: "response", requestId: "r1", ok: true, result: { directories: [DISCOVERED] } },
      { type: "response", requestId: "r2", ok: true, result: { branches: ["main"], head: "main" } },
      { type: "response", requestId: "r3", ok: true, result: {} },
    ]);
  });

  it("hands the install commands to the installs, and the update check to the latest pi", async () => {
    const { route, connection, sent, calls } = setUp();

    await route(connection, withTrace({ type: "install_pi", requestId: "r1" }));
    await route(connection, withTrace({ type: "install_node", requestId: "r2" }));
    await route(connection, withTrace({ type: "update_pi", requestId: "r3" }));
    await route(connection, withTrace({ type: "cancel_install", requestId: "r4", jobId: "j1" }));
    await route(connection, withTrace({ type: "check_pi_update", requestId: "r5" }));

    expect(calls).toStrictEqual([
      ["install", "install_pi"],
      ["install", "install_node"],
      ["install", "update_pi"],
      ["cancelInstall", "j1"],
      ["checkPiUpdate"],
    ]);
    expect(sent).toStrictEqual([
      { type: "response", requestId: "r1", ok: true, result: { jobId: "j1" } },
      { type: "response", requestId: "r2", ok: true, result: { jobId: "j1" } },
      { type: "response", requestId: "r3", ok: true, result: { jobId: "j1" } },
      { type: "response", requestId: "r4", ok: true, result: {} },
      { type: "response", requestId: "r5", ok: true, result: { latest: "1.1.0", checkedAt: 7 } },
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

describe("createRouter's attachments", () => {
  it("keeps an uploaded image for the connection and hands it to the message that names it", async () => {
    const { route, connection, sent, calls } = setUp();

    await route(
      connection,
      withTrace({ type: "upload_attachment", requestId: "u1", mimeType: "image/webp", data: "AAAA" }),
    );
    await route(
      connection,
      withTrace({ type: "upload_attachment", requestId: "u2", mimeType: "image/png", data: "BBBB" }),
    );
    await route(
      connection,
      withTrace({ type: "prompt", requestId: "p1", sessionId: "s1", text: "看图", attachmentIds: ["a1"] }),
    );
    await route(
      connection,
      withTrace({ type: "steer", requestId: "p2", sessionId: "s1", text: "", attachmentIds: ["a2"] }),
    );
    await route(
      connection,
      withTrace({ type: "prompt", requestId: "p3", sessionId: "s1", text: "again", attachmentIds: ["a1"] }),
    );

    expect(calls).toStrictEqual([
      ["prompt", "s1", "看图", "AAAA"],
      ["steer", "s1", "", "BBBB"],
    ]);
    expect(sent).toStrictEqual([
      { type: "response", requestId: "u1", ok: true, result: { attachmentId: "a1" } },
      { type: "response", requestId: "u2", ok: true, result: { attachmentId: "a2" } },
      { type: "response", requestId: "p1", ok: true, result: { disposition: "started" } },
      { type: "response", requestId: "p2", ok: true, result: { disposition: "queued" } },
      {
        type: "response",
        requestId: "p3",
        ok: false,
        error: { code: "attachment_missing", params: { attachmentId: "a1" } },
      },
    ]);
  });
});
