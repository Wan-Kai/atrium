import type { AssistantPart, LogMessage } from "@atrium/pi";
import type { AgentSource, MessageCommand, Step, Turn } from "@atrium/protocol";
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

/** A user message, as both live events and session entries carry it. */
type UserMessage = Extract<LogMessage, { kind: "user" }>;

/**
 * The skill a user message started with, as the transcript names it.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的 `/` 命令"): the turn shows the skill as a tag before what followed it.
 *
 * @sideEffects none
 * @param message - The user message.
 * @returns The command, or `null` when the message started with no skill.
 */
export function messageCommand(message: Pick<UserMessage, "skill">): MessageCommand | null {
  return message.skill === null ? null : { kind: "skill", name: message.skill };
}

/**
 * The text a steer shows: what was sent, the skill's name back in front of it when it had one.
 *
 * @remarks
 * A steer step has only text, no tag, so the skill is written as it was typed.
 *
 * @sideEffects none
 * @param message - The user message.
 * @returns The text.
 */
export function steerText(message: Pick<UserMessage, "skill" | "text">): string {
  if (message.skill === null) return message.text;
  return message.text === "" ? `/skill:${message.skill}` : `/skill:${message.skill} ${message.text}`;
}

/** What the host measured of a turn it saw live, kept apart from pi's entries (SPEC-0001, "当场计时的数据"). */
export interface TurnFacts {
  readonly turnId: string;
  readonly clientMessageId: string | null;
  /** The host sent the message to have the agent go on (SPEC-0001, "运行控制"). */
  readonly auto: boolean;
  /** From the user message to the end of the run, by the host's clock. */
  readonly durationMs: number | null;
  /** How long each thinking step took, by step id. */
  readonly thinkingMs: ReadonlyMap<string, number>;
  /** pi's limit on retries, when one was seen live; pi's file does not keep it. */
  readonly retryLimit: number | null;
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
/**
 * The user message of a turn notices or a task opened: there is none.
 *
 * @remarks
 * Such a turn shows its `source` instead (SPEC-0002, "显示 · 由通知开头的轮").
 *
 * @sideEffects none
 * @param timestamp - When the message that opened it was written.
 * @returns The empty user message.
 */
export function noUser(timestamp: number): Turn["user"] {
  return { text: "", images: 0, clientMessageId: null, auto: false, command: null, timestamp };
}

/**
 * A turn being built from pi's events, until it ends.
 *
 * @remarks
 * Opened by your message, or by notices or a task (SPEC-0002, "对话记录里的自定义消息").
 *
 * @sideEffects none
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
  #retryLimit: number | null;

  /**
   * Starts a turn at its user message.
   *
   * @remarks
   * The turn starts at the user message's own time, as a rebuild sees it too. A rebuild passes the
   * retry limit seen live, so its retry steps match the ones sent then.
   *
   * @sideEffects none
   * @param id - The turn's id.
   * @param user - The user message; empty for a turn notices or a task opened.
   * @param retryLimit - pi's limit on retries, if known.
   * @param source - What opened the turn when it was not you (SPEC-0002, "对话记录里的自定义消息").
   */
  constructor(
    readonly id: string,
    readonly user: Turn["user"],
    retryLimit: number | null,
    readonly source: AgentSource | null = null,
  ) {
    this.#lastTime = user.timestamp;
    this.#retryLimit = retryLimit;
  }

  /**
   * pi's limit on retries, once known.
   *
   * @remarks
   * Kept with the turn's facts, so a rebuild shows the limit seen live.
   *
   * @sideEffects none
   * @returns The limit, or null.
   */
  get retryLimit(): number | null {
    return this.#retryLimit;
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
    this.#steps[position] = step;
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
      // An untimed step copies `null`, which changes nothing.
      if (before?.kind === "thinking" && step.kind === "thinking") {
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
   * Adds notices or a task that came in while the turn ran.
   *
   * @remarks
   * Placed as a steer is, by the same rule (`takesSteer`; SPEC-0002, "对话记录里的自定义消息").
   *
   * @sideEffects Updates the draft.
   * @param source - What came in.
   * @param timestamp - Its time.
   * @returns The step.
   */
  delivered(source: AgentSource, timestamp: number): Step {
    return this.#push({ kind: "agent", id: stepId(this.#steps.length), source }, timestamp);
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
   * @param limit - pi's limit, when it tells it (live); otherwise the one the turn knows.
   * @returns The step.
   */
  retry(attempt: number, error: string, limit: number | null = this.#retryLimit): Step {
    this.#retryLimit = limit;
    return this.#push(
      { kind: "retry", id: stepId(this.#steps.length), attempt, maxAttempts: limit, error },
      this.#lastTime,
    );
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
      source: this.source,
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
   * Tools without a result become `unfinished`; the outcome comes from the last reply, unless pi
   * went away mid-turn: then it failed, with no text of pi's to show (SPEC-0001, `turn_finished`). The
   * duration is the one measured live if there is one, otherwise worked out from the messages'
   * timestamps, which is approximate (SPEC-0001, "滚动与长会话"). Live-timed thinking durations
   * are put back on their steps.
   *
   * @sideEffects Updates the draft.
   * @param facts - What the host measured of this turn live, if it saw it.
   * @param crashed - Whether pi went away mid-turn, which fails the turn whatever its last reply.
   * @returns The steps that changed, and the finished turn.
   */
  finish(facts: TurnFacts | undefined, crashed = false): { readonly changed: Step[]; readonly turn: FinishedTurn } {
    const changed: Step[] = [];
    finishedSteps(this.#steps).forEach((step, position) => {
      // Stryker disable next-line ConditionalExpression: only thinking steps are ever timed, so other steps have no duration to look up.
      const durationMs = step.kind === "thinking" ? facts?.thinkingMs.get(step.id) : undefined;
      const final =
        // Stryker disable next-line ConditionalExpression: see above; other steps found no duration.
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
      ...(crashed ? { outcome: "failed" as const, error: null } : turnOutcome(this.#last)),
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
    // Stryker disable next-line ConditionalExpression: only tool steps have a call id.
    return this.#steps.findLastIndex((step) => step.kind === "tool" && step.callId === callId);
  }
}
