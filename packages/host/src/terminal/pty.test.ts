import { describe, expect, it, vi } from "vitest";
import { spawnPty, terminalEnv } from "./pty";

describe("terminalEnv", () => {
  it("starts a shell like a terminal app does, not like this process", () => {
    const env = terminalEnv({
      HOME: "/Users/me",
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
      PATH: "/extra/bin:/usr/bin",
      ATRIUM_TOKEN: "secret",
      PI_SESSION_ID: "abc",
      AI_AGENT: "1",
    });
    expect(env).toStrictEqual({
      HOME: "/Users/me",
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
  });
});

describe("terminalEnv", () => {
  it("keeps every variable a terminal starts with, and adds its own two", () => {
    const env = terminalEnv({
      HOME: "/h",
      USER: "u",
      LOGNAME: "u",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp",
      LANG: "zh_CN.UTF-8",
      LC_ALL: "zh_CN.UTF-8",
      LC_CTYPE: "zh_CN.UTF-8",
      SSH_AUTH_SOCK: "/sock",
      ZDOTDIR: "/z",
      __CF_USER_TEXT_ENCODING: "0x1F5:0:0",
    });
    expect(Object.keys(env).toSorted()).toStrictEqual(
      [
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
        "TERM",
        "COLORTERM",
      ].toSorted(),
    );
    expect(env["TERM"]).toBe("xterm-256color");
    expect(env["COLORTERM"]).toBe("truecolor");
  });

  it("leaves out what the host happens to hold: PATH, tokens, pi's own variables", () => {
    const env = terminalEnv({
      PATH: "/a:/b",
      ATRIUM_TOKEN: "t",
      PI_SESSION_ID: "s",
      AI_AGENT: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      VIBE_ISLAND_PI_ROOT_SESSION_ID: "v",
    });
    expect(env).toStrictEqual({ TERM: "xterm-256color", COLORTERM: "truecolor" });
  });
});

describe("spawnPty", () => {
  it("runs a real login shell in a PTY and prints what it is told", async () => {
    const pty = spawnPty({ shell: "/bin/zsh", cwd: "/tmp", cols: 80, rows: 24, env: terminalEnv(process.env) });
    let output = "";
    pty.onData((data) => {
      output += data;
    });
    // The shell may still be reading its startup files, so the command is offered until it takes.
    const offer = setInterval(() => pty.write("echo pty-ok\r"), 400);
    try {
      await vi.waitFor(() => expect(output).toContain("pty-ok"), { timeout: 15_000, interval: 200 });
    } finally {
      clearInterval(offer);
      pty.kill();
    }
  }, 20_000);
});

describe("the PTY wrapper", () => {
  it("writes, resizes and kills the process it wraps", async () => {
    const pty = spawnPty({ shell: "/bin/zsh", cwd: "/tmp", cols: 80, rows: 24, env: terminalEnv(process.env) });
    let exited: number | null = null;
    pty.onExit((event) => {
      exited = event.exitCode;
    });
    pty.resize(100, 40);
    let output = "";
    pty.onData((data) => {
      output += data;
    });
    // A resize reaches the shell as SIGWINCH: the prompt is drawn again at the new width.
    await vi.waitFor(() => expect(output.length).toBeGreaterThan(0), { timeout: 15_000, interval: 200 });
    expect(pty.pid).toBeGreaterThan(0);
    pty.kill();
    await vi.waitFor(() => expect(exited).not.toBeNull(), { timeout: 15_000, interval: 200 });
  }, 20_000);
});
