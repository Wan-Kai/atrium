import { FakeClock, createTempDir } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { systemClock } from "./clock";
import { type ShellAttemptFailure, readLoginShellEnv } from "./login-shell";

const INHERITED_PATH = "/usr/bin:/bin";
/** `sleep` commands unique to this test process, so leftovers from an interrupted run do not match. */
const HANGING = `sleep ${40_000 + (process.pid % 10_000)}`;
const ABORTED = `sleep ${50_000 + (process.pid % 10_000)}`;

/** A temporary home with the given rc files; returns a host environment pointing zsh and bash at it. */
async function homeWith(files: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  const home = await createTempDir("shell-home");
  onTestFinished(home.cleanup);
  for (const [name, content] of Object.entries(files)) await writeFile(join(home.path, name), content);
  return { HOME: home.path, ZDOTDIR: home.path, PATH: INHERITED_PATH };
}

/** Reads the environment through `shell`, collecting failed attempts. */
async function read(
  shell: string,
  env: Record<string, string>,
  extra: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const failures: ShellAttemptFailure[] = [];
  const result = await readLoginShellEnv({
    shell,
    env,
    clock: systemClock,
    onFailure: (failure) => failures.push(failure),
    ...extra,
  });
  return { result, failures, path: result.env["PATH"] ?? "" };
}

/** Running processes whose whole command line is `command`. */
function running(command: string): string[] {
  return execFileSync("ps", ["-A", "-o", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.trim() === command);
}

/** Names that must not reach tools: Atrium's, Electron's, and the host-only test variable. */
function hostOnlyNames(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env).filter(
    (name) => name.startsWith("ATRIUM_") || name.startsWith("ELECTRON_") || name === "HOST_ONLY",
  );
}

describe("readLoginShellEnv", () => {
  it("takes the environment of an interactive zsh, including what .zshrc exports", async () => {
    const env = await homeWith({ ".zshrc": "export PATH=/custom/zshrc/bin:$PATH\nexport GREETING=hello\n" });

    const { result, failures, path } = await read("/bin/zsh", env);

    expect(result).toMatchObject({ source: "login-shell", shell: "/bin/zsh" });
    expect(path.split(":")[0]).toBe("/custom/zshrc/bin");
    expect(result.env["GREETING"]).toBe("hello");
    expect(result.env["HOME"]).toBe(env["HOME"]);
    expect(failures).toStrictEqual([]);
  });

  it("takes the environment of a bash login profile", async () => {
    const env = await homeWith({ ".bash_profile": "export PATH=/custom/bash/bin:$PATH\n" });

    const { result, path } = await read("/bin/bash", env);

    expect(result).toMatchObject({ source: "login-shell", shell: "/bin/bash" });
    expect(path.split(":")[0]).toBe("/custom/bash/bin");
  });

  it("keeps values with line breaks and equals signs intact, and drops the shell's own variables", async () => {
    const env = await homeWith({ ".zshrc": "export MULTI=$'first\\nsecond=2'\n" });

    const { result } = await read("/bin/zsh", env);

    expect(result.env["MULTI"]).toBe("first\nsecond=2");
    expect(Object.keys(result.env).filter((name) => ["SHLVL", "_", "PWD", "OLDPWD"].includes(name))).toStrictEqual([]);
  });

  it("starts the shell without the host's other variables, so the token never reaches tools", async () => {
    const env = await homeWith({ ".zshrc": "export ATRIUM_FROM_RC=1 ELECTRON_FROM_RC=1\n" });

    const { result } = await read("/bin/zsh", {
      ...env,
      ATRIUM_TOKEN: "secret-token",
      ELECTRON_RUN_AS_NODE: "1",
      HOST_ONLY: "x",
    });

    expect(result.source).toBe("login-shell");
    expect(hostOnlyNames(result.env)).toStrictEqual([]);
  });

  it("ignores banners and echoed commands that rc files print", async () => {
    const env = await homeWith({
      ".zshrc":
        'echo "welcome __ATRIUM_ back"\nexec 2>&1\nsetopt verbose xtrace\nexport PATH=/custom/noisy/bin:$PATH\n',
    });

    const { path } = await read("/bin/zsh", env);

    expect(path.split(":")[0]).toBe("/custom/noisy/bin");
  });

  it("falls back to a login-only shell when the interactive one hangs, and kills what it started", async () => {
    const env = await homeWith({
      ".zprofile": "export PATH=/custom/profile/bin:$PATH\n",
      ".zshrc": `${HANGING}\n`,
    });
    const clock = new FakeClock();
    const failures: ShellAttemptFailure[] = [];

    // The deadline runs on a fake clock and passes only once the interactive shell is stuck in its
    // rc file, so a slow machine cannot make the healthy login-only attempt time out too.
    const reading = readLoginShellEnv({ shell: "/bin/zsh", env, clock, onFailure: (f) => failures.push(f) });
    await vi.waitFor(() => expect(running(HANGING)).toHaveLength(1), { timeout: 15_000 });
    clock.advance(10_000);
    const result = await reading;

    expect(result.env["PATH"]?.split(":")[0]).toBe("/custom/profile/bin");
    expect(failures).toStrictEqual([{ args: ["-i", "-l", "-c"], reason: "timeout" }]);
    expect(running(HANGING)).toStrictEqual([]);
  });

  it("keeps the host's environment, without Atrium's and Electron's variables, when both attempts fail", async () => {
    const env = await homeWith({ ".zprofile": "exit 3\n" });

    const { result, failures } = await read("/bin/zsh", { ...env, ATRIUM_TOKEN: "secret", ELECTRON_X: "1" });

    expect(result).toStrictEqual({ source: "inherited", env, reason: "failed", shell: "/bin/zsh" });
    expect(failures).toStrictEqual([
      { args: ["-i", "-l", "-c"], reason: "exit", code: 3 },
      { args: ["-l", "-c"], reason: "exit", code: 3 },
    ]);
  });

  it("reports a shell whose printf prints nothing as a missing marker", async () => {
    const env = await homeWith({ ".zprofile": "printf() { :; }\n" });

    const { result, failures } = await read("/bin/zsh", env);

    expect(result).toMatchObject({ source: "inherited", reason: "failed" });
    expect(failures).toStrictEqual([
      { args: ["-i", "-l", "-c"], reason: "no-marker" },
      { args: ["-l", "-c"], reason: "no-marker" },
    ]);
  });

  it("reports a shell that cannot be started", async () => {
    const { result, failures } = await read("/nonexistent/zsh", { PATH: INHERITED_PATH });

    expect(result).toStrictEqual({
      source: "inherited",
      env: { PATH: INHERITED_PATH },
      reason: "failed",
      shell: "/nonexistent/zsh",
    });
    expect(failures).toStrictEqual([
      { args: ["-i", "-l", "-c"], reason: "spawn" },
      { args: ["-l", "-c"], reason: "spawn" },
    ]);
  });

  it("does not run shells outside the POSIX family, or when there is no shell", async () => {
    expect(
      (await read("/opt/homebrew/bin/fish", { PATH: INHERITED_PATH, ATRIUM_TOKEN: "secret" })).result,
    ).toStrictEqual({
      source: "inherited",
      env: { PATH: INHERITED_PATH },
      reason: "unsupported-shell",
      shell: "/opt/homebrew/bin/fish",
    });
    expect(await readLoginShellEnv({ shell: undefined, env: {}, clock: systemClock })).toStrictEqual({
      source: "inherited",
      env: {},
      reason: "no-shell",
    });
  });

  it("stops at once when aborted, killing the running shell", async () => {
    const env = await homeWith({ ".zprofile": `${ABORTED}\n` });
    const controller = new AbortController();

    const reading = read("/bin/zsh", env, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    const { result, failures } = await reading;

    expect(result).toMatchObject({ source: "inherited", reason: "failed" });
    expect(failures).toStrictEqual([{ args: ["-i", "-l", "-c"], reason: "aborted" }]);
    expect(running(ABORTED)).toStrictEqual([]);
  });
});
