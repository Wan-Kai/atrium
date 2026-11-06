import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";

/** What opening a terminal goes through, which tests replace with a scripted one. */
export interface TerminalHost {
  /** Runs a program and answers its standard output, or fails when it cannot or exits non-zero. */
  run(file: string, args: readonly string[], timeoutMs: number): Promise<{ readonly stdout: string }>;
  /** Whether a program is installed at that path. */
  exists(path: string): boolean;
  /** The user's home folder. */
  home(): string;
}

/** Where the cmux command comes from, in the order it is looked for. */
const CMUX = ["/Applications/cmux.app/Contents/Resources/bin/cmux", "/opt/homebrew/bin/cmux", "/usr/local/bin/cmux"];

/** cmux's bundle, for `open`, which launches it or brings it forward. */
const CMUX_BUNDLE = "com.cmuxterm.app";

/** macOS's `open`, which launches an app with an argument. */
const OPEN = "/usr/bin/open";

/** How long the app takes to appear before opening a terminal is given up on (SPEC-0001). */
const LAUNCH_TIMEOUT_MS = 15_000;
/** How long a command gets before it is taken as unanswered. */
const COMMAND_TIMEOUT_MS = 10_000;
/** How long cmux gets to answer, which a stopped app never does. */
const PROBE_TIMEOUT_MS = 5_000;
/** How long opening an app, or a directory in the Terminal, gets. */
const OPEN_TIMEOUT_MS = 10_000;
/** How long between asking whether cmux has come up. */
const POLL_MS = 300;

/** The desktop's own way out to the system. */
const desktopTerminal: TerminalHost = {
  run(file, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      execFile(file, [...args], { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => {
        if (error !== null) reject(error);
        else resolve({ stdout });
      });
    });
  },
  exists(path) {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  home: homedir,
};

/**
 * Waits between two looks at whether cmux has come up.
 *
 * @remarks
 * See `openTerminalIn`: a launched app needs a moment before its socket answers.
 *
 * @sideEffects Waits.
 * @param ms - How long.
 * @returns When the wait is over.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Opens a terminal in a directory: cmux when it is installed, the system Terminal otherwise.
 *
 * @remarks
 * SPEC-0001 ("在终端中打开"): the session stays as it is; only a terminal appears. cmux is asked
 * whether it is running, and launched if not; the terminal then becomes a new workspace in the
 * window the user is looking at, whose directory is the one asked for, and cmux comes forward. A
 * machine without cmux gets Terminal.app in that directory. Nothing here runs a command in the
 * new terminal.
 *
 * @sideEffects Launches apps and runs the cmux command.
 * @param dir - The directory to open in, or `null` for the home folder.
 * @param host - How to reach the system; tests script it.
 * @param wait - How to wait between looks at a launching cmux.
 * @returns When the terminal has been asked for.
 * @throws {Error} When cmux cannot be started in time or refuses the workspace.
 */
export async function openTerminalIn(
  dir: string | null,
  host: TerminalHost = desktopTerminal,
  wait: (ms: number) => Promise<void> = delay,
): Promise<void> {
  const target = dir ?? host.home();
  const cli = CMUX.find((path) => host.exists(path));
  if (cli === undefined) {
    await host.run(OPEN, ["-a", "Terminal", target], OPEN_TIMEOUT_MS);
    return;
  }
  /**
   * Whether cmux answers at all.
   *
   * @remarks
   * See `openTerminalIn`: a cmux that is not running, or is still starting, refuses to connect.
   *
   * @sideEffects Runs the cmux command.
   * @returns Whether it answered.
   */
  const answering = async (): Promise<boolean> =>
    host.run(cli, ["list-windows"], PROBE_TIMEOUT_MS).then(
      () => true,
      () => false,
    );
  if (!(await answering())) {
    await host.run(OPEN, ["-b", CMUX_BUNDLE], OPEN_TIMEOUT_MS);
    let up = false;
    for (let waited = 0; waited < LAUNCH_TIMEOUT_MS && !up; waited += POLL_MS) {
      await wait(POLL_MS);
      up = await answering();
    }
    if (!up) throw new Error("cmux did not start");
  }
  // An empty answer means no window is open yet: the command then makes its own.
  const window = await host.run(cli, ["current-window"], COMMAND_TIMEOUT_MS).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );
  await host.run(
    cli,
    ["new-workspace", ...(window === "" ? [] : ["--window", window]), "--cwd", target, "--focus", "true"],
    COMMAND_TIMEOUT_MS,
  );
  await host.run(OPEN, ["-b", CMUX_BUNDLE], OPEN_TIMEOUT_MS);
}
