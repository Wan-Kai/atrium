import { execFile } from "node:child_process";

/** Runs `ps` and returns its stdout; swapped in tests. */
type ProcessTable = () => Promise<string>;

/** What a terminal's process table query needs. */
export interface ChildrenOptions {
  /** Reads the whole table; `ps -axo pid=,ppid=` by default. */
  readonly table?: ProcessTable;
  /** How long `ps` may take before the query counts as failed. */
  readonly timeoutMs?: number;
}

/**
 * Reads every pid and its parent from `ps`.
 *
 * @remarks
 * One query per question, like T3's idle check: cheap on macOS, and the host asks only when a
 * terminal is being closed. A terminal with no children is an idle shell.
 *
 * @sideEffects Runs a child process.
 * @param timeoutMs - How long `ps` may take.
 * @returns The table's text.
 */
function readProcessTable(timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-axo", "pid=,ppid="], { timeout: timeoutMs }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * The pids whose parent is `pid`.
 *
 * @remarks
 * The program a shell is running is its child, so a non-empty answer means something is still
 * running in the terminal and closing it deserves a question (SPEC-0009, "生命周期").
 *
 * @sideEffects Runs `ps` unless a table is given.
 * @param pid - The shell's pid.
 * @param options - Where to read the table from.
 * @returns The children's pids, in the order `ps` printed them.
 * @throws When the table cannot be read; callers treat that as "there is something running".
 */
export async function childPidsOf(pid: number, options: ChildrenOptions = {}): Promise<readonly number[]> {
  const table = await (options.table ?? (() => readProcessTable(options.timeoutMs)))();
  const children: number[] = [];
  for (const line of table.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/);
    if (child === undefined || parent === undefined) continue;
    if (Number(parent) === pid) children.push(Number(child));
  }
  return children;
}

/** The most descendants one close will walk; a fork bomb cannot make it run forever. */
const MAX_TREE = 200;

/**
 * Every process under `pid`, deepest list first.
 *
 * @remarks
 * A shell's background jobs go into process groups of their own under job control, so signalling
 * the shell's group leaves them running (measured 2026-11-16). Walking the tree is what reaches
 * them (SPEC-0009, "生命周期").
 *
 * @sideEffects Reads the process table once per level.
 * @param pid - The shell's pid.
 * @param options - Where to read the table from.
 * @returns The descendants' pids; empty when there are none.
 */
export async function descendantsOf(pid: number, options: ChildrenOptions = {}): Promise<readonly number[]> {
  const table = await (options.table ?? (() => readProcessTable(options.timeoutMs)))();
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/u);
    if (child === undefined || parent === undefined) continue;
    const parentPid = Number(parent);
    const childPid = Number(child);
    if (!Number.isInteger(parentPid) || !Number.isInteger(childPid)) continue;
    const known = children.get(parentPid) ?? [];
    known.push(childPid);
    children.set(parentPid, known);
  }
  const found: number[] = [];
  /**
   * Collects one process's children, then theirs.
   *
   * @remarks
   * Depth-first, capped at {@link MAX_TREE}, so a wide or deep tree cannot stall a close.
   *
   * @sideEffects Adds to `found`.
   * @param from - The pid to walk from.
   */
  const walk = (from: number): void => {
    for (const child of children.get(from) ?? []) {
      if (found.length >= MAX_TREE) return;
      if (found.includes(child)) continue;
      found.push(child);
      walk(child);
    }
  };
  walk(pid);
  return found;
}
