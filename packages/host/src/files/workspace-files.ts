import { CommandError, type DirEntry, FILE_LIMITS, type FileContent, type ShownImageType } from "@atrium/protocol";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { BINARY_SNIFF_BYTES, isLikelyBinary } from "../changes/diff-text";
import type { GitRunner } from "../platform/git";
import type { Logger } from "../platform/logger";

/** Reads a workspace's files for the right panel's file tree and the viewer tabs. */
export interface WorkspaceFiles {
  /** One directory's entries, as `list_dir` answers. */
  listDir(workspaceId: string, path: string): Promise<{ entries: DirEntry[]; truncated: boolean }>;
  /** One file's size and content, as `read_file` answers. */
  readFile(workspaceId: string, path: string): Promise<{ size: number; content: FileContent }>;
}

/** How long one `git check-ignore` may take. */
const IGNORE_TIMEOUT_MS = 10_000;

/** The PNG signature. */
const PNG_START = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The start of every JPEG. */
const JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Which of the images shown as themselves a file is, by the bytes it starts with.
 *
 * @remarks
 * Not by its name (SPEC-0001, "M1.12 的文件与更改"): PNG, JPEG, GIF (87a or 89a) and WebP (a RIFF
 * container of type WEBP).
 *
 * @sideEffects none
 * @param start - The file's first bytes.
 * @returns The image type, or `undefined` when it is none of them.
 */
function imageTypeOf(start: Buffer): ShownImageType | undefined {
  if (start.subarray(0, 8).equals(PNG_START)) return "image/png";
  if (start.subarray(0, 3).equals(JPEG_START)) return "image/jpeg";
  const head = start.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return "image/webp";
  return undefined;
}

/**
 * Creates the reader behind `list_dir` and `read_file`.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改") and security.md ("子进程与文件"): a path is relative, made of
 * plain parts, and reached without passing through a link; the last part is opened without
 * following one. A file's type, size and content come from one opening. Every failure becomes an
 * error code, so nothing that names a path reaches the router's log; this logs only the workspace
 * and the error's kind.
 *
 * @sideEffects none until called; then reads the file system and runs `git check-ignore`.
 * @param options - Where each workspace is, git (`null` without git, when nothing counts as
 * ignored), and the logger.
 * @returns The reader.
 */
export function createWorkspaceFiles(options: {
  readonly dirOf: (workspaceId: string) => string | undefined;
  readonly git: Promise<GitRunner | null>;
  readonly logger: Logger;
}): WorkspaceFiles {
  /**
   * Turns a failure into the error the command answers with.
   *
   * @remarks
   * A `CommandError` passes as it is; anything else, such as a disk error, is `read_failed`,
   * logged by its kind only, since its message may name the path.
   *
   * @sideEffects Logs a failure that is not a `CommandError`.
   * @param workspaceId - The workspace, for the log.
   * @param error - What was thrown.
   * @returns The error to throw.
   */
  function failure(workspaceId: string, error: unknown): CommandError {
    if (error instanceof CommandError) return error;
    options.logger.warn({ workspace_id: workspaceId, reason: errorKind(error) }, "workspace file read failed");
    return new CommandError("read_failed");
  }

  /**
   * Which entries of a directory git ignores.
   *
   * @remarks
   * One `git check-ignore` for the directory, the names on its input, never in its arguments. Each
   * name goes as `./name`, so one starting with `:` is not read as pathspec magic (`:(top)foo`
   * would otherwise ask about `foo`). A tracked file is never reported. Exit 1 ignores nothing;
   * 128, outside a repository, likewise.
   *
   * @sideEffects Runs git.
   * @param dir - The directory, as its real path.
   * @param names - Its entries' names.
   * @returns The names ignored.
   * @throws {CommandError} `read_failed` when git fails otherwise.
   */
  async function ignored(dir: string, names: readonly string[]): Promise<ReadonlySet<string>> {
    const git = await options.git;
    // Stryker disable next-line ConditionalExpression,LogicalOperator: git ignores nothing of no names either; this spares it a run.
    if (git === null || names.length === 0) return new Set();
    const { code, stdout } = await git.run(["check-ignore", "--stdin", "-z"], {
      cwd: dir,
      input: names.map((name) => `./${name}\0`).join(""),
      timeoutMs: IGNORE_TIMEOUT_MS,
    });
    if (code === 1 || code === 128) return new Set();
    if (code !== 0) throw new CommandError("read_failed");
    return new Set(stdout.split("\0").map((name) => name.slice("./".length)));
  }

  return {
    async listDir(workspaceId, path) {
      const { target, check } = await locate(options.dirOf, workspaceId, path);
      let dir: FileHandle;
      try {
        // A link followed despite this would fail the check below, the opened directory not being the link.
        // Stryker disable next-line ArithmeticOperator,BitwiseOperator: see above.
        dir = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      } catch (error) {
        throw failure(workspaceId, openFailure(error, await lstat(target).catch(() => null)));
      }
      try {
        const opened = await dir.stat();
        const read = await readdir(target, { withFileTypes: true });
        await check(opened);
        const listed = read.flatMap((entry): DirEntry[] => {
          if (entry.name === ".git") return [];
          const kind = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : null;
          return kind === null ? [] : [{ name: entry.name, kind }];
        });
        const skip = await ignored(
          target,
          listed.map((entry) => entry.name),
        );
        const entries = listed.filter((entry) => !skip.has(entry.name));
        if (entries.length <= FILE_LIMITS.entries) return { entries, truncated: false };
        // Node's readdir gives names in byte order, so the same directory keeps the same first ones.
        return { entries: entries.slice(0, FILE_LIMITS.entries), truncated: true };
      } catch (error) {
        throw failure(workspaceId, error);
      } finally {
        await dir.close();
      }
    },

    async readFile(workspaceId, path) {
      const { target, check } = await locate(options.dirOf, workspaceId, path);
      let file: FileHandle;
      try {
        file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        const info = await lstat(target).catch(() => null);
        if (info?.isSymbolicLink() === true) return { size: info.size, content: { kind: "link" } };
        throw failure(workspaceId, openFailure(error, info));
      }
      try {
        const opened = await file.stat();
        if (!opened.isFile()) throw new CommandError("path_invalid");
        await check(opened);
        return { size: opened.size, content: await readContent(file, opened.size) };
      } catch (error) {
        throw failure(workspaceId, error);
      } finally {
        await file.close();
      }
    },
  };
}

/**
 * Finds the path a command names, checking it stays inside the workspace.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改"): the parts are plain, and the parent directory's real path is
 * exactly the workspace's real path joined with them, so no part on the way is a link. The check
 * it returns runs again once the target is open, with what the opening found, so a parent swapped
 * for a link meanwhile, or a target swapped after it was opened, is refused.
 *
 * @sideEffects Reads real paths from the file system.
 * @param dirOf - Where each workspace is.
 * @param workspaceId - The workspace.
 * @param path - The path, relative to it.
 * @returns The target's path, and the check to run once it is open.
 * @throws {CommandError} `workspace_not_found`, `path_invalid` or `path_not_found`.
 */
async function locate(
  dirOf: (workspaceId: string) => string | undefined,
  workspaceId: string,
  path: string,
): Promise<{ readonly target: string; readonly check: (opened: Stats) => Promise<void> }> {
  const dir = dirOf(workspaceId);
  if (dir === undefined) throw new CommandError("workspace_not_found");
  const parts = path === "" ? [] : path.split("/");
  if (path.includes("\0") || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new CommandError("path_invalid");
  }
  const root = await realpath(dir).catch(() => {
    throw new CommandError("path_not_found");
  });
  const parent = join(root, ...parts.slice(0, -1));
  const target = join(root, ...parts);
  /**
   * Checks the parent is still reached without a link.
   *
   * @remarks
   * A missing parent, or one that is a file, means nothing is at the path.
   *
   * @sideEffects Reads the parent's real path.
   * @throws {CommandError} `path_not_found` or `path_invalid`.
   */
  const checkParent = async (): Promise<void> => {
    const real = await realpath(parent).catch(() => {
      throw new CommandError("path_not_found");
    });
    if (real !== parent) throw new CommandError("path_invalid");
  };
  await checkParent();
  return {
    target,
    check: async (opened) => {
      await checkParent();
      const now = await lstat(target).catch(() => null);
      if (now?.ino !== opened.ino || now.dev !== opened.dev) throw new CommandError("path_invalid");
    },
  };
}

/**
 * The error for a target that would not open.
 *
 * @remarks
 * Nothing there is `path_not_found`; a link, or something that is neither a file nor a
 * directory as the command needs, is `path_invalid`; anything else goes on as it is.
 *
 * @sideEffects none
 * @param error - What opening threw.
 * @param info - What is at the path, without following a link; `null` when nothing is.
 * @returns The error to throw.
 */
function openFailure(error: unknown, info: Stats | null): unknown {
  if (info === null) return new CommandError("path_not_found");
  if (info.isSymbolicLink() || !(info.isFile() || info.isDirectory())) return new CommandError("path_invalid");
  return systemCode(error) === "ENOTDIR" ? new CommandError("path_invalid") : error;
}

/**
 * Reads an open file as the viewer shows it.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改"): the start decides an image (by its bytes, not its name) or
 * binary; text over 1 MB and images over 10 MB are not read; text that is not valid UTF-8 is
 * binary. At most `size` bytes are read, so a file growing meanwhile is cut where it was.
 *
 * @sideEffects Reads the file.
 * @param file - The open file.
 * @param size - Its size when it was opened.
 * @returns What it holds.
 */
async function readContent(file: FileHandle, size: number): Promise<FileContent> {
  const start = await readUpTo(file, Math.min(size, BINARY_SNIFF_BYTES));
  const image = imageTypeOf(start);
  if (image !== undefined) {
    if (size > FILE_LIMITS.imageBytes) return { kind: "too_large" };
    return { kind: "image", mimeType: image, data: (await readUpTo(file, size)).toString("base64") };
  }
  if (isLikelyBinary(start)) return { kind: "binary" };
  if (size > FILE_LIMITS.textBytes) return { kind: "too_large" };
  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(await readUpTo(file, size)) };
  } catch (error) {
    if (error instanceof TypeError) return { kind: "binary" };
    throw error;
  }
}

/**
 * Reads a file's first bytes.
 *
 * @remarks
 * From the start whatever was read before; fewer when the file has shrunk.
 *
 * @sideEffects Reads the file.
 * @param file - The open file.
 * @param length - How many bytes.
 * @returns What was read.
 */
async function readUpTo(file: FileHandle, length: number): Promise<Buffer> {
  const content = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(content, filled, length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return content.subarray(0, filled);
}

/**
 * A failure's kind, for the log.
 *
 * @remarks
 * The system's error code, as `EIO`, or the error's name; never its message, which may name the
 * path.
 *
 * @sideEffects none
 * @param error - The failure.
 * @returns Its kind.
 */
function errorKind(error: unknown): string {
  return systemCode(error) ?? (error instanceof Error ? error.name : "unknown");
}

/**
 * The system's code of a file system error, as `ENOENT`.
 *
 * @remarks
 * Node puts it on the error as `code`.
 *
 * @sideEffects none
 * @param error - The failure.
 * @returns The code, or `undefined` when there is none.
 */
function systemCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
