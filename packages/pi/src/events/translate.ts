import { type AssistantPart, type LogMessage, type PiMessage, toLogMessage } from "../history/log-entry";
import { contentText } from "../history/tools";
import type { PiEvent } from "../process/pi-process";

/**
 * What the translator makes of pi's events, in the shapes the host builds its transcript from
 * (domain-model §2), without the session, epoch, sequence numbers or trace id the host adds.
 *
 * @remarks
 * `index` is the block's position in its assistant message, the same as in the finished message's
 * `parts`, so the host can place a step live exactly where a rebuild from entries puts it.
 */
export type TranslatedEvent =
  | { readonly kind: "agent_started" }
  | { readonly kind: "agent_settled" }
  | { readonly kind: "assistant_started" }
  /** A text or thinking block starts empty; a tool call arrives once its arguments are complete. */
  | { readonly kind: "part_started"; readonly index: number; readonly part: AssistantPart }
  | { readonly kind: "part_delta"; readonly index: number; readonly delta: string }
  | { readonly kind: "message_finished"; readonly message: LogMessage }
  /** A running tool's output so far, all of it, not just what is new. */
  | { readonly kind: "tool_output"; readonly callId: string; readonly text: string }
  | { readonly kind: "retry_started"; readonly attempt: number; readonly error: string }
  | { readonly kind: "compaction_finished" };

/** Translates pi's session events one at a time, keeping track of the message that is streaming. */
export type EventTranslator = (event: PiEvent) => TranslatedEvent[];

/** pi's streaming update of an assistant message. */
type PiUpdate = Extract<PiEvent, { type: "message_update" }>["assistantMessageEvent"];

/**
 * Creates a translator from pi's events to Atrium's.
 *
 * @remarks
 * pi streams an assistant message as `message_start`, `message_update`s and `message_end`. Text
 * and thinking blocks are reported when they start and as they grow; a tool call only once its
 * arguments are complete (`toolcall_end`), since partial JSON is of no use to show. A delta for a
 * block whose start was missed reports the start first rather than being dropped. Finished user,
 * assistant and tool result messages are converted by `toLogMessage`, the same conversion session
 * entries get, so live and rebuilt transcripts agree; other messages are dropped. A tool's live
 * output, automatic retries and the end of a compaction pass through, nested tool calls' output
 * does not. `agent_start` and `agent_settled` pass through: the first `agent_start` after idle
 * begins a run, and `agent_settled` is the only event that ends it (pi-internals.md §3).
 *
 * @sideEffects none; the returned function updates its own state.
 * @param now - The time to give a message pi sent without one.
 * @returns The translator.
 */
export function createEventTranslator(now: () => number): EventTranslator {
  /** Indexes of the streaming message's blocks reported so far. */
  let started = new Set<number>();

  /**
   * Reports a text or thinking block's growth, starting it first if its start was missed.
   *
   * @remarks
   * See `createEventTranslator`.
   *
   * @sideEffects Records the block as started.
   * @param type - The block's kind.
   * @param index - Its position in the message.
   * @param delta - The new text.
   * @returns The events.
   */
  function grow(type: "text" | "thinking", index: number, delta: string): TranslatedEvent[] {
    const events: TranslatedEvent[] = [];
    if (!started.has(index)) {
      started.add(index);
      events.push({ kind: "part_started", index, part: { type, text: "" } });
    }
    events.push({ kind: "part_delta", index, delta });
    return events;
  }

  /**
   * Translates one streaming update of an assistant message.
   *
   * @remarks
   * See `createEventTranslator`.
   *
   * @sideEffects Records started blocks.
   * @param update - pi's update.
   * @returns The events.
   */
  function streamed(update: PiUpdate): TranslatedEvent[] {
    if (update.type === "text_start" || update.type === "thinking_start") {
      if (started.has(update.contentIndex)) return [];
      started.add(update.contentIndex);
      const type = update.type === "text_start" ? "text" : "thinking";
      return [{ kind: "part_started", index: update.contentIndex, part: { type, text: "" } }];
    }
    if (update.type === "text_delta") return grow("text", update.contentIndex, update.delta);
    if (update.type === "thinking_delta") return grow("thinking", update.contentIndex, update.delta);
    if (update.type !== "toolcall_end") return [];
    started.add(update.contentIndex);
    const { id, name, arguments: args } = update.toolCall;
    return [
      { kind: "part_started", index: update.contentIndex, part: { type: "toolCall", callId: id, tool: name, args } },
    ];
  }

  /**
   * Reports a finished message.
   *
   * @remarks
   * See `createEventTranslator`.
   *
   * @sideEffects Forgets the streaming message's blocks.
   * @param message - pi's message.
   * @returns The events.
   */
  function finished(message: PiMessage): TranslatedEvent[] {
    if (message.role === "assistant") started = new Set();
    const converted = toLogMessage(message, now());
    return converted === null ? [] : [{ kind: "message_finished", message: converted }];
  }

  return (event) => {
    if (event.type === "message_start") {
      if (event.message.role !== "assistant") return [];
      started = new Set();
      return [{ kind: "assistant_started" }];
    }
    if (event.type === "message_update") return streamed(event.assistantMessageEvent);
    if (event.type === "message_end") return finished(event.message);
    if (event.type === "tool_execution_update") {
      if (event.parentToolCallId !== undefined) return [];
      const partial: unknown = event.partialResult;
      return [{ kind: "tool_output", callId: event.toolCallId, text: outputText(partial) }];
    }
    if (event.type === "auto_retry_start") {
      return [{ kind: "retry_started", attempt: event.attempt, error: event.errorMessage }];
    }
    if (event.type === "compaction_end") return [{ kind: "compaction_finished" }];
    if (event.type === "agent_start") return [{ kind: "agent_started" }];
    if (event.type === "agent_settled") return [{ kind: "agent_settled" }];
    return [];
  };
}

/**
 * The text of a running tool's partial result.
 *
 * @remarks
 * pi types the partial result as anything; built-in tools send `{ content, details }`, others
 * may send nothing yet.
 *
 * @sideEffects none
 * @param partial - The partial result.
 * @returns Its text, empty if it has none.
 */
function outputText(partial: unknown): string {
  if (typeof partial !== "object" || partial === null || !("content" in partial)) return "";
  const content: unknown = partial.content;
  return Array.isArray(content) ? contentText(content.filter(isBlock)).text : "";
}

/**
 * Whether a value is a content block.
 *
 * @remarks
 * See `outputText`.
 *
 * @sideEffects none
 * @param value - The value.
 * @returns Whether it has a string `type`.
 */
function isBlock(value: unknown): value is { readonly type: string; readonly text?: string } {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}
