import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { sessionsLocation } from "@atrium/pi";
import { systemClock } from "../platform/clock";
import { readLoginShellEnv } from "../platform/login-shell";
import { type RunningHost, startHost } from "../main";
import { activeGraphOf, downstreamOf, upstreamOf } from "../tasks/graph";
import type { Task } from "../tasks/types";
import { modelFor } from "./task-try";

const USAGE =
  "usage: pnpm task:design --from <session id> [--scope <text>] [--model <provider/model[:thinking]>] [--home <dir>] [--sessions <dir>] [--cwd <dir>] [--timeout <seconds>] [--keep]\nRuns the task conversation's design turn on a copy of the conversation and prints the summary and the first graph; nothing is started and the original is only read.";

/** How long the host may take to see the copied conversation before the tool gives up. */
const SCAN_SECONDS = 120;

/** What `pnpm task:design` was asked to do. */
export interface TaskDesignOptions {
  /** The conversation to make a task of. */
  readonly sessionId: string;
  /** What the user would type after `/task`; `null` for none. */
  readonly scope: string | null;
  /** `provider/model[:thinking]` for the task conversation, or `null` for the source conversation's own. */
  readonly model: string | null;
  /** The Atrium home the conversation is in; only read. */
  readonly home: string;
  /** Where pi keeps its session files; only read. `null` for pi's own setting. */
  readonly sessions: string | null;
  /** The directory the design runs in instead of the conversation's own; `null` for its own. */
  readonly cwd: string | null;
  /** How long the design turn may take after the task is made, in seconds. */
  readonly timeoutSeconds: number;
  /** Keep the scratch directory afterwards. */
  readonly keep: boolean;
}

/**
 * Parses the command line of `pnpm task:design`.
 *
 * @remarks
 * `--home` defaults to `~/.atrium`, the Atrium home the conversation lives in; paths are relative to where the command was typed.
 *
 * @sideEffects none
 * @param argv - Arguments after the script name.
 * @param defaultCwd - The directory the command was typed in.
 * @param userHome - The user's home directory.
 * @returns The options, or a usage error.
 */
export function parseTaskDesignArgs(
  argv: readonly string[],
  defaultCwd: string,
  userHome: string,
): TaskDesignOptions | { readonly error: string } {
  let sessionId: string | undefined;
  let scope: string | null = null;
  let model: string | null = null;
  let home = join(userHome, ".atrium");
  let sessions: string | null = null;
  let cwd: string | null = null;
  let timeoutSeconds = 300;
  let keep = false;
  const rest = [...argv];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (arg === "--keep") {
      keep = true;
    } else if (["--from", "--scope", "--model", "--home", "--sessions", "--cwd", "--timeout"].includes(arg)) {
      const value = rest.shift();
      if (value === undefined) return { error: `${arg} needs a value\n${USAGE}` };
      if (arg === "--from") sessionId = value;
      else if (arg === "--scope") scope = value;
      else if (arg === "--model") model = value;
      else if (arg === "--home") home = resolve(defaultCwd, value);
      else if (arg === "--sessions") sessions = resolve(defaultCwd, value);
      else if (arg === "--cwd") cwd = resolve(defaultCwd, value);
      else {
        const seconds = Number(value);
        if (!Number.isInteger(seconds) || seconds < 1) return { error: `--timeout is a number of seconds\n${USAGE}` };
        timeoutSeconds = seconds;
      }
    } else {
      return { error: `${arg.startsWith("--") ? "unknown option " : "unexpected argument "}${arg}\n${USAGE}` };
    }
  }
  if (sessionId === undefined || !/^[\w-]{1,128}$/u.test(sessionId)) {
    return { error: `--from needs a session id\n${USAGE}` };
  }
  return { sessionId, scope, model, home, sessions, cwd, timeoutSeconds, keep };
}

/** A session file found on disk. */
export interface FoundSource {
  /** The file. */
  readonly path: string;
  /** The directory the session ran in, from its header. */
  readonly cwd: string;
}

/**
 * Finds a session's file among pi's, and the directory it ran in.
 *
 * @remarks
 * Only reads. pi names a session file `<time>_<id>.jsonl`; the first line is the header with the `cwd`.
 *
 * @sideEffects Reads the directory and the file's first line.
 * @param directory - Where pi keeps sessions.
 * @param sessionId - The session.
 * @returns The file and its directory, or `null` when there is none.
 */
export async function findSource(directory: string, sessionId: string): Promise<FoundSource | null> {
  const names = await readdir(directory, { recursive: true }).catch(() => [] as string[]);
  const name = names.find((candidate) => candidate.endsWith(`_${sessionId}.jsonl`));
  if (name === undefined) return null;
  const path = join(directory, name);
  const first = (await readFile(path, "utf8")).split("\n", 1)[0] ?? "";
  try {
    const header: unknown = JSON.parse(first);
    const cwd: unknown = Reflect.get(Object(header), "cwd");
    return typeof cwd === "string" && cwd !== "" ? { path, cwd } : null;
  } catch {
    return null;
  }
}

/**
 * A hash of a file's content and its modification time, to show that a run did not touch it.
 *
 * @remarks
 * The original conversation file is fingerprinted before the run and after; both are printed.
 *
 * @sideEffects Reads the file.
 * @param path - The file.
 * @returns The digest and the time, as text.
 */
async function fingerprint(path: string): Promise<string> {
  const [content, info] = await Promise.all([readFile(path), stat(path)]);
  return `${createHash("sha256").update(content).digest("hex").slice(0, 16)} @ ${String(info.mtimeMs)}`;
}

/**
 * The warnings about a graph that the acceptance looks for.
 *
 * @remarks
 * SPEC-0006, "附录：引导词": an implementing node must not be the one that verifies itself, so a `work` node
 * with no `check` node anywhere after it is named; so is a graph that ends without a human node.
 *
 * @sideEffects none
 * @param task - The task with its graph.
 * @returns The warnings, empty when there are none.
 */
export function designWarnings(task: Task): string[] {
  const graph = activeGraphOf(task);
  if (graph === undefined) return ["no graph was proposed"];
  const warnings: string[] = [];
  for (const node of graph.nodes.filter((one) => one.role === "work")) {
    const after = new Set<string>();
    const queue = downstreamOf(graph, node.id);
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      if (after.has(next)) continue;
      after.add(next);
      queue.push(...downstreamOf(graph, next));
    }
    if (!graph.nodes.some((one) => after.has(one.id) && one.role === "check")) {
      warnings.push(`${node.id} writes code and no check node comes after it`);
    }
  }
  if (!graph.nodes.some((one) => one.kind === "human")) warnings.push("the graph has no human node to accept it");
  return warnings;
}

/**
 * A titled list for the terminal, or nothing for an empty one.
 *
 * @remarks
 * Keeps the printed summary free of titles with nothing under them.
 *
 * @sideEffects none
 * @param title - The list's title.
 * @param items - Its items.
 * @returns The lines, empty when there are no items.
 */
function bulletLines(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : [`  ${title}`, ...items.map((item) => `    - ${item}`)];
}

/**
 * The requirement summary and the graph as the terminal shows them.
 *
 * @remarks
 * What the acceptance reads: whether the summary left out a point, and whether the graph is split sensibly.
 * The agent's own closing words to the user follow, and the warnings of `designWarnings`.
 *
 * @sideEffects none
 * @param task - The task after the design turn.
 * @param said - What the task conversation told the user at the end, or `null`.
 * @returns The lines.
 */
export function describeDesign(task: Task, said: string | null): string[] {
  const lines: string[] = [];
  lines.push(`task       ${task.name === "" ? "(unnamed)" : task.name}`);
  lines.push(`guide      ${task.guide.id} v${String(task.guide.version)}`);
  lines.push(`model      ${task.model.providerId}/${task.model.modelId}:${task.model.thinking}`);
  lines.push("", "requirement summary");
  lines.push(`  goal: ${task.summary.goal === "" ? "(not written)" : task.summary.goal}`);
  lines.push(...bulletLines("decisions", task.summary.decisions));
  lines.push(...bulletLines("constraints", task.summary.constraints));
  lines.push(...bulletLines("out of scope", task.summary.nonGoals));
  lines.push(...bulletLines("open questions", task.summary.openQuestions));
  lines.push(...bulletLines("acceptance", task.summary.acceptance));
  const graph = activeGraphOf(task);
  lines.push("", graph === undefined ? "graph: (none proposed)" : `graph v${String(graph.version)}: ${graph.note}`);
  for (const node of graph?.nodes ?? []) {
    const how =
      node.kind === "human"
        ? `human${node.merge === true ? ", merges" : ""}`
        : `${node.role ?? "?"}${node.place === undefined ? "" : `, ${node.place}`}`;
    lines.push(`  ${node.id} · ${node.name} [${how}]`);
    lines.push(`      job   ${node.job}`);
    for (const line of node.done) lines.push(`      done  ${line}`);
    const ups = upstreamOf(graph ?? { edges: [] }, node.id);
    lines.push(`      after ${ups.length === 0 ? "(start)" : ups.join(", ")}`);
  }
  for (const edge of (graph?.edges ?? []).filter((one) => one.kind === "back")) {
    lines.push(`  ${edge.from} can send back to ${edge.to}`);
  }
  const warnings = designWarnings(task);
  if (warnings.length > 0) lines.push("", "check these", ...warnings.map((text) => `  ! ${text}`));
  if (said !== null) {
    lines.push("", "the task conversation told the user", ...said.split("\n").map((text) => `  ${text}`));
  }
  return lines;
}

/**
 * The last thing the assistant said in a session file, if its last message is the assistant's and it ended its turn.
 *
 * @remarks
 * Tells that the task conversation is done with its turn and what it said. Only reads the file.
 *
 * @sideEffects Reads the file.
 * @param path - The session file.
 * @returns The text, or `null` while the turn goes on or nothing was said.
 */
export async function lastWords(path: string): Promise<string | null> {
  const text = await readFile(path, "utf8").catch(() => "");
  const lines = text.split("\n").filter((line) => line !== "");
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[at] ?? "");
    } catch {
      continue;
    }
    if (Reflect.get(Object(entry), "type") !== "message") continue;
    const message: unknown = Reflect.get(Object(entry), "message");
    if (Reflect.get(Object(message), "role") !== "assistant") return null;
    if (Reflect.get(Object(message), "stopReason") === "toolUse") return null;
    const content: unknown = Reflect.get(Object(message), "content");
    const words = (Array.isArray(content) ? content : [])
      .flatMap((block: unknown) =>
        Reflect.get(Object(block), "type") === "text" ? [String(Reflect.get(Object(block), "text"))] : [],
      )
      .join("\n")
      .trim();
    return words === "" ? null : words;
  }
  return null;
}

/** Where `runTaskDesign` writes. */
export interface TaskDesignOutput {
  write(text: string): void;
}

/**
 * Runs the task conversation's design turn on a copy of a conversation, and prints what it made.
 *
 * @remarks
 * SPEC-0006, "/task 与创建" and roadmap T6. The original is never written: the tool only reads the one session
 * file, copies it into a fresh scratch directory, starts a host there (its own home, its own pi session folder)
 * and runs `createFromChat` on the copy, so the "converted" line goes into the copy. The original file is
 * fingerprinted before and after and both are printed. The design turn runs with the conversation's directory (or
 * `--cwd`) as its working directory, with the task conversation's read-only tools; give `--cwd` a copy of the
 * repository to be sure nothing there is touched. The task is never started.
 *
 * @sideEffects Starts a host and pi; registers the directory as a project in the scratch host; writes only under
 * the scratch directory (removed unless `keep`); reads the original session file; writes to `out`.
 * @param options - What to do.
 * @param io - The environment, where to write, and an abort signal for Ctrl+C.
 * @returns The exit code: 0 when a graph was proposed, 1 when the turn ended without one or failed, 130 when interrupted.
 */
export async function runTaskDesign(
  options: TaskDesignOptions,
  io: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly out: TaskDesignOutput;
    readonly signal: AbortSignal;
    /** The extension pi loads in the task conversation; the bundle's own by default. */
    readonly extension?: string;
    /** Where the scratch directory is made; the system's temporary directory by default. */
    readonly scratchRoot?: string;
  },
): Promise<number> {
  const login = await readLoginShellEnv({ shell: io.env["SHELL"], env: io.env, clock: systemClock, signal: io.signal });
  const location = await sessionsLocation(
    options.sessions === null ? { ...login.env } : { ...login.env, PI_CODING_AGENT_SESSION_DIR: options.sessions },
  );
  const source = await findSource(location.directory, options.sessionId);
  if (source === null) {
    io.out.write(`no session ${options.sessionId} among the files in ${location.directory} (pass --sessions)\n`);
    return 1;
  }
  const dir = options.cwd ?? source.cwd;
  const model = options.model === null ? undefined : await modelFor(options.model, login.env);
  const scratch = await mkdtemp(join(io.scratchRoot ?? tmpdir(), "atrium-task-design-"));
  if (scratch.startsWith(options.home) || scratch.startsWith(location.directory)) {
    throw new Error("the scratch directory would be inside the real home or the real session folder");
  }
  const before = await fingerprint(source.path);
  io.out.write(
    `original   ${source.path}\ncwd        ${dir}\nscratch    ${scratch}\nread-only  the original is copied, never written (fingerprint ${before})\n`,
  );
  const sessionDir = join(scratch, "pi-sessions");
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await copyFile(source.path, join(sessionDir, basename(source.path)));
  let host: RunningHost | null = null;
  let code = 1;
  try {
    host = await startHost({
      home: join(scratch, "home"),
      token: randomBytes(24).toString("hex"),
      logLevel: "info",
      toolEnv: { ...login.env, PI_CODING_AGENT_SESSION_DIR: sessionDir },
      fastExtension: io.extension ?? join(__dirname, "atrium-extension.mjs"),
      piLatestUrl: null,
    });
    await host.tools;
    await host.projects.add(dir).catch((error: unknown) => {
      throw new Error(
        `${dir} cannot be a project (${error instanceof Error ? error.message : "unknown"}); pass --cwd with a git repository`,
      );
    });
    // The copy is found when the host's first scan has seen the folder; creating the task also waits for the
    // conversation's pi to take the design message, which can take a while on a busy machine, so the timeout
    // counts from the task's creation.
    const found = Date.now() + SCAN_SECONDS * 1000;
    let created: { taskId: string } | null = null;
    while (created === null && !io.signal.aborted && Date.now() < found) {
      created = await host.tasks
        .createFromChat(options.sessionId, options.scope ?? undefined, model === undefined ? {} : { model })
        .catch((error: unknown) => {
          if (Reflect.get(Object(error), "code") !== "session_not_found") throw error;
          return null;
        });
      if (created === null) {
        await new Promise<void>((done) => {
          setTimeout(done, 500);
        });
      }
    }
    if (created === null) {
      io.out.write("the copied conversation was not found by the host\n");
      return io.signal.aborted ? 130 : 1;
    }
    const { taskId } = created;
    const deadline = Date.now() + options.timeoutSeconds * 1000;
    io.out.write(`task       ${taskId} (designing; never started)\nwaiting for the design turn...\n`);
    let task = host.tasks.task(taskId);
    let said: string | null = null;
    while (!io.signal.aborted && Date.now() < deadline) {
      task = host.tasks.task(taskId) ?? task;
      const sessionId = task?.taskSessionId;
      const file = (await readdir(sessionDir)).find(
        (name) => sessionId !== undefined && name.endsWith(`_${sessionId}.jsonl`),
      );
      said = file === undefined ? null : await lastWords(join(sessionDir, file));
      if (said !== null && (task?.activeGraph ?? 0) >= 1) break;
      await new Promise<void>((done) => {
        setTimeout(done, 1000);
      });
    }
    if (io.signal.aborted) return 130;
    if (task === undefined) return 1;
    io.out.write(`${describeDesign(task, said).join("\n")}\n`);
    code = task.activeGraph >= 1 ? 0 : 1;
    if (code === 1)
      io.out.write(
        "\nno graph was proposed: the turn ended without one, or --timeout passed, or the conversation waits for an answer task:design cannot give\n",
      );
    return code;
  } finally {
    await host?.tasks.idle().catch(() => undefined);
    await host?.close().catch(() => undefined);
    const after = await fingerprint(source.path);
    io.out.write(`\noriginal   ${after === before ? "unchanged" : "CHANGED"} (${after})\n`);
    if (options.keep) io.out.write(`scratch    kept at ${scratch}\n`);
    else await rm(scratch, { recursive: true, force: true });
    if (after !== before) code = 1;
  }
}

/**
 * Entry point of `pnpm task:design`: parses the arguments and runs, returning the exit code.
 *
 * @remarks
 * pnpm runs scripts from the repository root, so paths come from `INIT_CWD`.
 *
 * @sideEffects As `runTaskDesign`; writes usage errors and failures to `stderr`.
 * @param argv - Arguments after the script name.
 * @param env - The process environment.
 * @param stdout - Where the result goes.
 * @param stderr - Where errors go.
 * @param signal - Aborted on Ctrl+C or SIGTERM.
 * @returns The exit code: 2 for a usage error, otherwise `runTaskDesign`'s, 1 for an error.
 */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  stdout: TaskDesignOutput,
  stderr: TaskDesignOutput,
  signal: AbortSignal,
): Promise<number> {
  const parsed = parseTaskDesignArgs(argv, env["INIT_CWD"] ?? process.cwd(), env["HOME"] ?? homedir());
  if ("error" in parsed) {
    stderr.write(`${parsed.error}\n`);
    return 2;
  }
  try {
    return await runTaskDesign(parsed, { env, out: stdout, signal });
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// Stryker disable all: this only runs as the bundled command; `main` above is the entry.
if (process.argv[1]?.endsWith("task-design.cjs") === true) {
  const interrupt = new AbortController();
  process.once("SIGINT", () => interrupt.abort());
  process.once("SIGTERM", () => interrupt.abort());
  void main(
    process.argv.slice(2),
    process.env,
    { write: (text) => process.stdout.write(text) },
    { write: (text) => process.stderr.write(text) },
    interrupt.signal,
  ).then((code) => (process.exitCode = code));
}
