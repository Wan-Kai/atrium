import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

/** Environment variable naming the file the probe appends its observations to, one JSON object per line. */
export const TASK_PROBE_LOG_ENV = "TASK_PROBE_LOG";
/** Environment variable listing, comma-separated, the tools the probe's `tool_call` hook blocks. */
export const TASK_PROBE_BLOCK_ENV = "TASK_PROBE_BLOCK_TOOLS";
/** What the model is told when the hook blocks a call. */
export const TASK_PROBE_BLOCK_REASON = "Blocked by the task probe.";
/** The hidden command that sends a custom message: `/task-probe-wake trigger` or `/task-probe-wake quiet`. */
export const TASK_PROBE_WAKE = "task-probe-wake";
/** The custom type of the message the wake command sends. */
export const TASK_PROBE_MESSAGE = "task-probe";
/** How long the timed tools take, long enough for two parallel ones to overlap clearly. */
export const TASK_PROBE_SLOW_MS = 200;

/** One line of the probe's log. */
export type TaskProbeRecord =
  | { readonly kind: "tool"; readonly name: string; readonly phase: "start" | "end"; readonly at: number }
  | { readonly kind: "hook"; readonly name: string; readonly input: unknown };

/**
 * Appends one observation to the probe's log file, if the test asked for one.
 *
 * @remarks
 * The probe runs inside pi's process, so a file is the only way for the test to see what happened
 * in which order; the clock is the process's own, so both ends of a tool share it.
 *
 * @sideEffects Appends a line to the file named by {@link TASK_PROBE_LOG_ENV}.
 * @param record - The observation.
 */
function log(record: TaskProbeRecord): void {
  const file = process.env[TASK_PROBE_LOG_ENV];
  if (file !== undefined) appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/**
 * A test-only pi extension that tries out what SPEC-0006's task runner relies on in pi.
 *
 * @remarks
 * `task_done` stands in for `node_done` by returning `terminate: true`; `task_note` is an ordinary
 * tool to batch it with. The `seq_*` tools declare `executionMode: "sequential"` and the `par_*` tools
 * do not, and all four log when they start and end. `/task-probe-wake` sends a custom message with or
 * without `triggerTurn`, as the host's wake-up will. The `tool_call` hook logs every call's input and
 * blocks the tools named in {@link TASK_PROBE_BLOCK_ENV}, as the path guard will. It is not the
 * extension Atrium ships.
 *
 * @sideEffects Registers tools, a command and a `tool_call` hook with pi; the tools and the hook
 * append to the log file.
 * @param pi - pi's extension API.
 */
export default function taskProbe(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "task_done",
    label: "Task done",
    description: "Ends the node: the result carries terminate.",
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ content: [{ type: "text", text: "done" }], details: {}, terminate: true }),
  });
  pi.registerTool({
    name: "task_note",
    label: "Task note",
    description: "An ordinary tool.",
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ content: [{ type: "text", text: "noted" }], details: {} }),
  });
  for (const name of ["seq_a", "seq_b", "par_a", "par_b"]) {
    pi.registerTool({
      name,
      label: name,
      description: "Takes a while and logs when it starts and ends.",
      parameters: Type.Object({}),
      ...(name.startsWith("seq") ? { executionMode: "sequential" as const } : {}),
      async execute() {
        log({ kind: "tool", name, phase: "start", at: Date.now() });
        await new Promise((resolve) => setTimeout(resolve, TASK_PROBE_SLOW_MS));
        log({ kind: "tool", name, phase: "end", at: Date.now() });
        return { content: [{ type: "text", text: name }], details: {} };
      },
    });
  }
  pi.registerCommand(TASK_PROBE_WAKE, {
    description: "Sends a custom message, with or without starting a turn (hidden; tests send it)",
    handler: (args) => {
      pi.sendMessage(
        { customType: TASK_PROBE_MESSAGE, content: "woken", display: true },
        { triggerTurn: args.trim() === "trigger" },
      );
      return Promise.resolve();
    },
  });
  const blocked = (process.env[TASK_PROBE_BLOCK_ENV] ?? "").split(",").filter((name) => name !== "");
  pi.on("tool_call", (event) => {
    log({ kind: "hook", name: event.toolName, input: event.input });
    return blocked.includes(event.toolName) ? { block: true, reason: TASK_PROBE_BLOCK_REASON } : undefined;
  });
}
