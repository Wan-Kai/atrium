import type { AssistantBlock, SessionEvent, TranscriptMessage } from "@atrium/protocol";

/** A user message shown before the host confirms it (domain-model §7). */
export interface PendingMessage {
  /** The `requestId` of the `prompt` that sent it; the confirmed message carries the same id. */
  readonly clientMessageId: string;
  readonly text: string;
}

/** What the client knows about one session it watches. */
export interface SessionView {
  readonly sessionId: string;
  /** `loading` until the first snapshot; `exited` once pi has ended. */
  readonly status: "loading" | "ready" | "exited";
  readonly epoch: number;
  /** The last event applied; events must follow it without a gap. */
  readonly seq: number;
  readonly messages: readonly TranscriptMessage[];
  readonly streaming: { readonly messageId: string; readonly content: readonly AssistantBlock[] } | null;
  readonly run: { readonly runId: string; readonly startedAt: number } | null;
  readonly pending: readonly PendingMessage[];
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
  return { sessionId, status: "loading", epoch: 0, seq: 0, messages: [], streaming: null, run: null, pending: [] };
}

/**
 * Drops pending messages the host has confirmed.
 *
 * @remarks
 * A confirmed user message carries the pending one's id as `clientMessageId`, so it replaces the
 * optimistic copy rather than showing twice.
 *
 * @sideEffects none
 * @param pending - Messages still waiting.
 * @param messages - Messages the host sent.
 * @returns The ones still unconfirmed.
 */
function unconfirmed(pending: readonly PendingMessage[], messages: readonly TranscriptMessage[]): PendingMessage[] {
  // Stryker disable next-line ConditionalExpression,ArrayDeclaration: assistant messages have no id a pending message could match.
  const confirmed = new Set(messages.flatMap((message) => (message.role === "user" ? [message.clientMessageId] : [])));
  return pending.filter((message) => !confirmed.has(message.clientMessageId));
}

/**
 * Adds streamed text to one block of the message in progress.
 *
 * @remarks
 * Only the changed block is replaced; the other blocks, the message list and every earlier
 * message keep their identity, so React redraws just the streaming text (domain-model §7).
 *
 * @sideEffects none
 * @param streaming - The message in progress.
 * @param type - Which kind of block.
 * @param index - The block's index.
 * @param delta - The new text.
 * @returns The updated message.
 */
function appendDelta(
  streaming: NonNullable<SessionView["streaming"]>,
  type: AssistantBlock["type"],
  index: number,
  delta: string,
): NonNullable<SessionView["streaming"]> {
  const content = [...streaming.content];
  content[index] = { type, text: (streaming.content[index]?.text ?? "") + delta };
  return { messageId: streaming.messageId, content };
}

/**
 * Applies one event from the host to a session's view.
 *
 * @remarks
 * A snapshot replaces everything but the still-unconfirmed pending messages. Any other event must
 * be the next one: from the same epoch with the next sequence number. Anything else means the
 * client missed something, and it asks for a fresh snapshot instead of guessing (domain-model §7).
 * Events that arrive before the first snapshot are already part of it and are ignored.
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
      status: "ready",
      epoch: event.epoch,
      seq: event.seq,
      messages: event.messages,
      streaming: event.streaming,
      run: event.run,
      pending: unconfirmed(view.pending, event.messages),
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
    case "message_started":
      return { ...next, streaming: { messageId: event.messageId, content: [] } };
    case "text_delta":
    case "reasoning_delta":
      if (view.streaming?.messageId !== event.messageId) return "resync";
      return {
        ...next,
        streaming: appendDelta(
          view.streaming,
          event.type === "text_delta" ? "text" : "reasoning",
          event.contentIndex,
          event.delta,
        ),
      };
    case "message_finished": {
      const messages = [...view.messages, event.message];
      return {
        ...next,
        messages,
        streaming: event.message.role === "assistant" ? null : view.streaming,
        pending: unconfirmed(view.pending, [event.message]),
      };
    }
    case "session_exited":
      return { ...next, status: "exited", streaming: null, run: null };
  }
  // Stryker disable next-line all: unreachable, since the switch covers every event type.
  throw new Error(`unknown session event ${String((event as { type: unknown }).type)}`);
}
