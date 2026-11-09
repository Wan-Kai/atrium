import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorCode } from "../platform/errors";
import type { Logger } from "../platform/logger";
import { MARKER } from "./directions";
import { STUDY_VERSION, StudyFile, parseStudyFile } from "./progress";

/** The most bytes of a marker file read; a larger one is broken, as the scan reads it. */
const MARKER_LIMIT = 1024 * 1024;

/**
 * Why a direction's progress was not written (SPEC-0008, "ML2 定的细节"): its file, its size, the
 * write, a directory that is no longer a real one right under the learning directory, or an
 * archive under way.
 */
export type StudyFileCode =
  | "study_file_broken"
  | "study_file_version"
  | "study_file_too_large"
  | "study_write_failed"
  | "learning_dir_unsafe"
  | "direction_archived";

/**
 * A direction's `.atrium-study.json` not written.
 *
 * @remarks
 * The host turns it into a tool's or a command's error code.
 *
 * @sideEffects none
 */
export class StudyFileError extends Error {
  /**
   * A failure with its code.
   *
   * @remarks
   * Only codes, never the file's content or path (security.md).
   *
   * @sideEffects none
   * @param code - The code.
   */
  constructor(readonly code: StudyFileCode) {
    super(code);
  }
}

/** Changes directions' progress files. */
export interface ProgressFiles {
  /**
   * Reads a direction's file again, changes it and writes it, one change at a time per direction;
   * resolves to what was written.
   */
  update(dir: string, change: (file: StudyFile) => StudyFile): Promise<StudyFile>;
  /**
   * Runs `task` once the changes asked for before are done, refusing changes asked for meanwhile
   * (`direction_archived`); for archiving a direction.
   */
  hold<T>(dir: string, task: () => Promise<T>): Promise<T>;
  /** Waits for the writes under way. */
  close(): Promise<void>;
}

/**
 * Reads a direction's marker file as the host writes it.
 *
 * @remarks
 * Opened with `O_NOFOLLOW`: a link, a file that is not regular, one too large or that does not
 * parse is broken; a later version is read but not written (security.md, "学习方向").
 *
 * @sideEffects Reads the file.
 * @param dir - The direction's directory.
 * @returns The file.
 * @throws {StudyFileError} `study_file_broken` or `study_file_version`.
 */
async function readStudyFile(dir: string): Promise<StudyFile> {
  const handle = await open(join(dir, MARKER), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (handle === null) throw new StudyFileError("study_file_broken");
  let text: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MARKER_LIMIT) throw new StudyFileError("study_file_broken");
    // Stryker disable next-line StringLiteral: without an encoding the buffer parses the same.
    text = await handle.readFile("utf8");
    // Stryker disable BlockStatement: an open handle left behind is not seen by any test, only by the leak counts.
  } finally {
    await handle.close();
  }
  // Stryker restore BlockStatement
  const file = parseStudyFile(text);
  if (file === null) throw new StudyFileError("study_file_broken");
  if (file.version > STUDY_VERSION) throw new StudyFileError("study_file_version");
  return file;
}

/**
 * Whether a direction's directory is still a real directory right under the learning directory.
 *
 * @remarks
 * Asked before each change (security.md, "学习方向"): a directory swapped for a link after the
 * scan would have the change read and written wherever the link points. It must be no link, and
 * its parent's real path the learning directory's.
 *
 * @sideEffects Looks at the directory and the learning directory.
 * @param dir - The direction's directory.
 * @param root - The learning directory.
 * @throws {StudyFileError} `learning_dir_unsafe`.
 */
async function checkPlace(dir: string, root: string): Promise<void> {
  const info = await lstat(dir).catch(() => null);
  // The directory itself is no link, so its real path is its parent's and its own name.
  // Stryker disable next-line ArrowFunction,StringLiteral: a missing parent only comes with a missing directory, refused already.
  const parent = await realpath(dirname(dir)).catch(() => "");
  // Stryker disable next-line ArrowFunction: as above; the learning directory holds the direction.
  const realRoot = await realpath(root).catch(() => null);
  if (info?.isDirectory() !== true || parent !== realRoot) throw new StudyFileError("learning_dir_unsafe");
}

/**
 * Creates the progress files' writer.
 *
 * @remarks
 * SPEC-0008, "ML2 定的细节": each change first checks the direction's directory is still a real
 * one right under the learning directory (`learning_dir_unsafe`), then reads the file again, so
 * the agent's tools, your marks and an edit by hand meanwhile all count; the change is checked to
 * read back as it would be read, and to be no larger than a read takes (`study_file_too_large`),
 * written to a temporary file in the same directory, made new (`wx`, so nothing there is
 * replaced) and owned from then on, and renamed over the marker, which replaces the marker and
 * nothing it might point at. A failure removes the temporary file and leaves the marker as it
 * was; it is logged by code only. Changes to one direction go one at a time; a refused one does
 * not hold up the next. An archive holds the direction: it waits for the changes before it, and
 * changes asked for while it runs are refused as `direction_archived`. The directions' watch
 * sees the new file and scans.
 *
 * @sideEffects none until a change; then reads and writes markers and logs.
 * @param options - The learning directory, the temporary name's random part, and the logger.
 * @returns The writer.
 */
export function createProgressFiles(options: {
  readonly root: string;
  readonly random: () => string;
  readonly logger: Logger;
}): ProgressFiles {
  const turns = new Map<string, Promise<unknown>>();
  const going = new Set<Promise<unknown>>();
  const held = new Set<string>();

  /**
   * Writes a direction's file whole, through a temporary file.
   *
   * @remarks
   * See `createProgressFiles`.
   *
   * @sideEffects Creates, writes and renames a file; removes it on a failure; logs.
   * @param dir - The direction's directory.
   * @param file - What to write.
   * @throws {StudyFileError} `study_file_too_large` or `study_write_failed`.
   */
  async function write(dir: string, file: StudyFile): Promise<void> {
    const temporary = join(dir, `${MARKER}.${options.random()}.tmp`);
    let made = false;
    try {
      if (!StudyFile.safeParse(file).success) throw new StudyFileError("study_write_failed");
      const text = `${JSON.stringify(file, null, 2)}\n`;
      if (Buffer.byteLength(text) > MARKER_LIMIT) throw new StudyFileError("study_file_too_large");
      const handle = await open(temporary, "wx");
      // Created here, so removed on any failure from now on, even a write cut off halfway.
      made = true;
      try {
        await handle.writeFile(text);
        // Stryker disable BlockStatement: an open handle left behind is not seen by any test, only by the leak counts.
      } finally {
        await handle.close();
      }
      // Stryker restore BlockStatement
      await rename(temporary, join(dir, MARKER));
    } catch (error) {
      if (made) await rm(temporary).catch(() => undefined);
      const code = error instanceof StudyFileError ? error.code : errorCode(error);
      options.logger.warn({ code }, "study file not written");
      throw new StudyFileError(code === "study_file_too_large" ? code : "study_write_failed");
    }
  }

  /**
   * Runs work on a direction after the work asked for before it.
   *
   * @remarks
   * A failed one does not hold up the next; `close` waits for each.
   *
   * @sideEffects Runs the work.
   * @param dir - The direction's directory.
   * @param work - The work.
   * @returns Its result.
   */
  function inTurn<T>(dir: string, work: () => Promise<T>): Promise<T> {
    const turn = (turns.get(dir) ?? Promise.resolve()).then(work);
    const settled = turn.catch(() => undefined);
    turns.set(dir, settled);
    going.add(settled);
    // Fire and forget: only frees memory once the turn settles.
    // Stryker disable next-line all: only frees memory; a settled turn holds up nothing, and `close` waits for it at once.
    void settled.finally(() => {
      // Stryker disable all: see above.
      going.delete(settled);
      if (turns.get(dir) === settled) turns.delete(dir);
      // Stryker restore all
    });
    return turn;
  }

  return {
    update(dir, change) {
      if (held.has(dir)) return Promise.reject(new StudyFileError("direction_archived"));
      return inTurn(dir, async () => {
        await checkPlace(dir, options.root);
        const file = change(await readStudyFile(dir));
        await write(dir, file);
        return file;
      });
    },
    async hold(dir, task) {
      held.add(dir);
      try {
        return await inTurn(dir, task);
      } finally {
        held.delete(dir);
      }
    },
    async close() {
      await Promise.allSettled(going);
    },
  };
}
