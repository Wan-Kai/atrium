import { present } from "@atrium/testkit";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { type ProcessSystem, descendantsOf, killProcessTree, parseProcessTable } from "./kill-tree";

describe("parseProcessTable", () => {
  it("reads pid, ppid and pgid from ps output, skipping malformed rows", () => {
    const output = [
      "  101     1   101",
      "  202   101   202",
      "garbage",
      "  303   202",
      "  4x   1   1",
      "  404   1   1 extra",
      "x 505   1   1",
      "",
    ].join("\n");

    expect(parseProcessTable(output)).toStrictEqual([
      { pid: 101, ppid: 1, pgid: 101 },
      { pid: 202, ppid: 101, pgid: 202 },
    ]);
  });
});

describe("descendantsOf", () => {
  const table = [
    { pid: 10, ppid: 1, pgid: 10 },
    { pid: 11, ppid: 10, pgid: 10 },
    { pid: 12, ppid: 10, pgid: 12 },
    { pid: 13, ppid: 12, pgid: 12 },
    { pid: 14, ppid: 13, pgid: 14 },
    { pid: 20, ppid: 1, pgid: 20 },
    { pid: 21, ppid: 20, pgid: 20 },
  ];

  it("finds children, grandchildren and deeper, whatever their process group", () => {
    expect(descendantsOf(table, 10).map((row) => row.pid)).toStrictEqual([11, 12, 13, 14]);
  });

  it("finds nothing for a process without children", () => {
    expect(descendantsOf(table, 14)).toStrictEqual([]);
  });

  it("terminates on a table with a parent cycle and never returns the root", () => {
    const cyclic = [
      { pid: 1, ppid: 2, pgid: 1 },
      { pid: 2, ppid: 1, pgid: 1 },
    ];

    expect(descendantsOf(cyclic, 1)).toStrictEqual([{ pid: 2, ppid: 1, pgid: 1 }]);
  });
});

/** A process table and a kill function that records its targets and fails as told. */
function fakeSystem(rows: readonly string[], failures: Readonly<Record<number, unknown>> = {}) {
  const killed: number[] = [];
  const system: ProcessSystem = {
    listProcesses: () => Promise.resolve(rows.join("\n")),
    kill(target) {
      killed.push(target);
      if (target in failures) throw failures[target];
    },
    ownPid: 50,
  };
  return { system, killed };
}

/**
 * Kills a process if it is still there.
 *
 * @remarks
 * Cleanup for a test that failed before killing what it spawned.
 *
 * @sideEffects Sends SIGKILL.
 * @param target - A pid, or a negative process group id.
 */
function killIfAlive(target: number): void {
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** An error shaped like the ones `process.kill` throws. */
function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe("killProcessTree with a fake system", () => {
  it("kills pi's group, every descendant's group and every descendant, but never its own group or groups 0 and 1", async () => {
    const { system, killed } = fakeSystem([
      "50 1 40", // the caller, in group 40
      "10 50 10", // pi, leading group 10
      "11 10 10", // a plain child of pi
      "12 10 12", // a detached child leading group 12
      "13 12 40", // a grandchild that somehow sits in the caller's group
      "14 12 1", // and one in group 1
      "15 12 0", // and one in group 0
    ]);

    await killProcessTree(10, system);

    expect(killed).toStrictEqual([-10, -12, 11, 12, 13, 14, 15]);
  });

  it("ignores processes that are already gone but passes on other failures", async () => {
    const gone = fakeSystem(["10 1 10", "11 10 11"], { [-10]: errno("ESRCH"), 11: errno("ESRCH") });
    const denied = fakeSystem(["10 1 10"], { [-10]: errno("EPERM") });
    const odd = fakeSystem(["10 1 10"], { [-10]: "not an error" });

    await expect(killProcessTree(10, gone.system)).resolves.toBeUndefined();
    expect(gone.killed).toStrictEqual([-10, -11, 11]);
    await expect(killProcessTree(10, denied.system)).rejects.toStrictEqual(errno("EPERM"));
    await expect(killProcessTree(10, odd.system)).rejects.toBe("not an error");
  });
});

describe("killProcessTree", () => {
  it("kills a process and a grandchild that leads its own process group", async () => {
    const parent = spawn(
      process.execPath,
      [
        "-e",
        // Both end on their own if the test never kills them: the sleep after 30 s, the parent
        // once it is orphaned, as when a timed-out test run is killed.
        `const c = require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
         process.stdout.write(String(c.pid) + "\\n");
         setInterval(() => { if (process.ppid === 1) process.exit(1); }, 200);`,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const parentPid = present(parent.pid, "parent pid");
    onTestFinished(() => killIfAlive(-parentPid));
    const [chunk] = (await once(parent.stdout, "data")) as [Buffer];
    const grandchild = Number(chunk.toString().trim());
    onTestFinished(() => killIfAlive(grandchild));
    const parentExit = once(parent, "exit");

    await killProcessTree(parentPid);

    expect(await parentExit).toStrictEqual([null, "SIGKILL"]);
    // The grandchild may linger for a moment as a zombie until launchd reaps it.
    await vi.waitFor(
      () => expect(() => process.kill(grandchild, 0)).toThrow(expect.objectContaining({ code: "ESRCH" })),
      { timeout: 15_000 },
    );
  });

  it("does nothing to a process that is already gone", async () => {
    const child = spawn(process.execPath, ["-e", ""], { detached: true });
    await once(child, "exit");

    await expect(killProcessTree(present(child.pid, "child pid"))).resolves.toBeUndefined();
  });
});
