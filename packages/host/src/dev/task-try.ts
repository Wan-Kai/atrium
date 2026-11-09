import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { z } from "zod";
import {
  CommandError,
  type HumanAnswer,
  ThinkingLevel,
  type TaskArchiveFacts,
  type TaskNode,
  type TaskView,
} from "@atrium/protocol";
import { systemClock } from "../platform/clock";
import { readLoginShellEnv } from "../platform/login-shell";
import { type RunningHost, startHost } from "../main";
import { activeGraphOf, latestRun } from "../tasks/graph";
import { validateGraph } from "../tasks/graph-validator";
import { newTaskRecord } from "../tasks/new-task";
import { deriveStatus } from "../tasks/status";
import { GraphEdge, GraphNode, type Task, type TaskEvent } from "../tasks/types";
import { describeEvent, describeNodes } from "./task-replay";

const USAGE =
  "usage: pnpm task:try <graph.json> [--repo <dir>] [--model <provider/model[:thinking]>] [--home <dir>]\nA human node and the archive question are answered with lines on stdin (p = pass, b <node> [reason] = send back, a / k = archive / keep, q = quit).";

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

/** What a task waits to ask the user. */
type Question = { readonly kind: "human"; readonly node: string } | { readonly kind: "archive" };

/**
 * What the task is waiting to ask, if anything.
 *
 * @remarks
 * A human node waiting for its answer (not one being merged), else, once the task ended, the question about
 * archiving.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns The question, or `null`.
 */
export function pendingQuestion(task: Task): Question | null {
  for (const node of activeGraphOf(task)?.nodes ?? []) {
    const run = latestRun(task, node.id);
    if (
      run?.state === "waiting" &&
      run.merging !== true &&
      run.void !== true &&
      (run.waitingFor === "human" || run.waitingFor === "merge_blocked")
    ) {
      return { kind: "human", node: node.id };
    }
  }
  return task.archive === "asked" ? { kind: "archive" } : null;
}

/** Where `runTaskTry` writes. */
export interface TaskTryOutput {
  write(text: string): void;
}

/** Asks the user one question on the terminal; `null` when the input ended or the run was interrupted. */
export type TaskTryAsk = (question: string, signal: AbortSignal) => Promise<string | null>;

const execFileAsync = promisify(execFile);

/**
 * How much the task's worktree changed since it began, as `git diff --shortstat` says.
 *
 * @remarks
 * The change statistics a human node shows (SPEC-0006, "human 节点"). The app takes them from the changes
 * service; this tool asks git. No external diff or text conversion runs: the worktree is the agent's.
 *
 * @sideEffects Runs git.
 * @param dir - The worktree.
 * @param base - The commit it began at.
 * @returns The statistics, or `null` when there are none or git failed.
 */
async function changeStat(dir: string, base: string): Promise<string | null> {
  const out = await execFileAsync("git", ["-C", dir, "diff", "--shortstat", "--no-ext-diff", "--no-textconv", base], {
    timeout: 30_000,
  }).catch(() => null);
  const text = out?.stdout.trim() ?? "";
  return text === "" ? null : text;
}

/**
 * Makes `ask` from a stream of lines, one line per question.
 *
 * @remarks
 * Lines typed ahead, or piped in, answer the questions in order. The end of the input, or the run's
 * interruption, answers `null`.
 *
 * @sideEffects Reads the stream; writes each question to `out`.
 * @param input - The stream, such as `process.stdin`.
 * @param out - Where the questions are written.
 * @returns The function, and one that stops reading.
 */
export function askFromStream(
  input: NodeJS.ReadableStream,
  out: TaskTryOutput,
): { readonly ask: TaskTryAsk; readonly close: () => void } {
  const reader = createInterface({ input, terminal: false });
  const lines = reader[Symbol.asyncIterator]();
  return {
    async ask(question, signal) {
      out.write(question);
      if (signal.aborted) return null;
      const stopped = new Promise<null>((done) => signal.addEventListener("abort", () => done(null), { once: true }));
      const next = await Promise.race([lines.next(), stopped]);
      return next === null || next.done === true ? null : next.value;
    },
    close: () => reader.close(),
  };
}

/**
 * Why the run stopped, and the exit code that goes with it.
 *
 * @remarks
 * The task ended, a node failed, or the task waits for something `task:try` cannot give: the answer to a
 * question. A human node waiting stops it only when it cannot ask (`interactive` false); asking, it goes on until
 * the task ends, and an ended task whose worktree is still to be archived or kept goes on until that is answered.
 * A stop for a question says so (`question`): a question that was open when a run ended died with it, and the next
 * run, which recovers the task, makes the node ask again (SPEC-0006, "宿主重启"), so it is a reason to stop only
 * for the run in which it is asked.
 *
 * @sideEffects none
 * @param task - The task.
 * @param interactive - Whether the run can ask the user at a human node and about archiving.
 * @returns The code and a line, or `null` while the task goes on.
 */
export function stopReason(
  task: Task,
  interactive = false,
): { readonly code: number; readonly line: string; readonly question?: true } | null {
  const status = deriveStatus(task);
  const archiveOpen = interactive && task.archive === "asked";
  if (status === "done") return archiveOpen ? null : { code: 0, line: "the task is done" };
  if (status === "cancelled") return archiveOpen ? null : { code: 1, line: "the task was cancelled" };
  const graph = activeGraphOf(task);
  for (const node of graph?.nodes ?? []) {
    const run = latestRun(task, node.id);
    if (run?.state === "failed") return { code: 1, line: `${node.id} failed: ${run.failure ?? "unknown"}` };
    if (run?.state === "waiting" && (run.waitingFor === "human" || run.waitingFor === "merge_blocked")) {
      if (interactive) continue;
      return { code: 0, line: `stopped at the human node ${node.id}: run with input on stdin to answer it` };
    }
    if (run?.state === "waiting" && run.waitingFor === "question") {
      return {
        code: 3,
        line: `${node.id} asked a question; task:try cannot answer it, run the command again to let it go on`,
        question: true,
      };
    }
    if (run?.state === "waiting" && run.waitingFor === "graph_change") {
      return { code: 3, line: `${node.id} asked for the graph to change; the task conversation (T6) handles that` };
    }
  }
  return null;
}

/** What the user typed at a human node. */
export type HumanChoice =
  | { readonly kind: "pass" }
  | { readonly kind: "back"; readonly to: string; readonly reason: string | null }
  | { readonly kind: "quit" }
  | { readonly kind: "unknown" };

/**
 * Reads the line typed at a human node.
 *
 * @remarks
 * `p` or `pass`; `b <node> [reason]` or `back <node> [reason]` (the reason is asked for when left out); `q` or
 * `quit`. A send-back to a node the human node has no back edge to is unknown.
 *
 * @sideEffects none
 * @param line - The line.
 * @param node - The human node as the board shows it.
 * @returns The choice.
 */
export function parseHumanChoice(line: string, node: TaskNode): HumanChoice {
  const [word = "", target, ...rest] = line.trim().split(/\s+/u);
  if (word === "p" || word === "pass") return { kind: "pass" };
  if (word === "q" || word === "quit") return { kind: "quit" };
  if ((word === "b" || word === "back") && target !== undefined && node.sendBack.some((edge) => edge.to === target)) {
    const reason = rest.join(" ").trim();
    return { kind: "back", to: target, reason: reason === "" ? null : reason };
  }
  return { kind: "unknown" };
}

/** What the user typed about the worktree. */
export type ArchiveChoice = "archive" | "keep" | "quit" | "unknown";

/**
 * Reads the line typed at the archive question.
 *
 * @remarks
 * `a` or `archive`; `k` or `keep`; `q` or `quit` (leave the question open).
 *
 * @sideEffects none
 * @param line - The line.
 * @returns The choice.
 */
export function parseArchiveChoice(line: string): ArchiveChoice {
  const word = line.trim();
  if (word === "a" || word === "archive") return "archive";
  if (word === "k" || word === "keep") return "keep";
  if (word === "q" || word === "quit") return "quit";
  return "unknown";
}

/**
 * What a waiting human node shows the user.
 *
 * @remarks
 * SPEC-0006, "human 节点": the job, what counts as done, the summaries of the nodes right before it, the
 * worktree's change statistics, why a merge was blocked, and the choices with how often each back edge was used.
 *
 * @sideEffects none
 * @param view - The task as the board shows it.
 * @param node - The human node.
 * @param stat - The change statistics, or `null` when there are none to show.
 * @returns The lines.
 */
export function describeHumanNode(view: TaskView, node: TaskNode, stat: string | null): string[] {
  const lines = [`[${node.id}] ${node.name} (attempt ${String(node.attempt)}) waits for you`, `  job: ${node.job}`];
  for (const line of node.done) lines.push(`  done when: ${line}`);
  for (const edge of view.edges.filter((one) => one.kind === "seq" && one.to === node.id)) {
    const from = view.nodes.find((one) => one.id === edge.from);
    if (from?.summary != null) lines.push(`  ${from.id} said: ${from.summary.split("\n")[0] ?? ""}`);
  }
  lines.push(`  changes: ${stat ?? "(none)"}`);
  if (node.blocked !== null) {
    const files = node.blockedFiles === undefined ? "" : ` (${node.blockedFiles.join(", ")})`;
    lines.push(`  the merge is blocked: ${node.blocked}${files}; deal with it, then pass again`);
  }
  const back = node.sendBack.map(
    (edge) => `b ${edge.to} [reason] = send back to ${edge.to} (used ${String(edge.uses)} of 2)`,
  );
  lines.push(
    `  choices: p = pass${node.merge === true ? " and merge" : ""}${back.map((one) => `, ${one}`).join("")}, q = quit`,
  );
  return lines;
}

/**
 * What the archive question shows.
 *
 * @remarks
 * SPEC-0006, "归档": the worktree's name, whether it is merged, whether it has changes that are not committed
 * and how many commits it has since the start.
 *
 * @sideEffects none
 * @param facts - The facts, or `null` when there is nothing to ask about.
 * @returns The lines.
 */
export function describeArchive(facts: TaskArchiveFacts | null): string[] {
  if (facts === null) return ["the task's worktree is gone or archived already"];
  const merged = facts.merged === null ? "unknown" : facts.merged ? "yes" : "no";
  return [
    `worktree ${facts.name}: merged ${merged}, uncommitted changes ${facts.dirty ? "yes" : "no"}, ${String(facts.commits)} commit(s) since the start`,
    facts.dirty
      ? "  archiving is refused while it has changes; a = try anyway, k = keep it, q = quit"
      : "  a = archive, k = keep it, q = quit",
  ];
}

/**
 * Runs a graph with real nodes, without the app: the host, a project, the task and its events on the terminal.
 *
 * @remarks
 * The narrowest path through the task runner (roadmap T4): a real host in this process, the repository
 * registered as a project, the task started with the graph file's graph, no UI and no `/task`. The task's
 * files stay in the home, so after Ctrl+C the same command carries on: the task is opened again, `recover`
 * does again what was lost, and a commit with the node's trailer is found, not made twice. At a human node it
 * shows what the node wants answered and reads the answer (pass, or send back to a node with a reason; after a
 * blocked merge, pass again to try again), and at the end it asks whether to archive the worktree the task made.
 * Without input it stops at a human node. It stops at a failure or a question too.
 *
 * @sideEffects Starts a host (and so pi) with its files under `options.home`; registers the repository as
 * a project; makes a worktree and commits in it; writes to `out` until it stops.
 * @param options - The graph, repository, model and home.
 * @param io - The process environment, where to write, and an abort signal for Ctrl+C.
 * @returns The exit code: 0 when the task ended or stopped at a human node or the user quit, 1 when a node
 * failed, 3 when it waits for an answer `task:try` cannot give, 130 when interrupted.
 */
export async function runTaskTry(
  options: TaskTryOptions,
  io: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly out: TaskTryOutput;
    readonly signal: AbortSignal;
    /** The extension pi loads in the nodes; the bundle's own by default. */
    readonly extension?: string;
    /** Asks the user at a human node and about archiving; without it the run stops at a human node. */
    readonly ask?: TaskTryAsk;
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
    // This run looks after the one task it carries on itself, below.
    recoverTasks: false,
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
    const interactive = io.ask !== undefined;
    let asking = false;
    let line: Promise<void> = Promise.resolve();
    /**
     * Asks the user whatever the task waits for, one question at a time.
     *
     * @remarks
     * A human node waiting, or a finished task whose worktree is still to be archived or kept. After an answer
     * the task is looked at again, since the answer may have led to another question.
     *
     * @sideEffects Reads the terminal; answers commands.
     */
    function askNext(): void {
      const ask = io.ask;
      const task = host.tasks.task(taskId);
      // A failed task asks nothing: it stops with the failure.
      if (ask === undefined || asking || task === undefined || stopReason(task, true)?.code === 1) return;
      const question = pendingQuestion(task);
      if (question === null) return;
      asking = true;
      line = line.then(() => askOnce(ask, question));
    }
    /**
     * Asks one question, then looks at the task again.
     *
     * @remarks
     * A failure ends the run with its message; the user quitting ends it with the task left as it is.
     *
     * @sideEffects Reads the terminal; answers commands.
     * @param ask - How to ask.
     * @param question - What the task waits to ask.
     */
    async function askOnce(ask: TaskTryAsk, question: NonNullable<ReturnType<typeof pendingQuestion>>): Promise<void> {
      try {
        const quit = await (question.kind === "archive" ? askArchive(ask) : askHuman(ask, question.node));
        asking = false;
        if (quit) finished.resolve({ code: 0, line: "stopped at your answer; run the command again to go on" });
        else askNext();
      } catch (error) {
        asking = false;
        finished.resolve({ code: 1, line: error instanceof Error ? error.message : String(error) });
      }
    }
    /**
     * Shows a human node and answers it as the user says.
     *
     * @remarks
     * A refusal of the command (a state that changed, a back edge used up) is printed and asked again.
     *
     * @sideEffects Reads the terminal; answers commands.
     * @param ask - How to ask.
     * @param node - The human node.
     * @returns Whether the user quit.
     */
    async function askHuman(ask: TaskTryAsk, node: string): Promise<boolean> {
      for (;;) {
        const view = await host.tasks.view(taskId, io.signal);
        const shown = view.nodes.find((one) => one.id === node);
        if (shown === undefined || shown.state !== "waiting") return false;
        const task = host.tasks.task(taskId);
        const dir = host.projects.workspaces().find((one) => one.id === task?.workspaceId)?.dir;
        const stat = dir === undefined || task?.baseCommit == null ? null : await changeStat(dir, task.baseCommit);
        for (const text of describeHumanNode(view, shown, stat)) io.out.write(`${text}\n`);
        const typed = await ask("> ", io.signal);
        if (typed === null) return true;
        const choice = parseHumanChoice(typed, shown);
        if (choice.kind === "quit") return true;
        if (choice.kind === "unknown") {
          io.out.write("not understood\n");
          continue;
        }
        let answer: HumanAnswer = { kind: "pass" };
        if (choice.kind === "back") {
          const reason = choice.reason ?? (await ask("reason> ", io.signal));
          if (reason === null) return true;
          if (reason.trim() === "") continue;
          answer = { kind: "send_back", backTo: choice.to, reason: reason.trim() };
        }
        try {
          await host.tasks.answerHuman(taskId, node, answer);
          return false;
        } catch (error) {
          if (!(error instanceof CommandError)) throw error;
          io.out.write(`refused: ${error.code}\n`);
          if (host.tasks.task(taskId) === undefined) return true;
        }
      }
    }
    /**
     * Asks what to do with the worktree the task made, and does it.
     *
     * @remarks
     * Archiving can be refused (changes that are not committed); that is printed and asked again.
     *
     * @sideEffects Reads the terminal; answers commands.
     * @param ask - How to ask.
     * @returns Whether the user quit.
     */
    async function askArchive(ask: TaskTryAsk): Promise<boolean> {
      for (;;) {
        const view = await host.tasks.view(taskId, io.signal);
        if (view.archive !== "asked") return false;
        for (const text of describeArchive(view.archiveFacts)) io.out.write(`${text}\n`);
        const typed = await ask("> ", io.signal);
        if (typed === null) return true;
        const choice = parseArchiveChoice(typed);
        if (choice === "quit") return true;
        if (choice === "unknown") {
          io.out.write("not understood\n");
          continue;
        }
        try {
          await host.tasks.answerArchive(taskId, choice);
          return false;
        } catch (error) {
          if (!(error instanceof CommandError)) throw error;
          io.out.write(`refused: ${error.code}\n`);
        }
      }
    }
    host.tasks.onEvent((task, event) => {
      for (const text of describeProgress(task, event)) io.out.write(`${text}\n`);
      io.out.write(`    nodes ${describeNodes(task)}\n`);
      const reason = stopReason(task, interactive);
      if (reason !== null) finished.resolve(reason);
      else askNext();
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
      const early = stopReason(existing, interactive);
      // A question left open by the last run is void now: recovering makes the node ask it again.
      if (early !== null && early.question !== true) finished.resolve(early);
      else {
        // As the app does when it starts: every task of the home that was going, here the one.
        await host.tasks.recoverAll({ signal: io.signal, staleLocks: true, ready: () => Promise.resolve(true) });
        askNext();
      }
    }
    const reason = await finished.promise;
    io.out.write(`${reason.line}\n`);
    await line;
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
 * @param stdin - Where the answers at a human node and about archiving are read from, a line each; without it
 * the run stops at a human node.
 * @returns The exit code: 2 for a usage error, otherwise `runTaskTry`'s, 1 for an error.
 */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  stdout: TaskTryOutput,
  stderr: TaskTryOutput,
  signal: AbortSignal,
  stdin?: NodeJS.ReadableStream,
): Promise<number> {
  // Stryker disable next-line LogicalOperator: pnpm always sets INIT_CWD; the fallback is for running the bundle by hand.
  const parsed = parseTaskTryArgs(argv, env["INIT_CWD"] ?? process.cwd());
  if ("error" in parsed) {
    stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const reader = stdin === undefined ? undefined : askFromStream(stdin, stdout);
  try {
    return await runTaskTry(parsed, { env, out: stdout, signal, ...(reader === undefined ? {} : { ask: reader.ask }) });
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    reader?.close();
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
    process.stdin,
  ).then((code) => (process.exitCode = code));
}
