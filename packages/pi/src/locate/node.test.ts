import { FakeClock, createTempDir } from "@atrium/testkit";
import { chmod, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { inspectNode } from "./node";

/**
 * A directory holding a `node` that runs a shell script body.
 *
 * @remarks
 * Stands in for Node versions this machine does not have.
 *
 * @sideEffects Creates a temporary directory, removed after the test.
 * @param body - The script after the shebang.
 * @returns The directory.
 */
async function nodeBin(body: string): Promise<string> {
  const dir = await createTempDir("node-bin");
  onTestFinished(dir.cleanup);
  await writeFile(join(dir.path, "node"), `#!/bin/sh\n${body}\n`);
  await chmod(join(dir.path, "node"), 0o755);
  return dir.path;
}

/**
 * A `node` script that answers a good version, but only after 10 seconds.
 *
 * @remarks
 * Answering at all shows the check was not stopped: a stopped one counts as missing. It `exec`s
 * this test's Node, so killing the script kills the one process holding its output open; the wait
 * ends on its own, within the test's timeout, if nothing kills it (testing.md).
 */
const LATE_NODE = `exec "${process.execPath}" -e "setTimeout(() => console.log('v22.19.0'), 10_432)"`;

describe("inspectNode", () => {
  it("finds no Node on a path without one", async () => {
    const clock = new FakeClock();

    expect(await inspectNode(join(await nodeBin(""), "empty"), { env: {}, clock })).toStrictEqual({
      status: "missing",
    });
  });

  it("accepts 22.19.0 and runs it with the search path as PATH", async () => {
    const clock = new FakeClock();
    const bin = await nodeBin("");
    await writeFile(join(bin, "node"), `#!/bin/sh\n[ "$PATH" = "${bin}" ] && echo v22.19.0\n`);

    expect(await inspectNode(bin, { env: { PATH: "/elsewhere" }, clock })).toStrictEqual({
      status: "ready",
      nodePath: join(bin, "node"),
      version: [22, 19, 0],
    });
    expect(clock.pendingTimers()).toBe(0);
  });

  it("calls 22.18.9 outdated", async () => {
    const bin = await nodeBin("echo v22.18.9");

    expect(await inspectNode(bin, { env: {}, clock: new FakeClock() })).toStrictEqual({
      status: "outdated",
      nodePath: join(bin, "node"),
      version: [22, 18, 9],
    });
  });

  it.each([
    ["fails", "exit 1"],
    ["prints no version", "echo node"],
  ])("counts a node that %s as missing", async (_, body) => {
    expect(await inspectNode(await nodeBin(body), { env: {}, clock: new FakeClock() })).toStrictEqual({
      status: "missing",
    });
  });

  it("counts a node that does not answer in time as missing, and kills it", async () => {
    const clock = new FakeClock();
    const bin = await nodeBin(LATE_NODE);
    const inspecting = inspectNode(bin, { env: {}, clock, timeoutMs: 1_000 });
    await vi.waitFor(() => expect(clock.pendingTimers()).toBe(1));

    clock.advance(999);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const early = clock.pendingTimers();
    clock.advance(1);

    expect(early).toBe(1);
    expect(await inspecting).toStrictEqual({ status: "missing" });
  });

  it("stops when its signal aborts", async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const inspecting = inspectNode(await nodeBin(LATE_NODE), { env: {}, clock, signal: controller.signal });
    await vi.waitFor(() => expect(clock.pendingTimers()).toBe(1));

    controller.abort();

    expect(await inspecting).toStrictEqual({ status: "missing" });
    expect(clock.pendingTimers()).toBe(0);
  });

  it("finds the Node running this test", async () => {
    const found = await inspectNode(dirname(process.execPath), { env: {}, clock: new FakeClock() });

    expect(found).toStrictEqual({
      status: "ready",
      nodePath: process.execPath,
      version: process.versions.node.split(".").map(Number),
    });
  });
});
