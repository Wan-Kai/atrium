import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The phone app's commands: checks, tests, builds, installing on the iPhone and screenshots.
 *
 * `node scripts/ios.mjs <check|kit|test|build|install|format|shot> [options]` (`kit --if-xcode` skips
 * without Xcode, for `pnpm test`), behind `pnpm ios:*`,
 * `pnpm test:ios` and `pnpm check` (development.md "命令"; testing.md "Swift（手机端）"). Every
 * Xcode tool runs through `xcrun`; `ATRIUM_IOS_XCRUN` swaps it for a Node stand-in in this
 * script's own test. `scripts/` is assembly code, so it may wait on real time (coding-standards).
 */

const root = join(import.meta.dirname, "..");
const ios = join(root, "apps", "ios");
const kit = join(ios, "AtriumKit");
const project = join(ios, "Atrium.xcodeproj");
const derivedData = join(ios, ".build", "xcode");
const bundleId = "site.ktoon.atrium";
const simulatorName = "Atrium iPhone 16 Pro";
const simulatorType = "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro";
/** What `swift-format` reads; the generated file opts out with `swift-format-ignore-file`. */
const swiftPaths = [
  join(kit, "Package.swift"),
  join(kit, "Sources"),
  join(kit, "Tests"),
  join(ios, "Atrium"),
  join(ios, "AtriumUITests"),
];

/**
 * Runs an Xcode tool through `xcrun`, or through the stand-in.
 *
 * @remarks
 * See the module comment.
 *
 * @sideEffects Runs a process; with `capture` false its output goes to this terminal.
 * @param {string[]} args - The tool and its arguments.
 * @param {{ capture?: boolean }} [options] - Whether to collect the output instead of showing it.
 * @returns {{ status: number, stdout: string }} The exit code and, when captured, the output.
 */
function xcrun(args, options = {}) {
  const standIn = process.env["ATRIUM_IOS_XCRUN"];
  const [command, commandArgs] = standIn === undefined ? ["xcrun", args] : [process.execPath, [standIn, ...args]];
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: options.capture === true ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

/**
 * Runs an Xcode tool and stops this script if it fails.
 *
 * @remarks
 * Each step of a build or install needs the one before it.
 *
 * @sideEffects Runs a process; exits with its code when it fails.
 * @param {string[]} args - The tool and its arguments.
 * @param {{ capture?: boolean }} [options] - Whether to collect the output instead of showing it.
 * @returns {string} The output when captured, else an empty string.
 */
function must(args, options = {}) {
  const result = xcrun(args, options);
  if (result.status !== 0) process.exit(result.status);
  return result.stdout;
}

/**
 * Tells whether a full Xcode is installed.
 *
 * @remarks
 * The Command Line Tools have `swift` but no `xcodebuild`, simulators or `devicectl`.
 *
 * @sideEffects Runs `xcrun --find xcodebuild`.
 * @returns {boolean} Whether Xcode is there.
 */
function hasXcode() {
  return xcrun(["--find", "xcodebuild"], { capture: true }).status === 0;
}

/**
 * Stops with a clear message when Xcode is missing.
 *
 * @remarks
 * Unlike `pnpm check` and `pnpm test`, which skip the Swift part, these commands cannot do anything
 * without it.
 *
 * @sideEffects Exits with 1 when Xcode is missing.
 * @param {string} command - The command, for the message.
 */
function requireXcode(command) {
  if (hasXcode()) return;
  console.error(`pnpm ios:${command} needs Xcode (xcrun could not find xcodebuild)`);
  process.exit(1);
}

/**
 * Runs AtriumKit's Swift Testing tests on macOS.
 *
 * @remarks
 * Warnings fail the build here rather than in `Package.swift` (coding-standards "Swift（手机端）"),
 * and an import of a module a target does not declare fails it too (overview.md "iOS 工程").
 *
 * @sideEffects Builds and runs the tests.
 * @returns {number} The exit code.
 */
function testKit() {
  return xcrun([
    "swift",
    "test",
    "--package-path",
    kit,
    "--explicit-target-dependency-import-check",
    "error",
    "-Xswiftc",
    "-warnings-as-errors",
  ]).status;
}

/**
 * Finds the Atrium simulator, making it on the newest iOS runtime when it is missing.
 *
 * @remarks
 * Tests and screenshots always use the same iPhone 16 Pro (the user's phone; testing.md).
 *
 * @sideEffects Runs `simctl`; may create a simulator.
 * @returns {{ udid: string, state: string }} The simulator.
 */
function simulator() {
  const { devices } = JSON.parse(must(["simctl", "list", "devices", "available", "-j"], { capture: true }));
  for (const [runtime, list] of Object.entries(devices)) {
    const found = runtime.includes(".iOS-") ? list.find((device) => device.name === simulatorName) : undefined;
    if (found !== undefined) return { udid: found.udid, state: found.state };
  }
  const { runtimes } = JSON.parse(must(["simctl", "list", "runtimes", "available", "-j"], { capture: true }));
  const newest = runtimes
    .filter((runtime) => runtime.platform === "iOS")
    .toSorted((a, b) => compareVersions(b.version, a.version))[0];
  if (newest === undefined) {
    console.error("no iOS simulator runtime installed: add one in Xcode › Settings › Components");
    process.exit(1);
  }
  const udid = must(["simctl", "create", simulatorName, simulatorType, newest.identifier], { capture: true }).trim();
  return { udid, state: "Shutdown" };
}

/**
 * Orders two dotted version numbers.
 *
 * @remarks
 * `26.10` is newer than `26.4`, which a string comparison gets wrong.
 *
 * @sideEffects none
 * @param {string} a - One version.
 * @param {string} b - The other.
 * @returns {number} Negative when `a` is older, positive when newer, 0 when equal.
 */
function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Builds the app with `xcodebuild`.
 *
 * @remarks
 * For devices it lets Xcode make the 7-day profile of the free team signed into Xcode
 * (`-allowProvisioningUpdates`; overview.md "iOS 工程").
 *
 * @sideEffects Builds into `apps/ios/.build/xcode`; exits when the build fails.
 * @param {string} destination - The `-destination` value.
 */
function build(destination) {
  must([
    "xcodebuild",
    "build",
    "-project",
    project,
    "-scheme",
    "Atrium",
    "-configuration",
    "Debug",
    "-destination",
    destination,
    "-derivedDataPath",
    derivedData,
    "-allowProvisioningUpdates",
    "-quiet",
  ]);
}

/**
 * Picks the iPhone to install on, or explains why there is none.
 *
 * @remarks
 * `devicectl` lists paired phones even when they are away; `unavailable` means it cannot reach
 * them, by cable or Wi-Fi. Checked before building so a missing phone does not cost a build.
 *
 * @sideEffects Runs `devicectl`; prints why when no iPhone can be used.
 * @returns {string | null} The iPhone's UDID, or `null` when there is none to use.
 */
function connectedPhone() {
  const dir = mkdtempSync(join(tmpdir(), "atrium-devices-"));
  try {
    const file = join(dir, "devices.json");
    must(["devicectl", "list", "devices", "--json-output", file], { capture: true });
    const phones = JSON.parse(readFileSync(file, "utf8")).result.devices.filter(
      (device) =>
        device.hardwareProperties?.reality === "physical" &&
        device.hardwareProperties?.deviceType === "iPhone" &&
        device.connectionProperties?.pairingState === "paired",
    );
    const usable = phones.find((device) => device.connectionProperties.tunnelState !== "unavailable");
    if (usable !== undefined) {
      console.log(`installing on ${usable.deviceProperties.name}`);
      return usable.hardwareProperties.udid;
    }
    if (phones.length === 0) {
      console.error(
        "pnpm ios:install: no paired iPhone. Connect it to this Mac with a cable, unlock it, tap Trust, " +
          "and turn on Developer Mode (Settings › Privacy & Security), then try again.",
      );
    }
    for (const device of phones) {
      const seen = device.connectionProperties.lastConnectionDate?.slice(0, 16).replace("T", " ") ?? "never";
      console.error(
        `pnpm ios:install: ${device.deviceProperties.name} (${device.hardwareProperties.marketingName}) is paired ` +
          `but not connected (last seen ${seen} UTC). Connect it with a cable, or unlock it on the same Wi-Fi ` +
          "as this Mac, then try again.",
      );
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Builds the app, installs it on the connected iPhone and opens it.
 *
 * @remarks
 * `pnpm ios:install` (SPEC-0005 "安装"). The free team's signature lasts 7 days; running this
 * again re-signs and keeps the keychain, since bundle id and team stay the same.
 *
 * @sideEffects Builds, installs on the phone and launches the app; exits on any failure.
 */
function install() {
  const udid = connectedPhone();
  if (udid === null) process.exit(1);
  build("generic/platform=iOS");
  must([
    "devicectl",
    "device",
    "install",
    "app",
    "--device",
    udid,
    join(derivedData, "Build", "Products", "Debug-iphoneos", "Atrium.app"),
  ]);
  must(["devicectl", "device", "process", "launch", "--device", udid, bundleId]);
}

/**
 * Runs the app's UI tests on the Atrium simulator.
 *
 * @remarks
 * By its id, so `xcodebuild` does not pick between the arm64 and x86_64 destinations of one name.
 *
 * @sideEffects Builds and runs the UI tests in the simulator.
 * @returns {number} The exit code.
 */
function testApp() {
  const { udid } = simulator();
  return xcrun([
    "xcodebuild",
    "test",
    "-project",
    project,
    "-scheme",
    "Atrium",
    "-destination",
    `id=${udid}`,
    "-derivedDataPath",
    derivedData,
    "-quiet",
  ]).status;
}

/**
 * Runs the Swift checks of `pnpm check`.
 *
 * @remarks
 * The generated protocol types are compared first, with Node only, so a protocol change that was
 * not regenerated fails `pnpm check` on any machine. The Swift lints need Xcode and are skipped,
 * saying so, without it.
 *
 * @sideEffects Runs the protocol check, `swift-format lint` and `scripts/swift-lint.mjs`; prints.
 * @returns {number} 0 when everything passed.
 */
function check() {
  const generated = spawnSync(process.execPath, [join(root, "scripts", "protocol-swift.mjs"), "--check"], {
    stdio: "inherit",
  });
  let status = generated.status ?? 1;
  if (!hasXcode()) {
    console.log("Swift checks skipped: Xcode not found (xcrun could not find xcodebuild)");
    return status;
  }
  const format = xcrun([
    "swift-format",
    "lint",
    "--strict",
    "--parallel",
    "--configuration",
    join(ios, ".swift-format"),
    "--recursive",
    ...swiftPaths,
  ]);
  const lint = spawnSync(process.execPath, [join(root, "scripts", "swift-lint.mjs"), ios], { stdio: "inherit" });
  for (const code of [format.status, lint.status ?? 1]) if (code !== 0) status = code;
  return status;
}

/**
 * Takes a screenshot of the app in the Atrium simulator.
 *
 * @remarks
 * `pnpm ios:shot [--dark]`, how a person or an agent looks at the interface (acceptance.md). The
 * app gets three seconds to draw after launching.
 *
 * @sideEffects Builds, boots the simulator, sets its appearance, installs and launches the app,
 * writes `apps/ios/.build/shots/home-<light|dark>.png`; prints its path.
 */
function shot() {
  const { udid, state } = simulator();
  build(`id=${udid}`);
  if (state !== "Booted") must(["simctl", "boot", udid]);
  must(["simctl", "bootstatus", udid, "-b"], { capture: true });
  const appearance = process.argv.includes("--dark") ? "dark" : "light";
  must(["simctl", "ui", udid, "appearance", appearance]);
  must(["simctl", "install", udid, join(derivedData, "Build", "Products", "Debug-iphonesimulator", "Atrium.app")]);
  must(["simctl", "launch", "--terminate-running-process", udid, bundleId], { capture: true });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  const dir = join(ios, ".build", "shots");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `home-${appearance}.png`);
  must(["simctl", "io", udid, "screenshot", file], { capture: true });
  console.log(file);
}

/**
 * Runs the command named on the command line.
 *
 * @remarks
 * See the module comment.
 *
 * @sideEffects Whatever the command does; sets the exit code.
 */
function main() {
  const command = process.argv[2] ?? "";
  switch (command) {
    case "check":
      process.exitCode = check();
      return;
    case "kit":
      if (process.argv.includes("--if-xcode") && !hasXcode()) {
        console.log("Swift tests skipped: Xcode not found (xcrun could not find xcodebuild)");
        return;
      }
      requireXcode("test");
      process.exitCode = testKit();
      return;
    case "test": {
      requireXcode("test");
      const status = testKit();
      process.exitCode = status === 0 ? testApp() : status;
      return;
    }
    case "build":
      requireXcode("build");
      build(process.argv.includes("--simulator") ? "generic/platform=iOS Simulator" : "generic/platform=iOS");
      return;
    case "install":
      requireXcode("install");
      install();
      return;
    case "format":
      requireXcode("format");
      process.exitCode = xcrun([
        "swift-format",
        "format",
        "--in-place",
        "--parallel",
        "--configuration",
        join(ios, ".swift-format"),
        "--recursive",
        ...swiftPaths,
      ]).status;
      return;
    case "shot":
      requireXcode("shot");
      shot();
      return;
    default:
      console.error("usage: node scripts/ios.mjs <check|kit|test|build|install|format|shot>");
      process.exitCode = 2;
  }
}

main();
