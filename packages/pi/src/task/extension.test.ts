import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, expectTypeOf, it } from "vitest";
import { encodeArgument } from "../agent/agent";
import atriumTask, { type TaskApi, flagValue } from "./extension";
import { outsideReason } from "./path-guard";
import { type TaskRequest, readRequest, TASK_TEXT_LIMITS } from "./schema";
import { NODE_DONE_TAKEN, GRAPH_CHANGE_TAKEN, TASK_STOPPED, errorText, nudgeText, resumeText } from "./words";

/** One of the tools the extension registered, as pi would call it. */
type Tool = Parameters<TaskApi["registerTool"]>[0];

/** A session entry the stand-in's session holds. */
interface Entry {
  readonly type: string;
  readonly customType?: string;
  readonly details?: unknown;
}

/** The extension registered against a stand-in for pi, with what it did. */
interface Stand {
  readonly tools: Map<string, Tool>;
  readonly flags: string[];
  /** How many `tool_call` hooks were registered. */
  readonly hooks: number;
  readonly commands: string[];
  /** Every `setStatus`, in order. */
  readonly statuses: [string, string | undefined][];
  /** Every message sent, with its options. */
  readonly sent: [unknown, unknown][];
  readonly session: { branch: Entry[] };
  /** Runs `/atrium-task <action> <argument>`. */
  readonly command: (action: string, argument?: unknown) => Promise<void>;
  /** Runs every `tool_call` hook and returns the first block. */
  readonly hook: (toolName: string, input: unknown, cwd?: string) => unknown;
  readonly call: (tool: string, id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

/**
 * Makes the flag argument pi would be started with.
 *
 * @sideEffects none
 * @param self - What the flag says.
 * @returns `--atrium-task=…`.
 */
function arg(self: unknown): string {
  return `--atrium-task=${encodeArgument(self)}`;
}

/** A node of a role, as the host's flag says it. */
const node = (role: string, extra: Record<string, unknown> = {}) => arg({ v: 1, kind: "node", role, ...extra });

/**
 * Registers the extension against a stand-in for pi.
 *
 * @remarks
 * Keeps what it registered, the statuses it wrote and the messages it sent.
 *
 * @sideEffects none
 * @param options - pi's arguments, and whether the agent part made the session isolated.
 * @returns The stand-in.
 */
function stand(options: { argv?: string[]; isolated?: boolean } = {}): Stand {
  const tools = new Map<string, Tool>();
  const flags: string[] = [];
  const commands: string[] = [];
  const statuses: [string, string | undefined][] = [];
  const sent: [unknown, unknown][] = [];
  const session = { branch: [] as Entry[] };
  const handlers: ((
    event: { toolName: string; input: unknown },
    ctx: { cwd: string },
  ) => { block: true; reason: string } | undefined)[] = [];
  let handler: Parameters<TaskApi["registerCommand"]>[1]["handler"] | null = null;
  const ui = { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) };
  const view = { getBranch: () => session.branch };
  atriumTask(
    {
      registerCommand: (name, command) => {
        commands.push(`${name}: ${command.description}`);
        handler = command.handler;
      },
      sendMessage: (message, sendOptions) => sent.push([message, sendOptions]),
      registerTool: (tool) => tools.set(tool.name, tool),
      registerFlag: (name, flag) => flags.push(`${name} (${flag.type}): ${flag.description}`),
      on: (_event, hook) => handlers.push(hook),
    },
    () => options.isolated === true,
    { argv: ["--no-session", ...(options.argv ?? [])] },
  );
  return {
    tools,
    flags,
    hooks: handlers.length,
    commands,
    statuses,
    sent,
    session,
    command: (action, argument) =>
      (handler ?? (() => Promise.reject(new Error("no command"))))(
        `${action} ${argument === undefined ? "" : encodeArgument(argument)}`,
        { ui, sessionManager: view, isIdle: () => true },
      ),
    hook: (toolName, input, cwd = "/nonexistent-work") => {
      for (const one of handlers) {
        const verdict = one({ toolName, input }, { cwd });
        if (verdict !== undefined) return verdict;
      }
      return undefined;
    },
    call: (tool, id, params, signal) => {
      const found = tools.get(tool);
      if (found === undefined) return Promise.reject(new Error(`no tool ${tool}`));
      return found.execute(id, params, signal, undefined, { ui, sessionManager: view });
    },
  };
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
function requests(statuses: readonly [string, string | undefined][]): TaskRequest[] {
  return statuses.flatMap(([, text]) => {
    const read = text === undefined ? null : readRequest(text);
    return read !== null && "request" in read ? [read.request] : [];
  });
}

/**
 * The statuses the extension cleared, in order.
 *
 * @sideEffects none
 * @param statuses - The statuses.
 * @returns Their keys.
 */
function cleared(statuses: readonly [string, string | undefined][]): string[] {
  return statuses.flatMap(([key, text]) => (text === undefined ? [key] : []));
}

/** The host's accepting answer. */
const ACCEPTED = { v: 1, id: "call-1", ok: true, result: { recorded: true } };

describe("atriumTask: what a session gets by what the flag says", () => {
  it("fits pi's extension API", () => {
    expectTypeOf<ExtensionAPI>().toExtend<TaskApi>();
    expect(true).toBe(true);
  });

  it("registers only the flag and the two guards without a readable flag", () => {
    for (const argv of [[], ["--atrium-task="], ["--atrium-task=%%%"], [arg({ v: 1, kind: "node", role: "boss" })]]) {
      const s = stand({ argv });

      expect([...s.tools.keys()]).toStrictEqual([]);
      expect(s.commands).toStrictEqual([]);
      expect(s.hooks).toBe(2);
      expect(s.flags).toHaveLength(1);
    }
  });

  it("ignores a flag that is not written as one argument with an equals sign", () => {
    const s = stand({ argv: ["--atrium-task", encodeArgument({ v: 1, kind: "node", role: "work" })] });

    expect([...s.tools.keys()]).toStrictEqual([]);
  });

  it("gives the task conversation the command but no tools, and no tool limits", () => {
    const s = stand({ argv: [arg({ v: 1, kind: "conversation" })] });

    expect([...s.tools.keys()]).toStrictEqual([]);
    expect(s.commands).toStrictEqual(["atrium-task: Atrium's tasks, sent by Atrium's host"]);
    expect(s.hooks).toBe(2);
    expect(s.hook("agent_spawn", {})).toBeUndefined();
  });

  it("gives a node node_done and request_graph_change, one at a time in a batch, and the command", () => {
    const s = stand({ argv: [node("work")] });

    expect([...s.tools.keys()]).toStrictEqual(["node_done", "request_graph_change"]);
    for (const tool of s.tools.values()) {
      expect(tool.executionMode).toBe("sequential");
      expect(tool.parameters["additionalProperties"]).toBe(false);
      expect(tool.description.length).toBeGreaterThan(100);
    }
    expect(s.tools.get("node_done")?.parameters["required"]).toStrictEqual(["ok"]);
    expect(s.tools.get("request_graph_change")?.parameters["required"]).toStrictEqual(["reason", "suggestion"]);
    expect(s.commands).toHaveLength(1);
    expect(s.hooks).toBe(3);
  });

  it("reads the flag wherever it is among pi's arguments", () => {
    expect(flagValue(["a", "--atrium-task=xyz", "b"])).toBe("xyz");
    expect(flagValue(["--atrium-task=a", "--atrium-task=b"])).toBe("a");
    expect(flagValue(["--atrium-agent=xyz", "atrium-task=xyz"])).toBeUndefined();
  });
});

describe("node_done and request_graph_change", () => {
  it("node_done asks the host with the call's id, waits, and on the host's yes ends the turn", async () => {
    const s = stand({ argv: [node("work")] });

    const result = s.call("node_done", "call-1", { ok: true, summary: "All done." });
    await Promise.resolve();

    expect(s.statuses.map(([key]) => key)).toStrictEqual(["atrium-task:call-1"]);
    expect(requests(s.statuses)).toStrictEqual([
      { kind: "call", id: "call-1", op: "node_done", args: { ok: true, summary: "All done." } },
    ]);
    await s.command("reply", ACCEPTED);
    expect(await result).toStrictEqual({
      content: [{ type: "text", text: NODE_DONE_TAKEN }],
      details: { v: 1, tool: "node_done" },
      terminate: true,
    });
    expect(cleared(s.statuses)).toStrictEqual(["atrium-task:call-1"]);
  });

  it("request_graph_change sends both texts and ends the turn the same way", async () => {
    const s = stand({ argv: [node("explore")] });

    const result = s.call("request_graph_change", "call-9", { reason: "Needs a step", suggestion: "Add N5" });
    await Promise.resolve();
    expect(requests(s.statuses)).toStrictEqual([
      {
        kind: "call",
        id: "call-9",
        op: "request_graph_change",
        args: { reason: "Needs a step", suggestion: "Add N5" },
      },
    ]);
    await s.command("reply", { ...ACCEPTED, id: "call-9" });

    expect(await result).toStrictEqual({
      content: [{ type: "text", text: GRAPH_CHANGE_TAKEN }],
      details: { v: 1, tool: "request_graph_change" },
      terminate: true,
    });
  });

  it("sends a failing node's reason, and an empty summary when the model wrote none", async () => {
    const s = stand({ argv: [node("work")] });

    const result = s.call("node_done", "call-1", { ok: false, reason: "Cannot build." });
    await Promise.resolve();

    expect(requests(s.statuses)).toStrictEqual([
      { kind: "call", id: "call-1", op: "node_done", args: { ok: false, summary: "", reason: "Cannot build." } },
    ]);
    await s.command("reply", ACCEPTED);
    await result;
  });

  it("does not end the turn when the host refuses: the model reads the words and calls again", async () => {
    const s = stand({ argv: [node("work")] });

    const result = s.call("node_done", "call-1", { ok: true, summary: "" });
    await Promise.resolve();
    await s.command("reply", {
      v: 1,
      id: "call-1",
      ok: false,
      code: "task_args_invalid",
      params: { field: "summary" },
    });

    expect(await result).toStrictEqual({
      content: [{ type: "text", text: errorText("task_args_invalid", { field: "summary" }) }],
      details: { v: 1, error: "task_args_invalid" },
      isError: true,
    });
    expect(cleared(s.statuses)).toStrictEqual(["atrium-task:call-1"]);
  });

  it("tells the model the call was refused for a session that is not the node's, and does not end the turn", async () => {
    const s = stand({ argv: [node("work")] });

    const result = s.call("request_graph_change", "call-1", { reason: "r", suggestion: "s" });
    await Promise.resolve();
    await s.command("reply", { v: 1, id: "call-1", ok: false, code: "task_caller_invalid" });

    expect(await result).toMatchObject({ isError: true, details: { v: 1, error: "task_caller_invalid" } });
    expect(await result).not.toHaveProperty("terminate");
  });

  it("does not trust an answer whose result is not what the host gives", async () => {
    const s = stand({ argv: [node("work")] });

    const result = s.call("node_done", "call-1", { ok: true, summary: "x" });
    await Promise.resolve();
    await s.command("reply", { v: 1, id: "call-1", ok: true, result: { recorded: false } });

    expect(await result).toMatchObject({ isError: true, details: { v: 1, error: "task_bad_request" } });
  });

  it("answers task_text_too_long itself, without asking the host", async () => {
    const s = stand({ argv: [node("work")] });

    const result = await s.call("node_done", "call-1", { ok: true, summary: "x".repeat(TASK_TEXT_LIMITS.summary + 1) });

    expect(result).toStrictEqual({
      content: [
        { type: "text", text: errorText("task_text_too_long", { param: "summary", limit: TASK_TEXT_LIMITS.summary }) },
      ],
      details: { v: 1, error: "task_text_too_long" },
      isError: true,
    });
    expect(s.statuses).toStrictEqual([]);
  });

  it("answers task_bad_request itself for parameters it cannot read", async () => {
    const s = stand({ argv: [node("work")] });

    for (const [tool, params] of [
      ["node_done", { ok: "yes" }],
      ["node_done", {}],
      ["request_graph_change", { reason: "r" }],
      ["request_graph_change", { reason: "", suggestion: "s" }],
    ] as const) {
      expect(await s.call(tool, "call-1", params)).toMatchObject({
        isError: true,
        details: { error: "task_bad_request" },
      });
    }
    expect(s.statuses).toStrictEqual([]);
  });

  it("takes only the first answer to an id, and ignores answers it cannot read or that ask nothing", async () => {
    const s = stand({ argv: [node("work")] });
    const result = s.call("node_done", "call-1", { ok: true, summary: "x" });
    await Promise.resolve();

    await s.command("reply", { v: 1, id: "call-1", ok: false, code: "nope" });
    await s.command("reply", { v: 1, id: "call-2", ok: true, result: { recorded: true } });
    await s.command("reply");
    await s.command("reply", "text");
    expect(cleared(s.statuses)).toStrictEqual([]);
    await s.command("reply", ACCEPTED);
    await s.command("reply", { v: 1, id: "call-1", ok: false, code: "task_failed" });

    expect(await result).toMatchObject({ terminate: true });
    expect(cleared(s.statuses)).toStrictEqual(["atrium-task:call-1"]);
  });

  it("gives a call up when the tool is stopped: the status is cleared, the host is told, and the tool fails", async () => {
    const s = stand({ argv: [node("work")] });
    const stop = new AbortController();

    const result = s.call("node_done", "call-1", { ok: true, summary: "x" }, stop.signal);
    await Promise.resolve();
    stop.abort();

    await expect(result).rejects.toThrow(TASK_STOPPED);
    expect(cleared(s.statuses)).toStrictEqual(["atrium-task:call-1", "atrium-task:n1"]);
    expect(requests(s.statuses)).toStrictEqual([
      { kind: "call", id: "call-1", op: "node_done", args: { ok: true, summary: "x" } },
      { kind: "note", id: "n1", op: "cancel", args: { id: "call-1" } },
    ]);
    // A late answer finds nothing waiting.
    await s.command("reply", ACCEPTED);
    expect(cleared(s.statuses)).toHaveLength(2);
  });

  it("does not ask at all when the tool is already stopped", async () => {
    const s = stand({ argv: [node("work")] });
    const stop = new AbortController();
    stop.abort();

    await expect(s.call("node_done", "call-1", { ok: true, summary: "x" }, stop.signal)).rejects.toThrow(TASK_STOPPED);
    expect(s.statuses).toStrictEqual([]);
  });

  it("stops listening for the stop once answered, so a later abort does nothing", async () => {
    const s = stand({ argv: [node("work")] });
    const stop = new AbortController();
    const result = s.call("node_done", "call-1", { ok: true, summary: "x" }, stop.signal);
    await Promise.resolve();
    await s.command("reply", ACCEPTED);
    await result;

    stop.abort();

    expect(requests(s.statuses)).toHaveLength(1);
  });

  it("numbers its notes, so two cancels have two ids", async () => {
    const s = stand({ argv: [node("work")] });
    for (const id of ["call-1", "call-2"]) {
      const stop = new AbortController();
      const result = s.call("node_done", id, { ok: true, summary: "x" }, stop.signal);
      await Promise.resolve();
      stop.abort();
      await expect(result).rejects.toThrow(TASK_STOPPED);
    }

    expect(
      requests(s.statuses)
        .filter((request) => request.kind === "note")
        .map((request) => request.id),
    ).toStrictEqual(["n1", "n2"]);
  });
});

describe("/atrium-task nudge, resume and progress", () => {
  it("nudge writes the reminder and starts a turn with it", async () => {
    const s = stand({ argv: [node("work")] });

    await s.command("nudge", { v: 1, id: "nudge-1" });

    expect(s.sent).toStrictEqual([
      [
        {
          customType: "atrium-task",
          content: nudgeText(),
          display: true,
          details: { v: 1, kind: "nudge", id: "nudge-1" },
        },
        { triggerTurn: true },
      ],
    ]);
  });

  it("does the same command once: not again in this process, nor after the session file has it", async () => {
    const s = stand({ argv: [node("work")] });

    await s.command("nudge", { v: 1, id: "nudge-1" });
    await s.command("nudge", { v: 1, id: "nudge-1" });
    expect(s.sent).toHaveLength(1);

    s.session.branch.push({
      type: "custom_message",
      customType: "atrium-task",
      details: { v: 1, kind: "nudge", id: "nudge-2" },
    });
    await s.command("nudge", { v: 1, id: "nudge-2" });
    expect(s.sent).toHaveLength(1);

    await s.command("nudge", { v: 1, id: "nudge-3" });
    expect(s.sent).toHaveLength(2);
  });

  it("is not fooled by other messages that carry the same id", async () => {
    const s = stand({ argv: [node("work")] });
    s.session.branch.push(
      { type: "custom_message", customType: "atrium-agent", details: { id: "nudge-1" } },
      { type: "message", customType: "atrium-task", details: { id: "nudge-1" } },
      { type: "custom_message", customType: "atrium-task" },
      { type: "custom_message", customType: "atrium-task", details: null },
      { type: "custom_message", customType: "atrium-task", details: { id: 5 } },
    );

    await s.command("nudge", { v: 1, id: "nudge-1" });

    expect(s.sent).toHaveLength(1);
  });

  it("nudges nodes only, and ignores a nudge it cannot read", async () => {
    const conversation = stand({ argv: [arg({ v: 1, kind: "conversation" })] });
    const s = stand({ argv: [node("work")] });

    await conversation.command("nudge", { v: 1, id: "n" });
    await s.command("nudge", { v: 1 });
    await s.command("nudge", { v: 2, id: "n" });
    await s.command("nudge");

    expect(conversation.sent).toStrictEqual([]);
    expect(s.sent).toStrictEqual([]);
  });

  it("resume starts a turn with the host's text in the shell, for a node and for the task conversation", async () => {
    for (const argv of [[node("work")], [arg({ v: 1, kind: "conversation" })]]) {
      const s = stand({ argv });

      await s.command("resume", { v: 1, id: "resume-1", kind: "wake", text: "N2 asks for a change." });

      expect(s.sent).toStrictEqual([
        [
          {
            customType: "atrium-task",
            content: resumeText("wake", "N2 asks for a change."),
            display: true,
            details: { v: 1, kind: "resume", id: "resume-1", reason: "wake" },
          },
          { triggerTurn: true },
        ],
      ]);
      await s.command("resume", { v: 1, id: "resume-1", kind: "wake", text: "N2 asks for a change." });
      expect(s.sent).toHaveLength(1);
    }
  });

  it("ignores a resume it cannot read", async () => {
    const s = stand({ argv: [node("work")] });

    await s.command("resume", { v: 1, id: "r", kind: "later", text: "x" });
    await s.command("resume", { v: 1, id: "r", kind: "continue", text: "" });
    await s.command("resume", { v: 1, id: "r", kind: "continue" });

    expect(s.sent).toStrictEqual([]);
  });

  it("progress writes the line as it is, without starting a turn, once per id", async () => {
    const s = stand({ argv: [arg({ v: 1, kind: "conversation" })] });

    await s.command("progress", { v: 1, id: "line-1", at: 1700, text: "N1 started" });
    await s.command("progress", { v: 1, id: "line-1", at: 1800, text: "N1 started again" });

    expect(s.sent).toStrictEqual([
      [
        {
          customType: "atrium-task",
          content: "N1 started",
          display: true,
          details: { v: 1, kind: "progress", id: "line-1", at: 1700, text: "N1 started" },
        },
        { triggerTurn: false },
      ],
    ]);
  });

  it("ignores progress it cannot read, and actions it does not know", async () => {
    const s = stand({ argv: [node("work")] });

    await s.command("progress", { v: 1, id: "p", text: "no time" });
    await s.command("deliver", { v: 1 });
    await s.command("");

    expect(s.sent).toStrictEqual([]);
  });
});

describe("the hooks of a node", () => {
  it("limits the tools by the role, and gives every node the node tools", () => {
    const explore = stand({ argv: [node("explore")] });
    const work = stand({ argv: [node("work")] });

    expect(explore.hook("edit", {})).toMatchObject({ block: true });
    expect(explore.hook("read", {})).toBeUndefined();
    expect(explore.hook("node_done", {})).toBeUndefined();
    expect(work.hook("edit", {})).toBeUndefined();
    expect(work.hook("agent_spawn", {})).toStrictEqual({
      block: true,
      reason: "A task node cannot start or talk to sub-agents.",
    });
    expect(work.hook("ask_parent", {})).toMatchObject({ block: true });
  });

  it("isolates a node by default: edit, write and git cannot leave the working directory", () => {
    const s = stand({ argv: [node("work")] });

    expect(s.hook("write", { path: "../x" }, "/nonexistent-work")).toStrictEqual({
      block: true,
      reason: outsideReason("/nonexistent-work"),
    });
    expect(s.hook("bash", { command: "git -C / log" }, "/nonexistent-work")).toMatchObject({ block: true });
  });

  it("does not isolate a node the host switched it off for, unless the agent part isolated it", () => {
    const off = stand({ argv: [node("work", { isolated: false })] });
    const agentOn = stand({ argv: [node("work", { isolated: false })], isolated: true });

    expect(off.hook("write", { path: "../x" }, "/w")).toBeUndefined();
    expect(agentOn.hook("write", { path: "../x" }, "/w")).toMatchObject({ block: true });
  });

  it("isolates what is not a task session when the agent part says so, and not otherwise", () => {
    const isolated = stand({ isolated: true });
    const plain = stand();

    expect(isolated.hook("write", { path: "../x" }, "/w")).toMatchObject({ block: true });
    expect(isolated.hook("bash", { command: "git -C / log" }, "/w")).toMatchObject({ block: true });
    expect(plain.hook("write", { path: "../x" }, "/w")).toBeUndefined();
    expect(plain.hook("bash", { command: "git -C / log" }, "/w")).toBeUndefined();
  });

  it("does not isolate the task conversation unless the agent part says so", () => {
    const s = stand({ argv: [arg({ v: 1, kind: "conversation" })] });

    expect(s.hook("write", { path: "../x" }, "/w")).toBeUndefined();
  });
});
