import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { sharedExecutable, warmExecutable } from "./shared-executable";

/** How the fake pi answers one command type. */
export interface ScriptedRule {
  /** Answer only after a command of this type has been answered. */
  readonly after?: string;
  /** Answer only when stdin closes, just before exiting. */
  readonly atStdinEnd?: true;
  /** Answer with `success: false` and this error. */
  readonly fail?: string;
  /** Never answer. */
  readonly silent?: true;
  /** Answer without the request id. */
  readonly noId?: true;
  /** `data` of the successful response. */
  readonly data?: unknown;
  /** Records to print before the response. */
  readonly events?: readonly object[];
  /** Exit with this code instead of answering. */
  readonly exit?: number;
  /** Print the response twice. */
  readonly twice?: true;
  /** Exit with this code right after answering. */
  readonly exitAfter?: number;
  /**
   * Before answering, writes this text, or this many bytes of `x`, to the file the command's
   * `outputPath` names, as pi's `export_html` does.
   */
  readonly writes?: string | number;
  /**
   * Before answering, writes `text` to `file` and from then on answers `get_state` with this
   * session id and file, as pi's `fork` and `clone` move it to a new session. `<session-dir>` in
   * `file` stands for the directory pi was given with `--session-dir`, where pi writes the new file.
   */
  readonly switchesTo?: { readonly sessionId: string; readonly file: string; readonly text: string };
  /** Rules for successive commands of this type, the last one repeating; the other fields are ignored. */
  readonly sequence?: readonly ScriptedRule[];
}

/** Everything the fake pi does. */
export interface ScriptedPiBehavior {
  readonly rules?: Readonly<Record<string, ScriptedRule>>;
  /** Raw lines printed to stdout at start. */
  readonly stdout?: readonly string[];
  /** Raw text printed to stdout at start without a line break. */
  readonly stdoutUnterminated?: string;
  /** Print `{type: "argv", argv, cwd}` with the arguments and directory it was started with. */
  readonly announceArgv?: true;
  /** Write the same `{argv, cwd}` as one JSON line to stderr, for callers that only see logs. */
  readonly argvToStderr?: true;
  /** Write every command it receives as `{received}`, one JSON line on stderr, for callers that only see logs. */
  readonly receivedToStderr?: true;
  /** Print `{type: "env", values}` with these variables (`null` when unset). */
  readonly announceEnv?: readonly string[];
  /** Close its own stdin right away but keep running, then print `{type: "stdin-closed"}`. */
  readonly closeStdin?: true;
  /** Raw text written to stderr at start. */
  readonly stderr?: string;
  /** Raw text written to stderr piece by piece, 10 ms apart, so each arrives as its own chunk. */
  readonly stderrChunks?: readonly string[];
  /** Exit with this code right after start. */
  readonly exitCode?: number;
  /** Keep running after stdin closes. */
  readonly ignoreStdinEnd?: true;
  /** Keep running after SIGTERM. */
  readonly ignoreSigterm?: true;
  /** What `pi --version` prints; defaults to 1.0.2. */
  readonly version?: string;
  /** Start `sleep` children; each is announced as `{type: "grandchild", pid, mode}`. */
  readonly grandchildren?: readonly ("detached" | "attached" | "holds-pipes")[];
  /**
   * What it does when started with `-p`, as pi's one-shot print mode: reads stdin to its end,
   * writes `{argv, cwd, stdin, pid, grandchild}` to the file `recordTo` names, prints `lines`
   * (records as JSON, strings as they are) once the file `waitFor` names exists, if it names one,
   * then exits with `exitCode` (0 by default), or keeps running with `hang`. Without it, `-p`
   * changes nothing.
   */
  readonly print?: {
    readonly lines?: readonly (object | string)[];
    /** Raw text printed after `lines` without a line break. */
    readonly unterminated?: string;
    /** Bytes written to stderr, waiting until they are read, before `lines`. */
    readonly stderrBytes?: number;
    /** Exit with `exitCode` at once, without reading stdin. */
    readonly ignoreStdin?: true;
    /** Start a `sleep` that keeps stdout and stderr open after it exits; its pid is recorded. */
    readonly holdPipes?: true;
    readonly exitCode?: number;
    readonly hang?: true;
    readonly recordTo?: string;
    readonly waitFor?: string;
  };
}

/** Environment variable the scripted pi reads its behavior from; not `ATRIUM_*`, which the host keeps from pi. */
const BEHAVIOR_ENV = "SCRIPTED_PI_BEHAVIOR";

/** The scripted pi, a Node script; every command it receives is announced as `{type: "received", record}`. */
const SCRIPT = `
import { spawn } from "node:child_process";
import { closeSync, existsSync, writeFileSync } from "node:fs";
const behavior = JSON.parse(process.env.${BEHAVIOR_ENV} ?? "{}");
const sessionDir = process.argv.includes("--session-dir") ? process.argv[process.argv.indexOf("--session-dir") + 1] : "";
if (process.argv.includes("--version")) {
  process.stdout.write((behavior.version ?? "1.0.2") + "\\n");
  process.exit(0);
}
// Exit once orphaned: a test run killed on timeout never stops this process, and some behaviors
// ignore stdin closing and SIGTERM.
setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 500).unref();
const print = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
if (behavior.print !== undefined && process.argv.includes("-p")) {
  if (behavior.print.ignoreStdin) process.exit(behavior.print.exitCode ?? 0);
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", async () => {
    const grandchild = behavior.print.holdPipes
      ? spawn("sleep", ["60"], { stdio: ["ignore", "inherit", "inherit"] }).pid
      : null;
    const seen = { argv: process.argv.slice(2), cwd: process.cwd(), stdin: input, pid: process.pid, grandchild };
    if (behavior.print.recordTo !== undefined) writeFileSync(behavior.print.recordTo, JSON.stringify(seen));
    const gate = behavior.print.waitFor;
    while (gate !== undefined && !existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 20));
    if (behavior.print.stderrBytes !== undefined) {
      await new Promise((resolve) => process.stderr.write("x".repeat(behavior.print.stderrBytes), resolve));
    }
    for (const line of behavior.print.lines ?? []) {
      if (typeof line === "string") process.stdout.write(line + "\\n");
      else print(line);
    }
    if (behavior.print.unterminated !== undefined) process.stdout.write(behavior.print.unterminated);
    if (behavior.print.hang) setInterval(() => {}, 1 << 30);
    else process.stdout.write("", () => process.exit(behavior.print.exitCode ?? 0));
  });
  // Nothing below is for print mode.
  await new Promise(() => {});
}
if (behavior.announceArgv) print({ type: "argv", argv: process.argv.slice(2), cwd: process.cwd() });
if (behavior.announceEnv) {
  print({ type: "env", values: Object.fromEntries(behavior.announceEnv.map((name) => [name, process.env[name] ?? null])) });
}
if (behavior.argvToStderr) process.stderr.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
for (const line of behavior.stdout ?? []) process.stdout.write(line + "\\n");
if (behavior.stdoutUnterminated !== undefined) process.stdout.write(behavior.stdoutUnterminated);
if (behavior.stderr !== undefined) process.stderr.write(behavior.stderr);
if (behavior.stderrChunks !== undefined) {
  const pieces = [...behavior.stderrChunks];
  const writeNext = () => {
    const piece = pieces.shift();
    if (piece !== undefined) process.stderr.write(piece, () => setTimeout(writeNext, 10));
  };
  writeNext();
}
if (behavior.exitCode !== undefined) {
  process.exitCode = behavior.exitCode;
} else {
  if (behavior.ignoreSigterm) process.on("SIGTERM", () => {});
  if (behavior.closeStdin) {
    // Close fd 0 itself: destroying process.stdin leaves the descriptor open.
    closeSync(0);
    setInterval(() => {}, 1 << 30);
    print({ type: "stdin-closed" });
  }
  if (behavior.ignoreStdinEnd) setInterval(() => {}, 1 << 30);
  for (const mode of behavior.grandchildren ?? []) {
    const stdio = mode === "holds-pipes" ? ["ignore", "inherit", "inherit"] : "ignore";
    // Short-lived, so a grandchild orphaned by a killed test run goes away on its own.
    const child = spawn("sleep", ["60"], { detached: mode === "detached", stdio });
    print({ type: "grandchild", pid: child.pid, mode });
  }
  if (!behavior.closeStdin) {
    let pending = "";
    process.stdin.on("data", (chunk) => {
      pending += chunk;
      for (let end = pending.indexOf("\\n"); end !== -1; end = pending.indexOf("\\n")) {
        handle(JSON.parse(pending.slice(0, end)));
        pending = pending.slice(end + 1);
      }
    });
    process.stdin.on("end", () => {
      for (const record of atEnd) answer(record, behavior.rules[record.type]);
      // Exit once everything printed so far is flushed; macOS writes pipes asynchronously.
      if (!behavior.ignoreStdinEnd) process.stdout.write("", () => process.exit(0));
    });
  }
}
const answered = new Set();
let switched = null;
const counts = new Map();
let held = [];
const atEnd = [];
function ruleFor(type) {
  const rule = (behavior.rules ?? {})[type] ?? {};
  if (rule.sequence === undefined) return rule;
  const count = counts.get(type) ?? 0;
  counts.set(type, count + 1);
  return rule.sequence[Math.min(count, rule.sequence.length - 1)];
}
function handle(record) {
  print({ type: "received", record });
  if (behavior.receivedToStderr) process.stderr.write(JSON.stringify({ received: record }) + "\\n");
  if (record.type === "extension_ui_response") return;
  const rule = ruleFor(record.type);
  if (rule.exit !== undefined) process.exit(rule.exit);
  if (rule.silent) return;
  if (rule.atStdinEnd) atEnd.push(record);
  else if (rule.after !== undefined && !answered.has(rule.after)) held.push(record);
  else answer(record, rule);
}
function answer(record, rule) {
  if (rule.writes !== undefined) {
    writeFileSync(record.outputPath, typeof rule.writes === "number" ? "x".repeat(rule.writes) : rule.writes);
  }
  if (rule.switchesTo !== undefined) {
    const file = rule.switchesTo.file.replace("<session-dir>", sessionDir);
    writeFileSync(file, rule.switchesTo.text);
    switched = { ...rule.switchesTo, file };
  }
  const data =
    record.type === "get_state" && switched !== null
      ? { ...rule.data, sessionId: switched.sessionId, sessionFile: switched.file }
      : rule.data;
  for (const event of rule.events ?? []) print(event);
  const response = { type: "response", command: record.type, ...(rule.noId ? {} : { id: record.id }) };
  if (rule.fail !== undefined) print({ ...response, success: false, error: rule.fail });
  else print({ ...response, success: true, ...(data === undefined ? {} : { data }) });
  if (rule.twice) print({ ...response, success: true });
  if (rule.exitAfter !== undefined) process.stdout.write("", () => process.exit(rule.exitAfter));
  answered.add(record.type);
  const ready = held.filter((waiting) => answered.has(behavior.rules[waiting.type].after));
  held = held.filter((waiting) => !ready.includes(waiting));
  for (const waiting of ready) answer(waiting, behavior.rules[waiting.type]);
}
`;

/** The shared file every `writeScriptedPi` links to: the script run by this Node. */
const SCRIPTED_PI = `#!${process.execPath}\n${SCRIPT}`;

/**
 * Writes and runs the shared scripted pi once, before tests start.
 *
 * @remarks
 * See `sharedExecutable`: the first run of a new executable is the slow one.
 *
 * @sideEffects Writes the shared script if missing; runs it with `--version`.
 */
export async function warmScriptedPi(): Promise<void> {
  await warmExecutable(await sharedExecutable("scripted-pi.mjs", SCRIPTED_PI), ["--version"]);
}

/**
 * Puts an executable pi stand-in, scripted by `behavior`, into `dir`.
 *
 * @remarks
 * Adapter tests need pi to misbehave on cue (answer out of order, crash, ignore SIGTERM, leave
 * grandchildren behind), which real pi does not do reliably. The fake is a real child process, so
 * spawning, pipes, signals and process groups are all real (testing.md, "能用真的就用真的"); the
 * pi contract tests check the same adapter against real pi. It lives in testkit because both the
 * pi package and the host drive it. `dir` gets a symlink to one shared copy, so no test waits for
 * macOS to check a new executable (see `sharedExecutable`).
 *
 * @sideEffects Creates a symlink in `dir`; writes the shared script on first use.
 * @param dir - A temporary directory owned by the test.
 * @param behavior - What the fake does.
 * @param fileName - File name; `pi` lets code that searches PATH for pi find it.
 * @returns The executable path and the environment that carries the behavior.
 */
export async function writeScriptedPi(
  dir: string,
  behavior: ScriptedPiBehavior,
  fileName = "scripted-pi.mjs",
): Promise<{ readonly piPath: string; readonly env: Readonly<Record<string, string>> }> {
  const piPath = join(dir, fileName);
  await symlink(await sharedExecutable("scripted-pi.mjs", SCRIPTED_PI), piPath);
  return { piPath, env: { [BEHAVIOR_ENV]: JSON.stringify(behavior) } };
}
