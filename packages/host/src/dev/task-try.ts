import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ThinkingLevel } from "@atrium/protocol";
import { systemClock } from "../platform/clock";
import { readLoginShellEnv } from "../platform/login-shell";
import { type RunningHost, startHost } from "../main";
import { activeGraphOf, latestRun } from "../tasks/graph";
import { validateGraph } from "../tasks/graph-validator";
import { newTaskRecord } from "../tasks/new-task";
import { deriveStatus } from "../tasks/status";
import { GraphEdge, GraphNode, type Task, type TaskEvent } from "../tasks/types";
import { describeEvent, describeNodes } from "./task-replay";

const USAGE = "usage: pnpm task:try <graph.json> [--repo <dir>] [--model <provider/model[:thinking]>] [--home <dir>]";

/** What `pnpm task:try` was asked to do. */
export interface TaskTryOptions {
  /** The graph file. */
  readonly graphFile: string;
  /** The repository the task works on. */
  readonly repo: string;
  /** `provider/model[:thinking]`, or `null` for pi's own default. */
  readonly model: string | null;
  /** Where the task's files and the host's index live. */
  readonly home: string;
}

/** A graph file: the task's name and goal, and its graph. */
const GraphFile = z.strictObject({
  name: z.string().min(1),
  goal: z.string().min(1),
  nodes: z.array(GraphNode).min(1),
  edges: z.array(GraphEdge),
});

/**
 * Parses the command line of `pnpm task:try`.
 *
 * @remarks
 * The repository defaults to the directory the command was typed in. The home, where the task's events,
 * the host's index and the sessions' files are kept, defaults to `<repository>.task-try` beside the
 * repository, outside it: a second run of the same command finds it and carries on.
 *
 * @sideEffects none
 * @param argv - Arguments after the script name.
 * @param defaultCwd - The directory the command was typed in.
 * @returns The options, or a usage error.
 */
export function parseTaskTryArgs(
  argv: readonly string[],
  defaultCwd: string,
): TaskTryOptions | { readonly error: string } {
  let graphFile: string | undefined;
  let repo = defaultCwd;
  let model: string | null = null;
  let home: string | null = null;
  const rest = [...argv];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (arg === "--repo" || arg === "--model" || arg === "--home") {
      const value = rest.shift();
      if (value === undefined) return { error: `${arg} needs a value\n${USAGE}` };
      if (arg === "--repo") repo = resolve(defaultCwd, value);
      else if (arg === "--model") model = value;
      else home = resolve(defaultCwd, value);
    } else if (arg.startsWith("--")) return { error: `unknown option ${arg}\n${USAGE}` };
    else if (graphFile === undefined) graphFile = resolve(defaultCwd, arg);
    else return { error: USAGE };
  }
  if (graphFile === undefined) return { error: USAGE };
  return { graphFile, repo, model, home: home ?? join(dirname(repo), `${basename(repo)}.task-try`) };
}

/**
 * Reads a graph file and checks the graph with the rules of the start.
 *
 * @remarks
 * Fails with the first problem's code, as the task conversation's tool would report it.
 *
 * @sideEffects Reads the file.
 * @param path - The file.
 * @returns The task's name, goal and graph.
 * @throws {Error} When the file is not a graph file or the graph breaks a rule.
 */
export async function readGraphFile(path: string): Promise<z.infer<typeof GraphFile>> {
  const file = GraphFile.parse(JSON.parse(await readFile(path, "utf8")));
  const problems = validateGraph(file, { projectless: false, localReadonly: false });
  if (problems.length > 0) {
    throw new Error(
      `the graph is not valid: ${problems.map((one) => `${one.code}${one.node === undefined ? "" : ` ${one.node}`}`).join(", ")}`,
    );
  }
  return file;
}

/**
 * The task's id for a graph file and a repository, the same every time.
 *
 * @remarks
 * So that running the command again finds the task it started and carries on.
 *
 * @sideEffects none
 * @param graphFile - The graph file's path.
 * @param repo - The repository's path.
 * @returns The id.
 */
export function taskIdFor(graphFile: string, repo: string): string {
  return `tsk_try_${createHash("sha256").update(`${graphFile}\n${repo}`).digest("hex").slice(0, 10)}`;
}

/**
 * The model to run the task on.
 *
 * @remarks
 * `--model provider/model[:thinking]`, else the default in pi's own settings.
 *
 * @sideEffects Reads pi's settings when no model is given.
 * @param flag - The `--model` value.
 * @param env - The tool environment, which says where pi's settings are.
 * @returns The model.
 * @throws {Error} When no model is given and pi's settings name none.
 */
export async function modelFor(
  flag: string | null,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Task["model"]> {
  if (flag !== null) {
    const [name = "", level] = flag.split(":");
    const slash = name.indexOf("/");
    if (slash <= 0 || slash === name.length - 1)
      throw new Error("--model is provider/model, such as anthropic/claude-sonnet-4");
    return {
      providerId: name.slice(0, slash),
      modelId: name.slice(slash + 1),
      thinking: ThinkingLevel.parse(level ?? "off"),
    };
  }
  const agentDir = env["PI_CODING_AGENT_DIR"] ?? join(env["HOME"] ?? "", ".pi", "agent");
  const settings: unknown = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8").catch(() => "{}"));
  const provider: unknown = Reflect.get(Object(settings), "defaultProvider");
  const model: unknown = Reflect.get(Object(settings), "defaultModel");
  if (typeof provider !== "string" || typeof model !== "string")
    throw new Error("pass --model: pi's settings name no default model");
  const level = ThinkingLevel.safeParse(Reflect.get(Object(settings), "defaultThinkingLevel"));
  return { providerId: provider, modelId: model, thinking: level.success ? level.data : "off" };
}

/**
 * One line for the terminal about an event.
 *
 * @remarks
 * The time, the event's type and payload, and for a few events what the node said: a hand-over summary or a
 * commit.
 *
 * @sideEffects none
 * @param task - The task after the event.
 * @param event - The event.
 * @returns The lines, without line breaks at their ends.
 */
export function describeProgress(task: Task, event: TaskEvent): string[] {
  const time = new Date(event.at).toISOString().slice(11, 19);
  const detail = describeEvent(event);
  const lines = [`${time} #${String(event.seq)} ${event.type}${detail === "" ? "" : ` ${detail}`}`];
  if (event.type === "node_settled" || event.type === "committed") {
    const run = latestRun(task, event.node);
    if (event.type === "committed") lines.push(`    commit ${event.commit}`);
    else if (run?.summary != null) lines.push(...run.summary.split("\n").map((line) => `    | ${line}`));
  }
  return lines;
}

/** Where `runTaskTry` writes. */
export interface TaskTryOutput {
  write(text: string): void;
}

/**
 * Why the run stopped, and the exit code that goes with it.
 *
 * @remarks
 * The task ended, a node failed, or the task waits for something `task:try` cannot give: a human node
 * (T5) or the answer to a question.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns The code and a line, or `null` while the task goes on.
 */
export function stopReason(task: Task): { readonly code: number; readonly line: string } | null {
  const status = deriveStatus(task);
  if (status === "done") return { code: 0, line: "the task is done" };
  if (status === "cancelled") return { code: 1, line: "the task was cancelled" };
  const graph = activeGraphOf(task);
  for (const node of graph?.nodes ?? []) {
    const run = latestRun(task, node.id);
    if (run?.state === "failed") return { code: 1, line: `${node.id} failed: ${run.failure ?? "unknown"}` };
    if (run?.state === "waiting" && run.waitingFor === "human") {
      return { code: 0, line: `stopped at the human node ${node.id}: answering it comes with the app (T5)` };
    }
    if (run?.state === "waiting" && run.waitingFor === "question") {
      return {
        code: 3,
        line: `${node.id} asked a question; task:try cannot answer it, run the command again to let it go on`,
      };
    }
    if (run?.state === "waiting" && run.waitingFor === "graph_change") {
      return { code: 3, line: `${node.id} asked for the graph to change; the task conversation (T6) handles that` };
    }
  }
  return null;
}

/**
 * Runs a graph with real nodes, without the app: the host, a project, the task and its events on the terminal.
 *
 * @remarks
 * The narrowest path through the task runner (roadmap T4): a real host in this process, the repository
 * registered as a project, the task started with the graph file's graph, no UI and no `/task`. The task's
 * files stay in the home, so after Ctrl+C the same command carries on: the task is opened again, `recover`
 * does again what was lost, and a commit with the node's trailer is found, not made twice. It stops at a
 * human node, a failure, or a question.
 *
 * @sideEffects Starts a host (and so pi) with its files under `options.home`; registers the repository as
 * a project; makes a worktree and commits in it; writes to `out` until it stops.
 * @param options - The graph, repository, model and home.
 * @param io - The process environment, where to write, and an abort signal for Ctrl+C.
 * @returns The exit code: 0 when the task ended or reached a human node, 1 when a node failed, 3 when it
 * waits for an answer, 130 when interrupted.
 */
export async function runTaskTry(
  options: TaskTryOptions,
  io: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly out: TaskTryOutput;
    readonly signal: AbortSignal;
    /** The extension pi loads in the nodes; the bundle's own by default. */
    readonly extension?: string;
  },
): Promise<number> {
  const file = await readGraphFile(options.graphFile);
  const repo = await realpath(options.repo);
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  const login = await readLoginShellEnv({ shell: io.env["SHELL"], env: io.env, clock: systemClock, signal: io.signal });
  const model = await modelFor(options.model, login.env);
  const taskId = taskIdFor(options.graphFile, repo);
  // The sessions' files stay with the task, not among the sessions of the user's own pi.
  const host: RunningHost = await startHost({
    home: options.home,
    token: randomBytes(24).toString("hex"),
    logLevel: "info",
    toolEnv: { ...login.env, PI_CODING_AGENT_SESSION_DIR: join(options.home, "pi-sessions") },
    fastExtension: io.extension ?? join(__dirname, "atrium-extension.mjs"),
    piLatestUrl: null,
  });
  const finished = Promise.withResolvers<{ code: number; line: string }>();
  /**
   * Ends the run when Ctrl+C comes.
   *
   * @remarks
   * The files stay as they are, so the same command carries on.
   *
   * @sideEffects Settles the run's end.
   */
  function interrupt(): void {
    finished.resolve({ code: 130, line: "interrupted" });
  }
  io.signal.addEventListener("abort", interrupt, { once: true });
  try {
    await host.tools;
    const projectId =
      host.projects.projects().find((project) => project.path === repo)?.id ?? (await host.projects.add(repo));
    io.out.write(
      `repository ${repo}\nhome       ${options.home}\ntask       ${taskId}\nmodel      ${model.providerId}/${model.modelId}\n`,
    );
    host.tasks.onEvent((task, event) => {
      for (const line of describeProgress(task, event)) io.out.write(`${line}\n`);
      io.out.write(`    nodes ${describeNodes(task)}\n`);
      const reason = stopReason(task);
      if (reason !== null) finished.resolve(reason);
    });
    const existing = await host.tasks.open(taskId).catch(() => null);
    if (existing === null) {
      await host.tasks.create(
        newTaskRecord({
          id: taskId,
          name: file.name,
          projectId,
          sourceDir: repo,
          originSessionId: `try:${taskId}`,
          taskSessionId: `try:${taskId}`,
          model,
          goal: file.goal,
          nodes: file.nodes,
          edges: file.edges,
          now: Date.now(),
        }),
      );
      await host.tasks.submit(taskId, { type: "started" });
    } else {
      io.out.write("carrying on the task found in the home\n");
      const early = stopReason(existing);
      if (early !== null) finished.resolve(early);
      else await host.tasks.recover(taskId);
    }
    const reason = await finished.promise;
    io.out.write(`${reason.line}\n`);
    const task = host.tasks.task(taskId);
    if (task?.workspaceId != null) {
      const dir = host.projects.workspaces().find((workspace) => workspace.id === task.workspaceId)?.dir;
      if (dir !== undefined)
        io.out.write(`worktree   ${dir}\nevents     ${join(options.home, "tasks", taskId, "events.jsonl")}\n`);
    }
    return reason.code;
  } finally {
    io.signal.removeEventListener("abort", interrupt);
    await host.tasks.idle().catch(() => undefined);
    await host.close();
  }
}

/**
 * Entry point of `pnpm task:try`: parses the arguments and runs, returning the exit code.
 *
 * @remarks
 * pnpm runs scripts from the repository root, so paths and the default repository come from `INIT_CWD`.
 *
 * @sideEffects As `runTaskTry`; writes usage errors and failures to `stderr`.
 * @param argv - Arguments after the script name.
 * @param env - The process environment.
 * @param stdout - Where the progress goes.
 * @param stderr - Where errors go.
 * @param signal - Aborted on Ctrl+C or SIGTERM.
 * @returns The exit code: 2 for a usage error, otherwise `runTaskTry`'s, 1 for an error.
 */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  stdout: TaskTryOutput,
  stderr: TaskTryOutput,
  signal: AbortSignal,
): Promise<number> {
  // Stryker disable next-line LogicalOperator: pnpm always sets INIT_CWD; the fallback is for running the bundle by hand.
  const parsed = parseTaskTryArgs(argv, env["INIT_CWD"] ?? process.cwd());
  if ("error" in parsed) {
    stderr.write(`${parsed.error}\n`);
    return 2;
  }
  try {
    return await runTaskTry(parsed, { env, out: stdout, signal });
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// Stryker disable all: this only runs as the bundled command; `main` above is tested directly.
if (process.argv[1]?.endsWith("task-try.cjs") === true) {
  // Ctrl+C would otherwise end Node at once, skipping the stop of pi and the flush of the files.
  const interrupt = new AbortController();
  process.once("SIGINT", () => interrupt.abort());
  process.once("SIGTERM", () => interrupt.abort());
  // Fire and forget: the chain cannot reject, and the process exits when it settles.
  void main(
    process.argv.slice(2),
    process.env,
    { write: (text) => process.stdout.write(text) },
    { write: (text) => process.stderr.write(text) },
    interrupt.signal,
  ).then((code) => (process.exitCode = code));
}
