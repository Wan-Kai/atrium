import { GIT_SCENE_ENV, createTempDir } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { startTestHost } from "../../test/harness";
import { TASK_NAME, type TaskHost, startTaskHost } from "../../test/task-harness";
import { systemClock } from "../platform/clock";
import { FOLLOWED_STEPS, fingerprint, followedTask, writeTask } from "./follow-support";
import { openTaskStore } from "./task-store";
import { agent, edges, human, need } from "./test-support";
import type { GraphEdge, GraphNode, Task } from "./types";

vi.setConfig({ testTimeout: 90_000 });

/**
 * Runs git in a directory and returns what it printed.
 *
 * @remarks
 * The scene's environment, so the machine's own git configuration does not matter.
 *
 * @sideEffects Runs git.
 * @param cwd - The directory.
 * @param args - git's arguments.
 * @returns Its output, trimmed.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_SCENE_ENV, encoding: "utf8" }).trim();
}

/**
 * A value a test knows is there.
 *
 * @remarks
 * Keeps the assertions free of optional chaining that would hide a missing value.
 *
 * @sideEffects none
 * @param value - The value.
 * @returns It.
 * @throws {Error} When it is `null` or `undefined`.
 */
function got<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

/** A reply that calls a tool. */
const call = (name: string, id: string, args: Record<string, unknown>) => ({
  blocks: [{ type: "toolCall" as const, id, name, arguments: args as Record<string, never> }],
});

/** A reply that only talks. */
const say = (text: string) => ({ blocks: [{ type: "text" as const, text }] });

/** `node_done` with a summary. */
const done = (id: string, summary: string) => call("node_done", id, { ok: true, summary });

/** A reply that holds until the test releases it, then ends the node. */
const holding = (name: string, summary: string) => ({ waitFor: name, blocks: done(`d-${name}`, summary).blocks });

/** An `ask_user` call with one question of two answers. */
const ask = (id: string) =>
  call("ask_user", id, {
    questions: [
      {
        header: "Scope",
        question: `Which scope (${id})?`,
        multiSelect: false,
        options: [
          { label: "Small", description: "just this" },
          { label: "Large", description: "all of it" },
        ],
      },
    ],
  });

/**
 * Cuts the task's event log to the events before the first of a type, which is what a host that died after the
 * action and before writing its result leaves.
 *
 * @remarks
 * Handed to `restart`, which runs it while the host is down. `task.json` is then behind the log and is rebuilt.
 *
 * @sideEffects Rewrites the task's `events.jsonl` when run.
 * @param harness - The harness.
 * @param taskId - The task.
 * @param type - The type of the event that is not written.
 * @param which - Which event of that type: the first, or the last.
 * @returns What to run while the host is down.
 */
function lostBefore(
  harness: TaskHost,
  taskId: string,
  type: string,
  which: "first" | "last" = "first",
): () => Promise<void> {
  return async () => {
    const path = join(harness.home, "tasks", taskId, "events.jsonl");
    const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");
    const matches = (line: string): boolean => line.includes(`"type":"${type}"`);
    const at = which === "first" ? lines.findIndex(matches) : lines.findLastIndex(matches);
    expect(at, `an event of type ${type} to lose`).toBeGreaterThan(0);
    await writeFile(path, `${lines.slice(0, at).join("\n")}\n`);
  };
}

/**
 * The event types of a task's log, in order.
 *
 * @remarks
 * Read from the file, so it shows what was written, not what is held.
 *
 * @sideEffects Reads a file.
 * @param harness - The harness.
 * @param taskId - The task.
 * @returns The types.
 */
async function loggedTypes(harness: TaskHost, taskId: string): Promise<string[]> {
  const text = await readFile(join(harness.home, "tasks", taskId, "events.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

/**
 * How many session records of the index belong to a node's attempt.
 *
 * @remarks
 * Read from the index file the host keeps in its home.
 *
 * @sideEffects Reads files.
 * @param home - The host's home.
 * @param node - The node.
 * @param attempt - The attempt.
 * @returns The count.
 */
async function recordsOf(home: string, node: string, attempt: number): Promise<number> {
  const file = (await readdir(home, { recursive: true })).find((name) => basename(name) === "sessions.json");
  const index = JSON.parse(await readFile(join(home, got(file)), "utf8")) as {
    sessions: { task?: { node?: string; attempt?: number } }[];
  };
  return index.sessions.filter((one) => one.task?.node === node && one.task.attempt === attempt).length;
}

/**
 * The path of a file of the host's home.
 *
 * @sideEffects Reads a directory.
 * @param home - The host's home.
 * @param name - The file's name.
 * @returns The path.
 */
async function homeFile(home: string, name: string): Promise<string> {
  return join(home, got((await readdir(home, { recursive: true })).find((one) => basename(one) === name)));
}

/** How many worktrees the repository has, the main checkout included. */
function worktreeCount(repo: string): number {
  return git(repo, "worktree", "list", "--porcelain").match(/^worktree /gmu)?.length ?? 0;
}

/** How many branches the tasks made. */
function taskBranches(repo: string): string[] {
  return git(repo, "branch", "--list", "atrium/*", "--format=%(refname:short)")
    .split("\n")
    .filter((line) => line !== "");
}

/**
 * Whether the conversation has named the task and proposed its first graph.
 *
 * @remarks
 * What a task waits for before it is started.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns Whether it has.
 */
function isDesigned(task: Task): boolean {
  return task.activeGraph === 1 && task.name === TASK_NAME;
}

/** The node's latest run. */
function runOf(task: Task, node: string) {
  return need(task.runs.findLast((run) => run.node === node));
}

/** Waits until the host has taken the task up and the task satisfies a condition. */
function reaches(harness: TaskHost, taskId: string, condition: (task: Task) => boolean): Promise<Task> {
  return harness.until(taskId, condition);
}

/** The prompt text the model was last asked, as one string. */
async function lastAsked(harness: TaskHost): Promise<string> {
  return JSON.stringify((await harness.contexts()).at(-1)?.messages);
}

/** How many times the contract of a node is in a text. */
const contractsIn = (text: string): number => text.match(/<atrium-task-node>\\n你在任务/gu)?.length ?? 0;

/** A table row: one action, the moment after it and before its event, and what must not repeat. */
interface Crash {
  readonly action: string;
  readonly run: () => Promise<void>;
}

/** A work node that writes a file, then a human node to stop at. */
const WRITES = [call("write", "w1", { path: "./a.txt", content: "a\n" }), done("d1", "Wrote a.txt.")];

const CRASHES: readonly Crash[] = [
  {
    action: "create the worktree (workspace_created is lost)",
    async run() {
      const harness = await startTaskHost({ N1: [holding("hold", "wrote")] });
      const task = await harness.start([agent("N1", "work")], []);
      const before = await reaches(harness, task.id, (now) => now.runs[0]?.sessionId != null);
      expect(worktreeCount(harness.repo)).toBe(2);

      await harness.restart(lostBefore(harness, task.id, "workspace_created"));
      await harness.release("hold");
      const finished = await reaches(harness, task.id, (now) => now.endedAt !== null);

      expect(finished.workspaceId).toBe(before.workspaceId);
      expect(worktreeCount(harness.repo)).toBe(2);
      expect(taskBranches(harness.repo)).toHaveLength(1);
      expect(await recordsOf(harness.home, "N1", 1)).toBe(1);
    },
  },
  {
    action: "create the worktree (git added it, the host died before recording it or its mark)",
    async run() {
      const harness = await startTaskHost({ N1: [holding("hold", "wrote")] });
      const task = await harness.start([agent("N1", "work")], []);
      const before = await reaches(harness, task.id, (now) => now.runs[0]?.sessionId != null);
      const dir = await harness.worktree(task.id);
      const start = git(dir, "rev-parse", "HEAD");
      const source = got(harness.client.index.getState().workspaces.find((one) => one.dir === harness.repo)?.id);

      await harness.restart(async () => {
        await lostBefore(harness, task.id, "workspace_created")();
        // What the host leaves when it dies after `git worktree add`: the plan in the task's directory, and no
        // workspace record for the new worktree.
        const marker = join(harness.home, "tasks", task.id, "workspace.json");
        const branch = git(dir, "branch", "--show-current");
        await writeFile(marker, `${JSON.stringify({ planned: { source, branch, dir, start } })}\n`);
        const projectsPath = await homeFile(harness.home, "projects.json");
        const projects = JSON.parse(await readFile(projectsPath, "utf8")) as { workspaces: { dir: string }[] };
        projects.workspaces = projects.workspaces.filter((one) => one.dir !== dir);
        await writeFile(projectsPath, JSON.stringify(projects));
      });
      await harness.release("hold");
      const finished = await reaches(harness, task.id, (now) => now.endedAt !== null);

      // The same worktree, recorded again; no second one.
      expect(finished.workspaceId).not.toBeNull();
      expect(await harness.worktree(task.id)).toBe(dir);
      expect(before.workspaceId).not.toBe(finished.workspaceId);
      expect(worktreeCount(harness.repo)).toBe(2);
      expect(taskBranches(harness.repo)).toHaveLength(1);
      expect(JSON.parse(await readFile(join(harness.home, "tasks", task.id, "workspace.json"), "utf8"))).toStrictEqual({
        workspaceId: finished.workspaceId,
      });
    },
  },
  {
    action: "start a node (node_started is lost; its session exists)",
    async run() {
      const harness = await startTaskHost({ N1: [holding("hold", "after the restart")] });
      const task = await harness.start([agent("N1", "explore")], []);
      await reaches(harness, task.id, (now) => now.runs[0]?.sessionId != null);
      await vi.waitFor(async () => expect(await harness.contexts()).toHaveLength(1));

      await harness.restart(lostBefore(harness, task.id, "node_started"));
      await harness.release("hold");
      const finished = await reaches(harness, task.id, (now) => now.endedAt !== null);

      expect(runOf(finished, "N1")).toMatchObject({ state: "passed", summary: "after the restart" });
      expect(await recordsOf(harness.home, "N1", 1)).toBe(1);
      expect(contractsIn(await lastAsked(harness))).toBe(1);
    },
  },
  {
    action: "send the contract (contract_sent is lost; pi has it on file)",
    async run() {
      const harness = await startTaskHost({
        N1: [call("bash", "b1", { command: "echo hi" }), holding("hold", "after the restart")],
      });
      const task = await harness.start([agent("N1", "explore")], []);
      await reaches(harness, task.id, (now) => now.runs[0]?.contractSent === true);
      // The tool result has gone back to the model, so pi has written the contract into its file.
      await vi.waitFor(async () => expect(await harness.contexts()).toHaveLength(2));

      await harness.restart(lostBefore(harness, task.id, "contract_sent"));
      await harness.release("hold");
      const finished = await reaches(harness, task.id, (now) => now.endedAt !== null);

      expect(runOf(finished, "N1")).toMatchObject({ state: "passed", contractSent: true });
      const asked = await lastAsked(harness);
      // Told once, and that the host restarted; not given the contract a second time.
      expect(contractsIn(asked)).toBe(1);
      expect(asked).toContain("宿主重启了");
    },
  },
  {
    action: "settle a node (node_settled is lost; its turn ended on node_done) and commit it",
    async run() {
      const harness = await startTaskHost({ N1: WRITES });
      const task = await harness.start([agent("N1", "work"), human("H")], edges(["N1", "H"]));
      await reaches(harness, task.id, (now) => runOf(now, "H").state === "waiting");
      const dir = await harness.worktree(task.id);
      const commit = git(dir, "rev-parse", "HEAD");
      const asked = (await harness.contexts()).length;

      await harness.restart(lostBefore(harness, task.id, "node_settled"));
      const finished = await reaches(harness, task.id, (now) => runOf(now, "H").state === "waiting");

      expect(runOf(finished, "N1")).toMatchObject({ state: "passed", commit });
      expect(git(dir, "rev-list", "--count", "main..HEAD")).toBe("1");
      // Settled, not sent back to work: the model was asked nothing more, and told nothing about a restart.
      expect((await harness.contexts()).length).toBe(asked);
      const types = await loggedTypes(harness, task.id);
      expect(types.indexOf("node_settled")).toBeLessThan(types.indexOf("host_restarted"));
    },
  },
  {
    action: "commit a node (committed is lost)",
    async run() {
      const harness = await startTaskHost({ N1: WRITES });
      const task = await harness.start([agent("N1", "work"), human("H")], edges(["N1", "H"]));
      await reaches(harness, task.id, (now) => runOf(now, "H").state === "waiting");
      const dir = await harness.worktree(task.id);
      const commit = git(dir, "rev-parse", "HEAD");

      await harness.restart(lostBefore(harness, task.id, "committed"));
      const finished = await reaches(harness, task.id, (now) => runOf(now, "N1").commit === commit);

      expect(runOf(finished, "N1").state).toBe("passed");
      expect(git(dir, "rev-list", "--count", "main..HEAD")).toBe("1");
      expect(git(dir, "rev-parse", "HEAD")).toBe(commit);
    },
  },
  {
    action: "merge the branch (merged is lost)",
    async run() {
      const harness = await startTaskHost({ N1: WRITES });
      const task = await harness.start([agent("N1", "work"), human("H", { merge: true })], edges(["N1", "H"]));
      await reaches(harness, task.id, (now) => runOf(now, "H").state === "waiting");
      await harness.host.host.tasks.answerHuman(task.id, "H", { kind: "pass" });
      await reaches(harness, task.id, (now) => now.endedAt !== null);
      const merged = git(harness.repo, "rev-parse", "main");
      expect(git(harness.repo, "rev-list", "--merges", "--count", "main")).toBe("1");

      await harness.restart(lostBefore(harness, task.id, "merged"));
      const finished = await reaches(harness, task.id, (now) => now.endedAt !== null);

      expect(runOf(finished, "H").state).toBe("passed");
      // The merge was recognised, not made again: the same commit, and still the one merge.
      expect(git(harness.repo, "rev-parse", "main")).toBe(merged);
      expect(git(harness.repo, "rev-list", "--merges", "--count", "main")).toBe("1");
      expect(git(harness.repo, "status", "--porcelain")).toBe("");
    },
  },
  {
    action: "archive the worktree (archive_answered is lost)",
    async run() {
      const harness = await startTaskHost({ N1: WRITES });
      const task = await harness.start([agent("N1", "work"), human("H", { merge: true })], edges(["N1", "H"]));
      await reaches(harness, task.id, (now) => runOf(now, "H").state === "waiting");
      await harness.host.host.tasks.answerHuman(task.id, "H", { kind: "pass" });
      await reaches(harness, task.id, (now) => now.archive === "asked");
      await harness.host.host.tasks.answerArchive(task.id, "archive");
      expect(harness.task(task.id).archive).toBe("archived");

      await harness.restart(lostBefore(harness, task.id, "archive_answered"));
      await reaches(harness, task.id, (now) => now.archive === "asked");
      // Asked again: the answer is given a second time over a worktree that is already archived.
      await harness.host.host.tasks.answerArchive(task.id, "archive");

      expect(harness.task(task.id).archive).toBe("archived");
      expect(worktreeCount(harness.repo)).toBe(1);
      expect((await loggedTypes(harness, task.id)).filter((type) => type === "archive_answered")).toHaveLength(1);
    },
  },
  {
    action: "ask a question (the host dies while it is open)",
    async run() {
      const harness = await startTaskHost({ N1: [ask("q1"), ask("q2"), done("d1", "Went with small.")] });
      const task = await harness.start([agent("N1", "explore")], []);
      const asking = await reaches(harness, task.id, (now) => now.runs[0]?.waitingFor === "question");
      const sessionId = got(asking.runs[0]?.sessionId);

      await harness.restart();
      await harness.client.watch([sessionId]);
      // The question died with pi. The node is told so, and asks again: a new card, not the old one.
      await vi.waitFor(async () => expect(await lastAsked(harness)).toContain("刚才的问题作废了"));
      await reaches(harness, task.id, (now) => now.runs[0]?.waitingFor === "question");
      await vi.waitFor(() => expect(harness.client.session(sessionId)?.getState().control.question?.id).toBe("q2"));
      await harness.client.answerQuestion(sessionId, "q2", { answers: [{ selected: [0], other: null }] });
      const finished = await reaches(harness, task.id, (now) => now.endedAt !== null);

      expect(runOf(finished, "N1")).toMatchObject({ state: "passed", summary: "Went with small." });
      expect(await recordsOf(harness.home, "N1", 1)).toBe(1);
    },
  },
  {
    action: "answer a question (node_resumed is lost)",
    async run() {
      const harness = await startTaskHost({ N1: [ask("q1"), holding("hold", "after the answer")] });
      const task = await harness.start([agent("N1", "explore")], []);
      const asking = await reaches(harness, task.id, (now) => now.runs[0]?.waitingFor === "question");
      await harness.client.answerQuestion(got(asking.runs[0]?.sessionId), "q1", {
        answers: [{ selected: [0], other: null }],
      });
      await vi.waitFor(async () => expect(await harness.contexts()).toHaveLength(2));

      await harness.restart(lostBefore(harness, task.id, "node_resumed"));
      await harness.release("hold");
      const finished = await reaches(harness, task.id, (now) => now.endedAt !== null);

      expect(runOf(finished, "N1")).toMatchObject({ state: "passed", summary: "after the answer" });
      expect(await recordsOf(harness.home, "N1", 1)).toBe(1);
    },
  },
];

describe("a host that dies when an action is done and its event is not written does not do it twice (SPEC-0006, T9)", () => {
  it.each(CRASHES)("$action", async ({ run }) => {
    await expect(run()).resolves.toBeUndefined();
  });
});

describe("the worktree of a plan is only the task's when it is exactly what the plan said", () => {
  it("makes another worktree, and leaves the first alone, when the one at the plan's place has a commit of someone's own", async () => {
    const harness = await startTaskHost({ N1: [holding("hold", "wrote")] });
    const task = await harness.start([agent("N1", "work")], []);
    await reaches(harness, task.id, (now) => now.runs[0]?.sessionId != null);
    const dir = await harness.worktree(task.id);
    const start = git(dir, "rev-parse", "HEAD");
    const branch = git(dir, "branch", "--show-current");
    const source = got(harness.client.index.getState().workspaces.find((one) => one.dir === harness.repo)?.id);

    await harness.restart(async () => {
      await lostBefore(harness, task.id, "workspace_created")();
      await writeFile(
        join(harness.home, "tasks", task.id, "workspace.json"),
        `${JSON.stringify({ planned: { source, branch, dir, start } })}\n`,
      );
      // Someone's own work is in it: it is no longer the fresh checkout the plan was about.
      await writeFile(join(dir, "mine.txt"), "my own work\n");
      git(dir, "add", "mine.txt");
      git(dir, "commit", "--quiet", "-m", "my own commit");
      const projectsPath = await homeFile(harness.home, "projects.json");
      const projects = JSON.parse(await readFile(projectsPath, "utf8")) as { workspaces: { dir: string }[] };
      projects.workspaces = projects.workspaces.filter((one) => one.dir !== dir);
      await writeFile(projectsPath, JSON.stringify(projects));
    });
    await harness.release("hold");
    const finished = await reaches(harness, task.id, (now) => now.endedAt !== null);

    expect(await harness.worktree(task.id)).toBe(`${dir}-2`);
    expect(finished.baseCommit).toBe(start);
    expect(worktreeCount(harness.repo)).toBe(3);
    expect(git(dir, "log", "-1", "--format=%s")).toBe("my own commit");
    expect(taskBranches(harness.repo).toSorted()).toStrictEqual([branch, `${branch}-2`].toSorted());
  });
});

describe("a node whose turn had ended is settled, not sent back to work", () => {
  it("passes an explore node whose node_done turn ended before the restart, and asks the model nothing", async () => {
    const harness = await startTaskHost({ N1: [done("d1", "Explored.")] });
    const task = await harness.start([agent("N1", "explore"), human("H")], edges(["N1", "H"]));
    await reaches(harness, task.id, (now) => runOf(now, "H").state === "waiting");
    expect(await harness.contexts()).toHaveLength(1);

    // The log ends with N1's `node_done`, before its turn was settled.
    await harness.restart(lostBefore(harness, task.id, "node_settled"));
    const finished = await reaches(harness, task.id, (now) => runOf(now, "H").state === "waiting");

    expect(runOf(finished, "N1")).toMatchObject({ state: "passed", summary: "Explored." });
    // Nothing was said to the model, and nothing about a restart: its turn was over, and so was its step.
    const asked = (await harness.contexts()).map((context) => JSON.stringify(context.messages));
    expect(asked).toHaveLength(1);
    expect(asked.join("")).not.toContain("宿主重启了");
    expect(await recordsOf(harness.home, "N1", 1)).toBe(1);
    const types = await loggedTypes(harness, task.id);
    expect(types.indexOf("node_settled")).toBeLessThan(types.indexOf("host_restarted"));
  });
});

/** The summary the task conversation writes. */
const SUMMARY = {
  goal: "make out.txt",
  decisions: [],
  constraints: [],
  nonGoals: [],
  openQuestions: [],
  acceptance: [],
};

/** A graph as the conversation's tool takes it. */
const graph = (nodes: readonly GraphNode[], graphEdges: readonly GraphEdge[]) => ({
  nodes: nodes as unknown as Record<string, never>[],
  edges: graphEdges as unknown as Record<string, never>[],
});

/** The task conversation's first turn: names the task and proposes two steps. */
const DESIGN_TURN = [
  call("task_set_summary", "t0", { summary: SUMMARY }),
  call("task_set_meta", "t1", { name: TASK_NAME }),
  call("task_propose_graph", "t2", {
    ...graph([agent("N1"), agent("N2")], edges(["N1", "N2"])),
    note: "two steps",
    guide: "research",
  }),
  say("Two steps."),
];

/** What the conversation does when it is woken: look, then propose N3 after N2. */
const wakeTurn = (suffix: string) => [
  call("task_status", `s${suffix}`, {}),
  call("task_propose_graph", `p${suffix}`, {
    ...graph([agent("N1"), agent("N2"), agent("N3")], edges(["N1", "N2"], ["N2", "N3"])),
    note: `add N3 (${suffix})`,
  }),
  say(`Proposed (${suffix}); please approve.`),
];

/**
 * The text of the task conversation's file.
 *
 * @remarks
 * What pi wrote: every wake-up the conversation was given is in it, with the words that came with it.
 *
 * @sideEffects Reads a file.
 * @param harness - The harness.
 * @param taskId - The task.
 * @returns The text.
 */
async function conversationFile(harness: TaskHost, taskId: string): Promise<string> {
  return harness.fileText(harness.task(taskId).taskSessionId);
}

/** How many times a text is in another. */
const timesIn = (text: string, part: string): number => text.split(part).length - 1;

/** A task whose N2 asks for a graph change, woken once; stops when the proposal is waiting. */
async function taskAskingForChange(second: boolean) {
  const harness = await startTaskHost(
    {
      N1: [done("d1", "first")],
      N2: [
        call("request_graph_change", "g1", { reason: "A check step is missing.", suggestion: "Add N3 after N2." }),
        done("d2", "N2 after the change"),
      ],
      N3: [done("d3", "checked")],
    },
    { design: [...DESIGN_TURN, ...wakeTurn("one"), ...(second ? wakeTurn("two") : [])] },
  );
  await harness.discuss();
  const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
  await harness.until(taskId, isDesigned);
  await harness.host.host.tasks.start(taskId);
  return { harness, taskId };
}

describe("a graph change that was asked for survives a restart (SPEC-0006, T9)", () => {
  it("keeps waiting for the user's verdict on a proposal that was written, and does not wake the conversation again", async () => {
    const { harness, taskId } = await taskAskingForChange(false);
    await harness.until(taskId, (now) => now.pendingGraph !== null);
    const woken = timesIn(await conversationFile(harness, taskId), "A check step is missing.");
    expect(woken).toBe(1);

    await harness.restart();
    // The host took the task up and told it the host restarted; what that sent is done once its queue is.
    await vi.waitFor(async () => expect(await loggedTypes(harness, taskId)).toContain("host_restarted"));
    await harness.host.host.tasks.idle();

    const held = harness.task(taskId);
    expect(held.pendingGraph).toBe(2);
    expect(held.graphs).toHaveLength(2);
    expect(runOf(held, "N2")).toMatchObject({ state: "waiting", waitingFor: "graph_change" });
    // Asked again by no one: the conversation was not started.
    expect(timesIn(await conversationFile(harness, taskId), "A check step is missing.")).toBe(woken);

    await harness.host.host.tasks.approveGraph(taskId);
    const finished = await harness.until(taskId, (now) => now.endedAt !== null);
    expect(finished.runs.map((run) => [run.node, run.state])).toStrictEqual([
      ["N1", "passed"],
      ["N2", "passed"],
      ["N3", "passed"],
    ]);
  });

  it("wakes the conversation again, with the node's reason and suggestion, for a proposal that was never written", async () => {
    const { harness, taskId } = await taskAskingForChange(true);
    await harness.until(taskId, (now) => now.pendingGraph !== null);
    expect(timesIn(await conversationFile(harness, taskId), "A check step is missing.")).toBe(1);

    // The proposal was lost; so was the verdict. The reason the node gave is on the run, in the log.
    await harness.restart(lostBefore(harness, taskId, "graph_proposed", "last"));
    await harness.until(taskId, (now) => now.pendingGraph !== null);

    const held = harness.task(taskId);
    expect(held.graphs).toHaveLength(2);
    expect(held.pendingGraph).toBe(2);
    // The second wake-up carries the same words as the first, from the log: the reason and the suggestion, quoted.
    const file = await conversationFile(harness, taskId);
    expect(timesIn(file, "A check step is missing.")).toBe(2);
    expect(timesIn(file, "Add N3 after N2.")).toBeGreaterThanOrEqual(2);
    expect(timesIn(file, '<atrium-quoted from=\\"N2 · node N2\\">')).toBeGreaterThanOrEqual(4);
  });
});

describe("the task conversation after a restart", () => {
  it("is read again once its pi is asked for with open_task_session, with what was said before", async () => {
    const harness = await startTaskHost({}, { design: [...DESIGN_TURN] });
    await harness.discuss();
    const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
    const task = await harness.until(taskId, isDesigned);
    await vi.waitFor(async () => expect(await harness.fileText(task.taskSessionId)).toContain("Two steps."));

    await harness.restart();
    const { client } = harness;
    await client.watch([task.taskSessionId]);
    // Its pi is not running: there is nothing to read yet.
    expect(client.session(task.taskSessionId)?.getState().status).not.toBe("ready");
    await client.openTaskSession(taskId, task.taskSessionId);

    await vi.waitFor(() => expect(client.session(task.taskSessionId)?.getState().status).toBe("ready"));
    await vi.waitFor(() =>
      expect(JSON.stringify(client.session(task.taskSessionId)?.getState().items)).toContain("Two steps."),
    );
  });
});

describe("locks that tasks left (SPEC-0006, 加锁)", () => {
  it("lifts those of a task that is over or unknown when the host starts, and leaves the user's and a live task's", async () => {
    const harness = await startTaskHost({ N1: [done("d1", "wrote")], N2: [holding("hold", "live")] });
    const finishedTask = await harness.start([agent("N1", "work")], []);
    await reaches(harness, finishedTask.id, (now) => now.endedAt !== null);
    const live = await harness.start([agent("N2", "work")], []);
    await reaches(harness, live.id, (now) => now.runs[0]?.sessionId != null);
    const finishedDir = await harness.worktree(finishedTask.id);
    const liveDir = await harness.worktree(live.id);
    // The worktrees of a ghost task and of the user, made by hand.
    const ghost = join(harness.repo, "..", "ghost-wt");
    const mine = join(harness.repo, "..", "mine-wt");
    git(harness.repo, "worktree", "add", "--quiet", "-b", "ghost", ghost);
    git(harness.repo, "worktree", "add", "--quiet", "-b", "mine", mine);
    git(harness.repo, "worktree", "lock", "--reason", "atrium task tsk_ghost", ghost);
    git(harness.repo, "worktree", "lock", "--reason", "mine, do not touch", mine);
    git(harness.repo, "worktree", "lock", "--reason", `atrium task ${finishedTask.id}`, finishedDir);

    await harness.restart();

    /**
     * The reason a worktree is locked for in git's listing, as the host leaves it.
     *
     * @remarks
     * The sweep runs in the background once the host has taken the tasks up, so the test reads again until it is done.
     *
     * @sideEffects Runs git.
     * @param dir - The worktree.
     * @returns The `locked …` line, or `undefined` when it is not locked.
     */
    const lockOf = (dir: string) =>
      new RegExp(`worktree ${dir}\\n[^\\n]*\\n[^\\n]*\\n(locked[^\\n]*)`, "u").exec(
        git(harness.repo, "worktree", "list", "--porcelain"),
      )?.[1];
    await vi.waitFor(() => {
      expect(lockOf(finishedDir)).toBeUndefined();
      expect(lockOf(ghost)).toBeUndefined();
    });
    expect(lockOf(mine)).toBe("locked mine, do not touch");
    expect(lockOf(liveDir)).toBe(`locked atrium task ${live.id}`);
    await harness.release("hold");
  });
});

describe("tasks that must not be taken up", () => {
  it("leaves a followed task alone, with pi ready and the task running, and takes up its own", async () => {
    const followed = await createTempDir("t9-followed");
    onTestFinished(followed.cleanup);
    const directory = join(followed.path, "tasks");
    const writer = await writeTask(directory, followedTask("tsk_try"));
    // Running: N1 passed, N2 started, with a session of the other process.
    for (const step of FOLLOWED_STEPS.slice(0, 4)) await writer.record(step);
    const harness = await startTaskHost(
      { N1: [holding("hold", "own, after the restart")] },
      {},
      { followTasks: directory },
    );
    const task = await harness.start([agent("N1", "explore")], []);
    await reaches(harness, task.id, (now) => now.runs[0]?.sessionId != null);
    const before = await fingerprint(directory);

    await harness.restart();
    await harness.release("hold");
    const finished = await reaches(harness, task.id, (now) => now.endedAt !== null);

    expect(runOf(finished, "N1").summary).toBe("own, after the restart");
    expect(await fingerprint(directory)).toStrictEqual(before);
    // It is on the list, as followed; no session of it was started and no lock of anyone's was lifted for it.
    expect(harness.host.host.tasks.held().map((held) => held.id)).toStrictEqual(
      expect.arrayContaining(["tsk_try", task.id]),
    );
    expect(await recordsOf(harness.home, "N2", 1)).toBe(0);
    expect(await readdir(join(harness.home, "tasks"))).toStrictEqual([task.id]);
  });

  it("leaves tasks as they are, and says so once, when pi is not ready; those that need no pi still get their locks lifted", async () => {
    const home = await createTempDir("t9-no-pi-home");
    onTestFinished(home.cleanup);
    const store = await openTaskStore(join(home.path, "tasks", "tsk_going"), systemClock);
    const task = followedTask("tsk_going");
    await store.record({ type: "created", task });
    await store.record({ type: "started" });
    const path = join(home.path, "tasks", "tsk_going", "events.jsonl");
    const written = await readFile(path, "utf8");
    // An empty PATH finds no pi (the default of the test host).
    const host = await startTestHost({ home: home.path });
    onTestFinished(host.dispose);
    host.expectLog({ level: "warn", msg: "tasks not recovered: pi is not ready", times: 1 });

    await vi.waitFor(async () =>
      expect((await host.readLog()).some((record) => record["msg"] === "tasks not recovered: pi is not ready")).toBe(
        true,
      ),
    );
    await host.host.tasks.idle();

    expect(await readFile(path, "utf8")).toBe(written);
    expect(host.host.tasks.held().map((held) => held.id)).toStrictEqual(["tsk_going"]);
  });

  it("takes up nothing and says nothing when there are no tasks, with or without pi", async () => {
    const host = await startTestHost();
    onTestFinished(host.dispose);

    await host.host.tasks.idle();

    expect((await host.readLog()).filter((record) => record["level"] === "warn")).toStrictEqual([]);
  });
});
