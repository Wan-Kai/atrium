import {
  CommandError,
  type CommandResult,
  type Direction,
  type ModelRef,
  type SessionStudy,
  type SessionSummary,
} from "@atrium/protocol";
import { lstat, mkdir, realpath, rename, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Clock } from "../platform/clock";
import { errorCode } from "../platform/errors";
import type { Logger } from "../platform/logger";
import type { SessionManager } from "../sessions/session-manager";
import type { LearningRecords } from "../store/learning-records";
import type { DirectionCreator } from "./direction-creator";
import type { DirectionNamer } from "./direction-namer";
import { ARCHIVE, type Directions, type FoundDirection, realDir } from "./directions";
import type { StudyFile } from "./progress";
import { StudyFileError, type ProgressFiles } from "./progress-file";
import { type StepMark, StudyRuleError, markGap, markStep, nextOf } from "./progress-rules";

/** The study commands the server hands on, and what the list and the host need of directions. */
export interface StudyCommands {
  /** Names and makes a direction from its first message, with a discussion session opened as the client's active tab. */
  createDirection(clientId: string, text: string, model: ModelRef | null): Promise<CommandResult<"create_direction">>;
  /** Names a direction, or with `null` goes back to its own display name. */
  renameDirection(directionId: string, name: string | null): Promise<CommandResult<"rename_direction">>;
  pinDirection(directionId: string): Promise<CommandResult<"pin_direction">>;
  unpinDirection(directionId: string): Promise<CommandResult<"unpin_direction">>;
  /** Stops a direction's sessions and moves its directory under `Archive/`. */
  archiveDirection(directionId: string): Promise<CommandResult<"archive_direction">>;
  /** Moves an archived direction's directory back where it was. */
  restoreDirection(directionId: string): Promise<CommandResult<"restore_direction">>;
  /**
   * Opens a session for a use at a level and step, as the step strip's button does (SPEC-0008,
   * "ML2 定的细节"); only the one the next step offers.
   */
  startStudySession(
    clientId: string,
    directionId: string,
    study: SessionStudy,
  ): Promise<CommandResult<"start_study_session">>;
  /** Marks a step's part done by hand, or takes a manual mark back (SPEC-0008, "手动标完成"). */
  markStudyStep(
    directionId: string,
    level: string,
    step: string,
    mark: StepMark,
    done: boolean,
  ): Promise<CommandResult<"mark_study_step">>;
  /** Marks a gap fixed by hand, or takes that back. */
  markStudyGap(directionId: string, gapId: string, fixed: boolean): Promise<CommandResult<"mark_study_gap">>;
  /** The directions as the list shows them, with their progress and next step. */
  list(): Direction[];
  /** A client went into a container; for a direction, it is the one opened last (SPEC-0008, "入口"). */
  entered(containerId: string | null): void;
  /** Calls off naming under way and waits for what is going on. */
  close(): Promise<void>;
}

/**
 * Makes a directory there unless something is, without minding one made meanwhile.
 *
 * @remarks
 * For `Archive/`, which the first archive makes.
 *
 * @sideEffects Makes the directory.
 * @param path - The directory.
 */
async function ensureDir(path: string): Promise<void> {
  await mkdir(path).catch((error: unknown) => {
    if (errorCode(error) !== "EEXIST") throw error;
  });
}

/**
 * The next step of a direction, from its progress and its sessions.
 *
 * @remarks
 * SPEC-0008, "下一步怎么算"; worked out each time the list is built.
 *
 * @sideEffects none
 * @param found - The direction.
 * @param sessions - Every session's summary.
 * @returns The two buttons.
 */
function nextFor(found: FoundDirection, sessions: readonly SessionSummary[]) {
  return nextOf(
    found.progress,
    sessions.filter((session) => session.containerId === found.id),
    { archived: found.archived, broken: found.broken, newer: found.newer },
  );
}

/**
 * Creates the study commands.
 *
 * @remarks
 * SPEC-0008 ("方向是一种新容器", "新建方向", "ML1 定的细节"):
 * - creating names the direction (`DirectionNamer`), makes its directory (`DirectionCreator`),
 *   lists it at once, starts watching the learning directory, and creates a discussion session
 *   in it; the first message goes there from the client;
 * - archiving stops the direction's sessions and keeps new ones out, moves its directory under
 *   `Archive/`, and drops its tabs from every layout; restoring moves it back. Archiving onto a
 *   name taken under `Archive/` is refused as `study_archive_conflict` before anything is stopped;
 *   restoring onto something where it was, as `study_restore_conflict`. Nothing is copied or
 *   removed. A direction's archive and restore go one at a time; archiving one archived, or
 *   restoring one that is not, does nothing;
 * - nothing is made or moved through a learning directory or `Archive/` that is a link
 *   (`learning_dir_unsafe`, security.md, "学习方向"). A move first claims its place by making an
 *   empty directory there, which fails if anything is there; `rename` then only replaces that
 *   empty directory, and fails if something was put into it meanwhile. Node cannot rename without
 *   replacing (macOS's `renamex_np` with `RENAME_EXCL`), so the claim is what keeps a move from
 *   putting a directory over another's; the most a race can replace is an empty directory made in
 *   place of the claim. The claim's parent is checked to be where it should be, links resolved;
 * - making a directory and moving one go one at a time, so a new direction never takes a name
 *   while an archive or restore of that name is under way;
 * - a direction made whose discussion could not be created is still given (`sessionId` `null`),
 *   so the client goes into it rather than making another;
 * - names, pins and the last opening go to `learning.json`; a direction is found by its directory,
 *   so one gone is `direction_not_found`.
 * Changes reach clients through `changed`; failures are logged by direction id and category only.
 *
 * @sideEffects none until a command arrives; then names, makes and moves directories, writes
 * `learning.json`, creates sessions and stops pi.
 * @param options - The directions, the namer and creator, the records, the session manager, the
 * clock, what to tell of a change, the logger, and how to move a directory.
 * @returns The commands.
 */
export function createStudyCommands(options: {
  readonly directions: Directions;
  readonly namer: Pick<DirectionNamer, "name" | "close">;
  readonly creator: DirectionCreator;
  readonly records: LearningRecords;
  readonly sessions: Pick<
    SessionManager,
    "createStudySession" | "startStudySession" | "stopContainer" | "releaseContainer" | "forgetWorkspaces" | "summaries"
  >;
  /** Writes directions' progress (SPEC-0008, "ML2 定的细节"). */
  readonly files: Pick<ProgressFiles, "update" | "hold">;
  readonly clock: Pick<Clock, "now">;
  readonly changed: () => void;
  readonly logger: Logger;
  /** Moves a directory; `rename` from `node:fs/promises` unless a test steps in. */
  readonly rename?: (from: string, to: string) => Promise<void>;
}): StudyCommands {
  const move = options.rename ?? rename;
  const turns = new Map<string, Promise<unknown>>();
  /** The making or moving of a directory under way, which the next waits for. */
  let disk: Promise<unknown> = Promise.resolve();
  const going = new Set<Promise<unknown>>();
  const closing = new AbortController();

  /**
   * Runs a direction's archive, restore or session start after the one asked for before it.
   *
   * @remarks
   * Archive and restore move its directory; one starting before the other ended would look at the
   * wrong place. A start asks for the next step in turn, so two at once never open two sessions
   * for one step, and none opens in a direction being archived. A failed one does not hold up
   * the next.
   *
   * @sideEffects Runs `work` once the direction's earlier one is done.
   * @param directionId - The direction.
   * @param work - The archive, restore or start.
   * @returns What `work` returns.
   */
  async function inTurn<T>(directionId: string, work: () => Promise<T>): Promise<T> {
    const turn = (turns.get(directionId) ?? Promise.resolve()).then(work);
    const settled = turn.catch(() => undefined);
    turns.set(directionId, settled);
    going.add(settled);
    try {
      return await turn;
    } finally {
      // Stryker disable next-line BlockStatement: only frees memory; `close` waits for a settled turn at once.
      going.delete(settled);
      // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: only frees memory; a settled turn holds up nothing.
      if (turns.get(directionId) === settled) turns.delete(directionId);
    }
  }

  /**
   * Runs the making or moving of a directory after the one under way.
   *
   * @remarks
   * See `createStudyCommands`. A failed one does not hold up the next.
   *
   * @sideEffects Runs `work` once the earlier one is done.
   * @param work - The making or moving.
   * @returns What `work` returns.
   */
  async function onDisk<T>(work: () => Promise<T>): Promise<T> {
    const turn = disk.then(work);
    disk = turn.catch(() => undefined);
    return turn;
  }

  /**
   * A direction there is, archived or not.
   *
   * @remarks
   * Found by its directory (`Directions`).
   *
   * @sideEffects none
   * @param directionId - The direction.
   * @returns The direction.
   * @throws {CommandError} `direction_not_found`.
   */
  function directionOf(directionId: string): FoundDirection {
    const found = options.directions.find(directionId);
    if (found === undefined) throw new CommandError("direction_not_found", { directionId });
    return found;
  }

  /**
   * Logs a move refused for its place, and builds its error.
   *
   * @remarks
   * Only the direction id and which way it would have moved go to the log.
   *
   * @sideEffects Logs.
   * @param found - The direction.
   * @returns The error.
   */
  function taken(found: FoundDirection): CommandError {
    const archiving = !found.archived;
    options.logger.info({ directionId: found.id, archiving }, "direction not moved: place taken");
    return new CommandError(archiving ? "study_archive_conflict" : "study_restore_conflict", { directionId: found.id });
  }

  /**
   * Where a direction moves, after checking the learning directory and `Archive/` are no links.
   *
   * @remarks
   * See `createStudyCommands`; asked before anything is stopped, and again just before the move.
   *
   * @sideEffects Looks at the learning directory, `Archive/` and the place.
   * @param found - The direction.
   * @returns Where it goes.
   * @throws {CommandError} `learning_dir_unsafe`, or the conflict when the place is taken.
   */
  async function placeOf(found: FoundDirection): Promise<string> {
    const archive = join(options.directions.root, ARCHIVE);
    const archiveThere = (await lstat(archive).catch(() => null)) !== null;
    if (!(await realDir(options.directions.root)) || (archiveThere && !(await realDir(archive)))) {
      throw new CommandError("learning_dir_unsafe");
    }
    const to = found.archived ? found.home : join(archive, found.dirName);
    if ((await lstat(to).catch(() => null)) !== null) throw taken(found);
    return to;
  }

  /**
   * Moves a direction's directory, then looks at the learning directory again.
   *
   * @remarks
   * See `createStudyCommands`: the place is claimed with an empty directory first, its parent
   * checked, and the claim taken back when the move fails. A failure other than the place is
   * logged by its code only.
   *
   * @sideEffects Makes `Archive/` when needed; makes and maybe removes the claim; renames the
   * directory; scans; logs.
   * @param found - The direction.
   * @throws {CommandError} `learning_dir_unsafe`, the conflict, or `study_move_failed`.
   */
  async function moveDir(found: FoundDirection): Promise<void> {
    const archiving = !found.archived;
    try {
      await ensureDir(join(options.directions.root, ARCHIVE));
      const to = await placeOf(found);
      try {
        await mkdir(to);
      } catch (error) {
        if (errorCode(error) === "EEXIST") throw taken(found);
        throw error;
      }
      if ((await realpath(dirname(to))) !== dirname(to)) {
        await rmdir(to).catch(() => undefined);
        throw new CommandError("learning_dir_unsafe");
      }
      try {
        await move(found.dir, to);
      } catch (error) {
        // Only the empty claim goes; something put into it stays.
        await rmdir(to).catch(() => undefined);
        const code = errorCode(error);
        if (code === "ENOTEMPTY" || code === "EEXIST") throw taken(found);
        throw error;
      }
    } catch (error) {
      if (error instanceof CommandError) throw error;
      options.logger.warn({ directionId: found.id, archiving, code: errorCode(error) }, "direction not moved");
      throw new CommandError("study_move_failed", { directionId: found.id });
    } finally {
      await options.directions.scan();
    }
  }

  /**
   * Records a client going into a direction.
   *
   * @remarks
   * Fire and forget for the layout command that took it there; a failed write is logged.
   *
   * @sideEffects Writes `learning.json`; tells of the change; may log.
   * @param directionId - The direction.
   */
  function opened(directionId: string): void {
    const write = options.records.opened(directionId, options.clock.now()).then(
      () => options.changed(),
      (error: unknown) =>
        options.logger.warn({ directionId, code: errorCode(error) }, "direction opening not recorded"),
    );
    going.add(write);
    // Fire and forget: `close` waits for it through `going`.
    // Stryker disable next-line ArrowFunction: only frees memory; `close` waits for a settled write at once.
    void write.finally(() => going.delete(write));
  }

  /**
   * Changes a direction's progress by hand, then lists it again.
   *
   * @remarks
   * An archived direction is not written (`direction_archived`); the rules' and the writer's
   * refusals are the command's error codes, with nothing written.
   *
   * @sideEffects Writes the direction's marker; scans; tells of the change.
   * @param directionId - The direction.
   * @param change - The change.
   * @throws {CommandError} As above, or `direction_not_found`.
   */
  async function changeProgress(directionId: string, change: (file: StudyFile) => StudyFile): Promise<void> {
    const found = directionOf(directionId);
    if (found.archived) throw new CommandError("direction_archived", { directionId });
    try {
      await options.files.update(found.dir, change);
    } catch (error) {
      if (error instanceof StudyRuleError || error instanceof StudyFileError) {
        options.logger.info({ directionId, code: error.code }, "study mark refused");
        // A mark is refused only as not found or not allowed by the rules.
        const code =
          error instanceof StudyFileError
            ? error.code
            : error.code === "study_not_found"
              ? "study_not_found"
              : "study_mark_refused";
        throw new CommandError(code, code === "direction_archived" ? { directionId } : {});
      }
      throw error;
    }
    await options.directions.scan();
    options.changed();
  }

  return {
    async createDirection(clientId, text, model) {
      const work = (async () => {
        const names = await options.namer.name(text, model, closing.signal);
        // Closed while naming: nothing is made any more.
        if (closing.signal.aborted) throw new CommandError("direction_create_failed");
        const found = await onDisk(() => options.creator.make(names, text));
        options.directions.added(found);
        options.directions.watch();
        try {
          const { sessionId } = await options.sessions.createStudySession(clientId, found.id, { kind: "discuss" });
          return { directionId: found.id, sessionId };
        } catch (error) {
          options.logger.warn(
            { directionId: found.id, code: error instanceof CommandError ? error.code : errorCode(error) },
            "direction discussion not created",
          );
          return { directionId: found.id, sessionId: null };
        }
      })();
      const settled = work.catch(() => undefined);
      going.add(settled);
      try {
        return await work;
      } finally {
        // Stryker disable next-line BlockStatement: only frees memory; `close` waits for a settled one at once.
        going.delete(settled);
      }
    },
    async renameDirection(directionId, name) {
      directionOf(directionId);
      await options.records.rename(directionId, name);
      options.changed();
      return {};
    },
    async pinDirection(directionId) {
      directionOf(directionId);
      await options.records.pin(directionId, options.clock.now());
      options.changed();
      return {};
    },
    async unpinDirection(directionId) {
      directionOf(directionId);
      await options.records.unpin(directionId);
      options.changed();
      return {};
    },
    async archiveDirection(directionId) {
      await inTurn(directionId, async () => {
        const found = directionOf(directionId);
        if (found.archived) return;
        // A place taken, or a link, refuses it before any session is stopped.
        await placeOf(found);
        // The progress written before it first; none from now on, so no temporary file is moved
        // along and no change lands in the old place (SPEC-0008, "ML2 定的细节").
        await options.files.hold(found.dir, async () => {
          await options.sessions.stopContainer(directionId);
          try {
            await onDisk(() => moveDir(found));
            await options.sessions.forgetWorkspaces([directionId]);
          } finally {
            options.sessions.releaseContainer(directionId);
          }
        });
      });
      return {};
    },
    async restoreDirection(directionId) {
      await inTurn(directionId, async () => {
        const found = directionOf(directionId);
        if (!found.archived) return;
        await onDisk(() => moveDir(found));
      });
      return {};
    },
    startStudySession(clientId, directionId, study) {
      // One at a time with each other and with archiving, the next step asked again in turn, so
      // two presses at once never open two sessions for one step.
      return inTurn(directionId, async () => {
        const found = directionOf(directionId);
        if (found.archived) throw new CommandError("direction_archived", { directionId });
        if (found.newer) throw new CommandError("study_file_version");
        const { primary } = nextFor(found, options.sessions.summaries());
        // Only what the strip offers now: no second session for a step, none ML2 cannot open yet.
        if (
          primary?.type !== "start" ||
          !primary.available ||
          primary.kind !== study.kind ||
          primary.level !== study.level ||
          primary.step !== study.step ||
          primary.gap !== study.gap
        ) {
          throw new CommandError("study_not_available", { directionId });
        }
        return options.sessions.startStudySession(clientId, directionId, study);
      });
    },
    async markStudyStep(directionId, level, step, mark, done) {
      await changeProgress(directionId, (file) => markStep(file, level, step, mark, done));
      return {};
    },
    async markStudyGap(directionId, gapId, fixed) {
      await changeProgress(directionId, (file) => markGap(file, gapId, fixed));
      return {};
    },
    list() {
      const sessions = options.sessions.summaries();
      return options.directions.list().map((found) => {
        const record = options.records.of(found.id);
        return {
          id: found.id,
          dir: found.dir,
          name: found.name ?? found.dirName,
          alias: record.alias,
          broken: found.broken,
          newer: found.newer,
          discussing: found.discussing,
          archived: found.archived,
          createdAt: found.createdAt,
          pinnedAt: record.pinnedAt,
          lastOpenedAt: record.lastOpenedAt,
          progress: found.progress,
          next: nextFor(found, sessions),
        };
      });
    },
    entered(containerId) {
      // Only a direction is found by `Directions`; an archived one is looked at, not gone on with.
      if (containerId === null || options.directions.find(containerId)?.archived !== false) return;
      opened(containerId);
    },
    async close() {
      closing.abort();
      await options.namer.close();
      await Promise.allSettled(going);
    },
  };
}
