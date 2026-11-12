import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Keeps the iPhone's Atrium on main's latest commit with a signature that has not run out.
 *
 * `node scripts/ios-sign.mjs [--cache <dir>] [--state <dir>] [--ios <file>] [<repo>]` (`pnpm ios:sign`;
 * run once a day by the Atrium schedule rule, development.md "手机签名自动续签"; `pnpm ios:sign:install`
 * keeps a launchd job around for going back to that). It only works when an iPhone is reachable over
 * this Wi-Fi, and builds nothing at all when there is none: main is checked
 * out in a worktree of its own (`--cache`, kept between runs so `xcodebuild` builds incrementally)
 * and installed with `scripts/ios.mjs install --no-launch`, which leaves the app closed. When main
 * does not build, the last commit that did is installed instead, so the free team's 7-day signature
 * is renewed either way. `--state` remembers what went to the phone last time: a record of the last
 * run, not the phone's own truth. `--ios` swaps the `scripts/ios.mjs` it runs, for this script's own
 * test.
 */

const dayMs = 24 * 60 * 60 * 1000;
/**
 * Rebuild once what is on the phone has less than this left. Apple hands out a new profile only when
 * the old one is spent or nearly so, and the rule runs once a day, so the time left has to cover the
 * gap to the next run: a day, and the weekend one may catch up after.
 */
const renewBeforeMs = 2 * dayMs;
/** A free team's profile lasts 7 days, for when the built app's expiry cannot be read. */
const profileLifetimeMs = 7 * dayMs;
/** Where `scripts/ios.mjs install` leaves the app it built, inside the worktree. */
const appProduct = join("apps", "ios", ".build", "xcode", "Build", "Products", "Debug-iphoneos", "Atrium.app");
/** `scripts/ios.mjs install` exits with this when no iPhone is reachable (its module comment). */
const noPhoneExit = 3;

/**
 * Writes one line of what happened, stamped in UTC.
 *
 * @remarks
 * The run's conversation keeps this output, so this is the whole record of a scheduled run.
 *
 * @sideEffects Writes to stdout.
 * @param {string} message - What to say.
 */
function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

/**
 * Reads the command line.
 *
 * @remarks
 * Every default is what a scheduled run wants; a positional `<repo>` is the checkout whose `main` is
 * built, which a test passes and a person does not need to.
 *
 * @sideEffects none
 * @param {string[]} argv - The arguments after the script's own path.
 * @returns {{ repo: string, cache: string, state: string, ios: string | null }} What the run works with.
 */
function options(argv) {
  const chosen = {
    repo: join(import.meta.dirname, ".."),
    cache: join(homedir(), ".cache", "atrium-ios-sign"),
    state: join(homedir(), "Library", "Caches", "atrium-ios", "sign"),
    ios: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = { "--cache": "cache", "--state": "state", "--ios": "ios" }[arg];
    if (key !== undefined) {
      const value = argv[index + 1];
      if (value === undefined) usage(`${arg} needs a folder`);
      chosen[key] = resolve(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) usage(`${arg} is not an option of this script`);
    chosen.repo = resolve(arg);
  }
  return chosen;
}

/**
 * Explains what the script takes and stops.
 *
 * @remarks
 * Only {@link options} calls this, for a command line it cannot use; nothing has run yet, so nothing
 * has to be undone.
 *
 * @sideEffects Prints and exits with 2, the code a usage error gets.
 * @param {string} problem - What was wrong with the command line.
 */
function usage(problem) {
  console.error(`scripts/ios-sign.mjs: ${problem}`);
  console.error("usage: node scripts/ios-sign.mjs [--cache <dir>] [--state <dir>] [--ios <file>] [<repo>]");
  process.exit(2);
}

/**
 * Runs git and collects what it said.
 *
 * @remarks
 * A git that is not on `PATH` has no exit code; counting that as a failure keeps every caller to one
 * shape of answer.
 *
 * @sideEffects Runs git.
 * @param {string} cwd - Where to run it.
 * @param {string[]} args - git's arguments.
 * @returns {{ status: number, stdout: string, stderr: string }} The exit code and output.
 */
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Shortens a commit for the log.
 *
 * @remarks
 * A person reading the log needs to recognize the commit in `git log`, not to copy it.
 *
 * @sideEffects none
 * @param {string} sha - A full commit id.
 * @returns {string} Its first ten characters.
 */
function short(sha) {
  return sha.slice(0, 10);
}

/**
 * Reads what the last run left on the phone.
 *
 * @remarks
 * Missing or unreadable means the same as "nothing known": the next run installs.
 *
 * @sideEffects Reads the state file.
 * @param {string} dir - The state folder.
 * @returns {{ commit?: string, installedAt?: string, expiresAt?: string | null } | null} The record, or `null`.
 */
function readState(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Records what this run installed.
 *
 * @remarks
 * Written in one piece after an install, so a run that dies earlier leaves the last good record
 * rather than half of a new one.
 *
 * @sideEffects Makes the state folder and writes `state.json` in it.
 * @param {string} dir - The state folder.
 * @param {{ commit: string, installedAt: string, expiresAt: string | null }} state - What went to the phone.
 */
function writeState(dir, state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * When the app that a record describes stops opening.
 *
 * @remarks
 * The profile's own expiry when the build reported one; otherwise the free team's 7 days from the
 * install, which errs towards rebuilding.
 *
 * @sideEffects none
 * @param {{ commit?: string, installedAt?: string, expiresAt?: string | null }} state - The record.
 * @returns {number} Milliseconds since the epoch, or `-Infinity` when there is nothing to go on.
 */
function expiryOf(state) {
  if (typeof state.expiresAt === "string") return Date.parse(state.expiresAt);
  if (typeof state.installedAt === "string") return Date.parse(state.installedAt) + profileLifetimeMs;
  return -Infinity;
}

/**
 * Tells whether a process with this id is running.
 *
 * @remarks
 * Signal 0 only asks; `EPERM` still means the process is there, just not this user's.
 *
 * @sideEffects Asks the system about the process.
 * @param {number} pid - The process id.
 * @returns {boolean} Whether it exists; `EPERM` counts, the process is there but not ours.
 */
function running(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), "code") === "EPERM";
  }
}

/**
 * Takes the run lock so two builds never share the worktree.
 *
 * @remarks
 * A folder that exists but whose owner is gone was left by a run that was killed, so it is taken
 * over; an owner file that is not there yet counts as gone, which can only lose a lock to a run that
 * died within the moment between making the folder and writing it.
 *
 * @sideEffects Makes or removes the lock folder.
 * @param {string} dir - The state folder.
 * @returns {string | null} The lock folder to hand back to {@link releaseLock}, or `null` when another run holds it.
 */
function takeLock(dir) {
  const path = join(dir, "run.lock");
  mkdirSync(dir, { recursive: true });
  try {
    mkdirSync(path);
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "EEXIST") throw error;
    let owner = null;
    try {
      owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
    } catch {
      owner = null;
    }
    if (owner !== null && running(owner.pid)) return null;
    rmSync(path, { recursive: true, force: true });
    try {
      mkdirSync(path);
    } catch {
      return null;
    }
  }
  writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return path;
}

/**
 * Gives the run lock back.
 *
 * @remarks
 * A run killed outright never gets here; {@link takeLock} takes that folder over once the process it
 * names is gone.
 *
 * @sideEffects Removes the lock folder.
 * @param {string} path - What {@link takeLock} returned.
 */
function releaseLock(path) {
  rmSync(path, { recursive: true, force: true });
}

/**
 * Puts the worktree on a commit, keeping the build cache.
 *
 * @remarks
 * `apps/ios/.build` is ignored by git, so `git clean` leaves it and `xcodebuild` builds only what
 * changed. A missing worktree is made in the first place by the repository it belongs to.
 *
 * @sideEffects Runs git; makes, cleans and checks out the worktree.
 * @param {{ repo: string, cache: string }} chosen - Where the repository is and where the worktree goes.
 * @param {string} sha - The commit to put in it.
 * @returns {boolean} Whether the worktree is now on that commit.
 */
function checkout(chosen, sha) {
  if (git(chosen.cache, ["rev-parse", "--is-inside-work-tree"]).status !== 0) {
    // A folder without a working tree is not a worktree this script can use; prune forgets one that
    // was deleted behind git's back, or `worktree add` refuses to make it again.
    mkdirSync(dirname(chosen.cache), { recursive: true });
    rmSync(chosen.cache, { recursive: true, force: true });
    git(chosen.repo, ["worktree", "prune"]);
    const added = git(chosen.repo, ["worktree", "add", "--quiet", "--detach", chosen.cache, sha]);
    if (added.status !== 0) {
      console.error(added.stderr.trim());
      return false;
    }
    return true;
  }
  const checked = git(chosen.cache, ["checkout", "--quiet", "--force", "--detach", sha]);
  if (checked.status !== 0) {
    console.error(checked.stderr.trim());
    return false;
  }
  git(chosen.cache, ["clean", "-fdq"]);
  return true;
}

/**
 * Builds the worktree's copy of main and installs it on the phone.
 *
 * @remarks
 * The worktree carries the whole checkout, so its own `scripts/ios.mjs` builds its own code, exactly
 * as `pnpm ios:install` would there. Its output goes straight to this run's log.
 *
 * @sideEffects Runs `xcodebuild` and `devicectl`, printing what they say.
 * @param {{ cache: string, ios: string | null }} chosen - The worktree, and the `ios.mjs` to run instead of the worktree's.
 * @param {string} worktree - Where the code to build is.
 * @returns {number} Its exit code, `3` meaning no iPhone is reachable.
 */
function install(chosen, worktree) {
  const ios = chosen.ios ?? join(worktree, "scripts", "ios.mjs");
  const result = spawnSync(process.execPath, [ios, "install", "--no-launch"], { cwd: worktree, stdio: "inherit" });
  return result.status ?? 1;
}

/**
 * Reads when the built app's profile runs out.
 *
 * @remarks
 * The profile is a CMS-signed plist in the app; `security` unwraps it and the date is the one
 * `AtriumUI`'s `Signing` shows on the phone. Not being able to read it is not a failure: the state
 * falls back to 7 days from the install.
 *
 * @sideEffects Runs `security`; reads the built app.
 * @param {string} worktree - Where the app was built.
 * @returns {Date | null} The expiry, or `null` when the app or its profile is not there or cannot be read.
 */
function profileExpiry(worktree) {
  const file = join(worktree, appProduct, "embedded.mobileprovision");
  if (!existsSync(file)) return null;
  const decoded = spawnSync("security", ["cms", "-D", "-i", file], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if ((decoded.status ?? 1) !== 0) return null;
  const found = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/u.exec(decoded.stdout ?? "");
  return found === null ? null : new Date(found[1]);
}

/**
 * Installs main, or the last commit that built, and records it.
 *
 * @remarks
 * The build is what asks Apple for the profile, so a failed build is not the only way to fail: the
 * phone can also go away mid-run, which is checked per attempt and ends the run quietly.
 *
 * @sideEffects Builds, installs on the phone, writes the state; prints what it did.
 * @param {{ repo: string, cache: string, state: string, ios: string | null }} chosen - What the run works with.
 * @param {string} head - main's commit.
 * @param {{ commit?: string, installedAt?: string, expiresAt?: string | null } | null} state - The last record.
 * @returns {number} 0 when the phone now has something or nothing needed to change, 1 when nothing could be installed.
 */
function reconcile(chosen, head, state) {
  const steps = [{ sha: head, why: `main (${short(head)})` }];
  if (typeof state?.commit === "string" && state.commit !== head) {
    steps.push({ sha: state.commit, why: `the last commit that built (${short(state.commit)})` });
  }
  for (const step of steps) {
    const started = Date.now();
    log(`building ${step.why} in ${chosen.cache}`);
    if (!checkout(chosen, step.sha)) {
      log(`${step.why} could not be checked out`);
      continue;
    }
    const code = install(chosen, chosen.cache);
    if (code === noPhoneExit) {
      log("no iPhone on this network; nothing installed, the next run tries again");
      return 0;
    }
    if (code !== 0) {
      log(`${step.why} did not build and install (exit code ${code})`);
      continue;
    }
    const expires = profileExpiry(chosen.cache);
    writeState(chosen.state, {
      commit: step.sha,
      installedAt: new Date().toISOString(),
      expiresAt: expires === null ? null : expires.toISOString(),
    });
    const took = Math.round((Date.now() - started) / 1000);
    if (expires === null) {
      log(`installed ${step.why} in ${took} s; could not read the profile's expiry, so the next run trusts 7 days`);
      return 0;
    }
    if (expires.getTime() - Date.now() < renewBeforeMs) {
      // Just re-signed, and Apple still handed back the old profile: the app stops opening at the
      // expiry, and the first run after that gets a new one (development.md "自动续签").
      log(
        `installed ${step.why} in ${took} s, but Apple kept the old profile: it runs out on ${expires.toISOString()}, ` +
          "and the next run after that renews it",
      );
      return 0;
    }
    log(`installed ${step.why} in ${took} s; it opens until ${expires.toISOString()}`);
    return 0;
  }
  log("nothing could be installed; the phone keeps what it has");
  return 1;
}

/**
 * Runs one renewal: skip when the phone already has main with time to spare, else install.
 *
 * @remarks
 * See the module comment. Anything that only the last run knows is in the state file, so a run after
 * a weekend or a reboot decides the same way.
 *
 * @sideEffects Whatever the run does; prints what it decided.
 * @returns {number} The exit code.
 */
function main() {
  const chosen = options(process.argv.slice(2));
  const head = git(chosen.repo, ["rev-parse", "--verify", "main"]);
  if (head.status !== 0) {
    console.error(`scripts/ios-sign.mjs: ${chosen.repo} has no main to build`);
    console.error(head.stderr.trim());
    return 1;
  }
  const sha = head.stdout.trim();
  const state = readState(chosen.state);
  const expires = state === null ? -Infinity : expiryOf(state);
  if (state !== null && state.commit === sha && expires - Date.now() > renewBeforeMs) {
    log(`the phone already has main (${short(sha)}) until ${new Date(expires).toISOString()}; nothing to do`);
    return 0;
  }
  const lock = takeLock(chosen.state);
  if (lock === null) {
    log("another run is still installing; skipped");
    return 0;
  }
  try {
    return reconcile(chosen, sha, state);
  } finally {
    releaseLock(lock);
  }
}

process.exitCode = main();
