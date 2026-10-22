import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FauxContext } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../test/contract";
import { encodeArgument } from "../agent/agent";
import { type Delivery, readRequest } from "../agent/channel";
import { CHILD_TOOLS, READ_ONLY_TOOLS, resultText, taskText } from "../agent/words";
import type { PiEvent } from "../process/pi-process";

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
  "agent_wait",
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

  it.each([
    {
      role: "explore",
      guard: "flags",
      tools: ["--tools", [...READ_ONLY_TOOLS, ...CHILD_TOOLS].join(",")],
      writeError: "Tool write not found",
    },
    {
      role: "advise",
      guard: "extension",
      tools: [],
      writeError:
        "This sub-agent is read-only (advise): it can use read, bash, grep, find, ls, report_progress, ask_parent.",
    },
  ] as const)(
    "agent-readonly-bash-$guard: $role can query with Bash but cannot call write",
    async ({ role, guard, tools, writeError }) => {
      await runScenario(
        {
          scenario: `agent-readonly-bash-${guard}`,
          extensions: [ATRIUM_EXTENSION],
          args: [flag({ child: true, role, depth: 2, guard }), ...tools],
          script: {
            replies: [
              {
                blocks: [
                  { type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "printf readonly-bash-ok" } },
                ],
              },
              {
                blocks: [
                  {
                    type: "toolCall",
                    id: "write-1",
                    name: "write",
                    arguments: { path: "forbidden.txt", content: "no" },
                  },
                ],
              },
              { blocks: [{ type: "text", text: "done" }] },
            ],
          },
        },
        async ({ pi, until, contexts, cwd }) => {
          await pi.request({ type: "prompt", message: "go" });
          await until((event) => event.type === "agent_settled");
          const [first, second, third] = await contexts();

          expect(first?.tools).toContain("bash");
          expect(lastResult(second)).toBe("readonly-bash-ok");
          expect(lastResult(third)).toBe(writeError);
          expect(await stat(join(cwd, "forbidden.txt")).catch(() => null)).toBeNull();
        },
      );
    },
  );

  it("agent-guard: a read-only child limited by the extension cannot run a tool off its list, and is told why", async () => {
    await runScenario(
      {
        scenario: "agent-guard",
        extensions: [ATRIUM_EXTENSION],
        args: [flag({ child: true, role: "explore", depth: 1, guard: "extension" })],
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "ran", content: "no" } }] },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, until, contexts }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        const [, second] = await contexts();

        expect(lastResult(second)).toBe(
          "This sub-agent is read-only (explore): it can use read, bash, grep, find, ls, report_progress, ask_parent and the agent_* tools.",
        );
      },
    );
  });
});
