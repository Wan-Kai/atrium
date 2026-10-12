import {
  type CommandResult,
  type Control,
  IDLE_CONTROL,
  type SessionEvent,
  type SessionMetrics,
  type SessionModel,
  type Step,
  type TranscriptItem,
  type Turn,
  UNKNOWN_METRICS,
} from "@atrium/protocol";

/** A user message shown before the host confirms it (domain-model §7). */
export interface PendingMessage {
  /** The `requestId` of the `prompt` that sent it; the turn it opens carries the same id. */
  readonly clientMessageId: string;
  readonly text: string;
  /** How many images go with it, when any. */
  readonly images?: number;
}

/** What the client knows about one session it watches. */
export interface SessionView {
  readonly sessionId: string;
  /** `loading` until the first snapshot; `exited` once pi has ended; `lost` when the host restarted without it. */
  readonly status: "loading" | "ready" | "exited" | "lost";
  readonly epoch: number;
  /** The last event applied; events must follow it without a gap. */
  readonly seq: number;
  /** The transcript as far back as the client has it, oldest first. */
  readonly items: readonly TranscriptItem[];
  /** Whether the host has items before the first one here. */
  readonly hasOlder: boolean;
  readonly run: { readonly runId: string; readonly startedAt: number } | null;
  readonly pending: readonly PendingMessage[];
  /** The queue, steers, stop, interactions and failure (SPEC-0001, "运行控制"). */
  readonly control: Control;
  /** The model and thinking level pi uses; `null` before pi has started (SPEC-0001, "模型与输入框"). */
  readonly model: SessionModel | null;
  /** Whether you want Fast in the session, whether or not its model has it (SPEC-0001, "Fast"). */
  readonly fast: boolean;
  /** The status bar's figures (SPEC-0001, "状态栏（M1.8）"). */
  readonly metrics: SessionMetrics;
}

/**
 * The view of a session before its snapshot arrives.
 *
 * @remarks
 * Events before the snapshot are ignored, since the snapshot already contains them.
 *
 * @sideEffects none
 * @param sessionId - The session.
 * @returns An empty, loading view.
 */
export function loadingView(sessionId: string): SessionView {
  return {
    sessionId,
    status: "loading",
    epoch: 0,
    seq: 0,
    items: [],
    hasOlder: false,
    run: null,
    pending: [],
    control: IDLE_CONTROL,
    model: null,
    fast: false,
    metrics: UNKNOWN_METRICS,
  };
}

/**
 * Drops pending messages the host has confirmed.
 *
 * @remarks
 * A turn carries the id of the pending message that opened it as `clientMessageId`, so it
 * replaces the optimistic copy rather than showing twice.
 *
 * @sideEffects none
 * @param pending - Messages still waiting.
 * @param items - Items the host sent.
 * @returns The ones still unconfirmed.
 */
function unconfirmed(pending: readonly PendingMessage[], items: readonly TranscriptItem[]): PendingMessage[] {
  // Stryker disable next-line ArrayDeclaration: a made-up id matches no pending message.
  const confirmed = new Set(items.flatMap((item) => (item.kind === "turn" ? [item.user.clientMessageId] : [])));
  return pending.filter((message) => !confirmed.has(message.clientMessageId));
}

/**
 * Replaces one turn, found by id from the end, where live events go.
 *
 * @remarks
 * Only the changed turn is new; the list's other items keep their identity, so React redraws
 * just that turn (domain-model §7).
 *
 * @sideEffects none
 * @param items - The items.
 * @param turnId - The turn's id.
 * @param change - Makes the new turn from the old; `null` if the change does not apply.
 * @returns The new items, or `null` when there is no such turn or the change does not apply.
 */
function updateTurn(
  items: readonly TranscriptItem[],
  turnId: string,
  change: (turn: Turn) => Turn | null,
): TranscriptItem[] | null {
  const index = items.findLastIndex((item) => item.id === turnId);
  const turn = items[index];
  if (turn?.kind !== "turn") return null;
  const changed = change(turn);
  if (changed === null) return null;
  const next = [...items];
  next[index] = changed;
  return next;
}

/**
 * Replaces one step of a turn, found by id.
 *
 * @remarks
 * See `updateTurn`: the turn's other steps keep their identity.
 *
 * @sideEffects none
 * @param turn - The turn.
 * @param stepId - The step's id.
 * @param change - Makes the new step from the old; `null` if the change does not apply.
 * @returns The new turn, or `null` when there is no such step or the change does not apply.
 */
function updateStep(turn: Turn, stepId: string, change: (step: Step) => Step | null): Turn | null {
  const index = turn.steps.findIndex((step) => step.id === stepId);
  const step = turn.steps[index];
  if (step === undefined) return null;
  const changed = change(step);
  if (changed === null) return null;
  const steps = [...turn.steps];
  steps[index] = changed;
  return { ...turn, steps };
}

/**
 * Applies a change to the items, or asks for a snapshot when it does not fit.
 *
 * @remarks
 * A step event for a turn or step the view does not have means it missed something.
 *
 * @sideEffects none
 * @param view - The view after the event's sequence number.
 * @param items - The new items, or `null`.
 * @returns The new view, or `resync`.
 */
function withItems(view: SessionView, items: TranscriptItem[] | null): SessionView | "resync" {
  return items === null ? "resync" : { ...view, items };
}

/**
 * Applies one event from the host to a session's view.
 *
 * @remarks
 * A snapshot replaces everything but the still-unconfirmed pending messages; one that starts a
 * new epoch (the host rebuilt the transcript) replaces older pages fetched before too. Any other
 * event must be the next one: from the same epoch with the next sequence number. Anything else, or
 * an event about a turn or step the view does not have, means the client missed something, and it
 * asks for a fresh snapshot instead of guessing (domain-model §7). Events that arrive before the
 * first snapshot are already part of it and are ignored.
 *
 * @sideEffects none
 * @param view - The current view.
 * @param event - The event.
 * @returns The new view, or `resync` when the event does not follow on.
 */
export function applySessionEvent(view: SessionView, event: SessionEvent): SessionView | "resync" {
  if (event.type === "session_snapshot") {
    return {
      sessionId: view.sessionId,
      status: event.exited ? "exited" : "ready",
      epoch: event.epoch,
      seq: event.seq,
      items: event.items,
      hasOlder: event.hasOlder,
      run: event.run,
      pending: unconfirmed(view.pending, event.items),
      control: event.control,
      model: event.model,
      fast: event.fast,
      metrics: event.metrics,
    };
  }
  if (view.status === "loading") return view;
  if (event.epoch !== view.epoch || event.seq !== view.seq + 1) return "resync";
  const next = { ...view, seq: event.seq };
  switch (event.type) {
    case "run_started":
      return { ...next, run: { runId: event.runId, startedAt: event.startedAt } };
    case "run_settled":
      return { ...next, run: null };
    case "turn_started":
      return { ...next, items: [...view.items, event.turn], pending: unconfirmed(view.pending, [event.turn]) };
    case "step_added":
      return withItems(
        next,
        updateTurn(view.items, event.turnId, (turn) => ({ ...turn, steps: [...turn.steps, event.step] })),
      );
    case "step_delta":
      return withItems(
        next,
        updateTurn(view.items, event.turnId, (turn) =>
          updateStep(turn, event.stepId, (step) =>
            step.kind === "thinking" || step.kind === "text" ? { ...step, text: step.text + event.delta } : null,
          ),
        ),
      );
    case "step_updated":
      return withItems(
        next,
        updateTurn(view.items, event.turnId, (turn) => updateStep(turn, event.step.id, () => event.step)),
      );
    case "turn_finished":
      return withItems(
        next,
        updateTurn(view.items, event.turnId, (turn) => ({
          ...turn,
          outcome: event.outcome,
          error: event.error,
          durationMs: event.durationMs,
          usage: event.usage,
          changes: event.changes,
        })),
      );
    case "notice_added": {
      if (event.before === null) return { ...next, items: [...view.items, event.notice] };
      const index = view.items.findIndex((item) => item.id === event.before);
      if (index === -1) return "resync";
      return { ...next, items: view.items.toSpliced(index, 0, event.notice) };
    }
    case "session_exited":
      return { ...next, status: "exited", run: null };
    case "control_updated":
      return { ...next, control: event.control };
    case "model_updated":
      return { ...next, model: event.model };
    case "fast_updated":
      return { ...next, fast: event.fast };
    case "metrics_updated":
      return { ...next, metrics: event.metrics };
    case "prompt_handled":
      return { ...next, pending: view.pending.filter((message) => message.clientMessageId !== event.clientMessageId) };
  }
  // Stryker disable next-line all: unreachable, since the switch covers every event type.
  throw new Error(`unknown session event ${String((event as { type: unknown }).type)}`);
}

/**
 * Puts a step fetched whole in place of the preview the view has.
 *
 * @remarks
 * A step fetched in an epoch that has since passed may no longer be the same step, so it is
 * dropped (SPEC-0001, "大内容"). Live events after the fetch replace it as any other step.
 *
 * @sideEffects none
 * @param view - The current view.
 * @param turnId - The turn.
 * @param step - The whole step.
 * @param epoch - The epoch it was fetched in.
 * @returns The new view.
 */
export function withWholeStep(view: SessionView, turnId: string, step: Step, epoch: number): SessionView {
  if (view.epoch !== epoch) return view;
  const items = updateTurn(view.items, turnId, (turn) => updateStep(turn, step.id, () => step));
  return items === null ? view : { ...view, items };
}

/**
 * Puts a page of older items in front of the view's.
 *
 * @remarks
 * A page fetched in an epoch that has since passed no longer lines up and is dropped; so is one
 * that no longer ends where the view's items begin, as when two fetches raced.
 *
 * @sideEffects none
 * @param view - The current view.
 * @param page - The items fetched and whether there are older ones.
 * @param epoch - The epoch the page was fetched in.
 * @param before - The id of the item it was fetched before.
 * @returns The new view.
 */
export function prependOlder(
  view: SessionView,
  page: CommandResult<"fetch_transcript">,
  epoch: number,
  before: string,
): SessionView {
  if (view.epoch !== epoch || view.items[0]?.id !== before) return view;
  return { ...view, items: [...page.items, ...view.items], hasOlder: page.hasOlder };
}
