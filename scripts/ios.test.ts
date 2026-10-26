import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "ios.mjs");

/** What the stand-in for `xcrun` answers, by the first two arguments. */
interface Answers {
  /** Exit code of `xcrun --find xcodebuild`; 0 means Xcode is there. */
  readonly xcode?: number;
  /** What `devicectl list devices --json-output <file>` writes. */
  readonly devices?: unknown;
  /** What `simctl list devices available -j` prints. */
  readonly simulators?: unknown;
  /** What `simctl list runtimes available -j` prints. */
  readonly runtimes?: unknown;
  /** A call to fail: when the arguments start with `args`, print both texts and exit 1. */
  readonly fail?: { readonly args: string; readonly stdout: string; readonly stderr: string };
}

/**
 * A folder with a stand-in for `xcrun` that logs each call and answers as told.
 *
 * @remarks
 * Nothing of Xcode runs and no phone or simulator is touched; the stand-in is a Node script, so no
 * new executable has to pass macOS's first-run check (testing.md, "测试里的可执行文件").
 *
 * @sideEffects Makes a temporary folder, removed when the test ends.
 * @param answers - What the stand-in answers.
 * @returns The folder, the stand-in and its log.
 */
async function scene(answers: Answers) {
  const dir = await mkdtemp(join(tmpdir(), "atrium-ios-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "calls.jsonl");
  const xcrun = join(dir, "xcrun.mjs");
  await writeFile(
    xcrun,
    [
      'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
      `const answers = ${JSON.stringify(answers)};`,
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
      // Whether the script running this holds the simulator lock, for each call.
      "let owner = null;",
      'try { owner = JSON.parse(readFileSync(process.env.ATRIUM_IOS_LOCK + "/owner.json", "utf8")).pid; } catch {}',
      `appendFileSync(${JSON.stringify(join(dir, "locked.txt"))}, args.slice(0, 2).join(" ") + " | " + (owner === process.ppid ? "held" : "free") + "\\n");`,
      "const at = (word) => args.indexOf(word);",
      'if (answers.fail && args.join(" ").startsWith(answers.fail.args)) { console.log(answers.fail.stdout); console.error(answers.fail.stderr); process.exit(1); }',
      'if (args[0] === "--find") process.exit(answers.xcode ?? 0);',
      'if (args[0] === "devicectl" && args[1] === "list") writeFileSync(args[at("--json-output") + 1], JSON.stringify(answers.devices ?? { result: { devices: [] } }));',
      'if (args[0] === "simctl" && args[2] === "devices") console.log(JSON.stringify(answers.simulators ?? { devices: {} }));',
      'if (args[0] === "simctl" && args[2] === "runtimes") console.log(JSON.stringify(answers.runtimes ?? { runtimes: [] }));',
      'if (args[0] === "simctl" && args[1] === "create") console.log("NEW-SIM-UDID");',
    ].join("\n"),
  );
  return { dir, xcrun, log };
}

/**
 * Runs `scripts/ios.mjs` with the stand-in, never failing on its exit code.
 *
 * @sideEffects Runs the script, which runs the stand-in.
 * @param xcrun - The stand-in.
 * @param log - The stand-in's log.
 * @param args - The script's arguments.
 * @param extra - More environment, such as how long to wait for the simulator lock.
 * @returns What it printed, its exit code, and the calls the stand-in saw.
 */
async function ios(xcrun: string, log: string, args: string[], extra: Record<string, string> = {}) {
  const lock = join(log, "..", "sim.lock");
  const env = {
    ...process.env,
    ATRIUM_IOS_XCRUN: xcrun,
    ATRIUM_IOS_LOCK: lock,
    ATRIUM_IOS_SHOT_DELAY_MS: "0",
    ...extra,
  };
  const result = await run(process.execPath, [script, ...args], { env }).then(
    ({ stdout, stderr }) => ({ output: stdout + stderr, code: 0 }),
    (error: unknown) => ({
      output: String(Reflect.get(Object(error), "stdout")) + String(Reflect.get(Object(error), "stderr")),
      code: Number(Reflect.get(Object(error), "code")),
    }),
  );
  const text = await readFile(log, "utf8").catch(() => "");
  const calls = text
    .split("\n")
    .filter((line) => line !== "")
    .map((line): string[] => JSON.parse(line));
  return { ...result, calls };
}

/**
 * Makes one device as `devicectl list devices` describes it.
 *
 * @sideEffects none
 * @param tunnelState - `connected`, `disconnected` or `unavailable`.
 * @param pairingState - `paired` or `unpaired`.
 * @returns The device.
 */
function phone(tunnelState: string, pairingState = "paired") {
  return {
    connectionProperties: { pairingState, tunnelState, lastConnectionDate: "2026-09-10T09:32:00.000Z" },
    deviceProperties: { name: "Test iPhone" },
    hardwareProperties: {
      deviceType: "iPhone",
      marketingName: "iPhone 16 Pro",
      platform: "iOS",
      reality: "physical",
      udid: "00008140-TEST",
    },
  };
}

const simulator = { name: "Atrium iPhone 16 Pro", udid: "SIM-UDID", state: "Shutdown" };

describe("ios.mjs install", () => {
  it("stops before building when no iPhone has been paired, saying how to pair one", async () => {
    const { xcrun, log } = await scene({ devices: { result: { devices: [phone("unavailable", "unpaired")] } } });
    const result = await ios(xcrun, log, ["install"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("no paired iPhone");
    expect(result.output).toContain("cable");
    expect(result.calls.some((call) => call[0] === "xcodebuild")).toBe(false);
  });

  it("stops before building when the paired iPhone is not connected, naming it and when it was last seen", async () => {
    const { xcrun, log } = await scene({ devices: { result: { devices: [phone("unavailable")] } } });
    const result = await ios(xcrun, log, ["install"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("Test iPhone (iPhone 16 Pro) is paired but not connected");
    expect(result.output).toContain("last seen 2026-09-10");
    expect(result.calls.some((call) => call[0] === "xcodebuild")).toBe(false);
  });

  it("uses a paired iPhone that devicectl describes without reality or a marketing name", async () => {
    // Xcode 26.6's devicectl, for a wired iPhone 16 Pro just paired (2026-10-26): no
    // hardwareProperties.reality or marketingName, and the tunnel is still "disconnected".
    const bare = phone("disconnected");
    const { reality: _reality, marketingName: _marketingName, ...hardware } = bare.hardwareProperties;
    const { xcrun, log } = await scene({
      devices: { result: { devices: [{ ...bare, hardwareProperties: { ...hardware, productType: "iPhone17,1" } }] } },
    });
    const result = await ios(xcrun, log, ["install"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain("installing on Test iPhone");
    expect(result.calls.some((call) => call.slice(0, 4).join(" ") === "devicectl device install app")).toBe(true);
  });

  it("names a paired iPhone that is away by its product type when devicectl gives no marketing name", async () => {
    const bare = phone("unavailable");
    const { marketingName: _marketingName, ...hardware } = bare.hardwareProperties;
    const { xcrun, log } = await scene({
      devices: { result: { devices: [{ ...bare, hardwareProperties: { ...hardware, productType: "iPhone17,1" } }] } },
    });
    const result = await ios(xcrun, log, ["install"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("Test iPhone (iPhone17,1) is paired but not connected");
  });

  it("says how to trust the developer when the phone refuses to open an app it has not trusted yet", async () => {
    const { xcrun, log } = await scene({
      devices: { result: { devices: [phone("connected")] } },
      fail: {
        args: "devicectl device process launch",
        stdout: "",
        // devicectl's words on the first install of a free-team app (2026-10-26).
        stderr:
          "ERROR: The application failed to launch. ... Unable to launch site.ktoon.atrium because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.",
      },
    });
    const result = await ios(xcrun, log, ["install"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("installed, but the iPhone has not trusted this developer yet");
    expect(result.output).toContain("Settings › General › VPN & Device Management");
    expect(result.output).toContain("pnpm ios:install");
  });

  it("builds for devices with provisioning updates, installs on the connected iPhone and opens the app", async () => {
    const { xcrun, log } = await scene({ devices: { result: { devices: [phone("connected")] } } });
    const result = await ios(xcrun, log, ["install"]);
    const build = result.calls.find((call) => call[0] === "xcodebuild");
    const install = result.calls.find((call) => call.slice(0, 4).join(" ") === "devicectl device install app");

    expect(result.code).toBe(0);
    expect(build).toStrictEqual([
      "xcodebuild",
      "build",
      "-project",
      expect.stringMatching(/apps\/ios\/Atrium\.xcodeproj$/u),
      "-scheme",
      "Atrium",
      "-configuration",
      "Debug",
      "-destination",
      "generic/platform=iOS",
      "-derivedDataPath",
      expect.stringMatching(/apps\/ios\/\.build\/xcode$/u),
      "-allowProvisioningUpdates",
      "-quiet",
    ]);
    expect(install).toStrictEqual([
      "devicectl",
      "device",
      "install",
      "app",
      "--device",
      "00008140-TEST",
      expect.stringMatching(/Debug-iphoneos\/Atrium\.app$/u),
    ]);
    expect(result.calls.at(-1)).toStrictEqual([
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      "00008140-TEST",
      "site.ktoon.atrium",
    ]);
  });
});

describe("ios.mjs test", () => {
  it("runs AtriumKit's tests with warnings as errors, then the UI tests on the Atrium simulator", async () => {
    const { xcrun, log } = await scene({
      simulators: { devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [simulator] } },
    });
    const result = await ios(xcrun, log, ["test"]);

    expect(result.code).toBe(0);
    expect(result.calls[1]).toStrictEqual([
      "swift",
      "test",
      "--package-path",
      expect.stringMatching(/apps\/ios\/AtriumKit$/u),
      "--explicit-target-dependency-import-check",
      "error",
      "-Xswiftc",
      "-warnings-as-errors",
    ]);
    expect(result.calls.at(-1)).toStrictEqual([
      "xcodebuild",
      "test",
      "-project",
      expect.stringMatching(/Atrium\.xcodeproj$/u),
      "-scheme",
      "Atrium",
      "-destination",
      expect.stringMatching(/^id=SIM-UDID,arch=(?:arm64|x86_64)$/u),
      "-derivedDataPath",
      expect.stringMatching(/\.build\/xcode$/u),
      "-quiet",
    ]);
  });

  it("makes the Atrium simulator on the newest iOS runtime when it is missing", async () => {
    const runtimes = {
      runtimes: [
        { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4", platform: "iOS", version: "26.4" },
        { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-10", platform: "iOS", version: "26.10" },
        { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-26-5", platform: "watchOS", version: "26.50" },
      ],
    };
    const { xcrun, log } = await scene({ runtimes });
    const result = await ios(xcrun, log, ["test"]);

    expect(result.calls).toContainEqual([
      "simctl",
      "create",
      "Atrium iPhone 16 Pro",
      "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
      "com.apple.CoreSimulator.SimRuntime.iOS-26-10",
    ]);
    expect(result.calls.at(-1)?.join(" ")).toContain("id=NEW-SIM-UDID,arch=");
  });
});

describe("ios.mjs failures", () => {
  it("prints the command, its output and its errors when a quiet Xcode call fails", async () => {
    const fail = {
      args: "simctl list devices",
      stdout: "partial list",
      stderr: "CoreSimulatorService connection became invalid",
    };
    const { xcrun, log } = await scene({ fail });
    const result = await ios(xcrun, log, ["test"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("xcrun simctl list devices available -j failed with exit code 1");
    expect(result.output).toContain("partial list");
    expect(result.output).toContain("CoreSimulatorService connection became invalid");
  });

  it("stays quiet when Xcode is only being looked for", async () => {
    const { xcrun, log } = await scene({ xcode: 1 });
    const result = await ios(xcrun, log, ["check"]);

    expect(result.output).not.toContain("failed with exit code");
  });
});

describe("ios.mjs check", () => {
  it("still compares the generated protocol types without Xcode, and skips the Swift checks saying why", async () => {
    const { xcrun, log } = await scene({ xcode: 1 });
    const result = await ios(xcrun, log, ["check"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain("Swift checks skipped: Xcode not found");
    expect(result.calls).toStrictEqual([["--find", "xcodebuild"]]);
  });

  it("refuses the iOS commands without Xcode", async () => {
    const { xcrun, log } = await scene({ xcode: 1 });
    const result = await ios(xcrun, log, ["build"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("needs Xcode");
  });
});

/**
 * Reads, for each call the stand-in saw, whether the script held the simulator lock then.
 *
 * @sideEffects Reads the stand-in's record.
 * @param dir - The scene's folder.
 * @returns Lines of `<tool> <first argument> | held|free`.
 */
async function lockedCalls(dir: string) {
  return (await readFile(join(dir, "locked.txt"), "utf8")).trim().split("\n");
}

/**
 * Writes a simulator lock as another process would leave it.
 *
 * @sideEffects Makes the lock folder and its owner file in the scene's folder.
 * @param dir - The scene's folder.
 * @param owner - The owner file's content, or `null` for a lock without one.
 * @returns The lock's path.
 */
async function lockedBy(dir: string, owner: object | null) {
  const lock = join(dir, "sim.lock");
  await mkdir(lock);
  if (owner !== null) await writeFile(join(lock, "owner.json"), JSON.stringify(owner));
  return lock;
}

/**
 * Says when a process started, as `ps` writes it.
 *
 * @sideEffects Runs `ps`.
 * @param pid - The process.
 * @returns Its start time.
 */
function startedAt(pid: number) {
  return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
}

const atrium = { devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [simulator] } };

describe("ios.mjs simulator lock", () => {
  it("holds the lock from finding the simulator to the end of the UI tests, but not for the Swift tests, and lets it go", async () => {
    const { dir, xcrun, log } = await scene({ simulators: atrium });
    const result = await ios(xcrun, log, ["test"]);

    expect(result.code).toBe(0);
    expect(await lockedCalls(dir)).toStrictEqual([
      "--find xcodebuild | free",
      "swift test | free",
      "simctl list | held",
      "xcodebuild test | held",
    ]);
    await expect(stat(join(dir, "sim.lock"))).rejects.toThrow("ENOENT");
  });

  it("holds the lock for the whole screenshot, from finding the simulator to taking the picture", async () => {
    const { dir, xcrun, log } = await scene({ simulators: atrium });
    const result = await ios(xcrun, log, ["shot"]);
    const seen = await lockedCalls(dir);

    expect(result.code).toBe(0);
    expect(seen.slice(1).every((line) => line.endsWith("| held"))).toBe(true);
    expect(seen.at(1)).toBe("simctl list | held");
    expect(seen.at(-1)).toBe("simctl io | held");
    await expect(stat(join(dir, "sim.lock"))).rejects.toThrow("ENOENT");
  });

  it("waits for a lock a running process holds, then gives up naming it, and leaves the lock alone", async () => {
    const { dir, xcrun, log } = await scene({ simulators: atrium });
    const owner = { pid: process.pid, started: startedAt(process.pid), worktree: "/work/other", command: "ios:shot" };
    const lock = await lockedBy(dir, owner);
    const result = await ios(xcrun, log, ["test"], { ATRIUM_IOS_LOCK_WAIT_MS: "1200" });

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `waiting for the Atrium simulator: pid ${process.pid} (pnpm ios:shot in /work/other)`,
    );
    expect(result.output).toContain("gave up waiting for the Atrium simulator");
    expect(result.calls.some((call) => call[0] === "simctl")).toBe(false);
    expect(JSON.parse(await readFile(join(lock, "owner.json"), "utf8"))).toStrictEqual(owner);
  });

  it("waits for a lock just made whose owner is not written yet", async () => {
    const { dir, xcrun, log } = await scene({ simulators: atrium });
    await lockedBy(dir, null);
    const result = await ios(xcrun, log, ["test"], { ATRIUM_IOS_LOCK_WAIT_MS: "300" });

    expect(result.code).toBe(1);
    expect(result.calls.some((call) => call[0] === "simctl")).toBe(false);
  });

  it.each([
    ["whose process is gone", () => ({ pid: deadPid(), started: "Thu Jan  1 00:00:00 1970" })],
    ["whose pid now belongs to another process", () => ({ pid: process.pid, started: "Thu Jan  1 00:00:00 1970" })],
  ])("takes over a lock %s", async (_case, owner) => {
    const { dir, xcrun, log } = await scene({ simulators: atrium });
    await lockedBy(dir, { ...owner(), worktree: "/work/other", command: "test:ios" });
    const result = await ios(xcrun, log, ["test"], { ATRIUM_IOS_LOCK_WAIT_MS: "300" });

    expect(result.code).toBe(0);
    expect(result.output).toContain("took over the Atrium simulator from pid");
    expect(await lockedCalls(dir)).toContain("xcodebuild test | held");
  });

  it("takes over a lock left without an owner long ago", async () => {
    const { dir, xcrun, log } = await scene({ simulators: atrium });
    const lock = await lockedBy(dir, null);
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    const result = await ios(xcrun, log, ["test"], { ATRIUM_IOS_LOCK_WAIT_MS: "300" });

    expect(result.code).toBe(0);
    expect(await lockedCalls(dir)).toContain("xcodebuild test | held");
  });
});

/**
 * Gives the pid of a process that has already ended.
 *
 * @sideEffects Runs and waits for a short process.
 * @returns Its pid.
 */
function deadPid() {
  return Number(execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim());
}
