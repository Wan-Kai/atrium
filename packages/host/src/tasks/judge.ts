import type { PiEvent } from "@atrium/pi";

/*
 * Whether a node's `node_done` stands, judged from pi's events (SPEC-0006, "扩展与通道 · T4a 定下的细节").
 * Pure: the runner feeds it what pi printed and what the host answered, and acts on what it says.
 */

/** How a node's turn ended, as the judge tells the runner. */
export type Ending =
  /** An accepted `node_done` stands. */
  | { readonly kind: "done" }
  /** An accepted `request_graph_change` stands. */
  | { readonly kind: "graph_change" }
  /** The turn ended normally with nothing that stands: `no_done`, or a hold. */
  | { readonly kind: "none" }
  /** The turn was stopped. */
  | { readonly kind: "stopped" }
  /** The turn ended in an error pi did not get over. */
  | { readonly kind: "error" };

/** What the judge says after an input. */
export type Verdict =
  /** The waiting call no longer counts. */
  | { readonly kind: "void" }
  /** The run is over. */
  | { readonly kind: "ended"; readonly ending: Ending };

/** The call that is waiting for the turn to end. */
type Pending = "done" | "graph_change";

/** What the judge remembers of one pi process's run. */
export interface JudgeState {
  /** The accepted call that would stand if the turn ended now. */
  readonly pending: Pending | null;
  /** Whether the last assistant message was an error, or pi gave up retrying. */
  readonly failed: boolean;
  /** Whether a run is going: from `agent_start` to `agent_settled`. */
  readonly running: boolean;
}

/** The judge's state before anything has happened. */
export const JUDGE_START: JudgeState = { pending: null, failed: false, running: false };

/**
 * What the judge is given.
 *
 * @remarks
 * Either a pi event, or the host accepting a call (it answered `recorded`).
 */
export type JudgeInput =
  | { readonly kind: "accepted"; readonly call: Pending }
  | { readonly kind: "pi"; readonly event: PiEvent };

/**
 * Whether the last assistant message of a finished run ended in an error.
 *
 * @remarks
 * `agent_end` carries the run's messages; a message ends in an error when its `stopReason` is `error`.
 *
 * @sideEffects none
 * @param event - The `agent_end` event.
 * @returns Whether it did.
 */
function endedInError(event: PiEvent): boolean {
  const messages: unknown = Reflect.get(event, "messages");
  if (!Array.isArray(messages)) return false;
  const last: unknown = messages.findLast((message: unknown) => Reflect.get(Object(message), "role") === "assistant");
  return last !== undefined && Reflect.get(Object(last), "stopReason") === "error";
}

/**
 * Takes one input and says what changed.
 *
 * @remarks
 * SPEC-0006, "T4a 定下的细节": a call the host accepted is waiting; a later `turn_start` voids it (pi began
 * another request: the same batch had other tools, or someone spoke); an `agent_end` whose last message is
 * an error voids it; `agent_settled` with `aborted: true` voids it (a stop makes pi print a `turn_start` and
 * an error too, so `aborted` is looked at first); at `agent_settled` what still waits stands, and with
 * nothing waiting the turn ended with none, unless it was stopped or ended in an error. A failed model call
 * pi retries and wins is no failure: each `agent_end` sets the flag again.
 *
 * @sideEffects none
 * @param state - What the judge knew.
 * @param input - The new input.
 * @returns The new state and what to tell the runner, in order.
 */
export function judge(state: JudgeState, input: JudgeInput): { state: JudgeState; verdicts: Verdict[] } {
  if (input.kind === "accepted") return { state: { ...state, pending: input.call }, verdicts: [] };
  const { event } = input;
  if (event.type === "agent_start") return { state: { ...state, running: true }, verdicts: [] };
  if (event.type === "turn_start") {
    // pi began another request while a call waited.
    return {
      state: { ...state, pending: null, running: true },
      verdicts: state.pending === null ? [] : [{ kind: "void" }],
    };
  }
  if (event.type === "auto_retry_end") {
    const success: unknown = Reflect.get(event, "success");
    return success === false ? { state: { ...state, failed: true }, verdicts: [] } : { state, verdicts: [] };
  }
  if (event.type === "agent_end") {
    const failed = endedInError(event);
    return {
      state: { ...state, failed, pending: failed ? null : state.pending },
      verdicts: failed && state.pending !== null ? [{ kind: "void" }] : [],
    };
  }
  if (event.type === "agent_settled") {
    const verdicts: Verdict[] = [];
    let ending: Ending;
    if (Reflect.get(event, "aborted") === true) {
      if (state.pending !== null) verdicts.push({ kind: "void" });
      ending = { kind: "stopped" };
    } else if (state.failed) {
      if (state.pending !== null) verdicts.push({ kind: "void" });
      ending = { kind: "error" };
    } else if (state.pending === "done") ending = { kind: "done" };
    else if (state.pending === "graph_change") ending = { kind: "graph_change" };
    else ending = { kind: "none" };
    verdicts.push({ kind: "ended", ending });
    return { state: JUDGE_START, verdicts };
  }
  return { state, verdicts: [] };
}
