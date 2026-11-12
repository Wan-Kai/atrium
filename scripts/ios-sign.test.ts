import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "ios-sign.mjs");
/** The real installer this script runs, so a test sees the same `devicectl` calls a run makes. */
const installer = join(import.meta.dirname, "ios.mjs");

/** What the stand-in for `xcrun` answers. */
interface Answers {
  /** What `devicectl list devices --json-output <file>` writes. */
  readonly devices?: unknown;
  /** How many `xcodebuild` calls fail, the way a broken main would. */
  readonly failBuilds?: number;
}

/**
 * A folder with a repository on `main`, a stand-in for `xcrun` and a place for the run's state.
 *
 * @remarks
 * git is real: the script makes a worktree, checks commits out and cleans them, and only Xcode is
 * stood in for, so nothing here touches a phone or builds anything (testing.md, "测试里的可执行文件").
 *
 * @sideEffects Makes a temporary folder, removed when the test ends.
 * @param answers - What the stand-in answers.
 * @returns The folder, the repository, the stand-in and the two commits on `main`.
 */
async function scene(answers: Answers) {
  const dir = await mkdtemp(join(tmpdir(), "atrium-ios-sign-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  await mkdir(repo);
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
      encoding: "utf8",
    });
  git(["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(repo, "one.txt"), "one\n");
  git(["add", "one.txt"]);
  git(["commit", "--quiet", "-m", "one"]);
  const first = git(["rev-parse", "HEAD"]).trim();
  await writeFile(join(repo, "two.txt"), "two\n");
  git(["add", "two.txt"]);
  git(["commit", "--quiet", "-m", "two"]);
  const last = git(["rev-parse", "HEAD"]).trim();

  const log = join(dir, "calls.jsonl");
  const count = join(dir, "builds.txt");
  const xcrun = join(dir, "xcrun.mjs");
  await writeFile(
    xcrun,
    [
      'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
      `const answers = ${JSON.stringify(answers)};`,
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
      'if (args[0] === "--find") process.exit(0);',
      'if (args[0] === "devicectl" && args[1] === "list") {',
      '  writeFileSync(args[args.indexOf("--json-output") + 1], JSON.stringify(answers.devices ?? { result: { devices: [] } }));',
      "  process.exit(0);",
      "}",
      'if (args[0] === "xcodebuild") {',
      `  const used = existsSync(${JSON.stringify(count)}) ? Number(readFileSync(${JSON.stringify(count)}, "utf8")) : 0;`,
      `  writeFileSync(${JSON.stringify(count)}, String(used + 1));`,
      '  if (used < (answers.failBuilds ?? 0)) { console.error("xcodebuild: error: no such build"); process.exit(65); }',
      "}",
      "process.exit(0);",
    ].join("\n"),
  );
  return { dir, repo, xcrun, log, first, last };
}

/**
 * Runs the script once and collects what it printed and the calls the stand-in saw.
 *
 * @sideEffects Runs the script, git and the stand-in.
 * @param stage - The folder and stand-in to run with.
 * @param args - More arguments, after the ones every run takes.
 * @returns What it printed, its exit code and the calls.
 */
async function sign(stage: Awaited<ReturnType<typeof scene>>, args: string[] = []) {
  const result = await run(
    process.execPath,
    [
      script,
      "--cache",
      join(stage.dir, "work"),
      "--state",
      join(stage.dir, "state"),
      "--ios",
      installer,
      stage.repo,
      ...args,
    ],
    { env: { ...process.env, ATRIUM_IOS_XCRUN: stage.xcrun } },
  ).then(
    ({ stdout, stderr }) => ({ output: stdout + stderr, code: 0 }),
    (error: unknown) => ({
      output: String(Reflect.get(Object(error), "stdout")) + String(Reflect.get(Object(error), "stderr")),
      code: Number(Reflect.get(Object(error), "code")),
    }),
  );
  const text = await readFile(stage.log, "utf8").catch(() => "");
  const calls = text
    .split("\n")
    .filter((line) => line !== "")
    .map((line): string[] => JSON.parse(line));
  return { ...result, calls };
}

/**
 * Counts the builds and the installs a run made.
 *
 * @sideEffects none
 * @param calls - What the stand-in saw.
 * @returns How many times each was called.
 */
function counts(calls: string[][]) {
  return {
    builds: calls.filter((call) => call[0] === "xcodebuild" && call[1] === "build").length,
    installs: calls.filter((call) => call.slice(0, 4).join(" ") === "devicectl device install app").length,
  };
}

/**
 * Writes what the last run would have left behind.
 *
 * @remarks
 * The profile's expiry is not readable without a real app built by Xcode, so a record is written
 * rather than made by an install.
 *
 * @sideEffects Makes the state folder and writes its `state.json`.
 * @param stage - The folder to write into.
 * @param state - The record.
 */
async function remember(stage: Awaited<ReturnType<typeof scene>>, state: unknown) {
  await mkdir(join(stage.dir, "state"), { recursive: true });
  await writeFile(join(stage.dir, "state", "state.json"), JSON.stringify(state));
}

/**
 * Reads what the run recorded.
 *
 * @sideEffects Reads the state file.
 * @param stage - The folder to read from.
 * @returns The record, or `null` when there is none.
 */
async function recorded(stage: Awaited<ReturnType<typeof scene>>) {
  const text = await readFile(join(stage.dir, "state", "state.json"), "utf8").catch(() => null);
  return text === null ? null : JSON.parse(text);
}

/** A phone `devicectl` can reach over this Wi-Fi. */
const phone = {
  connectionProperties: {
    pairingState: "paired",
    tunnelState: "connected",
    lastConnectionDate: "2026-11-09T09:32:00.000Z",
  },
  deviceProperties: { name: "Test iPhone" },
  hardwareProperties: {
    deviceType: "iPhone",
    marketingName: "iPhone 16 Pro",
    reality: "physical",
    udid: "00008140-TEST",
  },
};

/** A phone that is paired but not on this network, as `devicectl` describes one that is away. */
const away = { ...phone, connectionProperties: { ...phone.connectionProperties, tunnelState: "unavailable" } };

describe("ios-sign.mjs", () => {
  it("installs main's latest commit on a reachable iPhone, without opening the app, and remembers it", async () => {
    const stage = await scene({ devices: { result: { devices: [phone] } } });
    const result = await sign(stage);

    expect(result.code).toBe(0);
    expect(counts(result.calls)).toStrictEqual({ builds: 1, installs: 1 });
    expect(result.calls.some((call) => call.slice(0, 3).join(" ") === "devicectl device process")).toBe(false);
    expect(result.output).toContain("installing on Test iPhone");
    expect(execFileSync("git", ["-C", join(stage.dir, "work"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(
      stage.last,
    );
    expect((await recorded(stage)).commit).toBe(stage.last);
  });

  it("builds nothing at all when the iPhone is not on this network", async () => {
    const stage = await scene({ devices: { result: { devices: [away] } } });
    const result = await sign(stage);

    expect(result.code).toBe(0);
    expect(counts(result.calls)).toStrictEqual({ builds: 0, installs: 0 });
    expect(result.output).toContain("no iPhone on this network");
    expect(await recorded(stage)).toBeNull();
  });

  it("does nothing when the phone already has main and its signature has days left", async () => {
    const stage = await scene({ devices: { result: { devices: [phone] } } });
    await remember(stage, {
      commit: stage.last,
      installedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const result = await sign(stage);

    expect(result.code).toBe(0);
    expect(counts(result.calls)).toStrictEqual({ builds: 0, installs: 0 });
    expect(result.output).toContain("nothing to do");
    expect(existsSync(join(stage.dir, "work"))).toBe(false);
  });

  it("trusts 7 days from the install when the last run could not read the profile's expiry", async () => {
    const stage = await scene({ devices: { result: { devices: [phone] } } });
    await remember(stage, { commit: stage.last, installedAt: new Date().toISOString(), expiresAt: null });
    const result = await sign(stage);

    expect(result.code).toBe(0);
    expect(counts(result.calls)).toStrictEqual({ builds: 0, installs: 0 });
  });

  it("re-signs the same commit when what the phone has is about to run out", async () => {
    const stage = await scene({ devices: { result: { devices: [phone] } } });
    await remember(stage, {
      commit: stage.last,
      installedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    const result = await sign(stage);

    expect(result.code).toBe(0);
    expect(counts(result.calls)).toStrictEqual({ builds: 1, installs: 1 });
  });

  it("installs the last commit that built when main does not, so the signature is renewed anyway", async () => {
    const stage = await scene({ devices: { result: { devices: [phone] } }, failBuilds: 1 });
    await remember(stage, {
      commit: stage.first,
      installedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const result = await sign(stage);

    expect(result.code).toBe(0);
    expect(counts(result.calls)).toStrictEqual({ builds: 2, installs: 1 });
    expect(result.output).toContain("did not build and install");
    expect(result.output).toContain("the last commit that built");
    expect((await recorded(stage)).commit).toBe(stage.first);
  });

  it("fails when neither main nor the last commit that built can be installed", async () => {
    const stage = await scene({ devices: { result: { devices: [phone] } }, failBuilds: 2 });
    await remember(stage, {
      commit: stage.first,
      installedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const result = await sign(stage);

    expect(result.code).toBe(1);
    expect(counts(result.calls)).toStrictEqual({ builds: 2, installs: 0 });
    expect(result.output).toContain("nothing could be installed");
  });

  it("leaves a run alone when another one is still going", async () => {
    const stage = await scene({ devices: { result: { devices: [phone] } } });
    await mkdir(join(stage.dir, "state", "run.lock"), { recursive: true });
    await writeFile(
      join(stage.dir, "state", "run.lock", "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const result = await sign(stage);

    expect(result.code).toBe(0);
    expect(counts(result.calls)).toStrictEqual({ builds: 0, installs: 0 });
    expect(result.output).toContain("another run is still installing");
  });
});
