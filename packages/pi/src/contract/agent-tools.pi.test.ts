import { fileURLToPath } from "node:url";
import type { FauxContext } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_END_GATE, AGENT_END_REACHED } from "../../test/agent-end-probe";
import { encodeArgument } from "../agent/agent";
import { type Delivery, readRequest } from "../agent/channel";
import { reportText, resultText, taskText } from "../agent/words";
import type { PiEvent } from "../process/pi-process";

/** Holds pi at a run's `agent_end` until released, ahead of Atrium's extension. */
const AGENT_END_PROBE = fileURLToPath(new URL("../../test/agent-end-probe.ts", import.meta.url));

/** Atrium's extension, as the host has pi load it (ADR-0008, ADR-0013). */
const ATRIUM_EXTENSION = fileURLToPath(new URL("../extension/atrium.ts", import.meta.url));

/** The main agent's tools and a child's own two, as the extension registers them. */
const AGENT_TOOLS = [
  "agent_list",
  "agent_models",
  "agent_read",
  "agent_reply",
  "agent_send",
  "agent_spawn",
  "agent_stop",
  "ask_parent",
  "report_progress",
];

/**
 * The host's flag telling the extension who the session is.
 *
 * @remarks
 * One argument with `=`, as the host passes it (ADR-0013, point 3).
 *
 * @sideEffects none
 * @param self - Who it is.
 * @returns The argument.
 */
function flag(self: Record<string, unknown>): string {
  return `--atrium-agent=${encodeArgument({ v: 1, ...self })}`;
}

/**
 * Whether an event is a call the extension made on its status line.
 *
 * @remarks
 * `atrium-agent:<request id>` with the envelope as its text (ADR-0013, point 1).
 *
 * @sideEffects none
 * @param id - The request id.
 * @returns The predicate.
 */
function asked(id: string): (event: PiEvent) => boolean {
  return (event) =>
    event.type === "extension_ui_request" &&
    event.method === "setStatus" &&
    event.statusKey === `atrium-agent:${id}` &&
    event.statusText !== undefined;
}

/**
 * The text of the last tool result a request carried.
 *
 * @remarks
 * What the model was told.
 *
 * @sideEffects none
 * @param request - The request; none has no result.
 * @returns The text.
 */
function lastResult(request: FauxContext | undefined): string {
  const result = (request?.messages ?? []).findLast(
    (message) => Reflect.get(message as object, "role") === "toolResult",
  );
  const content: unknown = result === undefined ? [] : Reflect.get(Object(result), "content");
  return Array.isArray(content)
    ? content.map((block: unknown) => String(Reflect.get(block as object, "text") ?? "")).join("")
    : "";
}

/**
 * Whether an event ends a custom message: the delivery written into the session.
 *
 * @remarks
 * Its `details` are what the transcript reads (SPEC-0002, "对话记录里的自定义消息").
 *
 * @sideEffects none
 * @param event - The event.
 * @returns Whether it does.
 */
function customEnd(event: PiEvent): boolean {
  return event.type === "message_end" && event.message.role === "custom";
}

/**
 * Each message the model got, as `role: text`, without the system message.
 *
 * @remarks
 * A custom message reaches the model as a user message with text blocks.
 *
 * @sideEffects none
 * @param request - The request; none has no messages.
 * @returns One line each.
 */
function spoken(request: FauxContext | undefined): string[] {
  return (request?.messages ?? []).flatMap((message) => {
    const role = String(Reflect.get(message as object, "role"));
    if (role === "system") return [];
    const content: unknown = Reflect.get(message as object, "content");
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((block: unknown) => String(Reflect.get(block as object, "text") ?? "")).join("")
          : "";
    return [`${role}: ${text}`];
  });
}

/**
 * The agent tools a request offered the model, sorted.
 *
 * @remarks
 * pi's own tools are left out.
 *
 * @sideEffects none
 * @param request - The request; none offered nothing.
 * @returns The tools.
 */
function agentTools(request: FauxContext | undefined): string[] {
  return [...(request?.tools ?? [])].filter((tool) => AGENT_TOOLS.includes(tool)).toSorted();
}

/**
 * A child's task finishing, as a notice carries it.
 *
 * @remarks
 * From `audit`, after a second.
 *
 * @sideEffects none
 * @param taskId - The task.
 * @returns The event.
 */
function finishedOf(taskId: string): Extract<Delivery, { kind: "report" }>["events"][number] {
  return { name: "audit", title: "审查", sessionId: "s-1", taskId, event: "finished", elapsedMs: 1000 };
}

describe("pi contract: Atrium's agent tools", () => {
  it("agent-call: a tool asks the host on its status line, the host's reply answers it mid-run, and the model reads the words", async () => {
    await runScenario(
      {
        scenario: "agent-call",
        extensions: [ATRIUM_EXTENSION],
        args: [flag({ child: false, role: null, depth: 0, guard: "flags" })],
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "agent_list", arguments: {} }] },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "go" });
        const call = await until(asked("call-1"));
        const read = readRequest(String(Reflect.get(call, "statusText")));
        const result = { children: [] };
        const answered = await pi.request({
          type: "prompt",
          message: `/atrium-agent reply ${encodeArgument({ v: 1, id: "call-1", ok: true, result })}`,
        });
        await until((event) => event.type === "agent_settled");
        const [first, second] = await contexts();

        expect(read).toStrictEqual({ request: { kind: "call", id: "call-1", op: "list", args: {} } });
        expect(answered).toStrictEqual({ disposition: "handled" });
        expect(agentTools(first)).toStrictEqual(AGENT_TOOLS);
        expect(lastResult(second)).toBe(resultText("list", result));
      },
    );
  });

  it("agent-task: a task delivered to an idle pi starts a run, and the model reads it wrapped, with who it is", async () => {
    const delivery: Delivery = {
      v: 1,
      kind: "task",
      deliveries: ["d1"],
      from: "main",
      fromTitle: "修复",
      taskId: "t-1",
      text: "look at auth",
      preamble: { role: "explore", forked: false, canSpawn: true },
    };
    await runScenario(
      {
        scenario: "agent-task",
        session: true,
        extensions: [ATRIUM_EXTENSION],
        args: [flag({ child: true, role: "explore", depth: 1, guard: "flags" })],
        script: { replies: [{ blocks: [{ type: "text", text: "looked" }] }] },
      },
      async ({ pi, until, contexts }) => {
        const handled = await pi.request({
          type: "prompt",
          message: `/atrium-agent deliver ${encodeArgument(delivery)}`,
        });
        const message = await until(customEnd);
        await until((event) => event.type === "agent_settled");
        const [request] = await contexts();

        expect(handled).toStrictEqual({ disposition: "handled" });
        expect(message).toMatchObject({
          message: {
            customType: "atrium-agent",
            details: {
              v: 1,
              kind: "task",
              deliveries: ["d1"],
              from: "main",
              fromTitle: "修复",
              taskId: "t-1",
              text: "look at auth",
            },
          },
        });
        expect(spoken(request)).toStrictEqual([`user: ${taskText(delivery)}`]);
      },
    );
  });

  it("agent-boundary: notices that come while a tool runs go in together at the batch's end, before the next request", async () => {
    const first: Delivery = { v: 1, kind: "report", deliveries: ["d1"], events: [finishedOf("t-1")], progress: [] };
    const second: Delivery = {
      v: 1,
      kind: "report",
      deliveries: ["d2"],
      events: [finishedOf("t-2")],
      progress: [{ name: "audit", title: "审查", message: "half" }],
    };
    await runScenario(
      {
        scenario: "agent-boundary",
        extensions: [ATRIUM_EXTENSION],
        args: [flag({ child: false, role: null, depth: 0, guard: "flags" })],
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "agent_list", arguments: {} }] },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until(asked("call-1"));
        for (const delivery of [first, second])
          await pi.request({ type: "prompt", message: `/atrium-agent deliver ${encodeArgument(delivery)}` });
        await pi.request({
          type: "prompt",
          message: `/atrium-agent reply ${encodeArgument({ v: 1, id: "call-1", ok: true, result: { children: [] } })}`,
        });
        await until((one) => one.type === "agent_settled");
        const requests = await contexts();

        expect(requests).toHaveLength(2);
        expect(spoken(requests[1]).slice(-2)).toStrictEqual([
          `toolResult: ${resultText("list", { children: [] })}`,
          `user: ${reportText({ ...first, deliveries: ["d1", "d2"], events: [finishedOf("t-1"), finishedOf("t-2")], progress: second.progress })}`,
        ]);
      },
    );
  });

  it("agent-boundary-end: a notice that comes after the run's last turn end goes in as pi runs on, in the same run", async () => {
    const notice: Delivery = { v: 1, kind: "report", deliveries: ["d1"], events: [finishedOf("t-1")], progress: [] };
    await runScenario(
      {
        scenario: "agent-boundary-end",
        extensions: [AGENT_END_PROBE, ATRIUM_EXTENSION],
        args: [flag({ child: false, role: null, depth: 0, guard: "flags" })],
        script: {
          replies: [{ blocks: [{ type: "text", text: "done" }] }, { blocks: [{ type: "text", text: "saw it" }] }],
        },
      },
      async ({ pi, until, contexts, release, cwd, events }) => {
        await pi.request({ type: "prompt", message: "go" });
        await expect.poll(() => existsSync(join(cwd, "faux-gates", AGENT_END_REACHED)), { timeout: 30_000 }).toBe(true);
        await pi.request({ type: "prompt", message: `/atrium-agent deliver ${encodeArgument(notice)}` });
        await release(AGENT_END_GATE);
        await until((one) => one.type === "agent_settled");
        const requests = await contexts();

        expect(events.filter((one) => one.type === "agent_settled")).toHaveLength(1);
        expect(requests).toHaveLength(2);
        expect(spoken(requests[1]).at(-1)).toBe(`user: ${reportText(notice)}`);
      },
    );
  });

  it("agent-boundary-stop: a notice the extension holds goes no further once the run is stopped", async () => {
    const delivery: Delivery = {
      v: 1,
      kind: "report",
      deliveries: ["d1"],
      events: [{ name: "audit", title: "审查", sessionId: "s-1", taskId: "t-1", event: "finished" }],
      progress: [],
    };
    await runScenario(
      {
        scenario: "agent-boundary-stop",
        extensions: [ATRIUM_EXTENSION],
        args: [flag({ child: false, role: null, depth: 0, guard: "flags" })],
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "agent_list", arguments: {} }] },
            { blocks: [{ type: "text", text: "again" }] },
          ],
        },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until(asked("call-1"));
        await pi.request({ type: "prompt", message: `/atrium-agent deliver ${encodeArgument(delivery)}` });
        // As the host stops a session: pi's own queue first, then the run.
        await pi.request({ type: "clear_queue" });
        await pi.request({ type: "abort" });
        await until((one) => one.type === "agent_settled");
        await pi.request({ type: "prompt", message: "next" });
        await until((one) => one.type === "agent_settled");
        const requests = await contexts();

        expect(spoken(requests.at(-1)).filter((line) => line.includes("atrium-agent-report"))).toStrictEqual([]);
      },
    );
  });

  it("agent-guard: a read-only child limited by the extension cannot run a tool off its list, and is told why", async () => {
    await runScenario(
      {
        scenario: "agent-guard",
        extensions: [ATRIUM_EXTENSION],
        args: [flag({ child: true, role: "explore", depth: 1, guard: "extension" })],
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "touch ran" } }] },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        const [, second] = await contexts();

        expect(lastResult(second)).toBe(
          "This sub-agent is read-only (explore): it can use read, grep, find, ls, report_progress, ask_parent and the agent_* tools.",
        );
      },
    );
  });
});
