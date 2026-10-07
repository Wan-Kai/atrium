import type { AssistantBlock, StopReason, TranscriptMessage } from "@atrium/protocol";
import type { PiEvent } from "../process/pi-process";

/**
 * What the translator makes of pi's events: Atrium's transcript entities, without the session,
 * epoch, sequence numbers or trace id the host adds (overview.md, "包之间的依赖").
 */
export type TranslatedEvent =
  | { readonly kind: "message_started"; readonly messageId: string }
  | {
      readonly kind: "text_delta" | "reasoning_delta";
      readonly messageId: string;
      readonly contentIndex: number;
      readonly delta: string;
    }
  | { readonly kind: "message_finished"; readonly message: TranscriptMessage }
  | { readonly kind: "agent_started" }
  | { readonly kind: "agent_settled" };

/** pi's message types, as they arrive in events. */
type PiMessage = Extract<PiEvent, { type: "message_end" }>["message"];
type PiAssistantMessage = Extract<PiMessage, { role: "assistant" }>;
type PiUserMessage = Extract<PiMessage, { role: "user" }>;

/** Translates pi's session events one at a time, keeping track of the message that is streaming. */
export type EventTranslator = (event: PiEvent) => TranslatedEvent[];

/**
 * Maps pi's stop reason onto the protocol's.
 *
 * @remarks
 * `pending` only appears while a message streams, and `deferred` only when a request asks for a
 * deferred response, which Atrium never does; a finished message with either is treated as an
 * ordinary stop rather than rejected.
 *
 * @sideEffects none
 * @param reason - pi's stop reason.
 * @returns The protocol's.
 */
function stopReason(reason: PiAssistantMessage["stopReason"]): StopReason {
  return reason === "pending" || reason === "deferred" ? "stop" : reason;
}

/**
 * Keeps the text and reasoning of an assistant message, in order.
 *
 * @remarks
 * Tool calls get their own blocks in M1.4; until then they are left out, and the streaming
 * indexes count only the blocks kept, so they match this list.
 *
 * @sideEffects none
 * @param content - pi's content blocks.
 * @returns Atrium's.
 */
function assistantBlocks(content: PiAssistantMessage["content"]): AssistantBlock[] {
  return content.flatMap((block): AssistantBlock[] => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "thinking") return [{ type: "reasoning", text: block.thinking }];
    return [];
  });
}

/**
 * Joins the text parts of a user message.
 *
 * @remarks
 * pi stores a typed message as a list of parts; images are attachments, not text (M1.6).
 *
 * @sideEffects none
 * @param content - pi's user content.
 * @returns The text.
 */
function userText(content: PiUserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/**
 * Creates a translator from pi's events to Atrium's.
 *
 * @remarks
 * pi streams an assistant message as `message_start`, `message_update`s and `message_end`, with
 * `contentIndex` counting pi's blocks; Atrium gives the message an id of its own and counts only
 * the blocks it shows, so the translator remembers, for the message in progress, which pi index is
 * which Atrium index. User messages arrive complete at `message_end`; system messages and the
 * events Atrium does not show yet are dropped. `agent_start` and `agent_settled` pass through:
 * the first `agent_start` after idle begins a run, and `agent_settled` is the only event that ends
 * it (pi-internals.md §3); an automatic retry starts the agent again within the same run. Deterministic given `newId`, so it is tested against
 * the recorded fixtures.
 *
 * @sideEffects none; the returned function updates its own state and calls `newId`.
 * @param newId - Makes a fresh message id.
 * @returns The translator.
 */
export function createEventTranslator(newId: () => string): EventTranslator {
  let current: { readonly id: string; readonly indexes: Map<number, number> } | undefined;

  /**
   * Finds or assigns the Atrium index of one of pi's blocks.
   *
   * @remarks
   * A block normally gets its index at its `*_start` event; a delta for a block whose start was
   * missed gets one too, rather than being dropped.
   *
   * @sideEffects Records the index.
   * @param message - The message in progress.
   * @param piIndex - pi's index.
   * @returns Atrium's index.
   */
  function indexOf(message: NonNullable<typeof current>, piIndex: number): number {
    const known = message.indexes.get(piIndex);
    if (known !== undefined) return known;
    const assigned = message.indexes.size;
    message.indexes.set(piIndex, assigned);
    return assigned;
  }

  /**
   * Reports a message pi finished.
   *
   * @remarks
   * A user message arrives complete and gets its id here; an assistant message keeps the id it
   * got when it started streaming.
   *
   * @sideEffects Ends the message in progress; may call `newId`.
   * @param message - pi's finished message.
   * @returns The finished message, or nothing for a system message.
   */
  function finished(message: PiMessage): TranslatedEvent[] {
    if (message.role === "user") {
      return [
        {
          kind: "message_finished",
          message: {
            id: newId(),
            role: "user",
            text: userText(message.content),
            clientMessageId: null,
            timestamp: message.timestamp,
          },
        },
      ];
    }
    if (message.role !== "assistant") return [];
    const id = current?.id ?? newId();
    current = undefined;
    return [
      {
        kind: "message_finished",
        message: {
          id,
          role: "assistant",
          content: assistantBlocks(message.content),
          stopReason: stopReason(message.stopReason),
          errorMessage: message.errorMessage ?? null,
          timestamp: message.timestamp,
        },
      },
    ];
  }

  return (event) => {
    if (event.type === "message_start") {
      if (event.message.role !== "assistant") return [];
      current = { id: newId(), indexes: new Map() };
      return [{ kind: "message_started", messageId: current.id }];
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (current === undefined) return [];
      if (update.type === "text_start" || update.type === "thinking_start") {
        indexOf(current, update.contentIndex);
        return [];
      }
      if (update.type !== "text_delta" && update.type !== "thinking_delta") return [];
      return [
        {
          kind: update.type === "text_delta" ? "text_delta" : "reasoning_delta",
          messageId: current.id,
          contentIndex: indexOf(current, update.contentIndex),
          delta: update.delta,
        },
      ];
    }
    if (event.type === "message_end") return finished(event.message);
    if (event.type === "agent_start") return [{ kind: "agent_started" }];
    if (event.type === "agent_settled") return [{ kind: "agent_settled" }];
    return [];
  };
}
