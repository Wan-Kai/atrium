import { createTempDir } from "@atrium/testkit";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createTaskWorkspaces } from "./task-workspaces";
import { agent, newTask } from "./test-support";

/**
 * Task workspaces over a stub creator and project list.
 *
 * @remarks
 * The creator and the projects are the ports the runner's wiring gives; what is under test is the marker and
 * the abort signal, not git.
 *
 * @sideEffects Creates a temporary directory.
 * @param workspaces - The workspaces the project list holds.
 * @param marker - The workspace id `workspace.json` names, if any.
 * @returns The workspaces, the creator's calls and the task.
 */
async function setup(workspaces: { id: string; baseCommit: string | null }[], marker?: string) {
  const dir = await createTempDir("task-workspaces");
  onTestFinished(dir.cleanup);
  const task = newTask([agent("N1", "work")], []);
  if (marker !== undefined) {
    await mkdir(join(dir.path, task.id), { recursive: true });
    await writeFile(join(dir.path, task.id, "workspace.json"), JSON.stringify({ workspaceId: marker }));
  }
  const created: { signal: AbortSignal | undefined }[] = [];
  const ports = createTaskWorkspaces({
    creator: {
      createFrom(_workspace, _wanted, _prefix, _alias, signal) {
        created.push({ signal });
        workspaces.push({ id: "w_new", baseCommit: "base" });
        return Promise.resolve({ workspaceId: "w_new", dir: "/x", branch: "b" });
      },
    },
    projects: { projects: () => [], workspaces: () => workspaces as never },
    git: Promise.resolve(null),
    root: dir.path,
    sourceContainer: () => "src",
    dirOf: () => "/x",
  });
  return { ports, created, task };
}

describe("createTaskWorkspaces: ensure", () => {
  it("finds the worktree the marker names instead of making a second one", async () => {
    const { ports, created, task } = await setup([{ id: "w1", baseCommit: "b1" }], "w1");

    expect(await ports.ensure(task, new AbortController().signal)).toStrictEqual({
      workspaceId: "w1",
      baseCommit: "b1",
    });
    expect(created).toHaveLength(0);
  });

  it("refuses, rather than makes another worktree, when the marked one has no base commit", async () => {
    const { ports, created, task } = await setup([{ id: "w1", baseCommit: null }], "w1");

    await expect(ports.ensure(task, new AbortController().signal)).rejects.toThrow("no base commit");
    expect(created).toHaveLength(0);
  });

  it("makes the worktree when there is no mark, handing the creator the abort signal", async () => {
    const { ports, created, task } = await setup([]);
    const controller = new AbortController();

    expect(await ports.ensure(task, controller.signal)).toStrictEqual({ workspaceId: "w_new", baseCommit: "base" });
    expect(created[0]?.signal).toBe(controller.signal);
  });

  it("makes nothing when the host is already closing", async () => {
    const { ports, created, task } = await setup([]);
    const controller = new AbortController();
    controller.abort();

    await expect(ports.ensure(task, controller.signal)).rejects.toThrow("aborted");
    expect(created).toHaveLength(0);
  });
});
