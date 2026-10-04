import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import type { PiDeps } from "../deps";
import { createLineSplitter, serializeJsonLine } from "./jsonl";
import { type ProcessSystem, killProcessTree } from "./kill-tree";

/** `Omit` applied to each member of a union separately. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A pi RPC command without its id; the process assigns ids. */
export type PiCommand = DistributiveOmit<RpcCommand, "id">;

/** What a successful response to a command of type `T` carries in `data`. */
export type PiResponseData<T extends PiCommand["type"]> =
  Extract<RpcResponse, { command: T; success: true }> extends { data: infer Data } ? Data : undefined;

/** Everything pi prints that is not a response: session events and extension dialog requests. */
export type PiEvent =
  | JsonAgentSessionEvent
  | RpcExtensionUIRequest
  | {
      readonly type: "extension_error";
      readonly extensionPath: string;
      readonly event: string;
      readonly error: string;
    };

/** Why a request did not get a successful response. */
export type PiRequestFailure = "rejected" | "timeout" | "aborted" | "stopped" | "exited";

/**
 * A command that did not succeed.
 *
 * @remarks
 * The host turns `reason` into an error code for the UI and never shows `message` itself
 * (AGENTS.md, "宿主不产出给用户看的文字"); `detail` keeps pi's own error text or the end of its
 * stderr for the "展开看原始报错" view.
 *
 * @sideEffects none
 */
export class PiRequestError extends Error {
  override readonly name = "PiRequestError";

  /**
   * Creates the error.
   *
   * @remarks
   * The message combines command and reason so log lines are readable on their own.
   *
   * @sideEffects none
   * @param command - The command type that failed.
   * @param reason - Why it failed.
   * @param detail - pi's error text, or the end of its stderr when it exited.
   */
  constructor(
    readonly command: string,
    readonly reason: PiRequestFailure,
    readonly detail?: string,
  ) {
    super(`pi ${command} ${reason}${detail === undefined ? "" : `: ${detail}`}`);
  }
}

/** How pi ended. */
export interface PiExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** Whether `stop()` was called first; anything else is a crash. */
  readonly requested: boolean;
  /** The last part of stderr, for error details. */
  readonly stderrTail: string;
  /** Set when the process could not be started at all. */
  readonly spawnError?: string;
}

/** How to start pi. */
export interface PiLaunch {
  /** Absolute path of the pi executable, as found by `findPi`. */
  readonly piPath: string;
  /** Arguments after `--mode rpc`. */
  readonly args: readonly string[];
  readonly cwd: string;
  /** Variables added on top of `PiDeps.env`. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Timing knobs; tests shorten them. */
export interface PiProcessOptions {
  /** Default response deadline for commands that have one. */
  readonly requestTimeoutMs?: number;
  /** How long pi gets to exit after stdin closes, and again after SIGTERM. */
  readonly stopGraceMs?: number;
  /** Process listing and signalling for the forced kill; tests pass a fake. */
  readonly processSystem?: ProcessSystem;
}

/** A running `pi --mode rpc` process. */
export interface PiProcess {
  readonly pid: number | undefined;
  /** Resolves once the process has exited and its output is read, whatever the cause. */
  readonly exited: Promise<PiExit>;
  /**
   * Sends a command and resolves with the `data` of its successful response.
   *
   * `timeoutMs: null` waits without a deadline; by default `compact` and `bash` have none.
   */
  request<C extends PiCommand>(
    command: C,
    options?: { readonly timeoutMs?: number | null; readonly signal?: AbortSignal },
  ): Promise<PiResponseData<C["type"]>>;
  /** Answers an extension dialog; pi sends no response to this. */
  respond(response: RpcExtensionUIResponse): void;
  /** Subscribes to events; returns the unsubscribe function. */
  onEvent(listener: (event: PiEvent) => void): () => void;
  /** Stops pi; resolves with how it ended once every shutdown step, timers included, is done. */
  stop(): Promise<PiExit>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 2_000;
/** Commands whose duration depends on the model or the user's command, so a deadline would be wrong. */
const UNTIMED_COMMANDS: ReadonlySet<string> = new Set(["compact", "bash"]);
const STDERR_TAIL_BYTES = 8 * 1024;
/** How long to wait for pi's pipes to close after it exited before giving up on them. */
const PIPE_DRAIN_MS = 1_000;

/** A request waiting for its response. */
interface Pending {
  readonly command: string;
  readonly resolve: (data: unknown) => void;
  readonly reject: (error: PiRequestError) => void;
  /** Cancels the deadline and the abort listener. */
  readonly cleanup: () => void;
}

/**
 * Starts `pi --mode rpc` and speaks its JSONL protocol.
 *
 * @remarks
 * Written for Atrium instead of using pi's `RpcClient` (SPEC-0001, "风险与待定问题"): pi handles
 * each command line concurrently, so responses are matched by id and may arrive in any order;
 * deadlines are per command; dialog answers can be sent; stderr is logged line by line and only
 * its tail is kept in memory. pi leads its own process group so that stopping can reach
 * everything it started. Stopping closes stdin first, which pi treats as an orderly shutdown, then
 * sends SIGTERM, and only then kills the whole process tree (pi-internals.md §3 "退出"). Every
 * exit, requested or not, resolves `exited` and fails the requests still waiting.
 *
 * @sideEffects Spawns a process; counts it as a `pi-process` resource until it exits; logs its
 * stderr and lifecycle; may kill processes when stopping.
 * @param launch - Executable, arguments, working directory and extra environment.
 * @param deps - Host infrastructure.
 * @param options - Timing overrides.
 * @returns The running process.
 */
export function startPiProcess(launch: PiLaunch, deps: PiDeps, options: PiProcessOptions = {}): PiProcess {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const child = spawn(launch.piPath, ["--mode", "rpc", ...launch.args], {
    cwd: launch.cwd,
    env: { ...deps.env, ...launch.env },
    detached: true,
  });
  const pid = child.pid;
  const release = deps.track("pi-process");
  // Keyed by request id; `undefined` is never stored, so a response without an id finds nothing.
  const pending = new Map<string | undefined, Pending>();
  const listeners = new Set<(event: PiEvent) => void>();
  let stderrTail = "";
  let stopRequested = false;
  let exit: PiExit | undefined;
  let cancelDrain: (() => void) | undefined;
  let stopping: Promise<PiExit> | undefined;
  const { promise: exited, resolve: resolveExited } = Promise.withResolvers<PiExit>();

  /**
   * Fails every waiting request.
   *
   * @remarks
   * Once pi is stopping or gone, no response can come, so waiting callers are released at once.
   *
   * @sideEffects Rejects pending promises and cancels their deadlines.
   * @param reason - Why they failed.
   * @param detail - Extra text for the error.
   */
  function failAll(reason: PiRequestFailure, detail?: string): void {
    for (const [id, waiting] of pending) {
      pending.delete(id);
      waiting.cleanup();
      waiting.reject(new PiRequestError(waiting.command, reason, detail));
    }
  }

  /**
   * Records how pi ended, exactly once.
   *
   * @remarks
   * Called from `close`, and from `error` when spawning failed; when spawning fails Node may emit
   * `close` as well, so the second call is ignored.
   *
   * @sideEffects Fails waiting requests; cancels the drain timer; releases the resource count; logs;
   * resolves `exited`.
   * @param code - Exit code.
   * @param signal - Terminating signal.
   * @param spawnError - Why spawning failed, if it did.
   */
  function finish(code: number | null, signal: string | null, spawnError?: string): void {
    if (exit !== undefined) return;
    exit = {
      code,
      signal,
      requested: stopRequested,
      stderrTail,
      ...(spawnError === undefined ? {} : { spawnError }),
    };
    cancelDrain?.();
    failAll("exited", stderrTail);
    release();
    deps.log[exit.requested ? "info" : "warn"]({ pid, code, signal, requested: exit.requested }, "pi exited");
    resolveExited(exit);
  }

  /**
   * Routes a response to the request that is waiting for it.
   *
   * @remarks
   * A response without an id is pi's answer to a line it could not parse; one with an unknown id
   * belongs to a request that already timed out or was aborted.
   *
   * @sideEffects Settles a pending request; logs unmatched responses.
   * @param response - The response pi printed.
   */
  function handleResponse(response: RpcResponse): void {
    const waiting = pending.get(response.id);
    if (waiting === undefined) {
      deps.log.warn({ pid, id: response.id, command: response.command }, "pi response matches no waiting request");
      return;
    }
    pending.delete(response.id);
    waiting.cleanup();
    if (response.success) waiting.resolve("data" in response ? response.data : undefined);
    else waiting.reject(new PiRequestError(waiting.command, "rejected", response.error));
  }

  /**
   * Parses one stdout line and dispatches it.
   *
   * @remarks
   * Lines are logged by length only, because they carry conversation content (observability.md,
   * "脱敏"). A throwing listener is logged and skipped so it cannot break the stream for others.
   *
   * @sideEffects Calls event listeners; settles requests; logs malformed lines.
   * @param line - One JSONL record.
   */
  function handleLine(line: string): void {
    if (line.length === 0) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      deps.log.warn({ pid, length: line.length }, "pi printed a line that is not JSON");
      return;
    }
    if (typeof record !== "object" || record === null || !("type" in record) || typeof record.type !== "string") {
      deps.log.warn({ pid, length: line.length }, "pi printed a record without a type");
      return;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pi's record shapes are checked by the pi contract tests.
    if (record.type === "response") return handleResponse(record as RpcResponse);
    for (const listener of listeners) {
      try {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above.
        listener(record as PiEvent);
      } catch (error) {
        deps.log.error({ pid, err: error, type: record.type }, "pi event listener threw");
      }
    }
  }

  const stdout = createLineSplitter(handleLine);
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stdout.on("end", () => stdout.end());
  const stderr = createLineSplitter((line) => {
    if (line.length > 0) deps.log.info({ pid, stream: "stderr", line }, "pi stderr");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  child.stderr.on("end", () => stderr.end());
  child.stdin.on("error", (error) => deps.log.warn({ pid, err: error }, "pi stdin failed"));
  child.on("error", (error) => {
    // Without a pid the process never started, and no `close` follows reliably. After a successful
    // spawn, Node emits `error` only when `kill()` fails, which cannot be provoked in a test.
    // Stryker disable next-line ConditionalExpression: see above.
    if (pid === undefined) {
      finish(null, null, error.message);
      return;
    }
    // Stryker disable next-line all: see above.
    deps.log.warn({ pid, err: error }, "pi process error");
  });
  child.on("exit", () => {
    // A grandchild that inherited pi's pipes could keep them open forever. Destroying them after a
    // while lets `close` fire, which finishes as usual.
    cancelDrain = deps.clock.setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, PIPE_DRAIN_MS);
  });
  child.on("close", (code, signal) => finish(code, signal));
  deps.log.info({ pid, cwd: launch.cwd }, "pi started");

  /**
   * Resolves `true` if pi exits within `ms`, `false` otherwise.
   *
   * @remarks
   * The timer goes through the injected clock so it is counted and cancelled like any other.
   *
   * @sideEffects Schedules and cancels a timer.
   * @param ms - How long to wait.
   * @returns Whether pi exited in time.
   */
  async function exitsWithin(ms: number): Promise<boolean> {
    const timedOut = Promise.withResolvers<false>();
    const cancel = deps.clock.setTimeout(() => timedOut.resolve(false), ms);
    try {
      return await Promise.race([exited.then(() => true), timedOut.promise]);
    } finally {
      cancel();
    }
  }

  /**
   * Escalates from closing stdin to SIGTERM to killing the whole tree.
   *
   * @remarks
   * See `startPiProcess` for why the steps come in this order.
   *
   * @sideEffects Closes stdin; sends signals; may kill descendant processes; logs each escalation.
   */
  async function shutdown(): Promise<void> {
    child.stdin.end();
    if (await exitsWithin(stopGraceMs)) return;
    deps.log.warn({ pid }, "pi did not exit after stdin closed; sending SIGTERM");
    child.kill("SIGTERM");
    if (await exitsWithin(stopGraceMs)) return;
    deps.log.warn({ pid }, "pi did not exit after SIGTERM; killing its process tree");
    // Stryker disable next-line ConditionalExpression: a pi without a pid never started, so `exitsWithin` returned above.
    if (pid === undefined) return;
    try {
      await killProcessTree(pid, options.processSystem);
    } catch (error) {
      // Killing pi alone at least lets `stop()` resolve; its detached children may survive.
      deps.log.error({ pid, err: error }, "killing pi's process tree failed; killing pi alone");
      child.kill("SIGKILL");
    }
  }

  /**
   * Sends a command and waits for its response.
   *
   * @remarks
   * See `PiProcess.request`. The id comes from `PiDeps.nextRequestId`, so the host can tie the
   * command to its span. A request given up on (deadline or abort) stays given up on: a late
   * response is logged and dropped.
   *
   * @sideEffects Writes to pi's stdin; schedules a deadline; listens to the abort signal.
   * @param command - The command without an id.
   * @param requestOptions - Deadline override and abort signal.
   * @returns The response's `data`.
   * @throws {PiRequestError} When pi rejects the command, the deadline passes, the signal aborts, or
   * pi stops or exits first.
   */
  function request<C extends PiCommand>(
    command: C,
    requestOptions: { readonly timeoutMs?: number | null; readonly signal?: AbortSignal } = {},
  ): Promise<PiResponseData<C["type"]>> {
    const type = command.type;
    if (exit !== undefined || stopRequested) {
      return Promise.reject(
        exit === undefined ? new PiRequestError(type, "stopped") : new PiRequestError(type, "exited", exit.stderrTail),
      );
    }
    const { signal } = requestOptions;
    if (signal?.aborted === true) return Promise.reject(new PiRequestError(type, "aborted"));
    const id = deps.nextRequestId();
    const defaultTimeoutMs = UNTIMED_COMMANDS.has(type) ? null : requestTimeoutMs;
    const timeoutMs = requestOptions.timeoutMs === undefined ? defaultTimeoutMs : requestOptions.timeoutMs;
    const response = Promise.withResolvers<PiResponseData<C["type"]>>();

    /**
     * Gives up on the request.
     *
     * @remarks
     * A later response for this id is then logged and dropped by `handleResponse`.
     *
     * @sideEffects Rejects the request; removes it from the pending table.
     * @param reason - Timeout or abort.
     */
    function giveUp(reason: "timeout" | "aborted"): void {
      const waiting = pending.get(id);
      // Stryker disable next-line ConditionalExpression: unreachable, since settling cancels both the deadline and the abort listener; kept for the type.
      if (waiting === undefined) return;
      pending.delete(id);
      waiting.cleanup();
      waiting.reject(new PiRequestError(type, reason));
    }

    const cancelTimer = timeoutMs === null ? undefined : deps.clock.setTimeout(() => giveUp("timeout"), timeoutMs);
    const settled = new AbortController();
    signal?.addEventListener("abort", () => giveUp("aborted"), { signal: settled.signal });
    pending.set(id, {
      command: type,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pi's response shapes are checked by the pi contract tests.
      resolve: (data) => response.resolve(data as PiResponseData<C["type"]>),
      reject: response.reject,
      cleanup: () => {
        cancelTimer?.();
        settled.abort();
      },
    });
    deps.log.debug({ pid, id, command: type }, "pi request");
    child.stdin.write(serializeJsonLine({ ...command, id }));
    return response.promise;
  }

  return {
    pid,
    exited,
    request,
    respond(response) {
      // Stryker disable next-line ConditionalExpression: after a crash stdin is already destroyed, and Node drops such writes without an error.
      if (exit !== undefined || stopRequested) return;
      child.stdin.write(serializeJsonLine(response));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      if (stopping === undefined) {
        stopRequested = true;
        failAll("stopped");
        // Resolve only after the shutdown steps have cancelled their own timers, not just when pi exits.
        stopping = shutdown().then(() => exited);
      }
      return stopping;
    },
  };
}
