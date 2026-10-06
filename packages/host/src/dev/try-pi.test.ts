import type { PiEvent } from "@atrium/pi";
import { type ScriptedPiBehavior, createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { type TryOptions, main, parseTryArgs, renderEvent, runTry } from "./try-pi";

describe("parseTryArgs", () => {
  it("joins the prompt words and passes everything after -- to pi", () => {
    expect(parseTryArgs(["explain", "this", "--keep-session", "--", "--model", "x"], "/here")).toStrictEqual({
      prompt: "explain this",
      cwd: "/here",
      inheritEnv: false,
      keepSession: true,
      piArgs: ["--model", "x"],
    });
  });

  it("resolves --cwd against the directory the command ran in and reads --inherit-env", () => {
    expect(parseTryArgs(["--cwd", "sub", "--inherit-env", "hi"], "/here")).toStrictEqual({
      prompt: "hi",
      cwd: "/here/sub",
      inheritEnv: true,
      keepSession: false,
      piArgs: [],
    });
  });

  it.each([
    [[], "usage:"],
    [["--", "--model", "x"], "usage:"],
    [["hi", "--cwd"], "--cwd needs a directory"],
    [["hi", "--verbose"], "unknown option --verbose"],
    [["   "], "usage:"],
  ])("refuses %j", (argv, message) => {
    expect(parseTryArgs(argv, "/here")).toStrictEqual({ error: expect.stringContaining(message) });
  });
});

/** A `message_update` event carrying this assistant event. */
function update(assistantMessageEvent: object): PiEvent {
  return { type: "message_update", assistantMessageEvent } as unknown as PiEvent;
}

describe("renderEvent", () => {
  it("prints reply text as is and thinking dimmed, ending thinking with a line break", () => {
    expect(renderEvent(update({ type: "text_delta", delta: "Hi" }), true)).toStrictEqual({ out: "Hi", err: "" });
    expect(renderEvent(update({ type: "thinking_delta", delta: "hmm" }), true)).toStrictEqual({
      out: "\u001b[2mhmm\u001b[22m",
      err: "",
    });
    expect(renderEvent(update({ type: "thinking_delta", delta: "hmm" }), false)).toStrictEqual({ out: "hmm", err: "" });
    expect(renderEvent(update({ type: "thinking_end" }), false)).toStrictEqual({ out: "\n", err: "" });
  });

  it("puts tool calls on their own line and model errors on stderr", () => {
    const tool = { type: "tool_execution_start", toolName: "bash", args: { command: "ls" } } as unknown as PiEvent;
    const failed = {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "overloaded" },
    } as unknown as PiEvent;

    expect(renderEvent(tool, false)).toStrictEqual({ out: '\n[bash] {"command":"ls"}\n', err: "" });
    expect(renderEvent(failed, false)).toStrictEqual({ out: "", err: "\npi: overloaded\n" });
    const silent = { type: "message_end", message: { role: "assistant", stopReason: "error" } } as unknown as PiEvent;
    expect(renderEvent(silent, false)).toStrictEqual({ out: "", err: "\npi: error\n" });
    const user = { type: "message_end", message: { role: "user", stopReason: "error" } } as unknown as PiEvent;
    expect(renderEvent(user, false)).toStrictEqual({ out: "", err: "" });
  });

  it("ends the run with a line break and ignores everything else", () => {
    expect(renderEvent({ type: "agent_settled" } as unknown as PiEvent, false)).toStrictEqual({ out: "\n", err: "" });
    expect(renderEvent({ type: "turn_start" } as unknown as PiEvent, false)).toStrictEqual({ out: "", err: "" });
    expect(renderEvent(update({ type: "text_start" }), false)).toStrictEqual({ out: "", err: "" });
    expect(
      renderEvent(
        { type: "message_end", message: { role: "assistant", stopReason: "stop" } } as unknown as PiEvent,
        false,
      ),
    ).toStrictEqual({ out: "", err: "" });
  });
});

describe("runTry", () => {
  it("reports a pi that is not ready and exits with 1, still printing the trace", async () => {
    const home = await createTempDir("try-home");
    onTestFinished(home.cleanup);
    const out: string[] = [];
    const err: string[] = [];

    const code = await runTry(
      { prompt: "hi", cwd: home.path, inheritEnv: true, keepSession: false, piArgs: [] },
      {
        home: home.path,
        env: { PATH: "" },
        stdout: { write: (text) => out.push(text), color: false },
        stderr: { write: (text) => err.push(text), color: false },
      },
    );

    expect(code).toBe(1);
    expect(out).toStrictEqual([]);
    expect(err[0]).toBe('pi is missing: {"status":"missing"}\n');
    expect(err[1]).toMatch(/^trace [0-9a-f]{32} · pnpm trace [0-9a-f]{32} .+dev-logs\n$/);
  });
});

/** Runs `runTry` with a scripted `pi` first on PATH, capturing output and log records. */
async function tryScripted(
  behavior: ScriptedPiBehavior,
  options: Partial<TryOptions> = {},
  extraEnv: Record<string, string> = {},
  hooks: { readonly signal?: AbortSignal; readonly onStdout?: (text: string) => void } = {},
) {
  const dir = await createTempDir("try-scripted");
  onTestFinished(dir.cleanup);
  const scripted = await writeScriptedPi(dir.path, behavior, "pi");
  const out: string[] = [];
  const err: string[] = [];
  const code = await runTry(
    { prompt: "hi", cwd: dir.path, inheritEnv: true, keepSession: false, piArgs: [], ...options },
    {
      home: join(dir.path, "atrium"),
      env: { PATH: `${dir.path}:/usr/bin:/bin`, ...scripted.env, ...extraEnv },
      stdout: {
        write: (text) => {
          out.push(text);
          hooks.onStdout?.(text);
        },
        color: false,
      },
      stderr: { write: (text) => err.push(text), color: false },
      ...(hooks.signal === undefined ? {} : { signal: hooks.signal }),
    },
  );
  const log = await readFile(join(dir.path, "atrium", "dev-logs", "current.log"), "utf8");
  const records = log
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { code, out: out.join(""), err: err.join(""), records, dir: dir.path };
}

/** A stdout hook that aborts `controller` once `text` has been written. */
function abortOn(controller: AbortController, text: string): (written: string) => void {
  return (written) => {
    if (written === text) controller.abort();
  };
}

/** An assistant `message_end` record with this stop reason. */
function reply(stopReason: string): object {
  return { type: "message_end", message: { role: "assistant", stopReason, errorMessage: "overloaded" } };
}

/** A `message_update` record as pi prints it. */
function delta(type: "text_delta" | "thinking_delta", text: string): object {
  return { type: "message_update", assistantMessageEvent: { type, delta: text } };
}

describe("runTry with a scripted pi", () => {
  it("streams the reply until pi settles, then stops pi, all under one trace", async () => {
    const { code, out, err, records } = await tryScripted({
      rules: {
        prompt: {
          data: { disposition: "started" },
          events: [
            delta("thinking_delta", "Hm."),
            delta("text_delta", "Hel"),
            delta("text_delta", "lo."),
            { type: "agent_settled" },
          ],
        },
      },
    });

    // Stderr first: when this fails, it shows why the run did not succeed.
    expect(err).toMatch(/^trace ([0-9a-f]{32}) · pnpm trace \1 .+dev-logs\n$/);
    expect(code).toBe(0);
    expect(out).toBe("Hm.Hello.\n");
    const traceId = /^trace ([0-9a-f]{32})/.exec(err)?.[1];
    expect(new Set(records.map((record) => record["service"]))).toStrictEqual(new Set(["host"]));
    const spans = records.filter((record) => record["kind"] === "span");
    expect(spans.map((span) => [span["name"], span["status"], span["trace_id"]])).toStrictEqual([
      ["pi.rpc prompt", "ok", traceId],
      ["pi.process", "ok", traceId],
      ["dev.try-pi", "ok", traceId],
    ]);
  });

  it.each([
    [false, ["--mode", "rpc", "--no-session", "--model", "x"]],
    [true, ["--mode", "rpc", "--model", "x"]],
  ])("starts pi in the chosen directory with the extra arguments (keep session: %s)", async (keepSession, argv) => {
    const { records, dir } = await tryScripted(
      { argvToStderr: true, rules: { prompt: { data: { disposition: "handled" } } } },
      { piArgs: ["--model", "x"], keepSession },
    );

    const line = records.find((record) => record["msg"] === "pi stderr")?.["line"];
    expect(JSON.parse(String(line))).toStrictEqual({ argv, cwd: await realpath(dir) });
  });

  it("finishes at once when pi handles the prompt without a run", async () => {
    const { code, records } = await tryScripted({ rules: { prompt: { data: { disposition: "handled" } } } });

    expect(code).toBe(0);
    expect(records.filter((record) => record["msg"] === "pi exited")).toMatchObject([{ requested: true }]);
  });

  it("exits with 1 when the model reply fails, printing the error", async () => {
    const failed = {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "overloaded" },
    };
    const { code, err } = await tryScripted({
      rules: { prompt: { data: { disposition: "started" }, events: [failed, { type: "agent_settled" }] } },
    });

    expect(code).toBe(1);
    expect(err.startsWith("\npi: overloaded\n")).toBe(true);
  });

  it("exits with 0 when an error is retried and the last reply succeeds", async () => {
    const { code, err } = await tryScripted({
      rules: {
        prompt: {
          data: { disposition: "started" },
          events: [reply("error"), reply("stop"), { type: "agent_settled" }],
        },
      },
    });

    expect(code).toBe(0);
    expect(err.startsWith("\npi: overloaded\n")).toBe(true);
  });

  it("keeps credentials from the environment out of its log, even when pi prints them", async () => {
    const { code, records } = await tryScripted(
      { stderr: "auth failed for sk-try-0123456789\n", rules: { prompt: { data: { disposition: "handled" } } } },
      {},
      { OPENAI_API_KEY: "sk-try-0123456789" },
    );

    expect(code).toBe(0);
    expect(JSON.stringify(records)).not.toContain("sk-try-0123456789");
    expect(records.find((record) => record["msg"] === "pi stderr")).toMatchObject({
      line: "auth failed for [redacted]",
    });
  });

  it("exits with 1 when pi dies before the run settles", async () => {
    const { code, err, records } = await tryScripted({
      rules: { prompt: { data: { disposition: "started" }, exitAfter: 3 } },
    });

    expect(code).toBe(1);
    expect(err).toMatch(/^trace /);
    expect(records.filter((record) => record["msg"] === "pi exited")).toMatchObject([{ code: 3, requested: false }]);
  });

  it("exits with 1 when the prompt is rejected", async () => {
    const { code, err } = await tryScripted({ rules: { prompt: { fail: "No model selected" } } });

    expect(code).toBe(1);
    expect(err.startsWith("pi: pi prompt rejected: No model selected\n")).toBe(true);
  });

  it("reads the login shell's environment unless asked to inherit, and runs the pi found there", async () => {
    const shellHome = await createTempDir("try-shell");
    onTestFinished(shellHome.cleanup);
    const bin = await createTempDir("try-bin");
    onTestFinished(bin.cleanup);
    const scripted = await writeScriptedPi(
      bin.path,
      { stderr: "token sk-zshrc-0123456789\n", rules: { prompt: { data: { disposition: "handled" } } } },
      "pi",
    );
    await writeFile(
      join(shellHome.path, ".zshrc"),
      `export PATH=${bin.path}:$PATH\nexport OPENAI_API_KEY=sk-zshrc-0123456789\nexport SCRIPTED_PI_BEHAVIOR='${present(scripted.env["SCRIPTED_PI_BEHAVIOR"], "behavior")}'\n`,
    );

    const code = await runTry(
      { prompt: "hi", cwd: shellHome.path, inheritEnv: false, keepSession: false, piArgs: [] },
      {
        home: join(shellHome.path, "atrium"),
        env: { SHELL: "/bin/zsh", HOME: shellHome.path, ZDOTDIR: shellHome.path, PATH: "/usr/bin:/bin" },
        stdout: { write: () => undefined, color: false },
        stderr: { write: () => undefined, color: false },
      },
    );

    const log = await readFile(join(shellHome.path, "atrium", "dev-logs", "current.log"), "utf8");
    const process = log
      .split("\n")
      .filter((line) => line.includes('"name":"pi.process"'))
      .map((line) => JSON.parse(line) as { attributes: Record<string, unknown> });
    expect(code).toBe(0);
    expect(process.map((span) => span.attributes["pi.path"])).toStrictEqual([join(bin.path, "pi")]);
    // The key exists only in .zshrc, so only the login shell's environment can name it.
    expect(log).not.toContain("sk-zshrc-0123456789");
  });
});

describe("main", () => {
  it("prints usage and exits with 2 for bad arguments", async () => {
    const err: string[] = [];

    const code = await main(
      ["--verbose"],
      {},
      { write: () => undefined, color: false },
      { write: (t) => err.push(t), color: false },
    );

    expect(code).toBe(2);
    expect(err).toStrictEqual([expect.stringMatching(/^unknown option --verbose\nusage: .+\n$/)]);
  });

  it("runs in the directory pnpm was started from, logging under ATRIUM_HOME", async () => {
    const dir = await createTempDir("try-main");
    onTestFinished(dir.cleanup);
    const scripted = await writeScriptedPi(
      dir.path,
      { argvToStderr: true, rules: { prompt: { data: { disposition: "handled" } } } },
      "pi",
    );
    const home = join(dir.path, "atrium");

    const code = await main(
      ["hi", "--inherit-env"],
      { PATH: `${dir.path}:/usr/bin:/bin`, INIT_CWD: dir.path, ATRIUM_HOME: home, ...scripted.env },
      { write: () => undefined, color: false },
      { write: () => undefined, color: false },
    );

    const log = await readFile(join(home, "dev-logs", "current.log"), "utf8");
    const stderrLine = log.split("\n").find((line) => line.includes('"msg":"pi stderr"'));
    expect(code).toBe(0);
    expect(JSON.parse((JSON.parse(present(stderrLine, "pi stderr line")) as { line: string }).line)).toMatchObject({
      cwd: await realpath(dir.path),
    });
  });
});

describe("runTry checks pi first", () => {
  it("refuses an outdated pi, which also shows the environment reaches pi --version", async () => {
    const { code, err } = await tryScripted({ version: "0.5.0" });

    expect(code).toBe(1);
    expect(err.startsWith('pi is outdated: {"status":"outdated"')).toBe(true);
  });
});

describe("runTry interrupted", () => {
  it("stops pi and exits with 130 when interrupted mid-run", async () => {
    const interrupt = new AbortController();
    // Interrupt the moment the reply has started streaming.
    const { code, out, records } = await tryScripted(
      { rules: { prompt: { data: { disposition: "started" }, events: [delta("text_delta", "partial")] } } },
      {},
      {},
      { signal: interrupt.signal, onStdout: abortOn(interrupt, "partial") },
    );

    expect(code).toBe(130);
    expect(out).toBe("partial");
    expect(records.filter((record) => record["msg"] === "pi exited")).toMatchObject([{ requested: true }]);
  });

  it("exits with 130 without starting pi when interrupted before", async () => {
    const interrupt = new AbortController();
    interrupt.abort();

    const { code, records } = await tryScripted({}, {}, {}, { signal: interrupt.signal });

    expect(code).toBe(130);
    expect(records.filter((record) => record["msg"] === "pi started")).toStrictEqual([]);
  });
});
