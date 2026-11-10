import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { activeGraphOf, latestRun, stateOf } from "../tasks/graph";
import { type ReplayStep, replayEvents } from "../tasks/replay";
import { deriveStatus } from "../tasks/status";
import { parseEvents } from "../tasks/task-store";
import type { Action, Task, TaskEvent } from "../tasks/types";

const USAGE = "usage: pnpm task:replay <task directory | events.jsonl>";

/** Where `runReplay` writes. */
export interface ReplayOutput {
  write(text: string): void;
}

/**
 * Describes the payload of an event in a few words.
 *
 * @remarks
 * Everything but `seq`, `at` and `type`, as `key=value`; the big payloads (a task, a graph) are
 * shown as their size so a line stays one line.
 *
 * @sideEffects none
 * @param event - The event.
 * @returns The description; empty when the event has no payload.
 */
export function describeEvent(event: TaskEvent): string {
  const { seq: _seq, at: _at, type: _type, ...payload } = event;
  return Object.entries(payload)
    .map(([key, value]) => {
      if (key === "task" && typeof value === "object" && value !== null && "name" in value)
        return `task=${String(value.name)}`;
      if (Array.isArray(value)) return `${key}=${value.length}`;
      return `${key}=${String(value)}`;
    })
    .join(" ");
}

/**
 * Describes one action in a few words.
 *
 * @remarks
 * The kind and what it names, so that a reader can see what the runner would be asked to do.
 *
 * @sideEffects none
 * @param action - The action.
 * @returns The description.
 */
export function describeAction(action: Action): string {
  switch (action.kind) {
    case "start_node":
      return `start_node ${action.node}#${action.attempt}`;
    case "resume_node":
      return `resume_node ${action.node}`;
    case "stop_node":
      return `stop_node ${action.node} ${action.when}`;
    case "nudge_node":
      return `nudge_node ${action.node}`;
    case "commit_node":
      return `commit_node ${action.node}#${action.attempt}`;
    case "merge":
      return `merge ${action.node}`;
    case "progress_line":
      return `progress ${action.line.kind}${action.line.node === undefined ? "" : ` ${action.line.node}`}`;
    case "wake_task_conversation":
      return "wake_task_conversation";
    case "notify":
      return `notify ${action.attention.kind}${"node" in action.attention ? ` ${action.attention.node}` : ""}${"reason" in action.attention ? ` ${action.attention.reason}` : ""}`;
    case "ensure_workspace":
    case "lock_workspace":
    case "unlock_workspace":
    case "ask_archive":
      return action.kind;
  }
  return "unknown";
}

/**
 * Describes the state of every node of the graph in force.
 *
 * @remarks
 * `N1=running`, with `#2` for a later attempt and `*` for a run voided by a graph change.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns One line.
 */
export function describeNodes(task: Task): string {
  const graph = activeGraphOf(task);
  if (graph === undefined) return "(no graph)";
  return graph.nodes
    .map((node) => {
      const run = latestRun(task, node.id);
      const attempt = run !== undefined && run.attempt > 1 ? `#${run.attempt}` : "";
      const wait =
        run?.state === "waiting" && run.void !== true && run.waitingFor !== null ? `(${run.waitingFor})` : "";
      return `${node.id}=${stateOf(task, node.id)}${wait}${attempt}${run?.void === true ? "*" : ""}`;
    })
    .join(" ");
}

/**
 * Formats a replay as text: for each event, the node states, the task status and the actions.
 *
 * @remarks
 * Made for reading a fixture line by line and judging whether the states make sense
 * (roadmap T3, "你来验收"). Times are UTC.
 *
 * @sideEffects none
 * @param steps - The steps of `replayEvents`.
 * @returns The text, ending with a newline.
 */
export function formatReplay(steps: readonly ReplayStep[]): string {
  const lines: string[] = [];
  for (const { event, task, actions } of steps) {
    const time = new Date(event.at).toISOString().slice(11, 19);
    const detail = describeEvent(event);
    lines.push(`#${event.seq} ${time} ${event.type}${detail === "" ? "" : ` ${detail}`}`);
    lines.push(`    nodes   ${describeNodes(task)}`);
    lines.push(`    task    ${deriveStatus(task)}${task.paused ? " (paused)" : ""}`);
    if (actions.length > 0) lines.push(`    actions ${actions.map(describeAction).join(" | ")}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Replays a task's event log and prints it.
 *
 * @remarks
 * Reads only: the log is never repaired or written, so it can be pointed at a real task
 * directory (`~/.atrium/tasks/<id>`) while the host is running. A cut last line is reported and
 * left out, as the store would drop it.
 *
 * @sideEffects Reads the file; writes to `out`.
 * @param target - A task directory (its `events.jsonl` is read) or an event file.
 * @param out - Where the text goes.
 * @returns The exit code: 0 on success, 1 when the log cannot be read or replayed.
 */
export async function runReplay(target: string, out: ReplayOutput): Promise<number> {
  const path = (await stat(target)).isDirectory() ? join(target, "events.jsonl") : target;
  const parsed = parseEvents(await readFile(path, "utf8"), path);
  const steps = replayEvents(parsed.events);
  out.write(formatReplay(steps));
  if (parsed.droppedTail) out.write("(the last line was cut short and is left out)\n");
  return 0;
}

/**
 * Entry point of `pnpm task:replay`: parses the arguments and runs, returning the exit code.
 *
 * @remarks
 * pnpm runs scripts from the repository root, so a relative path is taken from `INIT_CWD`, the
 * directory the command was typed in.
 *
 * @sideEffects As `runReplay`; writes errors to `stderr`.
 * @param argv - Arguments after the script name.
 * @param env - The process environment.
 * @param stdout - Where the replay goes.
 * @param stderr - Where errors go.
 * @returns The exit code: 2 for a usage error, 1 for an unreadable log, else 0.
 */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  stdout: ReplayOutput,
  stderr: ReplayOutput,
): Promise<number> {
  const [target, ...rest] = argv;
  if (target === undefined || rest.length > 0) {
    stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    // Stryker disable next-line LogicalOperator: pnpm always sets INIT_CWD; the fallback is for running the bundle by hand.
    return await runReplay(resolve(env["INIT_CWD"] ?? process.cwd(), target), stdout);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// Stryker disable all: this only runs as the bundled command; `main` above is tested directly.
if (process.argv[1]?.endsWith("task-replay.cjs") === true) {
  // Fire and forget: the chain cannot reject, and the process exits when it settles.
  void main(
    process.argv.slice(2),
    process.env,
    { write: (text) => process.stdout.write(text) },
    { write: (text) => process.stderr.write(text) },
  ).then((code) => (process.exitCode = code));
}
