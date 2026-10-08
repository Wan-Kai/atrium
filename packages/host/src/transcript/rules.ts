import { type AssistantPart, type LogMessage, toolDetails } from "@atrium/pi";
import { type FileChange, type Step, TOOL_OUTPUT_LIMIT, type Turn } from "@atrium/protocol";

/** A tool step. */
export type ToolStep = Extract<Step, { kind: "tool" }>;

/** A tool result, as both live events and session entries carry it. */
export type ToolResult = Pick<Extract<LogMessage, { kind: "toolResult" }>, "text" | "isError" | "details">;

/** How a turn that has ended came out. */
export type FinishedOutcome = Exclude<Turn["outcome"], "running">;

/** How the last assistant message of a turn ended, if it had one. */
export type LastStop = Extract<LogMessage, { kind: "assistant" }>["stopReason"] | null;

/**
 * The id of the step at a position in its turn.
 *
 * @remarks
 * Positions are what live events and a rebuild from entries agree on (SPEC-0001, "对话记录").
 *
 * @sideEffects none
 * @param position - The step's index in the turn.
 * @returns The id.
 */
export function stepId(position: number): string {
  return String(position);
}

/**
 * The step one block of an assistant message becomes.
 *
 * @remarks
 * A thinking step's duration is only known when timed live, which the caller adds. A tool call
 * starts running with the details its arguments give.
 *
 * @sideEffects none
 * @param part - The block.
 * @param position - Its step's index in the turn.
 * @returns The step.
 */
export function partStep(part: AssistantPart, position: number): Step {
  const id = stepId(position);
  if (part.type === "thinking") return { kind: "thinking", id, text: part.text, durationMs: null };
  if (part.type === "text") return { kind: "text", id, text: part.text };
  return {
    kind: "tool",
    id,
    callId: part.callId,
    tool: part.tool,
    args: part.args,
    status: "running",
    output: null,
    details: toolDetails(part.tool, part.args),
  };
}

/**
 * Cuts a tool's output to what travels in the transcript.
 *
 * @remarks
 * At most `TOOL_OUTPUT_LIMIT` bytes of UTF-8. A command's output keeps its end, where errors
 * and summaries are and the end pi itself keeps; other tools keep the start (SPEC-0001,
 * "对话记录"). The cut never splits a character.
 *
 * @sideEffects none
 * @param tool - The tool's name.
 * @param text - The whole output.
 * @returns The output to send.
 */
export function cutOutput(tool: string, text: string): NonNullable<ToolStep["output"]> {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= TOOL_OUTPUT_LIMIT) return { text, truncated: false };
  if (tool === "bash") {
    let start = bytes.length - TOOL_OUTPUT_LIMIT;
    // A continuation byte is the middle of a character.
    while ((bytes[start] ?? 0) >> 6 === 0b10) start += 1;
    return { text: bytes.subarray(start).toString("utf8"), truncated: true };
  }
  let end = TOOL_OUTPUT_LIMIT;
  while ((bytes[end] ?? 0) >> 6 === 0b10) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * A tool step with output it printed so far.
 *
 * @remarks
 * pi reports a running tool's whole output each time, not what is new (pi-internals.md).
 *
 * @sideEffects none
 * @param step - The running step.
 * @param text - The output so far.
 * @returns The updated step.
 */
export function withOutput(step: ToolStep, text: string): ToolStep {
  return { ...step, output: cutOutput(step.tool, text) };
}

/**
 * A tool step with its result.
 *
 * @remarks
 * The details are worked out again with the result's own, which hold an edit's diff.
 *
 * @sideEffects none
 * @param step - The step.
 * @param result - The tool's result.
 * @returns The finished step.
 */
export function withResult(step: ToolStep, result: ToolResult): ToolStep {
  return {
    ...step,
    status: result.isError ? "failed" : "done",
    output: cutOutput(step.tool, result.text),
    details: toolDetails(step.tool, step.args, result.details),
  };
}

/**
 * The steps of a turn that has ended.
 *
 * @remarks
 * A tool still running when its turn ends will get no result: the run was stopped or pi went
 * away (SPEC-0001, `unfinished`).
 *
 * @sideEffects none
 * @param steps - The turn's steps.
 * @returns The steps, with running tools unfinished.
 */
export function finishedSteps(steps: readonly Step[]): Step[] {
  return steps.map((step) =>
    step.kind === "tool" && step.status === "running" ? { ...step, status: "unfinished" } : step,
  );
}

/**
 * How a turn ended, from its last assistant message.
 *
 * @remarks
 * A turn whose last reply asked for tools, or that has no reply at all, ended before the model
 * answered: stopped, or pi went away. Retried failures are replies too: a retry that was stopped
 * while waiting leaves the failure last.
 *
 * @sideEffects none
 * @param last - The last assistant message's stop reason and error text, or `null`.
 * @returns The outcome and the error text to show.
 */
export function turnOutcome(
  last: { readonly stopReason: NonNullable<LastStop>; readonly errorMessage: string | null } | null,
): { readonly outcome: FinishedOutcome; readonly error: string | null } {
  if (last?.stopReason === "stop" || last?.stopReason === "length") return { outcome: "done", error: null };
  if (last?.stopReason === "error") return { outcome: "failed", error: last.errorMessage ?? "" };
  return { outcome: "stopped", error: null };
}

/**
 * The files a turn changed through its tools.
 *
 * @remarks
 * "已观测到的工具修改" (SPEC-0001): successful `edit`s add up their lines, so editing a file
 * twice counts both edits, not the net change; a `write` lists the file with no counts, and
 * once a file was written its counts are unknown. Files keep the order they were first changed.
 *
 * @sideEffects none
 * @param steps - The turn's steps.
 * @returns The changed files.
 */
export function turnChanges(steps: readonly Step[]): FileChange[] {
  const changes = new Map<string, FileChange>();
  for (const step of steps) {
    if (step.kind !== "tool" || step.status !== "done") continue;
    const details = step.details;
    if (details?.tool === "edit") {
      const known = changes.get(details.path);
      changes.set(details.path, {
        path: details.path,
        added: known === undefined ? details.added : known.added === null ? null : known.added + details.added,
        removed:
          known === undefined ? details.removed : known.removed === null ? null : known.removed + details.removed,
      });
    } else if (details?.tool === "write") {
      changes.set(details.path, { path: details.path, added: null, removed: null });
    }
  }
  return [...changes.values()];
}

/**
 * Adds an assistant message's tokens to a turn's.
 *
 * @remarks
 * Every reply counts, failed ones too: they were paid for (SPEC-0001, "本轮用量").
 *
 * @sideEffects none
 * @param usage - The turn's so far.
 * @param message - The message's.
 * @returns The sum.
 */
export function addUsage(
  usage: Turn["usage"],
  message: { readonly input: number; readonly output: number },
): NonNullable<Turn["usage"]> {
  return { input: (usage?.input ?? 0) + message.input, output: (usage?.output ?? 0) + message.output };
}
