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
