import { type ScriptedPiBehavior, createTempDir, writeScriptedPi } from "@atrium/testkit";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PiDeps } from "../deps";
import type { ProcessSystem } from "../process/kill-tree";
import { ONESHOT_TIMEOUT_MS, OneShotError, runOneShot } from "./oneshot";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * An assistant message as pi's json mode ends it.
 *
 * @remarks
 * Only the fields the one-shot call reads, plus a thinking part it must skip.
 *
 * @sideEffects none
 * @param text - The reply's text, split into parts at `|`.
 * @param stopReason - How the reply ended.
 * @returns The `message_end` record.
 */
function reply(text: string, stopReason = "stop"): object {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        ...text.split("|").map((part) => ({ type: "text", text: part })),
      ],
      stopReason,
      ...(stopReason === "error" ? { errorMessage: "No API key found for anthropic" } : {}),
    },
  };
}

/**
 * Whether a process is still alive.
 *
 * @remarks
 * Signal 0 checks without signalling.
 *
 * @sideEffects none
 * @param pid - The process.
 * @returns Whether it exists.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a one-shot call against a fake pi that behaves as told in `-p` mode.
 *
 * @remarks
 * The fake pi writes what it was started with to a file, since the call keeps pi's stderr to
 * itself; the logs and open resources are recorded.
 *
 * @sideEffects Creates a temporary directory, removed after the test; runs the fake pi.
 * @param print - What the fake pi does in `-p` mode.
 * @param options - The deadline, an abort signal, a process system for killing, another pi path
 * and other content.
 * @returns The outcome, what pi saw, the logs, the open resources, how many timers are still set
 * and the directory.
 */
async function oneShot(
  print: NonNullable<ScriptedPiBehavior["print"]>,
  options: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly processSystem?: ProcessSystem;
    readonly piPath?: string;
    readonly input?: string;
  } = {},
) {
  const dir = await createTempDir("oneshot");
  cleanups.push(dir.cleanup);
  const recordTo = join(dir.path, "seen.json");
  const fake = await writeScriptedPi(dir.path, { print: { ...print, recordTo } });
  const logs: { readonly fields: object; readonly message: string }[] = [];
  const record = (fields: object, message: string): void => {
    logs.push({ fields, message });
  };
  const open = new Map<string, number>();
  const timers = new Set<NodeJS.Timeout>();
  const deps: PiDeps = {
    clock: {
      now: () => Date.now(),
      setTimeout(callback, ms) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          callback();
        }, ms);
        timers.add(timer);
        return () => {
          timers.delete(timer);
          clearTimeout(timer);
        };
      },
    },
    track(kind) {
      open.set(kind, (open.get(kind) ?? 0) + 1);
      return () => open.set(kind, (open.get(kind) ?? 0) - 1);
    },
    log: { debug: record, info: record, warn: record, error: record },
    nextRequestId: () => "unused",
    env: { PATH: process.env["PATH"] ?? "", FROM_HOST: "yes" },
  };
  const outcome = await runOneShot(
    {
      piPath: options.piPath ?? fake.piPath,
      cwd: dir.path,
      env: fake.env,
      model: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
      systemPrompt: "Name it.",
      input: options.input ?? "User: fix the login bug\n\nAssistant: Fixed.",
    },
    deps,
    options,
  ).then(
    (text) => ({ text }),
    (error: unknown) => ({ error }),
  );
  /** What the fake pi was started with, once it read its stdin. */
  const seen = async (): Promise<unknown> => JSON.parse(await readFile(recordTo, "utf8"));
  return { outcome, seen, logs, open, timers: timers.size, dir: await realpath(dir.path) };
}

describe("runOneShot", () => {
  it("runs pi once in print mode without a session or tools, the content on stdin, and answers its last reply's text", async () => {
    const { outcome, seen, open, timers, dir } = await oneShot({
      lines: [{ type: "session" }, reply("draft"), { type: "agent_end" }, reply("Login|fix")],
    });

    expect(outcome).toStrictEqual({ text: "Login\nfix" });
    expect(await seen()).toMatchObject({
      argv: [
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--no-tools",
        "--no-context-files",
        "--thinking",
        "off",
        "--model",
        "anthropic/claude-haiku-4-5",
        "--system-prompt",
        "Name it.",
      ],
      cwd: dir,
      stdin: "User: fix the login bug\n\nAssistant: Fixed.",
    });
    expect([open.get("pi-oneshot"), timers]).toStrictEqual([0, 0]);
  });

  it.each([
    ["the reply failed", { lines: [reply("", "error")] }, "model_failed"],
    ["the reply was aborted", { lines: [reply("half", "aborted")] }, "model_failed"],
    ["pi exited with an error", { lines: [reply("Login fix")], exitCode: 1 }, "exited"],
    [
      "pi printed no reply",
      { lines: [{ type: "session" }, { type: "message_end", message: { role: "user" } }] },
      "no_reply",
    ],
    ["the reply had no text", { lines: [reply("   ")] }, "no_reply"],
    [
      "the reply had no content",
      { lines: [{ type: "message_end", message: { role: "assistant", stopReason: "stop" } }] },
      "no_reply",
    ],
  ] as const)("fails when %s, and logs only why", async (_, print, reason) => {
    const { outcome, logs, open } = await oneShot(print);

    expect(outcome).toStrictEqual({ error: new OneShotError(reason) });
    expect(logs.filter((log) => log.message === "one-shot pi failed")).toStrictEqual([
      { fields: { reason }, message: "one-shot pi failed" },
    ]);
    expect(open.get("pi-oneshot")).toBe(0);
  });

  it("skips lines that are not JSON records, and records that do not end an assistant message", async () => {
    const { outcome } = await oneShot({
      lines: [
        "not json",
        "",
        "42",
        "null",
        { type: "message_end" },
        { type: "message_end", message: null },
        { type: "message_end", message: "Other" },
        reply("Title"),
        { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Other" }] } },
        { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Other" }] } },
      ],
    });

    expect(outcome).toStrictEqual({ text: "Title" });
  });

  it("reads a last line without a line break", async () => {
    const { outcome } = await oneShot({ lines: [reply("draft")], unterminated: JSON.stringify(reply("Title")) });

    expect(outcome).toStrictEqual({ text: "Title" });
  });

  it("reads and drops what pi writes to stderr, however much", async () => {
    const { outcome } = await oneShot({ stderrBytes: 1 << 20, lines: [reply("Title")] }, { timeoutMs: 3_000 });

    expect(outcome).toStrictEqual({ text: "Title" });
  });

  it("fails as exited when pi exits without reading its content", async () => {
    const { outcome } = await oneShot({ ignoreStdin: true, exitCode: 1 }, { input: "x".repeat(1 << 20) });

    expect(outcome).toStrictEqual({ error: new OneShotError("exited") });
  });

  it("answers once pi exited, even while a process it started keeps its pipes open", async () => {
    const { outcome, seen } = await oneShot({ holdPipes: true, lines: [reply("Title")] }, { timeoutMs: 3_000 });
    const { grandchild } = (await seen()) as { grandchild: number };
    process.kill(grandchild, "SIGKILL");

    expect(outcome).toStrictEqual({ text: "Title" });
  });

  it("leaves the signal alone once pi is done", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const processSystem: ProcessSystem = {
      listProcesses: async () => {
        calls.push("list");
        return "";
      },
      kill: () => calls.push("kill"),
      ownPid: process.pid,
    };

    const { outcome } = await oneShot({ lines: [reply("Title")] }, { signal: controller.signal, processSystem });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect([outcome, calls]).toStrictEqual([{ text: "Title" }, []]);
  });

  it("fails as exited when pi cannot be started", async () => {
    const { outcome, open } = await oneShot({}, { piPath: "/nonexistent/pi" });

    expect(outcome).toStrictEqual({ error: new OneShotError("exited") });
    expect(open.get("pi-oneshot")).toBe(0);
  });

  it("kills pi when it takes longer than the deadline, sixty seconds by default", async () => {
    const { outcome, seen, open } = await oneShot({ hang: true }, { timeoutMs: 300 });

    expect(outcome).toStrictEqual({ error: new OneShotError("timed_out") });
    const { pid } = (await seen()) as { pid: number };
    expect(alive(pid)).toBe(false);
    expect(open.get("pi-oneshot")).toBe(0);
    expect(ONESHOT_TIMEOUT_MS).toBe(60_000);
  });

  it("kills pi alone when its process tree cannot be read", async () => {
    const processSystem: ProcessSystem = {
      listProcesses: () => Promise.reject(new Error("ps failed")),
      kill: () => undefined,
      ownPid: process.pid,
    };

    const { outcome, seen, open } = await oneShot({ hang: true }, { timeoutMs: 300, processSystem });

    expect(outcome).toStrictEqual({ error: new OneShotError("timed_out") });
    const { pid } = (await seen()) as { pid: number };
    expect(alive(pid)).toBe(false);
    expect(open.get("pi-oneshot")).toBe(0);
  });

  it("kills pi when aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const { outcome, seen, open } = await oneShot({ hang: true }, { signal: controller.signal });

    expect(outcome).toStrictEqual({ error: new OneShotError("aborted") });
    const { pid } = (await seen()) as { pid: number };
    expect(alive(pid)).toBe(false);
    expect(open.get("pi-oneshot")).toBe(0);
  });

  it("does not start pi when aborted before", async () => {
    const controller = new AbortController();
    controller.abort();

    const { outcome, open } = await oneShot({ lines: [reply("Title")] }, { signal: controller.signal });

    expect(outcome).toStrictEqual({ error: new OneShotError("aborted") });
    expect(open.get("pi-oneshot")).toBeUndefined();
  });
});

describe("OneShotError", () => {
  it("names itself and carries the reason", () => {
    const error = new OneShotError("timed_out");

    expect([error.name, error.reason, error.message]).toStrictEqual(["OneShotError", "timed_out", "timed_out"]);
  });
});
