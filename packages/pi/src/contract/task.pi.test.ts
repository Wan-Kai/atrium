import { createTempDir, present } from "@atrium/testkit";
import type { FauxContext } from "@atrium/testkit";
import { existsSync } from "node:fs";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { runScenario } from "../../test/contract";
import {
  TASK_PROBE_BLOCK_ENV,
  TASK_PROBE_BLOCK_REASON,
  TASK_PROBE_LOG_ENV,
  TASK_PROBE_MESSAGE,
  TASK_PROBE_WAKE,
  type TaskProbeRecord,
} from "../../test/task-probe-extension";
import type { PiEvent } from "../process/pi-process";

/** The test-only extension that stands in for what SPEC-0006's task runner will register. */
const PROBE = fileURLToPath(new URL("../../test/task-probe-extension.ts", import.meta.url));

/**
 * Makes a file for the probe's log, outside the scenario's directory, and removes it afterwards.
 *
 * @remarks
 * The probe writes inside pi's process, so the test reads the log back; it sits apart from the
 * working directory so it never mixes with the files a scenario asserts on.
 *
 * @sideEffects Creates a temporary directory; deletes it when the test finishes.
 * @returns The log file's path.
 */
async function probeLog(): Promise<string> {
  const dir = await createTempDir("task-probe-log");
  onTestFinished(dir.cleanup);
  return join(dir.path, "probe.jsonl");
}

/**
 * What the probe logged of one kind, in order.
 *
 * @remarks
 * A missing file means the probe logged nothing.
 *
 * @sideEffects Reads the file.
 * @param file - The log file.
 * @param kind - Which records to return.
 * @returns The records.
 */
async function readProbeLog<K extends TaskProbeRecord["kind"]>(
  file: string,
  kind: K,
): Promise<Extract<TaskProbeRecord, { kind: K }>[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  const records = text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as TaskProbeRecord);
  return records.filter((record): record is Extract<TaskProbeRecord, { kind: K }> => record.kind === kind);
}

/**
 * The text of a file, or nothing if it is not there.
 *
 * @remarks
 * Where a file landed is what the path tests assert on.
 *
 * @sideEffects Reads the file.
 * @param path - The file.
 * @returns Its text, or `undefined`.
 */
async function textAt(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

/**
 * The event types of a run that mark where it stopped, in the order pi printed them.
 *
 * @remarks
 * Enough to show whether pi asked the model again after a tool batch and where `agent_settled` fell.
 *
 * @sideEffects none
 * @param events - pi's events.
 * @returns The types, with a toolResult message end as `toolResult`.
 */
function milestones(events: readonly PiEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === "message_end") return event.message.role === "toolResult" ? ["toolResult"] : [];
    return ["turn_start", "tool_execution_end", "turn_end", "agent_start", "agent_end", "agent_settled"].includes(
      event.type,
    )
      ? [event.type]
      : [];
  });
}

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
 * Whether an event is the end of the probe's custom message.
 *
 * @remarks
 * How `sendMessage` shows in pi's events: `role: "custom"`.
 *
 * @sideEffects none
 * @param event - pi's event.
 * @returns Whether it is.
 */
function isProbeMessage(event: PiEvent): boolean {
  return event.type === "message_end" && event.message.role === "custom";
}

/**
 * Waits long enough for pi to have started a run, had it been going to.
 *
 * @remarks
 * The only way to show something did not happen; the wait is far longer than pi takes to start a
 * run from a queued message, and the callers also assert on pi's state, not on the wait alone.
 *
 * @sideEffects Waits.
 */
async function quietPeriod(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500));
}

/** One model reply that calls the given tools in one batch. */
const batch = (...names: string[]) => ({
  blocks: names.map((name, index) => ({
    type: "toolCall" as const,
    id: `call-${String(index + 1)}`,
    name,
    arguments: {},
  })),
});

/** A model reply that ends the run with some text. */
const said = (text: string) => ({ blocks: [{ type: "text" as const, text }] });

describe("pi contract: terminate (SPEC-0006, node_done)", () => {
  it("terminate-alone: a batch of only a terminating tool ends the run without another request; agent_settled follows the turn end", async () => {
    await runScenario(
      {
        scenario: "task-terminate-alone",
        unrecorded: true,
        extensions: [PROBE],
        script: { replies: [batch("task_done"), said("must not be requested")] },
      },
      async ({ pi, events, until, contexts }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await quietPeriod();

        expect(milestones(events)).toStrictEqual([
          "agent_start",
          "turn_start",
          "tool_execution_end",
          "toolResult",
          "turn_end",
          "agent_end",
          "agent_settled",
        ]);
        expect(await contexts()).toHaveLength(1);
        expect(await pi.request({ type: "get_state" })).toMatchObject({ isStreaming: false });
      },
    );
  });

  it("terminate-all: several terminating tools in one batch also end the run", async () => {
    await runScenario(
      {
        scenario: "task-terminate-all",
        unrecorded: true,
        extensions: [PROBE],
        script: { replies: [batch("task_done", "task_done"), said("must not be requested")] },
      },
      async ({ pi, events, until, contexts }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");
        await quietPeriod();

        expect(events.filter((event) => event.type === "turn_start")).toHaveLength(1);
        expect(await contexts()).toHaveLength(1);
      },
    );
  });

  it("terminate-mixed: a terminating tool batched with an ordinary one does not stop the run; the model is asked again", async () => {
    await runScenario(
      {
        scenario: "task-terminate-mixed",
        unrecorded: true,
        extensions: [PROBE],
        script: { replies: [batch("task_done", "task_note"), said("after both")] },
      },
      async ({ pi, events, until, contexts }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");

        expect(events.filter((event) => event.type === "turn_start")).toHaveLength(2);
        const requests = await contexts();
        expect(requests).toHaveLength(2);
        expect(latestResults(requests[1]).map((result) => result.text)).toStrictEqual(["done", "noted"]);
      },
    );
  });
});

describe("pi contract: waking an idle pi (SPEC-0006, TaskRunner)", () => {
  it("wake-trigger-turn: sendMessage with triggerTurn while idle starts a run on that message", async () => {
    await runScenario(
      {
        scenario: "task-wake-trigger",
        unrecorded: true,
        extensions: [PROBE],
        script: { replies: [said("seen")] },
      },
      async ({ pi, events, until, contexts }) => {
        await pi.request({ type: "prompt", message: `/${TASK_PROBE_WAKE} trigger` });
        await until((event) => event.type === "agent_settled");

        expect(events.filter((event) => event.type === "agent_start")).toHaveLength(1);
        const delivered = await until(isProbeMessage);
        expect(delivered).toMatchObject({ message: { customType: TASK_PROBE_MESSAGE, content: "woken" } });
        const [first, ...rest] = await contexts();
        expect(rest).toHaveLength(0);
        expect(JSON.stringify(present(first, "the request").messages)).toContain("woken");
      },
    );
  });

  it("wake-quiet: sendMessage without triggerTurn while idle only records the message; no run starts", async () => {
    await runScenario(
      {
        scenario: "task-wake-quiet",
        unrecorded: true,
        extensions: [PROBE],
        script: { replies: [said("must not be requested")] },
      },
      async ({ pi, events, until, contexts }) => {
        await pi.request({ type: "prompt", message: `/${TASK_PROBE_WAKE} quiet` });
        await until(isProbeMessage);
        await quietPeriod();

        expect(events.filter((event) => event.type === "agent_start")).toHaveLength(0);
        expect(await contexts()).toHaveLength(0);
      },
    );
  });

  it("wake-follow-up: the RPC follow_up while idle is queued and starts no run", async () => {
    await runScenario(
      {
        scenario: "task-wake-follow-up",
        unrecorded: true,
        extensions: [PROBE],
        script: { replies: [said("must not be requested")] },
      },
      async ({ pi, events, contexts }) => {
        const answer = await pi.request({ type: "follow_up", message: "later" });
        await quietPeriod();

        expect(answer).toStrictEqual({ disposition: "queued" });
        expect(await pi.request({ type: "get_state" })).toMatchObject({ isStreaming: false, pendingMessageCount: 1 });
        expect(events.filter((event) => event.type === "agent_start")).toHaveLength(0);
        expect(await contexts()).toHaveLength(0);
      },
    );
  });
});

describe("pi contract: executionMode sequential (SPEC-0006, TaskRunner)", () => {
  it("sequential: a batch with a sequential tool runs its calls one after another, a plain batch overlaps them", async () => {
    const log = await probeLog();
    await runScenario(
      {
        scenario: "task-sequential",
        unrecorded: true,
        extensions: [PROBE],
        env: { [TASK_PROBE_LOG_ENV]: log },
        script: {
          replies: [
            batch("seq_a", "seq_b"),
            batch("par_a", "par_b"),
            batch("par_a", "seq_b"),
            batch("seq_a", "par_b"),
            said("done"),
          ],
        },
      },
      async ({ pi, until }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");

        const tools = await readProbeLog(log, "tool");
        const order = (batchIndex: number) =>
          tools.slice(batchIndex * 4, batchIndex * 4 + 4).map((record) => `${record.name} ${record.phase}`);
        expect(order(0)).toStrictEqual(["seq_a start", "seq_a end", "seq_b start", "seq_b end"]);
        expect(order(1)).toStrictEqual(["par_a start", "par_b start", "par_a end", "par_b end"]);
        // One sequential tool makes the whole batch sequential, wherever it stands in it.
        expect(order(2)).toStrictEqual(["par_a start", "par_a end", "seq_b start", "seq_b end"]);
        expect(order(3)).toStrictEqual(["seq_a start", "seq_a end", "par_b start", "par_b end"]);
      },
    );
  });
});

describe("pi contract: write's path resolution (SPEC-0006, 路径隔离)", () => {
  it("resolve-to-cwd: write strips a leading @, expands ~ to HOME, reads file:// URLs and turns Unicode spaces into plain ones", async () => {
    await runScenario(
      {
        scenario: "task-resolve-to-cwd",
        unrecorded: true,
        home: "home",
        script: (cwd) => ({
          replies: [
            {
              blocks: [
                ["@at.txt", "at"],
                ["~/tilde.txt", "tilde"],
                [`file://${cwd}/url.txt`, "url"],
                ["no\u00A0break.txt", "nbsp"],
                ["narrow\u202Fspace.txt", "nnbsp"],
              ].map(([path, content], index) => ({
                type: "toolCall" as const,
                id: `call-${String(index + 1)}`,
                name: "write",
                arguments: { path: present(path, "path"), content: present(content, "content") },
              })),
            },
            said("written"),
          ],
        }),
      },
      async ({ pi, until, cwd, contexts }) => {
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");

        expect(await textAt(join(cwd, "at.txt"))).toBe("at");
        expect(await textAt(join(cwd, "home", "tilde.txt"))).toBe("tilde");
        expect(await textAt(join(cwd, "url.txt"))).toBe("url");
        expect(await textAt(join(cwd, "no break.txt"))).toBe("nbsp");
        expect(await textAt(join(cwd, "narrow space.txt"))).toBe("nnbsp");
        // None of them was taken literally.
        expect(existsSync(join(cwd, "@at.txt"))).toBe(false);
        expect(existsSync(join(cwd, "~"))).toBe(false);
        expect(existsSync(join(cwd, "no\u00A0break.txt"))).toBe(false);
        expect(existsSync(join(cwd, "narrow\u202Fspace.txt"))).toBe(false);
        const [, second] = await contexts();
        expect(latestResults(second).every((result) => !result.isError)).toBe(true);
      },
    );
  });
});

describe("pi contract: the tool_call hook as a path guard (SPEC-0006, 路径隔离)", () => {
  it("tool-call-hook: blocks write and edit before they touch a missing file, a symlinked directory or .git/config, and sees the path as the model wrote it", async () => {
    const log = await probeLog();
    const outside = await createTempDir("task-outside");
    onTestFinished(outside.cleanup);
    const calls: [string, Record<string, string | { oldText: string; newText: string }[]>][] = [
      ["write", { path: "new.txt", content: "x" }],
      ["edit", { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }],
      ["write", { path: "link/escape.txt", content: "x" }],
      ["edit", { path: "link/existing.txt", edits: [{ oldText: "outside", newText: "changed" }] }],
      ["write", { path: ".git/config", content: "[evil]\n" }],
      ["edit", { path: ".git/config", edits: [{ oldText: "[core]", newText: "[evil]" }] }],
      ["write", { path: "@at.txt", content: "x" }],
      ["write", { path: "~/tilde.txt", content: "x" }],
      ["write", { path: "no\u00A0break.txt", content: "x" }],
    ];
    await runScenario(
      {
        scenario: "task-tool-call-hook",
        unrecorded: true,
        home: "home",
        extensions: [PROBE],
        env: { [TASK_PROBE_LOG_ENV]: log, [TASK_PROBE_BLOCK_ENV]: "write,edit" },
        files: { ".git/config": "[core]\n" },
        script: {
          replies: [
            {
              blocks: calls.map(([name, args], index) => ({
                type: "toolCall" as const,
                id: `call-${String(index + 1)}`,
                name,
                arguments: args,
              })),
            },
            said("refused"),
          ],
        },
      },
      async ({ pi, until, cwd, contexts }) => {
        await writeFile(join(outside.path, "existing.txt"), "outside");
        await symlink(outside.path, join(cwd, "link"), "dir");
        await pi.request({ type: "prompt", message: "go" });
        await until((event) => event.type === "agent_settled");

        const hooks = await readProbeLog(log, "hook");
        expect(hooks.map((record) => [record.name, Reflect.get(record.input as object, "path")])).toStrictEqual(
          calls.map(([name, args]) => [name, args["path"]]),
        );
        expect(existsSync(join(cwd, "new.txt"))).toBe(false);
        expect(existsSync(join(outside.path, "escape.txt"))).toBe(false);
        expect(await readFile(join(outside.path, "existing.txt"), "utf8")).toBe("outside");
        expect(await readFile(join(cwd, ".git", "config"), "utf8")).toBe("[core]\n");
        for (const stray of ["at.txt", "@at.txt", "no break.txt", join("home", "tilde.txt")]) {
          expect(existsSync(join(cwd, stray))).toBe(false);
        }
        const [, second] = await contexts();
        const results = latestResults(second);
        expect(results).toHaveLength(calls.length);
        for (const result of results) {
          expect(result.isError).toBe(true);
          expect(result.text).toContain(TASK_PROBE_BLOCK_REASON);
        }
      },
    );
  });
});
