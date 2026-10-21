import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { encodeArgument, noteText } from "./agent";
import { type AgentRequest, type Delivery, TEXT_LIMITS, readRequest } from "./channel";
import atriumAgent, {
  type AgentApi,
  type AgentDeps,
  type SessionEntryView,
  type SessionView,
  branchWithPi,
  parentCalls,
  refusal,
  selfOf,
} from "./extension";
import { askText, errorText, reportText, resultText, taskText } from "./words";

/** A note as the host sends it and the custom message keeps it. */
const NOTE = { v: 1, kind: "note", note: "worktree_moved", from: "/repo", to: "/repo.worktrees/tests" } as const;

/** A task as the host delivers it (SPEC-0002, "送达"). */
const TASK: Extract<Delivery, { kind: "task" }> = {
  v: 1,
  kind: "task",
  deliveries: ["d-1"],
  from: "main",
  fromTitle: "修复",
  taskId: "t-1",
  text: "look at auth",
  preamble: { role: "explore", forked: false, canSpawn: true },
};

/** A forked child's first task, as the host delivers it. */
const FORKED_TASK: Extract<Delivery, { kind: "task" }> = {
  ...TASK,
  preamble: { role: "work", forked: true, canSpawn: true },
};

/** A child's later task, without the preamble. */
const { preamble: _preamble, ...LATER_TASK } = TASK;

/** What the hook answers a forked child that redoes its parent's call. */
const THEIRS = {
  block: true,
  reason:
    "This call belongs to the parent conversation, which handles it; do not redo it. Do only the task you were given.",
};

/** One of the tools the extension registered, as pi would call it. */
type Tool = Parameters<AgentApi["registerTool"]>[0];

/** What the hook answers. */
type Verdict = unknown;

/**
 * Calls a hook the extension registered.
 *
 * @remarks
 * pi's `on` is overloaded per event; the stand-in keeps each hook by its event.
 *
 * @sideEffects As the hook's.
 * @param hook - The hook.
 * @param args - Its arguments.
 * @returns What it answered.
 * @throws {Error} When no such hook was registered.
 */
function callHook(hook: unknown, args: readonly unknown[]): unknown {
  if (typeof hook !== "function") throw new Error("no such hook");
  return Reflect.apply(hook, undefined, args);
}

/** A timer the stand-in keeps instead of setting it. */
interface Timer {
  readonly ms: number;
  readonly fire: () => void;
  cleared: boolean;
}

/** The extension registered against a stand-in for pi, with what it did. */
interface Stand {
  readonly tools: Map<string, Tool>;
  readonly flags: string[];
  readonly hooks: string[];
  readonly commands: string[];
  /** Every `setStatus`, in order. */
  readonly statuses: [string, string | undefined][];
  readonly sent: unknown[];
  readonly timers: Timer[];
  /** The branches cut, as `[file, dir, leaf]`. */
  readonly branches: [string, string, string][];
  /** The session the tools and hook see. */
  readonly session: { file: string | undefined; leaf: string | null; branch: SessionEntryView[] };
  readonly run: (args: string) => Promise<void>;
  readonly hook: (toolName: string, input: unknown) => Verdict;
  readonly call: (tool: string, id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

/**
 * Registers the extension against a stand-in for pi.
 *
 * @remarks
 * Keeps what it registered, the statuses it wrote, the messages it sent and the timers it set;
 * `branch` stands in for pi's branching.
 *
 * @sideEffects none
 * @param options - The host's flag, and what branching gives.
 * @returns The stand-in.
 */
function stand(options: { flag?: string; branch?: (dir: string) => string | undefined } = {}): Stand {
  const tools = new Map<string, Tool>();
  const flags: string[] = [];
  const hooks: string[] = [];
  const commands: string[] = [];
  const statuses: [string, string | undefined][] = [];
  const sent: unknown[] = [];
  const timers: Timer[] = [];
  const branches: [string, string, string][] = [];
  const session = {
    file: "/s/parent.jsonl" as string | undefined,
    leaf: "e9" as string | null,
    branch: [] as SessionEntryView[],
  };
  let handler:
    | ((
        args: string,
        ctx: { readonly ui: { setStatus(key: string, text: string | undefined): void } },
      ) => Promise<void>)
    | null = null;
  const hookOf = new Map<string, unknown>();
  const ui = { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) };
  const view: SessionView = {
    getSessionFile: () => session.file,
    getLeafId: () => session.leaf,
    getBranch: () => session.branch,
  };
  const deps: AgentDeps = {
    setTimeout: (fire, ms) => {
      const timer = { ms, fire, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer !== null) (timer as Timer).cleared = true;
    },
    branch: (_session, file, dir, leaf) => {
      branches.push([file, dir, leaf]);
      return (options.branch ?? ((at) => `${at}/branch.jsonl`))(dir);
    },
  };
  atriumAgent(
    {
      registerCommand: (name, command) => {
        commands.push(`${name}: ${command.description}`);
        handler = command.handler;
      },
      sendMessage: (custom, sendOptions) => sent.push([custom, sendOptions]),
      registerTool: (tool) => tools.set(tool.name, tool),
      registerFlag: (name, flag) => flags.push(`${name} (${flag.type}): ${flag.description}`),
      getFlag: () => options.flag,
      on: (event, hook) => {
        hooks.push(event);
        hookOf.set(event, hook);
      },
    },
    deps,
  );
  return {
    tools,
    flags,
    hooks,
    commands,
    statuses,
    sent,
    timers,
    branches,
    session,
    run: (args) => present(handler)(args, { ui }),
    hook: (toolName, input) =>
      callHook(hookOf.get("tool_call"), [
        { toolName, toolCallId: "c", input },
        { ui, sessionManager: view },
      ]),
    call: (tool, id, params, signal) =>
      present(tools.get(tool)).execute(id, params, signal, undefined, { ui, sessionManager: view }),
  };
}

/**
 * The value, which a test needs there.
 *
 * @remarks
 * A missing one fails the test.
 *
 * @sideEffects none
 * @param value - The value.
 * @returns It.
 * @throws {Error} When it is missing.
 */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing");
  return value;
}

/**
 * The requests the extension wrote into its statuses, in order.
 *
 * @remarks
 * Clearing a status writes `undefined`, which is not a request.
 *
 * @sideEffects none
 * @param statuses - The statuses.
 * @returns The requests.
 */
function requests(statuses: readonly [string, string | undefined][]): AgentRequest[] {
  return statuses.flatMap(([, text]) => {
    const read = text === undefined ? null : readRequest(text);
    return read !== null && "request" in read ? [read.request] : [];
  });
}

/**
 * The statuses the extension cleared, in order.
 *
 * @remarks
 * Every request's key is cleared once answered or done (ADR-0013, point 1).
 *
 * @sideEffects none
 * @param statuses - The statuses.
 * @returns Their keys.
 */
function cleared(statuses: readonly [string, string | undefined][]): string[] {
  return statuses.flatMap(([key, text]) => (text === undefined ? [key] : []));
}

/**
 * The host's answer to a call, as the hidden command's arguments.
 *
 * @remarks
 * `reply <base64url JSON>` (ADR-0013, point 2).
 *
 * @sideEffects none
 * @param id - The call's id.
 * @param result - What it answers.
 * @returns The arguments.
 */
function answer(id: string, result: unknown): string {
  return `reply ${encodeArgument({ v: 1, id, ok: true, result })}`;
}

/**
 * Lets the extension's promise callbacks run.
 *
 * @remarks
 * Its answers settle promises a tick later.
 *
 * @sideEffects none
 * @returns Once they ran.
 */
async function settled(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

/**
 * What the model is told of each tool, as SPEC-0002 defines it ("工具"): label, description and
 * parameters, the limits the extension checks itself written into the descriptions.
 */
const DECLARED: Record<string, unknown> = {
  agent_spawn: {
    label: "Start sub-agent",
    description:
      "Start a sub-agent: a child conversation that works on a task in parallel and reports back. Good for independent research that can run in parallel, a review by another model, or changes whose files do not overlap; do simple lookups yourself. By default it runs in the background and you get a notice when it finishes. Sub-agents' replies are not shown to the user: tell them what matters. Do not poll, and do not make up results that have not come back. Let only one sub-agent write in a directory at a time.",
    promptSnippet: "Start a sub-agent on a task in the background",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Its handle, never changed or reused: a lowercase letter then up to 39 lowercase letters, digits or hyphens, like auth-audit.",
        },
        task: {
          type: "string",
          minLength: 1,
          description: "What it should do, with everything it needs. At most 32000 characters.",
        },
        role: {
          type: "string",
          enum: ["explore", "work", "advise"],
          description:
            "explore: read-only research (default). work: may change files. advise: read-only review, often on another model.",
        },
        context: {
          type: "string",
          enum: ["none", "fork"],
          description: "fork: it starts with this whole conversation so far. Default none.",
        },
        place: {
          type: "string",
          enum: ["same", "worktree"],
          description:
            "worktree: its own new git worktree (work only). Default: worktree for work when possible, else same.",
        },
        model: {
          type: "string",
          description: "provider/modelId; default yours. Call agent_models if unsure.",
        },
        thinking: {
          type: "string",
          enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
          description: "Thinking level; default yours, adjusted to what the model supports.",
        },
        wait: {
          type: "boolean",
          description: "Wait for this task's result before returning. Default false.",
        },
        waitSeconds: {
          type: "integer",
          minimum: 30,
          maximum: 3600,
          description: "With wait, how long to wait at most; the sub-agent goes on after. Default 600.",
        },
      },
      required: ["name", "task"],
      additionalProperties: false,
    },
  },
  agent_send: {
    label: "Message sub-agent",
    description:
      "Give one of your sub-agents its next task. It goes on with its whole conversation; if it is running, the task waits for its current run to end. Sub-agents' replies are not shown to the user: tell them what matters. Do not poll, and do not make up results that have not come back. Let only one sub-agent write in a directory at a time.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          minLength: 1,
          description: 'The sub-agent: its name (handle), or "id:<session id>".',
        },
        message: {
          type: "string",
          minLength: 1,
          description: "The task. At most 32000 characters.",
        },
        wait: {
          type: "boolean",
          description: "Wait for this task's result before returning. Default false.",
        },
        waitSeconds: {
          type: "integer",
          minimum: 30,
          maximum: 3600,
          description: "With wait, how long to wait at most; the sub-agent goes on after. Default 600.",
        },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
  },
  agent_wait: {
    label: "Wait for sub-agents",
    description:
      "Wait for your sub-agents' tasks. Use it only when you started several and need all their results to go on; otherwise end your turn and wait for notices. Returns early when the user sends a message or a sub-agent asks you a question.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "string",
          },
          description:
            "Task ids to wait for; default all of yours that have not ended, and those whose result has not reached you yet. Pass the ids agent_spawn returned.",
        },
        until: {
          type: "string",
          enum: ["any", "all"],
          description: "any (default): the first event; all: every task ended.",
        },
        waitSeconds: {
          type: "integer",
          minimum: 30,
          maximum: 3600,
          description: "With wait, how long to wait at most; the sub-agent goes on after. Default 600.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  agent_reply: {
    label: "Answer sub-agent",
    description: "Answer a question a sub-agent asked you with ask_parent.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          minLength: 1,
          description: 'The sub-agent: its name (handle), or "id:<session id>".',
        },
        questionId: {
          type: "string",
          description: "The question's id, from its notice.",
        },
        answer: {
          type: "string",
          minLength: 1,
          description: "Your answer. At most 8000 characters.",
        },
      },
      required: ["to", "questionId", "answer"],
      additionalProperties: false,
    },
  },
  agent_list: {
    label: "List sub-agents",
    description: "List your sub-agents, with their status and open tasks.",
    parameters: {
      type: "object",
      properties: {
        includeEnded: {
          type: "boolean",
          description: "Also list archived and handed-off ones. Default false.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  agent_read: {
    label: "Read sub-agent",
    description: "Read a sub-agent's reply to a task, page by page, or its latest steps.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          minLength: 1,
          description: 'The sub-agent: its name (handle), or "id:<session id>".',
        },
        taskId: {
          type: "string",
          description: "The task; default its latest.",
        },
        what: {
          type: "string",
          enum: ["reply", "steps"],
          description: "reply (default) or steps.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "For reply: where to start, in characters.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 16000,
          description: "Characters (reply, default 8000) or steps (default 10, at most 50).",
        },
      },
      required: ["to"],
      additionalProperties: false,
    },
  },
  agent_stop: {
    label: "Stop sub-agent",
    description:
      "Stop a sub-agent's current run, and the running sub-agents it started. Its conversation stays: agent_send gives it more work.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          minLength: 1,
          description: 'The sub-agent: its name (handle), or "id:<session id>".',
        },
      },
      required: ["to"],
      additionalProperties: false,
    },
  },
  agent_models: {
    label: "List models",
    description: "List the models a sub-agent can use, with the thinking levels each supports.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  report_progress: {
    label: "Report progress",
    description:
      "Tell the agent that started you how the task is going, without interrupting it. It sees this with your next result; keep it short.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          minLength: 1,
          description: "The progress. At most 2000 characters.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  ask_parent: {
    label: "Ask parent agent",
    description:
      "Ask the agent that started you a question and wait for its answer, instead of guessing. If it does not answer in time, go on with your own judgment and say what you assumed in your final reply.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          minLength: 1,
          description: "The question. At most 4000 characters.",
        },
        options: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 6,
          description: "Possible answers, if any.",
        },
        timeoutSeconds: {
          type: "integer",
          minimum: 60,
          maximum: 3600,
          description: "How long to wait for an answer. Default 600.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
};

/**
 * Each registered tool without its code: what the model and pi see of it.
 *
 * @sideEffects none
 * @param tools - The tools, by name.
 * @returns Their declarations, by name.
 */
function declarations(tools: ReadonlyMap<string, Tool>): Record<string, unknown> {
  return Object.fromEntries(
    [...tools].map(([name, tool]) => [
      name,
      Object.fromEntries(Object.entries(tool).filter(([key]) => key !== "name" && key !== "execute")),
    ]),
  );
}

/**
 * A session whose class is the given value, as the extension reaches pi's class through it.
 *
 * @sideEffects none
 * @param manager - What its constructor is.
 * @returns The session.
 */
function sessionOf(manager: unknown): SessionView {
  const session: SessionView = { getSessionFile: () => undefined, getLeafId: () => null, getBranch: () => [] };
  Object.defineProperty(session, "constructor", { value: manager });
  return session;
}

describe("Atrium's extension: child conversations", () => {
  it("registers the ten tools, the command, the flag and the tool hook, and fits pi's extension API", () => {
    const { tools, flags, hooks, commands } = stand();

    expectTypeOf<ExtensionAPI>().toExtend<AgentApi>();
    expect([...tools.keys()]).toStrictEqual([
      "agent_spawn",
      "agent_send",
      "agent_wait",
      "agent_reply",
      "agent_list",
      "agent_read",
      "agent_stop",
      "agent_models",
      "report_progress",
      "ask_parent",
    ]);
    expect([flags, hooks, commands]).toStrictEqual([
      ["atrium-agent (string): Who this session is, set by Atrium's host"],
      ["tool_call"],
      ["atrium-agent: Atrium's child conversations, sent by Atrium's host"],
    ]);
    expect(tools.get("agent_spawn")?.parameters).toMatchObject({
      required: ["name", "task"],
      additionalProperties: false,
    });
  });

  it("declares each tool to the model with the parameters and limits SPEC-0002 gives it", () => {
    const { tools } = stand();

    expect(declarations(tools)).toStrictEqual(DECLARED);
  });

  it("writes a note into the session as an atrium-agent custom message, without starting a run", async () => {
    const { run, sent } = stand();

    await run(`  note   ${encodeArgument(NOTE)}\n`);

    expect(sent).toStrictEqual([
      [
        {
          customType: "atrium-agent",
          content: noteText({ note: "worktree_moved", from: "/repo", to: "/repo.worktrees/tests" }),
          display: true,
          details: NOTE,
        },
        { triggerTurn: false },
      ],
    ]);
  });

  it("does nothing for another action, anything it cannot read, or no argument", async () => {
    const { run, sent, statuses } = stand();

    await run(`fly ${encodeArgument(NOTE)}`);
    await run(`note ${encodeArgument({ ...NOTE, v: 2 })}`);
    await run(`deliver ${encodeArgument({ v: 1, kind: "task" })}`);
    await run(`reply ${encodeArgument({ v: 1, id: "nobody", ok: true, result: {} })}`);
    await run(`cancel ${encodeArgument({ v: 1, id: "nobody", reason: "archived" })}`);
    await run("reply not-json");
    await run("cancel not-json");
    await run(`fly ${encodeArgument(TASK)}`);
    await run("note");
    await run("");

    expect([sent, statuses]).toStrictEqual([[], []]);
  });
});

describe("the main agent's tools", () => {
  it("ask the host with the tool call's id, and word its answer, with the answer as details", async () => {
    const { call, run, statuses } = stand();
    const result = { to: "audit", sessionId: "s-1", taskId: "t-2", queued: false };

    const pending = call("agent_send", "call-1", { to: "audit", message: "go on" });
    await settled();
    const asked = requests(statuses);
    await run(answer("call-1", result));

    expect(asked).toStrictEqual([{ kind: "call", id: "call-1", op: "send", args: { to: "audit", message: "go on" } }]);
    expect(statuses[0]?.[0]).toBe("atrium-agent:call-1");
    expect(await pending).toStrictEqual({
      content: [{ type: "text", text: resultText("send", result) }],
      details: result,
    });
    expect(cleared(statuses)).toStrictEqual(["atrium-agent:call-1"]);
  });

  it("make each its own call", async () => {
    const { call, statuses } = stand();
    const ops = [
      ["agent_spawn", { name: "a", task: "t" }],
      ["agent_wait", {}],
      ["agent_reply", { to: "a", questionId: "q", answer: "x" }],
      ["agent_list", {}],
      ["agent_read", { to: "a" }],
      ["agent_stop", { to: "a" }],
      ["agent_models", {}],
    ] as const;

    for (const [tool, params] of ops) void call(tool, tool, params);
    await settled();

    expect(requests(statuses).map((request) => request.op)).toStrictEqual([
      "spawn",
      "wait",
      "reply",
      "list",
      "read",
      "stop",
      "models",
    ]);
  });

  it("word the host's failure for the model, as an error with the code as details", async () => {
    const { call, run } = stand();

    const pending = call("agent_spawn", "call-1", { name: "audit", task: "t" });
    await settled();
    await run(
      `reply ${encodeArgument({ v: 1, id: "call-1", ok: false, code: "agent_limit", params: { children: ["a"] } })}`,
    );

    expect(await pending).toStrictEqual({
      content: [{ type: "text", text: errorText("agent_limit", { children: ["a"] }) }],
      details: { error: "agent_limit", params: { children: ["a"] } },
      isError: true,
    });
  });

  it("take only the first answer to a call", async () => {
    const { call, run, statuses } = stand();

    const pending = call("agent_reply", "call-1", { to: "a", questionId: "q", answer: "x" });
    await settled();
    await run(answer("call-1", { delivered: true }));
    await run(answer("call-1", { delivered: "unknown" }));

    expect(await pending).toMatchObject({ details: { delivered: true } });
    expect(cleared(statuses)).toStrictEqual(["atrium-agent:call-1"]);
  });

  it("refuse text over its limit without asking the host, and ask with text at it", async () => {
    const { call, statuses } = stand();
    const over = [
      ["agent_spawn", { name: "a", task: "x".repeat(TEXT_LIMITS.task + 1) }, "task", TEXT_LIMITS.task],
      ["agent_send", { to: "a", message: "x".repeat(TEXT_LIMITS.message + 1) }, "message", TEXT_LIMITS.message],
      [
        "agent_reply",
        { to: "a", questionId: "q", answer: "x".repeat(TEXT_LIMITS.answer + 1) },
        "answer",
        TEXT_LIMITS.answer,
      ],
      ["ask_parent", { question: "x".repeat(TEXT_LIMITS.question + 1) }, "question", TEXT_LIMITS.question],
      ["report_progress", { message: "x".repeat(TEXT_LIMITS.progress + 1) }, "message", TEXT_LIMITS.progress],
    ] as const;

    const results = await Promise.all(over.map(([tool, params]) => call(tool, tool, params)));
    void call("agent_spawn", "at", { name: "a", task: "x".repeat(TEXT_LIMITS.task) });
    void call("report_progress", "p", { message: "x".repeat(TEXT_LIMITS.progress) });
    await settled();

    expect(results).toStrictEqual(
      over.map(([, , field, max]) => ({
        content: [{ type: "text", text: errorText("agent_text_too_long", { field, max }) }],
        details: { error: "agent_text_too_long", params: { field, max } },
        isError: true,
      })),
    );
    expect(requests(statuses).map((request) => request.op)).toStrictEqual(["spawn", "progress"]);
  });

  it("end at once when stopped, tell the host they no longer wait, and drop a late answer", async () => {
    const { call, run, statuses } = stand();
    const stop = new AbortController();

    const pending = call("agent_wait", "call-1", {}, stop.signal);
    await settled();
    stop.abort();
    const result = await pending;
    await run(answer("call-1", { events: [], timedOut: false, pending: [], progress: [] }));

    expect(result).toStrictEqual({
      content: [{ type: "text", text: "Stopped." }],
      details: { stopped: true },
      isError: true,
    });
    expect(requests(statuses)).toStrictEqual([
      { kind: "call", id: "call-1", op: "wait", args: {} },
      { kind: "note", id: "n1", op: "cancel", args: { id: "call-1" } },
    ]);
    expect(cleared(statuses)).toStrictEqual(["atrium-agent:call-1", "atrium-agent:n1"]);
  });

  it("leave the host alone when stopped after its answer came", async () => {
    const { call, run, statuses } = stand();
    const stop = new AbortController();

    const pending = call("agent_send", "call-1", { to: "audit", message: "go on" }, stop.signal);
    await settled();
    await run(answer("call-1", { to: "audit", sessionId: "s-1", taskId: "t-2", queued: false }));
    await pending;
    const before = statuses.length;
    stop.abort();

    expect(statuses.slice(before)).toStrictEqual([]);
  });

  it("do not ask at all when already stopped", async () => {
    const { call, statuses } = stand();

    const result = await call("agent_list", "call-1", {}, AbortSignal.abort());

    expect(result).toMatchObject({ content: [{ type: "text", text: "Stopped." }] });
    expect(statuses).toStrictEqual([]);
  });
});

describe("agent_spawn with context", () => {
  it("cuts the session where the call was made into the host's directory, then asks with the branch", async () => {
    const { call, run, statuses, branches, session } = stand();
    const params = { name: "audit", task: "look", context: "fork" };

    const pending = call("agent_spawn", "call-1", params);
    session.leaf = "e10";
    await settled();
    await run(answer("call-1/branch", { dir: "/home/tmp/b1" }));
    await settled();
    const asked = requests(statuses);
    await run(answer("call-1", { name: "audit" }));
    await pending;

    expect(asked).toStrictEqual([
      { kind: "call", id: "call-1/branch", op: "branch", args: {} },
      { kind: "call", id: "call-1", op: "spawn", args: { ...params, branch: "/home/tmp/b1/branch.jsonl" } },
    ]);
    expect(branches).toStrictEqual([["/s/parent.jsonl", "/home/tmp/b1", "e9"]]);
  });

  it("cannot without a file or a leaf, or when the branch is not written, and asks nothing more", async () => {
    const noFile = stand();
    noFile.session.file = undefined;
    const noLeaf = stand();
    noLeaf.session.leaf = null;
    const unwritten = stand({ branch: () => undefined });
    const throwing = stand({
      branch: () => {
        throw new Error("disk full");
      },
    });
    const unavailable = {
      content: [{ type: "text", text: errorText("agent_context_unavailable") }],
      details: { error: "agent_context_unavailable" },
      isError: true,
    };

    const results = await Promise.all(
      [noFile, noLeaf].map((one) => one.call("agent_spawn", "c", { name: "a", task: "t", context: "fork" })),
    );
    const cut = [unwritten, throwing].map((one) =>
      one.call("agent_spawn", "c", { name: "a", task: "t", context: "fork" }),
    );
    await settled();
    await Promise.all([unwritten, throwing].map((one) => one.run(answer("c/branch", { dir: "/d" }))));

    expect(results).toStrictEqual([unavailable, unavailable]);
    expect(await Promise.all(cut)).toStrictEqual([unavailable, unavailable]);
    expect([noFile, noLeaf].map((one) => one.statuses)).toStrictEqual([[], []]);
    expect(requests(unwritten.statuses).map((request) => request.op)).toStrictEqual(["branch"]);
  });

  it("cannot when the host's answer gives no directory, and cuts nothing", async () => {
    const given = [null, "/d", {}, { dir: 7 }];
    const stands = given.map(() => stand());
    const unavailable = {
      content: [{ type: "text", text: errorText("agent_context_unavailable") }],
      details: { error: "agent_context_unavailable" },
      isError: true,
    };

    const pending = stands.map((one) => one.call("agent_spawn", "c", { name: "a", task: "t", context: "fork" }));
    await settled();
    await Promise.all(stands.map((one, at) => one.run(answer("c/branch", given[at]))));
    await settled();

    expect(stands.map((one) => [one.branches, requests(one.statuses).map((request) => request.op)])).toStrictEqual(
      given.map(() => [[], ["branch"]]),
    );
    expect(await Promise.all(pending)).toStrictEqual(given.map(() => unavailable));
  });

  it("answers the host's failure to give a directory, and ends when stopped while asking", async () => {
    const refused = stand();
    const stopping = stand();
    const stop = new AbortController();

    const failed = refused.call("agent_spawn", "c", { name: "a", task: "t", context: "fork" });
    const stopped = stopping.call("agent_spawn", "c", { name: "a", task: "t", context: "fork" }, stop.signal);
    await settled();
    await refused.run(`reply ${encodeArgument({ v: 1, id: "c/branch", ok: false, code: "agent_busy" })}`);
    stop.abort();

    expect(await failed).toMatchObject({ details: { error: "agent_busy" }, isError: true });
    expect(await stopped).toMatchObject({ details: { stopped: true } });
    expect(refused.branches).toStrictEqual([]);
  });

  it("cuts a branch with the class of the session it was given", () => {
    const opened: unknown[] = [];
    /** A stand-in for pi's session manager class. */
    class Manager {
      /**
       * Opens a session file, as pi's does.
       *
       * @remarks
       * Keeps what it was given.
       *
       * @sideEffects Records the call.
       * @param file - The file.
       * @param dir - Where new files go.
       * @returns A manager.
       */
      static open(file: string, dir: string): { createBranchedSession(leaf: string): string } {
        opened.push([file, dir]);
        return { createBranchedSession: (leaf) => `${dir}/${leaf}.jsonl` };
      }

      /**
       * Nothing: the extension reaches the class through an instance.
       *
       * @remarks
       * See the test.
       *
       * @sideEffects none
       * @returns Nothing.
       */
      getSessionFile(): undefined {
        return undefined;
      }

      /**
       * Nothing.
       *
       * @remarks
       * See the test.
       *
       * @sideEffects none
       * @returns Nothing.
       */
      getLeafId(): null {
        return null;
      }

      /**
       * Nothing.
       *
       * @remarks
       * See the test.
       *
       * @sideEffects none
       * @returns No entries.
       */
      getBranch(): SessionEntryView[] {
        return [];
      }
    }

    expect(branchWithPi(new Manager(), "/s/p.jsonl", "/tmp/b", "e9")).toBe("/tmp/b/e9.jsonl");
    expect(opened).toStrictEqual([["/s/p.jsonl", "/tmp/b"]]);
    expect(
      branchWithPi({ getSessionFile: () => undefined, getLeafId: () => null, getBranch: () => [] }, "/f", "/d", "e"),
    ).toBeUndefined();
    expect(
      [
        { open: () => ({ createBranchedSession: () => "/d/b.jsonl" }) },
        Object.assign(() => undefined, { open: () => null }),
        Object.assign(() => undefined, { open: () => "opened" }),
        Object.assign(() => undefined, { open: () => ({ createBranchedSession: "cut" }) }),
        Object.assign(() => undefined, { open: () => ({ createBranchedSession: () => 5 }) }),
      ].map((manager) => branchWithPi(sessionOf(manager), "/f", "/d", "e")),
    ).toStrictEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("report_progress", () => {
  it("tells the host and answers at once, without waiting", async () => {
    const { call, statuses } = stand();

    const result = await call("report_progress", "call-1", { message: "half done" });

    expect(result).toStrictEqual({ content: [{ type: "text", text: "Noted." }], details: {} });
    expect(requests(statuses)).toStrictEqual([
      { kind: "note", id: "n1", op: "progress", args: { message: "half done" } },
    ]);
    expect(cleared(statuses)).toStrictEqual(["atrium-agent:n1"]);
  });
});

describe("ask_parent", () => {
  it("waits for the answer, confirms it took it, and stops its timer", async () => {
    const { call, run, statuses, timers } = stand();

    const pending = call("ask_parent", "call-1", { question: "vitest?", options: ["yes", "no"] });
    await settled();
    await run(answer("call-1", { answered: true, answer: "yes" }));
    const result = await pending;
    await settled();

    expect(result).toStrictEqual({
      content: [{ type: "text", text: askText({ answered: true, answer: "yes" }) }],
      details: { answered: true, answer: "yes" },
    });
    expect(requests(statuses)).toStrictEqual([
      { kind: "call", id: "call-1", op: "ask", args: { question: "vitest?", options: ["yes", "no"] } },
      { kind: "note", id: "n1", op: "answered", args: { id: "call-1" } },
    ]);
    expect(timers.map((timer) => [timer.ms, timer.cleared])).toStrictEqual([[600_000, true]]);
  });

  it("gives up after its own time, tells the host it closed, and closes a late answer", async () => {
    const { call, run, statuses, timers } = stand();

    const pending = call("ask_parent", "call-1", { question: "q", timeoutSeconds: 60 });
    await settled();
    present(timers[0]).fire();
    const result = await pending;
    await run(answer("call-1", { answered: true, answer: "late" }));

    expect(result).toMatchObject({ details: { answered: false, reason: "timeout" } });
    expect(timers.map((timer) => timer.ms)).toStrictEqual([60_000]);
    expect(requests(statuses).slice(1)).toStrictEqual([
      { kind: "note", id: "n1", op: "closed", args: { id: "call-1" } },
      { kind: "note", id: "n2", op: "closed", args: { id: "call-1" } },
    ]);
    expect(cleared(statuses)).toContain("atrium-agent:call-1");
  });

  it("confirms the same answer again, and closes another, once it took one", async () => {
    const { call, run, statuses } = stand();

    const pending = call("ask_parent", "call-1", { question: "q" });
    await settled();
    await run(answer("call-1", { answered: true, answer: "yes" }));
    await pending;
    await settled();
    await run(answer("call-1", { answered: true, answer: "yes" }));
    await run(answer("call-1", { answered: true, answer: "no" }));
    await run(`reply ${encodeArgument({ v: 1, id: "call-1", ok: false, code: "agent_gone" })}`);

    expect(
      requests(statuses)
        .slice(1)
        .map((request) => request.op),
    ).toStrictEqual(["answered", "answered", "closed"]);
  });

  it("closes when the host cancels it, saying whether it had taken an answer", async () => {
    const { call, run, statuses } = stand();

    const open = call("ask_parent", "call-1", { question: "q" });
    const taken = call("ask_parent", "call-2", { question: "q" });
    await settled();
    await run(answer("call-2", { answered: true, answer: "yes" }));
    await settled();
    await run(`cancel ${encodeArgument({ v: 1, id: "call-1", reason: "archived" })}`);
    await run(`cancel ${encodeArgument({ v: 1, id: "call-2", reason: "reply_failed" })}`);

    expect(await open).toMatchObject({ details: { answered: false, reason: "archived" } });
    expect(await taken).toMatchObject({ details: { answered: true } });
    expect(requests(statuses).slice(2)).toStrictEqual([
      { kind: "note", id: "n1", op: "answered", args: { id: "call-2" } },
      { kind: "note", id: "n2", op: "closed", args: { id: "call-1" } },
      { kind: "note", id: "n3", op: "answered", args: { id: "call-2" } },
    ]);
    expect(cleared(statuses)).toStrictEqual([
      "atrium-agent:call-2",
      "atrium-agent:call-2",
      "atrium-agent:n1",
      "atrium-agent:call-1",
      "atrium-agent:n2",
      "atrium-agent:n3",
    ]);
  });

  it("ends when stopped, passes on the host's answer that the turn is the user's, and words a failure", async () => {
    const { call, run, statuses, timers } = stand();
    const stop = new AbortController();

    const stopped = call("ask_parent", "call-1", { question: "q" }, stop.signal);
    const users = call("ask_parent", "call-2", { question: "q" });
    const refused = call("ask_parent", "call-3", { question: "q" });
    await settled();
    stop.abort();
    await run(answer("call-2", { answered: false, reason: "user_turn" }));
    await run(`reply ${encodeArgument({ v: 1, id: "call-3", ok: false, code: "agent_not_allowed" })}`);

    expect(await stopped).toMatchObject({ details: { answered: false, reason: "aborted" } });
    expect(await users).toStrictEqual({
      content: [{ type: "text", text: askText({ answered: false, reason: "user_turn" }) }],
      details: { answered: false, reason: "user_turn" },
    });
    expect(await refused).toMatchObject({ details: { error: "agent_not_allowed" }, isError: true });
    await run(`cancel ${encodeArgument({ v: 1, id: "call-2", reason: "archived" })}`);
    expect(requests(statuses).filter((request) => request.kind === "note")).toStrictEqual([
      { kind: "note", id: "n1", op: "cancel", args: { id: "call-1" } },
      { kind: "note", id: "n2", op: "closed", args: { id: "call-2" } },
    ]);
    expect(timers.map((timer) => timer.cleared)).toStrictEqual([true, true, true]);
  });

  it("takes no answer that came just before a cancel, once the cancel closed the question", async () => {
    const { call, run, statuses } = stand();

    const pending = call("ask_parent", "call-1", { question: "q" });
    await settled();
    void run(answer("call-1", { answered: true, answer: "yes" }));
    await run(`cancel ${encodeArgument({ v: 1, id: "call-1", reason: "archived" })}`);
    const result = await pending;
    await settled();

    expect(result).toStrictEqual({
      content: [{ type: "text", text: askText({ answered: false, reason: "archived" }) }],
      details: { answered: false, reason: "archived" },
    });
    expect(requests(statuses).slice(1)).toStrictEqual([
      { kind: "note", id: "n1", op: "closed", args: { id: "call-1" } },
    ]);
  });

  it("closes a late answer it cannot read", async () => {
    const { call, run, statuses, timers } = stand();

    const pending = call("ask_parent", "call-1", { question: "q" });
    await settled();
    present(timers[0]).fire();
    await pending;
    const before = statuses.length;
    for (const result of [null, "yes", { answered: true, answer: null }]) await run(answer("call-1", result));

    expect(requests(statuses.slice(before))).toStrictEqual([
      { kind: "note", id: "n2", op: "closed", args: { id: "call-1" } },
      { kind: "note", id: "n3", op: "closed", args: { id: "call-1" } },
      { kind: "note", id: "n4", op: "closed", args: { id: "call-1" } },
    ]);
  });

  it("forgets the oldest closed questions past 64, so a late answer to them does nothing", async () => {
    const { call, run, statuses, timers } = stand();

    for (let at = 0; at < 66; at += 1) void call("ask_parent", `q${String(at)}`, { question: "q" });
    await settled();
    for (const timer of timers) timer.fire();
    await settled();
    const before = statuses.length;
    await run(answer("q0", { answered: true, answer: "late" }));
    await run(answer("q1", { answered: true, answer: "late" }));
    await run(answer("q2", { answered: true, answer: "late" }));

    expect(requests(statuses.slice(before))).toStrictEqual([
      { kind: "note", id: "n67", op: "closed", args: { id: "q2" } },
    ]);
  });
});

describe("ask_parent, once closed", () => {
  it("sends no cancel when the run is stopped after its own time or the host closed it", async () => {
    const { call, run, statuses, timers } = stand();
    const stop = new AbortController();

    const timedOut = call("ask_parent", "call-1", { question: "q" }, stop.signal);
    const cancelled = call("ask_parent", "call-2", { question: "q" }, stop.signal);
    await settled();
    present(timers[0]).fire();
    await run(`cancel ${encodeArgument({ v: 1, id: "call-2", reason: "archived" })}`);
    const results = [await timedOut, await cancelled];
    stop.abort();
    await settled();
    await run(answer("call-1", { answered: true, answer: "late" }));

    expect(results).toMatchObject([
      { details: { answered: false, reason: "timeout" } },
      { details: { answered: false, reason: "archived" } },
    ]);
    expect(requests(statuses).filter((request) => request.kind === "note")).toStrictEqual([
      { kind: "note", id: "n1", op: "closed", args: { id: "call-1" } },
      { kind: "note", id: "n2", op: "closed", args: { id: "call-2" } },
      { kind: "note", id: "n3", op: "closed", args: { id: "call-1" } },
    ]);
  });
});

describe("ask_parent, with many questions", () => {
  it("never forgets a question still open, however many closed after it", async () => {
    const { call, run, statuses, timers } = stand();

    const open = call("ask_parent", "q0", { question: "q" });
    for (let at = 1; at < 66; at += 1) void call("ask_parent", `q${String(at)}`, { question: "q" });
    await settled();
    for (const timer of timers.slice(1)) timer.fire();
    await settled();
    const before = statuses.length;
    await run(`cancel ${encodeArgument({ v: 1, id: "q0", reason: "archived" })}`);

    expect(requests(statuses.slice(before))).toStrictEqual([
      { kind: "note", id: "n66", op: "closed", args: { id: "q0" } },
    ]);
    expect(await open).toMatchObject({ details: { answered: false, reason: "archived" } });
  });
});

describe("deliver", () => {
  it("writes notices as a custom message that starts a run or steers, with the reply only in the content", async () => {
    const { run, sent } = stand();
    const delivery: Extract<Delivery, { kind: "report" }> = {
      v: 1,
      kind: "report",
      deliveries: ["d-1", "d-2"],
      events: [
        {
          name: "audit",
          title: "审查",
          sessionId: "s-1",
          taskId: "t-1",
          event: "finished",
          reply: { text: "ok", totalChars: 2 },
        },
        {
          name: "tests",
          title: "测试",
          sessionId: "s-2",
          taskId: "t-2",
          event: "question",
          questionId: "q",
          question: "which?",
          options: ["a"],
        },
      ],
      progress: [{ name: "audit", title: "审查", message: "half" }],
    };

    await run(`deliver ${encodeArgument(delivery)}`);

    expect(sent).toStrictEqual([
      [
        {
          customType: "atrium-agent",
          content: reportText(delivery),
          display: true,
          details: {
            v: 1,
            kind: "report",
            deliveries: ["d-1", "d-2"],
            events: [
              { name: "audit", title: "审查", sessionId: "s-1", taskId: "t-1", event: "finished" },
              {
                name: "tests",
                title: "测试",
                sessionId: "s-2",
                taskId: "t-2",
                event: "question",
                questionId: "q",
                question: "which?",
              },
            ],
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      ],
    ]);
  });

  it("writes a task with its text in the details, and its preamble only in the content", async () => {
    const { run, sent } = stand();
    await run(`deliver ${encodeArgument(TASK)}`);

    expect(sent).toStrictEqual([
      [
        {
          customType: "atrium-agent",
          content: taskText(TASK),
          display: true,
          details: {
            v: 1,
            kind: "task",
            deliveries: ["d-1"],
            from: "main",
            fromTitle: "修复",
            taskId: "t-1",
            text: "look at auth",
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      ],
    ]);
  });
});

describe("the tool hook", () => {
  it("lets a session without the flag use everything but a child's tools", () => {
    const { hook } = stand();

    expect([hook("bash", {}), hook("agent_spawn", {}), hook("report_progress", {})]).toStrictEqual([
      undefined,
      undefined,
      { block: true, reason: "Only a sub-agent can use this tool." },
    ]);
  });

  it("blocks for a forked read-only child what is not on its list, and the main agent's tools at depth 2", () => {
    const explore = stand({
      flag: encodeArgument({ v: 1, child: true, role: "explore", depth: 1, guard: "extension" }),
    });
    const deep = stand({ flag: encodeArgument({ v: 1, child: true, role: "advise", depth: 2, guard: "extension" }) });

    expect(
      ["read", "ls", "ask_parent", "agent_spawn", "bash", "edit", "mcp"].map((tool) => explore.hook(tool, {})),
    ).toStrictEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        block: true,
        reason:
          "This sub-agent is read-only (explore): it can use read, bash, grep, find, ls, report_progress, ask_parent and the agent_* tools.",
      },
      {
        block: true,
        reason:
          "This sub-agent is read-only (explore): it can use read, bash, grep, find, ls, report_progress, ask_parent and the agent_* tools.",
      },
    ]);
    expect([
      deep.hook("bash", { command: "git diff" }),
      deep.hook("agent_send", {}),
      deep.hook("edit", {}),
      deep.hook("write", {}),
    ]).toStrictEqual([
      undefined,
      { block: true, reason: "This sub-agent is too deep to start sub-agents of its own." },
      {
        block: true,
        reason:
          "This sub-agent is read-only (advise): it can use read, bash, grep, find, ls, report_progress, ask_parent.",
      },
      {
        block: true,
        reason:
          "This sub-agent is read-only (advise): it can use read, bash, grep, find, ls, report_progress, ask_parent.",
      },
    ]);
  });

  it("keeps a forked child from redoing its parent's unanswered calls in its first task, whatever their keys' order", () => {
    const forked = stand({ flag: encodeArgument({ v: 1, child: true, role: "work", depth: 1, guard: "extension" }) });
    const flagged = stand({ flag: encodeArgument({ v: 1, child: true, role: "work", depth: 1, guard: "flags" }) });
    const history = [
      message("assistant", [
        toolCall("a", "bash", { command: "ls", timeout: 5 }),
        toolCall("b", "read", { path: "x" }),
      ]),
      message("toolResult", [], "b"),
      task(),
    ];
    forked.session.branch = history;
    flagged.session.branch = history;

    expect([
      forked.hook("bash", { timeout: 5, command: "ls" }),
      forked.hook("bash", { command: "ls -a", timeout: 5 }),
      forked.hook("read", { path: "x" }),
      forked.hook("grep", { timeout: 5, command: "ls" }),
      flagged.hook("bash", { timeout: 5, command: "ls" }),
    ]).toStrictEqual([THEIRS, undefined, undefined, undefined, undefined]);
    forked.session.branch = [...history, task(false)];
    expect(forked.hook("bash", { timeout: 5, command: "ls" })).toBeUndefined();
  });
});

describe("the tool hook, at the fork", () => {
  it("blocks only the parent's batch at the fork, never the child's own call that has no result yet", () => {
    const forked = stand({ flag: encodeArgument({ v: 1, child: true, role: "work", depth: 1, guard: "extension" }) });
    forked.session.branch = [
      message("assistant", [toolCall("a", "bash", { command: "ls" }), toolCall("s", "agent_spawn", { name: "n" })]),
      task(),
      message("assistant", [toolCall("c1", "read", { path: "x" })]),
    ];

    expect([forked.hook("read", { path: "x" }), forked.hook("bash", { command: "ls" })]).toStrictEqual([
      undefined,
      THEIRS,
    ]);
  });

  it("in a grandchild, whose history holds its parent's own first task, blocks the parent's batch and no older one", () => {
    const grandchild = stand({
      flag: encodeArgument({ v: 1, child: true, role: "work", depth: 2, guard: "extension" }),
    });
    grandchild.session.branch = [
      message("assistant", [toolCall("r", "bash", { command: "rm x" }), toolCall("s0", "agent_spawn", { name: "p" })]),
      task(),
      message("assistant", [toolCall("g", "grep", { pattern: "y" })]),
      message("toolResult", [], "g"),
      message("assistant", [toolCall("b", "bash", { command: "pwd" }), toolCall("s1", "agent_spawn", { name: "n" })]),
      task(),
    ];

    expect([grandchild.hook("bash", { command: "pwd" }), grandchild.hook("bash", { command: "rm x" })]).toStrictEqual([
      THEIRS,
      undefined,
    ]);
  });

  it("blocks nothing in a later task, even one after the child's own calls a crash left without results", () => {
    const forked = stand({ flag: encodeArgument({ v: 1, child: true, role: "work", depth: 1, guard: "extension" }) });
    forked.session.branch = [
      message("assistant", [toolCall("a", "bash", { command: "ls" })]),
      task(),
      message("assistant", [toolCall("c1", "bash", { command: "make" })]),
      task(false),
    ];

    expect([forked.hook("bash", { command: "make" }), forked.hook("bash", { command: "ls" })]).toStrictEqual([
      undefined,
      undefined,
    ]);
  });
});

describe("the tool hook, comparing inputs", () => {
  it("matches a parent's call whose input holds nulls and arrays, and tells an array from an object with its keys", () => {
    const forked = stand({ flag: encodeArgument({ v: 1, child: true, role: "work", depth: 1, guard: "extension" }) });
    forked.session.branch = [message("assistant", [toolCall("a", "mcp", { ids: ["x", "y"], filter: null })]), task()];

    expect([
      forked.hook("mcp", { filter: null, ids: ["x", "y"] }),
      forked.hook("mcp", { filter: null, ids: { 0: "x", 1: "y" } }),
    ]).toStrictEqual([THEIRS, undefined]);
  });
});

describe("the tool hook, against pi's checked input", () => {
  it("matches a parent's raw call that pi would have changed: an optional null left out, numbers and booleans as text", () => {
    const forked = stand({ flag: encodeArgument({ v: 1, child: true, role: "work", depth: 1, guard: "extension" }) });
    forked.session.branch = [
      message("assistant", [
        toolCall("a", "bash", { command: "ls", timeout: null }),
        toolCall("b", "bash", { command: "pwd", timeout: "5", login: "true" }),
      ]),
      task(),
    ];

    expect([
      forked.hook("bash", { command: "ls" }),
      forked.hook("bash", { command: "pwd", timeout: 5, login: true }),
      forked.hook("bash", { command: "pwd", timeout: 6, login: true }),
    ]).toStrictEqual([THEIRS, THEIRS, undefined]);
  });
});

describe("refusal", () => {
  it("lets work, roleless and flag-limited sessions be, and a depth-2 work child still not start sub-agents", () => {
    expect([
      refusal({ v: 1, child: true, role: "work", depth: 1, guard: "extension" }, "bash"),
      refusal({ v: 1, child: true, role: "explore", depth: 1, guard: "flags" }, "bash"),
      refusal({ v: 1, child: true, role: "work", depth: 2, guard: "flags" }, "agent_wait"),
      refusal({ v: 1, child: false, role: null, depth: 0, guard: "extension" }, "ask_parent"),
      refusal({ v: 1, child: false, role: null, depth: 0, guard: "extension" }, "bash"),
    ]).toStrictEqual([
      null,
      null,
      "This sub-agent is too deep to start sub-agents of its own.",
      "Only a sub-agent can use this tool.",
      null,
    ]);
  });
});

describe("selfOf", () => {
  it("reads the host's flag, and makes no one's child of anything else", () => {
    const self = { v: 1, child: true, role: "advise", depth: 2, guard: "extension" } as const;
    const nobody = { v: 1, child: false, role: null, depth: 0, guard: "flags" };

    expect(selfOf(encodeArgument(self))).toStrictEqual(self);
    expect([
      selfOf(undefined),
      selfOf(true),
      selfOf("garbage"),
      selfOf(encodeArgument({ ...self, v: 2 })),
    ]).toStrictEqual([nobody, nobody, nobody, nobody]);
  });
});

describe("parentCalls", () => {
  it("lists the calls without results of the assistant message the first task follows, until a later task came", () => {
    const history = [
      message("assistant", [toolCall("a", "bash", { command: "ls" })]),
      message("toolResult", [], "a"),
      message("assistant", [
        toolCall("b", "read", { path: "x" }),
        toolCall("c", "agent_spawn", { name: "n" }),
        toolCall("d", "grep", { pattern: "p" }),
      ]),
      message("toolResult", [], "d"),
      { type: "label", label: "fork" } as SessionEntryView,
      { type: "custom_message", customType: "other", details: { kind: "task" } } as SessionEntryView,
      task(),
    ];

    expect(parentCalls(history)).toStrictEqual([
      { name: "read", input: { path: "x" } },
      { name: "agent_spawn", input: { name: "n" } },
    ]);
    expect(parentCalls([...history, task(false)])).toStrictEqual([]);
    expect(parentCalls([...history, task()])).toStrictEqual([]);
    expect(parentCalls([])).toStrictEqual([]);
  });
});

describe("parentCalls, at what the first task follows", () => {
  it("finds no batch after a user message, a task without the preamble, or the session's start", () => {
    const calls = message("assistant", [toolCall("a", "bash", { command: "ls" })]);

    expect([
      parentCalls([calls, message("user", [toolCall("x", "bash", {})]), task()]),
      parentCalls([calls, task(false)]),
      parentCalls([task()]),
      parentCalls([calls, { type: "message", message: null } as SessionEntryView, task()]),
      parentCalls([
        calls,
        { type: "message", message: { role: "assistant", content: "ls" } } as SessionEntryView,
        task(),
      ]),
    ]).toStrictEqual([[], [], [], [], []]);
  });
});

describe("parentCalls, in whatever a session file holds", () => {
  it("reads calls only from tool call blocks, results only from tool results, and tasks only from Atrium's task messages", () => {
    const history = [
      message("assistant", [
        null,
        "text",
        { type: "text", text: "look" },
        { type: "thinking", thinking: "hm" },
        toolCall("a", "bash", { command: "ls" }),
        toolCall("b", "read", { path: "x" }),
      ]),
      { type: "custom", message: { role: "toolResult", toolCallId: "a", content: [] } },
      { type: "custom", customType: "atrium-agent", details: { v: 1, kind: "task" } },
      { type: "custom_message", customType: "atrium-agent" },
      { type: "custom_message", customType: "atrium-agent", details: null },
      { type: "custom_message", customType: "atrium-agent", details: { v: 1, kind: "report" } },
      task(),
      { type: "custom_message", customType: "atrium-agent", content: 5, details: { v: 1, kind: "report" } },
    ] as SessionEntryView[];

    expect(parentCalls(history)).toStrictEqual([
      { name: "bash", input: { command: "ls" } },
      { name: "read", input: { path: "x" } },
    ]);
  });
});

describe("parentCalls, reading a task's content", () => {
  it("takes the preamble from text blocks too, and none from content it cannot read", () => {
    const calls = message("assistant", [toolCall("a", "bash", { command: "ls" })]);
    const first = taskText(FORKED_TASK);

    expect([
      parentCalls([
        calls,
        taskWith([
          { type: "image", data: "x" },
          { type: "text", text: first },
        ]),
      ]),
      parentCalls([
        calls,
        taskWith([
          { type: "text", text: "<atrium-agent-task>" },
          { type: "text", text: "<atrium-subagent>" },
        ]),
      ]),
      parentCalls([calls, taskWith(5)]),
      parentCalls([calls, taskWith([null, { type: "text", text: 5 }])]),
      parentCalls([calls, taskWith(first.replace("<atrium-subagent>", "<atrium-subagent> "))]),
      parentCalls([calls, taskWith(["<atrium-subagent>", { type: "text", text: ["<atrium-subagent>"] }])]),
    ]).toStrictEqual([
      [{ name: "bash", input: { command: "ls" } }],
      [{ name: "bash", input: { command: "ls" } }],
      [],
      [],
      [],
      [],
    ]);
  });
});

/**
 * A session's message entry.
 *
 * @remarks
 * Only what `parentCalls` reads.
 *
 * @sideEffects none
 * @param role - Its role.
 * @param content - Its blocks.
 * @param toolCallId - A tool result's call.
 * @returns The entry.
 */
function message(role: string, content: unknown[], toolCallId?: string): SessionEntryView {
  return {
    type: "message",
    message: { role, content, ...(toolCallId === undefined ? {} : { toolCallId }) },
  } as SessionEntryView;
}

/**
 * A tool call block.
 *
 * @remarks
 * See `message`.
 *
 * @sideEffects none
 * @param id - Its id.
 * @param name - Its tool.
 * @param args - Its input.
 * @returns The block.
 */
function toolCall(id: string, name: string, args: unknown): unknown {
  return { type: "toolCall", id, name, arguments: args };
}

/**
 * A task's custom message entry, as pi writes it.
 *
 * @remarks
 * A child's first task opens with the preamble (SPEC-0002, "子对话的角色说明放在第一件事的消息里");
 * the later ones do not.
 *
 * @sideEffects none
 * @param first - Whether it is the child's first task.
 * @returns The entry.
 */
function task(first = true): SessionEntryView {
  return taskWith(taskText(first ? FORKED_TASK : LATER_TASK));
}

/**
 * A task's custom message entry with the given content.
 *
 * @remarks
 * See `task`.
 *
 * @sideEffects none
 * @param content - Its content.
 * @returns The entry.
 */
function taskWith(content: unknown): SessionEntryView {
  return {
    type: "custom_message",
    customType: "atrium-agent",
    content,
    display: true,
    details: { v: 1, kind: "task" },
  } as SessionEntryView;
}

describe("the extension's own timers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times a question out with real timers, and clears the timer of one answered", async () => {
    vi.useFakeTimers();
    const tools = new Map<string, Tool>();
    const statuses: [string, string | undefined][] = [];
    const handlers: ((
      args: string,
      ctx: { readonly ui: { setStatus(key: string, text: string | undefined): void } },
    ) => Promise<void>)[] = [];
    atriumAgent({
      registerCommand: (_name, command) => handlers.push(command.handler),
      sendMessage: () => undefined,
      registerTool: (tool) => tools.set(tool.name, tool),
      registerFlag: () => undefined,
      getFlag: () => encodeArgument({ v: 1, child: true, role: "explore", depth: 1, guard: "flags" }),
      on: () => undefined,
    });
    const ui = { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) };
    const ask = present(tools.get("ask_parent"));
    const ctx = { ui, sessionManager: sessionOf(undefined) };

    const timedOut = ask.execute("q-1", { question: "a?", timeoutSeconds: 60 }, undefined, undefined, ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    const answered = ask.execute("q-2", { question: "b?", timeoutSeconds: 60 }, undefined, undefined, ctx);
    await vi.advanceTimersByTimeAsync(0);
    await present(handlers[0])(answer("q-2", { answered: true, answer: "yes" }), { ui });

    expect([await timedOut, await answered]).toMatchObject([
      { details: { answered: false, reason: "timeout" } },
      { details: { answered: true, answer: "yes" } },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
