import { createTempDir } from "@atrium/testkit";
import type { FauxContext, FauxScript } from "@atrium/testkit";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { PiEvent } from "../process/pi-process";
import { FakeTaskHost, type FakeAnswer, type SeenCall } from "../../test/fake-task-host";
import { runScenario } from "../../test/contract";
import { encodeArgument } from "../agent/agent";
import { gitReason } from "../task/git-guard";
import { outsideReason } from "../task/path-guard";
import { commandText } from "../task/schema";
import { GRAPH_CHANGE_TAKEN, NODE_DONE_TAKEN, errorText, nudgeText, resumeText } from "../task/words";

const run = promisify(execFile);

/** Atrium's extension, as the host has pi load it (ADR-0008, ADR-0013). */
const ATRIUM_EXTENSION = fileURLToPath(new URL("../extension/atrium.ts", import.meta.url));

/**
 * The host's flag for a task session.
 *
 * @sideEffects none
 * @param self - What the flag says, without `v`.
 * @returns The argument.
 */
function flag(self: Record<string, unknown>): string {
  return `--atrium-task=${encodeArgument({ v: 1, ...self })}`;
}

/** The flag of a node of a role. */
const node = (role: string, extra: Record<string, unknown> = {}) => flag({ kind: "node", role, ...extra });

/** The arguments of a scripted tool call. */
type ToolArguments = Extract<FauxScript["replies"][number]["blocks"][number], { type: "toolCall" }>["arguments"];

/**
 * A model reply that calls tools in one batch.
 *
 * @sideEffects none
 * @param calls - Name and arguments of each call.
 * @returns The reply.
 */
function batch(...calls: readonly (readonly [name: string, args: ToolArguments])[]) {
  return {
    blocks: calls.map(([name, args], index) => ({
      type: "toolCall" as const,
      id: `call-${String(index + 1)}`,
      name,
      arguments: args,
    })),
  };
}

/** A model reply that ends the turn with some text. */
const said = (text: string) => ({ blocks: [{ type: "text" as const, text }] });

/** `node_done` with a summary. */
const done = (summary = "All done.") => batch(["node_done", { ok: true, summary }]);

/**
 * The tool results a request carried after the last assistant message, as text.
 *
 * @remarks
 * What the model was told about its latest batch; `isError` shows a refusal.
 *
 * @sideEffects none
 * @param request - The request; none has no results.
 * @returns One entry per result, in order.
 */
function latestResults(request: FauxContext | undefined): { text: string; isError: boolean }[] {
  const messages = request?.messages ?? [];
  const lastAssistant = messages.findLastIndex((message) => Reflect.get(message as object, "role") === "assistant");
  return messages
    .slice(lastAssistant + 1)
    .filter((message) => Reflect.get(message as object, "role") === "toolResult")
    .map((message) => {
      const content: unknown = Reflect.get(message as object, "content");
      const text = Array.isArray(content)
        ? content.map((block: unknown) => String(Reflect.get(block as object, "text") ?? "")).join("")
        : "";
      return { text, isError: Reflect.get(message as object, "isError") === true };
    });
}

/**
 * Everything a request carried, as one text.
 *
 * @remarks
 * To see what the model was told, wherever it stood in the messages.
 *
 * @sideEffects none
 * @param request - The request.
 * @returns The messages as JSON text.
 */
function everything(request: FauxContext | undefined): string {
  return JSON.stringify(request?.messages ?? []);
}

/**
 * Whether an event is the end of a custom message: what the extension wrote into the session.
 *
 * @sideEffects none
 * @param event - pi's event.
 * @returns Whether it is.
 */
function isCustomEnd(event: PiEvent): boolean {
  return event.type === "message_end" && event.message.role === "custom";
}

/**
 * Waits until the fake host has judged `count` runs.
 *
 * @sideEffects Waits.
 * @param host - The fake host.
 * @param count - How many runs.
 */
async function settled(host: FakeTaskHost, count: number): Promise<void> {
  await vi.waitFor(() => expect(host.settlements).toHaveLength(count), { timeout: 20_000, interval: 10 });
}

/**
 * Waits long enough for pi to have started a run, had it been going to.
 *
 * @remarks
 * The only way to show something did not happen; callers also assert on pi's state.
 *
 * @sideEffects Waits.
 */
async function quietPeriod(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/**
 * A host that refuses a `node_done` without a summary and takes everything else.
 *
 * @sideEffects none
 * @param call - The call.
 * @returns The answer.
 */
function refuseEmptySummary(call: SeenCall): FakeAnswer {
  return call.op === "node_done" && call.args.summary === ""
    ? { ok: false, code: "task_args_invalid", params: { field: "summary" } }
    : { ok: true };
}

describe("pi contract: the node tools (SPEC-0006, 结束 and 中途)", () => {
  it("done-alone: node_done on its own ends the turn; the host got the call and the run settles on it", async () => {
    await runScenario(
      {
        scenario: "task-done-alone",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: { replies: [done("Built it."), said("must not be requested")] },
      },
      async ({ pi, events, until, contexts }) => {
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await quietPeriod();
        await host.close();

        expect(host.calls).toStrictEqual([
          { kind: "call", id: "call-1", op: "node_done", args: { ok: true, summary: "Built it." } },
        ]);
        expect(host.settlements).toStrictEqual([{ kind: "node_done", args: { ok: true, summary: "Built it." } }]);
        expect(host.voids).toStrictEqual([]);
        expect(events.filter((event) => event.type === "turn_start")).toHaveLength(1);
        const requests = await contexts();
        expect(requests).toHaveLength(1);
        expect(requests[0]?.tools).toStrictEqual(
          expect.arrayContaining(["node_done", "request_graph_change", "ask_user"]),
        );
        expect(await pi.request({ type: "get_state" })).toMatchObject({ isStreaming: false });
      },
    );
  });

  it("done-gave-up: node_done with ok false carries the reason", async () => {
    await runScenario(
      {
        scenario: "task-done-gave-up",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: { replies: [batch(["node_done", { ok: false, reason: "No toolchain." }])] },
      },
      async ({ pi, until }) => {
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await host.close();

        expect(host.settlements).toStrictEqual([
          { kind: "node_done", args: { ok: false, summary: "", reason: "No toolchain." } },
        ]);
      },
    );
  });

  it("done-with-others: node_done batched with another tool is voided by the model's next request", async () => {
    await runScenario(
      {
        scenario: "task-done-with-others",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: { replies: [batch(["node_done", { ok: true, summary: "early" }], ["ls", {}]), said("looked again")] },
      },
      async ({ pi, until, contexts }) => {
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await host.close();

        expect(host.calls).toHaveLength(1);
        expect(host.voids).toStrictEqual(["turn_start"]);
        expect(host.settlements).toStrictEqual([{ kind: "no_done" }]);
        const requests = await contexts();
        expect(requests).toHaveLength(2);
        const results = latestResults(requests[1]);
        expect(results).toHaveLength(2);
        expect(results[0]).toStrictEqual({ text: NODE_DONE_TAKEN, isError: false });
      },
    );
  });

  it("done-then-steer: words that come in before the turn ends start another request and void the call", async () => {
    await runScenario(
      {
        scenario: "task-done-then-steer",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: { replies: [done(), said("noted, not done yet")] },
      },
      async ({ pi, until, contexts }) => {
        const host = new FakeTaskHost(pi, () => "hold");
        await pi.request({ type: "prompt", message: "go" });
        await vi.waitFor(() => expect(host.calls).toHaveLength(1), { timeout: 20_000, interval: 10 });
        await pi.request({ type: "steer", message: "wait, also check the docs" });
        host.release("call-1");
        await until((event) => event.type === "agent_settled");
        await host.close();

        expect(host.voids).toStrictEqual(["turn_start"]);
        expect(host.settlements).toStrictEqual([{ kind: "no_done" }]);
        const requests = await contexts();
        expect(requests).toHaveLength(2);
        expect(everything(requests[1])).toContain("wait, also check the docs");
      },
    );
  });

  it("done-then-stop: a run stopped after the host took node_done voids it too", async () => {
    await runScenario(
      {
        scenario: "task-done-then-stop",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: { replies: [batch(["node_done", { ok: true, summary: "x" }], ["bash", { command: "sleep 30" }])] },
      },
      async ({ pi, until }) => {
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await vi.waitFor(() => expect(host.pending).not.toBeNull(), { timeout: 20_000, interval: 10 });
        await pi.request({ type: "abort" });
        await until((event) => event.type === "agent_settled");
        await host.close();

        expect(host.pending).toBeNull();
        expect(host.settlements).toHaveLength(1);
        expect(host.settlements[0]?.kind).not.toBe("node_done");
        expect(host.voids).toHaveLength(1);
      },
    );
  });

  it("done-then-error: a model error after node_done and another tool leaves nothing to settle", async () => {
    await runScenario(
      {
        scenario: "task-done-then-error",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: {
          replies: [batch(["node_done", { ok: true, summary: "x" }], ["ls", {}]), { blocks: [], error: "boom" }],
        },
      },
      async ({ pi, until }) => {
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await host.close();

        expect(host.pending).toBeNull();
        expect(host.settlements).toStrictEqual([{ kind: "error" }]);
        expect(host.voids).toContain("turn_start");
      },
    );
  });

  it("graph-change: request_graph_change on its own ends the turn, and the host got reason and suggestion", async () => {
    await runScenario(
      {
        scenario: "task-graph-change",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("explore")],
        script: {
          replies: [
            batch(["request_graph_change", { reason: "Needs a migration step", suggestion: "Add N5 before N3" }]),
            said("must not be requested"),
          ],
        },
      },
      async ({ pi, until, contexts }) => {
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await quietPeriod();
        await host.close();

        const args = { reason: "Needs a migration step", suggestion: "Add N5 before N3" };
        expect(host.calls).toStrictEqual([{ kind: "call", id: "call-1", op: "request_graph_change", args }]);
        expect(host.settlements).toStrictEqual([{ kind: "request_graph_change", args }]);
        expect(await contexts()).toHaveLength(1);
      },
    );
  });

  it("graph-change-with-others: request_graph_change batched with another tool is voided like node_done", async () => {
    await runScenario(
      {
        scenario: "task-graph-change-with-others",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("explore")],
        script: {
          replies: [batch(["request_graph_change", { reason: "r", suggestion: "s" }], ["ls", {}]), said("went on")],
        },
      },
      async ({ pi, until, contexts }) => {
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await host.close();

        expect(host.voids).toStrictEqual(["turn_start"]);
        expect(host.settlements).toStrictEqual([{ kind: "no_done" }]);
        expect(latestResults((await contexts())[1])[0]).toStrictEqual({ text: GRAPH_CHANGE_TAKEN, isError: false });
      },
    );
  });

  it("refused: the host's refusal reaches the model as an error; it fixes the call and the second one settles", async () => {
    await runScenario(
      {
        scenario: "task-refused",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: { replies: [done(""), done("Now with words."), said("must not be requested")] },
      },
      async ({ pi, until, contexts }) => {
        const host = new FakeTaskHost(pi, refuseEmptySummary);
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await host.close();

        const requests = await contexts();
        expect(requests).toHaveLength(2);
        expect(latestResults(requests[1])).toStrictEqual([
          { text: errorText("task_args_invalid", { field: "summary" }), isError: true },
        ]);
        expect(host.settlements).toStrictEqual([{ kind: "node_done", args: { ok: true, summary: "Now with words." } }]);
        expect(host.voids).toStrictEqual([]);
      },
    );
  });

  it("wrong-caller: task_caller_invalid is an error result, nothing settles, and the model is asked again", async () => {
    await runScenario(
      {
        scenario: "task-wrong-caller",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: { replies: [done(), said("understood")] },
      },
      async ({ pi, until, contexts }) => {
        const host = new FakeTaskHost(pi, () => ({ ok: false, code: "task_caller_invalid" }));
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await host.close();

        expect(latestResults((await contexts())[1])).toStrictEqual([
          { text: errorText("task_caller_invalid"), isError: true },
        ]);
        expect(host.settlements).toStrictEqual([{ kind: "no_done" }]);
      },
    );
  });

  it("too-long: a summary over the limit is answered by the extension; the host hears nothing", async () => {
    await runScenario(
      {
        scenario: "task-too-long",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: { replies: [done("x".repeat(32_001)), said("shorter next time")] },
      },
      async ({ pi, until, contexts }) => {
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await host.close();

        expect(host.calls).toStrictEqual([]);
        expect(latestResults((await contexts())[1])).toStrictEqual([
          { text: errorText("task_text_too_long", { param: "summary", limit: 32_000 }), isError: true },
        ]);
      },
    );
  });

  it("stopped-while-asking: stopping a run while the host has not answered cancels the call", async () => {
    await runScenario(
      {
        scenario: "task-stopped-while-asking",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: { replies: [done()] },
      },
      async ({ pi, until }) => {
        const host = new FakeTaskHost(pi, () => "hold");
        await pi.request({ type: "prompt", message: "go" });
        await vi.waitFor(() => expect(host.calls).toHaveLength(1), { timeout: 20_000, interval: 10 });
        await pi.request({ type: "abort" });
        await until((event) => event.type === "agent_settled");
        await host.close();

        expect(host.cancelled).toStrictEqual(["call-1"]);
        expect(host.pending).toBeNull();
        expect(host.settlements).toStrictEqual([{ kind: "stopped" }]);
      },
    );
  });
});

describe("pi contract: nudge, resume and progress (SPEC-0006, no_done)", () => {
  it("nudge: after a turn that ended without node_done, nudge starts a new turn, and the model reads the reminder", async () => {
    await runScenario(
      {
        scenario: "task-nudge",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: { replies: [said("I believe it is finished."), done("Finished after the nudge."), said("never")] },
      },
      async ({ pi, events, contexts }) => {
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await settled(host, 1);
        expect(host.settlements).toStrictEqual([{ kind: "no_done" }]);

        await host.command("nudge", { v: 1, id: "nudge-1" });
        await settled(host, 2);
        await host.close();

        expect(host.settlements[1]).toStrictEqual({
          kind: "node_done",
          args: { ok: true, summary: "Finished after the nudge." },
        });
        const requests = await contexts();
        expect(requests).toHaveLength(2);
        expect(everything(requests[1])).toContain(nudgeText().split("\n").slice(0, 2).join("\\n"));
        expect(events.filter((event) => event.type === "agent_start")).toHaveLength(2);

        // The same nudge again (the host sends it again after a restart): no new turn.
        await host.command("nudge", { v: 1, id: "nudge-1" });
        await quietPeriod();
        expect(await contexts()).toHaveLength(2);
        expect(await pi.request({ type: "get_state" })).toMatchObject({ isStreaming: false });
      },
    );
  });

  it("resume: the host's words start a new turn in the node, inside the shell, with the new contract in them", async () => {
    await runScenario(
      {
        scenario: "task-resume",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: { replies: [batch(["request_graph_change", { reason: "r", suggestion: "s" }]), done("Continued.")] },
      },
      async ({ pi, until, contexts }) => {
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await settled(host, 1);

        await host.command("resume", {
          v: 1,
          id: "resume-1",
          kind: "graph_changed",
          text: "New contract: do N5 first.",
        });
        await settled(host, 2);
        await host.close();
        await until((event) => event.type === "agent_settled");

        expect(host.settlements.map((one) => one.kind)).toStrictEqual(["request_graph_change", "node_done"]);
        const second = everything((await contexts())[1]);
        expect(second).toContain(
          JSON.stringify(resumeText("graph_changed", "New contract: do N5 first.")).slice(1, -1),
        );
      },
    );
  });

  it("conversation: a task conversation has no node tools, takes progress without a turn, and wakes on resume", async () => {
    await runScenario(
      {
        scenario: "task-conversation",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [flag({ kind: "conversation" })],
        script: { replies: [said("I see the request.")] },
      },
      async ({ pi, events, until, contexts }) => {
        const host = new FakeTaskHost(pi);
        await host.command("progress", { v: 1, id: "line-1", at: 1700, text: "N1 started" });
        await until(isCustomEnd);
        await quietPeriod();
        expect(events.filter((event) => event.type === "agent_start")).toHaveLength(0);
        expect(await contexts()).toHaveLength(0);

        await host.command("resume", { v: 1, id: "wake-1", kind: "wake", text: "N2 asks for a change: reason." });
        await settled(host, 1);
        await host.close();

        const [request] = await contexts();
        expect(request?.tools).not.toContain("node_done");
        expect(request?.tools).not.toContain("request_graph_change");
        expect(everything(request)).toContain("N2 asks for a change: reason.");
      },
    );
  });
});

describe("pi contract: who gets the node tools", () => {
  it.each([
    ["no flag at all", []],
    ["an unreadable flag", ["--atrium-task=%%%"]],
    ["a flag with an unknown role", [node("boss")]],
    ["the task conversation", [flag({ kind: "conversation" })]],
    [
      "only the agent flag",
      [`--atrium-agent=${encodeArgument({ v: 1, child: false, role: null, depth: 0, guard: "flags" })}`],
    ],
  ])("%s: node_done and request_graph_change do not exist", async (_name, args) => {
    await runScenario(
      {
        scenario: "task-not-a-node",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args,
        script: { replies: [batch(["node_done", { ok: true, summary: "x" }]), said("it is not there")] },
      },
      async ({ pi, until, contexts }) => {
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await host.close();

        const requests = await contexts();
        expect(requests[0]?.tools).not.toContain("node_done");
        expect(requests[0]?.tools).not.toContain("request_graph_change");
        expect(host.calls).toStrictEqual([]);
        expect(latestResults(requests[1])[0]?.isError).toBe(true);
      },
    );
  });
});

describe("pi contract: a node's tools by role", () => {
  it("explore: edit and write are refused with the role's words, read goes through", async () => {
    await runScenario(
      {
        scenario: "task-role-explore",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("explore")],
        files: { "a.txt": "hello\n" },
        script: {
          replies: [
            batch(["read", { path: "a.txt" }], ["write", { path: "b.txt", content: "x" }], ["agent_list", {}]),
            said("ok"),
          ],
        },
      },
      async ({ pi, until, contexts, cwd }) => {
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await host.close();

        const results = latestResults((await contexts())[1]);
        expect(results[0]).toStrictEqual({ text: expect.stringContaining("hello"), isError: false });
        expect(results[1]).toStrictEqual({
          text: "This node (explore) can only use read, bash, ffgrep, fffind, ls, node_done, request_graph_change, ask_user.",
          isError: true,
        });
        expect(results[2]).toStrictEqual({ text: "A task node cannot start or talk to sub-agents.", isError: true });
        const { existsSync } = await import("node:fs");
        expect(existsSync(`${cwd}/b.txt`)).toBe(false);
      },
    );
  });

  it("work: a write inside the directory is done, and one outside is refused with the path guard's words", async () => {
    await runScenario(
      {
        scenario: "task-role-work",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: {
          replies: [
            batch(["write", { path: "ok.txt", content: "x" }], ["write", { path: "../escape.txt", content: "x" }]),
            said("ok"),
          ],
        },
      },
      async ({ pi, until, contexts, cwd }) => {
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await host.close();

        const results = latestResults((await contexts())[1]);
        expect(results[0]?.isError).toBe(false);
        expect(results[1]).toStrictEqual({ text: outsideReason(cwd), isError: true });
      },
    );
  });
});

/**
 * Makes a git repository outside the working directory, with one commit.
 *
 * @sideEffects Creates and runs git in a temporary directory; deletes it when the test finishes.
 * @returns The repository's real path.
 */
async function outsideRepo(): Promise<string> {
  const dir = await createTempDir("task-git-outside");
  onTestFinished(dir.cleanup);
  const path = await realpath(dir.path);
  const git = (...args: string[]) => run("git", ["-C", path, ...args]);
  await git("init", "-q");
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first");
  return path;
}

/**
 * How many commits a repository has.
 *
 * @sideEffects Runs git.
 * @param path - The repository.
 * @returns The count.
 */
async function commitCount(path: string): Promise<number> {
  return Number((await run("git", ["-C", path, "rev-list", "--count", "HEAD"])).stdout.trim());
}

/** The commands the model runs, and what the guard should make of each. */
const commit = (outside: string) =>
  `git -C ${outside} -c user.name=m -c user.email=m@m commit -q --allow-empty -m evil`;

describe("pi contract: bash git outside the working directory (SPEC-0006, 路径隔离)", () => {
  it("a node: git -C and GIT_DIR= to a repository outside are refused; git status in its own directory runs", async () => {
    const outside = await outsideRepo();
    await runScenario(
      {
        scenario: "task-git-blocked",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: {
          replies: [
            batch(
              ["bash", { command: commit(outside) }],
              [
                "bash",
                {
                  command: `GIT_DIR=${outside}/.git git -c user.name=m -c user.email=m@m commit -q --allow-empty -m evil`,
                },
              ],
              [
                "bash",
                { command: `cd ${outside} && git -c user.name=m -c user.email=m@m commit -q --allow-empty -m evil` },
              ],
              ["bash", { command: "git status --short" }],
            ),
            said("done"),
          ],
        },
      },
      async ({ pi, until, contexts, cwd }) => {
        await run("git", ["-C", cwd, "init", "-q"]);
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await host.close();

        const results = latestResults((await contexts())[1]);
        expect(results.slice(0, 3)).toStrictEqual(
          Array.from({ length: 3 }, () => ({ text: gitReason(cwd), isError: true })),
        );
        expect(results[3]?.isError).toBe(false);
        expect(await commitCount(outside)).toBe(1);
      },
    );
  });

  it("a node the host did not isolate: the same command runs", async () => {
    const outside = await outsideRepo();
    await runScenario(
      {
        scenario: "task-git-not-isolated",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work", { isolated: false })],
        script: { replies: [batch(["bash", { command: commit(outside) }]), said("done")] },
      },
      async ({ pi, until }) => {
        const host = new FakeTaskHost(pi);
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await host.close();

        expect(await commitCount(outside)).toBe(2);
      },
    );
  });

  it("not a task session: the same command runs", async () => {
    const outside = await outsideRepo();
    await runScenario(
      {
        scenario: "task-git-plain",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        script: { replies: [batch(["bash", { command: commit(outside) }]), said("done")] },
      },
      async ({ pi, until }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");

        expect(await commitCount(outside)).toBe(2);
      },
    );
  });
});

describe("pi contract: the hidden command's text", () => {
  it("is what commandText writes: pi handles it and writes nothing the model sees but the extension's message", async () => {
    await runScenario(
      {
        scenario: "task-command-text",
        unrecorded: true,
        extensions: [ATRIUM_EXTENSION],
        args: [node("work")],
        script: { replies: [said("never")] },
      },
      async ({ pi, contexts }) => {
        const answered = await pi.request({
          type: "prompt",
          message: commandText("reply", { v: 1, id: "nobody", ok: true, result: {} }),
        });
        await quietPeriod();

        expect(answered).toStrictEqual({ disposition: "handled" });
        expect(await contexts()).toHaveLength(0);
      },
    );
  });
});
