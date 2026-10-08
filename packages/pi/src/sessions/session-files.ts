import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** How much of a file is read at a time. */
const CHUNK_BYTES = 1024 * 1024;

/**
 * Expands a leading `~` as pi does.
 *
 * @remarks
 * pi accepts `~` in its directory variables (pi 1.0.2, `config.js` `expandTildePath`).
 *
 * @sideEffects none
 * @param path - The path.
 * @param home - The home directory.
 * @returns The expanded path.
 */
function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

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
  const agentEnv = env["PI_CODING_AGENT_DIR"];
  const agentDir = agentEnv === undefined || agentEnv === "" ? join(home, ".pi", "agent") : expandTilde(agentEnv, home);
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
 * User content is a string or a list of blocks; only text blocks count.
 *
 * @sideEffects none
 * @param record - An entry.
 * @returns The text, or `null` when the entry is not a user message with text.
 */
function userText(record: unknown): string | null {
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
  if (state.header === null) return;
  if (state.firstPrompt === null && line.includes('"user"')) state.firstPrompt = userText(parseJson(line));
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
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(to - from, 1)));
    while (position < to) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, to - position), position);
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
