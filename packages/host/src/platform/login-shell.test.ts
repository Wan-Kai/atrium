import { createTempDir } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { systemClock } from "./clock";
import { type ShellAttemptFailure, readLoginShellPath } from "./login-shell";

const INHERITED = "/usr/bin:/bin";

/** A temporary home with the given rc files, used as both HOME and ZDOTDIR. */
async function homeWith(files: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  const home = await createTempDir("shell-home");
  onTestFinished(home.cleanup);
  for (const [name, content] of Object.entries(files)) await writeFile(join(home.path, name), content);
  return { HOME: home.path, ZDOTDIR: home.path, PATH: INHERITED };
}

/** Reads PATH through `shell` with the given environment, collecting failed attempts. */
async function read(
  shell: string,
  env: Record<string, string>,
  extra: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const failures: ShellAttemptFailure[] = [];
  const result = await readLoginShellPath({
    shell,
    env,
    clock: systemClock,
    onFailure: (failure) => failures.push(failure),
    ...extra,
  });
  return { result, failures };
}

/** Running processes whose whole command line is `command`. */
function running(command: string): string[] {
  return execFileSync("ps", ["-A", "-o", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.trim() === command);
}

describe("readLoginShellPath", () => {
  it("takes PATH from an interactive zsh, including what .zshrc adds", async () => {
    const env = await homeWith({ ".zshrc": "export PATH=/custom/zshrc/bin:$PATH\n" });

    const { result, failures } = await read("/bin/zsh", env);

    expect(result).toMatchObject({ source: "login-shell", shell: "/bin/zsh" });
    expect(result.path.split(":")[0]).toBe("/custom/zshrc/bin");
    expect(failures).toStrictEqual([]);
  });

  it("takes PATH from a bash login profile", async () => {
    const env = await homeWith({ ".bash_profile": "export PATH=/custom/bash/bin:$PATH\n" });

    const { result } = await read("/bin/bash", env);

    expect(result).toMatchObject({ source: "login-shell", shell: "/bin/bash" });
    expect(result.path.split(":")[0]).toBe("/custom/bash/bin");
  });

  it("ignores banners and echoed commands that rc files print", async () => {
    const env = await homeWith({
      ".zshrc":
        'echo "welcome __ATRIUM_ back"\nexec 2>&1\nsetopt verbose xtrace\nexport PATH=/custom/noisy/bin:$PATH\n',
    });

    const { result } = await read("/bin/zsh", env);

    expect(result.path.split(":")[0]).toBe("/custom/noisy/bin");
  });

  it("falls back to a login-only shell when the interactive one hangs, and kills what it started", async () => {
    const env = await homeWith({
      ".zprofile": "export PATH=/custom/profile/bin:$PATH\n",
      ".zshrc": "sleep 4321\n",
    });

    const { result, failures } = await read("/bin/zsh", env, { timeoutMs: 1_000 });

    expect(result.path.split(":")[0]).toBe("/custom/profile/bin");
    expect(failures).toStrictEqual([{ args: ["-i", "-l", "-c"], reason: "timeout" }]);
    expect(running("sleep 4321")).toStrictEqual([]);
  });

  it("keeps the inherited PATH when both attempts fail, reporting each", async () => {
    const env = await homeWith({ ".zprofile": "exit 3\n" });

    const { result, failures } = await read("/bin/zsh", env);

    expect(result).toStrictEqual({ source: "inherited", path: INHERITED, reason: "failed", shell: "/bin/zsh" });
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
    const { result, failures } = await read("/nonexistent/zsh", { PATH: INHERITED });

    expect(result).toStrictEqual({ source: "inherited", path: INHERITED, reason: "failed", shell: "/nonexistent/zsh" });
    expect(failures).toStrictEqual([
      { args: ["-i", "-l", "-c"], reason: "spawn" },
      { args: ["-l", "-c"], reason: "spawn" },
    ]);
  });

  it("does not run shells outside the POSIX family, or when there is no shell", async () => {
    expect((await read("/opt/homebrew/bin/fish", { PATH: INHERITED })).result).toStrictEqual({
      source: "inherited",
      path: INHERITED,
      reason: "unsupported-shell",
      shell: "/opt/homebrew/bin/fish",
    });
    expect(await readLoginShellPath({ shell: undefined, env: {}, clock: systemClock })).toStrictEqual({
      source: "inherited",
      path: "",
      reason: "no-shell",
    });
  });

  it("stops at once when aborted, killing the running shell", async () => {
    const env = await homeWith({ ".zprofile": "sleep 4322\n" });
    const controller = new AbortController();

    const reading = read("/bin/zsh", env, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    const { result, failures } = await reading;

    expect(result).toMatchObject({ source: "inherited", reason: "failed" });
    expect(failures).toStrictEqual([{ args: ["-i", "-l", "-c"], reason: "aborted" }]);
    expect(running("sleep 4322")).toStrictEqual([]);
  });
});
