import type { AtriumClient } from "@atrium/client";
import { type FauxReply, GIT_SCENE_ENV, createGitScene, createTempDir, fauxPi, present } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, vi } from "vitest";
import { newTaskRecord } from "../src/tasks/new-task";
import type { GraphEdge, GraphNode, Task, TaskEventInput } from "../src/tasks/types";
import { type TestHost, startTestHost } from "./harness";

/** Atrium's extension, as the host has pi load it. */
export const ATRIUM_EXTENSION = fileURLToPath(new URL("../../pi/src/extension/atrium.ts", import.meta.url));

/** The name of every task the harness makes; the faux model's scripts begin their conversations with it. */
export const TASK_NAME = "test task";

/**
 * What a node's contract begins with, which names its conversation in a faux script.
 *
 * @remarks
 * `FauxScript.byConversation` tells conversations by their first user message.
 *
 * @sideEffects none
 * @param node - The node's id.
 * @returns The beginning.
 */
export function contractStart(node: string): string {
  return `<atrium-task-node>\n你在任务「${TASK_NAME}」里负责节点 ${node} ·`;
}

/**
 * Whether an executable answers `--version` promptly.
 *
 * @remarks
 * Tells pi from a shim of the same name that waits for something.
 *
 * @sideEffects Runs the executable.
 * @param path - The executable.
 * @returns Whether it printed a version within a few seconds.
 */
function answers(path: string): boolean {
  try {
    return /^\d+\.\d+\.\d+/u.test(
      execFileSync(path, ["--version"], {
        encoding: "utf8",
        timeout: 5000,
        // As the host runs it: nothing of the terminal's own environment.
        env: { PATH: process.env["PATH"] ?? "" },
      }).trim(),
    );
  } catch {
    return false;
  }
}

/**
 * Finds the installed pi.
 *
 * @remarks
 * Only its executable is reused; the faux launch supplies an isolated agent directory.
 *
 * @sideEffects Checks executable paths on disk.
 * @returns The pi executable.
 * @throws {Error} When pi is not installed.
 */
async function realPi(): Promise<string> {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidate = join(directory, "pi");
    if (
      directory !== "" &&
      (await access(candidate).then(
        () => true,
        () => false,
      )) &&
      // A terminal's shim named pi would call the wrapper back (it runs the next `pi` on PATH): not pi.
      !directory.includes("cmux-cli-shims") &&
      answers(candidate)
    )
      return candidate;
  }
  throw new Error("pi is not on PATH; the task tests need it installed");
}

/** What the first message of the conversation tasks are made from starts with, which names it in a faux script. */
export const SOURCE_PROMPT = "Let's plan the out.txt task";

/** What the first message of a task conversation starts with (SPEC-0006, "/task 与创建"). */
export const DESIGN_START = "<atrium-task-design>";

/** The replies of the conversations besides the nodes'. */
export interface TaskHostScripts {
  /** What the task conversation says, in order across its turns (the design turn, then any wake). */
  readonly design?: readonly FauxReply[];
  /** What the source conversation answers to `SOURCE_PROMPT`. */
  readonly source?: readonly FauxReply[];
}

/** A host with a project, a conversation to make tasks from, and a faux model that scripts every node. */
export interface TaskHost {
  /** The conversation tasks are made from. */
  readonly origin: string;
  /** Says `SOURCE_PROMPT` in the source conversation and waits for its reply to end. */
  discuss(): Promise<void>;
  /** The text of a session's file, found by the session's id among the files pi wrote. */
  fileText(sessionId: string): Promise<string>;
  readonly host: TestHost;
  readonly client: AtriumClient;
  /** The project's repository. */
  readonly repo: string;
  /** What the faux model was asked, across all node sessions. */
  readonly contexts: () => Promise<{ readonly tools: readonly string[]; readonly messages: readonly unknown[] }[]>;
  /** Makes a task on the graph, records it and starts it. */
  start(nodes: readonly GraphNode[], edges: readonly GraphEdge[], extra?: Partial<Task>): Promise<Task>;
  /** Records an event for the task. */
  send(taskId: string, event: TaskEventInput): Promise<Task>;
  /** The task as it is. */
  task(taskId: string): Task;
  /** Waits until a condition on the task holds. */
  until(taskId: string, condition: (task: Task) => boolean): Promise<Task>;
  /** The host's home directory. */
  readonly home: string;
  /** Lets a faux reply scripted with `waitFor: name` go on. */
  release(name: string): Promise<void>;
  /** The process id of the pi that last started, which a test can kill. */
  pid(): Promise<number>;
  /** The directory of the task's worktree. */
  worktree(taskId: string): Promise<string>;
  /** Stops the host and starts another on the same files, after `edit` changed them; the tasks are not taken up. */
  restart(edit?: () => Promise<void>): Promise<void>;
}

/**
 * Starts a real host whose pi runs the faux model, with a git project and one conversation.
 *
 * @remarks
 * The scripts are `FauxScript.byConversation`: each node's conversation (told by its contract's first line) is
 * answered from its own list, whichever pi process serves it.
 *
 * @sideEffects Creates temporary directories and a git repository, starts a host and a client; both are
 * stopped when the test finishes.
 * @param conversations - The replies of each node, by node id.
 * @returns The harness.
 */
export async function startTaskHost(
  conversations: Readonly<Record<string, readonly FauxReply[]>>,
  scripts: TaskHostScripts = {},
): Promise<TaskHost> {
  const dir = await createTempDir("task-host");
  onTestFinished(dir.cleanup);
  const scene = await createGitScene("task-host-repo");
  onTestFinished(scene.cleanup);
  const launch = await fauxPi(
    {
      replies: [],
      // The title the host asks for after the source conversation's first exchange.
      title: "A title",
      byConversation: [
        ...Object.entries(conversations).map(([node, replies]) => ({
          startsWith: contractStart(node),
          replies,
        })),
        ...(scripts.design === undefined ? [] : [{ startsWith: DESIGN_START, replies: scripts.design }]),
        { startsWith: SOURCE_PROMPT, replies: scripts.source ?? [{ blocks: [{ type: "text", text: "Understood." }] }] },
      ],
    },
    dir.path,
  );
  await writeFile(join(launch.agentDir, "settings.json"), JSON.stringify({ images: { autoResize: false } }));
  const bin = join(dir.path, "bin");
  await mkdir(bin);
  const quoted = launch.args.map((arg) => `'${arg.replaceAll("'", String.raw`'\''`)}'`).join(" ");
  const wrapper = join(bin, "pi");
  await writeFile(
    wrapper,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then exec "$TASK_REAL_PI" --version; fi\nexec "$TASK_REAL_PI" "$@" ${quoted}\n`,
  );
  await chmod(wrapper, 0o755);
  const home = await createTempDir("task-host-home");
  onTestFinished(home.cleanup);
  const repo = await realpath(scene.repo);
  const env = {
    ...GIT_SCENE_ENV,
    ...launch.env,
    HOME: dir.path,
    PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
    TASK_REAL_PI: await realPi(),
  };
  let counter = 0;

  /**
   * Starts a host on the home, with a client; the project is added the first time.
   *
   * @remarks
   * A second call is a restart of the host over the same files.
   *
   * @sideEffects Starts a host and a client, both stopped when the test finishes.
   * @returns The host, the client, and the id of the conversation tasks are made from.
   */
  async function boot(first: boolean) {
    const host = await startTestHost({ home: home.path, fastExtension: ATRIUM_EXTENSION, toolEnv: env });
    onTestFinished(host.dispose);
    await host.host.tools;
    const client = host.connect();
    onTestFinished(() => client.disconnect());
    await client.connect();
    if (first) await client.addProject(repo);
    await vi.waitFor(() => expect(client.index.getState().workspaces.length).toBeGreaterThan(0));
    return { host, client };
  }

  const first = await boot(true);
  const workspaceId = present(first.client.index.getState().workspaces[0]?.id, "the project's workspace");
  const { sessionId: origin } = await first.client.createSession(workspaceId);
  const current = { ...first };
  const harness: TaskHost = {
    origin,
    async fileText(sessionId) {
      const found = (await readdir(dir.path, { recursive: true })).find((name) => name.endsWith(`_${sessionId}.jsonl`));
      if (found === undefined) throw new Error(`no session file for ${sessionId}`);
      return readFile(join(dir.path, found), "utf8");
    },
    async discuss() {
      await current.client.prompt(origin, SOURCE_PROMPT);
      await vi.waitFor(
        () => {
          const found = current.client.index.getState().sessions.find((one) => one.sessionId === origin);
          // pi writes the file with the first reply, so a persisted, idle session has the exchange on file.
          if (found?.state !== "persisted" || found.running)
            throw new Error("the source conversation is not on file yet");
        },
        { timeout: 30_000, interval: 50 },
      );
    },
    get host() {
      return current.host;
    },
    get client() {
      return current.client;
    },
    repo,
    home: home.path,
    release: (name) => launch.release(name),
    pid: () => launch.pid(),
    contexts: () => launch.contexts(),
    async start(nodes, edges, extra = {}) {
      counter += 1;
      const task = {
        ...newTaskRecord({
          id: `tsk_${String(counter)}`,
          name: TASK_NAME,
          projectId: present(current.client.index.getState().projects[0]?.id, "the project"),
          sourceDir: repo,
          originSessionId: origin,
          taskSessionId: "ses_task",
          model: { providerId: "faux", modelId: "faux-1", thinking: "off" },
          goal: "make out.txt",
          nodes,
          edges,
          now: Date.now(),
        }),
        ...extra,
      };
      await current.host.host.tasks.create(task);
      return current.host.host.tasks.submit(task.id, { type: "started" });
    },
    send: (taskId, event) => current.host.host.tasks.submit(taskId, event),
    task: (taskId) => present(current.host.host.tasks.task(taskId), "the task"),
    async until(taskId, condition) {
      await vi.waitFor(
        () => {
          if (!condition(present(current.host.host.tasks.task(taskId), "the task"))) {
            throw new Error("the task is not there yet");
          }
        },
        { timeout: 30_000, interval: 50 },
      );
      // Whatever the event that got it there still has to do (a commit, a pi to stop) is done too.
      await current.host.host.tasks.idle();
      return present(current.host.host.tasks.task(taskId), "the task");
    },
    worktree(taskId) {
      const id = present(current.host.host.tasks.task(taskId)?.workspaceId, "the task's worktree");
      return vi.waitFor(() => {
        const found = current.client.index.getState().workspaces.find((workspace) => workspace.id === id);
        if (found === undefined) throw new Error("the index does not list the worktree yet");
        return found.dir;
      });
    },
    async restart(edit) {
      await current.host.dispose();
      await edit?.();
      Object.assign(current, await boot(false));
    },
  };
  return harness;
}
