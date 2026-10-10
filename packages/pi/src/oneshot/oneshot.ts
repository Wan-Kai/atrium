import type { ModelRef } from "@atrium/protocol";
import { spawn } from "node:child_process";
import type { PiDeps } from "../deps";
import { piEnvironment } from "../env/pi-env";
import { contentText } from "../history/tools";
import { createLineSplitter } from "../process/jsonl";
import { type ProcessSystem, killProcessTree } from "../process/kill-tree";

/** How long a one-shot call may take before pi is killed. */
export const ONESHOT_TIMEOUT_MS = 60_000;

/** How long to wait for pi's pipes to close after it exited before giving up on them. */
const PIPE_DRAIN_MS = 1_000;

/** Why a one-shot call gave no text. */
export type OneShotFailure = "model_failed" | "exited" | "no_reply" | "timed_out" | "aborted";

/**
 * A one-shot call that gave no text.
 *
 * @remarks
 * Only the reason: pi's output may quote the conversation, which stays out of logs (security.md,
 * "凭据与日志").
 *
 * @sideEffects none
 */
export class OneShotError extends Error {
  override readonly name = "OneShotError";

  /**
   * Creates the error.
   *
   * @remarks
   * See the class.
   *
   * @sideEffects none
   * @param reason - Why the call failed.
   */
  constructor(readonly reason: OneShotFailure) {
    super(reason);
  }
}

/** What to ask a one-shot pi. */
export interface OneShotRequest {
  readonly piPath: string;
  readonly cwd: string;
  /** Environment on top of the host's, as for the session's own pi. */
  readonly env?: Readonly<Record<string, string>>;
  readonly model: ModelRef;
  readonly systemPrompt: string;
  /** The content, given on stdin. */
  readonly input: string;
}

/** An assistant message as pi's json mode ends it, reduced to what the call reads. */
interface Reply {
  readonly stopReason: unknown;
  readonly text: string;
}

/**
 * The assistant message a line of pi's json mode ends, if it ends one.
 *
 * @remarks
 * Lines are read leniently: anything that is not an assistant `message_end` is skipped
 * (pi-internals.md, "一次性调用").
 *
 * @sideEffects none
 * @param line - One line of stdout.
 * @returns The reply, or `undefined`.
 */
function replyOf(line: string): Reply | undefined {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null || Reflect.get(record, "type") !== "message_end") return undefined;
  const message: unknown = Reflect.get(record, "message");
  if (typeof message !== "object" || message === null || Reflect.get(message, "role") !== "assistant") return undefined;
  const content: unknown = Reflect.get(message, "content");
  return {
    stopReason: Reflect.get(message, "stopReason"),
    text: Array.isArray(content) ? contentText(content).text : "",
  };
}

/**
 * Runs pi once without a session and answers its reply's text.
 *
 * @remarks
 * SPEC-0001 ("自动生成标题"): `pi --mode json -p --no-session --no-tools --thinking off --model …
 * --system-prompt …` with the content on stdin, since `ps` shows arguments. pi leads its own
 * process group, as the session's pi does, so a deadline or an abort can kill its whole tree; it is
 * counted as a `pi-oneshot` resource until it is gone. The last assistant reply is the answer; a
 * reply that failed or was aborted, a non-zero exit, no reply with text, the deadline and an abort
 * all fail, and only the reason is logged. stderr is read and dropped, since it may quote the
 * content.
 *
 * @sideEffects Spawns pi and may kill its process tree; logs a failure's reason.
 * @param request - pi, the directory, the model, the instructions and the content.
 * @param deps - Host infrastructure.
 * @param options - The deadline, an abort signal, and the process system for killing.
 * @returns The reply's text.
 * @throws {OneShotError} When the call gave no text.
 */
export async function runOneShot(
  request: OneShotRequest,
  deps: PiDeps,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly processSystem?: ProcessSystem } = {},
): Promise<string> {
  /**
   * Logs why the call failed and makes its error.
   *
   * @remarks
   * See `runOneShot`.
   *
   * @sideEffects Logs.
   * @param reason - Why.
   * @returns The error.
   */
  const failure = (reason: OneShotFailure): OneShotError => {
    deps.log.warn({ reason }, "one-shot pi failed");
    return new OneShotError(reason);
  };
  if (options.signal?.aborted === true) throw failure("aborted");
  const { model, systemPrompt } = request;
  const child = spawn(
    request.piPath,
    [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-tools",
      "--thinking",
      "off",
      "--model",
      `${model.providerId}/${model.modelId}`,
      "--system-prompt",
      systemPrompt,
    ],
    { cwd: request.cwd, env: piEnvironment(deps.env, request.env ?? {}), detached: true },
  );
  const release = deps.track("pi-oneshot");
  let last: Reply | undefined;
  let stopped: "timed_out" | "aborted" | undefined;
  const stdout = createLineSplitter((line) => {
    last = replyOf(line) ?? last;
  });
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stdout.on("end", () => stdout.end());
  child.stderr.resume();
  // pi may exit before reading all of stdin; its exit says what went wrong.
  child.stdin.on("error", () => undefined);
  child.stdin.end(request.input);

  /**
   * Kills pi and everything it started.
   *
   * @remarks
   * pi leads its own process group. When the tree cannot be read, killing pi alone still ends the
   * call.
   *
   * @sideEffects Kills processes.
   * @param why - Why pi is stopped.
   */
  const kill = async (why: "timed_out" | "aborted"): Promise<void> => {
    stopped ??= why;
    // Stryker disable next-line ConditionalExpression: a pi without a pid never started and has already closed.
    if (child.pid === undefined) return;
    try {
      await killProcessTree(child.pid, options.processSystem);
    } catch {
      child.kill("SIGKILL");
    }
  };
  const cancelTimer = deps.clock.setTimeout(() => void kill("timed_out"), options.timeoutMs ?? ONESHOT_TIMEOUT_MS);
  /**
   * Kills pi when the caller gives up.
   *
   * @remarks
   * See `kill`.
   *
   * @sideEffects Kills processes.
   */
  const onAbort = (): void => void kill("aborted");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let cancelDrain: (() => void) | undefined;
  child.on("exit", () => {
    // A process that inherited pi's pipes could keep them open; closing them lets `close` fire.
    cancelDrain = deps.clock.setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, PIPE_DRAIN_MS);
  });
  const { promise: closed, resolve } = Promise.withResolvers<number | null>();
  child.on("error", () => resolve(null));
  child.on("close", (code) => resolve(code));
  const code = await closed;
  cancelTimer();
  cancelDrain?.();
  options.signal?.removeEventListener("abort", onAbort);
  release();

  if (stopped !== undefined) throw failure(stopped);
  if (code !== 0) throw failure("exited");
  if (last === undefined) throw failure("no_reply");
  if (last.stopReason === "error" || last.stopReason === "aborted") throw failure("model_failed");
  const text = last.text.trim();
  if (text.length === 0) throw failure("no_reply");
  return last.text;
}
