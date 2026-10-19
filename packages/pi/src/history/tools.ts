import type { ToolDetails } from "@atrium/protocol";
import { agentToolDetails } from "../agent/details";

/** A JSON object, as tool call arguments are. */
export type ToolArgs = Readonly<Record<string, unknown>>;

/** A text or image block of a tool result or a user message, as pi stores it. */
interface ContentBlock {
  readonly type: string;
  readonly text?: string;
}

/**
 * Reads a string argument.
 *
 * @remarks
 * Arguments are what the model wrote, so any field may be missing or of another type.
 *
 * @sideEffects none
 * @param args - The arguments.
 * @param keys - Names to try, in order.
 * @returns The first string found, or `undefined`.
 */
function stringArg(args: ToolArgs, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * Reads a whole-number argument.
 *
 * @remarks
 * See `stringArg`.
 *
 * @sideEffects none
 * @param args - The arguments.
 * @param key - The name.
 * @returns The number, or `null`.
 */
function integerArg(args: ToolArgs, key: string): number | null {
  const value = args[key];
  // Stryker disable next-line ConditionalExpression: `Number.isInteger` is false for non-numbers; `typeof` only narrows the type.
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Counts the added and removed lines of pi's display diff.
 *
 * @remarks
 * pi's edit tool returns lines like `+12 text`, `-12 text`, ` 12 text` and ` ...` (pi 1.0.2,
 * `edit-diff.js`); only the first character says what a line is.
 *
 * @sideEffects none
 * @param diff - The display diff.
 * @returns How many lines were added and removed.
 */
export function countDiffLines(diff: string): { readonly added: number; readonly removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/**
 * Reads the display diff from an edit result's details.
 *
 * @remarks
 * `details` is whatever the tool returned; a running call has none yet.
 *
 * @sideEffects none
 * @param details - The result's details.
 * @returns The diff, or `null`.
 */
function editDiff(details: unknown): string | null {
  if (typeof details !== "object" || details === null || !("diff" in details)) return null;
  return typeof details.diff === "string" ? details.diff : null;
}

/**
 * The details a tool step shows, from its arguments and, once it has one, its result.
 *
 * @remarks
 * pi's built-in tools (SPEC-0001, "对话记录"): `bash` shows its command; `read` its path and range;
 * `edit` the display diff pi returns in `details.diff`, with its line counts; `write` the written
 * content, which only the call's arguments hold (pi's result says just "Successfully wrote"); the
 * main agent's tools the children they started and the events they brought back (SPEC-0002).
 * Paths are read under the names pi accepts, `path` and the older `file_path`. Other tools, and
 * arguments without the expected fields, have no details. Used for live events and rebuilt
 * history alike, so both show the same.
 *
 * @sideEffects none
 * @param tool - The tool's name.
 * @param args - The call's arguments.
 * @param resultDetails - The result's `details`, if there is a result.
 * @returns The details, or `null`.
 */
export function toolDetails(tool: string, args: ToolArgs, resultDetails?: unknown): ToolDetails | null {
  const path = stringArg(args, "path", "file_path");
  switch (tool) {
    case "bash": {
      const command = stringArg(args, "command");
      return command === undefined ? null : { tool: "bash", command };
    }
    case "read":
      return path === undefined
        ? null
        : { tool: "read", path, offset: integerArg(args, "offset"), limit: integerArg(args, "limit") };
    case "edit": {
      if (path === undefined) return null;
      const diff = editDiff(resultDetails);
      if (diff === null) return { tool: "edit", path, diff: null, added: 0, removed: 0 };
      return { tool: "edit", path, diff, ...countDiffLines(diff) };
    }
    case "write": {
      const content = stringArg(args, "content");
      return path === undefined || content === undefined ? null : { tool: "write", path, content };
    }
    default:
      return agentToolDetails(tool, resultDetails);
  }
}

/**
 * Joins the text of content blocks, counting the images among them.
 *
 * @remarks
 * Tool results and user messages hold text and image blocks; images are not shown as text.
 *
 * @sideEffects none
 * @param content - A string, or blocks.
 * @returns The text and the number of images.
 */
export function contentText(content: string | readonly ContentBlock[]): {
  readonly text: string;
  readonly images: number;
} {
  if (typeof content === "string") return { text: content, images: 0 };
  const texts: string[] = [];
  let images = 0;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block.type === "image") images += 1;
  }
  return { text: texts.join("\n"), images };
}
