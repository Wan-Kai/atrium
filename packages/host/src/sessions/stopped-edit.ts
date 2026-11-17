import { editCommand } from "@atrium/pi";
import { CommandError } from "@atrium/protocol";
import type { EntriesPage } from "../transcript/session-transcript";
import type { SessionPi } from "./session-controller";
import { createSessionLog } from "../transcript/session-log";

/** How long the session file is looked at again for the replacement, and how often. */
const REPLACEMENT_GAP_MS = 100;
const REPLACEMENT_ATTEMPTS = 20;

/**
 * Waits a moment before looking again.
 *
 * @remarks
 * The default for `editStoppedBranch`; tests replace it with no wait.
 *
 * @sideEffects Starts a timer.
 * @param ms - How long.
 * @returns When it passed.
 */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Whether pi holds entries the file does not have.
 *
 * @remarks
 * An append that failed to persist leaves them, which must not be added to.
 *
 * @sideEffects none
 * @param live - pi's entries.
 * @param disk - The file's entries.
 * @returns Whether any is in memory only.
 */
function hasUnwritten(live: EntriesPage, disk: EntriesPage): boolean {
  const ids = new Set(disk.entries.map((entry) => entry.id));
  return live.entries.some((entry) => !ids.has(entry.id));
}

/**
 * Reads only the active path of a complete pi entry page.
 * @remarks Old branches remain on file and cannot prove that a replacement was accepted.
 * @sideEffects none
 * @param page - The entries and authoritative leaf.
 * @returns The active path.
 */
function activeEntries(page: EntriesPage) {
  const log = createSessionLog();
  log.append(page.entries, page.leafId);
  return log.branch();
}

/**
 * Rewinds a stopped user message and commits its replacement, or restores the old branch.
 * @remarks pi updates memory before appending to disk: `handled`, echoed messages and
 * `get_entries` alone cannot prove persistence after ENOSPC/EIO. Each navigation is checked
 * against the real file; only a new on-disk user outside the old branch proves acceptance.
 * Internal stage error text is deliberately discarded: the outer boundary always returns
 * `edit_failed`, so changing an inner error string is externally equivalent.
 * @sideEffects Calls pi, reads its session file, changes branches, publishes snapshots and stops
 * pi if its in-memory branch cannot safely be used (SPEC-0001, stopped-message editing).
 * @param options - The protected pi, target, operation id, submission callbacks and how to wait.
 * @returns That the replacement user is on file.
 * @throws {CommandError} `edit_failed` when navigation, submission or recovery failed.
 */
export async function editStoppedBranch(options: {
  readonly pi: Pick<SessionPi, "command" | "getEntries" | "readPersistedEntries" | "stop">;
  readonly entryId: string;
  readonly token: string;
  readonly send: () => Promise<"started" | "handled">;
  readonly onBranch: (page: EntriesPage) => void;
  /** How to wait between looks at the session file; without it, 50 ms at a time. */
  readonly wait?: (ms: number) => Promise<void>;
}): Promise<{ readonly disposition: "started" }> {
  let before: EntriesPage | null = null;
  let attempted = false;
  let unsafe = false;
  let lastDisk: EntriesPage | null = null;
  /**
   * Keeps the last successful disk read for failure recovery.
   * @remarks A subsequent read or dead pi must not leave viewers on the temporary memory leaf.
   * @sideEffects Reads the file and retains its page until this operation ends.
   * @returns The actual persisted entries and leaf.
   */
  async function readDisk(): Promise<EntriesPage> {
    const page = await options.pi.readPersistedEntries();
    lastDisk = page;
    return page;
  }
  /**
   * Checks that every in-memory entry has actually reached the file.
   * @remarks A moved leaf need not be persisted, but a missing ancestor must never receive children.
   * @sideEffects Calls pi and reads its file.
   * @returns pi's authoritative active branch.
   * @throws When a read fails or pi retained an entry whose append failed.
   */
  async function confirmed(): Promise<EntriesPage> {
    const live = await options.pi.getEntries(undefined);
    const disk = await readDisk();
    const ids = new Set(disk.entries.map((entry) => entry.id));
    if (live.entries.some((entry) => !ids.has(entry.id))) {
      unsafe = true;
      throw new CommandError("edit_failed");
    }
    return live;
  }
  /**
   * Recognizes a committed replacement without relying on a possibly lost response or echo.
   * @remarks It must be a fresh user on a path that excludes the original user, not an append.
   * @sideEffects none
   * @param page - Entries from the actual session file, or from pi.
   * @returns Whether the replacement was committed.
   */
  function replaced(page: EntriesPage): boolean {
    if (before === null) return false;
    const known = new Set(before.entries.map((entry) => entry.id));
    const branch = activeEntries(page);
    return (
      !branch.some((entry) => entry.id === options.entryId) &&
      branch.some((entry) => entry.kind === "user" && !known.has(entry.id))
    );
  }
  /**
   * Waits for pi's replacement to reach the session file.
   *
   * @remarks
   * A prompt's answer does not wait for the user's entry: pi appends it after the response, and
   * the file may trail its memory. Only a new user on disk, outside the old branch, counts.
   * Nothing appended within the wait is a refusal, which the caller restores; anything in memory
   * the file still does not have is unsafe, as for any other append that failed to persist.
   *
   * @sideEffects Calls pi and reads its file; may mark the session's branch unsafe.
   * @returns The page proving the replacement on disk, or `null` when it did not come.
   */
  async function settled(): Promise<EntriesPage | null> {
    const wait = options.wait ?? pause;
    const live = await options.pi.getEntries(undefined);
    let disk = await readDisk();
    for (let attempt = 0; !replaced(disk) && attempt < REPLACEMENT_ATTEMPTS; attempt += 1) {
      await wait(REPLACEMENT_GAP_MS);
      disk = await readDisk();
    }
    if (!replaced(disk)) {
      unsafe = hasUnwritten(live, disk);
      return null;
    }
    // The file has the replacement; nothing else of pi's may still be only in its memory.
    unsafe = hasUnwritten(live, disk);
    return unsafe ? null : disk;
  }
  try {
    before = await confirmed();
    const branch = activeEntries(before);
    const target = branch.find((entry) => entry.id === options.entryId);
    const lastInput = branch.findLast((entry) => entry.kind === "user" || entry.kind === "agent");
    if (target?.kind !== "user" || lastInput?.id !== target.id) throw new CommandError("edit_failed");
    attempted = true;
    await options.pi.command(
      editCommand({ action: "rewind", token: options.token, entryId: target.id, leafId: before.leafId }),
    );
    const after = await confirmed();
    if (after.leafId !== target.parentId) throw new CommandError("edit_failed");
    options.onBranch(after);
    if ((await options.send()) !== "started") throw new CommandError("edit_failed");
    // pi answers before it appends the user, and its file may trail its memory: wait for both.
    if ((await settled()) === null) throw new CommandError("edit_failed");
    return { disposition: "started" };
  } catch {
    try {
      const disk = await readDisk();
      if (unsafe) {
        await options.pi.stop();
        options.onBranch(disk);
      }
      if (replaced(disk)) {
        if (!unsafe) {
          try {
            await confirmed();
          } catch {
            await options.pi.stop();
            options.onBranch(disk);
          }
        }
        return { disposition: "started" };
      }
      // `attempted` is set only after `before` is read and validated; keep the null check for narrowing.
      if (!unsafe && attempted && before !== null) {
        const previousLeaf = before.leafId;
        let current = await confirmed();
        if (!activeEntries(current).some((entry) => entry.id === previousLeaf)) {
          await options.pi.command(editCommand({ action: "restore", token: options.token }));
          current = await confirmed();
          if (!activeEntries(current).some((entry) => entry.id === previousLeaf)) throw new CommandError("edit_failed");
        }
        options.onBranch(current);
      }
    } catch {
      // No further write may use an uncertain leaf; show the last disk proof even when pi is gone.
      await options.pi.stop();
      if (lastDisk !== null) options.onBranch(lastDisk);
    }
    throw new CommandError("edit_failed");
  }
}
