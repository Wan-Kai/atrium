import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/** node-pty, loaded on first use: a host that never opens a terminal never loads a native module. */
let nodePty: typeof import("node-pty") | null = null;

/** Where node-pty was loaded from, so its `spawn-helper` is looked for there too. */
let nodePtyDir: string | null = null;

/**
 * This module's file, wherever it ended up.
 *
 * @remarks
 * The host is bundled to CommonJS, where `__filename` is the bundle; the sources also run as
 * modules in tests, where only `import.meta.url` exists. Native module paths are relative to
 * whichever it is.
 *
 * @sideEffects none
 * @returns The file's path.
 */
function moduleFile(): string {
  return typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
}

/**
 * Where a packaged app puts node-pty.
 *
 * @remarks
 * The host's bundle has no `node_modules`; the app ships the addon under `Resources/app/native`
 * (SPEC-0009, "打包"). Tried only after the plain require fails, which is how a checkout resolves
 * it.
 *
 * @sideEffects none
 * @returns Candidate directories, most likely first.
 */
function packagedPlaces(): readonly string[] {
  // Electron sets `resourcesPath` on every process it starts; plain Node has none.
  const resources: unknown = Reflect.get(process, "resourcesPath");
  const beside = join(dirname(process.execPath), "..", "Resources", "app", "native", "node-pty");
  // The host's bundle sits in `<Resources>/app/host`, so its sibling is right in a packaged app
  // whichever process this is (a utility process need not report `resourcesPath`).
  const sibling = join(dirname(moduleFile()), "..", "native", "node-pty");
  const places = [sibling, beside];
  return typeof resources === "string" ? [sibling, join(resources, "app", "native", "node-pty"), beside] : places;
}

/**
 * Loads node-pty.
 *
 * @remarks
 * Deferred because it is a native addon: the require has to resolve at run time, from wherever
 * the package sits (a checkout, or `Resources/app/native` in a packaged app), and bundling it
 * would point the module's own paths at the bundle.
 *
 * @sideEffects Loads (and caches) the native module.
 * @returns The module.
 */
function loadNodePty(): typeof import("node-pty") {
  const require = createRequire(moduleFile());
  let loaded: unknown;
  try {
    loaded = require("node-pty");
    nodePtyDir = dirname(require.resolve("node-pty/package.json"));
  } catch (error) {
    const packaged = packagedPlaces().find((place) => existsSync(join(place, "package.json")));
    if (packaged === undefined) throw error;
    loaded = require(packaged);
    nodePtyDir = packaged;
  }
  if (typeof loaded !== "object" || loaded === null || typeof Reflect.get(loaded, "spawn") !== "function") {
    throw new Error("node-pty loaded without spawn");
  }
  // oxlint-disable-next-line no-unsafe-type-assertion -- checked just above: the module has a callable spawn.
  nodePty ??= loaded as typeof import("node-pty");
  return nodePty;
}

/** A PTY process, as much of node-pty's shape as the host uses. */
export interface PtyProcess {
  /** The shell's pid; the foreground program is among its children. */
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Ends the process group; `signal` is node-pty's, `SIGTERM` by default. */
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
}

/** What a terminal starts with. */
export interface PtySpawnInput {
  readonly shell: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Readonly<Record<string, string>>;
}

/** Starts PTYs; tests pass their own. */
export type PtySpawn = (input: PtySpawnInput) => PtyProcess;

/**
 * The variables a terminal shell starts with (SPEC-0009, "环境").
 *
 * @remarks
 * The shell reads `.zprofile` and `.zshrc` itself, so `PATH` is deliberately absent: passing the
 * host's own would duplicate entries and leak whatever launched Atrium (measured 2026-11-12).
 * Atrium's and pi's variables are dropped so a terminal behaves like one opened from the Dock.
 *
 * @sideEffects none
 * @param source - The host's environment.
 * @returns What the shell gets, `TERM` and `COLORTERM` included.
 */
export function terminalEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const kept = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSH_AUTH_SOCK",
    "ZDOTDIR",
    "__CF_USER_TEXT_ENCODING",
  ];
  const env: Record<string, string> = {};
  for (const name of kept) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] = "truecolor";
  return env;
}

/**
 * Makes node-pty's `spawn-helper` executable, once.
 *
 * @remarks
 * npm and pnpm install it as `0644`; without the execute bit every spawn fails with
 * `posix_spawnp failed` (measured 2026-11-12, and T3's `NodePtyAdapter` does the same). The paths
 * cover a checkout and a packaged app, where the module sits under `Resources/app/native`.
 *
 * @sideEffects Changes the file's mode, best effort.
 * @param moduleDir - The `node-pty` package directory; looked up from this module by default.
 */
function ensureSpawnHelper(moduleDir?: string): void {
  let base = moduleDir;
  if (base === undefined) {
    try {
      base = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
    } catch {
      return;
    }
  }
  const candidates = [
    join(base, "build", "Release", "spawn-helper"),
    join(base, "build", "Debug", "spawn-helper"),
    join(base, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      chmodSync(candidate, 0o755);
    } catch {
      // A read-only install is still worth trying: the helper may already be executable.
    }
    return;
  }
}

/**
 * Starts a login shell in a PTY.
 *
 * @remarks
 * `-i -l` so the shell reads the same startup files a terminal app's shell reads; without a
 * controlling terminal of its own the PTY is the controlling terminal, which is what programs
 * such as `vim` and the agent CLIs check for.
 *
 * @sideEffects Starts a process and possibly changes the helper's mode.
 * @param input - What to start.
 * @returns The running process.
 */
export const spawnPty: PtySpawn = (input) => {
  const module = loadNodePty();
  // After loading: the helper is looked for beside wherever the module came from.
  ensureSpawnHelper(nodePtyDir ?? undefined);
  const child = module.spawn(input.shell, ["-i", "-l"], {
    name: "xterm-256color",
    cwd: input.cwd,
    cols: input.cols,
    rows: input.rows,
    env: input.env,
  });
  return {
    pid: child.pid,
    write: (data) => child.write(data),
    resize: (cols, rows) => child.resize(cols, rows),
    kill: (signal) => child.kill(signal),
    onData: (listener) => {
      child.onData(listener);
    },
    onExit: (listener) => {
      child.onExit(({ exitCode }) => listener({ exitCode }));
    },
  };
};
