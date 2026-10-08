import type { AssistantPart, LogMessage } from "@atrium/pi";
import type { Step, Turn } from "@atrium/protocol";
import {
  type FinishedOutcome,
  type LastStop,
  type ToolResult,
  addUsage,
  finishedSteps,
  partStep,
  stepId,
  turnChanges,
  turnOutcome,
  withOutput,
  withResult,
} from "./rules";

/** A turn that has ended. */
export type FinishedTurn = Turn & { readonly outcome: FinishedOutcome; readonly durationMs: number };

/** An assistant message, as both live events and session entries carry it. */
type AssistantMessage = Extract<LogMessage, { kind: "assistant" }>;

/** What the host measured of a turn it saw live, kept apart from pi's entries (SPEC-0001, "当场计时的数据"). */
export interface TurnFacts {
  readonly turnId: string;
  readonly clientMessageId: string | null;
  /** From the user message to the end of the run, by the host's clock. */
  readonly durationMs: number | null;
  /** How long each thinking step took, by step id. */
  readonly thinkingMs: ReadonlyMap<string, number>;
}

/**
 * A turn being put together, live from pi's events or from session entries.
 *
 * @remarks
 * Both build turns through this one class, so they place steps at the same positions and apply
 * the same rules (SPEC-0001, "对话记录"); each method returns the steps it added or changed, for
 * the live side to publish. An assistant message's block `i` is the step at the position the turn
 * had reached when the message started, plus `i`.
 *
 * @sideEffects none; each instance keeps one turn's state.
 */
export class TurnDraft {
  readonly #steps: Step[] = [];
  #usage: Turn["usage"] = null;
  #last: { readonly stopReason: NonNullable<LastStop>; readonly errorMessage: string | null } | null = null;
  /** Where the current assistant message's blocks begin. */
  #base = 0;
  /** The latest message's time, for a duration worked out from timestamps. */
  #lastTime: number;
  /** Whether the latest message was a tool result, which makes a following user message a steer. */
  #afterToolResult = false;

  /**
   * Starts a turn at its user message.
   *
   * @remarks
   * The turn starts at the user message's own time, as a rebuild sees it too.
   *
   * @sideEffects none
   * @param id - The turn's id.
   * @param user - The user message.
   */
  constructor(
    readonly id: string,
    readonly user: Turn["user"],
  ) {
    this.#lastTime = user.timestamp;
  }

  /**
   * Whether a user message now would be a steer rather than a new turn.
   *
   * @remarks
   * pi's file does not tell steers from new messages; one right after a tool result, before the
   * model replies again, is a steer (SPEC-0001, "对话记录").
   *
   * @sideEffects none
   * @returns Whether it would be a steer.
   */
  get takesSteer(): boolean {
    return this.#afterToolResult;
  }

  /**
   * The steps so far.
   *
   * @remarks
   * The draft's own list; callers only read it.
   *
   * @sideEffects none
   * @returns The steps.
   */
  get steps(): readonly Step[] {
    return this.#steps;
  }

  /**
   * Notes that an assistant message starts, so its blocks know their positions.
   *
   * @remarks
   * Its blocks go after every step so far (see the class).
   *
   * @sideEffects Updates the draft.
   */
  startAssistant(): void {
    this.#base = this.#steps.length;
  }

  /**
   * Puts one block of the current assistant message in place.
   *
   * @remarks
   * Live, a block arrives when it starts; a block already in place is replaced.
   *
   * @sideEffects Updates the draft.
   * @param index - The block's index in its message.
   * @param part - The block.
   * @returns The step, and whether it is new.
   */
  setPart(index: number, part: AssistantPart): { readonly step: Step; readonly added: boolean } {
    const position = this.#base + index;
    const step = partStep(part, position);
    const added = position >= this.#steps.length;
    if (added) this.#steps.push(step);
    else this.#steps[position] = step;
    return { step, added };
  }

  /**
   * Appends streamed text to a thinking or text step.
   *
   * @remarks
   * Text arrives in pieces live; the finished message replaces it with the final text anyway.
   *
   * @sideEffects Updates the draft.
   * @param index - The block's index in its message.
   * @param delta - The new text.
   * @returns The step's id, or `null` if there is no such step to grow.
   */
  appendText(index: number, delta: string): string | null {
    const step = this.#steps[this.#base + index];
    if (step?.kind !== "thinking" && step?.kind !== "text") return null;
    this.#steps[this.#base + index] = { ...step, text: step.text + delta };
    return step.id;
  }

  /**
   * Sets how long a thinking step took.
   *
   * @remarks
   * Only the host's live timing knows this; history has no durations (SPEC-0001, "当场计时的数据").
   *
   * @sideEffects Updates the draft.
   * @param id - The step's id.
   * @param durationMs - Its duration.
   * @returns The updated step, or `null` if it is not a thinking step.
   */
  timeThinking(id: string, durationMs: number): Step | null {
    const position = Number(id);
    const step = this.#steps[position];
    if (step?.kind !== "thinking") return null;
    const timed = { ...step, durationMs };
    this.#steps[position] = timed;
    return timed;
  }

  /**
   * Finishes the current assistant message with its final content.
   *
   * @remarks
   * Blocks are set again from the finished message, which may differ from what streamed; a
   * thinking step keeps a duration it was given. The message's tokens count towards the turn's.
   *
   * @sideEffects Updates the draft.
   * @param message - The finished message.
   * @returns The steps that were added or changed, in order.
   */
  finishAssistant(message: AssistantMessage): { readonly step: Step; readonly added: boolean }[] {
    const changed: { step: Step; added: boolean }[] = [];
    message.parts.forEach((part, index) => {
      const before = this.#steps[this.#base + index];
      let { step, added } = this.setPart(index, part);
      if (before?.kind === "thinking" && step.kind === "thinking" && before.durationMs !== null) {
        step = { ...step, durationMs: before.durationMs };
        this.#steps[this.#base + index] = step;
      }
      if (added || JSON.stringify(before) !== JSON.stringify(step)) changed.push({ step, added });
    });
    this.#usage = addUsage(this.#usage, message.usage);
    this.#last = { stopReason: message.stopReason, errorMessage: message.errorMessage };
    this.#afterToolResult = false;
    this.#lastTime = message.timestamp;
    return changed;
  }

  /**
   * Records a running tool's output so far.
   *
   * @remarks
   * Output that arrives after the tool finished is ignored; the result has the final output.
   *
   * @sideEffects Updates the draft.
   * @param callId - pi's call id.
   * @param text - The whole output so far.
   * @returns The updated step, or `null` if no running tool has this call id.
   */
  toolOutput(callId: string, text: string): Step | null {
    const position = this.#findTool(callId);
    const step = this.#steps[position];
    if (step?.kind !== "tool" || step.status !== "running") return null;
    const updated = withOutput(step, text);
    this.#steps[position] = updated;
    return updated;
  }

  /**
   * Records a tool's result.
   *
   * @remarks
   * Results pair with calls by call id, not by position (domain-model §2).
   *
   * @sideEffects Updates the draft.
   * @param callId - pi's call id.
   * @param result - The result.
   * @param timestamp - The result message's time.
   * @returns The updated step, or `null` if no tool has this call id.
   */
  toolResult(callId: string, result: ToolResult, timestamp: number): Step | null {
    this.#afterToolResult = true;
    this.#lastTime = timestamp;
    const position = this.#findTool(callId);
    const step = this.#steps[position];
    if (step?.kind !== "tool") return null;
    const updated = withResult(step, result);
    this.#steps[position] = updated;
    return updated;
  }

  /**
   * Adds a steer: a user message sent while the turn ran.
   *
   * @remarks
   * See `takesSteer`.
   *
   * @sideEffects Updates the draft.
   * @param text - The message's text.
   * @param timestamp - Its time.
   * @returns The step.
   */
  steer(text: string, timestamp: number): Step {
    return this.#push({ kind: "steer", id: stepId(this.#steps.length), text }, timestamp);
  }

  /**
   * Adds an automatic retry after a failed reply.
   *
   * @remarks
   * It follows whatever the failed reply had already put out, so that is never taken for the
   * turn's reply (SPEC-0001, `retry`).
   *
   * @sideEffects Updates the draft.
   * @param attempt - Which attempt this is, counted as pi does.
   * @param error - pi's error text for the failed reply.
   * @returns The step.
   */
  retry(attempt: number, error: string): Step {
    return this.#push({ kind: "retry", id: stepId(this.#steps.length), attempt, error }, this.#lastTime);
  }

  /**
   * The turn as it stands while it runs.
   *
   * @remarks
   * Usage and changes come with `turn_finished`, so a running turn has none yet, whether a
   * client builds it from events or gets it in a snapshot.
   *
   * @sideEffects none
   * @returns The turn.
   */
  running(): Turn {
    return {
      kind: "turn",
      id: this.id,
      user: this.user,
      steps: [...this.#steps],
      outcome: "running",
      error: null,
      startedAt: this.user.timestamp,
      durationMs: null,
      usage: null,
      changes: [],
    };
  }

  /**
   * Ends the turn.
   *
   * @remarks
   * Tools without a result become `unfinished`; the outcome comes from the last reply. The
   * duration is the one measured live if there is one, otherwise worked out from the messages'
   * timestamps, which is approximate (SPEC-0001, "滚动与长会话"). Live-timed thinking durations
   * are put back on their steps.
   *
   * @sideEffects Updates the draft.
   * @param facts - What the host measured of this turn live, if it saw it.
   * @returns The steps that changed, and the finished turn.
   */
  finish(facts: TurnFacts | undefined): { readonly changed: Step[]; readonly turn: FinishedTurn } {
    const changed: Step[] = [];
    finishedSteps(this.#steps).forEach((step, position) => {
      const durationMs = step.kind === "thinking" ? facts?.thinkingMs.get(step.id) : undefined;
      const final =
        step.kind !== "thinking" || durationMs === undefined || durationMs === step.durationMs
          ? step
          : { ...step, durationMs };
      if (final !== this.#steps[position]) {
        this.#steps[position] = final;
        changed.push(final);
      }
    });
    const turn: FinishedTurn = {
      ...this.running(),
      ...turnOutcome(this.#last),
      durationMs: facts?.durationMs ?? Math.max(0, this.#lastTime - this.user.timestamp),
      usage: this.#usage,
      changes: turnChanges(this.#steps),
    };
    return { changed, turn };
  }

  /**
   * Appends a step that comes from no assistant message.
   *
   * @remarks
   * Such a step is not a tool result, so a user message after it starts a new turn.
   *
   * @sideEffects Updates the draft.
   * @param step - The step.
   * @param timestamp - When it happened.
   * @returns The step.
   */
  #push(step: Step, timestamp: number): Step {
    this.#steps.push(step);
    this.#afterToolResult = false;
    this.#lastTime = timestamp;
    return step;
  }

  /**
   * Finds the latest tool step with a call id.
   *
   * @remarks
   * Call ids are unique in practice; the latest wins if a provider ever repeats one.
   *
   * @sideEffects none
   * @param callId - pi's call id.
   * @returns Its position, or -1.
   */
  #findTool(callId: string): number {
    return this.#steps.findLastIndex((step) => step.kind === "tool" && step.callId === callId);
  }
}
