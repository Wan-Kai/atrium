import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
/** A simulator runs both arm64 and x86_64 apps; naming this Mac's keeps `xcodebuild` from picking. */
const simulatorArch = process.arch === "arm64" ? "arm64" : "x86_64";
/**
 * The lock every worktree takes before using the Atrium simulator; `ATRIUM_IOS_LOCK` moves it for
 * this script's own test (development.md "手机端的确切命令").
 */
const simulatorLock = process.env["ATRIUM_IOS_LOCK"] ?? join(homedir(), "Library", "Caches", "atrium-ios", "sim.lock");
/** How long to wait for another worktree to finish with the simulator before giving up. */
const lockWaitMs = Number(process.env["ATRIUM_IOS_LOCK_WAIT_MS"] ?? 30 * 60 * 1000);
/** How long the app gets to draw before a screenshot; the test sets 0. */
const shotDelayMs = Number(process.env["ATRIUM_IOS_SHOT_DELAY_MS"] ?? 3000);
/** A lock without an owner file older than this was left by a process killed right after making it. */
const ownerlessStaleMs = 30_000;

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
 * @param {{ capture?: boolean, env?: NodeJS.ProcessEnv }} [options] - Whether to collect the output instead of showing it, and the environment to run it in.
 * @returns {{ status: number, stdout: string, stderr: string }} The exit code and, when captured,
 *   the output and the errors.
 */
function xcrun(args, options = {}) {
  const standIn = process.env["ATRIUM_IOS_XCRUN"];
  const [command, commandArgs] = standIn === undefined ? ["xcrun", args] : [process.execPath, [standIn, ...args]];
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: options.capture === true ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Runs an Xcode tool and stops this script if it fails.
 *
 * @remarks
 * Each step of a build or install needs the one before it.
 *
 * @sideEffects Runs a process; when it fails, prints the command with its captured output and errors
 * and exits with its code.
 * @param {string[]} args - The tool and its arguments.
 * @param {{ capture?: boolean, env?: NodeJS.ProcessEnv }} [options] - Whether to collect the output instead of showing it, and the environment to run it in.
 * @returns {string} The output when captured, else an empty string.
 */
function must(args, options = {}) {
  const result = xcrun(args, options);
  if (result.status !== 0) {
    // Captured output would otherwise be lost with the reason the call failed.
    if (options.capture === true) {
      console.error(`xcrun ${args.join(" ")} failed with exit code ${result.status}`);
      for (const text of [result.stdout, result.stderr]) if (text.trim() !== "") console.error(text.trimEnd());
    }
    process.exit(result.status);
  }
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
 * Waits without spinning.
 *
 * @remarks
 * `scripts/` is assembly code and may wait on real time (coding-standards "异步与取消").
 *
 * @sideEffects Blocks this process for the time given.
 * @param {number} ms - How long.
 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/**
 * Says when a process started, as `ps` writes it, or `null` when there is no such process.
 *
 * @remarks
 * A pid alone can be reused by an unrelated process; pid and start time together name one process.
 *
 * @sideEffects Runs `ps`.
 * @param {number} pid - The process.
 * @returns {string | null} Its start time.
 */
function startedAt(pid) {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const text = result.status === 0 ? result.stdout.trim() : "";
  return text === "" ? null : text;
}

/**
 * Reads who holds the simulator lock.
 *
 * @remarks
 * The owner file is written right after the lock folder is made, so it can be missing for a moment.
 *
 * @sideEffects Reads the owner file.
 * @returns {{ pid: number, started: string, worktree: string, command: string } | null} The owner, or
 *   `null` when the file is missing or unreadable.
 */
function lockOwner() {
  try {
    return JSON.parse(readFileSync(join(simulatorLock, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Tells whether the simulator lock was left by a process that is gone.
 *
 * @remarks
 * Gone means no process with the owner's pid and start time; a lock without an owner file is only
 * stale once it is old, since the owner may be writing it right now.
 *
 * @sideEffects Runs `ps`; reads the lock folder's time.
 * @param {{ pid: number, started: string } | null} owner - The owner, as read.
 * @returns {boolean} Whether it can be taken over.
 */
function isStale(owner) {
  if (owner === null) {
    try {
      return Date.now() - statSync(simulatorLock).mtimeMs > ownerlessStaleMs;
    } catch {
      return false;
    }
  }
  return startedAt(owner.pid) !== owner.started;
}

/**
 * Takes over a stale simulator lock.
 *
 * @remarks
 * The lock is renamed aside before it is removed, so two processes taking it over at once cannot
 * both remove it. If the one renamed aside turns out to have a different owner (someone took the lock
 * in between), it is put back; a third process racing in the same moment is not handled.
 *
 * @sideEffects Renames and removes the lock folder; prints a line.
 * @param {{ pid: number } | null} owner - The stale owner, as read.
 */
function takeOver(owner) {
  const aside = `${simulatorLock}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(simulatorLock, aside);
  } catch {
    return;
  }
  let moved = null;
  try {
    moved = JSON.parse(readFileSync(join(aside, "owner.json"), "utf8"));
  } catch {
    // An ownerless lock stays ownerless.
  }
  if (moved?.pid !== owner?.pid || moved?.started !== owner?.started) {
    try {
      renameSync(aside, simulatorLock);
      return;
    } catch {
      // The lock was taken again meanwhile; the one set aside is gone for good.
    }
  }
  rmSync(aside, { recursive: true, force: true });
  console.log(`took over the Atrium simulator from pid ${owner?.pid ?? "unknown"}, which is gone`);
}

/**
 * Takes the lock on the Atrium simulator, waiting while another worktree has it.
 *
 * @remarks
 * All worktrees share one simulator by name; without the lock, a screenshot or UI test in one could
 * install over another's build mid-run. Taken for the whole cycle: finding or making the simulator,
 * installing, testing or taking the picture. An atomic `mkdir` makes the lock; the owner file says
 * which process and worktree has it; a lock whose process is gone is taken over. Given back when this
 * process exits, however it exits.
 *
 * @sideEffects Makes the lock folder and owner file; may wait, print, take over a stale lock, or exit
 * with 1 after `lockWaitMs`; registers exit and signal handlers that remove the lock.
 * @param {string} command - The pnpm command, for the owner file.
 */
function lockSimulator(command) {
  mkdirSync(dirname(simulatorLock), { recursive: true });
  const deadline = Date.now() + lockWaitMs;
  let told = false;
  for (;;) {
    try {
      mkdirSync(simulatorLock);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const owner = lockOwner();
    if (isStale(owner)) {
      takeOver(owner);
      continue;
    }
    const holder =
      owner === null ? "a process just starting" : `pid ${owner.pid} (pnpm ${owner.command} in ${owner.worktree})`;
    if (!told) {
      console.log(`waiting for the Atrium simulator: ${holder} is using it`);
      told = true;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      console.error(`gave up waiting for the Atrium simulator after ${Math.round(lockWaitMs / 1000)} s: ${holder}`);
      process.exit(1);
    }
    sleep(Math.min(1000, left));
  }
  const started = startedAt(process.pid) ?? "";
  writeFileSync(
    join(simulatorLock, "owner.json"),
    JSON.stringify({ pid: process.pid, started, worktree: root, command }),
  );
  process.on("exit", unlockSimulator);
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]) {
    process.once(signal, () => process.exit(code));
  }
}

/**
 * Gives the simulator lock back if this process holds it.
 *
 * @remarks
 * Runs on exit; checks the owner so a lock another process took over is left alone.
 *
 * @sideEffects Removes the lock folder.
 */
function unlockSimulator() {
  if (lockOwner()?.pid === process.pid) rmSync(simulatorLock, { recursive: true, force: true });
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
        // Xcode 26.6 leaves out `reality` for some phones; this list only has real devices anyway.
        (device.hardwareProperties?.reality ?? "physical") === "physical" &&
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
        `pnpm ios:install: ${device.deviceProperties.name} (${device.hardwareProperties.marketingName ?? device.hardwareProperties.productType}) is paired ` +
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
  const launch = xcrun(["devicectl", "device", "process", "launch", "--device", udid, bundleId], { capture: true });
  if (launch.status === 0) return;
  // The free team's first install on a phone: iOS will not open it until the developer is trusted.
  if (`${launch.stdout}${launch.stderr}`.includes("not been explicitly trusted by the user")) {
    console.error(
      "pnpm ios:install: Atrium is installed, but the iPhone has not trusted this developer yet. On the iPhone, " +
        "open Settings › General › VPN & Device Management, tap the developer under Developer App and trust it, " +
        "then run pnpm ios:install again.",
    );
    process.exit(1);
  }
  console.error(`xcrun devicectl device process launch failed with exit code ${launch.status}`);
  for (const text of [launch.stdout, launch.stderr]) if (text.trim() !== "") console.error(text.trimEnd());
  process.exit(launch.status);
}

/**
 * Runs the app's UI tests on the Atrium simulator.
 *
 * @remarks
 * By its id and this Mac's architecture, so `xcodebuild` has exactly one destination.
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
    `id=${udid},arch=${simulatorArch}`,
    "-derivedDataPath",
    derivedData,
    "-quiet",
  ]).status;
}

/**
 * Runs the Swift checks of `pnpm check`.
 *
 * @remarks
 * The generated protocol types and the file icons built from the desktop's are compared first,
 * with Node only, so a protocol change or icon table that was not regenerated fails `pnpm check`
 * on any machine. The Swift lints need Xcode and are skipped,
 * saying so, without it.
 *
 * @sideEffects Runs the protocol and icon checks, `swift-format lint` and `scripts/swift-lint.mjs`; prints.
 * @returns {number} 0 when everything passed.
 */
function check() {
  const generated = spawnSync(process.execPath, [join(root, "scripts", "protocol-swift.mjs"), "--check"], {
    stdio: "inherit",
  });
  let status = generated.status ?? 1;
  // The phone's file icons are built from the desktop's table and must not drift from it.
  const icons = spawnSync(process.execPath, [join(root, "scripts", "ios-file-icons.mjs"), "--check"], {
    stdio: "inherit",
  });
  if (icons.status !== 0) status = icons.status ?? 1;
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
 * `pnpm ios:shot [--dark] [--gallery=<section>]`, how a person or an agent looks at the interface
 * (acceptance.md). With `--gallery` the Debug build opens that design gallery section instead of
 * the home. The app gets three seconds to draw after launching. The caller holds the simulator lock.
 *
 * @sideEffects Builds, boots the simulator, sets its appearance, installs and launches the app,
 * writes `apps/ios/.build/shots/<home|gallery-section>-<light|dark>.png`; prints its path.
 */
function shot() {
  const { udid, state } = simulator();
  build(`id=${udid},arch=${simulatorArch}`);
  if (state !== "Booted") must(["simctl", "boot", udid]);
  must(["simctl", "bootstatus", udid, "-b"], { capture: true });
  const appearance = process.argv.includes("--dark") ? "dark" : "light";
  must(["simctl", "ui", udid, "appearance", appearance]);
  must(["simctl", "install", udid, join(derivedData, "Build", "Products", "Debug-iphonesimulator", "Atrium.app")]);
  const gallery = process.argv.find((arg) => arg.startsWith("--gallery="))?.slice("--gallery=".length);
  // simctl passes SIMCTL_CHILD_ variables to the launched app without the prefix.
  const env = gallery === undefined ? process.env : { ...process.env, SIMCTL_CHILD_ATRIUM_GALLERY: gallery };
  must(["simctl", "launch", "--terminate-running-process", udid, bundleId], { capture: true, env });
  sleep(shotDelayMs);
  const dir = join(ios, ".build", "shots");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${gallery === undefined ? "home" : `gallery-${gallery}`}-${appearance}.png`);
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
      if (status !== 0) {
        process.exitCode = status;
        return;
      }
      lockSimulator("test:ios");
      process.exitCode = testApp();
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
      lockSimulator("ios:shot");
      shot();
      return;
    default:
      console.error("usage: node scripts/ios.mjs <check|kit|test|build|install|format|shot>");
      process.exitCode = 2;
  }
}

main();
