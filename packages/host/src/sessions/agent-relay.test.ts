import type { AskUserResult, LogEntry } from "@atrium/pi";
import type { CatalogModel, SessionModel } from "@atrium/protocol";
import { FakeClock, present } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import type { AgentRecord, AgentTask, DeliveryRecord } from "../store/agent-records";
import { type AgentHost, type ChildRequest, type SessionState, createAgentRelay } from "./agent-relay";
import type { AgentFields, CatalogEntry } from "./session-catalog";

/** A session that is idle, with its pi running. */
const IDLE: SessionState = { live: true, running: false, asking: false, paused: null, failed: false, queued: 0 };

/** The models the host lists. */
const MODELS: CatalogModel[] = [
  {
    providerId: "faux",
    modelId: "m1",
    name: "M1",
    contextWindow: 1000,
    maxOutput: 100,
    supportsImage: false,
    thinkingLevels: ["off", "low", "high"],
    fast: null,
  },
  {
    providerId: "faux",
    modelId: "m2",
    name: "M2",
    contextWindow: 1000,
    maxOutput: 100,
    supportsImage: false,
    thinkingLevels: ["off"],
    fast: null,
  },
];

/**
 * A session in the index, with whatever `fields` say.
 *
 * @remarks
 * In a workspace, on file, idle, no one's child unless told.
 *
 * @sideEffects none
 * @param sessionId - Its id.
 * @param fields - Fields to set.
 * @returns The entry.
 */
function session(sessionId: string, fields: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    sessionId,
    containerId: "wks_1",
    name: null,
    prompt: sessionId,
    file: `/pi/${sessionId}.jsonl`,
    state: "persisted",
    updatedAt: 1,
    archived: false,
    attention: null,
    handedOff: false,
    model: null,
    parent: null,
    cwd: `/repo/${sessionId}`,
    fast: null,
    usageAfter: null,
    agent: null,
    usedHandles: [],
    deliveries: [],
    ...fields,
  };
}

/**
 * A child the agent opened, with its tasks.
 *
 * @remarks
 * See `session`.
 *
 * @sideEffects none
 * @param sessionId - Its id.
 * @param parent - Its parent.
 * @param handle - Its handle.
 * @param fields - Its role, tasks and anything else.
 * @returns The entry.
 */
function child(
  sessionId: string,
  parent: string,
  handle: string,
  fields: Partial<AgentRecord> & { readonly entry?: Partial<CatalogEntry> } = {},
): CatalogEntry {
  const { entry, ...agent } = fields;
  return session(sessionId, {
    name: handle,
    parent: { sessionId: parent, by: "agent" },
    agent: { handle, role: "explore", toolGuard: "flags", startOn: null, worktree: false, tasks: [], ...agent },
    ...entry,
  });
}

/**
 * An open task.
 *
 * @remarks
 * Given at 1000.
 *
 * @sideEffects none
 * @param taskId - Its id.
 * @param fields - Fields to set.
 * @returns The task.
 */
function task(taskId: string, fields: Partial<AgentTask> = {}): AgentTask {
  return { taskId, state: "open", at: 1000, ...fields };
}

/**
 * Lets the relay's promise callbacks run.
 *
 * @remarks
 * It answers on the host's command a few awaits after a request.
 *
 * @sideEffects none
 * @returns Once they ran.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The argument of a hidden command, decoded.
 *
 * @remarks
 * `/atrium-agent <action> <base64url JSON>` (ADR-0013, point 2).
 *
 * @sideEffects none
 * @param message - The command.
 * @returns The action and the value.
 */
function decode(message: string): { action: string; value: Record<string, unknown> } {
  const [, action = "", argument = ""] = message.split(" ");
  return { action, value: JSON.parse(Buffer.from(argument, "base64url").toString("utf8")) as Record<string, unknown> };
}

/**
 * The relay over a host in memory: an index, pi's that only record, and a clock.
 *
 * @remarks
 * `call` and `note` send what Atrium's extension would, as a session's pi of process 1; `reply`
 * reads the answer the relay sent back.
 *
 * @sideEffects none
 * @param entries - The sessions in the index.
 * @returns The relay and what it did.
 */
function harness(...entries: CatalogEntry[]) {
  const sessions = new Map(entries.map((entry) => [entry.sessionId, entry]));
  const commands: [string, number, ReturnType<typeof decode>][] = [];
  const states = new Map<string, SessionState>();
  const live = new Set(entries.map((entry) => entry.sessionId));
  const tabs = new Set<string>();
  const archiving = new Set<string>();
  const pumped: string[] = [];
  const stopped: string[] = [];
  const started: string[] = [];
  const recycled: string[] = [];
  const removed: string[] = [];
  const notes: string[][] = [];
  const created: ChildRequest[] = [];
  const files = new Map<string, LogEntry[]>();
  const clock = new FakeClock(1000);
  const { logger, records } = recordingTracing();
  let changes = 0;
  let ids = 0;
  let dirs = 0;
  let failCreate: unknown = null;
  let holdCreate: Promise<void> | null = null;
  let holdRecycle: Promise<void> | null = null;
  let failWrites = false;
  /** Sessions whose index writes fail, or wait for a promise first. */
  const failWritesTo = new Set<string>();
  const holdWritesTo = new Map<string, Promise<void>>();
  const resumed: string[] = [];
  /** The `ask_user` calls the controllers hold, by `session#call`, with how to answer them. */
  const asked = new Map<string, (result: AskUserResult | null) => void>();
  /** The `ask_user` calls dropped, as `session#call`. */
  const dropped: string[] = [];
  let failStarts = false;
  let workChanges: Awaited<ReturnType<AgentHost["workChanges"]>> = { branch: null, changes: null };
  let model: SessionModel | null = { providerId: "faux", modelId: "m1", thinkingLevel: "high" };
  const host: AgentHost = {
    catalog: {
      list: () => [...sessions.values()],
      find: (id) => sessions.get(id),
      changeAgent: async (id, change) => {
        if (failWrites || failWritesTo.has(id)) throw new Error("index not written");
        const hold = holdWritesTo.get(id);
        holdWritesTo.delete(id);
        await hold;
        const entry = sessions.get(id);
        if (entry === undefined) return;
        const fields: AgentFields = {
          agent: entry.agent,
          usedHandles: entry.usedHandles,
          deliveries: entry.deliveries,
        };
        sessions.set(id, { ...entry, ...change(fields) });
      },
    },
    clock,
    newId: () => `id${String(++ids)}`,
    logger,
    command: async (sessionId, epoch, message) => {
      commands.push([sessionId, epoch, decode(message)]);
      return true;
    },
    controller: (sessionId) =>
      live.has(sessionId)
        ? ({
            deliveriesChanged: () => pumped.push(sessionId),
            askUser: (id: string) => {
              const { promise, resolve } = Promise.withResolvers<AskUserResult | null>();
              asked.set(`${sessionId}#${id}`, resolve);
              return promise;
            },
            dropQuestion: (id: string) => dropped.push(`${sessionId}#${id}`),
            get asking() {
              return [...asked.keys()].some((key) => key.startsWith(`${sessionId}#`));
            },
            stop: async () => {
              stopped.push(sessionId);
              return { confirmed: true };
            },
          } as unknown as ReturnType<AgentHost["controller"]>)
        : undefined,
    state: (sessionId) => states.get(sessionId) ?? { ...IDLE, live: live.has(sessionId) },
    ensureRunning: async (sessionId) => {
      if (failStarts) throw new Error("pi did not start");
      started.push(sessionId);
      live.add(sessionId);
    },
    resumeQueue: async (sessionId) => {
      resumed.push(sessionId);
    },
    workChanges: async () => workChanges,
    recycle: async (sessionId) => {
      live.delete(sessionId);
      await holdRecycle;
      recycled.push(sessionId);
    },
    tabOpen: (sessionId) => tabs.has(sessionId),
    archiving: (sessionId) => archiving.has(sessionId),
    canBranch: (sessionId) => sessions.get(sessionId)?.containerId.startsWith("wks_") === true,
    createChild: async (request) => {
      if (failCreate !== null) throw failCreate;
      await holdCreate;
      created.push(request);
      const id = `c${String(created.length)}`;
      const worktree = request.worktree
        ? { dir: `/repo.worktrees/${request.agent.handle}`, branch: `agent/${request.agent.handle}` }
        : null;
      sessions.set(
        id,
        session(id, {
          name: request.agent.handle,
          file: null,
          state: "draft",
          parent: { sessionId: request.parentId, by: "agent" },
          agent: { ...request.agent, worktree: worktree !== null },
          cwd: worktree?.dir ?? `/repo/${request.parentId}`,
        }),
      );
      return { sessionId: id, worktree };
    },
    models: async () => MODELS,
    modelOf: () => model,
    readEntries: async (file) => files.get(file) ?? [],
    noteMoved: async (sessionId, from, to) => {
      notes.push([sessionId, from, to]);
    },
    tempDir: async () => `/home/tmp/b${String(++dirs)}`,
    removeDir: async (dir) => {
      removed.push(dir);
    },
    changed: () => {
      changes += 1;
    },
  };
  const relay = createAgentRelay(host);
  let calls = 0;

  /**
   * What the relay answered a call with.
   *
   * @remarks
   * `undefined` while it has not.
   *
   * @sideEffects none
   * @param id - The call's id.
   * @returns The answer.
   */
  const reply = (id: string): Record<string, unknown> | undefined =>
    commands.find(([, , sent]) => sent.action === "reply" && sent.value["id"] === id)?.[2].value;

  return {
    relay,
    sessions,
    commands,
    states,
    live,
    tabs,
    archiving,
    pumped,
    stopped,
    started,
    recycled,
    removed,
    notes,
    created,
    files,
    clock,
    records,
    reply,
    changes: () => changes,
    failCreate: (error: unknown) => {
      failCreate = error;
    },
    /** Keeps the children being created until `until` settles, as a worktree being made does. */
    holdCreate: (until: Promise<void>) => {
      holdCreate = until;
    },
    /** Keeps the pi's being stopped until `until` settles; their controllers are gone at once. */
    holdRecycle: (until: Promise<void>) => {
      holdRecycle = until;
    },
    /** Makes every write of the index fail from now on, as a full disk does. */
    failWrites: () => {
      failWrites = true;
    },
    /** Makes the index writes of one session fail from now on. */
    failWritesTo: (id: string) => {
      failWritesTo.add(id);
    },
    /** Keeps the next index write of one session until `until` settles; the ones after it go at once. */
    holdWritesTo: (id: string, until: Promise<void>) => {
      holdWritesTo.set(id, until);
    },
    resumed,
    asked,
    dropped,
    /** Makes every start of pi fail from now on. */
    failStarts: () => {
      failStarts = true;
    },
    /** What a `work` child's worktree changed, as the host reads it. */
    setWorkChanges: (next: Awaited<ReturnType<AgentHost["workChanges"]>>) => {
      workChanges = next;
    },
    setModel: (next: SessionModel | null) => {
      model = next;
    },
    entry: (id: string) => present(sessions.get(id), id),
    /** Sends a call as a session's extension would; resolves once the relay had time to answer. */
    call: async (sessionId: string, op: string, args: Record<string, unknown>, id = `call-${String(++calls)}`) => {
      relay.request(sessionId, 1, JSON.stringify({ v: 1, id, kind: "call", op, args }));
      await settle();
      return { id, answer: reply(id) };
    },
    /** Sends a note as a session's extension would. */
    note: async (sessionId: string, op: string, args: Record<string, unknown>) => {
      relay.request(sessionId, 1, JSON.stringify({ v: 1, id: `n${String(++calls)}`, kind: "note", op, args }));
      await settle();
    },
  };
}

/**
 * How many times the relay sent a child's extension the answer to a question.
 *
 * @sideEffects none
 * @param commands - The hidden commands sent, as the harness keeps them.
 * @param questionId - The question.
 * @returns The count.
 */
function repliesTo(commands: readonly [string, number, ReturnType<typeof decode>][], questionId: string): number {
  return commands.filter(([, , sent]) => sent.action === "reply" && sent.value["id"] === questionId).length;
}

/**
 * The answers the relay sent a session's extension for one request id, in order.
 *
 * @sideEffects none
 * @param commands - The hidden commands sent, as the harness keeps them.
 * @param id - The request.
 * @returns The answers.
 */
function replyValues(
  commands: readonly [string, number, ReturnType<typeof decode>][],
  id: string,
): Record<string, unknown>[] {
  return commands.flatMap(([, , sent]) => (sent.action === "reply" && sent.value["id"] === id ? [sent.value] : []));
}

/**
 * The children an `agent_list` answer listed, as name, status and place.
 *
 * @sideEffects none
 * @param answer - The answer the extension was sent.
 * @returns One each.
 */
function listedChildren(answer: unknown): unknown[] {
  const children: unknown = Reflect.get(Object(Reflect.get(Object(answer), "result")), "children");
  return Array.isArray(children)
    ? children.map((one: unknown) => ["name", "status", "place"].map((key) => Reflect.get(Object(one), key)))
    : [];
}

describe("agent relay: agent_spawn's checks", () => {
  it("answers each check that fails with its code, in the SPEC's order", async () => {
    const deep = harness(
      session("main"),
      child("c1", "main", "a", { role: "work" }),
      child("c2", "c1", "b", { role: "work" }),
    );
    const caller = harness(
      session("main", { usedHandles: ["taken"] }),
      child("reader", "main", "reader"),
      child("adviser", "main", "adviser", { role: "advise" }),
      session("chat", { containerId: "cht_x" }),
    );
    caller.archiving.add("main");

    const answers = [
      (await deep.call("c2", "spawn", { name: "x", task: "t" })).answer,
      (await caller.call("chat", "spawn", { name: "Bad", task: "t" })).answer,
      (await caller.call("main", "spawn", { name: "taken", task: "t" })).answer,
      (await caller.call("main", "spawn", { name: "fresh", task: "t" })).answer,
      (await caller.call("reader", "spawn", { name: "w", task: "t", role: "work" })).answer,
      (await caller.call("adviser", "spawn", { name: "w", task: "t", role: "work" })).answer,
      (await caller.call("reader", "spawn", { name: "w", task: "t", place: "worktree" })).answer,
      (await caller.call("chat", "spawn", { name: "w", task: "t", role: "work", place: "worktree" })).answer,
      (await caller.call("chat", "spawn", { name: "w", task: "t", model: "faux/nope" })).answer,
      (await caller.call("chat", "spawn", { name: "w", task: "t", model: "faux/m2", thinking: "high" })).answer,
      (await caller.call("chat", "spawn", { name: "w", task: "t", context: "fork", branch: "/elsewhere/b.jsonl" }))
        .answer,
    ];

    expect(answers.map((answer) => [answer?.["code"], answer?.["params"]])).toStrictEqual([
      ["agent_depth_limit", undefined],
      ["agent_name_invalid", undefined],
      ["agent_name_taken", undefined],
      ["agent_busy", undefined],
      ["agent_role_not_allowed", undefined],
      ["agent_role_not_allowed", undefined],
      ["agent_place_invalid", undefined],
      ["agent_place_invalid", undefined],
      ["agent_model_unknown", undefined],
      ["agent_thinking_invalid", { supported: ["off"] }],
      ["agent_context_unavailable", undefined],
    ]);
    expect([deep.created, caller.created]).toStrictEqual([[], []]);
  });

  it("allows six unfinished children, counting those being created, and names the six when full", async () => {
    const { call, states } = harness(
      session("main"),
      ...["a", "b", "c", "d", "e"].map((handle) => child(`k-${handle}`, "main", handle)),
      child("k-idle", "main", "idle"),
    );
    for (const handle of ["a", "b", "c", "d", "e"]) states.set(`k-${handle}`, { ...IDLE, running: true });

    const sixth = await call("main", "spawn", { name: "f", task: "t" });
    const seventh = await call("main", "spawn", { name: "g", task: "t" });

    expect(sixth.answer).toMatchObject({ ok: true, result: { name: "f", status: "creating" } });
    expect(seventh.answer).toStrictEqual({
      v: 1,
      id: seventh.id,
      ok: false,
      code: "agent_limit",
      params: { children: ["a", "b", "c", "d", "e", "f"] },
    });
  });

  it("answers a failed worktree with its reason, and anything unexpected as agent_failed, logged", async () => {
    const { call, failCreate, records } = harness(session("main"));
    failCreate(Object.assign(new Error("x"), { code: "worktree_create_failed" }));
    const place = await call("main", "spawn", { name: "a", task: "t", role: "work" });
    failCreate(new Error("disk full"));
    const broken = await call("main", "spawn", { name: "b", task: "t" });

    expect(place.answer).toMatchObject({
      ok: false,
      code: "agent_place_failed",
      params: { reason: "worktree_create_failed" },
    });
    expect(broken.answer).toMatchObject({ ok: false, code: "agent_failed" });
    expect(records).toContainEqual(expect.objectContaining({ msg: "agent call failed", op: "spawn" }));
  });
});

describe("agent relay: opening a child", () => {
  it("records the handle, opens the child with its first task waiting, starts its pi and hands it the task", async () => {
    const { call, created, entry, started, pumped, changes } = harness(session("main"));

    const { answer } = await call("main", "spawn", { name: "audit", task: "look at auth", role: "advise" });

    expect(answer).toStrictEqual({
      v: 1,
      id: "call-1",
      ok: true,
      result: {
        name: "audit",
        sessionId: "c1",
        taskId: "t-id1",
        role: "advise",
        place: "same",
        model: "faux/m1",
        thinking: "high",
        status: "creating",
      },
    });
    expect(entry("main").usedHandles).toStrictEqual(["audit"]);
    expect(created).toStrictEqual([
      {
        parentId: "main",
        agent: {
          handle: "audit",
          role: "advise",
          toolGuard: "flags",
          startOn: { providerId: "faux", modelId: "m1", thinkingLevel: "high" },
          worktree: false,
          tasks: [{ taskId: "t-id1", state: "open", at: 1000 }],
        },
        worktree: false,
        branchFile: null,
        fallback: true,
      },
    ]);
    expect(entry("c1").deliveries).toStrictEqual([
      { id: "id2", kind: "task", from: "main", taskId: "t-id1", text: "look at auth", at: 1000, state: "waiting" },
    ]);
    expect(started).toStrictEqual(["c1"]);
    expect(pumped).toStrictEqual(["c1"]);
    expect(changes()).toBeGreaterThan(0);
  });

  it("puts a work child in its own worktree by default, and the level wanted where the model has it", async () => {
    const { call, created, setModel } = harness(session("main"));
    setModel({ providerId: "faux", modelId: "m1", thinkingLevel: "minimal" });

    const { answer } = await call("main", "spawn", { name: "tests", task: "t", role: "work" });
    const other = await call("main", "spawn", { name: "other", task: "t", model: "faux/m2" });

    expect(answer).toMatchObject({
      result: { place: "worktree", workspace: "/repo.worktrees/tests", branch: "agent/tests", thinking: "low" },
    });
    expect(other.answer).toMatchObject({ result: { model: "faux/m2", thinking: "off" } });
    expect(created.map((request) => [request.worktree, request.fallback])).toStrictEqual([
      [true, true],
      [false, true],
    ]);
  });

  it("starts a child with its parent's conversation from the branch cut in a directory this process got, then removes it", async () => {
    const { call, created, removed, notes } = harness(session("main"));

    const dir = await call("main", "branch", {}, "call-1/branch");
    const { answer } = await call("main", "spawn", {
      name: "tests",
      task: "t",
      role: "work",
      context: "fork",
      branch: "/home/tmp/b1/s.jsonl",
    });
    await settle();

    expect(dir.answer).toMatchObject({ ok: true, result: { dir: "/home/tmp/b1" } });
    expect(answer).toMatchObject({ ok: true });
    expect(created[0]).toMatchObject({ agent: { toolGuard: "extension" }, branchFile: "/home/tmp/b1/s.jsonl" });
    expect(removed).toStrictEqual(["/home/tmp/b1"]);
    expect(notes).toStrictEqual([["c1", "/repo/main", "/repo.worktrees/tests"]]);
  });

  it("picks the level next up from the parent's that the model supports, else the next down", async () => {
    const { call, setModel } = harness(session("main"));

    setModel({ providerId: "faux", modelId: "m1", thinkingLevel: "medium" });
    const medium = await call("main", "spawn", { name: "a", task: "t" });
    setModel({ providerId: "faux", modelId: "m1", thinkingLevel: "max" });
    const max = await call("main", "spawn", { name: "b", task: "t" });

    expect([medium.answer, max.answer]).toMatchObject([
      { ok: true, result: { thinking: "high" } },
      { ok: true, result: { thinking: "high" } },
    ]);
  });

  it("gives a grandchild, opened or set to work, the task its parent's run is on, and none once its parent is detached", async () => {
    const h = harness(
      session("main"),
      child("w1", "main", "audit", { role: "work", tasks: [task("t-1")] }),
      child("w2", "w1", "deep", { tasks: [task("t-0", { state: "done" })] }),
    );
    await runTaskStarted(h, "w1", "t-1");

    await h.call("w1", "spawn", { name: "probe", task: "t" });
    await h.call("w1", "send", { to: "deep", message: "more" });
    // Detached as its run goes on: the task it was on ended there.
    h.sessions.set("w1", { ...h.entry("w1"), parent: null });
    await h.relay.ended("w1", "detached", "main");
    await h.call("w1", "spawn", { name: "after", task: "t" });

    expect(h.created.map((request) => request.agent.tasks)).toStrictEqual([
      [{ taskId: "t-id1", state: "open", at: 1000, originTask: "t-1" }],
      [{ taskId: "t-id6", state: "open", at: 1000 }],
    ]);
    expect(h.entry("w2").agent?.tasks).toStrictEqual([
      task("t-0", { state: "done" }),
      { taskId: "t-id3", state: "open", at: 1000, originTask: "t-1" },
    ]);
  });
});

/**
 * A reply entry in a child's file.
 *
 * @remarks
 * Only what the relay reads: its id and text.
 *
 * @sideEffects none
 * @param id - The entry's id.
 * @param text - The reply.
 * @returns The entry.
 */
function replied(id: string, text: string): LogEntry {
  return {
    id,
    parentId: null,
    kind: "assistant",
    parts: [{ type: "text", text }],
    stopReason: "stop",
    errorMessage: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null },
    timestamp: 0,
  };
}

/**
 * A task's message in a child's file.
 *
 * @remarks
 * As Atrium's extension writes it.
 *
 * @sideEffects none
 * @param id - The entry's id.
 * @param taskId - The task.
 * @returns The entry.
 */
function taskEntry(id: string, taskId: string): LogEntry {
  return {
    id,
    parentId: null,
    timestamp: 0,
    kind: "agent",
    details: { v: 1, kind: "task", deliveries: ["d"], from: "main", fromTitle: "m", taskId, text: "t" },
  };
}

/**
 * Notices delivered in a child's file, from the children below it.
 *
 * @remarks
 * As Atrium's extension writes them; they do not end the task's run.
 *
 * @sideEffects none
 * @param id - The entry's id.
 * @returns The entry.
 */
function reportEntry(id: string): LogEntry {
  return {
    id,
    parentId: null,
    timestamp: 0,
    kind: "agent",
    details: { v: 1, kind: "report", deliveries: ["d"], events: [] },
  };
}

/**
 * A notice waiting for a parent.
 *
 * @remarks
 * From child `c1`.
 *
 * @sideEffects none
 * @param id - Its id.
 * @param taskId - The child's task.
 * @param event - What happened.
 * @param fields - Fields to set.
 * @returns The delivery.
 */
function notice(
  id: string,
  taskId: string,
  event: DeliveryRecord["event"],
  fields: Partial<DeliveryRecord> = {},
): DeliveryRecord {
  return { id, kind: "report", from: "c1", taskId, event, at: 1000, state: "waiting", ...fields };
}

describe("agent relay: tasks and notices", () => {
  it("words a child's first task with who it is, and later ones without", async () => {
    const { relay } = harness(
      session("main", { name: "修复" }),
      child("c1", "main", "audit", {
        role: "work",
        toolGuard: "extension",
        worktree: true,
        tasks: [task("t-1"), task("t-2")],
        entry: {
          cwd: "/repo.worktrees/audit",
          deliveries: [
            { id: "k1", kind: "task", from: "main", taskId: "t-1", text: "first", at: 1, state: "waiting" },
            { id: "k2", kind: "task", from: "main", taskId: "t-2", text: "second", at: 2, state: "waiting" },
          ],
        },
      }),
    );
    const deliveries = relay.deliveries("c1");

    const first = decode(present(await deliveries.command(["k1"]), "the first"));
    const second = decode(present(await deliveries.command(["k2"]), "the second"));

    expect(first).toStrictEqual({
      action: "deliver",
      value: {
        v: 1,
        kind: "task",
        deliveries: ["k1"],
        from: "main",
        fromTitle: "修复",
        taskId: "t-1",
        text: "first",
        preamble: { role: "work", forked: true, canSpawn: true, workspace: "/repo.worktrees/audit" },
      },
    });
    expect(second.value).not.toHaveProperty("preamble");
    expect(deliveries.items()).toStrictEqual([
      { id: "k1", kind: "task", fromTitle: "修复", event: null, state: "waiting" },
      { id: "k2", kind: "task", fromTitle: "修复", event: null, state: "waiting" },
    ]);
  });

  it("tells the parent a task's run finished, with its reply's entry and time, and stops the idle child's pi", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", {
        tasks: [task("t-1")],
        entry: {
          deliveries: [{ id: "k1", kind: "task", from: "main", taskId: "t-1", text: "t", at: 1, state: "sending" }],
        },
      }),
    );
    const deliveries = h.relay.deliveries("c1");
    deliveries.runStarted({ deliveries: ["k1"] });
    await deliveries.confirm(["k1"]);
    h.clock.advance(192_000);

    deliveries.runSettled("completed", false, Promise.resolve("a9"));
    await settle();

    expect(h.entry("main").deliveries).toStrictEqual([
      {
        id: "id1",
        kind: "report",
        from: "c1",
        taskId: "t-1",
        event: "finished",
        replyEntry: "a9",
        at: 193_000,
        state: "waiting",
        elapsedMs: 192_000,
      },
    ]);
    expect(h.entry("c1").agent?.tasks).toStrictEqual([{ ...task("t-1"), state: "done", replyEntry: "a9" }]);
    expect(h.pumped).toContain("main");
    expect(h.recycled).toStrictEqual(["c1"]);
  });

  it("gives when the child's open task was handed down, the next one's once it is done, and none once all are", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", {
        tasks: [task("t-0", { state: "done", at: 500 }), task("t-1"), task("t-2", { at: 5000 })],
        entry: {
          deliveries: [
            { id: "k1", kind: "task", from: "main", taskId: "t-1", text: "t", at: 1000, state: "sending" },
            { id: "k2", kind: "task", from: "main", taskId: "t-2", text: "t", at: 5000, state: "sending" },
          ],
        },
      }),
    );
    const deliveries = h.relay.deliveries("c1");
    const first = h.relay.summary("c1").agent;
    deliveries.runStarted({ deliveries: ["k1"] });
    await deliveries.confirm(["k1"]);
    deliveries.runSettled("completed", false, Promise.resolve("a1"));
    await settle();
    const second = h.relay.summary("c1").agent;
    deliveries.runStarted({ deliveries: ["k2"] });
    await deliveries.confirm(["k2"]);
    deliveries.runSettled("completed", false, Promise.resolve("a2"));
    await settle();

    expect(
      [first, second, h.relay.summary("c1").agent].map((agent) => [
        Reflect.get(Object(agent), "taskId"),
        Reflect.get(Object(agent), "taskStartedAt"),
      ]),
    ).toStrictEqual([
      ["t-1", 1000],
      ["t-2", 5000],
      [null, null],
    ]);
  });

  it("does not tell the parent of a turn you opened in the child, nor stop the pi of a child with a tab", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    h.tabs.add("c1");
    const deliveries = h.relay.deliveries("c1");

    deliveries.runStarted("user");
    deliveries.runSettled("completed", false, Promise.resolve("a1"));
    await settle();
    await h.call("c1", "ask", { question: "q" }, "ask-1");

    expect(h.entry("main").deliveries).toStrictEqual([]);
    expect(h.recycled).toStrictEqual([]);
    expect(h.reply("ask-1")).toMatchObject({ ok: true, result: { answered: false, reason: "user_turn" } });
  });

  it("calls a stopped run stopped, by whom, and a failed one failed; a crashed one waits for the restart or its end", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", { tasks: [task("t-1"), task("t-2"), task("t-3")] }),
    );
    h.states.set("c1", { ...IDLE, running: true });
    const deliveries = h.relay.deliveries("c1");
    deliveries.runStarted({ deliveries: [] });
    // A run nothing opened carries no task: nothing is told.
    deliveries.runSettled("failed", false, Promise.resolve(null));
    await settle();

    h.sessions.set("c1", {
      ...h.entry("c1"),
      deliveries: [
        { id: "k1", kind: "task", from: "main", taskId: "t-1", text: "t", at: 1, state: "sending" },
        { id: "k2", kind: "task", from: "main", taskId: "t-2", text: "t", at: 1, state: "sending" },
        { id: "k3", kind: "task", from: "main", taskId: "t-3", text: "t", at: 1, state: "sending" },
      ],
    });
    deliveries.runStarted({ deliveries: ["k1"] });
    await h.call("main", "stop", { to: "audit" });
    deliveries.runSettled("stopped", false, Promise.resolve(null));
    await settle();
    deliveries.runStarted({ deliveries: ["k2"] });
    deliveries.runSettled("failed", true, Promise.resolve(null));
    deliveries.runStarted("auto");
    deliveries.runSettled("failed", false, Promise.resolve(null));
    await settle();
    deliveries.runStarted({ deliveries: ["k3"] });
    deliveries.runSettled("failed", true, Promise.resolve(null));
    deliveries.gaveUp();
    await settle();

    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.event, one.reason])).toStrictEqual([
      ["t-1", "stopped", "agent_stop"],
      ["t-2", "failed", undefined],
      ["t-3", "failed", "crashed"],
    ]);
  });

  it("words notices for the parent with the reply read from the child's file, cut to 4000, and progress once", async () => {
    const h = harness(
      session("main", {
        deliveries: [
          notice("n1", "t-1", "finished", { replyEntry: "a1", elapsedMs: 5 }),
          notice("n2", "t-2", "question", { questionId: "q9" }),
        ],
      }),
      child("c1", "main", "audit", {
        worktree: true,
        role: "work",
        tasks: [task("t-1", { state: "done" }), task("t-2")],
        entry: { name: "审查", cwd: "/w" },
      }),
    );
    h.files.set("/pi/c1.jsonl", [replied("a1", "x".repeat(4001))]);
    await h.note("c1", "progress", { message: "half" });

    const command = decode(present(await h.relay.deliveries("main").command(["n1"]), "the command"));
    const again = decode(present(await h.relay.deliveries("main").command(["n1"]), "the command again"));
    const gone = await h.relay.deliveries("main").command(["n2"]);

    expect(command.value).toStrictEqual({
      v: 1,
      kind: "report",
      deliveries: ["n1"],
      events: [
        {
          name: "audit",
          title: "审查",
          sessionId: "c1",
          taskId: "t-1",
          event: "finished",
          elapsedMs: 5,
          reply: { text: "x".repeat(4000), totalChars: 4001 },
          workspace: "/w",
        },
      ],
      progress: [{ name: "audit", title: "审查", message: "half" }],
    });
    expect(again.value["progress"]).toStrictEqual([]);
    expect(gone).not.toBeNull();
    expect(h.relay.deliveries("main").items()).toStrictEqual([
      { id: "n1", kind: "report", fromTitle: "审查", event: "finished", state: "waiting" },
      { id: "n2", kind: "report", fromTitle: "审查", event: "question", state: "waiting" },
    ]);
  });

  it("drops what goes to a session archived, keeps what goes to one handed off or held, and starts one asleep", async () => {
    const h = harness(
      session("main"),
      session("gone", { archived: true, deliveries: [notice("n1", "t-1", "finished")] }),
      session("away", { handedOff: true, deliveries: [notice("n2", "t-1", "finished")] }),
      child("c1", "main", "audit", { tasks: [task("t-1")] }),
    );
    h.live.delete("main");
    const deliveries = h.relay.deliveries("c1");
    h.sessions.set("c1", {
      ...h.entry("c1"),
      deliveries: [{ id: "k1", kind: "task", from: "main", taskId: "t-1", text: "t", at: 1, state: "sending" }],
    });
    deliveries.runStarted({ deliveries: ["k1"] });
    deliveries.runSettled("completed", false, Promise.resolve(null));
    await settle();
    h.relay.takenBack("gone");
    h.relay.takenBack("away");
    await settle();

    expect(h.started).toStrictEqual(["main"]);
    expect(h.entry("gone").deliveries).toStrictEqual([]);
    expect(h.entry("away").deliveries.map((one) => one.id)).toStrictEqual(["n2"]);
  });

  it("counts a child still being created against the six when one asleep would start", async () => {
    const waitingTask: DeliveryRecord = {
      id: "w1",
      kind: "task",
      from: "main",
      taskId: "t-z",
      text: "t",
      at: 1,
      state: "waiting",
    };
    const h = harness(
      session("main"),
      ...["a", "b", "c", "d", "e"].map((handle) =>
        child(`k-${handle}`, "main", handle, { tasks: [task(`t-${handle}`)] }),
      ),
      child("asleep", "main", "asleep", { tasks: [task("t-z")] }),
    );
    for (const handle of ["a", "b", "c", "d", "e"]) h.states.set(`k-${handle}`, { ...IDLE, running: true });
    h.live.delete("asleep");
    const made = Promise.withResolvers<void>();
    h.holdCreate(made.promise);

    const spawned = h.call("main", "spawn", { name: "sixth", task: "t" }, "spawn-1");
    await settle();
    h.sessions.set("asleep", { ...h.entry("asleep"), deliveries: [waitingTask] });
    h.relay.takenBack("asleep");
    await settle();
    const whileCreating = [...h.started];
    made.resolve();
    await spawned;
    await settle();

    expect(whileCreating).toStrictEqual([]);
    expect(h.reply("spawn-1")).toMatchObject({ ok: true });
  });

  it("starts a child asleep only within its parent's six, and once a sibling settles, the one waiting", async () => {
    const waitingTask: DeliveryRecord = {
      id: "w1",
      kind: "task",
      from: "main",
      taskId: "t-z",
      text: "t",
      at: 1,
      state: "waiting",
    };
    const h = harness(
      session("main"),
      ...["a", "b", "c", "d", "e", "f"].map((handle) =>
        child(`k-${handle}`, "main", handle, { tasks: [task(`t-${handle}`)] }),
      ),
      child("asleep", "main", "asleep", { tasks: [task("t-z")], entry: { deliveries: [waitingTask] } }),
    );
    for (const handle of ["a", "b", "c", "d", "e", "f"]) h.states.set(`k-${handle}`, { ...IDLE, running: true });
    h.live.delete("asleep");

    h.relay.takenBack("asleep");
    await settle();
    const full = [...h.started];
    h.states.set("k-a", IDLE);
    const deliveries = h.relay.deliveries("k-a");
    h.sessions.set("k-a", {
      ...h.entry("k-a"),
      deliveries: [{ id: "x", kind: "task", from: "main", taskId: "t-a", text: "t", at: 1, state: "sending" }],
    });
    deliveries.runStarted({ deliveries: ["x"] });
    await deliveries.confirm(["x"]);
    deliveries.runSettled("completed", false, Promise.resolve(null));
    await settle();

    expect(full).toStrictEqual([]);
    expect(h.started).toStrictEqual(["asleep"]);
    expect(h.pumped).toContain("asleep");
  });

  it("gives a work child's workspace only with its finished event", async () => {
    const h = harness(
      session("main", { deliveries: [notice("n1", "t-1", "failed", { reason: "crashed" })] }),
      child("c1", "main", "audit", {
        worktree: true,
        role: "work",
        tasks: [task("t-1", { state: "done" })],
        entry: { cwd: "/w" },
      }),
    );

    const command = decode(present(await h.relay.deliveries("main").command(["n1"]), "the command"));

    expect(command.value["events"]).toStrictEqual([
      { name: "audit", title: "audit", sessionId: "c1", taskId: "t-1", event: "failed", reason: "crashed" },
    ]);
  });

  it("hands no task to a session the agent did not open or one whose text is gone, nor notices of a child gone", async () => {
    const h = harness(
      session("main", {
        deliveries: [
          { id: "m1", kind: "task", from: "x", taskId: "t-9", text: "t", at: 1, state: "waiting" },
          notice("n1", "t-1", "finished"),
        ],
      }),
      child("k1", "main", "a", {
        tasks: [task("t-2")],
        entry: { deliveries: [{ id: "g1", kind: "task", from: "main", taskId: "t-2", at: 1, state: "waiting" }] },
      }),
    );

    const commands = [
      await h.relay.deliveries("main").command(["m1"]),
      await h.relay.deliveries("k1").command(["g1"]),
      await h.relay.deliveries("main").command(["n1"]),
    ];

    expect(commands).toStrictEqual([null, null, null]);
  });

  it("tells a child at depth 2, in its first task, that it opens none", async () => {
    const h = harness(
      session("main"),
      child("k1", "main", "a", { tasks: [task("t-1")] }),
      child("k2", "k1", "b", {
        tasks: [task("t-3")],
        entry: {
          deliveries: [{ id: "d1", kind: "task", from: "k1", taskId: "t-3", text: "go", at: 1, state: "waiting" }],
        },
      }),
    );

    const command = decode(present(await h.relay.deliveries("k2").command(["d1"]), "the command"));

    expect(command.value["preamble"]).toStrictEqual({ role: "explore", forked: false, canSpawn: false });
  });

  it("tells the summaries when a child's run begins and when its event goes to the parent", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", {
        tasks: [task("t-1")],
        entry: {
          deliveries: [{ id: "k1", kind: "task", from: "main", taskId: "t-1", text: "t", at: 1, state: "sending" }],
        },
      }),
    );
    const deliveries = h.relay.deliveries("c1");
    const before = h.changes();

    deliveries.runStarted({ deliveries: ["k1"] });
    const begun = h.changes();
    await deliveries.confirm(["k1"]);
    const confirmed = h.changes();
    deliveries.runSettled("completed", false, Promise.resolve(null));
    await settle();

    expect([begun - before, h.changes() - confirmed]).toStrictEqual([1, 1]);
  });

  it("tells the parent of a child archived mid-run that it ended, not also how its run ended", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    await runTaskStarted(h, "c1", "t-1");

    await h.relay.ended("c1", "archived");
    h.relay.deliveries("c1").runSettled("stopped", false, Promise.resolve(null));
    await settle();

    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.event, one.reason])).toStrictEqual([
      ["t-1", "ended", "archived"],
    ]);
  });

  it("stops the pi of a child without a tab once a run ends idle, a task's or one you opened", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", { tasks: [task("t-1")] }),
      child("c2", "main", "tests"),
    );
    h.states.set("c1", { ...IDLE, running: true });
    await runTaskStarted(h, "c1", "t-1");
    h.states.set("c1", IDLE);
    const deliveries = h.relay.deliveries("c2");

    h.relay.deliveries("c1").runSettled("completed", false, Promise.resolve(null));
    await settle();
    deliveries.runStarted("user");
    deliveries.runSettled("completed", false, Promise.resolve(null));
    await settle();

    expect(h.recycled).toStrictEqual(["c1", "c2"]);
  });

  it("calls a run you stopped stopped by the user, though agent_stop stopped the one before", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1"), task("t-2")] }));
    h.states.set("c1", { ...IDLE, running: true });
    h.sessions.set("c1", {
      ...h.entry("c1"),
      deliveries: [
        { id: "k1", kind: "task", from: "main", taskId: "t-1", text: "t", at: 1, state: "sending" },
        { id: "k2", kind: "task", from: "main", taskId: "t-2", text: "t", at: 1, state: "sending" },
      ],
    });
    const deliveries = h.relay.deliveries("c1");

    deliveries.runStarted({ deliveries: ["k1"] });
    await h.call("main", "stop", { to: "audit" });
    deliveries.runSettled("stopped", false, Promise.resolve(null));
    await settle();
    deliveries.runStarted({ deliveries: ["k2"] });
    deliveries.runSettled("stopped", false, Promise.resolve(null));
    await settle();

    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.event, one.reason])).toStrictEqual([
      ["t-1", "stopped", "agent_stop"],
      ["t-2", "stopped", "user"],
    ]);
  });

  it("treats a run pi carries on by itself, after giving up on a task, as no task's", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    await runTaskStarted(h, "c1", "t-1");
    const deliveries = h.relay.deliveries("c1");

    deliveries.runSettled("failed", true, Promise.resolve(null));
    deliveries.gaveUp();
    await settle();
    deliveries.runStarted("auto");
    const asked = await h.call("c1", "ask", { question: "?" });

    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.event, one.reason])).toStrictEqual([
      ["t-1", "failed", "crashed"],
    ]);
    expect(asked.answer).toStrictEqual({
      v: 1,
      id: asked.id,
      ok: true,
      result: { answered: false, reason: "user_turn" },
    });
  });

  it("opens a run on notices from below under the task they came of, or a follow-up once that ended", async () => {
    const h = harness(
      session("main"),
      child("w1", "main", "audit", { tasks: [task("t-1")] }),
      child("w2", "w1", "deep", { tasks: [task("t-g", { originTask: "t-1" })] }),
    );
    const deliveries = h.relay.deliveries("w1");
    const done = { ...task("t-1"), state: "done", replyEntry: null };

    h.sessions.set("w1", {
      ...h.entry("w1"),
      deliveries: [notice("r1", "t-g", "needs_you", { from: "w2", state: "sending" })],
    });
    deliveries.runStarted({ deliveries: ["r1"] });
    await deliveries.confirm(["r1"]);
    deliveries.runSettled("completed", false, Promise.resolve(null));
    await settle();
    const underOrigin = h.entry("w1").agent?.tasks;
    h.sessions.set("w1", {
      ...h.entry("w1"),
      deliveries: [notice("r2", "t-g", "finished", { from: "w2", state: "sending" })],
    });
    deliveries.runStarted({ deliveries: ["r2"] });
    await settle();
    const followUp = h.entry("w1").agent?.tasks;
    await deliveries.confirm(["r2"]);
    deliveries.runSettled("completed", false, Promise.resolve(null));
    await settle();
    const command = decode(present(await h.relay.deliveries("main").command(["id3"]), "the command"));

    expect(underOrigin).toStrictEqual([done]);
    expect(followUp).toStrictEqual([done, { taskId: "t-id2", state: "open", at: 1000, followUpOf: "t-1" }]);
    expect(command.value["events"]).toStrictEqual([
      {
        name: "audit",
        title: "audit",
        sessionId: "w1",
        taskId: "t-id2",
        event: "finished",
        followUpOf: "t-1",
        elapsedMs: 0,
      },
    ]);
  });

  it("starts a child's pi again only once its stop before ended", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    const stopping = Promise.withResolvers<void>();
    h.holdRecycle(stopping.promise);
    await runTask(h, "c1", "t-1");

    await h.call("main", "send", { to: "audit", message: "more" });
    const whileStopping = [...h.started];
    stopping.resolve();
    await settle();

    expect(whileStopping).toStrictEqual([]);
    expect([h.recycled, h.started]).toStrictEqual([["c1"], ["c1"]]);
  });
});

/**
 * Settles a child's run on a task, as its controller tells the relay.
 *
 * @remarks
 * The task's delivery opened the run.
 *
 * @sideEffects Changes the index; runs the relay.
 * @param h - The harness.
 * @param childId - The child.
 * @param taskId - The task.
 * @param outcome - How the run ended.
 */
async function runTask(
  h: ReturnType<typeof harness>,
  childId: string,
  taskId: string,
  outcome: "completed" | "stopped" | "failed" = "completed",
): Promise<void> {
  const id = `run-${taskId}`;
  h.sessions.set(childId, {
    ...h.entry(childId),
    deliveries: [{ id, kind: "task", from: "main", taskId, text: "t", at: 1, state: "sending" }],
  });
  const deliveries = h.relay.deliveries(childId);
  deliveries.runStarted({ deliveries: [id] });
  await deliveries.confirm([id]);
  deliveries.runSettled(outcome, false, Promise.resolve(null));
  await settle();
}

describe("agent relay: waiting", () => {
  it("waits for any task by default, and takes the event it returns with from the deliveries", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", { tasks: [task("t-1")] }),
      child("c2", "main", "tests", { tasks: [task("t-2"), task("t-0", { state: "done" })] }),
    );

    const waiting = await h.call("main", "wait", {}, "wait-1");
    await runTask(h, "c2", "t-2");

    expect(waiting.answer).toBeUndefined();
    expect(h.reply("wait-1")).toStrictEqual({
      v: 1,
      id: "wait-1",
      ok: true,
      result: {
        events: [{ name: "tests", title: "tests", sessionId: "c2", taskId: "t-2", event: "finished", elapsedMs: 0 }],
        pending: ["t-1"],
        progress: [],
        timedOut: false,
      },
    });
    expect(h.entry("main").deliveries).toMatchObject([{ taskId: "t-2", state: "claimed", claimedBy: "wait-1" }]);
  });

  it("waits for all, returning early at a question but not at a request for you", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", { tasks: [task("t-1")] }),
      child("c2", "main", "tests", { tasks: [task("t-2")] }),
    );

    await h.call("main", "wait", { until: "all" }, "wait-1");
    await runTask(h, "c1", "t-1");
    h.sessions.set("c2", {
      ...h.entry("c2"),
      deliveries: [{ id: "k2", kind: "task", from: "main", taskId: "t-2", text: "t", at: 1, state: "sending" }],
    });
    h.relay.deliveries("c2").runStarted({ deliveries: ["k2"] });
    h.relay.asking("c2", true);
    h.relay.asking("c2", true);
    await settle();
    const beforeQuestion = h.reply("wait-1");
    await h.call("c2", "ask", { question: "vitest?", options: ["yes", "no"] }, "ask-1");

    expect(beforeQuestion).toBeUndefined();
    expect(h.reply("wait-1")).toMatchObject({
      result: {
        events: [
          { name: "audit", event: "finished" },
          { name: "tests", event: "needs_you" },
          { name: "tests", event: "question", questionId: "ask-1", question: "vitest?", options: ["yes", "no"] },
        ],
        pending: ["t-2"],
        timedOut: false,
      },
    });
  });

  it("counts at once events already waiting for the parent, and answers at once with nothing to wait for", async () => {
    const h = harness(
      session("main", {
        deliveries: [notice("n1", "t-1", "finished"), notice("n2", "t-1", "question", { state: "sending" })],
      }),
      child("c1", "main", "audit", { tasks: [task("t-1", { state: "done" })] }),
    );

    const listed = await h.call("main", "wait", { tasks: ["t-1"] }, "wait-1");
    const none = await h.call("main", "wait", {}, "wait-2");

    expect(listed.answer).toMatchObject({ result: { events: [{ taskId: "t-1", event: "finished" }], pending: [] } });
    expect(none.answer).toMatchObject({ result: { events: [], pending: [], timedOut: false } });
    expect(h.entry("main").deliveries.map((one) => [one.id, one.state])).toStrictEqual([
      ["n1", "claimed"],
      ["n2", "sending"],
    ]);
  });

  it("takes by default, at once, the events still waiting of tasks that ended, as well as the open tasks", async () => {
    const h = harness(
      session("main", {
        deliveries: [notice("n1", "t-1", "finished"), notice("n0", "t-0", "finished", { state: "sending" })],
      }),
      child("c1", "main", "audit", { tasks: [task("t-0", { state: "done" }), task("t-1", { state: "done" })] }),
      child("c2", "main", "tests", { tasks: [task("t-2")] }),
    );

    const { answer } = await h.call("main", "wait", {}, "wait-1");

    expect(answer).toMatchObject({
      result: { events: [{ taskId: "t-1", event: "finished" }], pending: ["t-2"], timedOut: false },
    });
    expect(h.entry("main").deliveries.map((one) => [one.id, one.state])).toStrictEqual([
      ["n1", "claimed"],
      ["n0", "sending"],
    ]);
  });

  it("answers a task not the caller's agent_not_allowed", async () => {
    const h = harness(session("main"), session("other"), child("c1", "other", "audit", { tasks: [task("t-1")] }));

    const { answer } = await h.call("main", "wait", { tasks: ["t-1"] });

    expect(answer).toMatchObject({ ok: false, code: "agent_not_allowed" });
  });

  it("ends at its time, or when you send a message, with what is still running", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));

    await h.call("main", "wait", { waitSeconds: 30 }, "wait-1");
    h.clock.advance(29_999);
    await settle();
    const early = h.reply("wait-1");
    h.clock.advance(1);
    await settle();
    await h.call("main", "wait", {}, "wait-2");
    h.relay.deliveries("main").userSpoke();
    await settle();

    expect(early).toBeUndefined();
    expect(h.reply("wait-1")).toMatchObject({ result: { events: [], pending: ["t-1"], timedOut: true } });
    expect(h.reply("wait-2")).toMatchObject({ result: { timedOut: false, interrupted: "user_message" } });
  });

  it("puts back what a wait stopped had taken, answers nothing, and stops the child only a wait: true waited for", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1"), task("t-2")] }));

    await h.call("main", "wait", { until: "all" }, "wait-1");
    await runTask(h, "c1", "t-1");
    const taken = h.entry("main").deliveries.map((one) => [one.taskId, one.state]);
    await h.note("main", "cancel", { id: "wait-1" });
    h.states.set("c1", { ...IDLE, running: true });
    await h.call("main", "send", { to: "audit", message: "more", wait: true }, "send-1");
    await h.note("main", "cancel", { id: "send-1" });

    expect(taken).toStrictEqual([["t-1", "claimed"]]);
    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.state, one.claimedBy])).toStrictEqual([
      ["t-1", "waiting", undefined],
    ]);
    expect([h.reply("wait-1"), h.reply("send-1")]).toStrictEqual([undefined, undefined]);
    expect(h.stopped).toStrictEqual(["c1"]);
    expect(h.pumped).toContain("main");
  });

  it("leaves a child running when an agent_wait on its one task is stopped", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    h.states.set("c1", { ...IDLE, running: true });

    await h.call("main", "wait", { tasks: ["t-1"] }, "wait-1");
    await h.note("main", "cancel", { id: "wait-1" });

    expect(h.reply("wait-1")).toBeUndefined();
    expect(h.stopped).toStrictEqual([]);
  });

  it("answers wait: true with the event of its own task only", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));

    await h.call("main", "send", { to: "audit", message: "more", wait: true }, "send-1");
    const taskId = present(h.entry("c1").agent?.tasks[1], "the new task").taskId;
    await runTask(h, "c1", "t-1");
    const afterOther = h.reply("send-1");
    await runTask(h, "c1", taskId);

    expect(afterOther).toBeUndefined();
    expect(h.reply("send-1")).toMatchObject({
      ok: true,
      result: {
        to: "audit",
        sessionId: "c1",
        taskId,
        queued: false,
        waited: { timedOut: false, event: { taskId, event: "finished" } },
      },
    });
    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.state])).toStrictEqual([
      ["t-1", "waiting"],
      [taskId, "claimed"],
    ]);
  });

  it("answers wait: true at a message of yours, as interrupted", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));

    await h.call("main", "send", { to: "audit", message: "more", wait: true }, "send-1");
    h.relay.deliveries("main").userSpoke();
    await settle();

    expect(h.reply("send-1")).toStrictEqual({
      v: 1,
      id: "send-1",
      ok: true,
      result: {
        to: "audit",
        sessionId: "c1",
        taskId: "t-id1",
        queued: false,
        waited: { timedOut: false, interrupted: "user_message" },
      },
    });
  });

  it("ends a session's waits only at words of yours there, or when its own pi exits", async () => {
    const h = harness(
      session("main"),
      session("other"),
      child("k1", "main", "audit", { tasks: [task("t-1")] }),
      child("k2", "other", "tests", { tasks: [task("t-2")] }),
    );
    await h.call("main", "wait", {}, "wait-1");
    await h.call("other", "wait", {}, "wait-2");

    h.relay.exited("k1", 1);
    h.relay.deliveries("main").userSpoke();
    await settle();

    expect(h.reply("wait-1")).toStrictEqual({
      v: 1,
      id: "wait-1",
      ok: true,
      result: { events: [], pending: ["t-1"], progress: [], timedOut: false, interrupted: "user_message" },
    });
    expect(h.reply("wait-2")).toBeUndefined();
  });

  it("stops only the wait a note names, of the process that sent it, and puts back only what that wait took", async () => {
    const h = harness(
      session("main"),
      child("k1", "main", "audit", { tasks: [task("t-1"), task("t-3"), task("t-4")] }),
    );
    await h.call("main", "wait", { tasks: ["t-1"] }, "w1");
    await h.call("main", "wait", { tasks: ["t-3"] }, "w3");
    await h.call("main", "wait", { tasks: ["t-4"] }, "w4");

    // A newer process does not stop what an older one waits on.
    h.relay.request("main", 2, JSON.stringify({ v: 1, id: "n-old", kind: "note", op: "cancel", args: { id: "w1" } }));
    await settle();
    await runTask(h, "k1", "t-1");
    await h.note("main", "cancel", { id: "w3" });
    await runTask(h, "k1", "t-4");

    expect(["w1", "w3", "w4"].map((id) => h.reply(id)?.["ok"])).toStrictEqual([true, undefined, true]);
    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.state, one.claimedBy])).toStrictEqual([
      ["t-1", "claimed", "w1"],
      ["t-4", "claimed", "w4"],
    ]);
  });

  it("counts a final event already waiting as its task's end, before the child's record says so", async () => {
    const h = harness(
      session("main", { deliveries: [notice("n1", "t-1", "ended", { reason: "archived" })] }),
      child("c1", "main", "audit", { tasks: [task("t-1")] }),
    );

    // As between the two writes of a child that ends.
    const { answer } = await h.call("main", "wait", { tasks: ["t-1"], until: "all" });

    expect(answer).toMatchObject({
      ok: true,
      result: { events: [{ taskId: "t-1", event: "ended", reason: "archived" }], timedOut: false },
    });
  });

  it("leaves out of a wait's result the event of a child no longer in the index", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", { tasks: [task("t-1")] }),
      child("c2", "main", "tests", { tasks: [task("t-2")] }),
    );

    await h.call("main", "wait", { until: "all" }, "wait-1");
    await runTask(h, "c1", "t-1");
    h.sessions.delete("c1");
    await runTask(h, "c2", "t-2");

    expect(h.reply("wait-1")).toStrictEqual({
      v: 1,
      id: "wait-1",
      ok: true,
      result: {
        events: [{ name: "tests", title: "tests", sessionId: "c2", taskId: "t-2", event: "finished", elapsedMs: 0 }],
        pending: [],
        progress: [],
        timedOut: false,
      },
    });
  });
});

describe("agent relay: questions", () => {
  it("hands the child the answer and says it was delivered once the child took it", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    await runTaskStarted(h, "c1", "t-1");
    await h.call("c1", "ask", { question: "which?" }, "ask-1");

    await h.call("main", "reply", { to: "audit", questionId: "ask-1", answer: "left" }, "reply-1");
    const asked = h.reply("ask-1");
    await h.note("c1", "answered", { id: "ask-1" });

    expect(asked).toStrictEqual({ v: 1, id: "ask-1", ok: true, result: { answered: true, answer: "left" } });
    expect(h.reply("reply-1")).toMatchObject({ ok: true, result: { delivered: true } });
    expect(h.relay.summary("c1").agent?.status).not.toBe("waiting_for_parent");
  });

  it("closes the question once the child closed it, with its notice still waiting removed", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    h.live.delete("main");
    await runTaskStarted(h, "c1", "t-1");
    await h.call("c1", "ask", { question: "which?" }, "ask-1");
    const waitingNotice = h.entry("main").deliveries.map((one) => one.event);
    const status = h.relay.summary("c1").agent;

    await h.note("c1", "closed", { id: "ask-1" });
    const late = await h.call("main", "reply", { to: "audit", questionId: "ask-1", answer: "left" });

    expect(waitingNotice).toStrictEqual(["question"]);
    expect(status).toMatchObject({ status: "waiting_for_parent", question: "which?" });
    expect(h.entry("main").deliveries).toStrictEqual([]);
    expect(late.answer).toMatchObject({ ok: false, code: "agent_question_closed" });
    expect(h.reply("ask-1")).toBeUndefined();
  });

  it("closes the question in the child when the answer is not confirmed in 10 s, and says what the child said then", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", { tasks: [task("t-1"), task("t-2"), task("t-3")] }),
    );
    await runTaskStarted(h, "c1", "t-1");
    await h.call("c1", "ask", { question: "a?" }, "ask-1");
    await h.call("c1", "ask", { question: "b?" }, "ask-2");
    await h.call("c1", "ask", { question: "c?" }, "ask-3");

    await h.call("main", "reply", { to: "audit", questionId: "ask-1", answer: "x" }, "reply-1");
    await h.call("main", "reply", { to: "audit", questionId: "ask-2", answer: "y" }, "reply-2");
    await h.call("main", "reply", { to: "audit", questionId: "ask-3", answer: "z" }, "reply-3");
    h.clock.advance(10_000);
    await settle();
    const cancels = h.commands.filter(([, , sent]) => sent.action === "cancel").map(([, , sent]) => sent.value);
    await h.note("c1", "answered", { id: "ask-1" });
    await h.note("c1", "closed", { id: "ask-2" });
    h.clock.advance(10_000);
    await settle();

    expect(cancels).toStrictEqual([
      { v: 1, id: "ask-1", reason: "reply_failed" },
      { v: 1, id: "ask-2", reason: "reply_failed" },
      { v: 1, id: "ask-3", reason: "reply_failed" },
    ]);
    expect([h.reply("reply-1"), h.reply("reply-2"), h.reply("reply-3")]).toMatchObject([
      { ok: true, result: { delivered: true } },
      { ok: false, code: "agent_question_closed" },
      { ok: true, result: { delivered: "unknown" } },
    ]);
  });

  it("hands a question answered before the same answer again, for the child to confirm or close", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    await runTaskStarted(h, "c1", "t-1");
    await h.call("c1", "ask", { question: "a?" }, "ask-1");
    await h.call("main", "reply", { to: "audit", questionId: "ask-1", answer: "x" }, "reply-1");
    await h.note("c1", "answered", { id: "ask-1" });

    await h.call("main", "reply", { to: "audit", questionId: "ask-1", answer: "x" }, "reply-2");
    const resent = repliesTo(h.commands, "ask-1");
    await h.note("c1", "answered", { id: "ask-1" });

    expect(resent).toBe(2);
    expect(h.reply("reply-2")).toMatchObject({ ok: true, result: { delivered: true } });
  });

  it("closes the questions of a child's pi that exited, and a child stopped being its parent's cancels them", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", { tasks: [task("t-1")] }),
      child("c2", "main", "tests", { tasks: [task("t-2")] }),
    );
    await runTaskStarted(h, "c1", "t-1");
    await runTaskStarted(h, "c2", "t-2");
    await h.call("c1", "ask", { question: "a?" }, "ask-1");
    await h.call("c2", "ask", { question: "b?" }, "ask-2");

    h.relay.exited("c1", 1);
    await settle();
    await h.relay.ended("c2", "detached", "main");
    const late = await h.call("main", "reply", { to: "audit", questionId: "ask-1", answer: "x" });

    expect(late.answer).toMatchObject({ ok: false, code: "agent_question_closed" });
    expect(
      h.commands.filter(([, , sent]) => sent.action === "cancel").map(([id, , sent]) => [id, sent.value]),
    ).toStrictEqual([["c2", { v: 1, id: "ask-2", reason: "detached" }]]);
    expect(h.entry("main").deliveries.map((one) => [one.from, one.event, one.reason])).toStrictEqual([
      ["c2", "ended", "detached"],
    ]);
  });

  it("refuses ask_parent to a session the agent did not open", async () => {
    const h = harness(session("main"));

    const { answer } = await h.call("main", "ask", { question: "?" });

    expect(answer).toMatchObject({ ok: false, code: "agent_not_allowed" });
  });

  it("cancels only the open questions of a child that ended, and keeps what waits for one handed off", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    await runTaskStarted(h, "c1", "t-1");
    await h.note("c1", "progress", { message: "half" });
    await h.call("c1", "ask", { question: "a?" }, "ask-1");
    await h.note("c1", "closed", { id: "ask-1" });
    const waitingTask: DeliveryRecord = {
      id: "k9",
      kind: "task",
      from: "main",
      taskId: "t-1",
      text: "t",
      at: 1,
      state: "waiting",
    };
    h.sessions.set("c1", { ...h.entry("c1"), deliveries: [waitingTask] });

    await h.relay.ended("c1", "handed_off");

    expect(h.commands.filter(([, , sent]) => sent.action === "cancel")).toStrictEqual([]);
    expect(h.entry("c1").deliveries).toStrictEqual([waitingTask]);
    expect(h.relay.summary("c1").agent?.progress).toBe("half");
  });
});

/**
 * Starts a child's run on a task, as its controller tells the relay.
 *
 * @remarks
 * See `runTask`; the run goes on.
 *
 * @sideEffects Changes the index; runs the relay.
 * @param h - The harness.
 * @param childId - The child.
 * @param taskId - The task.
 */
async function runTaskStarted(h: ReturnType<typeof harness>, childId: string, taskId: string): Promise<void> {
  const id = `run-${taskId}`;
  h.sessions.set(childId, {
    ...h.entry(childId),
    deliveries: [{ id, kind: "task", from: "main", taskId, text: "t", at: 1, state: "sending" }],
  });
  h.relay.deliveries(childId).runStarted({ deliveries: [id] });
  await h.relay.deliveries(childId).confirm([id]);
  h.states.set(childId, { ...IDLE, running: true });
}

describe("agent relay: list, read, stop and models", () => {
  it("lists the caller's children the agent opened, their status, model and open tasks, ended ones when asked", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", {
        tasks: [task("t-1"), task("t-0", { state: "done" })],
        startOn: { providerId: "faux", modelId: "m2", thinkingLevel: "off" },
        entry: { name: "审查", updatedAt: 7 },
      }),
      child("c2", "main", "tests", { role: "work", worktree: true, entry: { archived: true } }),
      child("c3", "main", "away", { entry: { handedOff: true } }),
      child("c4", "main", "lost", { entry: { state: "missing" } }),
      session("yours", { parent: { sessionId: "main", by: "user" } }),
    );
    h.states.set("c1", { ...IDLE, running: true });
    h.setModel(null);
    await h.note("c1", "progress", { message: "half" });
    await h.note("main", "progress", { message: "not a child" });

    const { answer } = await h.call("main", "list", {});
    const all = await h.call("main", "list", { includeEnded: true });

    expect(answer).toMatchObject({
      ok: true,
      result: {
        children: [
          {
            name: "audit",
            title: "审查",
            sessionId: "c1",
            role: "explore",
            status: "running",
            place: "same",
            model: "faux/m2",
            thinking: "off",
            updatedAt: 7,
            openTasks: ["t-1"],
            lastProgress: "half",
          },
        ],
      },
    });
    expect(listedChildren(all.answer)).toStrictEqual([
      ["audit", "running", "same"],
      ["tests", "ended", "worktree"],
      ["away", "handed_off", "same"],
      ["lost", "ended", "same"],
    ]);
    expect(h.relay.summary("main").agent).toBeNull();
  });

  it("reads a task's reply a page at a time, the latest task by default, and says when there is none yet", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", {
        tasks: [task("t-1", { state: "done", replyEntry: "a1" }), task("t-2")],
        entry: { archived: true },
      }),
    );
    h.files.set("/pi/c1.jsonl", [
      taskEntry("k1", "t-1"),
      replied("a1", "abcdef"),
      taskEntry("k2", "t-2"),
      replied("a2", ""),
    ]);

    const first = await h.call("main", "read", { to: "audit", taskId: "t-1", limit: 4 });
    const next = await h.call("main", "read", { to: "id:c1", taskId: "t-1", offset: 4 });
    const latest = await h.call("main", "read", { to: "audit" });
    const unknown = await h.call("main", "read", { to: "audit", taskId: "t-9" });

    expect([first.answer?.["result"], next.answer?.["result"], latest.answer?.["result"]]).toStrictEqual([
      { text: "abcd", totalChars: 6, nextOffset: 4 },
      { text: "ef", totalChars: 6, nextOffset: null },
      { text: null, reason: "no_reply_yet" },
    ]);
    expect(unknown.answer).toMatchObject({ ok: false, code: "agent_not_allowed" });
  });

  it("reads a task's latest steps, with how each went", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    h.files.set("/pi/c1.jsonl", [
      taskEntry("k1", "t-1"),
      {
        ...replied("a1", ""),
        parts: [
          { type: "toolCall", callId: "x1", tool: "read", args: { path: "a.ts" } },
          { type: "toolCall", callId: "x2", tool: "bash", args: { command: "npm\n  test" } },
          { type: "toolCall", callId: "x3", tool: "ls", args: {} },
        ],
      } as LogEntry,
      {
        id: "r1",
        parentId: null,
        kind: "toolResult",
        callId: "x1",
        tool: "read",
        text: "",
        isError: false,
        details: undefined,
        timestamp: 0,
      },
      {
        id: "r2",
        parentId: null,
        kind: "toolResult",
        callId: "x2",
        tool: "bash",
        text: "",
        isError: true,
        details: undefined,
        timestamp: 0,
      },
      { id: "u1", parentId: null, kind: "user", text: "yours", images: 0, skill: null, timestamp: 0 },
      { ...replied("a2", ""), parts: [{ type: "toolCall", callId: "x4", tool: "edit", args: {} }] } as LogEntry,
    ]);

    const { answer } = await h.call("main", "read", { to: "audit", what: "steps", limit: 2 });

    expect(answer?.["result"]).toStrictEqual({
      steps: [
        { title: "bash npm test", status: "failed" },
        { title: "ls", status: "running" },
      ],
    });
  });

  it("stops a child's run and the running agent children below it, not past one you opened", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", { tasks: [task("t-1")] }),
      child("g1", "c1", "deep", { tasks: [task("t-2")] }),
      child("g2", "c1", "idle"),
      session("yours", { parent: { sessionId: "c1", by: "user" } }),
      child("under-yours", "yours", "under"),
    );
    for (const id of ["c1", "g1", "under-yours", "yours"]) h.states.set(id, { ...IDLE, running: true });

    const { answer } = await h.call("main", "stop", { to: "audit" });

    expect(answer).toMatchObject({
      ok: true,
      result: { to: "audit", sessionId: "c1", previousStatus: "running", stopped: ["audit", "deep"] },
    });
    expect(h.stopped).toStrictEqual(["c1", "g1"]);
  });

  it("names a child the caller may not touch: another's, detached, gone, archived, handed off or being archived", async () => {
    const h = harness(
      session("main", { usedHandles: ["gone", "loose"] }),
      session("other"),
      child("theirs", "other", "theirs"),
      session("loose", {
        name: "loose",
        agent: { handle: "loose", role: "explore", toolGuard: "flags", startOn: null, worktree: false, tasks: [] },
      }),
      child("archived", "main", "archived", { entry: { archived: true } }),
      child("away", "main", "away", { entry: { handedOff: true } }),
      child("busy", "main", "busy"),
      child("missing", "main", "missing", { entry: { state: "missing" } }),
    );
    h.archiving.add("busy");

    const codes = [];
    for (const to of [
      "theirs",
      "id:theirs",
      "gone",
      "loose",
      "id:loose",
      "id:nobody",
      "archived",
      "away",
      "busy",
      "missing",
    ]) {
      codes.push((await h.call("main", "send", { to, message: "x" })).answer?.["code"]);
    }
    const readable = await h.call("main", "read", { to: "archived" });

    expect(codes).toStrictEqual([
      "agent_not_allowed",
      "agent_not_allowed",
      "agent_gone",
      "agent_not_allowed",
      "agent_not_allowed",
      "agent_gone",
      "agent_gone",
      "agent_handed_off",
      "agent_busy",
      "agent_gone",
    ]);
    expect(readable.answer).toMatchObject({ ok: false, code: "agent_not_allowed" });
    // Detached, it is no longer one the agent opened.
    expect(h.relay.summary("loose")).toStrictEqual({ agent: null, heldDeliveries: 0 });
  });

  it("lists the models the caller can use, with the current one marked", async () => {
    const h = harness(session("main"));

    const { answer } = await h.call("main", "models", {});

    expect(answer?.["result"]).toStrictEqual({
      models: [
        { id: "faux/m1", name: "M1", thinking: ["off", "low", "high"], current: true },
        { id: "faux/m2", name: "M2", thinking: ["off"] },
      ],
    });
  });

  it("finds a handle among the caller's own children, and calls one it used before gone, not another's", async () => {
    const h = harness(
      session("main", { usedHandles: ["gone"] }),
      session("other"),
      session("yours", { parent: { sessionId: "main", by: "user" } }),
      child("x1", "other", "audit"),
      child("x2", "other", "gone"),
      child("c1", "main", "audit"),
    );

    const sent = await h.call("main", "send", { to: "audit", message: "look" });
    const gone = await h.call("main", "send", { to: "gone", message: "look" });
    // A caller the index no longer lists has no children.
    const ghost = [await h.call("ghost", "send", { to: "audit", message: "look" }), await h.call("ghost", "wait", {})];

    expect(sent.answer).toStrictEqual({
      v: 1,
      id: sent.id,
      ok: true,
      result: { to: "audit", sessionId: "c1", taskId: "t-id1", queued: false },
    });
    expect(h.entry("c1").agent?.tasks).toStrictEqual([{ taskId: "t-id1", state: "open", at: 1000 }]);
    expect(h.entry("c1").deliveries).toStrictEqual([
      { id: "id2", kind: "task", from: "main", taskId: "t-id1", text: "look", at: 1000, state: "waiting" },
    ]);
    expect(gone.answer).toMatchObject({ ok: false, code: "agent_gone" });
    expect(ghost.map((one) => one.answer)).toStrictEqual([
      { v: 1, id: "call-3", ok: false, code: "agent_not_allowed" },
      { v: 1, id: "call-4", ok: true, result: { events: [], pending: [], progress: [], timedOut: false } },
    ]);
  });

  it("reads a reply's text parts only, joined", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    h.files.set("/pi/c1.jsonl", [
      taskEntry("k1", "t-1"),
      {
        ...replied("a1", ""),
        parts: [
          { type: "thinking", text: "hmm" },
          { type: "text", text: "ab" },
          { type: "toolCall", callId: "x1", tool: "ls", args: {} },
          { type: "text", text: "cd" },
        ],
      } as LogEntry,
    ]);

    const { answer } = await h.call("main", "read", { to: "audit" });

    expect(answer?.["result"]).toStrictEqual({ text: "abcd", totalChars: 4, nextOffset: null });
  });

  it("reads a task's reply from its own run: notices from below in it, up to the next task or message of yours", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", { tasks: [task("t-1"), task("t-2"), task("t-3")] }),
    );
    h.files.set("/pi/c1.jsonl", [
      replied("a0", "before"),
      taskEntry("k1", "t-1"),
      replied("a1", "one"),
      reportEntry("k2"),
      replied("a2", "two"),
      taskEntry("k3", "t-2"),
      replied("a3", "three"),
    ]);

    const replies = [];
    for (const taskId of ["t-1", "t-2", "t-3"]) {
      replies.push((await h.call("main", "read", { to: "audit", taskId })).answer?.["result"]);
    }

    expect(replies).toStrictEqual([
      { text: "two", totalChars: 3, nextOffset: null },
      { text: "three", totalChars: 5, nextOffset: null },
      { text: null, reason: "no_reply_yet" },
    ]);
  });

  it("titles a step by its tool and first text argument, cut to 120 characters, and calls one that went well done", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    h.files.set("/pi/c1.jsonl", [
      taskEntry("k1", "t-1"),
      {
        ...replied("a1", ""),
        parts: [
          { type: "toolCall", callId: "x1", tool: "read", args: { limit: 5, path: "a.ts" } },
          { type: "toolCall", callId: "x2", tool: "bash", args: { command: "x".repeat(200) } },
        ],
      } as LogEntry,
      {
        id: "r1",
        parentId: null,
        kind: "toolResult",
        callId: "x1",
        tool: "read",
        text: "",
        isError: false,
        details: undefined,
        timestamp: 0,
      },
    ]);

    const { answer } = await h.call("main", "read", { to: "audit", what: "steps" });

    expect(answer?.["result"]).toStrictEqual({
      steps: [
        { title: "read a.ts", status: "done" },
        { title: `bash ${"x".repeat(115)}`, status: "running" },
      ],
    });
  });
});

describe("agent relay: the channel", () => {
  it("answers a call it cannot read with agent_bad_request when it has an id, and nothing otherwise", async () => {
    const h = harness(session("main"));
    const texts = [
      JSON.stringify({ v: 1, id: "bad-1", kind: "call", op: "stop", args: {} }),
      "not json",
      JSON.stringify({ v: 1, id: "bad-2", kind: "note", op: "fly", args: {} }),
    ];

    for (const text of texts) h.relay.request("main", 1, text);
    await settle();

    expect(h.commands.map(([, , sent]) => sent)).toStrictEqual([
      { action: "reply", value: { v: 1, id: "bad-1", ok: false, code: "agent_bad_request" } },
    ]);
    expect(
      h.records
        .filter((record) => record["msg"] === "agent request not read")
        .map((record) => [record["sessionId"], record["size"]]),
    ).toStrictEqual(texts.map((text) => ["main", text.length]));
  });

  it("answers a call once per process and request id, and again for a new process", async () => {
    const h = harness(session("main"));

    h.relay.request("main", 1, JSON.stringify({ v: 1, id: "c", kind: "call", op: "list", args: {} }));
    h.relay.request("main", 1, JSON.stringify({ v: 1, id: "c", kind: "call", op: "list", args: {} }));
    await settle();
    h.relay.exited("main", 1);
    h.relay.request("main", 1, JSON.stringify({ v: 1, id: "c", kind: "call", op: "list", args: {} }));
    h.relay.request("main", 2, JSON.stringify({ v: 1, id: "c", kind: "call", op: "list", args: {} }));
    await settle();

    expect(h.commands.map(([id, epoch]) => [id, epoch])).toStrictEqual([
      ["main", 1],
      ["main", 1],
      ["main", 2],
    ]);
    expect(h.records).toContainEqual(
      expect.objectContaining({ msg: "agent call", op: "list", requestId: "c", code: null }),
    );
  });

  it("gives the main agent's tools nothing at depth 2, but lets a child there ask its parent", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "a", { tasks: [task("t-1")] }),
      child("c2", "c1", "b", { tasks: [task("t-2")] }),
    );
    await runTaskStarted(h, "c2", "t-2");

    const listed = await h.call("c2", "list", {});
    await h.call("c2", "ask", { question: "?" }, "ask-1");

    expect(listed.answer).toMatchObject({ ok: false, code: "agent_depth_limit" });
    expect(h.entry("c1").deliveries.map((one) => one.event)).toStrictEqual(["question"]);
  });

  it("removes the branch directories a process got when it exits, and only those", async () => {
    const h = harness(session("main"));
    await h.call("main", "branch", {});
    await h.call("main", "branch", {});

    h.relay.exited("main", 2);
    h.relay.exited("main", 1);
    await settle();

    expect(h.removed).toStrictEqual(["/home/tmp/b1", "/home/tmp/b2"]);
  });

  it("logs a note it could not act on, and a child's event it could not send", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    await runTaskStarted(h, "c1", "t-1");
    await h.call("c1", "ask", { question: "a?" }, "ask-1");
    h.failWrites();

    await h.note("c1", "closed", { id: "ask-1" });
    h.relay.deliveries("c1").runSettled("completed", false, Promise.resolve(null));
    await settle();

    expect(
      h.records
        .filter((record) => ["agent note failed", "child's event not sent"].includes(String(record["msg"])))
        .map((record) => [
          record["msg"],
          record["sessionId"],
          record["op"],
          Reflect.get(Object(record["err"]), "message"),
        ]),
    ).toStrictEqual([
      ["agent note failed", "c1", "closed", "index not written"],
      ["child's event not sent", "c1", undefined, "index not written"],
    ]);
  });
});

describe("agent relay: the queue panel, a restart and the host closing", () => {
  it("removes a delivery not yet handed to pi, and refuses one handed over or unknown", async () => {
    const h = harness(
      session("main", {
        deliveries: [notice("n1", "t-1", "finished"), notice("n2", "t-1", "failed", { state: "sending" })],
      }),
      child("c1", "main", "audit"),
    );

    await h.relay.removeDelivery("main", "n1");
    const sending = await h.relay.removeDelivery("main", "n2").catch((error: unknown) => error);
    const unknown = await h.relay.removeDelivery("main", "n9").catch((error: unknown) => error);

    expect(h.entry("main").deliveries.map((one) => one.id)).toStrictEqual(["n2"]);
    expect([sending, unknown]).toMatchObject([
      { code: "delivery_sending", params: { deliveryId: "n2" } },
      { code: "delivery_not_found", params: { deliveryId: "n9" } },
    ]);
    expect(h.pumped).toStrictEqual(["main"]);
  });

  it("holds what waited when the host stopped, put back as waiting, questions and what a wait got dropped, until you let it go", async () => {
    const h = harness(
      session("main", {
        deliveries: [
          notice("n1", "t-1", "finished", { state: "sending" }),
          notice("n2", "t-1", "question", { questionId: "q" }),
          notice("n3", "t-2", "finished", { state: "claimed", claimedBy: "w" }),
          notice("n4", "t-2", "finished", { state: "claimed", claimedBy: "w-done" }),
        ],
      }),
      child("c1", "main", "audit", {
        tasks: [task("t-1")],
        entry: {
          deliveries: [{ id: "k1", kind: "task", from: "main", taskId: "t-1", text: "t", at: 1, state: "waiting" }],
        },
      }),
      session("quiet"),
    );
    h.files.set("/pi/c1.jsonl", [
      {
        ...replied("a1", ""),
        parts: [{ type: "toolCall", callId: "p1", tool: "report_progress", args: { message: "earlier" } }],
      } as LogEntry,
      {
        ...replied("a2", ""),
        parts: [{ type: "toolCall", callId: "p2", tool: "report_progress", args: { message: "latest" } }],
      } as LogEntry,
      { id: "u1", parentId: null, kind: "user", text: "yours", images: 0, skill: null, timestamp: 0 },
    ]);
    h.files.set("/pi/main.jsonl", [toolResult("r1", "w-done")]);

    await h.relay.start();
    const held = [
      h.relay.summary("main").heldDeliveries,
      h.relay.summary("c1").heldDeliveries,
      h.relay.summary("quiet").heldDeliveries,
    ];
    const progress = h.relay.summary("c1").agent?.progress;
    await h.relay.resumeDeliveries("main", true);

    expect(h.entry("main").deliveries.map((one) => [one.id, one.state, one.claimedBy])).toStrictEqual([
      ["n1", "waiting", undefined],
      ["n3", "waiting", undefined],
    ]);
    expect(held).toStrictEqual([2, 1, 0]);
    expect(progress).toBe("latest");
    expect([h.relay.summary("main").heldDeliveries, h.relay.summary("c1").heldDeliveries]).toStrictEqual([0, 0]);
    expect(h.pumped).toStrictEqual(["main", "c1"]);
  });

  it("lets go only the session's own deliveries without tree", async () => {
    const h = harness(
      session("main", { deliveries: [notice("n1", "t-1", "finished")] }),
      child("c1", "main", "audit", { entry: { deliveries: [notice("n2", "t-1", "finished", { from: "x" })] } }),
    );
    await h.relay.start();

    await h.relay.resumeDeliveries("main", false);

    expect([h.relay.summary("main").heldDeliveries, h.relay.summary("c1").heldDeliveries]).toStrictEqual([0, 1]);
  });

  it("tells parents the tasks running when the host closes stopped, with the host's exit as why", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", { tasks: [task("t-1")] }),
      child("c2", "main", "tests"),
    );
    await runTaskStarted(h, "c1", "t-1");
    h.relay.deliveries("c2").runStarted("user");
    await h.call("main", "wait", {}, "wait-1");

    await h.relay.close();

    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.event, one.reason, one.state])).toStrictEqual([
      ["t-1", "stopped", "host_exit", "waiting"],
    ]);
    expect(h.reply("wait-1")).toBeUndefined();
  });

  it("ends a child's open tasks for its parent when it is archived, handed off or detached, and drops what waited for an archived one", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", {
        tasks: [task("t-1"), task("t-0", { state: "done" })],
        entry: { deliveries: [notice("n9", "t-5", "finished", { from: "g" })] },
      }),
      child("c2", "main", "tests", { tasks: [task("t-2")] }),
      session("plain"),
    );

    await h.relay.ended("c1", "archived");
    await h.relay.ended("c2", "handed_off");
    await h.relay.ended("plain", "archived");

    expect(h.entry("main").deliveries.map((one) => [one.from, one.taskId, one.event, one.reason])).toStrictEqual([
      ["c1", "t-1", "ended", "archived"],
      ["c2", "t-2", "ended", "handed_off"],
    ]);
    expect(h.entry("c1").deliveries).toStrictEqual([]);
    expect(h.entry("c1").agent?.tasks.map((one) => one.state)).toStrictEqual(["done", "done"]);
  });

  it("titles a delivery from a session with no name, message or handle, or one gone, with nothing", () => {
    const h = harness(
      session("main", {
        deliveries: [
          notice("n1", "t-1", "finished", { from: "ghost" }),
          notice("n2", "t-1", "finished", { from: "blank" }),
        ],
      }),
      session("blank", { name: null, prompt: null }),
    );

    expect(h.relay.deliveries("main").items()).toStrictEqual([
      { id: "n1", kind: "report", fromTitle: "", event: "finished", state: "waiting" },
      { id: "n2", kind: "report", fromTitle: "", event: "finished", state: "waiting" },
    ]);
  });

  it("holds what pi stalled on, back as waiting, until you let it go", async () => {
    const h = harness(
      session("main", { deliveries: [notice("n1", "t-1", "finished", { state: "sending" })] }),
      child("c1", "main", "audit"),
    );
    const deliveries = h.relay.deliveries("main");
    const before = h.changes();

    deliveries.stalled(["n1"]);
    await settle();

    expect(h.entry("main").deliveries.map((one) => [one.id, one.state])).toStrictEqual([["n1", "waiting"]]);
    expect([deliveries.held(), h.relay.summary("main").heldDeliveries, h.changes() - before]).toStrictEqual([
      "stalled",
      0,
      1,
    ]);
  });

  it("counts held deliveries a wait has not taken, and none for a session the index does not list", async () => {
    const h = harness(
      session("main", { deliveries: [notice("n1", "t-1", "finished"), notice("n2", "t-2", "finished")] }),
      child("c1", "main", "audit", { tasks: [task("t-1", { state: "done" }), task("t-2", { state: "done" })] }),
    );
    await h.relay.start();

    await h.call("main", "wait", { tasks: ["t-1"] });

    expect([h.relay.summary("main"), h.relay.summary("nobody")]).toStrictEqual([
      { agent: null, heldDeliveries: 1 },
      { agent: null, heldDeliveries: 0 },
    ]);
  });
});

describe("agent relay: resources", () => {
  it("leaves no timer behind once waits and answers end, however they end", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", { tasks: [task("t-1"), task("t-2"), task("t-3")] }),
    );

    await h.call("main", "wait", { tasks: ["t-1"], waitSeconds: 30 }, "w1");
    h.clock.advance(30_000);
    await settle();
    await h.call("main", "wait", { tasks: ["t-1"] }, "w2");
    await runTask(h, "c1", "t-1");
    await h.call("main", "wait", { tasks: ["t-2"] }, "w3");
    await h.note("main", "cancel", { id: "w3" });
    await runTaskStarted(h, "c1", "t-3");
    await h.call("c1", "ask", { question: "a?" }, "ask-1");
    await h.call("main", "reply", { to: "audit", questionId: "ask-1", answer: "x" }, "reply-1");
    await h.note("c1", "answered", { id: "ask-1" });
    const confirmed = h.clock.pendingTimers();
    await h.call("c1", "ask", { question: "b?" }, "ask-2");
    await h.call("main", "reply", { to: "audit", questionId: "ask-2", answer: "y" }, "reply-2");
    // Ten seconds for the child to confirm, then ten for it to close the question.
    h.clock.advance(10_000);
    await settle();
    h.clock.advance(10_000);
    await settle();

    expect(["w1", "w2", "w3", "reply-1", "reply-2"].map((id) => h.reply(id)?.["ok"])).toStrictEqual([
      true,
      true,
      undefined,
      true,
      true,
    ]);
    expect([confirmed, h.clock.pendingTimers()]).toStrictEqual([0, 0]);
  });
});

describe("agent relay: what reviews of the relay found", () => {
  it("tells the parent a task whose pi was restarting stopped, when the host closes", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    await runTaskStarted(h, "c1", "t-1");
    h.relay.deliveries("c1").runSettled("failed", true, Promise.resolve(null));
    await settle();

    await h.relay.close();

    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.event, one.reason])).toStrictEqual([
      ["t-1", "stopped", "host_exit"],
    ]);
  });

  it("forgets why agent_stop stopped a turn you opened, so a later stop of a task is yours", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    h.relay.deliveries("c1").runStarted("user");
    h.states.set("c1", { ...IDLE, running: true });
    await h.call("main", "stop", { to: "audit" }, "stop-1");
    h.relay.deliveries("c1").runSettled("stopped", false, Promise.resolve(null));
    await settle();
    await runTaskStarted(h, "c1", "t-1");

    h.relay.deliveries("c1").runSettled("stopped", false, Promise.resolve(null));
    await settle();

    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.event, one.reason])).toStrictEqual([
      ["t-1", "stopped", "user"],
    ]);
  });

  it("hands a wait the end of a child archived or detached, at once", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", { tasks: [task("t-1")] }),
      child("c2", "main", "tests", { tasks: [task("t-2")] }),
    );

    await h.call("main", "wait", { tasks: ["t-1", "t-2"], until: "all" }, "wait-1");
    await h.relay.ended("c1", "archived");
    await h.relay.ended("c2", "detached", "main");
    await settle();

    expect(h.reply("wait-1")).toMatchObject({ ok: true, result: { timedOut: false, pending: [] } });
    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.state])).toStrictEqual([
      ["t-1", "claimed"],
      ["t-2", "claimed"],
    ]);
  });
});

/**
 * A tool's result in a session's file.
 *
 * @remarks
 * As pi writes it once a call returned: a wait's result there confirms what it took.
 *
 * @sideEffects none
 * @param id - The entry's id.
 * @param callId - The call.
 * @returns The entry.
 */
function toolResult(id: string, callId: string): LogEntry {
  return {
    id,
    parentId: null,
    kind: "toolResult",
    callId,
    tool: "agent_wait",
    text: "",
    isError: false,
    details: undefined,
    timestamp: 0,
  };
}

/**
 * A reply in a child's file that only reports progress.
 *
 * @remarks
 * As the child's agent calls `report_progress`.
 *
 * @sideEffects none
 * @param id - The entry's id.
 * @param message - The progress.
 * @returns The entry.
 */
function progressEntry(id: string, message: string): LogEntry {
  return {
    ...replied(id, ""),
    parts: [{ type: "toolCall", callId: `p-${id}`, tool: "report_progress", args: { message } }],
  } as LogEntry;
}

/**
 * A call as Atrium's extension sends it.
 *
 * @remarks
 * For calls sent together, without waiting between them.
 *
 * @sideEffects none
 * @param id - The call's id.
 * @param op - The operation.
 * @param args - Its arguments.
 * @returns The status text.
 */
function callText(id: string, op: string, args: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, id, kind: "call", op, args });
}

/**
 * A notice from a grandchild waiting for a child.
 *
 * @remarks
 * From `g`, on no task of the child's, so the run it opens is no task's.
 *
 * @sideEffects none
 * @param id - Its id.
 * @returns The delivery.
 */
function fromBelow(id: string): DeliveryRecord {
  return notice(id, "t-g", "finished", { from: "g" });
}

/** The children the six-place tests open, by handle. */
const SEVEN = ["a", "b", "c", "d", "e", "f", "g"];

/**
 * A parent with seven children the agent opened, recycled, each with a notice waiting.
 *
 * @remarks
 * For the places among the six (SPEC-0002, "概念 · 数量").
 *
 * @sideEffects none
 * @returns The harness.
 */
function sevenAsleep(): ReturnType<typeof harness> {
  const h = harness(
    session("main"),
    ...SEVEN.map((handle) =>
      child(`k-${handle}`, "main", handle, {
        tasks: [task(`t-${handle}`, { state: "done" })],
        entry: { deliveries: [fromBelow(`n-${handle}`)] },
      }),
    ),
  );
  for (const handle of SEVEN) h.live.delete(`k-${handle}`);
  return h;
}

/**
 * Runs a child's notices to their end, as its controller tells the relay.
 *
 * @remarks
 * The run takes the notice, confirms it, and ends idle.
 *
 * @sideEffects Changes the index; runs the relay.
 * @param h - The harness.
 * @param childId - The child.
 * @param deliveryId - The notice.
 */
async function runNotices(h: ReturnType<typeof harness>, childId: string, deliveryId: string): Promise<void> {
  const deliveries = h.relay.deliveries(childId);
  deliveries.runStarted({ deliveries: [deliveryId] });
  await deliveries.confirm([deliveryId]);
  deliveries.runSettled("completed", false, Promise.resolve(null));
  await settle();
}

describe("agent relay: what the three-way review found (2026-10-18)", () => {
  it("after a restart drops what a wait took whose result is on file, and puts back the rest as waiting", async () => {
    const h = harness(
      session("main", {
        deliveries: [
          notice("n1", "t-1", "finished", { state: "claimed", claimedBy: "w1" }),
          notice("n2", "t-2", "finished", { state: "claimed", claimedBy: "w2" }),
        ],
      }),
      child("c1", "main", "audit", { tasks: [task("t-1", { state: "done" }), task("t-2", { state: "done" })] }),
    );
    h.files.set("/pi/main.jsonl", [toolResult("r1", "w1")]);

    await h.relay.start();

    expect(h.entry("main").deliveries.map((one) => [one.id, one.state, one.claimedBy])).toStrictEqual([
      ["n2", "waiting", undefined],
    ]);
  });

  it("holds every session's deliveries at once on a restart, before reading any file", async () => {
    const h = harness(
      child("c1", "main", "audit", { tasks: [task("t-1", { state: "done" })] }),
      session("main", { deliveries: [notice("n1", "t-1", "finished")] }),
    );

    const starting = h.relay.start();
    const held = h.relay.deliveries("main").held();
    await starting;

    expect(held).toBe("restart");
  });

  it("carries the progress read back after a restart once, with the next notice", async () => {
    const h = harness(
      session("main", { deliveries: [notice("n1", "t-1", "finished")] }),
      child("c1", "main", "audit", { tasks: [task("t-1", { state: "done" })] }),
    );
    h.files.set("/pi/c1.jsonl", [progressEntry("a1", "latest")]);
    await h.relay.start();

    const first = decode(present(await h.relay.deliveries("main").command(["n1"]), "the notice"));
    const again = decode(present(await h.relay.deliveries("main").command(["n1"]), "the notice again"));

    expect([first.value["progress"], again.value["progress"]]).toStrictEqual([
      [{ name: "audit", title: "audit", message: "latest" }],
      [],
    ]);
  });

  it("after the host was killed, tells parents the tasks still open with nothing on its way stopped, held", async () => {
    const h = harness(
      session("main", { deliveries: [notice("n3", "t-3", "finished", { from: "c3" })] }),
      child("c1", "main", "audit", { tasks: [task("t-1"), task("t-0", { state: "done" })] }),
      child("c2", "main", "tests", {
        tasks: [task("t-2")],
        entry: {
          deliveries: [{ id: "k2", kind: "task", from: "main", taskId: "t-2", text: "t", at: 1, state: "waiting" }],
        },
      }),
      child("c3", "main", "lint", { tasks: [task("t-3")] }),
      session("solo"),
      child("c4", "solo", "alone", { tasks: [task("t-4")] }),
    );

    await h.relay.start();

    expect(
      h.entry("main").deliveries.map((one) => [one.from, one.taskId, one.event, one.reason, one.state]),
    ).toStrictEqual([
      ["c3", "t-3", "finished", undefined, "waiting"],
      ["c1", "t-1", "stopped", "host_exit", "waiting"],
    ]);
    expect(h.entry("c1").agent?.tasks.map((one) => one.state)).toStrictEqual(["done", "done"]);
    expect([h.relay.summary("main").heldDeliveries, h.relay.summary("solo").heldDeliveries, h.pumped]).toStrictEqual([
      2,
      1,
      [],
    ]);
  });

  it("lets go the hold once nothing held is left, the restart's or a stall's", async () => {
    const h = harness(session("main", { deliveries: [notice("n1", "t-1", "finished")] }), session("side"));
    await h.relay.start();
    h.sessions.set("side", { ...h.entry("side"), deliveries: [notice("n2", "t-1", "finished", { state: "sending" })] });
    h.relay.deliveries("side").stalled(["n2"]);
    await settle();
    const before = [h.relay.deliveries("main").held(), h.relay.deliveries("side").held()];

    await h.relay.removeDelivery("main", "n1");
    await h.relay.removeDelivery("side", "n2");

    expect(before).toStrictEqual(["restart", "stalled"]);
    expect([h.relay.deliveries("main").held(), h.relay.deliveries("side").held()]).toStrictEqual([null, null]);
  });

  it("holds what pi stalled on as stalled, apart from the restart's count, and lets it go only from its session", async () => {
    const h = harness(
      session("main", { deliveries: [notice("n1", "t-1", "finished", { state: "sending" })] }),
      child("c1", "main", "audit"),
    );
    const deliveries = h.relay.deliveries("main");
    deliveries.stalled(["n1"]);
    await settle();
    const stalled = [deliveries.held(), h.relay.summary("main").heldDeliveries];

    await h.relay.resumeDeliveries("main", true);
    const afterTree = deliveries.held();
    await h.relay.resumeDeliveries("main", false);

    expect(stalled).toStrictEqual(["stalled", 0]);
    expect([afterTree, deliveries.held()]).toStrictEqual(["stalled", null]);
  });

  it("only records what it tells as the host closes, starting no pi and handing nothing over", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1"), task("t-2")] }));
    h.live.delete("main");
    await runTaskStarted(h, "c1", "t-1");
    await h.call("main", "wait", { tasks: ["t-2"] }, "wait-1");
    const pumped = h.pumped.length;

    await h.relay.close();
    await settle();

    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.event, one.reason, one.state])).toStrictEqual([
      ["t-1", "stopped", "host_exit", "waiting"],
    ]);
    expect([h.started, h.pumped.slice(pumped)]).toStrictEqual([[], []]);
  });

  it("leaves a task open when its parent's notice could not be written, so its end is not lost", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    h.failWritesTo("main");

    await runTask(h, "c1", "t-1");

    expect(h.entry("c1").agent?.tasks).toStrictEqual([task("t-1")]);
    expect(h.records.filter((record) => record["msg"] === "child's event not sent")).toHaveLength(1);
  });

  it("gives a wait an event that comes while its write is under way, though the wait's time runs out meanwhile", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    await h.call("main", "wait", { tasks: ["t-1"], waitSeconds: 30 }, "wait-1");
    const written = Promise.withResolvers<void>();
    h.holdWritesTo("main", written.promise);

    await runTask(h, "c1", "t-1");
    h.clock.advance(30_000);
    await settle();
    written.resolve();
    await settle();

    expect(h.reply("wait-1")).toMatchObject({
      ok: true,
      result: { events: [{ taskId: "t-1", event: "finished" }], pending: [], timedOut: false },
    });
    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.state, one.claimedBy])).toStrictEqual([
      ["t-1", "claimed", "wait-1"],
    ]);
  });

  it("puts back as waiting an event a wait took while its write was under way, when the wait was stopped meanwhile", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1"), task("t-2")] }));
    await h.call("main", "wait", { tasks: ["t-1", "t-2"], until: "all" }, "wait-1");
    const written = Promise.withResolvers<void>();
    h.holdWritesTo("main", written.promise);

    await runTask(h, "c1", "t-1");
    await h.note("main", "cancel", { id: "wait-1" });
    written.resolve();
    await settle();

    expect(h.reply("wait-1")).toBeUndefined();
    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.state, one.claimedBy])).toStrictEqual([
      ["t-1", "waiting", undefined],
    ]);
  });

  it("ends at once a wait whose stop came while its child was being made, and stops the child as its run begins", async () => {
    const h = harness(session("main"));
    const made = Promise.withResolvers<void>();
    h.holdCreate(made.promise);
    const spawned = h.call(
      "main",
      "spawn",
      { name: "audit", task: "t", role: "work", place: "worktree", wait: true },
      "spawn-1",
    );
    await settle();

    await h.note("main", "cancel", { id: "spawn-1" });
    made.resolve();
    await spawned;
    await settle();
    const first = present(h.entry("c1").deliveries[0], "the first task");
    h.relay.deliveries("c1").runStarted({ deliveries: [first.id] });
    await settle();
    h.relay.deliveries("c1").runSettled("stopped", false, Promise.resolve(null));
    await settle();

    expect(h.reply("spawn-1")).toBeUndefined();
    expect(h.stopped).toStrictEqual(["c1"]);
    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.event, one.reason, one.state])).toStrictEqual([
      [first.taskId, "stopped", "parent_stopped", "waiting"],
    ]);
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("counts the first answer to a question when two come at once, refuses a different second, and confirms the same", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    await runTaskStarted(h, "c1", "t-1");
    await h.call("c1", "ask", { question: "which?" }, "ask-1");

    h.relay.request("main", 1, callText("reply-1", "reply", { to: "audit", questionId: "ask-1", answer: "left" }));
    h.relay.request("main", 1, callText("reply-2", "reply", { to: "audit", questionId: "ask-1", answer: "right" }));
    h.relay.request("main", 1, callText("reply-3", "reply", { to: "audit", questionId: "ask-1", answer: "left" }));
    await settle();
    const beforeConfirmed = repliesTo(h.commands, "ask-1");
    await h.note("c1", "answered", { id: "ask-1" });
    await settle();
    await h.note("c1", "answered", { id: "ask-1" });

    expect([h.reply("reply-1"), h.reply("reply-2"), h.reply("reply-3")]).toMatchObject([
      { ok: true, result: { delivered: true } },
      { ok: false, code: "agent_question_closed" },
      { ok: true, result: { delivered: true } },
    ]);
    expect(beforeConfirmed).toBe(1);
    expect(replyValues(h.commands, "ask-1").map((value) => value["result"])).toStrictEqual([
      { answered: true, answer: "left" },
      { answered: true, answer: "left" },
    ]);
  });

  it("answers a request repeated after it was answered with the same answer, for a process's latest 64", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    await h.call("main", "list", {}, "l-0");
    await h.call("main", "list", {}, "l-1");
    // A wait stopped is answered nothing, so it takes none of the 64.
    await h.call("main", "wait", { tasks: ["t-1"] }, "wait-1");
    await h.note("main", "cancel", { id: "wait-1" });
    for (const n of Array.from({ length: 63 }, (_, at) => at + 2)) await h.call("main", "list", {}, `l-${String(n)}`);

    await h.call("main", "list", {}, "l-64");
    await h.call("main", "list", {}, "l-1");
    await h.call("main", "list", {}, "l-0");

    const [first, again] = replyValues(h.commands, "l-64");

    expect([repliesTo(h.commands, "l-64"), repliesTo(h.commands, "l-1"), repliesTo(h.commands, "l-0")]).toStrictEqual([
      2, 2, 1,
    ]);
    expect(repliesTo(h.commands, "wait-1")).toBe(0);
    expect(again).toStrictEqual(first);
  });

  it("keeps the latest 16 questions a child no longer has open, so an answer repeated to an older one is refused", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1")] }));
    await runTaskStarted(h, "c1", "t-1");
    await h.call("c1", "ask", { question: "first?" }, "ask-0");
    await h.call("main", "reply", { to: "audit", questionId: "ask-0", answer: "x" }, "reply-0");
    await h.note("c1", "answered", { id: "ask-0" });
    for (const n of Array.from({ length: 16 }, (_, at) => at + 1)) {
      await h.call("c1", "ask", { question: "more?" }, `ask-${String(n)}`);
      await h.note("c1", "closed", { id: `ask-${String(n)}` });
    }

    const again = await h.call("main", "reply", { to: "audit", questionId: "ask-0", answer: "x" }, "reply-again");

    expect(again.answer).toMatchObject({ ok: false, code: "agent_question_closed" });
  });

  it("starts recycled children notices come to only as places free among the six, all of them in time", async () => {
    const h = sevenAsleep();

    for (const handle of SEVEN) h.relay.takenBack(`k-${handle}`);
    await settle();
    const first = [...h.started];
    await runNotices(h, "k-a", "n-a");

    expect(first).toStrictEqual(["k-a", "k-b", "k-c", "k-d", "k-e", "k-f"]);
    expect(h.started).toStrictEqual([...first, "k-g"]);
  });

  it("lets go seven children held since a restart within the six, and the seventh once a place frees", async () => {
    const h = sevenAsleep();
    await h.relay.start();

    await h.relay.resumeDeliveries("main", true);
    const first = [...h.started];
    await runNotices(h, "k-b", "n-b");

    expect(first).toStrictEqual(["k-a", "k-b", "k-c", "k-d", "k-e", "k-f"]);
    expect(h.started).toStrictEqual([...first, "k-g"]);
  });

  it("wakes a child waiting for a place when a sibling ends, or a run you opened in one ends", async () => {
    const h = sevenAsleep();
    for (const handle of SEVEN) h.relay.takenBack(`k-${handle}`);
    await settle();
    await h.relay.ended("k-a", "archived");
    await settle();
    const yours = sevenAsleep();
    yours.tabs.add("k-c");
    for (const handle of SEVEN) yours.relay.takenBack(`k-${handle}`);
    await settle();

    await yours.relay.deliveries("k-c").confirm(["n-c"]);
    yours.relay.deliveries("k-c").runStarted("user");
    yours.relay.deliveries("k-c").runSettled("completed", false, Promise.resolve(null));
    await settle();

    const all = SEVEN.map((handle) => `k-${handle}`);
    expect([h.started, yours.started]).toStrictEqual([all, all]);
  });

  it("wakes a child waiting with a place free when a sibling's run ends, not when one of a session you opened does", async () => {
    const h = harness(
      session("main"),
      session("u1", { parent: { sessionId: "main", by: "user" } }),
      child("k-b", "main", "b"),
      // As after its start failed: a place is free, and it waits.
      child("k-a", "main", "a", { tasks: [task("t-a", { state: "done" })], entry: { deliveries: [fromBelow("n-a")] } }),
    );
    h.live.delete("k-a");

    h.relay.deliveries("u1").runStarted("user");
    h.relay.deliveries("u1").runSettled("completed", false, Promise.resolve(null));
    await settle();
    const before = [...h.started];
    h.relay.deliveries("k-b").runStarted("user");
    h.relay.deliveries("k-b").runSettled("completed", false, Promise.resolve(null));
    await settle();

    expect([before, h.started]).toStrictEqual([[], ["k-a"]]);
  });

  it("lets the queue of a child stopped or crashed out go again when the agent sends it a task", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit"),
      child("c2", "main", "tests"),
      child("c3", "main", "lint"),
    );
    h.states.set("c1", { ...IDLE, paused: "stopped" });
    h.states.set("c2", { ...IDLE, paused: "crashed", failed: true });

    await h.call("main", "send", { to: "audit", message: "go" });
    await h.call("main", "send", { to: "tests", message: "go" });
    await h.call("main", "send", { to: "lint", message: "go" });

    expect(h.resumed).toStrictEqual(["c1", "c2"]);
  });

  it("drops the tasks a detached child had waiting from its old parent, and still tells that parent it ended", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", {
        tasks: [task("t-1"), task("t-2")],
        entry: {
          parent: null,
          deliveries: [
            { id: "k2", kind: "task", from: "main", taskId: "t-2", text: "t", at: 1, state: "waiting" },
            { id: "k3", kind: "task", from: "main", taskId: "t-1", text: "t", at: 1, state: "sending" },
            fromBelow("n1"),
          ],
        },
      }),
    );

    await h.relay.ended("c1", "detached", "main");

    expect(h.entry("c1").deliveries.map((one) => one.id)).toStrictEqual(["k3", "n1"]);
    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.event, one.reason])).toStrictEqual([
      ["t-1", "ended", "detached"],
      ["t-2", "ended", "detached"],
    ]);
  });

  it("tells the parent a running child archived or handed off ended, though its run's end comes first", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", { tasks: [task("t-1")] }),
      child("c2", "main", "tests", { tasks: [task("t-2")] }),
    );
    await runTaskStarted(h, "c1", "t-1");
    await runTaskStarted(h, "c2", "t-2");

    h.relay.ending("c1");
    h.relay.ending("c2");
    h.relay.deliveries("c1").runSettled("failed", false, Promise.resolve(null));
    h.relay.deliveries("c2").runSettled("failed", false, Promise.resolve(null));
    await settle();
    await h.relay.ended("c1", "archived");
    await h.relay.ended("c2", "handed_off");

    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.event, one.reason])).toStrictEqual([
      ["t-1", "ended", "archived"],
      ["t-2", "ended", "handed_off"],
    ]);
  });

  it("tells the parent a child's run ended again once every stop for an archive or hand-off called off is over", async () => {
    const h = harness(session("main"), child("c1", "main", "audit", { tasks: [task("t-1"), task("t-2")] }));
    const first = h.relay.ending("c1");
    const second = h.relay.ending("c1");

    first();
    first();
    await runTask(h, "c1", "t-1", "failed");
    second();
    await runTask(h, "c1", "t-2");

    expect(h.entry("main").deliveries.map((one) => [one.taskId, one.event])).toStrictEqual([["t-2", "finished"]]);
  });

  it("ends a task quietly when you remove its delivery, and a first one stops counting as being created", async () => {
    const h = harness(session("main"));
    await h.call("main", "spawn", { name: "audit", task: "t" }, "spawn-1");
    const delivery = present(h.entry("c1").deliveries[0], "the first task");

    await h.relay.removeDelivery("c1", delivery.id);
    const waited = await h.call("main", "wait", { tasks: [delivery.taskId] }, "wait-1");

    expect(h.entry("c1").agent?.tasks.map((one) => [one.taskId, one.state])).toStrictEqual([[delivery.taskId, "done"]]);
    expect(h.relay.summary("c1").agent?.status).toBe("idle");
    expect(h.entry("main").deliveries).toStrictEqual([]);
    expect(waited.answer).toMatchObject({ ok: true, result: { events: [], pending: [], timedOut: false } });
  });

  it("drops the first task of a child that could not start, which its parent was told failed", async () => {
    const h = harness(session("main"));
    h.failStarts();

    await h.call("main", "spawn", { name: "audit", task: "t" }, "spawn-1");
    await settle();

    expect(h.entry("c1").deliveries).toStrictEqual([]);
    expect(h.entry("main").deliveries.map((one) => [one.event, one.reason])).toStrictEqual([
      ["failed", "start_failed"],
    ]);
  });

  it("gives a work child's branch and what its worktree changed with its finished event", async () => {
    const h = harness(
      session("main", { deliveries: [notice("n1", "t-1", "finished")] }),
      child("c1", "main", "audit", {
        worktree: true,
        role: "work",
        tasks: [task("t-1", { state: "done" })],
        entry: { cwd: "/w" },
      }),
    );
    h.setWorkChanges({ branch: "agent/audit", changes: { files: 2, added: 10, removed: 3 } });

    const command = decode(present(await h.relay.deliveries("main").command(["n1"]), "the command"));

    expect(command.value["events"]).toStrictEqual([
      {
        name: "audit",
        title: "audit",
        sessionId: "c1",
        taskId: "t-1",
        event: "finished",
        workspace: "/w",
        branch: "agent/audit",
        changes: { files: 2, added: 10, removed: 3 },
      },
    ]);
  });
});

describe("agent relay: ask_user (SPEC-0003)", () => {
  /** One question, as the extension sends it. */
  const questions = [
    {
      header: "范围",
      question: "改到哪为止？",
      multiSelect: false,
      options: [
        { label: "只改收件箱", description: "", preview: null, recommended: true },
        { label: "整个侧栏", description: "", preview: null, recommended: false },
      ],
    },
  ];

  it("hands the session's controller the questions, and replies with how you answered once you did", async () => {
    const h = harness(session("main"));

    const { id, answer } = await h.call("main", "ask_user", { questions });
    present(h.asked.get(`main#${id}`), "the questions held")({ outcome: "skipped" });
    await settle();

    expect(answer).toBeUndefined();
    expect(h.reply(id)).toStrictEqual({ v: 1, id, ok: true, result: { outcome: "skipped" } });
  });

  it("refuses a child the agent opened, however deep, and lets one you opened ask", async () => {
    const h = harness(
      session("main"),
      child("c1", "main", "audit", { role: "work" }),
      child("c2", "c1", "deeper", { role: "work" }),
      session("yours", { parent: { sessionId: "main", by: "user" } }),
    );

    const first = await h.call("c1", "ask_user", { questions });
    const deep = await h.call("c2", "ask_user", { questions });
    const yours = await h.call("yours", "ask_user", { questions });

    expect([first.answer, deep.answer]).toStrictEqual([
      { v: 1, id: first.id, ok: false, code: "ask_user_unavailable" },
      { v: 1, id: deep.id, ok: false, code: "ask_user_unavailable" },
    ]);
    expect(yours.answer).toBeUndefined();
    expect([...h.asked.keys()]).toStrictEqual([`yours#${yours.id}`]);
  });

  it("answers nothing for questions dropped, and drops them when the extension gives the call up", async () => {
    const h = harness(session("main"));

    const { id } = await h.call("main", "ask_user", { questions });
    present(h.asked.get(`main#${id}`), "the questions held")(null);
    await h.note("main", "cancel", { id });

    expect(h.reply(id)).toBeUndefined();
    expect(h.dropped).toStrictEqual([`main#${id}`]);
  });

  it("takes a give-up from a session whose pi has gone, quietly", async () => {
    const h = harness(session("main"));
    h.live.delete("main");

    await h.note("main", "cancel", { id: "call-1" });

    expect(h.records.filter((record) => record["msg"] === "agent note failed")).toStrictEqual([]);
  });

  it("refuses questions while another call's are open, and fails them in a session whose pi has gone", async () => {
    const h = harness(session("main"), session("gone"));
    h.live.delete("gone");

    await h.call("main", "ask_user", { questions });
    const second = await h.call("main", "ask_user", { questions });
    const gone = await h.call("gone", "ask_user", { questions });

    expect(second.answer).toStrictEqual({ v: 1, id: second.id, ok: false, code: "agent_bad_request" });
    expect(gone.answer).toStrictEqual({ v: 1, id: gone.id, ok: false, code: "agent_failed" });
  });
});
