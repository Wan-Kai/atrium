import { createTempDir } from "@atrium/testkit";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createTaskWorkspaces } from "./task-workspaces";
import { GitError, type GitRunner } from "../platform/git";
import type { WorktreePlan } from "../workspaces/worktree-creator";
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
async function setup(
  workspaces: { id: string; baseCommit: string | null }[],
  marker?: string | { planned: WorktreePlan },
  adopting: "adopts" | "refuses" = "refuses",
  extra: {
    readonly projects?: { id: string; path: string }[];
    readonly git?: GitRunner | null;
    readonly source?: string | undefined;
    /** What `workspace.json` holds, as text, in place of a mark. */
    readonly raw?: string;
  } = {},
) {
  const dir = await createTempDir("task-workspaces");
  onTestFinished(dir.cleanup);
  const task = newTask([agent("N1", "work")], []);
  if (marker !== undefined) {
    await mkdir(join(dir.path, task.id), { recursive: true });
    await writeFile(
      join(dir.path, task.id, "workspace.json"),
      JSON.stringify(typeof marker === "string" ? { workspaceId: marker } : marker),
    );
  }
  if (extra.raw !== undefined) {
    await mkdir(join(dir.path, task.id), { recursive: true });
    await writeFile(join(dir.path, task.id, "workspace.json"), extra.raw);
  }
  const created: { signal: AbortSignal | undefined; marker: string; asked: (string | null | undefined)[] }[] = [];
  const adopted: { plan: WorktreePlan; alias: string | null | undefined; allowedLock: string | undefined }[] = [];
  const markerOnDisk = () => readFile(join(dir.path, task.id, "workspace.json"), "utf8").then((text) => text.trim());
  const ports = createTaskWorkspaces({
    creator: {
      async createFrom(workspace, wanted, prefix, alias, signal, planned) {
        // What the creator tells the plan to, and what the task's directory holds when git is asked.
        await planned?.({ source: "src", branch: "atrium/b", dir: "/x", start: "start" });
        created.push({ signal, marker: await markerOnDisk(), asked: [workspace, wanted, prefix, alias] });
        workspaces.push({ id: "w_new", baseCommit: "base" });
        return { workspaceId: "w_new", dir: "/x", branch: "atrium/b" };
      },
      adopt(plan, adoption) {
        adopted.push({ plan, alias: adoption.alias, allowedLock: adoption.allowedLock });
        if (adopting === "refuses") return Promise.resolve(null);
        workspaces.push({ id: "w_adopted", baseCommit: "base" });
        return Promise.resolve({ workspaceId: "w_adopted", dir: plan.dir, branch: plan.branch });
      },
    },
    projects: { projects: () => (extra.projects ?? []) as never, workspaces: () => workspaces as never },
    git: Promise.resolve(extra.git ?? null),
    root: dir.path,
    sourceContainer: () => ("source" in extra ? extra.source : "src"),
    dirOf: () => "/x",
    inspector: Promise.resolve(null),
  });
  return { ports, created, task, adopted, markerOnDisk };
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

/** A plan as the marker holds it. */
const PLANNED = { planned: { source: "src", branch: "atrium/a-task", dir: "/w/a-task", start: "abc" } };

describe("createTaskWorkspaces: the plan and the crash window (SPEC-0006, T9)", () => {
  it("has written the plan, and nothing else, when git is asked to add the worktree; the mark names the workspace after", async () => {
    const { ports, created, task, markerOnDisk } = await setup([]);

    await ports.ensure(task, new AbortController().signal);

    expect(created[0]?.marker).toBe(
      JSON.stringify({ planned: { source: "src", branch: "atrium/b", dir: "/x", start: "start" } }),
    );
    expect(await markerOnDisk()).toBe(JSON.stringify({ workspaceId: "w_new" }));
  });

  it("adopts the worktree the plan names, for this task, and marks it without making another", async () => {
    const { ports, created, task, adopted, markerOnDisk } = await setup([], PLANNED, "adopts");
    const controller = new AbortController();

    expect(await ports.ensure(task, controller.signal)).toStrictEqual({ workspaceId: "w_adopted", baseCommit: "base" });

    expect(adopted).toStrictEqual([{ plan: PLANNED.planned, alias: task.name, allowedLock: `atrium task ${task.id}` }]);
    expect(created).toHaveLength(0);
    expect(await markerOnDisk()).toBe(JSON.stringify({ workspaceId: "w_adopted" }));
  });

  it("makes a new worktree, with a new plan, when the plan's is not found or not exactly it", async () => {
    const { ports, created, task, adopted, markerOnDisk } = await setup([], PLANNED, "refuses");

    expect(await ports.ensure(task, new AbortController().signal)).toStrictEqual({
      workspaceId: "w_new",
      baseCommit: "base",
    });

    expect(adopted).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(await markerOnDisk()).toBe(JSON.stringify({ workspaceId: "w_new" }));
  });

  it("goes by the workspace the mark names before the plan: a mark with both is no mark", async () => {
    const both = { workspaceId: "w1", planned: PLANNED.planned };
    const { ports, created, task, adopted } = await setup([{ id: "w1", baseCommit: "b1" }], both);

    await ports.ensure(task, new AbortController().signal);

    // Neither was trusted: the strict shape rejects it and the task makes its worktree afresh.
    expect(adopted).toHaveLength(0);
    expect(created).toHaveLength(1);
  });

  it("does not look for a plan's worktree when the host is already closing", async () => {
    const { ports, adopted, task } = await setup([], PLANNED, "adopts");
    const controller = new AbortController();
    controller.abort();

    await expect(ports.ensure(task, controller.signal)).rejects.toThrow("aborted");
    expect(adopted).toHaveLength(0);
  });

  it("reports an adopted worktree that has no base commit as a failure, as it does a marked one", async () => {
    const { ports, task } = await setup([{ id: "w_adopted", baseCommit: null }], PLANNED, "adopts");

    await expect(ports.ensure(task, new AbortController().signal)).rejects.toThrow("no base commit");
  });
});

describe("createTaskWorkspaces: what is asked of the creator", () => {
  it("asks for a branch under atrium/ named after the task, from the task's source, and says why when there is none", async () => {
    const { ports, created, task } = await setup([]);
    await ports.ensure(task, new AbortController().signal);
    const noSource = await setup([], undefined, "refuses", { source: undefined });

    expect(created[0]?.asked).toStrictEqual(["src", task.name, "atrium/", task.name]);
    await expect(noSource.ports.ensure(noSource.task, new AbortController().signal)).rejects.toThrow(
      "the task's source has no workspace",
    );
    expect(noSource.created).toHaveLength(0);
  });

  it("takes the record of the workspace it made, not another, and refuses one that has none", async () => {
    const other = { id: "w_other", baseCommit: "other-base" };
    const { ports, task } = await setup([other]);
    const lost = await setup([], undefined, "refuses");

    expect(await ports.ensure(task, new AbortController().signal)).toStrictEqual({
      workspaceId: "w_new",
      baseCommit: "base",
    });
    // The creator says it made a workspace the list does not hold.
    const missing = createTaskWorkspaces({
      creator: {
        createFrom: () => Promise.resolve({ workspaceId: "w_gone", dir: "/x", branch: "b" }),
        adopt: () => Promise.resolve(null),
      },
      projects: { projects: () => [], workspaces: () => [] },
      git: Promise.resolve(null),
      root: (await createTempDir("task-workspaces-missing")).path,
      sourceContainer: () => "src",
      dirOf: () => "/x",
      inspector: Promise.resolve(null),
    });
    await expect(missing.ensure(lost.task, new AbortController().signal)).rejects.toThrow(
      "the new worktree has no base commit",
    );
  });

  it("reads a mark of another shape as no mark, and makes the worktree", async () => {
    const { ports, created, task, markerOnDisk } = await setup([], undefined, "refuses", {
      raw: JSON.stringify({ workspaceId: 5, planned: "elsewhere" }),
    });

    await ports.ensure(task, new AbortController().signal);

    expect(created).toHaveLength(1);
    expect(await markerOnDisk()).toBe(JSON.stringify({ workspaceId: "w_new" }));
  });
});

/**
 * Real-looking git that lists worktrees and records what it is asked to unlock.
 *
 * @remarks
 * The listing is the porcelain git prints; `unlock` is git's own subcommand. A repository named in `failing` makes
 * the listing fail the way git does when it is gone (exit 128).
 *
 * @sideEffects none
 * @param locked - Per repository, the worktrees locked for tasks.
 * @param failing - Repositories git cannot list.
 * @param broken - Repositories where git cannot be run at all.
 * @returns The runner and the unlocks it was asked for.
 */
function lockingGit(
  locked: Readonly<Record<string, readonly string[]>>,
  failing: readonly string[] = [],
  broken: readonly string[] = [],
) {
  const unlocked: string[] = [];
  const git: GitRunner = {
    run(args, options) {
      if (broken.includes(options.cwd)) return Promise.reject(new TypeError("not a GitError"));
      if (failing.includes(options.cwd)) return Promise.resolve({ code: 128, stdout: "" });
      if (args.includes("unlock")) {
        unlocked.push(String(args.at(-1)));
        return Promise.resolve({ code: 0, stdout: "" });
      }
      const listing = (locked[options.cwd] ?? [])
        .map((task) => `worktree /w/${task}\nHEAD abc\nbranch refs/heads/${task}\nlocked atrium task ${task}\n`)
        .join("\n");
      return Promise.resolve({
        code: 0,
        stdout: `worktree ${options.cwd}\nHEAD abc\nbranch refs/heads/main\n\n${listing}`,
      });
    },
  };
  return { git, unlocked };
}

describe("createTaskWorkspaces: clearStaleLocks", () => {
  const PROJECTS = [
    { id: "p1", path: "/r1" },
    { id: "p2", path: "/r2" },
  ];

  it("lifts the locks of tasks that are over in every project, counting them, and keeps those of active tasks", async () => {
    const { git, unlocked } = lockingGit({ "/r1": ["tsk_over", "tsk_live"], "/r2": ["tsk_gone"] });
    const { ports } = await setup([], undefined, "refuses", { projects: PROJECTS, git });

    const lifted = await ports.clearStaleLocks((taskId) => taskId === "tsk_live");

    expect(lifted).toBe(2);
    expect(unlocked.toSorted()).toStrictEqual(["/w/tsk_gone", "/w/tsk_over"]);
  });

  it("goes on past a repository git cannot list, and lifts nothing without git", async () => {
    const { git, unlocked } = lockingGit({ "/r2": ["tsk_over"] }, ["/r1"]);
    const { ports } = await setup([], undefined, "refuses", { projects: PROJECTS, git });
    const bare = await setup([], undefined, "refuses", { projects: PROJECTS });

    expect(await ports.clearStaleLocks(() => false)).toBe(1);
    expect(unlocked).toStrictEqual(["/w/tsk_over"]);
    expect(await bare.ports.clearStaleLocks(() => false)).toBe(0);
  });

  it("does not hide a failure that is not git's", async () => {
    const { git } = lockingGit({}, [], ["/r1"]);
    const { ports } = await setup([], undefined, "refuses", { projects: PROJECTS, git });

    await expect(ports.clearStaleLocks(() => false)).rejects.toThrow("not a GitError");
    expect(new GitError("worktree", "exit")).toBeInstanceOf(Error);
  });
});
