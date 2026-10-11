import { createTempDir } from "@atrium/testkit";
import { realpath } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemClock } from "../platform/clock";
import { ResourceTracker } from "../platform/resources";
import { type JobCommand, type JobEnd, runJob } from "./install-job";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * Runs a shell script as a job, collecting what it writes.
 *
 * @remarks
 * The script runs in a temporary folder with only the system's directories on PATH.
 *
 * @sideEffects Creates a temporary directory, removed after the test; runs `/bin/sh`.
 * @param script - The script for `sh -c`.
 * @param options - The signal, how long cancelling waits before forcing, and other command fields.
 * @returns How the job ended, its output, its folder and the open processes.
 */
async function sh(
  script: string,
  options: { signal?: AbortSignal; graceMs?: number; command?: Partial<JobCommand> } = {},
): Promise<{ end: Promise<JobEnd>; output: string[]; dir: string; open: () => number }> {
  const temp = await createTempDir("install-job");
  cleanups.push(temp.cleanup);
  const dir = await realpath(temp.path);
  const output: string[] = [];
  const resources = new ResourceTracker();
  const end = runJob(
    {
      file: "/bin/sh",
      args: ["-c", script],
      input: null,
      cwd: dir,
      env: { PATH: "/usr/bin:/bin" },
      ...options.command,
    },
    {
      signal: options.signal ?? new AbortController().signal,
      onOutput: (text) => output.push(text),
      clock: systemClock,
      resources,
      graceMs: options.graceMs ?? 3000,
    },
  );
  return { end, output, dir, open: () => resources.snapshot()["install.process"] ?? 0 };
}

/**
 * Whether a process is still there.
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

describe("runJob", () => {
  it("runs the command in the folder and environment given, passing on all it writes", async () => {
    const { end, output, dir, open } = await sh('echo "$GREETING"; pwd; echo oops >&2; exit 3', {
      command: { env: { PATH: "/usr/bin:/bin", GREETING: "hi" } },
    });

    expect(await end).toStrictEqual({ started: true, exitCode: 3 });
    expect(output.join("").split("\n").toSorted()).toStrictEqual(["", dir, "hi", "oops"]);
    expect(open()).toBe(0);
  });

  it("gives the input on standard input, then closes it", async () => {
    const { end, output } = await sh("", {
      command: { args: ["-s"], input: "echo one\nread rest || echo closed\n" },
    });

    expect(await end).toStrictEqual({ started: true, exitCode: 0 });
    expect(output.join("")).toBe("one\nclosed\n");
  });

  it("closes standard input at once when there is no input", async () => {
    const { end, output } = await sh("read line || echo closed");

    expect(await end).toStrictEqual({ started: true, exitCode: 0 });
    expect(output.join("")).toBe("closed\n");
  });

  it("keeps a character split between two writes whole", async () => {
    const { end, output } = await sh(String.raw`printf '\344\270'; sleep 0.1; printf '\255\n'`);

    expect(await end).toStrictEqual({ started: true, exitCode: 0 });
    expect(output.join("")).toBe("中\n");
  });

  it("ends the process group on cancel, and a command that leaves goes", async () => {
    const stop = new AbortController();
    const { end, output, open } = await sh("sleep 60 & echo $!; wait", { signal: stop.signal, graceMs: 60_000 });
    await vi.waitFor(() => expect(output.join("")).toMatch(/^\d+\n$/));
    const sleeper = Number(output.join(""));

    stop.abort();

    expect(await end).toStrictEqual({ started: true, exitCode: null });
    expect(alive(sleeper)).toBe(false);
    expect(open()).toBe(0);
  });

  it("forces the whole tree to go when it ignores the request to stop", async () => {
    const stop = new AbortController();
    const { end, output, open } = await sh('trap "" TERM; sleep 60 & echo $!; wait; wait', {
      signal: stop.signal,
      graceMs: 200,
    });
    await vi.waitFor(() => expect(output.join("")).toMatch(/^\d+\n$/));
    const sleeper = Number(output.join(""));

    stop.abort();

    expect(await end).toStrictEqual({ started: true, exitCode: null });
    expect(alive(sleeper)).toBe(false);
    expect(open()).toBe(0);
  });

  it("forces the group to go when the process tree cannot be read", async () => {
    // Without `ps` on the host's own PATH, the tree cannot be read.
    vi.stubEnv("PATH", "/nonexistent");
    const stop = new AbortController();
    const { end, output, open } = await sh('trap "" TERM; sleep 60 & echo $!; wait; wait', {
      signal: stop.signal,
      graceMs: 200,
    });
    await vi.waitFor(() => expect(output.join("")).toMatch(/^\d+\n$/));
    const sleeper = Number(output.join(""));

    stop.abort();

    expect(await end).toStrictEqual({ started: true, exitCode: null });
    expect(alive(sleeper)).toBe(false);
    expect(open()).toBe(0);
  });

  it("does not start when the command cannot run", async () => {
    const { end, open } = await sh("", { command: { file: "/nonexistent/brew", args: ["install", "node"] } });

    expect(await end).toStrictEqual({ started: false });
    expect(open()).toBe(0);
  });

  it("does not start once cancelled", async () => {
    const { end, output, open } = await sh("echo ran", { signal: AbortSignal.abort() });

    expect(await end).toStrictEqual({ started: false });
    expect(output).toStrictEqual([]);
    expect(open()).toBe(0);
  });

  it("ends what the command left running in its group once it exits", async () => {
    const { end, output } = await sh("(trap '' TERM; exec sleep 60) & echo $!");

    expect(await end).toStrictEqual({ started: true, exitCode: 0 });
    expect(alive(Number(output.join("")))).toBe(false);
  });

  it("stops waiting for its output a while after it exits, when a process of another group holds it", async () => {
    const { end, output } = await sh("set -m; sleep 60 & echo $!", { graceMs: 200 });
    await vi.waitFor(() => expect(output.join("")).toMatch(/^\d+\n$/));
    const escaped = Number(output.join(""));
    cleanups.push(async () => {
      process.kill(escaped, "SIGKILL");
    });

    expect(await end).toStrictEqual({ started: true, exitCode: 0 });
  });
});
