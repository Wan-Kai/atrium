import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

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
 * Finds the directory pi keeps its session files in.
 *
 * @remarks
 * The same order pi follows (pi 1.0.2, `main.js`): `PI_CODING_AGENT_SESSION_DIR`, then
 * `sessionDir` in the global `settings.json`, then `sessions` in pi's agent directory
 * (`PI_CODING_AGENT_DIR`, by default `~/.pi/agent`); pi-internals.md §1. Project settings can
 * also move it, which is not followed here. An unreadable settings file counts as none.
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
  try {
    const settings: unknown = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    if (typeof settings === "object" && settings !== null && "sessionDir" in settings) {
      const configured = settings.sessionDir;
      if (typeof configured === "string" && configured !== "") return expandTilde(configured, home);
    }
  } catch {
    // No settings, or not JSON: pi's default applies.
  }
  return join(agentDir, "sessions");
}

/**
 * Reads a session file's header and the text of its first user message.
 *
 * @remarks
 * Only the start of the file is read (`HEAD_BYTES`). The header is the first line (pi-internals.md
 * §1); a file whose first line is not one is not a session file.
 *
 * @sideEffects Reads the file.
 * @param path - The file.
 * @returns The session id, its working directory and the first prompt, or `null` for no session file.
 */
async function readHead(
  path: string,
): Promise<{ readonly sessionId: string; readonly cwd: string; readonly firstPrompt: string | null } | null> {
  const stream = createReadStream(path, { encoding: "utf8", end: HEAD_BYTES - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let header: { sessionId: string; cwd: string } | null = null;
  try {
    for await (const line of lines) {
      const record = parseLine(line);
      if (header === null) {
        if (record?.["type"] !== "session" || typeof record["id"] !== "string") return null;
        header = { sessionId: record["id"], cwd: typeof record["cwd"] === "string" ? record["cwd"] : "" };
        continue;
      }
      const prompt = userText(record);
      if (prompt !== null) return { ...header, firstPrompt: prompt };
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return header === null ? null : { ...header, firstPrompt: null };
}

/**
 * Parses one line of a session file.
 *
 * @remarks
 * A line cut by the read limit, or damaged, is skipped.
 *
 * @sideEffects none
 * @param line - The line.
 * @returns The record, or `null`.
 */
function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Whether a value is a JSON object.
 *
 * @remarks
 * See `parseLine`.
 *
 * @sideEffects none
 * @param value - The value.
 * @returns Whether it is an object that is not an array.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
function userText(record: Record<string, unknown> | null): string | null {
  const message = record?.["type"] === "message" ? record["message"] : undefined;
  if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "user") return null;
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content.flatMap((block: unknown) =>
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "text" &&
    "text" in block &&
    typeof block.text === "string"
      ? [block.text]
      : [],
  );
  return texts.length === 0 ? null : texts.join("\n");
}

/**
 * Lists the most recently changed session files in pi's session directory.
 *
 * @remarks
 * pi keeps one folder per working directory, each holding `.jsonl` files (pi-internals.md §1).
 * Files are ordered by modification time, newest first, and only the newest `limit` are read;
 * a session id that appears in more than one file keeps the newest file. Missing directories,
 * unreadable files and files that are not sessions are skipped. Read only: nothing is written.
 *
 * @sideEffects Reads the directory and the start of the newest files.
 * @param directory - pi's session directory.
 * @param limit - The most sessions to return.
 * @returns The sessions, newest first.
 */
export async function listSessionFiles(directory: string, limit: number): Promise<SessionFileInfo[]> {
  const folders = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: { readonly path: string; readonly modifiedAt: number }[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const names = await readdir(join(directory, folder.name)).catch((): string[] => []);
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(directory, folder.name, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() === true) files.push({ path, modifiedAt: info.mtimeMs });
    }
  }
  files.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const found: SessionFileInfo[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (found.length >= limit) break;
    const head = await readHead(file.path).catch(() => null);
    if (head === null || seen.has(head.sessionId)) continue;
    seen.add(head.sessionId);
    found.push({ path: file.path, modifiedAt: Math.floor(file.modifiedAt), ...head });
  }
  return found;
}
