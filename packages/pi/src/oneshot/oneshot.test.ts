import { type ScriptedPiBehavior, createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import fs, { readFile, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiDeps } from "../deps";
import type { ProcessSystem } from "../process/kill-tree";
import { ONESHOT_TIMEOUT_MS, OneShotError, runOneShot } from "./oneshot";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
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
    readonly maxOutputBytes?: number;
    readonly isolateTranslation?: boolean;
    readonly beforeRun?: () => void;
    readonly onStarted?: (seen: { readonly argv: readonly string[]; readonly pid: number }) => Promise<void>;
  } = {},
) {
  const dir = await createTempDir("oneshot");
  cleanups.push(dir.cleanup);
  const recordTo = join(dir.path, "seen.json");
  const releasePath = join(dir.path, "release");
  const fake = await writeScriptedPi(dir.path, {
    print: { ...print, recordTo, ...(options.onStarted === undefined ? {} : { waitFor: releasePath }) },
  });
  const logs: { readonly level: string; readonly fields: object; readonly message: string }[] = [];
  const record =
    (level: string) =>
    (fields: object, message: string): void => {
      logs.push({ level, fields, message });
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
    log: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
    nextRequestId: () => "unused",
    env: { PATH: process.env["PATH"] ?? "", FROM_HOST: "yes" },
  };
  options.beforeRun?.();
  const running = runOneShot(
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
  let probeError: { readonly error: unknown } | undefined;
  if (options.onStarted !== undefined) {
    try {
      const recorded = await vi.waitFor(
        async () =>
          JSON.parse(await readFile(recordTo, "utf8")) as { readonly argv: readonly string[]; readonly pid: number },
      );
      await options.onStarted(recorded);
    } catch (error) {
      probeError = { error };
    }
    await writeFile(releasePath, "");
  }
  const outcome = await running;
  if (probeError !== undefined) throw probeError.error;
  /** What the fake pi was started with, once it read its stdin. */
  const seen = async (): Promise<unknown> => JSON.parse(await readFile(recordTo, "utf8"));
  return { outcome, seen, logs, open, timers: timers.size, dir: await realpath(dir.path) };
}

/**
 * Gives guard preparation its own real temporary root.
 * @remarks No filesystem adapter is added to production to inspect owned-file cleanup.
 * @sideEffects Creates a directory, removed at test cleanup.
 * @returns Its path.
 */
async function guardRoot(): Promise<string> {
  const directory = await createTempDir("oneshot-guard-root");
  cleanups.push(directory.cleanup);
  return directory.path;
}

/**
 * Directs os.tmpdir to the test's owned root until cleanup.
 * @remarks Node reads TMPDIR on each call; the host's subprocess environment remains isolated.
 * @sideEffects Changes and later restores this test worker's TMPDIR.
 * @param root - The root, or a regular file when exercising ENOTDIR.
 */
function useGuardRoot(root: string): void {
  const previous = process.env["TMPDIR"];
  process.env["TMPDIR"] = root;
  cleanups.push(async () => {
    if (previous === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previous;
  });
}

/**
 * Inserts a failure or cancellation after the real guard write completes.
 * @remarks Only this external OS boundary is intercepted: production still uses actual mkdir,
 * write and cleanup. It deterministically exercises disk-full and cancellation races without a
 * filesystem abstraction or elapsed-time guesses.
 * @sideEffects Temporarily intercepts the next fs.writeFile; cleanup restores builtin ESM bindings.
 * @param action - What the test triggers at the real write's completion.
 */
function afterGuardWrite(action: (path: string) => Promise<void>): void {
  const original = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
    await original(...args);
    const path = args[0];
    if (typeof path !== "string") throw new Error("the guard must be written through its owned path");
    await action(path);
  });
  syncBuiltinESMExports();
}

/**
 * Lists only the owned translation guard directories.
 * @remarks Other fixture files are not part of the guard cleanup contract.
 * @sideEffects Reads the owned root directory.
 * @param root - The test's private temporary directory.
 * @returns Guard directory names.
 */
async function guardsIn(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.startsWith("atrium-translation-guard-"));
}

describe("runOneShot", () => {
  it("isolates translation resources with a private exact-model guard and removes it after the process closes", async () => {
    const root = await guardRoot();
    const { outcome, seen, open, timers } = await oneShot(
      { lines: [reply("译文")] },
      {
        isolateTranslation: true,
        beforeRun: () => useGuardRoot(root),
        onStarted: async ({ argv }) => {
          const guard = present(argv[argv.indexOf("--extension") + 1], "guard extension");
          const source = await readFile(guard, "utf8");
          expect(source).toContain("ctx.modelRegistry.find(expected.providerId, expected.modelId)");
          expect(source).toContain("ctx.abort()");
          expect(source).toContain('{"providerId":"anthropic","modelId":"claude-haiku-4-5"}');
          expect([(await stat(guard)).mode & 0o777, (await stat(dirname(guard))).mode & 0o777]).toStrictEqual([
            0o600, 0o700,
          ]);
        },
      },
    );
    const { argv } = (await seen()) as { readonly argv: readonly string[] };
    expect(outcome).toStrictEqual({ text: "译文" });
    expect(argv).toContain("--no-skills");
    expect(argv).toContain("--no-prompt-templates");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe("");
    const guard = present(argv[argv.indexOf("--extension") + 1], "guard extension");
    expect(guard).toMatch(/atrium-translation-guard-/);
    expect([existsSync(guard), existsSync(dirname(guard))]).toStrictEqual([false, false]);
    expect([open.get("pi-oneshot"), timers]).toStrictEqual([0, 0]);
  });

  it("reports guard-directory creation failure without starting a process or retaining a guard", async () => {
    const root = await guardRoot();
    const file = join(root, "not-a-directory");
    await writeFile(file, "occupied");
    const { outcome, open, timers } = await oneShot(
      { lines: [reply("unexpected")] },
      { isolateTranslation: true, beforeRun: () => useGuardRoot(file) },
    );
    expect(outcome).toStrictEqual({ error: new OneShotError("exited") });
    expect([open.size, timers, await guardsIn(root)]).toStrictEqual([0, 0, []]);
  });

  it("cleans a partially written guard when its write fails", async () => {
    const root = await guardRoot();
    const { outcome, open, timers } = await oneShot(
      { lines: [reply("unexpected")] },
      {
        isolateTranslation: true,
        beforeRun: () => {
          useGuardRoot(root);
          afterGuardWrite(async () => {
            throw new Error("private disk failure");
          });
        },
      },
    );
    expect(outcome).toStrictEqual({ error: new OneShotError("exited") });
    expect([open.size, timers, await guardsIn(root)]).toStrictEqual([0, 0, []]);
  });

  it("cancels after writing the guard but before starting pi and removes the guard", async () => {
    const root = await guardRoot();
    const controller = new AbortController();
    const { outcome, open, timers } = await oneShot(
      { lines: [reply("unexpected")] },
      {
        isolateTranslation: true,
        signal: controller.signal,
        beforeRun: () => {
          useGuardRoot(root);
          afterGuardWrite(async () => {
            controller.abort();
          });
        },
      },
    );
    expect(outcome).toStrictEqual({ error: new OneShotError("aborted") });
    expect([open.size, timers, await guardsIn(root)]).toStrictEqual([0, 0, []]);
  });

  it("reports a failed guard cleanup during preparation cancellation", async () => {
    const root = await guardRoot();
    const controller = new AbortController();
    const { outcome, open, timers } = await oneShot(
      { lines: [reply("unexpected")] },
      {
        isolateTranslation: true,
        signal: controller.signal,
        beforeRun: () => {
          useGuardRoot(root);
          afterGuardWrite(async () => {
            vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup denied"));
            syncBuiltinESMExports();
            controller.abort();
          });
        },
      },
    );
    expect(outcome).toStrictEqual({ error: new OneShotError("exited") });
    expect([open.size, timers, (await guardsIn(root)).length]).toStrictEqual([0, 0, 1]);
  });

  it("tolerates an already removed guard when cancelled during preparation", async () => {
    const root = await guardRoot();
    const controller = new AbortController();
    const { outcome, open, timers } = await oneShot(
      { lines: [reply("unexpected")] },
      {
        isolateTranslation: true,
        signal: controller.signal,
        beforeRun: () => {
          useGuardRoot(root);
          afterGuardWrite(async (path) => {
            await rm(dirname(path), { recursive: true });
            controller.abort();
          });
        },
      },
    );
    expect(outcome).toStrictEqual({ error: new OneShotError("aborted") });
    expect([open.size, timers, await guardsIn(root)]).toStrictEqual([0, 0, []]);
  });

  it.each([false, true])(
    "cleans a synchronous spawn failure with translation isolation %s",
    async (isolateTranslation) => {
      const root = await guardRoot();
      const { outcome, open, timers } = await oneShot(
        {},
        { piPath: "invalid\u0000pi", isolateTranslation, beforeRun: () => useGuardRoot(root) },
      );
      expect(outcome).toStrictEqual({ error: new OneShotError("exited") });
      expect([open.size, timers, await guardsIn(root)]).toStrictEqual([0, 0, []]);
    },
  );

  it("reports post-process cleanup failure and still releases process and timer counts", async () => {
    const root = await guardRoot();
    const { outcome, open, timers } = await oneShot(
      { lines: [reply("unexpected")] },
      {
        isolateTranslation: true,
        beforeRun: () => useGuardRoot(root),
        onStarted: async () => {
          vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup denied"));
          syncBuiltinESMExports();
        },
      },
    );
    expect(outcome).toStrictEqual({ error: new OneShotError("exited") });
    expect([open.get("pi-oneshot"), timers, (await guardsIn(root)).length]).toStrictEqual([0, 0, 1]);
  });

  it("tolerates an already removed guard after the process closes", async () => {
    const root = await guardRoot();
    const { outcome, open, timers } = await oneShot(
      { lines: [reply("Title")] },
      {
        isolateTranslation: true,
        beforeRun: () => useGuardRoot(root),
        onStarted: async ({ argv }) => {
          const path = present(argv[argv.indexOf("--extension") + 1], "guard extension");
          await rm(dirname(path), { recursive: true });
        },
      },
    );
    expect(outcome).toStrictEqual({ text: "Title" });
    expect([open.get("pi-oneshot"), timers, await guardsIn(root)]).toStrictEqual([0, 0, []]);
  });

  it("accepts a long valid escaped JSON record whose reply is within the output limit", async () => {
    const text = "\u0000".repeat(20_000);
    const { outcome, open, timers } = await oneShot({ lines: [reply(text)] }, { maxOutputBytes: 20_000 });
    expect(outcome).toStrictEqual({ text });
    expect([open.get("pi-oneshot"), timers]).toStrictEqual([0, 0]);
  });

  it("rejects an unfinished record exactly at the JSON safety boundary", async () => {
    const { outcome, open, timers } = await oneShot(
      { unterminated: "x".repeat(16_480), hang: true },
      { maxOutputBytes: 16, timeoutMs: 300 },
    );
    expect(outcome).toStrictEqual({ error: new OneShotError("too_large") });
    expect([open.get("pi-oneshot"), timers]).toStrictEqual([0, 0]);
  });

  it("starts one process-tree kill when a single stdout chunk contains several oversized replies", async () => {
    let lists = 0;
    const processSystem: ProcessSystem = {
      listProcesses: async () => {
        lists += 1;
        return "";
      },
      kill: (target) => process.kill(target, "SIGKILL"),
      ownPid: process.pid,
    };
    // One sub-PIPE_BUF write reaches the pipe atomically, exercising callbacks from the same chunk.
    const records = `${JSON.stringify(reply("oversized-one"))}\n${JSON.stringify(reply("oversized-two"))}\n`;
    const { outcome, open, timers } = await oneShot(
      { unterminated: records, hang: true },
      { maxOutputBytes: 8, processSystem },
    );
    expect(outcome).toStrictEqual({ error: new OneShotError("too_large") });
    expect([lists, open.get("pi-oneshot"), timers]).toStrictEqual([1, 0, 0]);
  });

  it("skips non-reply records with an output limit instead of dereferencing an absent reply", async () => {
    const { outcome, open, timers } = await oneShot(
      { lines: [{ type: "session" }, { type: "message_end", message: { role: "user" } }, reply("Title")] },
      { maxOutputBytes: 64 },
    );
    expect(outcome).toStrictEqual({ text: "Title" });
    expect([open.get("pi-oneshot"), timers]).toStrictEqual([0, 0]);
  });

  it("bounds a standalone reply in UTF-8 bytes and releases the process and timers", async () => {
    const { outcome, open, timers } = await oneShot({ lines: [reply("中文译文")] }, { maxOutputBytes: 11 });
    expect(outcome).toStrictEqual({ error: new OneShotError("too_large") });
    expect([open.get("pi-oneshot"), timers]).toStrictEqual([0, 0]);
  });

  it("allows a reply exactly at the UTF-8 byte limit", async () => {
    const { outcome, open, timers } = await oneShot({ lines: [reply("中文译文")] }, { maxOutputBytes: 12 });
    expect(outcome).toStrictEqual({ text: "中文译文" });
    expect([open.get("pi-oneshot"), timers]).toStrictEqual([0, 0]);
  });

  it("bounds an unfinished JSON record even when pi never sends a complete reply", async () => {
    const { outcome, open, timers } = await oneShot(
      { unterminated: "x".repeat(17_000), hang: true },
      { maxOutputBytes: 1 },
    );
    expect(outcome).toStrictEqual({ error: new OneShotError("too_large") });
    expect([open.get("pi-oneshot"), timers]).toStrictEqual([0, 0]);
  });

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
      { level: "warn", fields: { reason }, message: "one-shot pi failed" },
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

  it("kills pi when aborted, and logs that at info level, since the caller asked for it", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const { outcome, seen, open, logs } = await oneShot({ hang: true }, { signal: controller.signal });

    expect(outcome).toStrictEqual({ error: new OneShotError("aborted") });
    expect(logs.filter((log) => log.message === "one-shot pi failed")).toStrictEqual([
      { level: "info", fields: { reason: "aborted" }, message: "one-shot pi failed" },
    ]);
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
