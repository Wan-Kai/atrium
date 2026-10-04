import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** How the fake pi answers one command type. */
export interface FakeRule {
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
}

/** Everything the fake pi does. */
export interface FakeBehavior {
  readonly rules?: Readonly<Record<string, FakeRule>>;
  /** Raw lines printed to stdout at start. */
  readonly stdout?: readonly string[];
  /** Raw text printed to stdout at start without a line break. */
  readonly stdoutUnterminated?: string;
  /** Print `{type: "argv", argv}` with the arguments it was started with. */
  readonly announceArgv?: true;
  /** Raw text written to stderr at start. */
  readonly stderr?: string;
  /** Exit with this code right after start. */
  readonly exitCode?: number;
  /** Keep running after stdin closes. */
  readonly ignoreStdinEnd?: true;
  /** Keep running after SIGTERM. */
  readonly ignoreSigterm?: true;
  /** Start `sleep` children; each is announced as `{type: "grandchild", pid, mode}`. */
  readonly grandchildren?: readonly ("detached" | "attached" | "holds-pipes")[];
}

/** Environment variable the fake pi reads its behavior from. */
const BEHAVIOR_ENV = "ATRIUM_FAKE_PI";

/** The fake pi, a Node script; every command it receives is announced as `{type: "received", record}`. */
const SCRIPT = `
import { spawn } from "node:child_process";
const behavior = JSON.parse(process.env.${BEHAVIOR_ENV} ?? "{}");
// Exit once orphaned: a test run killed on timeout never stops this process, and some behaviors
// ignore stdin closing and SIGTERM.
setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 500).unref();
const print = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
if (behavior.announceArgv) print({ type: "argv", argv: process.argv.slice(2) });
for (const line of behavior.stdout ?? []) process.stdout.write(line + "\\n");
if (behavior.stdoutUnterminated !== undefined) process.stdout.write(behavior.stdoutUnterminated);
if (behavior.stderr !== undefined) process.stderr.write(behavior.stderr);
if (behavior.exitCode !== undefined) {
  process.exitCode = behavior.exitCode;
} else {
  if (behavior.ignoreSigterm) process.on("SIGTERM", () => {});
  if (behavior.ignoreStdinEnd) setInterval(() => {}, 1 << 30);
  for (const mode of behavior.grandchildren ?? []) {
    const stdio = mode === "holds-pipes" ? ["ignore", "inherit", "inherit"] : "ignore";
    // Short-lived, so a grandchild orphaned by a killed test run goes away on its own.
    const child = spawn("sleep", ["60"], { detached: mode === "detached", stdio });
    print({ type: "grandchild", pid: child.pid, mode });
  }
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
const answered = new Set();
let held = [];
const atEnd = [];
function handle(record) {
  print({ type: "received", record });
  if (record.type === "extension_ui_response") return;
  const rule = (behavior.rules ?? {})[record.type] ?? {};
  if (rule.exit !== undefined) process.exit(rule.exit);
  if (rule.silent) return;
  if (rule.atStdinEnd) atEnd.push(record);
  else if (rule.after !== undefined && !answered.has(rule.after)) held.push(record);
  else answer(record, rule);
}
function answer(record, rule) {
  for (const event of rule.events ?? []) print(event);
  const response = { type: "response", command: record.type, ...(rule.noId ? {} : { id: record.id }) };
  if (rule.fail !== undefined) print({ ...response, success: false, error: rule.fail });
  else print({ ...response, success: true, ...(rule.data === undefined ? {} : { data: rule.data }) });
  if (rule.twice) print({ ...response, success: true });
  answered.add(record.type);
  const ready = held.filter((waiting) => answered.has(behavior.rules[waiting.type].after));
  held = held.filter((waiting) => !ready.includes(waiting));
  for (const waiting of ready) answer(waiting, behavior.rules[waiting.type]);
}
`;

/**
 * Writes an executable fake pi into `dir`.
 *
 * @remarks
 * Adapter tests need pi to misbehave on cue (answer out of order, crash, ignore SIGTERM, leave
 * grandchildren behind), which real pi does not do reliably. The fake is a real child process, so
 * spawning, pipes, signals and process groups are all real (testing.md, "能用真的就用真的"); the
 * pi contract tests check the same adapter against real pi.
 *
 * @sideEffects Writes an executable file.
 * @param dir - A temporary directory owned by the test.
 * @param behavior - What the fake does.
 * @returns The executable path and the environment that carries the behavior.
 */
export async function writeFakePi(
  dir: string,
  behavior: FakeBehavior,
): Promise<{ readonly piPath: string; readonly env: Readonly<Record<string, string>> }> {
  const piPath = join(dir, "fake-pi.mjs");
  await writeFile(piPath, `#!${process.execPath}\n${SCRIPT}`);
  await chmod(piPath, 0o755);
  return { piPath, env: { [BEHAVIOR_ENV]: JSON.stringify(behavior) } };
}
