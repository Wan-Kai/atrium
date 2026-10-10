import { CommandError, type InstallOutputEvent, type InstallUpdatedEvent } from "@atrium/protocol";
import { createTempDir } from "@atrium/testkit";
import { access, chmod, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { runJob } from "./install-job";
import { DownloadError } from "./install-script";
import { type InstallService, createInstallService } from "./install-service";
import type { HostTools } from "./toolbox";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Sessions whose running count a test sets. */
interface TestSessions {
  running(): number;
  onChange(listener: () => void): () => void;
  /** Sets how many sessions run, and tells the listeners. */
  set(count: number): void;
  /** How many listeners are attached. */
  listeners(): number;
}

/**
 * Sessions whose running count a test sets.
 *
 * @remarks
 * The install service only reads the count and listens for changes.
 *
 * @sideEffects none
 * @param initial - How many sessions run at first.
 * @returns The sessions.
 */
function testSessions(initial: number): TestSessions {
  let count = initial;
  const listeners = new Set<() => void>();
  return {
    running: () => count,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      count = next;
      for (const listener of listeners) listener();
    },
    listeners: () => listeners.size,
  };
}

/**
 * Writes an executable shell script.
 *
 * @remarks
 * Stands in for `brew` and `pi`.
 *
 * @sideEffects Writes the file.
 * @param path - Where.
 * @param body - The script after the `#!/bin/sh` line.
 * @returns The path.
 */
async function executable(path: string, body: string): Promise<string> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/**
 * An install service over a fake `brew` and `pi`, sending its events into an array.
 *
 * @remarks
 * Jobs run for real. `brew` and `pi` print what they were asked and the folder they run in, then
 * exit with `BREW_EXIT` / `PI_EXIT`; `pi` waits for `PI_WAIT` seconds first and records that it ran.
 * The script is whatever the test gives: the script, a failing download, or how to download it.
 * Job ids count up from `j1`.
 *
 * @sideEffects Creates a temporary directory; closes the service and removes the directory after
 * the test.
 * @param options - The tools to change, the script, the sessions, and extra environment.
 * @returns The service, its events, the log records, the folder and the open processes.
 */
async function service(
  options: {
    tools?: (tools: HostTools) => HostTools | null;
    script?: string | DownloadError | ((signal: AbortSignal) => Promise<string>);
    sessions?: TestSessions;
    env?: Record<string, string>;
  } = {},
): Promise<{
  service: InstallService;
  events: (InstallUpdatedEvent | InstallOutputEvent)[];
  records: Record<string, unknown>[];
  dir: string;
  open: () => number;
}> {
  const temp = await createTempDir("install-service");
  cleanups.push(temp.cleanup);
  const dir = await realpath(temp.path);
  const brew = await executable(join(dir, "brew"), 'echo "brew $* in $(pwd)"; exit "${BREW_EXIT:-0}"');
  const pi = await executable(
    join(dir, "pi"),
    `touch "${dir}/pi-ran"; sleep "\${PI_WAIT:-0}"; echo "pi $* in $(pwd)"; exit "\${PI_EXIT:-0}"`,
  );
  const tools: HostTools = {
    env: { PATH: "/usr/bin:/bin", ...options.env },
    envSource: "configured",
    pi: { status: "outdated", piPath: pi, version: [1, 0, 0], minimum: [1, 0, 1] },
    node: { status: "ready", nodePath: process.execPath, version: [22, 19, 0] },
    homebrew: brew,
    fd: null,
  };
  const found = options.tools === undefined ? tools : options.tools(tools);
  const recording = recordingTracing();
  cleanups.push(recording.shutdown);
  const events: (InstallUpdatedEvent | InstallOutputEvent)[] = [];
  const script = options.script ?? "echo installing";
  let ids = 0;
  const value = createInstallService({
    toolbox: { current: async () => found },
    script: async (signal) => {
      if (typeof script === "function") return script(signal);
      if (script instanceof DownloadError) throw script;
      return script;
    },
    sessions: options.sessions ?? testSessions(0),
    broadcast: (event) => events.push(event),
    run: (command, run) =>
      runJob(command, { ...run, clock: systemClock, resources: recording.resources, graceMs: 200 }),
    cwd: dir,
    newId: () => `j${++ids}`,
    logger: recording.logger,
  });
  cleanups.push(() => value.close());
  return {
    service: value,
    events,
    records: recording.records,
    dir,
    open: () => recording.resources.snapshot()["install.process"] ?? 0,
  };
}

/**
 * Waits until a job ends, and returns its last state.
 *
 * @remarks
 * Jobs run real processes.
 *
 * @sideEffects none
 * @param events - The events so far.
 * @returns The job's final state.
 */
async function ended(events: readonly (InstallUpdatedEvent | InstallOutputEvent)[]): Promise<InstallUpdatedEvent> {
  return vi.waitFor(
    () => {
      const last = updates(events).at(-1);
      if (last === undefined || ["waiting", "running"].includes(last.state)) throw new Error("not yet");
      return last;
    },
    { timeout: 10_000 },
  );
}

/**
 * The state changes among the events.
 *
 * @remarks
 * Leaves the output out.
 *
 * @sideEffects none
 * @param events - The events.
 * @returns The state changes.
 */
function updates(events: readonly (InstallUpdatedEvent | InstallOutputEvent)[]): InstallUpdatedEvent[] {
  return events.filter((event): event is InstallUpdatedEvent => event.type === "install_updated");
}

/**
 * All the output among the events, joined.
 *
 * @remarks
 * Output comes in pieces of any size.
 *
 * @sideEffects none
 * @param events - The events.
 * @returns The output.
 */
function output(events: readonly (InstallUpdatedEvent | InstallOutputEvent)[]): string {
  return events.flatMap((event) => (event.type === "install_output" ? [event.text] : [])).join("");
}

/** A job's state with nothing but what every state has. */
const UPDATE = { type: "install_updated", running: null, exitCode: null, reason: null } as const;

describe("InstallService.start", () => {
  it("installs pi by running the downloaded script with sh, passing on its output", async () => {
    const { service: installs, events, records, dir } = await service({ script: 'echo "installing in $(pwd)"' });

    const { jobId } = await installs.start("install_pi");
    const done = await ended(events);

    expect(jobId).toBe("j1");
    expect(updates(events)).toStrictEqual([
      { ...UPDATE, jobId: "j1", kind: "install_pi", state: "running" },
      { ...UPDATE, jobId: "j1", kind: "install_pi", state: "ok", exitCode: 0 },
    ]);
    expect(done.state).toBe("ok");
    expect(output(events)).toBe(`installing in ${dir}\n`);
    expect(records).toContainEqual(
      expect.objectContaining({ msg: "install finished", kind: "install_pi", state: "ok", exitCode: 0, reason: null }),
    );
    expect(JSON.stringify(records)).not.toContain("installing");
  });

  it("installs Node with the Homebrew found, and fails with brew's exit code", async () => {
    const { service: installs, events, dir } = await service({ env: { BREW_EXIT: "7" } });

    await installs.start("install_node");
    const done = await ended(events);

    expect(done).toStrictEqual({
      ...UPDATE,
      jobId: "j1",
      kind: "install_node",
      state: "failed",
      exitCode: 7,
      reason: "exit",
    });
    expect(output(events)).toBe(`brew install node in ${dir}\n`);
  });

  it("updates pi at once when no session runs", async () => {
    const { service: installs, events, dir } = await service();

    await installs.start("update_pi");
    const done = await ended(events);

    expect(updates(events).map(({ state, running }) => [state, running])).toStrictEqual([
      ["running", null],
      ["ok", null],
    ]);
    expect(done).toStrictEqual({ ...UPDATE, jobId: "j1", kind: "update_pi", state: "ok", exitCode: 0 });
    expect(output(events)).toBe(`pi update in ${dir}\n`);
  });

  it("updates pi once the running sessions have finished, showing how many still run", async () => {
    const sessions = testSessions(2);
    const { service: installs, events } = await service({ sessions });

    await installs.start("update_pi");
    sessions.set(2);
    sessions.set(1);
    expect(output(events)).toBe("");
    sessions.set(0);
    await ended(events);

    expect(updates(events).map(({ state, running }) => [state, running])).toStrictEqual([
      ["waiting", 2],
      ["waiting", 1],
      ["running", null],
      ["ok", null],
    ]);
    expect(sessions.listeners()).toBe(0);
  });

  it("fails without running anything when the script cannot be downloaded, and logs only why", async () => {
    const { service: installs, events, records, open } = await service({ script: new DownloadError("status") });

    await installs.start("install_pi");
    const done = await ended(events);

    expect(done).toStrictEqual({
      ...UPDATE,
      jobId: "j1",
      kind: "install_pi",
      state: "failed",
      reason: "download_failed",
    });
    expect(output(events)).toBe("");
    expect(open()).toBe(0);
    expect(records).toContainEqual(
      expect.objectContaining({ msg: "install script not downloaded", kind: "install_pi", reason: "status" }),
    );
  });

  it("fails when the command cannot start", async () => {
    const { service: installs, events } = await service({
      tools: (tools) => ({ ...tools, homebrew: "/nonexistent/brew" }),
    });

    await installs.start("install_node");
    const done = await ended(events);

    expect(done).toStrictEqual({
      ...UPDATE,
      jobId: "j1",
      kind: "install_node",
      state: "failed",
      reason: "spawn_failed",
    });
  });

  it("runs one job at a time", async () => {
    const { service: installs, events } = await service({ env: { PI_WAIT: "0.3" } });

    await installs.start("update_pi");
    const busy = installs.start("install_pi");

    await expect(busy).rejects.toBeInstanceOf(CommandError);
    await expect(busy).rejects.toMatchObject({ code: "install_busy" });
    await ended(events);
    await expect(installs.start("install_node")).resolves.toStrictEqual({ jobId: "j2" });
  });

  it.each([
    ["any job before the tools are found", "install_pi", () => null],
    ["Node without Homebrew", "install_node", (tools: HostTools) => ({ ...tools, homebrew: null })],
    ["an update without pi", "update_pi", (tools: HostTools) => ({ ...tools, pi: { status: "missing" } as const })],
  ] as const)("cannot run %s", async (_case, kind, tools) => {
    const { service: installs, events } = await service({ tools });

    const starting = installs.start(kind);

    await expect(starting).rejects.toBeInstanceOf(CommandError);
    await expect(starting).rejects.toMatchObject({ code: "install_unavailable" });
    expect(events).toStrictEqual([]);
  });

  it("is free again after a job it could not run", async () => {
    const { service: installs, events } = await service({ tools: (tools) => ({ ...tools, homebrew: null }) });
    await expect(installs.start("install_node")).rejects.toMatchObject({ code: "install_unavailable" });

    await installs.start("install_pi");

    expect((await ended(events)).state).toBe("ok");
  });
});

describe("InstallService.cancel", () => {
  it("ends a running job and its processes", async () => {
    const { service: installs, events, open } = await service({ env: { PI_WAIT: "60" } });
    const { jobId } = await installs.start("update_pi");
    await vi.waitFor(() => expect(open()).toBe(1));

    installs.cancel(jobId);
    const done = await ended(events);

    expect(done).toStrictEqual({ ...UPDATE, jobId: "j1", kind: "update_pi", state: "cancelled" });
    expect(open()).toBe(0);
  });

  it("ends a waiting update without running pi", async () => {
    const sessions = testSessions(1);
    const { service: installs, events, dir } = await service({ sessions });
    const { jobId } = await installs.start("update_pi");

    installs.cancel(jobId);
    const done = await ended(events);
    sessions.set(0);

    expect(done).toStrictEqual({ ...UPDATE, jobId: "j1", kind: "update_pi", state: "cancelled" });
    expect(updates(events).map(({ state }) => state)).toStrictEqual(["waiting", "cancelled"]);
    await expect(access(join(dir, "pi-ran"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(sessions.listeners()).toBe(0);
  });

  it("ends a job still downloading its script", async () => {
    const { service: installs, events } = await service({
      script: (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new DownloadError("aborted")), { once: true }),
        ),
    });
    const { jobId } = await installs.start("install_pi");

    installs.cancel(jobId);
    const done = await ended(events);

    expect(done.state).toBe("cancelled");
  });

  it("knows no job but the one under way", async () => {
    const { service: installs, events } = await service();
    const { jobId } = await installs.start("install_pi");
    await ended(events);

    const notFound = new CommandError("install_not_found");
    expect(() => installs.cancel("j9")).toThrow(notFound);
    expect(() => installs.cancel(jobId)).toThrow(notFound);
  });
});

describe("InstallService.close", () => {
  it("cancels the job under way, waits for its processes, then runs no more", async () => {
    const { service: installs, events, open } = await service({ env: { PI_WAIT: "60" } });
    await installs.start("update_pi");
    await vi.waitFor(() => expect(open()).toBe(1));

    await installs.close();

    expect(open()).toBe(0);
    expect(updates(events).at(-1)).toMatchObject({ state: "cancelled" });
    await expect(installs.start("install_pi")).rejects.toMatchObject({ code: "install_unavailable" });
  });
});
