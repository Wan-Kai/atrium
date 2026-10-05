import { type PiEvent, inspectPi } from "@atrium/pi";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { systemClock } from "../platform/clock";
import { readLoginShellEnv, toolSafe } from "../platform/login-shell";
import { createLogger, openLogFile } from "../platform/logger";
import { createPiDeps } from "../platform/pi-deps";
import { ResourceTracker } from "../platform/resources";
import { inSpan, setupTracing } from "../platform/tracing";
import { startTracedPi } from "../sessions/traced-pi";

/** What `pnpm pi:try` was asked to do. */
export interface TryOptions {
  readonly prompt: string;
  /** Directory pi works in. */
  readonly cwd: string;
  /** Skip the login shell and use this process's environment. */
  readonly inheritEnv: boolean;
  /** Let pi write a session file instead of passing `--no-session`. */
  readonly keepSession: boolean;
  /** Extra arguments for pi, after `--`. */
  readonly piArgs: readonly string[];
}

const USAGE = 'usage: pnpm pi:try "<prompt>" [--cwd <dir>] [--inherit-env] [--keep-session] [-- <pi arguments>]';

/**
 * Parses the command line of `pnpm pi:try`.
 *
 * @remarks
 * Kept separate from running so the parsing is testable without starting pi.
 *
 * @sideEffects none
 * @param argv - Arguments after the script name.
 * @param defaultCwd - Directory to use when `--cwd` is absent.
 * @returns The options, or a usage error.
 */
export function parseTryArgs(argv: readonly string[], defaultCwd: string): TryOptions | { readonly error: string } {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const piArgs = separator === -1 ? [] : argv.slice(separator + 1);
  let cwd = defaultCwd;
  let inheritEnv = false;
  let keepSession = false;
  const words: string[] = [];
  const rest = [...own];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (arg === "--inherit-env") inheritEnv = true;
    else if (arg === "--keep-session") keepSession = true;
    else if (arg === "--cwd") {
      const value = rest.shift();
      if (value === undefined) return { error: `--cwd needs a directory\n${USAGE}` };
      cwd = resolve(defaultCwd, value);
    } else if (arg.startsWith("--")) return { error: `unknown option ${arg}\n${USAGE}` };
    else words.push(arg);
  }
  const prompt = words.join(" ").trim();
  if (prompt === "") return { error: USAGE };
  return { prompt, cwd, inheritEnv, keepSession, piArgs };
}

/** Where `runTry` writes. */
export interface TryOutput {
  write(text: string): void;
  /** Whether ANSI styling should be used. */
  readonly color: boolean;
}

/**
 * Dims text with ANSI styling when color is on.
 *
 * @remarks
 * Thinking and tool lines are secondary to the reply, as in the app's default view.
 *
 * @sideEffects none
 * @param text - Text to show.
 * @param color - Whether to use ANSI styling.
 * @returns The styled or plain text.
 */
function dim(text: string, color: boolean): string {
  return color ? `\u001b[2m${text}\u001b[22m` : text;
}

/**
 * Turns one pi event into terminal text: reply text as is, thinking dimmed, tool calls on their own line.
 *
 * @remarks
 * Only the parts a person watching the stream needs; the full record is in the log.
 *
 * @sideEffects none
 * @param event - A pi event.
 * @param color - Whether to use ANSI styling.
 * @returns Text for stdout and stderr; empty strings when there is nothing to show.
 */
export function renderEvent(event: PiEvent, color: boolean): { readonly out: string; readonly err: string } {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") return { out: update.delta, err: "" };
    if (update.type === "thinking_delta") return { out: dim(update.delta, color), err: "" };
    if (update.type === "thinking_end") return { out: "\n", err: "" };
  }
  if (event.type === "tool_execution_start")
    return { out: dim(`\n[${event.toolName}] ${JSON.stringify(event.args)}\n`, color), err: "" };
  if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
    return { out: "", err: `\npi: ${event.message.errorMessage ?? "error"}\n` };
  }
  if (event.type === "agent_settled") return { out: "\n", err: "" };
  return { out: "", err: "" };
}

/**
 * Sends one prompt to real pi and streams the reply, the narrowest path from host to pi (roadmap M1.2).
 *
 * @remarks
 * Uses the same pieces the host will use for sessions: the tool environment, `createPiDeps`,
 * `startTracedPi`, spans and the redacting logger. Everything runs under one trace whose id is
 * printed at the end, so `pnpm trace <id> <logs>` shows the whole run. Logs go to their own
 * directory, so a host running at the same time keeps its log rotation to itself.
 *
 * @sideEffects Creates the log directory; spawns pi (and possibly the login shell); writes logs
 * and the streamed reply.
 * @param options - Prompt, working directory, environment choice and extra pi arguments.
 * @param io - Atrium home, base environment, and where to write.
 * @returns The process exit code: 0 when the run settled without a model error, 1 otherwise.
 */
export async function runTry(
  options: TryOptions,
  io: {
    readonly home: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly stdout: TryOutput;
    readonly stderr: TryOutput;
  },
): Promise<number> {
  const logsDir = join(io.home, "dev-logs");
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  const { stream } = await openLogFile(logsDir);
  // Stryker disable next-line ArrayDeclaration: the run holds no secret of its own; pi's environment is never logged.
  const logger = createLogger({ destination: stream, level: "debug", secrets: () => [], service: "host" });
  const resources = new ResourceTracker();
  const tracing = setupTracing({ logger, resources, version: packageJson.version });
  // Stryker disable next-line StringLiteral: always set before anything can fail inside the span.
  let traceId = "";
  try {
    return await inSpan(tracing.tracer, "dev.try-pi", async (span) => {
      traceId = span.spanContext().traceId;
      const env = options.inheritEnv
        ? toolSafe(io.env)
        : (await readLoginShellEnv({ shell: io.env["SHELL"], env: io.env, clock: systemClock })).env;
      // Stryker disable next-line StringLiteral: without PATH no pi is found either way.
      const pi = await inspectPi(env["PATH"] ?? "", { env });
      if (pi.status !== "ready") {
        io.stderr.write(`pi is ${pi.status}: ${JSON.stringify(pi)}\n`);
        return 1;
      }
      const deps = createPiDeps({ clock: systemClock, resources, logger, env });
      const traced = startTracedPi({
        launch: {
          piPath: pi.piPath,
          args: [...(options.keepSession ? [] : ["--no-session"]), ...options.piArgs],
          cwd: options.cwd,
        },
        deps,
        tracer: tracing.tracer,
      });
      const settled = Promise.withResolvers<boolean>();
      let failed = false;
      traced.process.onEvent((event) => {
        const text = renderEvent(event, io.stdout.color);
        io.stdout.write(text.out);
        if (text.err !== "") {
          failed = true;
          io.stderr.write(text.err);
        }
        if (event.type === "agent_settled") settled.resolve(true);
      });
      // Fire and forget: resolving an already settled promise does nothing.
      void traced.process.exited.then(() => settled.resolve(false));
      try {
        const response = await traced.request({ type: "prompt", message: options.prompt });
        const finished = response.disposition === "handled" ? true : await settled.promise;
        return finished && !failed ? 0 : 1;
      } catch (error) {
        io.stderr.write(`pi: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      } finally {
        await traced.process.stop();
      }
    });
  } finally {
    io.stderr.write(`trace ${traceId} · pnpm trace ${traceId} ${logsDir}\n`);
    await tracing.shutdown();
    await new Promise<void>((done) => {
      stream.once("close", () => done());
      stream.end();
    });
  }
}

/**
 * Entry point of `pnpm pi:try`: parses the arguments and runs, returning the exit code.
 *
 * @remarks
 * pnpm runs scripts from the repository root, so the directory the command was typed in comes
 * from `INIT_CWD`. Takes its inputs as arguments so tests can run it without a real terminal.
 *
 * @sideEffects As `runTry`; writes usage errors to `stderr`.
 * @param argv - Arguments after the script name.
 * @param env - The process environment.
 * @param stdout - Where the reply goes.
 * @param stderr - Where errors and the trace id go.
 * @returns The exit code: 2 for a usage error, otherwise `runTry`'s.
 */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  stdout: TryOutput,
  stderr: TryOutput,
): Promise<number> {
  // Stryker disable next-line LogicalOperator: pnpm always sets INIT_CWD; the fallback is for running the bundle by hand.
  const parsed = parseTryArgs(argv, env["INIT_CWD"] ?? process.cwd());
  if ("error" in parsed) {
    stderr.write(`${parsed.error}\n`);
    return 2;
  }
  // Stryker disable next-line LogicalOperator,StringLiteral: the default is the user's real home, which tests never touch.
  const home = env["ATRIUM_HOME"] ?? join(homedir(), ".atrium");
  return runTry(parsed, { home, env, stdout, stderr });
}

// Stryker disable all: this only runs as the bundled command; `main` above is tested directly.
if (process.argv[1]?.endsWith("try-pi.cjs") === true) {
  // Fire and forget: the chain cannot reject, and the process exits when it settles.
  void main(
    process.argv.slice(2),
    process.env,
    { write: (text) => process.stdout.write(text), color: process.stdout.isTTY },
    { write: (text) => process.stderr.write(text), color: process.stderr.isTTY },
  )
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      return 1;
    })
    .then((code) => (process.exitCode = code));
}
