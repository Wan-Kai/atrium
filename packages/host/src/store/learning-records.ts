import type { IndexFile } from "./index-file";
import { type LearningDocument, listedAlias } from "./index-schema";

/** What Atrium keeps of one direction; `null` where it keeps nothing. */
interface LearningRecord {
  readonly alias: string | null;
  readonly pinnedAt: number | null;
  readonly lastOpenedAt: number | null;
}

/** What Atrium keeps of learning directions: the names the user gave them, pins, and last openings. */
export interface LearningRecords {
  /** A direction's record, `null` fields for what is not kept. */
  of(directionId: string): LearningRecord;
  /** Names a direction, or with `null` forgets its name; writes only when that changes it. */
  rename(directionId: string, alias: string | null): Promise<void>;
  /**
   * Pins a direction at `at`.
   *
   * @remarks
   * An already pinned direction keeps its time, so pinning again writes nothing.
   */
  pin(directionId: string, at: number): Promise<void>;
  /** Unpins a direction; writes only when that changes it. */
  unpin(directionId: string): Promise<void>;
  /** Records that a client went into a direction at `at` (SPEC-0008, "入口"). */
  opened(directionId: string, at: number): Promise<void>;
}

/** The fields a change may set; `undefined` removes one. */
interface Change {
  readonly alias?: string | undefined;
  readonly pinnedAt?: number | undefined;
  readonly lastOpenedAt?: number | undefined;
}

/**
 * Creates the learning records over `learning.json`.
 *
 * @remarks
 * Shaped as `chats.json`'s records (SPEC-0008, "索引"): a direction with none of a name, a pin or
 * a last opening has no record. Archiving is not kept here: a direction is archived when its
 * directory is under `Archive/`. Whether the direction exists is the caller's to check, as
 * directions are found by their directories; the record of one whose directory went stays, a few
 * bytes naming nothing shown. Fields this Atrium does not know stay as they were.
 *
 * @sideEffects none until a change; then writes `learning.json`.
 * @param file - The loaded file.
 * @returns The records.
 */
export function createLearningRecords(file: IndexFile<LearningDocument>): LearningRecords {
  /**
   * Changes a direction's record, dropping it when nothing is left in it.
   *
   * @remarks
   * Writes only when the record changes.
   *
   * @sideEffects May write `learning.json`.
   * @param directionId - The direction.
   * @param change - The fields to set; `undefined` removes one.
   */
  async function update(directionId: string, change: Change): Promise<void> {
    const document = file.read();
    const before = document.directions.find((record) => record.id === directionId) ?? { id: directionId };
    const { alias, pinnedAt, lastOpenedAt } = { ...before, ...change };
    // Fields a newer Atrium wrote stay (`IndexFileSpec.schema`).
    const { alias: _alias, pinnedAt: _pinnedAt, lastOpenedAt: _lastOpenedAt, ...rest } = before;
    // Stryker disable ConditionalExpression: a field set to `undefined` is left out of the JSON all the same.
    const after = {
      ...rest,
      ...(alias === undefined ? {} : { alias }),
      ...(pinnedAt === undefined ? {} : { pinnedAt }),
      ...(lastOpenedAt === undefined ? {} : { lastOpenedAt }),
    };
    // Stryker restore ConditionalExpression
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    const others = document.directions.filter((record) => record.id !== directionId);
    // A record left with only its id goes; one with fields a newer Atrium wrote stays.
    const empty = Object.keys(after).length === 1;
    await file.save({ ...document, directions: empty ? others : [...others, after] });
  }

  /**
   * A direction's stored record, if it has one.
   *
   * @remarks
   * See `createLearningRecords`.
   *
   * @sideEffects none
   * @param directionId - The direction.
   * @returns The record.
   */
  const find = (directionId: string) => file.read().directions.find((record) => record.id === directionId);

  return {
    of(directionId) {
      const record = find(directionId);
      return {
        alias: listedAlias(record?.alias),
        pinnedAt: record?.pinnedAt ?? null,
        lastOpenedAt: record?.lastOpenedAt ?? null,
      };
    },
    rename: (directionId, alias) => update(directionId, { alias: alias ?? undefined }),
    // Pinning again keeps the first time, so a pinned direction does not jump around.
    pin: (directionId, at) => update(directionId, { pinnedAt: find(directionId)?.pinnedAt ?? at }),
    unpin: (directionId) => update(directionId, { pinnedAt: undefined }),
    opened: (directionId, at) => update(directionId, { lastOpenedAt: at }),
  };
}
