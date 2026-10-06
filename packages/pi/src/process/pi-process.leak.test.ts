import { createTempDir, fauxPi, present } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { describe, expect, it, onTestFinished } from "vitest";
import type { PiDeps } from "../deps";
import { findPi } from "../locate/locate";
import { descendantsOf, parseProcessTable } from "./kill-tree";
import { startPiProcess } from "./pi-process";

/** Node's live child processes, pipes and timers, independent of our own counts. */
function liveHandles(): { ProcessWrap: number; PipeWrap: number; Timeout: number } {
  const resources = process.getActiveResourcesInfo();
  const count = (kind: string): number => resources.filter((resource) => resource === kind).length;
  return { ProcessWrap: count("ProcessWrap"), PipeWrap: count("PipeWrap"), Timeout: count("Timeout") };
}

/** The pids of every process this test process has started and that is still running, except `ps` itself. */
function ownDescendants(): number[] {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,comm="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => !/\sps$/.test(line))
    .map((line) => line.trim().split(/\s+/).slice(0, 3).join(" "));
  return descendantsOf(parseProcessTable(rows.join("\n")), process.pid).map((row) => row.pid);
}

/**
 * Running processes that are one of `pids` or sit in a process group one of them leads.
 *
 * @remarks
 * pi and the children it starts in its own group are reparented to launchd once pi is gone, so
 * `ownDescendants` alone would no longer see them.
 *
 * @sideEffects Runs `ps`.
 * @param pids - pi's pids.
 * @returns The matching rows.
 */
function survivorsOf(pids: ReadonlySet<number>): { pid: number; ppid: number; pgid: number }[] {
  const table = parseProcessTable(execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" }));
  return table.filter((row) => pids.has(row.pid) || pids.has(row.pgid));
}

/** Dependencies that count open resources and live timers. */
function countingDeps(env: Record<string, string>) {
  const open = new Map<string, number>();
  const timers = new Set<NodeJS.Timeout>();
  let nextId = 0;
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
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    nextRequestId: () => `req-${++nextId}`,
    env,
  };
  return { deps, open, timers };
}

describe("PiProcess resources", () => {
  it("leaves no process, handle, timer or count behind after starting and stopping real pi 200 times", async () => {
    const dir = await createTempDir("pi-leak");
    onTestFinished(dir.cleanup);
    const launch = await fauxPi({ replies: [] }, dir.path);
    const path = present(process.env["PATH"], "PATH");
    const piPath = present(await findPi(path), "pi on PATH");
    const { deps, open, timers } = countingDeps({ PATH: path, HOME: dir.path });
    const handlesBefore = liveHandles();
    const descendantsBefore = ownDescendants();
    const piPids = new Set<number>();

    for (let batch = 0; batch < 20; batch++) {
      const processes = Array.from({ length: 10 }, () =>
        startPiProcess({ piPath, args: ["--no-session", ...launch.args], cwd: dir.path, env: launch.env }, deps),
      );
      for (const pi of processes) piPids.add(present(pi.pid, "pi pid"));
      const exits = await Promise.all(processes.map((pi) => pi.stop()));
      expect(exits.map((exit) => exit.requested)).toStrictEqual(Array.from({ length: 10 }, () => true));
    }

    expect(open.get("pi-process")).toBe(0);
    expect(timers.size).toBe(0);
    expect(ownDescendants()).toStrictEqual(descendantsBefore);
    expect(piPids.size).toBe(200);
    expect(survivorsOf(piPids)).toStrictEqual([]);
    // Checked directly, not through vi.waitFor, whose own polling timer would be counted too.
    // stop() resolves only after pi's pipes have closed, so nothing should be left to wait for.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = liveHandles();
    expect(after.ProcessWrap).toBe(handlesBefore.ProcessWrap);
    expect(after.PipeWrap).toBe(handlesBefore.PipeWrap);
    expect(after.Timeout).toBeLessThanOrEqual(handlesBefore.Timeout);
  });
});
