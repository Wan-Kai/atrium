import { absolutePathEntries, killProcessTree } from "@atrium/pi";
import { spawn } from "node:child_process";
import type { Clock } from "../platform/clock";
import type { ResourceTracker } from "../platform/resources";

/** A command an install job runs. */
export interface JobCommand {
  /** The program, by absolute path. */
  readonly file: string;
  readonly args: readonly string[];
  /** Written to standard input, which then closes; `null` closes it at once. */
  readonly input: string | null;
  readonly cwd: string;
  /** The login shell's environment. */
  readonly env: Readonly<Record<string, string>>;
}

/** How a job's command ended: it never started, or it exited (`null` when a signal ended it). */
export type JobEnd = { readonly started: false } | { readonly started: true; readonly exitCode: number | null };

/** How long a cancelled job has to go after SIGTERM before it is forced (SPEC-0001, "首次启动 · 接口"). */
const JOB_GRACE_MS = 3000;

/**
 * Does nothing.
 *
 * @remarks
 * Stands for a timer not set.
 *
 * @sideEffects none
 */
function nothing(): void {
  // Nothing to cancel.
}

/**
 * Runs an install job's command until it ends, passing on everything it writes.
 *
 * @remarks
 * The command leads a process group of its own (SPEC-0001, "首次启动 · 接口"). Cancelling sends
 * SIGTERM to the group; whatever is left after `graceMs` is force-killed with its whole tree. Once
 * the command exits, what it left in its group is killed too, and output still held open by a
 * process outside the group is waited for only `graceMs`. stdout and stderr go out together as
 * they arrive, decoded as UTF-8 so a character split between two writes stays whole. The output
 * is never logged. The command runs with its PATH made absolute, as git does.
 *
 * @sideEffects Runs the command; signals its process group and tree; counts the process as a
 * resource while it runs.
 * @param command - What to run.
 * @param options - The signal that cancels, where the output goes, the clock, the resource counts,
 * and how long cancelling waits before forcing.
 * @returns How the command ended; it does not reject.
 */
export function runJob(
  command: JobCommand,
  options: {
    readonly signal: AbortSignal;
    readonly onOutput: (text: string) => void;
    readonly clock: Clock;
    readonly resources: ResourceTracker;
    readonly graceMs?: number;
  },
): Promise<JobEnd> {
  const { signal, clock } = options;
  const graceMs = options.graceMs ?? JOB_GRACE_MS;
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ started: false });
      return;
    }
    const release = options.resources.acquire("install.process");
    const env = { ...command.env, PATH: absolutePathEntries(command.env["PATH"] ?? "") };
    const child = spawn(command.file, [...command.args], {
      cwd: command.cwd,
      env,
      detached: true,
      stdio: "pipe",
    });
    let started = false;
    let stopTimer = nothing;
    let forcing: Promise<void> = Promise.resolve();

    /**
     * Signals the command's process group.
     *
     * @remarks
     * A group already gone is fine.
     *
     * @sideEffects Signals the group.
     * @param name - The signal.
     */
    const signalGroup = (name: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, name);
      } catch {
        // Already gone.
      }
    };

    /**
     * Force-kills the command's tree and group.
     *
     * @remarks
     * The tree is read while the command is still there, so processes in other groups are found
     * too; a failure to read it still kills the group.
     *
     * @sideEffects Runs `ps`; sends SIGKILL.
     */
    const force = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      forcing = killProcessTree(pid)
        .catch(() => undefined)
        .then(() => signalGroup("SIGKILL"));
    };

    /**
     * Asks the command to stop, and forces it after the grace period.
     *
     * @remarks
     * A named listener, so it can be removed once the command has ended.
     *
     * @sideEffects Sends SIGTERM to the group; schedules the forced kill.
     */
    const onAbort = (): void => {
      signalGroup("SIGTERM");
      stopTimer = clock.setTimeout(force, graceMs);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", options.onOutput);
    child.stderr.on("data", options.onOutput);
    // A command that exits without reading its input closes the pipe; that is not a failure.
    child.stdin.on("error", () => undefined);
    // Without input, standard input is closed at once, so nothing waits on it.
    child.stdin.end(command.input);
    child.once("spawn", () => {
      started = true;
    });
    // A command that cannot start reports it here, then closes.
    child.once("error", () => undefined);
    child.once("exit", () => {
      signalGroup("SIGKILL");
      stopTimer();
      // Output held by a process outside the group would keep the job open forever.
      stopTimer = clock.setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, graceMs);
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      stopTimer();
      resolve(
        forcing.then(() => {
          release();
          return started ? { started: true, exitCode: code } : { started: false };
        }),
      );
    });
  });
}
