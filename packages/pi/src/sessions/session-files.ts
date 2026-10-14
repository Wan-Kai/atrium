import { agentDirectory, expandTilde } from "../env/agent-dir";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSkillBlock } from "../history/skill-block";
import { type LineSplitter, createLineSplitter } from "../process/jsonl";

/** Where pi keeps its session files. */
export interface SessionsLocation {
  readonly directory: string;
  /**
   * Whether each working directory has a folder of its own in `directory`; when the directory is
   * configured, pi puts every session straight into it instead (pi-internals.md §1).
   */
  readonly perCwd: boolean;
}

/** What a session file says about its session. */
export interface SessionFileSummary {
  readonly path: string;
  readonly sessionId: string;
  /** The working directory pi recorded; empty when the header has none. */
  readonly cwd: string;
  /** pi's session name: the latest `session_info`, `null` when unset or cleared. */
  readonly name: string | null;
  /** The text of the first user message that has text, or `null`. */
  readonly firstPrompt: string | null;
  /** Milliseconds since the epoch. */
  readonly modifiedAt: number;
}

/** A working directory pi has kept sessions for. */
export interface SessionDirectory {
  /** The working directory, as pi recorded it. */
  readonly cwd: string;
  /** How many session files name it. */
  readonly sessions: number;
  /** When the latest of them last changed, in milliseconds since the epoch. */
  readonly lastUsedAt: number;
}

/** Reads session files, remembering what it read so a later scan reads only what changed. */
export interface SessionFileReader {
  /**
   * Summarizes the session files in a folder.
   *
   * @remarks
   * See `createSessionFileReader`.
   */
  scanFolder(folder: string, signal?: AbortSignal): Promise<SessionFileSummary[]>;
}

/** An image a user message carries in a session file, as pi keeps it. */
export interface SessionImage {
  readonly mimeType: SessionImageType;
  /** Base64, without a `data:` prefix. */
  readonly data: string;
}

/** The formats pi keeps images in (pi-internals.md, "图片"). */
export type SessionImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** See {@link SessionImageType}. */
const IMAGE_TYPES: ReadonlySet<unknown> = new Set<SessionImageType>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Whether a value names a format pi keeps images in.
 *
 * @remarks
 * Narrows what a session file says to {@link SessionImageType}.
 *
 * @sideEffects none
 * @param value - The value.
 * @returns Whether it is one.
 */
function isImageType(value: unknown): value is SessionImageType {
  return IMAGE_TYPES.has(value);
}

/** How much of a file is read at a time. */
// Stryker disable next-line ArithmeticOperator: a smaller chunk only makes reads slower and smaller; each read still stops at its end.
const CHUNK_BYTES = 1024 * 1024;

/** The most read of a file to find its header; pi's is well under 1 KiB. */
const HEADER_BYTES = 64 * 1024;

/**
 * Reads one field of a JSON value.
 *
 * @remarks
 * Session files and settings are JSON from another program; any field may be missing or of
 * another type.
 *
 * @sideEffects none
 * @param value - The value.
 * @param key - The field.
 * @returns The field's value, or `undefined` when the value is not an object.
 */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * Waits for a read, counting a file the system cannot read as none.
 *
 * @remarks
 * A file missing, unreadable or not what was expected fails a system call, and its error names
 * the call (`syscall`); such files are skipped. Any other error, such as Node refusing an
 * argument, is a bug and is thrown.
 *
 * @sideEffects none beyond the read.
 * @param read - The read.
 * @returns What it read, or `null`.
 * @throws Errors that are not a failed system call.
 */
async function unlessUnreadable<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (typeof field(error, "syscall") === "string") return null;
    throw error;
  }
}

/**
 * Finds where pi keeps its session files.
 *
 * @remarks
 * The same order pi follows (pi 1.0.2, `main.js`): `PI_CODING_AGENT_SESSION_DIR`, then
 * `sessionDir` in the global `settings.json`, then `sessions` in pi's agent directory
 * (`PI_CODING_AGENT_DIR`, by default `~/.pi/agent`); pi-internals.md §1. Only the last keeps a
 * folder per working directory. Project settings can also move it, which is not followed here.
 * A missing or unreadable settings file counts as none.
 *
 * @sideEffects Reads pi's settings file.
 * @param env - pi's environment.
 * @returns The location.
 */
export async function sessionsLocation(env: Readonly<Record<string, string>>): Promise<SessionsLocation> {
  const home = env["HOME"] ?? homedir();
  const fromEnv = env["PI_CODING_AGENT_SESSION_DIR"];
  if (fromEnv !== undefined && fromEnv !== "") return { directory: expandTilde(fromEnv, home), perCwd: false };
  const agentDir = agentDirectory(env);
  // Stryker disable next-line StringLiteral: without an encoding the bytes parse the same.
  const text = await unlessUnreadable(readFile(join(agentDir, "settings.json"), "utf8"));
  // No file reads as JSON `null`, which has no field.
  const configured = field(parseJson(String(text)), "sessionDir");
  if (typeof configured === "string" && configured !== "") {
    return { directory: expandTilde(configured, home), perCwd: false };
  }
  return { directory: join(agentDir, "sessions"), perCwd: true };
}

/**
 * The folder pi writes a working directory's sessions to.
 *
 * @remarks
 * pi's rule (pi 1.0.1, `session-manager.ts` `getDefaultSessionDirPath`): the path without its
 * leading separator, with `/`, `\` and `:` turned into `-`, between `--` and `--`. Different
 * paths can share a folder (`/a-b` and `/a/b`), so callers still check each file's `cwd`. With a
 * configured location every session is in the one directory.
 *
 * @sideEffects none
 * @param location - Where pi keeps sessions.
 * @param cwd - The working directory, absolute.
 * @returns The folder.
 */
export function sessionFolder(location: SessionsLocation, cwd: string): string {
  if (!location.perCwd) return location.directory;
  return join(location.directory, `--${cwd.replace(/^[/\\]/, "").replaceAll(/[/\\:]/g, "-")}--`);
}

/**
 * Parses JSON text.
 *
 * @remarks
 * A damaged line or file counts as nothing rather than failing the whole read.
 *
 * @sideEffects none
 * @param text - The text.
 * @returns The value, or `undefined` when it is not JSON.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: nothing.
  }
  return undefined;
}

/**
 * The text of a user message entry.
 *
 * @remarks
 * User content is a string or a list of blocks; only text blocks count. A message that started
 * with a skill gives what followed the skill's name, or the name when nothing did (SPEC-0001,
 * "M1.11 的 `/` 命令"), not the skill's file.
 *
 * @sideEffects none
 * @param record - An entry.
 * @returns The text, or `null` when the entry is not a user message with text.
 */
function userText(record: unknown): string | null {
  const text = rawUserText(record);
  const skill = text === null ? null : readSkillBlock(text);
  return skill === null ? text : skill.args || skill.name;
}

/**
 * The text of a user message entry as pi keeps it.
 *
 * @remarks
 * See `userText`.
 *
 * @sideEffects none
 * @param record - An entry.
 * @returns The text, or `null` when the entry is not a user message with text.
 */
function rawUserText(record: unknown): string | null {
  const message = field(record, "type") === "message" ? field(record, "message") : undefined;
  if (field(message, "role") !== "user") return null;
  const content = field(message, "content");
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content.flatMap((block: unknown) => {
    const text = field(block, "text");
    return field(block, "type") === "text" && typeof text === "string" ? [text] : [];
  });
  return texts.length === 0 ? null : texts.join("\n");
}

/** What has been read of one file so far. */
interface FileState {
  size: number;
  modifiedAt: number;
  /** Keeps the line still being written between reads. */
  readonly splitter: LineSplitter;
  /** `undefined` before the first line, `null` when the file is not a session. */
  header: { readonly sessionId: string; readonly cwd: string } | null | undefined;
  name: string | null;
  firstPrompt: string | null;
}

/**
 * Starts reading a file from its beginning.
 *
 * @remarks
 * Lines are split at LF only, as pi frames its records (pi-internals.md §3): a lone CR inside a
 * line does not end it. The first line is the header (pi-internals.md §1); a file whose first
 * line is not one is not a session file. After it, only lines that may matter are parsed: user
 * messages until the first with text, and `session_info` entries, the latest of which names
 * the session (pi trims it; empty clears it).
 *
 * @sideEffects none
 * @returns The state, with nothing read.
 */
function newFileState(): FileState {
  const state: FileState = {
    size: 0,
    modifiedAt: 0,
    splitter: createLineSplitter((line) => readLine(state, line)),
    header: undefined,
    name: null,
    firstPrompt: null,
  };
  return state;
}

/**
 * Takes in one line of a session file.
 *
 * @remarks
 * See `newFileState`.
 *
 * @sideEffects Updates `state`.
 * @param state - The file's state.
 * @param line - The line.
 */
function readLine(state: FileState, line: string): void {
  if (state.header === undefined) {
    const first = parseJson(line);
    const sessionId = field(first, "id");
    const cwd = field(first, "cwd");
    state.header =
      field(first, "type") === "session" && typeof sessionId === "string"
        ? { sessionId, cwd: typeof cwd === "string" ? cwd : "" }
        : null;
    return;
  }
  // Stryker disable next-line ConditionalExpression: a fast path; a file that is not a session is left out of every scan, whatever its later lines say.
  if (state.header === null) return;
  // Stryker disable next-line StringLiteral: a fast path; `userText` finds nothing in a line without a user message anyway.
  if (state.firstPrompt === null && line.includes('"user"')) state.firstPrompt = userText(parseJson(line));
  // Stryker disable next-line ConditionalExpression,StringLiteral: a fast path; the entry's type is checked below anyway.
  if (line.includes('"session_info"')) {
    const entry = parseJson(line);
    const name = field(entry, "name");
    if (field(entry, "type") === "session_info") {
      state.name = typeof name === "string" && name.trim() !== "" ? name.trim() : null;
    }
  }
}

/**
 * Reads a file's bytes from one offset to another into its state.
 *
 * @remarks
 * In chunks, so a large file is never held whole; checks the signal between chunks.
 *
 * @sideEffects Reads the file.
 * @param path - The file.
 * @param state - Its state.
 * @param from - Where to start.
 * @param to - Where to stop.
 * @param signal - Stops the read.
 * @returns Where the read stopped: `to`, or earlier when the file ended first.
 * @throws The signal's reason once it is aborted; the file system's errors.
 */
async function readRange(
  path: string,
  state: FileState,
  from: number,
  to: number,
  signal?: AbortSignal,
): Promise<number> {
  const file = await open(path, "r");
  let position = from;
  try {
    // Stryker disable next-line MethodExpression,ArithmeticOperator: the buffer's size only changes how much memory a read takes and how often the signal is checked; each read still stops at `to`.
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(to - from, 1)));
    // Stryker disable next-line EqualityOperator: at `to` a read asks for no bytes, gets none and stops the loop.
    while (position < to) {
      signal?.throwIfAborted();
      // Stryker disable next-line ArithmeticOperator: a read only goes past `to` when the file grew between stat and read, which cannot be timed in a test.
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, to - position), position);
      // Stryker disable next-line ConditionalExpression: a read before `to` only finds nothing when the file shrank between stat and read, which cannot be timed in a test.
      if (bytesRead === 0) break;
      state.splitter.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
  return position;
}

/**
 * Creates a reader of pi's session files.
 *
 * @remarks
 * pi only appends to a session file (pi-internals.md §1), so a file that grew is read from where
 * the last read stopped, and one that did not change is not read at all; a file that shrank or
 * changed without growing was rewritten and is read again from the start. A line counts once its
 * LF has been written, so a record pi is still writing waits for the next scan. What the system
 * cannot read (a missing folder, a broken link, a file that vanished mid-scan) and files that
 * are not sessions are skipped. Read only: nothing is written (SPEC-0001, "项目、工作区与会话").
 *
 * @sideEffects none until a scan; scans read the folder and its files.
 * @returns The reader.
 */
export function createSessionFileReader(): SessionFileReader {
  const files = new Map<string, FileState>();
  return {
    async scanFolder(folder, signal) {
      signal?.throwIfAborted();
      // Stryker disable next-line ArrayDeclaration: only names ending in `.jsonl` are read, so a stand-in name without it changes nothing.
      const names = (await unlessUnreadable(readdir(folder))) ?? [];
      const found: SessionFileSummary[] = [];
      const seen = new Set<string>();
      for (const name of names.filter((entry) => entry.endsWith(".jsonl")).toSorted()) {
        signal?.throwIfAborted();
        const path = join(folder, name);
        const info = await unlessUnreadable(stat(path));
        if (info?.isFile() !== true) continue;
        seen.add(path);
        let state = files.get(path);
        if (
          state === undefined ||
          info.size < state.size ||
          (info.size === state.size && info.mtimeMs !== state.modifiedAt)
        ) {
          state = newFileState();
          files.set(path, state);
        }
        if (info.size > state.size) {
          const reached = await unlessUnreadable(readRange(path, state, state.size, info.size, signal));
          // A file that ended before its size (rewritten since it was looked at) is read again
          // from its start next time, rather than continued from the wrong place.
          // Stryker disable next-line ConditionalExpression,EqualityOperator: a file shrinking between stat and read cannot be timed in a test.
          if (reached === null || reached < info.size) {
            files.delete(path);
            continue;
          }
        }
        state.size = info.size;
        state.modifiedAt = info.mtimeMs;
        if (state.header === null || state.header === undefined) continue;
        found.push({
          path,
          ...state.header,
          name: state.name,
          firstPrompt: state.firstPrompt,
          modifiedAt: Math.floor(info.mtimeMs),
        });
      }
      for (const path of files.keys()) {
        if (path.startsWith(`${folder}/`) && !seen.has(path)) files.delete(path);
      }
      return found;
    },
  };
}

/**
 * One image of a user message, as a session file keeps it.
 *
 * @remarks
 * User content is a string or a list of blocks; images are counted among the image blocks
 * alone, as `contentText` counts them. Only the formats pi keeps count, so nothing else, such as
 * SVG, which can carry script, ever reaches a `data:` address.
 *
 * @sideEffects none
 * @param message - The entry's message.
 * @param index - Which image, from 0.
 * @returns The image, or `null` when the message is not a user's or has no such image.
 */
function userImage(message: unknown, index: number): SessionImage | null {
  const content = field(message, "role") === "user" ? field(message, "content") : undefined;
  const block: unknown = Array.isArray(content)
    ? content.filter((one) => field(one, "type") === "image")[index]
    : undefined;
  const mimeType = field(block, "mimeType");
  const data = field(block, "data");
  return isImageType(mimeType) && typeof data === "string" ? { mimeType, data } : null;
}

/**
 * Reads a file from its start until an entry is found or the file ends.
 *
 * @remarks
 * In chunks, so a large file is never held whole; checks the signal between chunks. A line
 * counts once its LF has been written, as in {@link createSessionFileReader}.
 *
 * @sideEffects Reads the file.
 * @param path - The file.
 * @param entryId - The entry.
 * @param index - Which of its images.
 * @param signal - Stops the read.
 * @returns The image; `null` when the entry or the image is not there; `undefined` when the
 * entry is not in the file.
 * @throws The signal's reason once it is aborted; the file system's errors.
 */
async function findUserImage(
  path: string,
  entryId: string,
  index: number,
  signal?: AbortSignal,
): Promise<SessionImage | null | undefined> {
  let found: SessionImage | null | undefined;
  const splitter = createLineSplitter((line) => {
    // Stryker disable next-line ConditionalExpression,LogicalOperator: a fast path; the entry's id is checked below anyway, and reading stops once it is found.
    if (found !== undefined || !line.includes(entryId)) return;
    const entry = parseJson(line);
    if (field(entry, "type") === "message" && field(entry, "id") === entryId) {
      found = userImage(field(entry, "message"), index);
    }
  });
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      splitter.push(buffer.subarray(0, bytesRead));
      // Stryker disable next-line ConditionalExpression: stopping here only spares reading the rest; the first match is kept either way.
      if (found !== undefined) break;
    }
  } finally {
    await file.close();
  }
  return found;
}

/**
 * Reads one image of a user message from a session file.
 *
 * @remarks
 * pi keeps the images it took in a user message's content and writes the message to the file as
 * soon as it is added (pi-internals.md, "图片"), so the image is there whatever became of the
 * file it was pasted from; for the thumbnails of sent messages (SPEC-0001, "M1.11 的消息图片").
 * Entries are found by id, which is unique within a file. A file the system cannot read counts as
 * having none. Read only.
 *
 * @sideEffects Reads the file.
 * @param path - The session file.
 * @param entryId - The user message's entry.
 * @param index - Which of its images, from 0.
 * @param signal - Stops the read.
 * @returns The image, or `null` when the file, the entry or the image is not there.
 * @throws The signal's reason once it is aborted.
 */
export async function readUserImage(
  path: string,
  entryId: string,
  index: number,
  signal?: AbortSignal,
): Promise<SessionImage | null> {
  return (await unlessUnreadable(findUserImage(path, entryId, index, signal))) ?? null;
}

/**
 * The working directory a session file's header names.
 *
 * @remarks
 * Only the first line is read, up to {@link HEADER_BYTES}: the header (pi-internals.md §1). A
 * header still being written, without its line break, counts as none yet, as in
 * {@link createSessionFileReader}.
 *
 * @sideEffects Reads the start of the file.
 * @param path - The file.
 * @returns The `cwd`, or `null` when the file is not a session or names none.
 */
async function headerCwd(path: string): Promise<string | null> {
  const file = await open(path, "r");
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(HEADER_BYTES), 0, HEADER_BYTES, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(0x0a);
    // Stryker disable next-line ConditionalExpression,UnaryOperator: without the check, no line break reads as text up to -1, which is empty and names no `cwd`; a first line one byte long names none either.
    if (end === -1) return null;
    const first = parseJson(buffer.toString("utf8", 0, end));
    const cwd = field(first, "cwd");
    return field(first, "type") === "session" &&
      typeof field(first, "id") === "string" &&
      typeof cwd === "string" &&
      cwd !== ""
      ? cwd
      : null;
  } finally {
    await file.close();
  }
}

/**
 * The working directories pi has kept sessions for.
 *
 * @remarks
 * For first launch, which offers them as projects (SPEC-0001, "首次启动 · 接口"). Reads only each
 * file's header, so a long history is quick: in a folder per working directory, or the configured
 * directory itself (see {@link sessionsLocation}). A folder can hold more than one working
 * directory's sessions ({@link sessionFolder}), so each file's own `cwd` counts. Like pi (pi 1.0.2,
 * `SessionManager.listAll`), a link among the folders is followed; any other name there that is
 * not a folder fails to be read as one. What the system cannot read is skipped. Read only.
 *
 * @sideEffects Reads pi's session folders and the start of each session file.
 * @param location - Where pi keeps sessions.
 * @param signal - Stops the read.
 * @returns Each working directory, in no order.
 * @throws The signal's reason once it is aborted.
 */
export async function sessionDirectories(
  location: SessionsLocation,
  signal?: AbortSignal,
): Promise<SessionDirectory[]> {
  signal?.throwIfAborted();
  const folders = location.perCwd
    ? // Stryker disable next-line ArrayDeclaration: a made-up name is not a folder there either, so it is skipped the same way.
      ((await unlessUnreadable(readdir(location.directory))) ?? []).map((name) => join(location.directory, name))
    : [location.directory];
  const found = new Map<string, { sessions: number; lastUsedAt: number }>();
  for (const folder of folders) {
    // Stryker disable next-line ArrayDeclaration: a made-up name does not end in `.jsonl`, so it is left out like none.
    const names = (await unlessUnreadable(readdir(folder))) ?? [];
    for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
      signal?.throwIfAborted();
      const path = join(folder, name);
      const info = await unlessUnreadable(stat(path));
      if (info?.isFile() !== true) continue;
      const cwd = await unlessUnreadable(headerCwd(path));
      if (cwd === null) continue;
      const before = found.get(cwd);
      const modifiedAt = Math.floor(info.mtimeMs);
      found.set(cwd, {
        sessions: (before?.sessions ?? 0) + 1,
        lastUsedAt: Math.max(before?.lastUsedAt ?? 0, modifiedAt),
      });
    }
  }
  return [...found].map(([cwd, { sessions, lastUsedAt }]) => ({ cwd, sessions, lastUsedAt }));
}
