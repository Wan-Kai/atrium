import { type AssistantPart, type LogMessage, toolDetails } from "@atrium/pi";
import { type FileChange, STEP_TEXT_LIMIT, type Step, type TranscriptItem, type Turn } from "@atrium/protocol";

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
 * starts running with the details its arguments give; a `write` call's content goes into its
 * details only, not again in its arguments (SPEC-0001, "对话记录").
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
  const details = toolDetails(part.tool, part.args);
  return {
    kind: "tool",
    id,
    callId: part.callId,
    tool: part.tool,
    args: details?.tool === "write" ? withoutKey(part.args, "content") : part.args,
    status: "running",
    output: null,
    details,
    partial: false,
  };
}

/**
 * A copy of an object without one key.
 *
 * @remarks
 * See `partStep`.
 *
 * @sideEffects none
 * @param object - The object.
 * @param key - The key to leave out.
 * @returns The copy.
 */
function withoutKey(object: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
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
  return { ...step, output: text };
}

/**
 * A tool step with its result.
 *
 * @remarks
 * The details are worked out again with the result's own, which hold an edit's diff; a write's
 * content stays where `partStep` put it.
 *
 * @sideEffects none
 * @param step - The step.
 * @param result - The tool's result.
 * @returns The finished step.
 */
export function withResult(step: ToolStep, result: ToolResult): ToolStep {
  const details = step.details?.tool === "write" ? step.details : toolDetails(step.tool, step.args, result.details);
  return { ...step, status: result.isError ? "failed" : "done", output: result.text, details };
}

/**
 * A preview of a long text: its start, or its end.
 *
 * @remarks
 * At most `STEP_TEXT_LIMIT` bytes of UTF-8, never cutting a character in half.
 *
 * @sideEffects none
 * @param text - The text, longer than the limit.
 * @param keepEnd - Whether to keep the end rather than the start.
 * @returns The preview.
 */
function preview(text: string, keepEnd: boolean): string {
  // Stryker disable next-line StringLiteral: an empty encoding is UTF-8.
  const bytes = Buffer.from(text, "utf8");
  if (keepEnd) {
    let start = bytes.length - STEP_TEXT_LIMIT;
    // A continuation byte is the middle of a character.
    while ((bytes[start] ?? 0) >> 6 === 0b10) start += 1;
    return bytes.subarray(start).toString("utf8");
  }
  let end = STEP_TEXT_LIMIT;
  while ((bytes[end] ?? 0) >> 6 === 0b10) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * Whether a text is too long to travel whole.
 *
 * @remarks
 * See `forTransport`.
 *
 * @sideEffects none
 * @param text - The text.
 * @returns Whether it is over `STEP_TEXT_LIMIT` bytes.
 */
function tooLong(text: string): boolean {
  // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: the length check only spares counting the bytes of short text, which cannot be too long; an empty encoding is UTF-8.
  return text.length > STEP_TEXT_LIMIT / 4 && Buffer.byteLength(text, "utf8") > STEP_TEXT_LIMIT;
}

/**
 * A step as events, snapshots and pages carry it.
 *
 * @remarks
 * Nothing is cut away for good (SPEC-0001, "大内容"): long text of a tool step, its output, a
 * write's content, an edit's diff and long strings in its arguments, travels as a preview, and
 * the step says it is `partial`, so the UI can fetch it whole. A command's output keeps its end,
 * where errors are, as pi does; every other text keeps its start. Short steps are returned as
 * they are.
 *
 * @sideEffects none
 * @param step - The whole step.
 * @returns The step to send.
 */
export function forTransport(step: Step): Step {
  if (step.kind !== "tool") return step;
  let partial = false;
  /**
   * Shortens one text if it is too long.
   *
   * @remarks
   * See `forTransport`.
   *
   * @sideEffects Marks the step partial.
   * @param text - The text.
   * @param keepEnd - Whether a preview keeps the end.
   * @returns The text or its preview.
   */
  const shorten = (text: string, keepEnd = false): string => {
    if (!tooLong(text)) return text;
    partial = true;
    return preview(text, keepEnd);
  };
  /**
   * Shortens the long strings anywhere in an argument value.
   *
   * @remarks
   * Arguments are any JSON the model wrote.
   *
   * @sideEffects Marks the step partial.
   * @param value - The value.
   * @returns The value with long strings shortened.
   */
  const shortenValue = (value: unknown): unknown => {
    if (typeof value === "string") return shorten(value);
    if (Array.isArray(value)) return value.map(shortenValue);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shortenValue(item)]));
    }
    return value;
  };
  const args = Object.fromEntries(Object.entries(step.args).map(([key, value]) => [key, shortenValue(value)]));
  const output = step.output === null ? null : shorten(step.output, step.tool === "bash");
  let details = step.details;
  if (details?.tool === "write") details = { ...details, content: shorten(details.content) };
  else if (details?.tool === "edit" && details.diff !== null) details = { ...details, diff: shorten(details.diff) };
  return partial ? { ...step, args, output, details, partial } : step;
}

/**
 * An item as events, snapshots and pages carry it.
 *
 * @remarks
 * See `forTransport`.
 *
 * @sideEffects none
 * @param item - The whole item.
 * @returns The item to send.
 */
export function itemForTransport(item: TranscriptItem): TranscriptItem {
  if (item.kind !== "turn") return item;
  const steps = item.steps.map(forTransport);
  return steps.every((step, index) => step === item.steps[index]) ? item : { ...item, steps };
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
  return steps.map(finishedStep);
}

/**
 * One step of a turn that has ended.
 *
 * @remarks
 * See `finishedSteps`.
 *
 * @sideEffects none
 * @param step - The step.
 * @returns The step, unfinished if it was a running tool.
 */
function finishedStep(step: Step): Step {
  // Stryker disable next-line ConditionalExpression: a step that is not a tool has no status.
  if (step.kind !== "tool" || step.status !== "running") return step;
  return { ...step, status: "unfinished" };
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
    // Stryker disable next-line ConditionalExpression: a step that is not a tool has no status, which is never "done".
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
