import { spawn } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PiDeps } from "../deps";
import { piEnvironment } from "../env/pi-env";
import { createLineSplitter, serializeJsonLine } from "../process/jsonl";
import { type ProcessSystem, killProcessTree } from "../process/kill-tree";
import type {
  WorkerEvent,
  WorkerFailure,
  WorkerInput,
  WorkerOutput,
  WorkerPrompt,
  WorkerProvider,
} from "./login-worker";

export type { WorkerEvent as LoginEvent, WorkerPrompt as LoginPrompt, WorkerProvider as LoginProvider };

/** How long a status check or a logout may take before the login program is killed. */
export const LOGIN_QUERY_TIMEOUT_MS = 30_000;

/** How long the login program may take to leave after being told to cancel. */
const CANCEL_GRACE_MS = 3_000;

/** The pi package the login program drives. */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** What it takes to run the login program. */
export interface LoginProgram {
  /** Absolute path of the system Node, the one pi runs on. */
  readonly node: string;
  /** Absolute path of the login program. */
  readonly worker: string;
  /** File URL of the installed pi package's entry, from {@link piPackageEntry}. */
  readonly piEntry: string;
}

/** Why a login operation failed: the program's reasons, or the deadline. */
export type LoginFailure = WorkerFailure | "timed_out";

/**
 * A login operation that failed.
 *
 * @remarks
 * `detail` is pi's own text, shown to the user but never logged: it can quote what pi was told
 * (security.md, "凭据与日志").
 *
 * @sideEffects none
 */
export class LoginError extends Error {
  override readonly name = "LoginError";

  /**
   * Creates the error.
   *
   * @remarks
   * See the class.
   *
   * @sideEffects none
   * @param reason - Why it failed.
   * @param detail - pi's message, if any.
   */
  constructor(
    readonly reason: LoginFailure,
    readonly detail: string | null,
  ) {
    super(reason);
  }
}

/** What a running login reports. */
export type LoginUpdate =
  | { readonly kind: "event"; readonly event: WorkerEvent }
  | { readonly kind: "prompt"; readonly promptId: number; readonly prompt: WorkerPrompt }
  | { readonly kind: "prompt_closed"; readonly promptId: number };

/** A login under way. */
export interface LoginRun {
  /** Answers one of pi's questions; an answer to a question no longer open is dropped. */
  answer(promptId: number, value: string): void;
  /** Cancels the login; `finished` then rejects with `aborted`. */
  cancel(): void;
  /** Settles when the program has exited: fulfilled when the credential was saved. */
  readonly finished: Promise<void>;
}

/** What to sign in to. */
export interface LoginRequest {
  readonly providerId: string;
  readonly method: "oauth" | "api_key";
  /** For an API key login, the key, given to pi's first secret question. */
  readonly key?: string;
}

/**
 * Finds the entry of the pi package an installed `pi` command belongs to.
 *
 * @remarks
 * `pi` is a link into the package (`dist/bundle/cli.js` or `dist/cli.js`), installed by npm or by
 * the official script (pi-internals §4, "从外部调用 pi 的登录"). Walks up from the real path to the
 * package's `package.json`; a pi that is not such a package (a compiled binary) has none, and the
 * user then signs in from the terminal instead.
 *
 * @sideEffects Reads the file system.
 * @param piPath - Absolute path of the `pi` command.
 * @returns The file URL of the package's `dist/index.js`, or `null`.
 */
export async function piPackageEntry(piPath: string): Promise<string | null> {
  let directory: string;
  try {
    directory = dirname(await realpath(piPath));
  } catch {
    return null;
  }
  for (;;) {
    try {
      // Stryker disable next-line StringLiteral: without an encoding JSON.parse reads the buffer as UTF-8 all the same.
      const manifest: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      // Stryker disable next-line ConditionalExpression,LogicalOperator: Reflect.get throws on a non-object, which the catch also takes as no manifest; the check says what is meant.
      if (typeof manifest === "object" && manifest !== null && Reflect.get(manifest, "name") === PI_PACKAGE) {
        const entry = join(directory, "dist", "index.js");
        await access(entry);
        return pathToFileURL(entry).href;
      }
    } catch {
      // No manifest here, or no entry: keep walking up.
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** One run of the login program. */
interface WorkerRun {
  /** Writes one line to the program. */
  write(input: WorkerInput): void;
  /** Asks the program to cancel, then kills it if it does not leave. */
  cancel(): void;
  /** The program's final line, once it has exited. */
  readonly finished: Promise<void>;
}

/**
 * Starts the login program for one operation.
 *
 * @remarks
 * Runs with the environment pi gets, so proxies from the login shell reach the token exchange. The
 * program leads its own process group, like pi, so a deadline or a cancel that it ignores can kill
 * everything it started; it is counted as a `pi-login` resource until it is gone. stderr is dropped:
 * pi may print credentials there. `finished` fulfils on a `done` line and rejects with the `failed`
 * line's reason, or with `failed` when the program exits without either. A `done` wins over a cancel
 * that came too late: pi already saved the credential. With its signal already aborted, nothing starts.
 *
 * @sideEffects Spawns the login program; may kill its process tree.
 * @param program - Node, the program and pi.
 * @param args - The operation and its arguments.
 * @param deps - Host infrastructure.
 * @param onOutput - Receives every line before the last.
 * @param options - A deadline, an abort signal and the process system for killing.
 * @returns The run.
 */
function runWorker(
  program: LoginProgram,
  args: readonly string[],
  deps: PiDeps,
  onOutput: (output: Exclude<WorkerOutput, { readonly type: "done" | "failed" }>) => void,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly processSystem?: ProcessSystem },
): WorkerRun {
  if (options.signal?.aborted === true) {
    return {
      write: () => undefined,
      cancel: () => undefined,
      finished: Promise.reject(new LoginError("aborted", null)),
    };
  }
  const child = spawn(program.node, [program.worker, program.piEntry, ...args], {
    env: piEnvironment(deps.env),
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const release = deps.track("pi-login");
  let last: WorkerOutput | undefined;
  let stopped: "timed_out" | "aborted" | undefined;
  const stdout = createLineSplitter((line) => {
    let output: WorkerOutput;
    try {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the login program is ours; its lines are checked by the login tests.
      output = JSON.parse(line) as WorkerOutput;
    } catch {
      return;
    }
    if (output.type === "done" || output.type === "failed") last = output;
    else onOutput(output);
  });
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  // Stryker disable next-line StringLiteral,ArrowFunction,CallExpression: the program ends every line it writes, so nothing is left to flush.
  child.stdout.on("end", () => stdout.end());
  // The program may exit before reading what it was sent; its last line says what happened.
  // Stryker disable next-line StringLiteral: the broken pipe needs the program to die between two writes, which no test can time.
  child.stdin.on("error", () => undefined);

  /**
   * Kills the program and everything it started.
   *
   * @remarks
   * When the tree cannot be read, killing the program alone still ends the run.
   *
   * @sideEffects Kills processes.
   */
  const kill = async (): Promise<void> => {
    // Stryker disable next-line ConditionalExpression: a program without a pid never started and has already closed.
    if (child.pid === undefined) return;
    try {
      await killProcessTree(child.pid, options.processSystem);
    } catch {
      child.kill("SIGKILL");
    }
  };
  let cancelGrace: (() => void) | undefined;
  /**
   * Asks the program to cancel and kills it if it does not leave in time.
   *
   * @remarks
   * Ending its stdin cancels: the program aborts pi's login, which closes its callback server, and
   * exits by itself. A run that has timed out is already being killed and stays timed out.
   *
   * @sideEffects Writes to the program; may kill it later.
   */
  const cancel = (): void => {
    if (stopped !== undefined) return;
    stopped = "aborted";
    child.stdin.end();
    cancelGrace = deps.clock.setTimeout(() => void kill(), CANCEL_GRACE_MS);
  };
  const cancelTimer =
    options.timeoutMs === undefined
      ? undefined
      : deps.clock.setTimeout(() => {
          stopped ??= "timed_out";
          void kill();
        }, options.timeoutMs);
  options.signal?.addEventListener("abort", cancel);
  // A program that cannot be started closes after its `error`, which would be thrown without a listener.
  child.on("error", () => undefined);
  const { promise: closed, resolve } = Promise.withResolvers<void>();
  child.on("close", () => resolve());
  const finished = closed.then(() => {
    cancelTimer?.();
    cancelGrace?.();
    options.signal?.removeEventListener("abort", cancel);
    release();
    if (last?.type === "done") return;
    if (last?.type === "failed") throw new LoginError(last.reason, last.message);
    throw new LoginError(stopped ?? "failed", null);
  });
  return {
    // A write after a cancel ended stdin fails into the error listener above.
    write: (input) => child.stdin.write(serializeJsonLine(input)),
    cancel,
    finished,
  };
}

/**
 * Lists pi's providers and how each is signed in.
 *
 * @remarks
 * One run of the login program; nothing is refreshed, so a stored credential may be expired.
 *
 * @sideEffects Runs the login program, which reads pi's `auth.json`.
 * @param program - Node, the program and pi.
 * @param deps - Host infrastructure.
 * @param options - An abort signal, a deadline and the process system for killing.
 * @returns The providers in pi's order.
 * @throws {LoginError} When pi cannot be loaded, the check fails, times out or is aborted.
 */
export async function readLogins(
  program: LoginProgram,
  deps: PiDeps,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly processSystem?: ProcessSystem } = {},
): Promise<readonly WorkerProvider[]> {
  // Stryker disable next-line ArrayDeclaration: the program lists the providers before every `done`.
  let providers: readonly WorkerProvider[] = [];
  await runWorker(
    program,
    ["status"],
    deps,
    (output) => {
      // Stryker disable next-line ConditionalExpression: a status check writes nothing else before its end.
      if (output.type === "providers") providers = output.providers;
    },
    { ...options, timeoutMs: options.timeoutMs ?? LOGIN_QUERY_TIMEOUT_MS },
  ).finished;
  return providers;
}

/**
 * Removes a provider's stored credential.
 *
 * @remarks
 * pi's `logout`; a key that comes from the environment stays usable.
 *
 * @sideEffects Runs the login program, which rewrites pi's `auth.json`.
 * @param program - Node, the program and pi.
 * @param deps - Host infrastructure.
 * @param providerId - The provider.
 * @param options - An abort signal, a deadline and the process system for killing.
 * @throws {LoginError} When pi cannot be loaded, the logout fails, times out or is aborted.
 */
export async function logout(
  program: LoginProgram,
  deps: PiDeps,
  providerId: string,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly processSystem?: ProcessSystem } = {},
): Promise<void> {
  await runWorker(program, ["logout", providerId], deps, () => undefined, {
    ...options,
    timeoutMs: options.timeoutMs ?? LOGIN_QUERY_TIMEOUT_MS,
  }).finished;
}

/**
 * Starts signing in to a provider.
 *
 * @remarks
 * Two of pi's questions are answered here, as SPEC-0001 ("第 2 步：登录模型") decides: the login
 * method, by choosing pi's `browser` option when there is one, and, for an API key login, pi's first
 * secret question, with the key given. Everything else pi asks or tells goes to `onUpdate`. There is
 * no deadline: the user may take a while in the browser, and cancelling ends it.
 *
 * @sideEffects Runs the login program, which listens on a local port and writes pi's `auth.json`.
 * @param program - Node, the program and pi.
 * @param deps - Host infrastructure.
 * @param request - The provider, the method and the key.
 * @param onUpdate - Receives pi's questions and events.
 * @param options - The process system for killing.
 * @returns The login under way.
 */
export function startLogin(
  program: LoginProgram,
  deps: PiDeps,
  request: LoginRequest,
  onUpdate: (update: LoginUpdate) => void,
  options: { readonly processSystem?: ProcessSystem } = {},
): LoginRun {
  let keyGiven = false;
  const run = runWorker(
    program,
    ["login", request.providerId, request.method],
    deps,
    (output) => {
      switch (output.type) {
        case "prompt": {
          const { promptId, prompt } = output;
          // Only a choice has options.
          if (prompt.options.some(({ id }) => id === "browser")) {
            run.write({ promptId, value: "browser" });
            return;
          }
          if (prompt.kind === "secret" && request.key !== undefined && !keyGiven) {
            keyGiven = true;
            run.write({ promptId, value: request.key });
            return;
          }
          onUpdate({ kind: "prompt", promptId, prompt });
          return;
        }
        case "prompt_closed":
          onUpdate({ kind: "prompt_closed", promptId: output.promptId });
          return;
        case "event":
          onUpdate({ kind: "event", event: output.event });
          return;
        // Stryker disable next-line ConditionalExpression,StringLiteral: a login never lists providers.
        case "providers":
          return;
      }
    },
    options,
  );
  return {
    answer: (promptId, value) => run.write({ promptId, value }),
    cancel: () => run.cancel(),
    finished: run.finished,
  };
}
