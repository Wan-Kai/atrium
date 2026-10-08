import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type ToolArgs, contentText } from "./tools";

/** One block of an assistant message, as Atrium keeps it. */
export type AssistantPart =
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "toolCall"; readonly callId: string; readonly tool: string; readonly args: ToolArgs };

/** Why an assistant message ended. */
export type LogStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/**
 * A message in Atrium's shape: user, assistant or tool result (domain-model §2).
 *
 * @remarks
 * Live events and session entries carry the same messages, so the live transcript and the one
 * rebuilt from entries are made from the same shape. `timestamp` is the message's own time, in
 * milliseconds since the epoch.
 */
export type LogMessage =
  | { readonly kind: "user"; readonly text: string; readonly images: number; readonly timestamp: number }
  | {
      readonly kind: "assistant";
      readonly parts: readonly AssistantPart[];
      readonly stopReason: LogStopReason;
      readonly errorMessage: string | null;
      readonly usage: { readonly input: number; readonly output: number };
      readonly timestamp: number;
    }
  | {
      readonly kind: "toolResult";
      readonly callId: string;
      readonly tool: string;
      readonly text: string;
      readonly isError: boolean;
      /** pi's `details`, read by `toolDetails`. */
      readonly details: unknown;
      readonly timestamp: number;
    };

/**
 * A session entry in Atrium's shape (domain-model §2).
 *
 * @remarks
 * Produced by the pi package, used only inside the host, never sent to clients. The tree
 * structure (`id`, `parentId`) is kept for every entry, including those the transcript skips.
 * `timestamp` is the message's own time for messages and the entry's otherwise.
 */
export type LogEntry = { readonly id: string; readonly parentId: string | null } & (
  | LogMessage
  | ({ readonly timestamp: number } & (
      | { readonly kind: "compaction"; readonly summary: string; readonly tokensBefore: number }
      /** A failed reply taken out of the model's context before a retry. */
      | { readonly kind: "omission"; readonly targetId: string }
      /** Anything the transcript does not show: model and thinking changes, labels, system messages… */
      | { readonly kind: "other" }
    ))
);

/** pi's message, as it arrives in a message entry or a `message_end` event. */
export type PiMessage = Extract<SessionEntry, { type: "message" }>["message"];
type PiAssistantMessage = Extract<PiMessage, { role: "assistant" }>;

/**
 * Converts an assistant message's blocks.
 *
 * @remarks
 * Images never appear in assistant messages; any other block type is skipped.
 *
 * @sideEffects none
 * @param content - pi's blocks.
 * @returns Atrium's.
 */
function assistantParts(content: PiAssistantMessage["content"]): AssistantPart[] {
  return content.flatMap((block): AssistantPart[] => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "thinking") return [{ type: "thinking", text: block.thinking }];
    return [{ type: "toolCall", callId: block.id, tool: block.name, args: block.arguments }];
  });
}

/**
 * Maps pi's stop reason onto the transcript's.
 *
 * @remarks
 * `pending` only appears while streaming and `deferred` only when asked for, which Atrium never
 * does; both read as an ordinary stop.
 *
 * @sideEffects none
 * @param reason - pi's stop reason.
 * @returns Atrium's.
 */
function stopReason(reason: PiAssistantMessage["stopReason"]): LogStopReason {
  return reason === "pending" || reason === "deferred" ? "stop" : reason;
}

/**
 * Converts one of pi's messages to Atrium's shape.
 *
 * @remarks
 * User, assistant and tool result messages are part of turns; system messages, `!bash` messages
 * and extensions' messages are not (pi-internals.md §1). The message's own time is the one live
 * events carry too, so durations computed from either match; the types promise it, but the file
 * is JSON from another process, so a message without one takes `fallbackTime`.
 *
 * @sideEffects none
 * @param message - pi's message.
 * @param fallbackTime - The time to use when the message has none.
 * @returns The message, or `null` for one the transcript does not show.
 */
export function toLogMessage(message: PiMessage, fallbackTime: number): LogMessage | null {
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : fallbackTime;
  if (message.role === "user") return { kind: "user", ...contentText(message.content), timestamp };
  if (message.role === "assistant") {
    return {
      kind: "assistant",
      parts: assistantParts(message.content),
      stopReason: stopReason(message.stopReason),
      errorMessage: message.errorMessage ?? null,
      usage: { input: message.usage.input, output: message.usage.output },
      timestamp,
    };
  }
  if (message.role === "toolResult") {
    return {
      kind: "toolResult",
      callId: message.toolCallId,
      tool: message.toolName,
      text: contentText(message.content).text,
      isError: message.isError,
      details: message.details,
      timestamp,
    };
  }
  return null;
}

/**
 * Converts one pi session entry to Atrium's shape.
 *
 * @remarks
 * Message entries become messages (`toLogMessage`). A `context_edit` that removes its target
 * marks a failed reply that pi retried. Everything else keeps only its place in the tree. An entry
 * time that cannot be read becomes 0.
 *
 * @sideEffects none
 * @param entry - pi's entry.
 * @returns The entry.
 */
export function toLogEntry(entry: SessionEntry): LogEntry {
  const base = { id: entry.id, parentId: entry.parentId, timestamp: Date.parse(entry.timestamp) || 0 };
  if (entry.type === "compaction") {
    return { ...base, kind: "compaction", summary: entry.summary, tokensBefore: entry.tokensBefore };
  }
  if (entry.type === "context_edit") {
    return entry.replacement === null
      ? { ...base, kind: "omission", targetId: entry.targetId }
      : { ...base, kind: "other" };
  }
  if (entry.type !== "message") return { ...base, kind: "other" };
  const message = toLogMessage(entry.message, base.timestamp);
  return message === null ? { ...base, kind: "other" } : { id: entry.id, parentId: entry.parentId, ...message };
}
