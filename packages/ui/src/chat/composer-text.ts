import type { MessageTag } from "@atrium/client";
import type { MessageCommand, TranscriptItem, Turn } from "@atrium/protocol";

/** What the input box holds besides images (SPEC-0001, "输入框"). */
export interface DraftText {
  /** The text in the box. */
  readonly text: string;
  /** Long pasted texts, shown as capsules, in the order pasted. */
  readonly pastes: readonly { readonly id: string; readonly text: string }[];
  /** Referenced files and directories, relative to the session's directory; a directory ends in `/`. */
  readonly files: readonly string[];
  /** The command chosen from the `/` list, shown as a tag before the text. */
  readonly command: ChosenCommand | null;
}

/** A command chosen from the `/` list, shown as a tag at the start of the box; a skill's name starts with `skill:`. */
export type ChosenCommand = MessageTag;

/** What kind of command a `/` list entry is: Atrium's built-in, or one of pi's three kinds. */
export type CommandKind = MessageTag["source"];

/** The order the `/` list shows the kinds in (SPEC-0001, "M1.11 的 `/` 命令"). */
const KIND_ORDER: readonly CommandKind[] = ["builtin", "extension", "prompt", "skill"];

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
 * What stays in the box once the command being typed becomes a tag.
 *
 * @remarks
 * The first word goes into the tag, with one space after it; what follows stays as the command's
 * arguments, the caret before it (SPEC-0001, "M1.11 的 `/` 命令").
 *
 * @sideEffects none
 * @param text - The box's text.
 * @returns The text after the tag.
 */
export function tagCommand(text: string): string {
  return text.replace(/^\S*\s?/, "");
}

/**
 * The box with a tag written back as `/name`, as Backspace before the text does.
 *
 * @remarks
 * A space keeps the name and what followed it apart; the caret goes after the name, so it can be
 * changed (SPEC-0001, "M1.11 的 `/` 命令").
 *
 * @sideEffects none
 * @param command - The tag.
 * @param text - The text after it.
 * @returns The new text and where the caret goes.
 */
export function untagCommand(command: ChosenCommand, text: string): { readonly text: string; readonly caret: number } {
  return { text: writtenCommand(command, text), caret: command.name.length + 1 };
}

/**
 * A tag and the text after it, written as typed: `/name text`.
 *
 * @remarks
 * How a tag goes out to pi, comes back on ↑ and is copied (SPEC-0001, "M1.11 的 `/` 命令").
 *
 * @sideEffects none
 * @param command - The tag, or `null` for none.
 * @param text - The text after it.
 * @returns The written message.
 */
export function writtenCommand(command: ChosenCommand | null, text: string): string {
  if (command === null) return text;
  return text === "" ? `/${command.name}` : `/${command.name} ${text}`;
}

/**
 * What a message sent with a tag says after it.
 *
 * @remarks
 * A pending message is kept as it went out, `/name text`; its bubble shows the tag and the rest.
 *
 * @sideEffects none
 * @param command - The tag it went with.
 * @param text - The message.
 * @returns The text after `/name`, or the whole message when it does not start with it.
 */
export function commandArguments(command: ChosenCommand, text: string): string {
  const written = `/${command.name}`;
  return text.startsWith(written) ? text.slice(written.length).trimStart() : text;
}

/**
 * The tag a turn's message shows, from the command the host found it started with.
 *
 * @remarks
 * Only skills come back from pi: as the tag `skill:name` (SPEC-0001, "M1.11 的 `/` 命令").
 *
 * @sideEffects none
 * @param command - The turn's command.
 * @returns The tag, or `null`.
 */
export function messageTag(command: MessageCommand | null): ChosenCommand | null {
  return command === null ? null : { source: "skill", name: `skill:${command.name}` };
}

/**
 * The listed commands under their kinds, in the `/` list's order.
 *
 * @remarks
 * Built-in, extension, template, skill; each keeps the order it came in, and a kind with no
 * command has no group (SPEC-0001, "M1.11 的 `/` 命令").
 *
 * @sideEffects none
 * @param commands - The commands.
 * @returns The groups.
 */
export function groupCommands<T extends { readonly source: CommandKind }>(
  commands: readonly T[],
): { readonly source: CommandKind; readonly commands: readonly T[] }[] {
  return KIND_ORDER.map((source) => ({
    source,
    commands: commands.filter((command) => command.source === source),
  })).filter((group) => group.commands.length > 0);
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
function startsWith(command: { readonly name: string }, wanted: string): boolean {
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
export function filterCommands<T extends { readonly name: string }>(commands: readonly T[], query: string): T[] {
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
 * directory with white space in its name writes it, runs to its closing quote, spaces and all; a
 * quote past a space or line break belongs to other words.
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
    // The closing quote counts only right after the word, before any space or other word.
    const closing = /^[^"\s]*"/.exec(text.slice(caret))?.[0].length ?? 0;
    return { start: caret - query.length - 2, end: caret + closing, query };
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
 * "模型与输入框"). Files go as paths only, for the agent to read itself. A tag goes first, as
 * `/name`, the text after it (SPEC-0001, "M1.11 的 `/` 命令").
 *
 * @sideEffects none
 * @param draft - What the box holds.
 * @returns The message's text; empty when there is nothing to send.
 */
export function composeMessage(draft: DraftText): string {
  const files = draft.files.map(reference).join(" ");
  return [
    draft.command === null ? draft.text.trimEnd() : writtenCommand(draft.command, draft.text.trim()),
    ...draft.pastes.map((paste) => paste.text),
    files,
  ]
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
 * A message as the user typed it: its text, after the skill it started with written as a command.
 *
 * @remarks
 * pi keeps a skill's message as the skill's body and what followed its name; the host gives the
 * name and that text, and ↑, the copy button, the question nav and the Markdown export show it
 * the way it was typed, `/skill:名字 参数` (SPEC-0001, "M1.11 的 `/` 命令").
 *
 * @sideEffects none
 * @param user - The message's text and command.
 * @returns The typed message.
 */
export function typedMessage(user: Pick<Turn["user"], "command" | "text">): string {
  return writtenCommand(messageTag(user.command), user.text);
}

/**
 * What ↑ goes back through: the messages you sent in the session, newest first.
 *
 * @remarks
 * The current branch's turns as far back as loaded, each its message and then its steers,
 * without the host's own messages, a repeat in a row counted once (SPEC-0001, "模型与输入框"); a
 * message that started with a skill as it was typed.
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
    for (const text of [...(item.user.auto ? [] : [typedMessage(item.user)]), ...steers].toReversed()) {
      if (sent.at(-1) !== text) sent.push(text);
    }
  }
  return sent;
}
