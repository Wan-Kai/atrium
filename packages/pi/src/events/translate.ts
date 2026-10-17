import type { ThinkingLevel } from "@atrium/protocol";
import { AGENT_MESSAGE, type AgentNote, agentNote } from "../agent/agent";
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
  /** pi is about to prepare and send a request to the model (its `turn_start`). */
  | { readonly kind: "request_started" }
  | { readonly kind: "assistant_started" }
  /** The streaming message's first output: text, thinking or a tool call's arguments. */
  | { readonly kind: "output_started" }
  /** A text or thinking block starts empty; a tool call arrives once its arguments are complete. */
  | { readonly kind: "part_started"; readonly index: number; readonly part: AssistantPart }
  | { readonly kind: "part_delta"; readonly index: number; readonly delta: string }
  | { readonly kind: "message_finished"; readonly message: LogMessage }
  /** pi wrote the host's note to the model, an `atrium-agent` custom message (SPEC-0002). */
  | { readonly kind: "note_added"; readonly note: AgentNote; readonly timestamp: number }
  /** A running tool's output so far, all of it, not just what is new. */
  | { readonly kind: "tool_output"; readonly callId: string; readonly text: string }
  /** `maxAttempts` is pi's own limit, from its settings (SPEC-0001, "运行控制"). */
  | { readonly kind: "retry_started"; readonly attempt: number; readonly maxAttempts: number; readonly error: string }
  | { readonly kind: "compaction_started" }
  | { readonly kind: "compaction_finished" }
  /** The steers pi holds that have not reached the model yet, all of them. */
  | { readonly kind: "steering_changed"; readonly steering: readonly string[] }
  /** pi's thinking level changed, as after switching to a model that supports fewer levels. */
  | { readonly kind: "thinking_changed"; readonly level: ThinkingLevel }
  | { readonly kind: "dialog_requested"; readonly dialog: Dialog }
  /** A one-way message from an extension, which Atrium only logs. */
  | { readonly kind: "notified"; readonly level: "info" | "warning" | "error"; readonly text: string };

/** An extension's question, from pi's `extension_ui_request` (pi-internals.md §5). */
export interface Dialog {
  readonly id: string;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly title: string;
  /** What a confirmation asks about. */
  readonly message: string | null;
  /** A selection's choices. */
  readonly options: readonly string[] | null;
  readonly placeholder: string | null;
  /** An editor's starting text. */
  readonly prefill: string | null;
  /** How long pi waits for the answer; null for no limit. */
  readonly timeoutMs: number | null;
}

/** pi's extension UI requests. */
type UiRequest = Extract<PiEvent, { type: "extension_ui_request" }>;

/** Translates pi's session events one at a time, keeping track of the message that is streaming. */
export type EventTranslator = (event: PiEvent) => TranslatedEvent[];

/** pi's streaming update of an assistant message. */
type PiUpdate = Extract<PiEvent, { type: "message_update" }>["assistantMessageEvent"];

/**
 * Reports a custom message pi wrote: Atrium's note, and nothing for any other.
 *
 * @remarks
 * Mid-run it does not end the message that is streaming (SPEC-0002, "对话记录里的自定义消息").
 *
 * @sideEffects none
 * @param message - pi's custom message.
 * @returns The events.
 */
function custom(message: Extract<PiMessage, { role: "custom" }>): TranslatedEvent[] {
  const note = message.customType === AGENT_MESSAGE ? agentNote(message.details) : null;
  return note === null ? [] : [{ kind: "note_added", note, timestamp: message.timestamp }];
}

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
 * output, automatic retries and the start and end of a compaction pass through, nested tool
 * calls' output does not. pi's queue reports its steers whole each time; its follow-ups are not
 * used, since the host keeps its own queue (SPEC-0001, "运行中输入"). Of extension UI requests,
 * the four dialogs pass through and notifications are passed on to be logged; the rest only
 * mean something in pi's terminal. `agent_start` and `agent_settled` pass through: the first
 * `agent_start` after idle begins a run, and `agent_settled` is the only event that ends it
 * (pi-internals.md §3). For the status bar's timing, pi's `turn_start` says a request is about to
 * go out, and the first delta of an assistant message, of text, thinking or a tool call's
 * arguments, is its first output (SPEC-0001, "状态栏（M1.8）").
 *
 * @sideEffects none; the returned function updates its own state.
 * @param now - The time to give a message pi sent without one.
 * @returns The translator.
 */
export function createEventTranslator(now: () => number): EventTranslator {
  /** Indexes of the streaming message's blocks reported so far. */
  let started = new Set<number>();
  /** Whether the streaming message has output anything yet. */
  let output = false;

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
    const first =
      !output && (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta");
    if (first) output = true;
    const events = streamedParts(update);
    return first ? [{ kind: "output_started" }, ...events] : events;
  }

  /**
   * Translates one streaming update into the blocks it starts or grows.
   *
   * @remarks
   * See `createEventTranslator`.
   *
   * @sideEffects Records started blocks.
   * @param update - pi's update.
   * @returns The events.
   */
  function streamedParts(update: PiUpdate): TranslatedEvent[] {
    if (update.type === "text_start" || update.type === "thinking_start") {
      if (started.has(update.contentIndex)) return [];
      started.add(update.contentIndex);
      const type = update.type === "text_start" ? "text" : "thinking";
      return [{ kind: "part_started", index: update.contentIndex, part: { type, text: "" } }];
    }
    if (update.type === "text_delta") return grow("text", update.contentIndex, update.delta);
    if (update.type === "thinking_delta") return grow("thinking", update.contentIndex, update.delta);
    if (update.type !== "toolcall_end") return [];
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
   * @sideEffects Forgets the blocks of the message that streamed; a finished message ends it.
   * @param message - pi's message.
   * @returns The events.
   */
  function finished(message: PiMessage): TranslatedEvent[] {
    started = new Set();
    output = false;
    const converted = toLogMessage(message, now());
    return converted === null ? [] : [{ kind: "message_finished", message: converted }];
  }

  return (event) => {
    if (event.type === "message_start") {
      if (event.message.role !== "assistant") return [];
      started = new Set();
      output = false;
      return [{ kind: "assistant_started" }];
    }
    if (event.type === "message_update") return streamed(event.assistantMessageEvent);
    if (event.type === "message_end" && event.message.role === "custom") return custom(event.message);
    if (event.type === "message_end") return finished(event.message);
    if (event.type === "tool_execution_update") {
      if (event.parentToolCallId !== undefined) return [];
      const partial: unknown = event.partialResult;
      return [{ kind: "tool_output", callId: event.toolCallId, text: outputText(partial) }];
    }
    if (event.type === "auto_retry_start") {
      return [
        { kind: "retry_started", attempt: event.attempt, maxAttempts: event.maxAttempts, error: event.errorMessage },
      ];
    }
    if (event.type === "compaction_start") return [{ kind: "compaction_started" }];
    if (event.type === "compaction_end") return [{ kind: "compaction_finished" }];
    if (event.type === "queue_update") return [{ kind: "steering_changed", steering: [...event.steering] }];
    if (event.type === "thinking_level_changed") return [{ kind: "thinking_changed", level: event.level }];
    if (event.type === "extension_ui_request") return uiRequest(event);
    if (event.type === "agent_start") return [{ kind: "agent_started" }];
    if (event.type === "turn_start") return [{ kind: "request_started" }];
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
  // Stryker disable next-line ConditionalExpression: `contentText` compares the type with "text", which no other type equals.
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

/**
 * Translates an extension UI request.
 *
 * @remarks
 * See `createEventTranslator`. A timeout of 0 or none means pi waits as long as it takes.
 *
 * @sideEffects none
 * @param request - pi's request.
 * @returns The events.
 */
function uiRequest(request: UiRequest): TranslatedEvent[] {
  if (request.method === "notify") {
    return [{ kind: "notified", level: request.notifyType ?? "info", text: request.message }];
  }
  const base = { id: request.id, message: null, options: null, placeholder: null, prefill: null };
  const timeoutMs =
    // Stryker disable next-line ConditionalExpression: without the field `timeout` is undefined, which the next test catches; `in` only narrows the type.
    "timeout" in request && request.timeout !== undefined && request.timeout > 0 ? request.timeout : null;
  if (request.method === "select") {
    return [dialog({ ...base, method: "select", title: request.title, options: [...request.options], timeoutMs })];
  }
  if (request.method === "confirm") {
    return [dialog({ ...base, method: "confirm", title: request.title, message: request.message, timeoutMs })];
  }
  if (request.method === "input") {
    return [
      dialog({ ...base, method: "input", title: request.title, placeholder: request.placeholder ?? null, timeoutMs }),
    ];
  }
  if (request.method === "editor") {
    return [
      dialog({ ...base, method: "editor", title: request.title, prefill: request.prefill ?? null, timeoutMs: null }),
    ];
  }
  return [];
}

/**
 * Wraps a dialog as an event.
 *
 * @remarks
 * See `uiRequest`.
 *
 * @sideEffects none
 * @param found - The dialog.
 * @returns The event.
 */
function dialog(found: Dialog): TranslatedEvent {
  return { kind: "dialog_requested", dialog: found };
}
