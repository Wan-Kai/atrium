import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** One row of the process table. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
}

/**
 * Parses `ps -A -o pid=,ppid=,pgid=` output.
 *
 * @remarks
 * Rows that do not hold three numbers are skipped rather than failing the whole kill.
 *
 * @sideEffects none
 * @param output - The command's stdout.
 * @returns The rows.
 */
export function parseProcessTable(output: string): ProcessRow[] {
  return output.split("\n").flatMap((line) => {
    const match = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(line.trim());
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) }];
  });
}

/**
 * Finds every descendant of `root`, following parent links.
 *
 * @remarks
 * Parent links, not process groups: pi starts each bash tool command in its own process group
 * (pi-internals.md §3 "退出"), so the group of pi alone misses them.
 *
 * @sideEffects none
 * @param table - The process table.
 * @param root - The process whose descendants to find.
 * @returns The descendants, without `root` itself.
 */
export function descendantsOf(table: readonly ProcessRow[], root: number): ProcessRow[] {
  const children = Map.groupBy(table, (row) => row.ppid);
  const found: ProcessRow[] = [];
  const queue = [root];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const child of children.get(parent) ?? []) {
      if (child.pid === root || found.includes(child)) continue;
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/** What `killProcessTree` needs from the operating system; tests pass a recording fake. */
export interface ProcessSystem {
  /** Output of `ps -A -o pid=,ppid=,pgid=`. */
  listProcesses(): Promise<string>;
  /** Sends SIGKILL to a pid, or to a process group when negative. */
  kill(target: number): void;
  /** Pid of the calling process. */
  readonly ownPid: number;
}

/** The real operating system. */
const realSystem: ProcessSystem = {
  listProcesses: async () => (await run("ps", ["-A", "-o", "pid=,ppid=,pgid="])).stdout,
  kill: (target) => process.kill(target, "SIGKILL"),
  ownPid: process.pid,
};

/**
 * Sends SIGKILL and ignores a process that is already gone.
 *
 * @remarks
 * Killing races with processes exiting on their own; ESRCH is the expected outcome then. Any other
 * failure, such as EPERM, is a real problem and is passed on.
 *
 * @sideEffects Signals a process or process group.
 * @param system - The operating system.
 * @param target - A pid, or a negated process group id.
 * @throws {Error} For any failure other than ESRCH.
 */
function killQuietly(system: ProcessSystem, target: number): void {
  try {
    system.kill(target);
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, "code") === "ESRCH")) throw error;
  }
}

/**
 * Force-kills a process, all its descendants, and every process group they lead.
 *
 * @remarks
 * Used only after closing stdin and SIGTERM both failed (roadmap M1.2). The tree is read while
 * `pid` is still alive, because once it dies its children are reparented to launchd and can no
 * longer be found. `pid` must lead its own process group (spawned with `detached: true`). The
 * caller's own process group, and groups 0 and 1, are never signalled, whatever the table says:
 * `kill(-0)` would hit the caller's group and `kill(-1)` every process the user owns.
 *
 * @sideEffects Runs `ps`; sends SIGKILL to processes and process groups.
 * @param pid - The process to kill, which leads its own process group.
 * @param system - The operating system; tests pass a fake.
 * @throws {Error} When `ps` fails or a signal fails for a reason other than the process being gone.
 */
export async function killProcessTree(pid: number, system: ProcessSystem = realSystem): Promise<void> {
  const table = parseProcessTable(await system.listProcesses());
  const descendants = descendantsOf(table, pid);
  const ownGroup = table.find((row) => row.pid === system.ownPid)?.pgid;
  const groups = new Set([pid, ...descendants.map((row) => row.pgid)]);
  for (const group of groups) if (group > 1 && group !== ownGroup) killQuietly(system, -group);
  for (const row of descendants) killQuietly(system, row.pid);
}
