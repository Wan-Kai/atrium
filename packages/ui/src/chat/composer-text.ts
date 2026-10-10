import type { SlashCommand, TranscriptItem } from "@atrium/protocol";

/** What the input box holds besides images (SPEC-0001, "输入框"). */
export interface DraftText {
  /** The text in the box. */
  readonly text: string;
  /** Long pasted texts, shown as capsules, in the order pasted. */
  readonly pastes: readonly { readonly id: string; readonly text: string }[];
  /** Referenced files and directories, relative to the session's directory; a directory ends in `/`. */
  readonly files: readonly string[];
}

/** The `@` word the caret is in. */
export interface Mention {
  /** Where the `@` is. */
  readonly start: number;
  /** Where the word ends. */
  readonly end: number;
  /** What is typed between the `@` and the caret. */
  readonly query: string;
}

/** A pasted text longer than this many lines, or characters, becomes a capsule (SPEC-0001, "输入框"). */
const LONG_PASTE_LINES = 8;
const LONG_PASTE_CHARS = 800;

/**
 * What follows a `/` at the start of the box, while the caret is still in that first word.
 *
 * @remarks
 * `/` commands are only typed at the start (SPEC-0001, "输入框").
 *
 * @sideEffects none
 * @param text - The box's text.
 * @param caret - Where the caret is.
 * @returns The query, or `null` when no command is being typed.
 */
export function slashQuery(text: string, caret: number): string | null {
  if (!text.startsWith("/")) return null;
  const typed = text.slice(1, caret);
  return /\s/.test(typed) ? null : typed;
}

/**
 * The box with a chosen command in place of its first word.
 *
 * @remarks
 * What follows the word stays, as the command's arguments; a space follows a command that had
 * none.
 *
 * @sideEffects none
 * @param text - The box's text.
 * @param name - The command's name.
 * @returns The new text and where the caret goes.
 */
export function acceptCommand(text: string, name: string): { readonly text: string; readonly caret: number } {
  const wordEnd = text.search(/\s/);
  const rest = wordEnd === -1 ? " " : text.slice(wordEnd);
  return { text: `/${name}${rest}`, caret: name.length + 2 };
}

/**
 * Whether a command's name starts with a query, a skill's also after `skill:`.
 *
 * @remarks
 * Such commands come first in the `/` list.
 *
 * @sideEffects none
 * @param command - The command.
 * @param wanted - The query, in lower case.
 * @returns Whether it starts with it.
 */
function startsWith(command: SlashCommand, wanted: string): boolean {
  const name = command.name.toLowerCase();
  return name.startsWith(wanted) || name.startsWith(`skill:${wanted}`);
}

/**
 * The commands whose name contains the query, those starting with it first.
 *
 * @remarks
 * Without case; a skill matches by its own name after `skill:` as well. Otherwise pi's order is
 * kept: extension commands, templates, skills.
 *
 * @sideEffects none
 * @param commands - pi's commands.
 * @param query - What follows the `/`.
 * @returns The matching commands.
 */
export function filterCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const wanted = query.toLowerCase();
  const matching = commands.filter((command) => command.name.toLowerCase().includes(wanted));
  return [
    ...matching.filter((command) => startsWith(command, wanted)),
    ...matching.filter((command) => !startsWith(command, wanted)),
  ];
}

/**
 * The `@` word the caret is in.
 *
 * @remarks
 * The `@` must not follow a letter, digit or `._+-`, so a mail address does not count; Chinese
 * has no spaces between words, so it may follow a character or punctuation. The query is what is
 * typed between it and the caret, as in pi's terminal. A word opened with `@"`, as going into a
 * directory with white space in its name writes it, runs to its closing quote, spaces and all.
 *
 * @sideEffects none
 * @param text - The box's text.
 * @param caret - Where the caret is.
 * @returns The word, or `null` when the caret is not in one.
 */
export function mentionAt(text: string, caret: number): Mention | null {
  const quoted = /(?:^|[^\w.+\-@])@"([^"]*)$/u.exec(text.slice(0, caret));
  if (quoted !== null) {
    // Stryker disable next-line StringLiteral: the group always matches, if only nothing.
    const query = quoted[1] ?? "";
    const close = text.indexOf('"', caret);
    return { start: caret - query.length - 2, end: close === -1 ? caret : close + 1, query };
  }
  const found = /(?:^|[^\w.+\-@])@([^\s@]*)$/u.exec(text.slice(0, caret));
  if (found === null) return null;
  // Stryker disable next-line StringLiteral: the group always matches, if only nothing.
  const query = found[1] ?? "";
  const start = caret - query.length - 1;
  const after = text.slice(caret).search(/\s/);
  return { start, end: after === -1 ? text.length : caret + after, query };
}

/**
 * The box without an `@` word, which became a capsule.
 *
 * @remarks
 * The file goes above the box; its word leaves the text (SPEC-0001, "输入框").
 *
 * @sideEffects none
 * @param text - The box's text.
 * @param mention - The word.
 * @returns The new text and where the caret goes.
 */
export function removeMention(text: string, mention: Mention): { readonly text: string; readonly caret: number } {
  return { text: text.slice(0, mention.start) + text.slice(mention.end), caret: mention.start };
}

/**
 * The box with an `@` word turned into a directory's path, to look inside it.
 *
 * @remarks
 * Tab on a directory goes into it, as pi's terminal completes `@dir/`; a name with white space
 * opens a quoted word, `@"my dir/`, which `mentionAt` reads to the caret.
 *
 * @sideEffects none
 * @param text - The box's text.
 * @param mention - The word.
 * @param path - The directory, ending in `/`.
 * @returns The new text and where the caret goes.
 */
export function enterDirectory(
  text: string,
  mention: Mention,
  path: string,
): { readonly text: string; readonly caret: number } {
  const word = /\s/.test(path) ? `@"${path}` : `@${path}`;
  return { text: text.slice(0, mention.start) + word + text.slice(mention.end), caret: mention.start + word.length };
}

/**
 * How a file dropped on the box is referenced.
 *
 * @remarks
 * From the session's directory when inside it, else whole; a directory ends in `/`, as `@` writes
 * it (SPEC-0001, "模型与输入框").
 *
 * @sideEffects none
 * @param path - The file's absolute path.
 * @param baseDir - The session's directory, if known.
 * @param directory - Whether it is a directory.
 * @returns The path to reference.
 */
export function droppedReference(path: string, baseDir: string | null, directory: boolean): string {
  const shown = baseDir !== null && path.startsWith(`${baseDir}/`) ? path.slice(baseDir.length + 1) : path;
  return directory ? `${shown}/` : shown;
}

/**
 * How a referenced file is written in the message.
 *
 * @remarks
 * As pi's terminal inserts it: `@path`, quoted when the path has white space.
 *
 * @sideEffects none
 * @param path - The path.
 * @returns The reference.
 */
function reference(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/**
 * The text a message goes out with.
 *
 * @remarks
 * The box's text, then each pasted text in the order pasted, then the referenced files on one
 * line, a blank line apart; empty parts are left out and trailing space is trimmed (SPEC-0001,
 * "模型与输入框"). Files go as paths only, for the agent to read itself.
 *
 * @sideEffects none
 * @param draft - What the box holds.
 * @returns The message's text; empty when there is nothing to send.
 */
export function composeMessage(draft: DraftText): string {
  const files = draft.files.map(reference).join(" ");
  return [draft.text.trimEnd(), ...draft.pastes.map((paste) => paste.text), files]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
}

/**
 * How many lines a text has.
 *
 * @remarks
 * A trailing line break does not start another.
 *
 * @sideEffects none
 * @param text - The text.
 * @returns The count.
 */
export function lineCount(text: string): number {
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/**
 * Whether a pasted text is long enough to become a capsule.
 *
 * @remarks
 * More than 8 lines or 800 characters (SPEC-0001, "输入框").
 *
 * @sideEffects none
 * @param text - The pasted text.
 * @returns Whether it is long.
 */
export function isLongPaste(text: string): boolean {
  return lineCount(text) > LONG_PASTE_LINES || text.length > LONG_PASTE_CHARS;
}

/**
 * What ↑ goes back through: the messages you sent in the session, newest first.
 *
 * @remarks
 * The current branch's turns as far back as loaded, each its message and then its steers,
 * without the host's own messages, a repeat in a row counted once (SPEC-0001, "模型与输入框").
 *
 * @sideEffects none
 * @param items - The transcript, oldest first.
 * @returns The messages.
 */
export function historyOf(items: readonly TranscriptItem[]): string[] {
  const sent: string[] = [];
  for (const item of items.toReversed()) {
    if (item.kind !== "turn") continue;
    const steers = item.steps.flatMap((step) => (step.kind === "steer" ? [step.text] : []));
    for (const text of [...(item.user.auto ? [] : [item.user.text]), ...steers].toReversed()) {
      if (sent.at(-1) !== text) sent.push(text);
    }
  }
  return sent;
}
