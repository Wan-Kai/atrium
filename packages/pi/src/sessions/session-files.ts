import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLineSplitter } from "../process/jsonl";

/** A session file found in pi's session directory. */
export interface SessionFileInfo {
  readonly path: string;
  readonly sessionId: string;
  /** The working directory pi recorded for the session. */
  readonly cwd: string;
  /** Milliseconds since the epoch. */
  readonly modifiedAt: number;
  /** The text of the first user message, or `null` if the start of the file holds none. */
  readonly firstPrompt: string | null;
}

/** How much of a file is read looking for the first user message; system prompts come first and can be long. */
const HEAD_BYTES = 256 * 1024;

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
 * Finds the directory pi keeps its session files in.
 *
 * @remarks
 * The same order pi follows (pi 1.0.2, `main.js`): `PI_CODING_AGENT_SESSION_DIR`, then
 * `sessionDir` in the global `settings.json`, then `sessions` in pi's agent directory
 * (`PI_CODING_AGENT_DIR`, by default `~/.pi/agent`); pi-internals.md §1. Project settings can
 * also move it, which is not followed here. A missing or unreadable settings file counts as none.
 *
 * @sideEffects Reads pi's settings file.
 * @param env - pi's environment.
 * @returns The directory.
 */
export async function sessionsDirectory(env: Readonly<Record<string, string>>): Promise<string> {
  const home = env["HOME"] ?? homedir();
  const fromEnv = env["PI_CODING_AGENT_SESSION_DIR"];
  if (fromEnv !== undefined && fromEnv !== "") return expandTilde(fromEnv, home);
  const agentEnv = env["PI_CODING_AGENT_DIR"];
  const agentDir = agentEnv === undefined || agentEnv === "" ? join(home, ".pi", "agent") : expandTilde(agentEnv, home);
  // Stryker disable next-line StringLiteral: without an encoding the bytes parse the same.
  const text = await unlessUnreadable(readFile(join(agentDir, "settings.json"), "utf8"));
  // No file reads as JSON `null`, which has no field.
  const configured = field(parseJson(String(text)), "sessionDir");
  if (typeof configured === "string" && configured !== "") return expandTilde(configured, home);
  return join(agentDir, "sessions");
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
    // Stryker disable next-line BlockStatement: an empty block returns `undefined` all the same.
  } catch {
    return undefined;
  }
}

/**
 * Reads a session file's header and the text of its first user message.
 *
 * @remarks
 * Only the start of the file is read (`HEAD_BYTES`), split at LF only, as pi frames its records
 * (pi-internals.md §3): a lone CR inside a line does not end it. The header is the first line
 * (pi-internals.md §1); a file whose first line is not one is not a session file. A last line cut
 * by the limit does not parse and is skipped. A file the system cannot read counts as none.
 *
 * @sideEffects Reads the file.
 * @param path - The file.
 * @returns The session id, its working directory and the first prompt, or `null` for no session file.
 * @throws Errors that are not the file system's.
 */
export async function readSessionHead(
  path: string,
): Promise<{ readonly sessionId: string; readonly cwd: string; readonly firstPrompt: string | null } | null> {
  const head = await unlessUnreadable(readStart(path));
  if (head === null) return null;
  const lines: unknown[] = [];
  const splitter = createLineSplitter((line) => lines.push(parseJson(line)));
  splitter.push(head);
  splitter.end();
  const [first, ...rest] = lines;
  const sessionId = field(first, "id");
  if (field(first, "type") !== "session" || typeof sessionId !== "string") return null;
  const cwd = field(first, "cwd");
  const header = { sessionId, cwd: typeof cwd === "string" ? cwd : "" };
  for (const record of rest) {
    const prompt = userText(record);
    if (prompt !== null) return { ...header, firstPrompt: prompt };
  }
  return { ...header, firstPrompt: null };
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

/**
 * Lists the most recently changed session files in pi's session directory.
 *
 * @remarks
 * pi keeps one folder per working directory, each holding `.jsonl` files (pi-internals.md §1).
 * Files are ordered by modification time, newest first, and only the newest `limit` are read
 * (scanning a large directory takes a while, so it can be stopped); a session id that appears in
 * more than one file keeps the newest file. What the system cannot read (a missing directory, a
 * loose file where a folder should be, a broken link) and files that are not sessions are
 * skipped. Read only: nothing is written.
 *
 * @sideEffects Reads the directory and the start of the newest files.
 * @param directory - pi's session directory.
 * @param limit - The most sessions to return.
 * @param signal - Stops the scan; it then rejects with the signal's reason.
 * @returns The sessions, newest first.
 * @throws The signal's reason once it is aborted, and errors that are not the file system's.
 */
export async function listSessionFiles(
  directory: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SessionFileInfo[]> {
  signal?.throwIfAborted();
  const files: { readonly path: string; readonly modifiedAt: number }[] = [];
  for (const folder of await namesIn(directory)) {
    signal?.throwIfAborted();
    for (const name of await namesIn(join(directory, folder))) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(directory, folder, name);
      const info = await unlessUnreadable(stat(path));
      if (info?.isFile() === true) files.push({ path, modifiedAt: info.mtimeMs });
    }
  }
  files.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const found: SessionFileInfo[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    signal?.throwIfAborted();
    if (found.length >= limit) break;
    const head = await readSessionHead(file.path);
    if (head === null || seen.has(head.sessionId)) continue;
    seen.add(head.sessionId);
    found.push({ path: file.path, modifiedAt: Math.floor(file.modifiedAt), ...head });
  }
  return found;
}

/**
 * The names in a directory.
 *
 * @remarks
 * A directory the system cannot list, or a file in its place, has none.
 *
 * @sideEffects Reads the directory.
 * @param directory - The directory.
 * @returns The names.
 * @throws Errors that are not the file system's.
 */
async function namesIn(directory: string): Promise<string[]> {
  // Stryker disable next-line ArrayDeclaration: a made-up name is no folder and no `.jsonl` file, so it is skipped too.
  return (await unlessUnreadable(readdir(directory))) ?? [];
}

/**
 * Reads the start of a file.
 *
 * @remarks
 * At most `HEAD_BYTES`; see `readSessionHead`.
 *
 * @sideEffects Reads the file.
 * @param path - The file.
 * @returns The bytes read.
 */
async function readStart(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await file.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
