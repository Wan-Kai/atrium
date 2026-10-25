import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      'import { appendFileSync, writeFileSync } from "node:fs";',
      `const answers = ${JSON.stringify(answers)};`,
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
      "const at = (word) => args.indexOf(word);",
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
 * @param args - The script's arguments.
 * @returns What it printed, its exit code, and the calls the stand-in saw.
 */
async function ios(xcrun: string, log: string, args: string[]) {
  const env = { ...process.env, ATRIUM_IOS_XCRUN: xcrun };
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
      "id=SIM-UDID",
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
    expect(result.calls.at(-1)).toContain("id=NEW-SIM-UDID");
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
