import { CommandError, type InstallKind, type InstallOutputEvent, type InstallUpdatedEvent } from "@atrium/protocol";
import type { Logger } from "../platform/logger";
import type { JobCommand, JobEnd } from "./install-job";
import { DownloadError } from "./install-script";
import type { HostTools, Toolbox } from "./toolbox";

/** Installing and updating pi and Node, as the commands ask (SPEC-0001, "首次启动 · 接口"). */
export interface InstallService {
  /**
   * Starts a job.
   *
   * @throws {CommandError} `install_busy` while another job is under way; `install_unavailable`
   * when the job's tool is missing.
   */
  start(kind: InstallKind): Promise<{ jobId: string }>;
  /**
   * Cancels the job under way.
   *
   * @throws {CommandError} `install_not_found` when `jobId` is not the job under way.
   */
  cancel(jobId: string): void;
  /**
   * Resolves once no update of pi is running.
   *
   * @remarks
   * A session starting pi waits for it, so it starts the new pi (SPEC-0001, "首次启动 · 接口").
   */
  settled(): Promise<void>;
  /** Cancels the job under way and waits for its processes to go; no job starts after. */
  close(): Promise<void>;
}

/** The sessions, as far as an update waits for them. */
export interface RunningSessions {
  /** How many sessions are running now. */
  running(): number;
  /** Calls `listener` whenever the sessions may have changed; returns a function that stops it. */
  onChange(listener: () => void): () => void;
}

/** A job the service started, and what it has shown of it. */
interface Job {
  readonly stop: AbortController;
  state: InstallUpdatedEvent;
}

/** How a job ended, as shown. */
type Outcome = Pick<InstallUpdatedEvent, "state" | "exitCode" | "reason">;

/**
 * The command a job runs with the tools found, or `null` when its tool is missing.
 *
 * @remarks
 * The install script is downloaded once the job runs, so its input is filled in then (SPEC-0001,
 * "首次启动 · 接口"): the script goes to `sh -s` on standard input, never through a shell command
 * line.
 *
 * @sideEffects none
 * @param kind - The job.
 * @param tools - The tools found, or `null`.
 * @param cwd - The folder jobs run in.
 * @returns The command.
 */
function commandFor(kind: InstallKind, tools: HostTools | null, cwd: string): JobCommand | null {
  if (tools === null) return null;
  const { env } = tools;
  if (kind === "install_pi") return { file: "/bin/sh", args: ["-s"], input: "", cwd, env };
  if (kind === "install_node") {
    return tools.homebrew === null ? null : { file: tools.homebrew, args: ["install", "node"], input: null, cwd, env };
  }
  return tools.pi.status === "missing" ? null : { file: tools.pi.piPath, args: ["update"], input: null, cwd, env };
}

/**
 * Creates the install service.
 *
 * @remarks
 * One job at a time. An update first waits for the running sessions to finish, showing how many
 * still run; while it runs, sessions starting pi wait for it ({@link InstallService.settled}). A
 * job that succeeds shows done only after `afterSuccess`, which checks the tools again and, after
 * an update, stops idle sessions' pi so their next use starts the new one. Each change of state goes whole to every connection, and so does the output, as it
 * comes; the output is never logged, only the job's kind, outcome, exit code and failure reason
 * (SPEC-0001, "首次启动 · 接口").
 *
 * @sideEffects none until asked; then downloads the install script, runs commands and broadcasts.
 * @param options - Where the tools come from, how to download the install script, the sessions an
 * update waits for, how to reach every connection, how to run a command, what to do after a job
 * succeeds and before it shows done, the folder jobs run in, how to make a job id, and the logger.
 * @returns The service.
 */
export function createInstallService(options: {
  readonly toolbox: Pick<Toolbox, "current">;
  readonly script: (signal: AbortSignal) => Promise<string>;
  readonly sessions: RunningSessions;
  readonly broadcast: (event: InstallUpdatedEvent | InstallOutputEvent) => void;
  readonly run: (
    command: JobCommand,
    run: { readonly signal: AbortSignal; readonly onOutput: (text: string) => void },
  ) => Promise<JobEnd>;
  readonly afterSuccess: (kind: InstallKind) => Promise<void>;
  readonly cwd: string;
  readonly newId: () => string;
  readonly logger: Logger;
}): InstallService {
  let current: Job | null = null;
  /** Released once the update of pi under way has ended; holds only while it runs. */
  let updating: PromiseWithResolvers<void> | null = null;
  let closed = false;
  const finishing = new Set<Promise<void>>();

  /**
   * Changes a job's state and sends it to every connection.
   *
   * @remarks
   * See {@link createInstallService}.
   *
   * @sideEffects Broadcasts.
   * @param job - The job.
   * @param changes - What changed.
   */
  function publish(job: Job, changes: Partial<InstallUpdatedEvent>): void {
    job.state = { ...job.state, ...changes };
    options.broadcast(job.state);
  }

  /**
   * Waits until no session runs, showing how many still do, then shows the update running.
   *
   * @remarks
   * Stops waiting when the job is cancelled. The update shows running at once, so a session that
   * starts pi from then on waits for it.
   *
   * @sideEffects Listens to the sessions until done; broadcasts the count when it changes, and the
   * update running.
   * @param job - The update.
   * @returns Once no session runs or the job is cancelled.
   */
  function idle(job: Job): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const { signal } = job.stop;
    /**
     * Looks at the sessions again.
     *
     * @remarks
     * A named listener, so it can be removed.
     *
     * @sideEffects May broadcast; stops listening once done.
     */
    const check = (): void => {
      const running = options.sessions.running();
      if (running > 0 && !signal.aborted) {
        if (running !== job.state.running) publish(job, { running });
        return;
      }
      stop();
      signal.removeEventListener("abort", check);
      if (!signal.aborted) publish(job, { state: "running", running: null });
      resolve();
    };
    const stop = options.sessions.onChange(check);
    signal.addEventListener("abort", check);
    check();
    return promise;
  }

  /**
   * Runs a job to its end.
   *
   * @remarks
   * See {@link createInstallService}.
   *
   * @sideEffects Waits for the sessions; downloads the script; runs the command; broadcasts.
   * @param job - The job.
   * @param command - What it runs.
   * @returns How it ended.
   */
  async function execute(job: Job, command: JobCommand): Promise<Outcome> {
    const { signal } = job.stop;
    const { jobId, kind } = job.state;
    const cancelled = { state: "cancelled", exitCode: null, reason: null } as const;
    if (job.state.state === "waiting") {
      await idle(job);
      if (signal.aborted) return cancelled;
    }
    let input = command.input;
    if (kind === "install_pi") {
      try {
        input = await options.script(signal);
      } catch (error) {
        if (signal.aborted) return cancelled;
        const reason = error instanceof DownloadError ? error.reason : "unknown";
        options.logger.warn({ kind, reason }, "install script not downloaded");
        return { state: "failed", exitCode: null, reason: "download_failed" };
      }
    }
    const end = await options.run(
      { ...command, input },
      { signal, onOutput: (text) => options.broadcast({ type: "install_output", jobId, text }) },
    );
    if (signal.aborted) return cancelled;
    if (!end.started) return { state: "failed", exitCode: null, reason: "spawn_failed" };
    if (end.exitCode !== 0) return { state: "failed", exitCode: end.exitCode, reason: "exit" };
    try {
      await options.afterSuccess(kind);
    } catch (error) {
      // The job itself succeeded; what follows it is the host's own work.
      options.logger.error({ err: error, kind }, "after install failed");
    }
    return { state: "ok", exitCode: 0, reason: null };
  }

  /**
   * Shows how a job ended, logs it, and frees the service for the next.
   *
   * @remarks
   * See {@link createInstallService}.
   *
   * @sideEffects Broadcasts; logs.
   * @param job - The job.
   * @param outcome - How it ended.
   */
  function finish(job: Job, outcome: Outcome): void {
    current = null;
    const { kind } = job.state;
    options.logger.info({ kind, ...outcome }, "install finished");
    publish(job, { ...outcome, running: null });
    updating?.resolve();
    updating = null;
  }

  return {
    async start(kind) {
      if (closed) throw new CommandError("install_unavailable");
      if (current !== null) throw new CommandError("install_busy");
      // Taken before waiting for the tools, so a second start while this one looks is busy.
      const job: Job = {
        stop: new AbortController(),
        state: {
          type: "install_updated",
          jobId: options.newId(),
          kind,
          state: "running",
          running: null,
          exitCode: null,
          reason: null,
        },
      };
      current = job;
      const command = commandFor(kind, await options.toolbox.current(), options.cwd);
      if (command === null || closed) {
        current = null;
        throw new CommandError("install_unavailable");
      }
      if (kind === "update_pi") updating = Promise.withResolvers();
      const running = kind === "update_pi" ? options.sessions.running() : 0;
      if (running > 0) job.state = { ...job.state, state: "waiting", running };
      options.logger.info({ kind }, "install started");
      options.broadcast(job.state);
      const done = execute(job, command).then(
        (outcome) => finish(job, outcome),
        (error: unknown) => {
          // Running a job only fails through its outcome; anything else is a bug, shown as a failure.
          options.logger.error({ err: error, kind }, "install ended unexpectedly");
          finish(job, { state: "failed", exitCode: null, reason: "spawn_failed" });
        },
      );
      finishing.add(done);
      void done.finally(() => finishing.delete(done));
      return { jobId: job.state.jobId };
    },
    settled: () => (updating !== null && current?.state.state === "running" ? updating.promise : Promise.resolve()),
    cancel(jobId) {
      if (current === null || current.state.jobId !== jobId) throw new CommandError("install_not_found");
      current.stop.abort();
    },
    async close() {
      closed = true;
      current?.stop.abort();
      await Promise.allSettled(finishing);
    },
  };
}
