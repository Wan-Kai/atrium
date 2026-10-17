/** The hidden command the host hands Atrium's extension child conversations' things with (ADR-0013). */
export const AGENT_COMMAND = "atrium-agent";

/** The custom type of Atrium's own messages in pi's sessions (SPEC-0002, "对话记录里的自定义消息"). */
export const AGENT_MESSAGE = "atrium-agent";

/**
 * The host's note to the model: a child conversation forked into a new worktree works in `to`,
 * though its history names `from` (SPEC-0002, "带上下文的子对话怎么做出来").
 */
export interface AgentNote {
  readonly note: "worktree_moved";
  readonly from: string;
  readonly to: string;
}

/**
 * Encodes a value as the argument of a hidden command.
 *
 * @remarks
 * base64url JSON, so its spaces and quotes stay one argument (ADR-0013, point 2).
 *
 * @sideEffects none
 * @param value - The value.
 * @returns The argument.
 */
export function encodeArgument(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Decodes an argument `encodeArgument` made.
 *
 * @remarks
 * Anything that is not base64url JSON is `undefined`, so a mangled command does nothing.
 *
 * @sideEffects none
 * @param argument - The argument.
 * @returns The value, or `undefined`.
 */
export function decodeArgument(argument: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(argument, "base64url").toString("utf8"));
  } catch {
    // Not base64url JSON: nothing.
  }
  return value;
}

/** The longest path a note carries: what the protocol's note notice takes. */
const PATH_LIMIT = 4096;

/**
 * Whether a value is a path a note can carry.
 *
 * @remarks
 * A longer one would make the transcript it goes into fail the protocol, and with it the whole
 * session's (SPEC-0002, "对话记录里的自定义消息").
 *
 * @sideEffects none
 * @param value - The value.
 * @returns Whether.
 */
function notePath(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= PATH_LIMIT;
}

/**
 * Reads a note from what the host sent, or from a custom message's `details`.
 *
 * @remarks
 * Both carry `{ v: 1, kind: "note", note, from, to }` (ADR-0013, point 10), each path at most
 * 4096 characters; anything else, as a later version's note, is `null`, and the transcript leaves
 * it out.
 *
 * @sideEffects none
 * @param value - The value.
 * @returns The note, or `null`.
 */
export function agentNote(value: unknown): AgentNote | null {
  if (typeof value !== "object" || value === null) return null;
  const [v, kind, note, from, to] = ["v", "kind", "note", "from", "to"].map((key): unknown => Reflect.get(value, key));
  if (v !== 1 || kind !== "note" || note !== "worktree_moved") return null;
  if (!notePath(from) || !notePath(to)) return null;
  return { note, from, to };
}

/**
 * What the model is told for a note.
 *
 * @remarks
 * The extension words it, not the host (ADR-0013, point 9). Its absolute paths would otherwise lead
 * a model that can write back into the parent's directory (SPEC-0002, "带上下文的子对话怎么做出来").
 *
 * @sideEffects none
 * @param note - The note.
 * @returns The text.
 */
export function noteText(note: AgentNote): string {
  return [
    "<atrium-agent-note>",
    "This is a note from Atrium, not from the user.",
    `This conversation was copied into a new git worktree and now works in ${note.to}.`,
    `Paths in the history above belong to ${note.from}; read and change files under ${note.to} from now on.`,
    "</atrium-agent-note>",
  ].join("\n");
}
