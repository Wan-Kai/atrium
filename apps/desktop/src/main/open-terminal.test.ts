import { describe, expect, it } from "vitest";
import { type TerminalHost, openTerminalIn } from "./open-terminal";

/** The cmux command the app bundle carries. */
const BUNDLED = "/Applications/cmux.app/Contents/Resources/bin/cmux";
/** A cmux from Homebrew, which the bundle's wins over. */
const BREWED = "/opt/homebrew/bin/cmux";

/** A host that answers what a test scripts, and records every call. */
interface Scripted {
  readonly host: TerminalHost;
  /** Every call, as the program and its arguments. */
  readonly calls: string[][];
  /** Every number of milliseconds the opening waited for. */
  readonly waits: number[];
}

/**
 * A host that answers as a machine with the given cmux would.
 *
 * @remarks
 * See `openTerminalIn`: a cmux that is not running refuses to answer until `open` launches it,
 * and one that cannot be launched never does.
 *
 * @sideEffects none
 * @param options - What is installed, whether cmux is already running, whether it can be
 * launched, and the window it reports.
 * @returns The host and what it recorded.
 */
function scripted(options: {
  readonly installed?: readonly string[];
  readonly running?: boolean;
  readonly launchable?: boolean;
  readonly window?: string;
}): Scripted {
  const calls: string[][] = [];
  const waits: number[] = [];
  const installed = options.installed ?? [];
  const launchable = options.launchable !== false;
  let running = options.running === true;
  return {
    host: {
      async run(file, args) {
        const call = [file, ...args];
        calls.push(call);
        if (file === "/usr/bin/open") {
          if (args[0] === "-b" && launchable) running = true;
          return { stdout: "" };
        }
        if (args[0] === "list-windows") {
          if (!running) throw new Error("no socket");
          return { stdout: "" };
        }
        if (args[0] === "current-window") return { stdout: options.window ?? "w-1\n" };
        return { stdout: "" };
      },
      exists: (path) => installed.includes(path),
      home: () => "/Users/me",
    },
    calls,
    waits,
  };
}

/**
 * Waits between two looks at a launching cmux, recording how long it was asked for.
 *
 * @remarks
 * See `openTerminalIn`: a test has no reason to wait for real.
 *
 * @sideEffects Pushes to `waits`.
 * @param waits - The numbers to record into.
 * @returns The waiting function.
 */
function recording(waits: number[]): (ms: number) => Promise<void> {
  return (ms) => {
    waits.push(ms);
    return Promise.resolve();
  };
}

describe("openTerminalIn", () => {
  it("opens Terminal.app in the directory when cmux is not installed", async () => {
    const { host, calls } = scripted({});

    await openTerminalIn("/work/atrium", host);

    expect(calls).toStrictEqual([["/usr/bin/open", "-a", "Terminal", "/work/atrium"]]);
  });

  it("opens the home folder for a chat, which has no workspace", async () => {
    const { host, calls } = scripted({});

    await openTerminalIn(null, host);

    expect(calls).toStrictEqual([["/usr/bin/open", "-a", "Terminal", "/Users/me"]]);
  });

  it("adds a workspace in the window cmux shows, in the directory, and brings cmux forward", async () => {
    const { host, calls } = scripted({ installed: [BUNDLED], running: true, window: "w-7" });

    await openTerminalIn("/work/sidebar", host);

    expect(calls).toStrictEqual([
      [BUNDLED, "list-windows"],
      [BUNDLED, "current-window"],
      [BUNDLED, "new-workspace", "--window", "w-7", "--cwd", "/work/sidebar", "--focus", "true"],
      ["/usr/bin/open", "-b", "com.cmuxterm.app"],
    ]);
  });

  it("prefers the cmux inside the app to one from Homebrew", async () => {
    const { host, calls } = scripted({ installed: [BREWED, BUNDLED], running: true });

    await openTerminalIn("/work/atrium", host);

    expect(calls.filter(([file]) => file === BREWED)).toStrictEqual([]);
    expect(calls.filter(([file]) => file === BUNDLED)).toHaveLength(3);
  });

  it("launches cmux when it is not running, and waits for it before asking for a workspace", async () => {
    const { host, calls, waits } = scripted({ installed: [BUNDLED], window: "w-1" });

    await openTerminalIn("/work/atrium", host, recording(waits));

    expect(calls).toStrictEqual([
      [BUNDLED, "list-windows"],
      ["/usr/bin/open", "-b", "com.cmuxterm.app"],
      [BUNDLED, "list-windows"],
      [BUNDLED, "current-window"],
      [BUNDLED, "new-workspace", "--window", "w-1", "--cwd", "/work/atrium", "--focus", "true"],
      ["/usr/bin/open", "-b", "com.cmuxterm.app"],
    ]);
    expect(waits.length).toBeGreaterThan(0);
  });

  it("makes its own window when cmux has none open", async () => {
    const { host, calls } = scripted({ installed: [BUNDLED], running: true, window: "" });

    await openTerminalIn("/work/atrium", host);

    expect(calls[2]).toStrictEqual([BUNDLED, "new-workspace", "--cwd", "/work/atrium", "--focus", "true"]);
  });

  it("gives up when cmux never answers", async () => {
    const { host, calls, waits } = scripted({ installed: [BUNDLED], launchable: false });

    await expect(openTerminalIn("/work/atrium", host, recording(waits))).rejects.toStrictEqual(
      new Error("cmux did not start"),
    );

    expect(calls.filter(([, ...args]) => args[0] === "new-workspace")).toStrictEqual([]);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(15_000);
  });
});
