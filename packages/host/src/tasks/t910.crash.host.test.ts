import { createTempDir } from "@atrium/testkit";
import { type ChildProcess, spawn } from "node:child_process";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { startTestHost } from "../../test/harness";
import { ATRIUM_EXTENSION, prepareTaskEnvironment } from "../../test/task-harness";
import { agent, need } from "./test-support";

vi.setConfig({ testTimeout: 120_000 });

/** A reply that calls a tool. */
const call = (name: string, id: string, args: Record<string, unknown>) => ({
  blocks: [{ type: "toolCall" as const, id, name, arguments: args as Record<string, never> }],
});

/** A reply that holds until the test releases it, then ends the node. */
const holding = (name: string, summary: string) => ({
  waitFor: name,
  blocks: call("node_done", `d-${name}`, { ok: true, summary }).blocks,
});

/**
 * Bundles the child host with esbuild, as the host's own build does.
 *
 * @sideEffects Writes a file in a temporary directory, removed when the test ends.
 * @returns The path of the bundle.
 */
async function bundleChild(): Promise<string> {
  const out = await createTempDir("crash-child");
  onTestFinished(out.cleanup);
  const outfile = join(out.path, "child.cjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../../test/crash-child.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["bufferutil", "utf-8-validate"],
    logLevel: "silent",
  });
  return outfile;
}

/**
 * Starts the child and resolves with it once the lines it prints satisfy a condition.
 *
 * @remarks
 * The child is its own process group leader, so that the pi processes it started can be ended with it. It is killed
 * (and its group) when the test ends, whatever happened.
 *
 * @sideEffects Spawns a process.
 * @param bundle - The child's bundle.
 * @param config - What the child is to do.
 * @returns The process, and a way to wait for an event it reports.
 */
function runChild(bundle: string, config: object) {
  const child: ChildProcess = spawn(process.execPath, [bundle], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, CRASH_CHILD: JSON.stringify(config) },
  });
  onTestFinished(() => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  const seen: string[] = [];
  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = JSON.parse(line) as { type: string; event?: string };
      seen.push(parsed.type === "event" ? (parsed.event ?? "") : parsed.type);
    }
  });
  return {
    child,
    seen,
    reached: (name: string) => vi.waitFor(() => expect(seen).toContain(name), { timeout: 60_000, interval: 50 }),
  };
}

describe("a real host killed with SIGKILL in the middle of a node (SPEC-0006, T9 / T10 审查后用户定)", () => {
  it("is taken up again by the next host on the same home: one worktree, one contract, the node finishes", async () => {
    const world = await prepareTaskEnvironment({ N1: [holding("go", "wrote"), holding("again", "wrote again")] });
    const bundle = await bundleChild();
    const taskId = "tsk_crash1";
    const running = runChild(bundle, {
      home: world.home,
      repo: world.repo,
      extension: ATRIUM_EXTENSION,
      env: world.env,
      taskId,
      nodes: [agent("N1", "work")],
      edges: [],
    });
    await running.reached("contract_sent");

    // The kill: no handler runs, no file is flushed, the pi of the node is cut off from its host.
    process.kill(need(running.child.pid), "SIGKILL");
    await new Promise((resolve) => running.child.once("exit", resolve));

    const host = await startTestHost({
      home: world.home,
      fastExtension: ATRIUM_EXTENSION,
      toolEnv: world.env,
    });
    onTestFinished(host.dispose);
    await host.host.tools;
    await world.release("go");
    await world.release("again");
    await vi.waitFor(
      () => {
        expect(need(host.host.tasks.task(taskId)).endedAt).not.toBeNull();
      },
      { timeout: 90_000, interval: 100 },
    );
    await host.host.tasks.idle();

    const task = need(host.host.tasks.task(taskId));
    expect(task.runs.map((run) => run.state)).toStrictEqual(["passed"]);
    const log = (await readFile(join(world.home, "tasks", taskId, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(log.filter((type) => type === "workspace_created")).toHaveLength(1);
    expect(log.filter((type) => type === "host_restarted")).toHaveLength(1);
    // One worktree besides the main checkout, whatever the dead host had under way.
    const listing = await new Promise<string>((resolve, reject) => {
      const git = spawn("git", ["worktree", "list", "--porcelain"], { cwd: world.repo, env: world.env });
      let text = "";
      git.stdout.on("data", (chunk: Buffer) => void (text += chunk.toString("utf8")));
      git.on("error", reject);
      git.on("close", () => resolve(text));
    });
    expect(listing.match(/^worktree /gmu)).toHaveLength(2);
    // The contract reached the node's file once, though the restart told it the host had restarted.
    const files = (await readdir(world.dir, { recursive: true })).filter((name) => name.endsWith(".jsonl"));
    const sessionId = String(need(task.runs[0]).sessionId);
    const file = need(files.find((name) => name.endsWith(`_${sessionId}.jsonl`)));
    const text = await readFile(join(world.dir, file), "utf8");
    expect(text.split("你在任务「test task」里负责节点 N1").length - 1).toBe(1);
    expect(text).toContain("宿主重启了");
  });
});
