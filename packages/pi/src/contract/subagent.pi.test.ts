import { createTempDir, present } from "@atrium/testkit";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runScenario, startOtherPi } from "../../test/contract";
import {
  PROBE_BLOCK_ENV,
  PROBE_BLOCK_REASON,
  PROBE_BRANCH_DIR_ENV,
  PROBE_CHANNEL,
  PROBE_DELIVER,
  PROBE_MESSAGE,
  PROBE_REPLY,
  type ProbeDelivery,
  encodeArgument,
} from "../../test/subagent-probe";
import { findPi } from "../locate/locate";
import type { PiEvent } from "../process/pi-process";

/** The test-only extension that tries out what SPEC-0002's extension will rely on. */
const PROBE = fileURLToPath(new URL("../../test/subagent-probe.ts", import.meta.url));

/**
 * The prompt that hands pi a custom message through the probe.
 *
 * @remarks
 * As the host's `deliver` will (SPEC-0002, "送达"): a hidden command whose argument is base64url JSON.
 *
 * @sideEffects none
 * @param delivery - The message and how to deliver it.
 * @returns The prompt's text.
 */
function deliver(delivery: ProbeDelivery): string {
  return `/${PROBE_DELIVER} ${encodeArgument(delivery)}`;
}

/**
 * The steers pi listed in each `queue_update`, in order.
 *
 * @remarks
 * A custom steer must not show here: the queue panel lists only what you queued.
 *
 * @sideEffects none
 * @param events - pi's events.
 * @returns The lists.
 */
function steering(events: readonly PiEvent[]): string[][] {
  return events.flatMap((event) => (event.type === "queue_update" ? [[...event.steering]] : []));
}

/**
 * The text of a message the model got: its string content, or its text blocks joined.
 *
 * @remarks
 * Custom messages arrive with string content, user and tool messages with blocks.
 *
 * @sideEffects none
 * @param message - The message.
 * @returns The text.
 */
function textOf(message: unknown): string {
  const content: unknown = typeof message === "object" && message !== null ? Reflect.get(message, "content") : "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) =>
      typeof block === "object" && block !== null && Reflect.get(block, "type") === "text"
        ? String(Reflect.get(block, "text"))
        : "",
    )
    .join("");
}

/**
 * Each message the model got, as `role: text`, with a tool call as `call <name>`.
 *
 * @remarks
 * Enough to compare what the model saw in order, without the timestamps and usage.
 *
 * @sideEffects none
 * @param messages - The messages of one request.
 * @returns One line each; the system message is left out.
 */
function seen(messages: readonly unknown[]): string[] {
  return messages.flatMap((message): string[] => {
    const role = String(Reflect.get(message as object, "role"));
    if (role === "system") return [];
    const content: unknown = Reflect.get(message as object, "content");
    const calls = Array.isArray(content)
      ? content.flatMap((block: unknown) =>
          typeof block === "object" && block !== null && Reflect.get(block, "type") === "toolCall"
            ? [`call ${String(Reflect.get(block, "name"))}`]
            : [],
        )
      : [];
    const text = textOf(message);
    return [...(text === "" ? [] : [`${role}: ${text}`]), ...calls.map((call) => `${role}: ${call}`)];
  });
}

/**
 * The lines of a JSON-lines file, parsed.
 *
 * @remarks
 * For session files, whose entries the scenarios compare.
 *
 * @sideEffects Reads the file.
 * @param path - The file.
 * @returns The lines.
 */
async function linesOf(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Whether an event is the probe asking the host on the status line.
 *
 * @remarks
 * The request SPEC-0002's "乙" channel makes: a `setStatus` whose key starts with the channel's.
 *
 * @sideEffects none
 * @param event - pi's event.
 * @returns Whether it is.
 */
function isProbeQuestion(event: PiEvent): boolean {
  return (
    event.type === "extension_ui_request" &&
    event.method === "setStatus" &&
    event.statusKey.startsWith(`${PROBE_CHANNEL}:`)
  );
}

/**
 * Whether an event is the end of a custom message.
 *
 * @remarks
 * How a delivery shows in pi's events: `role: "custom"`, no `entry_appended`.
 *
 * @sideEffects none
 * @param event - pi's event.
 * @returns Whether it is.
 */
function isCustomMessage(event: PiEvent): boolean {
  return event.type === "message_end" && event.message.role === "custom";
}

/**
 * Whether an event is the end of the `probe_branch` call the fork scenario makes.
 *
 * @remarks
 * Its result carries the branch's path.
 *
 * @sideEffects none
 * @param event - pi's event.
 * @returns Whether it is.
 */
function isBranchResult(event: PiEvent): boolean {
  return event.type === "tool_execution_end" && event.toolCallId === "call-branch";
}

/**
 * Whether a session entry is the assistant message that called `probe_branch`.
 *
 * @remarks
 * Found by the scripted tool call id; entry ids never show in pi's events.
 *
 * @sideEffects none
 * @param line - A session file line.
 * @returns Whether it is.
 */
function isBranchCall(line: Record<string, unknown>): boolean {
  return JSON.stringify(line["message"] ?? null).includes('"call-branch"');
}

/**
 * A session file line's kind: its type, and for a message its role too.
 *
 * @remarks
 * Enough to compare what pi wrote in order.
 *
 * @sideEffects none
 * @param line - A session file line.
 * @returns For example `"custom_message"` or `"message assistant"`.
 */
function entryKind(line: Record<string, unknown>): unknown {
  return line["type"] === "message"
    ? `message ${String(Reflect.get(line["message"] as object, "role"))}`
    : line["type"];
}

/** The shape of pi-ai's `transformMessages`, which every real provider runs on a request's messages. */
type TransformMessages = (messages: unknown[], model: unknown) => unknown[];

/**
 * Loads `transformMessages` from the pi-ai of the installed pi, not the repository's copy.
 *
 * @remarks
 * Real providers fill unanswered tool calls in there; faux does not run it, so the scenario runs
 * the installed pi's own copy on the messages pi gave faux (SPEC-0002, "带上下文的子对话").
 *
 * @sideEffects Reads pi's install.
 * @returns The function.
 * @throws {Error} When the installed pi has no pi-ai beside it.
 */
async function installedTransformMessages(): Promise<TransformMessages> {
  let dir = await realpath(present(await findPi(present(process.env["PATH"], "PATH")), "pi on PATH"));
  for (;;) {
    const file = join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "api", "transform-messages.js");
    if (existsSync(file)) {
      const module = (await import(pathToFileURL(file).href)) as { transformMessages: TransformMessages };
      return module.transformMessages;
    }
    if (dirname(dir) === dir) throw new Error("the installed pi has no pi-ai beside it");
    dir = dirname(dir);
  }
}

describe("pi contract: SPEC-0002's extension channel and deliveries", () => {
  it("agent-channel: a tool asks over the status line, and the hidden command answers it mid-run without a trace", async () => {
    await runScenario(
      {
        scenario: "agent-channel",
        session: true,
        extensions: [PROBE],
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "probe_ask", arguments: { question: "which?" } }] },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, events, until, contexts, sessionsDir }) => {
        await pi.request({ type: "prompt", message: "go" });
        const asked = await until(isProbeQuestion);
        expect(asked).toMatchObject({ statusKey: `${PROBE_CHANNEL}:q1`, statusText: '{"question":"which?"}' });
        expect(await pi.request({ type: "get_state" })).toMatchObject({ isStreaming: true });

        // pi runs an extension command at once, even mid-run (pi-internals, "扩展与宿主的通道").
        const answered = await pi.request({ type: "prompt", message: `/${PROBE_REPLY} q1 ${encodeArgument("left")}` });
        await until((event) => event.type === "agent_settled");

        expect(answered).toStrictEqual({ disposition: "handled" });
        const [, second] = await contexts();
        expect(seen(present(second, "the second request").messages)).toStrictEqual([
          "user: go",
          "assistant: call probe_ask",
          "toolResult: left",
        ]);
        expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
        const [file] = await readdir(sessionsDir, { recursive: true });
        const text = await readFile(join(sessionsDir, present(file, "the session file")), "utf8");
        expect(text).not.toContain(PROBE_REPLY);
      },
    );
  });

  it("custom-idle: a custom message with triggerTurn starts a run while idle, and the file waits for the reply", async () => {
    await runScenario(
      {
        scenario: "custom-idle",
        session: true,
        extensions: [PROBE],
        script: { replies: [{ waitFor: "reply", blocks: [{ type: "text", text: "seen" }] }] },
      },
      async ({ pi, events, until, release, contexts, sessionsDir }) => {
        const handled = await pi.request({
          type: "prompt",
          message: deliver({ text: "from child", triggerTurn: true, deliverAs: "steer" }),
        });
        const delivered = await until(isCustomMessage);
        // Only a custom message so far: pi has not written the file (SPEC-0002, "确认").
        const before = await readdir(sessionsDir, { recursive: true });
        await release("reply");
        await until((event) => event.type === "agent_settled");
        const after = await readdir(sessionsDir, { recursive: true });

        expect(handled).toStrictEqual({ disposition: "handled" });
        expect(delivered).toMatchObject({
          message: { role: "custom", customType: PROBE_MESSAGE, content: "from child" },
        });
        expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
        expect(before).toStrictEqual([]);
        const lines = await linesOf(join(sessionsDir, present(after[0], "the session file")));
        expect(lines.map(entryKind)).toStrictEqual([
          "session",
          "model_change",
          "thinking_level_change",
          "message system",
          "custom_message",
          "message assistant",
        ]);
        const [first] = await contexts();
        expect(seen(present(first, "the request").messages)).toStrictEqual(["user: from child"]);
      },
    );
  });

  it("custom-steer: mid-run, a custom steer is not listed and reaches the model after the tool batch, in the same run", async () => {
    await runScenario(
      {
        scenario: "custom-steer",
        extensions: [PROBE],
        script: {
          replies: [
            {
              waitFor: "first",
              blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf ok" } }],
            },
            { blocks: [{ type: "text", text: "steered" }] },
          ],
        },
      },
      async ({ pi, events, until, release, heldAfterUserMessage, contexts }) => {
        await pi.request({ type: "prompt", message: "one" });
        await heldAfterUserMessage(1);
        const handled = await pi.request({
          type: "prompt",
          message: deliver({ text: "from child", triggerTurn: true, deliverAs: "steer" }),
        });
        await release("first");
        await until((event) => event.type === "agent_settled");

        expect(handled).toStrictEqual({ disposition: "handled" });
        expect(steering(events).flat()).toStrictEqual([]);
        expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
        const [, second] = await contexts();
        expect(seen(present(second, "the second request").messages)).toStrictEqual([
          "user: one",
          "assistant: call bash",
          "toolResult: ok",
          "user: from child",
        ]);
      },
    );
  });

  it("custom-clear: clear_queue drops a custom steer, without listing it, and the run ends without it", async () => {
    await runScenario(
      {
        scenario: "custom-clear",
        extensions: [PROBE],
        script: {
          replies: [
            {
              waitFor: "first",
              blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf ok" } }],
            },
            { blocks: [{ type: "text", text: "after" }] },
          ],
        },
      },
      async ({ pi, until, release, heldAfterUserMessage, contexts }) => {
        await pi.request({ type: "prompt", message: "one" });
        await heldAfterUserMessage(1);
        await pi.request({
          type: "prompt",
          message: deliver({ text: "from child", triggerTurn: true, deliverAs: "steer" }),
        });
        const cleared = await pi.request({ type: "clear_queue" });
        await release("first");
        await until((event) => event.type === "agent_settled");

        expect(cleared).toStrictEqual({ steering: [], followUp: [] });
        const [, second] = await contexts();
        expect(seen(present(second, "the second request").messages)).toStrictEqual([
          "user: one",
          "assistant: call bash",
          "toolResult: ok",
        ]);
      },
    );
  });
});

describe("pi contract: SPEC-0002's tool limits", () => {
  it("tools-allow: --tools declares only the listed tools, extensions' too, and a call to another fails without running", async () => {
    await runScenario(
      {
        scenario: "tools-allow",
        extensions: [PROBE],
        args: ["--tools", "read,ls,probe_ask"],
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "touch ran" } }] },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, until, contexts, cwd }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");

        const [first, second] = await contexts();
        expect([...present(first, "the request").tools].toSorted()).toStrictEqual(["ls", "probe_ask", "read"]);
        expect(seen(present(second, "the second request").messages)).toStrictEqual([
          "user: go",
          "assistant: call bash",
          "toolResult: Tool bash not found",
        ]);
        expect(existsSync(join(cwd, "ran"))).toBe(false);
      },
    );
  });

  it("tools-exclude: --exclude-tools leaves the named tools, extensions' too, undeclared and uncallable", async () => {
    await runScenario(
      {
        scenario: "tools-exclude",
        extensions: [PROBE],
        args: ["--exclude-tools", "bash,probe_branch"],
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "touch ran" } }] },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, until, contexts, cwd }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");

        const [first, second] = await contexts();
        const tools = present(first, "the request").tools;
        expect([
          tools.includes("bash"),
          tools.includes("probe_branch"),
          tools.includes("probe_ask"),
          tools.includes("read"),
        ]).toStrictEqual([false, false, true, true]);
        expect(seen(present(second, "the second request").messages)).toStrictEqual([
          "user: go",
          "assistant: call bash",
          "toolResult: Tool bash not found",
        ]);
        expect(existsSync(join(cwd, "ran"))).toBe(false);
      },
    );
  });

  it("tool-block: a call the tool_call hook blocks does not run, and the model gets the hook's reason as an error", async () => {
    await runScenario(
      {
        scenario: "tool-block",
        extensions: [PROBE],
        env: { [PROBE_BLOCK_ENV]: "bash" },
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "touch ran" } }] },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, until, contexts, cwd }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");

        const [first, second] = await contexts();
        expect(present(first, "the request").tools).toContain("bash");
        const messages = present(second, "the second request").messages;
        expect(seen(messages)).toStrictEqual(["user: go", "assistant: call bash", `toolResult: ${PROBE_BLOCK_REASON}`]);
        expect(messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "call-1", isError: true });
        expect(existsSync(join(cwd, "ran"))).toBe(false);
      },
    );
  });
});

describe("pi contract: SPEC-0002's child with context", () => {
  it("agent-fork: a tool cuts the session at the current leaf, and --fork starts a child on it that sees the calls unanswered", async () => {
    // The host's temporary directory for the branch, outside the parent's session directory.
    const temp = await createTempDir("branch");
    const branchDir = await realpath(temp.path);
    try {
      await runScenario(
        {
          scenario: "agent-fork",
          session: true,
          extensions: [PROBE],
          env: { [PROBE_BRANCH_DIR_ENV]: branchDir },
          script: {
            replies: [
              { blocks: [{ type: "text", text: "first answer" }] },
              {
                blocks: [
                  { type: "toolCall", id: "call-branch", name: "probe_branch", arguments: {} },
                  { type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "printf x" } },
                ],
              },
              { blocks: [{ type: "text", text: "parent done" }] },
            ],
          },
        },
        async ({ pi, events, until, cwd, sessionsDir }) => {
          await pi.request({ type: "prompt", message: "one" });
          await until((event) => event.type === "agent_settled");
          await pi.request({ type: "prompt", message: "two" });
          await vi.waitFor(() => expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(2), {
            timeout: 20_000,
            interval: 10,
          });
          const parentFile = present((await pi.request({ type: "get_state" })).sessionFile, "the parent's file");
          const result = present(events.find(isBranchResult), "the branch result");
          const { branch } = JSON.parse(textOf(Reflect.get(result, "result"))) as { branch: string };
          const parent = await linesOf(parentFile);
          const cut = await linesOf(branch);

          // The branch is the parent up to the assistant message that called the tool, ids kept.
          const callAt = parent.findIndex(isBranchCall);
          expect(Reflect.get(present(parent[callAt], "the call entry"), "message")).toMatchObject({
            role: "assistant",
            stopReason: "toolUse",
          });
          expect(cut[0]).toMatchObject({ type: "session", cwd, parentSession: parentFile });
          expect(cut.slice(1).map((line) => line["id"])).toStrictEqual(
            parent.slice(1, callAt + 1).map((line) => line["id"]),
          );
          expect(parent.length).toBeGreaterThan(callAt + 1);
          expect(dirname(branch)).toBe(branchDir);
          expect(dirname(parentFile).startsWith(sessionsDir)).toBe(true);

          // The child's pi, in another directory, forked from the branch with an id of the host's.
          const childDir = join(cwd, "child");
          const childSessions = join(cwd, "child-sessions");
          const id = randomUUID();
          const child = await startOtherPi({
            dir: childDir,
            script: { replies: [{ blocks: [{ type: "text", text: "child answer" }] }] },
            args: ["--session-dir", childSessions, "--fork", branch, "--session-id", id],
            extensions: [PROBE],
          });
          try {
            const state = await child.pi.request({ type: "get_state" });
            const childFile = present(state.sessionFile, "the child's file");
            const writtenBeforeState = existsSync(childFile);
            const childLines = await linesOf(childFile);
            await child.pi.request({ type: "prompt", message: deliver({ text: "task", triggerTurn: true }) });
            await child.until((event) => event.type === "agent_settled");
            const [request] = await child.contexts();
            const messages = present(request, "the child's request").messages;
            const transform = await installedTransformMessages();

            expect(state).toMatchObject({ sessionId: id });
            expect(writtenBeforeState).toBe(true);
            expect(childLines[0]).toMatchObject({ type: "session", id, cwd: childDir });
            expect(childLines.slice(1).map((line) => line["id"])).toStrictEqual(cut.slice(1).map((line) => line["id"]));
            expect(seen(messages)).toStrictEqual([
              "user: one",
              "assistant: first answer",
              "user: two",
              "assistant: call probe_branch",
              "assistant: call bash",
              "user: task",
            ]);
            expect(
              seen(transform([...messages], { api: "atrium-faux", provider: "faux", id: "faux-1", input: ["text"] })),
            ).toStrictEqual([
              "user: one",
              "assistant: first answer",
              "user: two",
              "assistant: call probe_branch",
              "assistant: call bash",
              "toolResult: No result provided",
              "toolResult: No result provided",
              "user: task",
            ]);
          } finally {
            await child.pi.stop();
          }
        },
      );
    } finally {
      await temp.cleanup();
    }
  });
});

describe("pi contract: SPEC-0003's ask_user on the extension channel", () => {
  it("ask-steer: a steer sent while a tool waits on the host reaches the model right after the tool's answer, in the same run", async () => {
    await runScenario(
      {
        scenario: "ask-steer",
        extensions: [PROBE],
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "probe_ask", arguments: { question: "which?" } }] },
            { blocks: [{ type: "text", text: "done" }] },
          ],
        },
      },
      async ({ pi, events, until, contexts }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until(isProbeQuestion);
        // The direct reply's order (SPEC-0003, "直接回复"): the steer first, then the answer.
        const steered = await pi.request({ type: "steer", message: "do it my way" });
        const answered = await pi.request({
          type: "prompt",
          message: `/${PROBE_REPLY} q1 ${encodeArgument("replied directly")}`,
        });
        await until((event) => event.type === "agent_settled");

        expect(steered).toStrictEqual({ disposition: "queued" });
        expect(answered).toStrictEqual({ disposition: "handled" });
        expect(steering(events)).toStrictEqual([["do it my way"], []]);
        expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
        const [, second] = await contexts();
        expect(seen(present(second, "the second request").messages)).toStrictEqual([
          "user: go",
          "assistant: call probe_ask",
          "toolResult: replied directly",
          "user: do it my way",
        ]);
      },
    );
  });

  it("ask-abort: abort ends a tool waiting on the host as an error with the extension's text, and the model sees it so next time", async () => {
    await runScenario(
      {
        scenario: "ask-abort",
        session: true,
        extensions: [PROBE],
        script: {
          replies: [
            { blocks: [{ type: "toolCall", id: "call-1", name: "probe_ask", arguments: { question: "which?" } }] },
            { blocks: [{ type: "text", text: "after" }] },
          ],
        },
      },
      async ({ pi, events, until, contexts, sessionsDir }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until(isProbeQuestion);
        await pi.request({ type: "abort" });
        await until((event) => event.type === "agent_settled");
        const ended = events.find((event) => event.type === "tool_execution_end");
        await pi.request({ type: "prompt", message: "next" });
        await until(() => events.filter((event) => event.type === "agent_settled").length === 2);

        expect(ended).toMatchObject({
          toolCallId: "call-1",
          isError: true,
          result: { content: [{ type: "text", text: "aborted" }], details: {} },
        });
        const [file] = await readdir(sessionsDir, { recursive: true });
        const lines = await linesOf(join(sessionsDir, present(file, "the session file")));
        // What a rebuild reads (SPEC-0003, "对话记录"): an error result without the extension's details.
        expect(lines.find((line) => entryKind(line) === "message toolResult")).toMatchObject({
          message: { toolCallId: "call-1", isError: true, details: {} },
        });
        // The abort cut the run before a second request: the next one is the user's.
        const [, second] = await contexts();
        expect(seen(present(second, "the request after the abort").messages)).toStrictEqual([
          "user: go",
          "assistant: call probe_ask",
          "toolResult: aborted",
          "user: next",
        ]);
      },
    );
  });
});
