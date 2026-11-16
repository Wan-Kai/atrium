import type { LogEntry } from "@atrium/pi";

/** How many characters one page of a long read holds (SPEC-0006, "任务对话": `task_read_source`, `task_read_node`). */
export const PAGE_CHARS = 12_000;

/** How much of a tool call's arguments and of a tool's result a rendered transcript keeps. */
const CALL_CHARS = 300;
const RESULT_CHARS = 800;

/**
 * Cuts a text to a length, marking the cut.
 *
 * @remarks
 * Only for the model's reading; the marker is plain.
 *
 * @sideEffects none
 * @param text - The text.
 * @param max - The most characters kept.
 * @returns The text, or its start and an ellipsis.
 */
function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * The entries of the branch the session is on, oldest first.
 *
 * @remarks
 * A session file is a tree (a fork or an edit adds a branch); the last entry written is on the branch in use, so
 * the path from it to the root is the conversation. An id that is missing ends the path.
 *
 * @sideEffects none
 * @param entries - The file's entries, in file order.
 * @returns The entries on the path.
 */
function activePath(entries: readonly LogEntry[]): LogEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: LogEntry[] = [];
  const seen = new Set<string>();
  for (
    let at = entries.at(-1);
    at !== undefined && !seen.has(at.id);
    at = at.parentId === null ? undefined : byId.get(at.parentId)
  ) {
    seen.add(at.id);
    path.push(at);
  }
  return path.toReversed();
}

/**
 * A session's conversation as plain text.
 *
 * @remarks
 * The user's and the assistant's words, in order; thinking is left out. For a node's conversation (`steps`)
 * the tool calls and their results are shown short, since what a node did is mostly in them. The labels are plain
 * markers for the model; the text itself is quoted by the caller before the model reads it.
 *
 * @sideEffects none
 * @param entries - The session file's entries.
 * @param steps - Whether to show the tool calls and results.
 * @returns The text, empty for a conversation without words.
 */
export function renderTranscript(entries: readonly LogEntry[], steps: boolean): string {
  const blocks: string[] = [];
  for (const entry of activePath(entries)) {
    if (entry.kind === "user") {
      blocks.push(`[user]\n${entry.text}${entry.images > 0 ? `\n(${String(entry.images)} image(s) attached)` : ""}`);
    } else if (entry.kind === "assistant") {
      const lines = entry.parts.flatMap((part) => {
        if (part.type === "text") return [part.text];
        if (part.type === "toolCall" && steps) {
          return [`[call ${part.tool} ${shorten(JSON.stringify(part.args), CALL_CHARS)}]`];
        }
        return [];
      });
      if (lines.length > 0) blocks.push(`[assistant]\n${lines.join("\n")}`);
    } else if (entry.kind === "toolResult" && steps) {
      blocks.push(`[result ${entry.tool}${entry.isError ? " (error)" : ""}]\n${shorten(entry.text, RESULT_CHARS)}`);
    } else if (entry.kind === "compaction") {
      blocks.push(`[earlier part of the conversation, compacted]\n${entry.summary}`);
    }
  }
  return blocks.join("\n\n");
}

/** One page of a long text. */
export interface Page {
  readonly text: string;
  readonly page: number;
  readonly pages: number;
}

/**
 * One page of a text, counting from 1.
 *
 * @remarks
 * A text of no length is one empty page. A page past the end is `null`: the caller names the argument.
 *
 * @sideEffects none
 * @param text - The whole text.
 * @param page - Which page, from 1.
 * @returns The page, or `null` past the end.
 */
export function pageOf(text: string, page: number): Page | null {
  const pages = Math.max(1, Math.ceil(text.length / PAGE_CHARS));
  if (page > pages) return null;
  return { text: text.slice((page - 1) * PAGE_CHARS, page * PAGE_CHARS), page, pages };
}
