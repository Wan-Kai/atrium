import { editCommand } from "@atrium/pi";
import { CommandError } from "@atrium/protocol";
import type { EntriesPage } from "../transcript/session-transcript";
import type { SessionPi } from "./session-controller";
import { createSessionLog } from "../transcript/session-log";

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
 * @param options - The protected pi, target, operation id and submission callbacks.
 * @returns That the replacement user is on file.
 * @throws {CommandError} `edit_failed` when navigation, submission or recovery failed.
 */
export async function editStoppedBranch(options: {
  readonly pi: Pick<SessionPi, "command" | "getEntries" | "readPersistedEntries" | "stop">;
  readonly entryId: string;
  readonly token: string;
  readonly send: () => Promise<"started" | "handled">;
  readonly onBranch: (page: EntriesPage) => void;
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
   * @param disk - Entries from the actual session file.
   * @returns Whether the replacement was committed.
   */
  function replaced(disk: EntriesPage): boolean {
    if (before === null) return false;
    const known = new Set(before.entries.map((entry) => entry.id));
    const branch = activeEntries(disk);
    return (
      !branch.some((entry) => entry.id === options.entryId) &&
      branch.some((entry) => entry.kind === "user" && !known.has(entry.id))
    );
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
    // Preflight answers before the user is appended; the next RPC read sees that synchronous append.
    await confirmed();
    if (!replaced(await readDisk())) throw new CommandError("edit_failed");
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
