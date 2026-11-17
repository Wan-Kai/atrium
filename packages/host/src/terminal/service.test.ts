import { CommandError, type Terminal } from "@atrium/protocol";
import { FakeClock } from "@atrium/testkit";
import { ResourceTracker } from "../platform/resources";
import { describe, expect, it } from "vitest";
import type { Logger } from "../platform/logger";
import type { PtySpawnInput, PtyProcess } from "./pty";
import { type TerminalEvent, createTerminalService } from "./service";

/** The socket events go to, the client that owns a terminal, and another client. */
const CONN = "conn-1";
const CLIENT = "client-1";
const CALLER = { connectionId: CONN, clientId: CLIENT };
const OTHER = "client-2";
const OTHER_CALLER = { connectionId: "conn-2", clientId: OTHER };
const W1 = "wks_0000000000000001";
const SESSION = "sess-1";

/** A logger that keeps what it was told to warn about. */
function quietLogger(warnings: string[] = []): Logger {
  const log = (level: string) => (_fields: unknown, message?: string) => {
    if (level === "warn") warnings.push(message ?? "");
  };
  return {
    trace: log("trace"),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    fatal: log("fatal"),
    child: () => quietLogger(warnings),
  } as unknown as Logger;
}

/** A PTY a test drives: it records what it was told and lets the test write output and exit. */
function fakePty(input: PtySpawnInput) {
  let onData: ((data: string) => void) | null = null;
  let onExit: ((event: { exitCode: number }) => void) | null = null;
  const calls: string[] = [];
  const process: PtyProcess = {
    pid: 4242,
    write: (data) => calls.push(`write:${data}`),
    resize: (cols, rows) => calls.push(`resize:${cols}x${rows}`),
    kill: (signal) => calls.push(`kill:${signal ?? "SIGTERM"}`),
    onData: (listener) => {
      onData = listener;
    },
    onExit: (listener) => {
      onExit = listener;
    },
  };
  return {
    input,
    process,
    calls,
    output: (data: string) => onData?.(data),
    exit: (exitCode: number) => onExit?.({ exitCode }),
  };
}

/** The service with fakes around it; `children` decides what `ps` answers. */
function harness(options: { readonly childrenFails?: boolean } = {}) {
  const clock = new FakeClock();
  const resources = new ResourceTracker();
  const sent: Array<[string, TerminalEvent]> = [];
  const spawned: Array<ReturnType<typeof fakePty>> = [];
  const warnings: string[] = [];
  const dirs = new Map<string, string>([[W1, "/work/a"]]);
  const service = createTerminalService({
    shell: "/bin/zsh",
    dirOf: (containerId) => dirs.get(containerId),
    home: "/Users/me",
    env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
    spawn: (input) => {
      const pty = fakePty(input);
      spawned.push(pty);
      return pty.process;
    },
    send: (connectionId, event) => sent.push([connectionId, event]),
    broadcast: (event) => sent.push(["all", event]),
    clock,
    resources,
    logger: quietLogger(warnings),
    childrenOf: async () => {
      if (options.childrenFails === true) throw new Error("ps: no such process");
      return [4300];
    },
    killGraceMs: 3000,
  });
  return { service, clock, sent, spawned, warnings, dirs };
}

/** What each `terminal_output` event carried, in order. */
function outputTexts(sent: Array<[string, TerminalEvent]>): string[] {
  return sent.flatMap(([, event]) => (event.type === "terminal_output" ? [event.data] : []));
}

/** The last event of a type, for assertions. */
function lastEvent(sent: Array<[string, TerminalEvent]>, type: TerminalEvent["type"]): TerminalEvent | undefined {
  return sent.filter(([, event]) => event.type === type).at(-1)?.[1];
}

/** The code of the error `run` throws. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CommandError) return error.code;
    throw error;
  }
  throw new Error("nothing was thrown");
}

/** Opens a terminal in the workspace and returns it. */
function openIn(service: ReturnType<typeof harness>["service"], caller = CALLER): Terminal {
  return service.open({ caller, containerId: W1, cols: 100, rows: 30 });
}

/**
 * Opens a terminal the way the agent tool does.
 *
 * @remarks
 * An agent's terminal belongs to no window, so it is told to every local connection.
 *
 * @sideEffects Starts a terminal.
 * @param service - The service.
 * @param sessionId - The agent's session.
 * @returns The terminal.
 */
function agentOpen(service: ReturnType<typeof harness>["service"], sessionId = SESSION): Terminal {
  return service.open({
    caller: { connectionId: "conn-agent", clientId: sessionId },
    containerId: W1,
    cols: 80,
    rows: 24,
    origin: "agent",
    sessionId,
  });
}

describe("open", () => {
  it("starts a shell in the container's directory and tells its connection", () => {
    const { service, sent, spawned } = harness();
    const terminal = openIn(service);
    expect(spawned[0]?.input).toStrictEqual({
      shell: "/bin/zsh",
      cwd: "/work/a",
      cols: 100,
      rows: 30,
      env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    expect(terminal).toMatchObject({ containerId: W1, cwd: "/work/a", state: "running", origin: "user" });
    expect(sent).toStrictEqual([[CONN, { type: "terminal_opened", terminal }]]);
  });

  it("opens a chat's terminal in the home directory", () => {
    const { service, spawned } = harness();
    service.open({ caller: CALLER, containerId: "cht_a", cols: 80, rows: 24 });
    expect(spawned[0]?.input.cwd).toBe("/Users/me");
  });

  it("refuses a container whose directory is gone", () => {
    const { service } = harness();
    expect(
      codeOf(() => service.open({ caller: CALLER, containerId: "wks_0000000000000009", cols: 80, rows: 24 })),
    ).toBe("terminal_cwd_invalid");
  });

  it("names the terminal after the command it runs", () => {
    const { service, spawned } = harness();
    service.open({ caller: CALLER, containerId: W1, cols: 80, rows: 24, command: "npm run dev" });
    expect(spawned[0]?.calls).toContain("write:npm run dev\r");
    expect(lastEventFrom(service)).toMatchObject({ title: "npm" });
  });

  it("stops at the container's limit", () => {
    const { service } = harness();
    for (let i = 0; i < 4; i += 1) openIn(service);
    expect(codeOf(() => openIn(service))).toBe("terminal_limit");
  });

  it("reports a shell that will not start", () => {
    const clock = new FakeClock();
    const service = createTerminalService({
      shell: "/bin/zsh",
      dirOf: () => "/work/a",
      home: "/Users/me",
      env: {},
      spawn: () => {
        throw new Error("posix_spawnp failed");
      },
      send: () => {},
      broadcast: () => {},
      clock,
      resources: new ResourceTracker(),
      logger: quietLogger(),
      childrenOf: async () => [],
    });
    expect(codeOf(() => service.open({ caller: CALLER, containerId: W1, cols: 80, rows: 24 }))).toBe(
      "terminal_spawn_failed",
    );
  });
});

describe("titles and delivery", () => {
  it("names a terminal by the agent's title, then the command, then the directory", () => {
    const { service, sent } = harness();
    service.open({
      caller: CALLER,
      containerId: W1,
      cols: 80,
      rows: 24,
      title: "  dev server  ",
      command: "npm run dev",
    });
    const byTitle = sent.filter(([, event]) => event.type === "terminal_opened").at(-1);
    expect(byTitle?.[1]).toMatchObject({ terminal: { title: "dev server" } });

    service.open({ caller: CALLER, containerId: W1, cols: 80, rows: 24, command: "/usr/bin/npm run dev" });
    const byCommand = sent.filter(([, event]) => event.type === "terminal_opened").at(-1);
    expect(byCommand?.[1]).toMatchObject({ terminal: { title: "npm" } });

    service.open({ caller: CALLER, containerId: W1, cols: 80, rows: 24 });
    const byDirectory = sent.filter(([, event]) => event.type === "terminal_opened").at(-1);
    expect(byDirectory?.[1]).toMatchObject({ terminal: { title: "a" } });
  });

  it("sends a rebuilt tab's output to the connection it came back on", () => {
    const { service, clock, sent, spawned } = harness();
    const terminal = openIn(service);
    // The page reloaded: same client, a new socket.
    service.attach({ connectionId: "conn-9", clientId: CLIENT }, terminal.id);
    spawned[0]?.output("after reload");
    clock.advance(20);
    expect(sent.at(-1)).toStrictEqual([
      "conn-9",
      { type: "terminal_output", terminalId: terminal.id, data: "after reload" },
    ]);
  });

  it("paces output instead of letting a burst fill the connection", () => {
    const { service, clock, sent, spawned } = harness();
    openIn(service);
    // 100 KiB in one write: the first flush is capped, the rest follows.
    spawned[0]?.output("a".repeat(100 * 1024));
    clock.advance(20);
    expect(outputTexts(sent).map((text) => text.length)).toStrictEqual([64 * 1024]);
    clock.advance(20);
    expect(outputTexts(sent).map((text) => text.length)).toStrictEqual([64 * 1024, 100 * 1024 - 64 * 1024]);
  });

  it("drops the oldest output past the queue cap, and says so on the screen", () => {
    const { service, clock, sent, spawned } = harness();
    openIn(service);
    spawned[0]?.output("x".repeat(3 * 1024 * 1024));
    clock.advance(20);
    expect(outputTexts(sent).join("")).toContain("[output dropped");
  });

  it("stops listing a terminal once it ended", () => {
    const { service, spawned } = harness();
    const first = openIn(service);
    const second = openIn(service);
    spawned[0]?.exit(0);
    expect(service.openTerminals()).toStrictEqual([second]);
    expect(first.id).not.toBe(second.id);
  });
});

describe("attach, write and resize", () => {
  it("attaches with the output so far and refuses a second connection", () => {
    const { service, spawned } = harness();
    const terminal = openIn(service);
    spawned[0]?.output("hello\r\n");
    expect(service.attach(CALLER, terminal.id)).toStrictEqual({ terminal, history: "hello\r\n" });
    expect(codeOf(() => service.attach(OTHER_CALLER, terminal.id))).toBe("terminal_not_owner");
  });

  it("writes and resizes for the owner only", () => {
    const { service, spawned } = harness();
    const terminal = openIn(service);
    service.write(CALLER, terminal.id, "ls\r");
    service.resize(CALLER, terminal.id, 120, 40);
    expect(spawned[0]?.calls).toStrictEqual(["write:ls\r", "resize:120x40"]);
    expect(codeOf(() => service.write(OTHER_CALLER, terminal.id, "rm -rf /\r"))).toBe("terminal_not_owner");
    expect(codeOf(() => service.resize(OTHER_CALLER, terminal.id, 10, 10))).toBe("terminal_not_owner");
  });

  it("has nothing to attach to once the terminal is gone", () => {
    const { service } = harness();
    expect(codeOf(() => service.attach(CALLER, "term_0123456789abcdef"))).toBe("terminal_not_found");
  });
});

describe("what the window may send", () => {
  it("counts a paste in bytes, not characters", () => {
    const { service } = harness();
    const terminal = openIn(service);
    // 2000 CJK characters are under the schema's 64 000 characters but three times over 4 KiB.
    expect(codeOf(() => service.write(CALLER, terminal.id, "中".repeat(2000)))).toBe("terminal_write_too_large");
    expect(() => service.write(CALLER, terminal.id, "ok")).not.toThrow();
  });
});

describe("output and exit", () => {
  it("sends output to the connection and keeps it for replay", () => {
    const { service, clock, sent, spawned } = harness();
    const terminal = openIn(service);
    spawned[0]?.output("hello\r\n");
    clock.advance(20);
    expect(sent.at(-1)).toStrictEqual([CONN, { type: "terminal_output", terminalId: terminal.id, data: "hello\r\n" }]);
    expect(service.attach(CALLER, terminal.id).history).toBe("hello\r\n");
  });

  it("marks the terminal ended and then releases it", () => {
    const { service, sent, spawned } = harness();
    const terminal = openIn(service);
    spawned[0]?.exit(0);
    expect(lastEvent(sent, "terminal_exited")).toStrictEqual({
      type: "terminal_exited",
      terminalId: terminal.id,
      exitCode: 0,
    });
    expect(lastEvent(sent, "terminal_closed")).toStrictEqual({ type: "terminal_closed", terminalId: terminal.id });
    expect(service.openTerminals()).toStrictEqual([]);
  });
});

describe("close", () => {
  it("asks the process group to stop, and releases it when it exits", async () => {
    const { service, sent, spawned } = harness();
    const terminal = openIn(service);
    const closing = service.close(CALLER, terminal.id, true);
    expect(spawned[0]?.calls).toContain("kill:SIGTERM");
    spawned[0]?.exit(143);
    await closing;
    expect(lastEvent(sent, "terminal_closed")).toStrictEqual({ type: "terminal_closed", terminalId: terminal.id });
  });

  it("forces the kill after the grace period", async () => {
    const { service, clock, spawned } = harness();
    const terminal = openIn(service);
    const closing = service.close(CALLER, terminal.id, true);
    clock.advance(3000);
    expect(spawned[0]?.calls).toContain("kill:SIGKILL");
    clock.advance(1000);
    await closing;
  });

  it("asks before ending a program that is still running", async () => {
    const { service, spawned } = harness();
    const terminal = openIn(service);
    await expect(service.close(CALLER, terminal.id)).rejects.toMatchObject({ code: "terminal_has_process" });
    expect(spawned[0]?.calls.filter((call) => call.startsWith("kill:"))).toStrictEqual([]);
  });

  it("closes an already exited terminal without signalling it", async () => {
    const { service, spawned } = harness();
    const terminal = openIn(service);
    spawned[0]?.exit(0);
    await service.close(CALLER, terminal.id, true);
    expect(spawned[0]?.calls.filter((call) => call.startsWith("kill:"))).toStrictEqual([]);
  });

  it("refuses another connection", async () => {
    const { service } = harness();
    const terminal = openIn(service);
    await expect(service.close(OTHER_CALLER, terminal.id, true)).rejects.toMatchObject({ code: "terminal_not_owner" });
  });
});

describe("what an agent may do", () => {
  it("tells every local connection, since the terminal belongs to no window", () => {
    const { service, sent } = harness();
    const terminal = agentOpen(service);
    expect(sent[0]).toStrictEqual(["all", { type: "terminal_opened", terminal }]);
  });

  it("keeps a container to six agent terminals, whatever the sessions", () => {
    const { service } = harness();
    for (let i = 0; i < 6; i += 1) agentOpen(service, `sess-${String(i)}`);
    expect(codeOf(() => agentOpen(service, "sess-more"))).toBe("terminal_limit");
  });

  it("lets a window show a terminal an agent opened, without taking it from the agent", async () => {
    const { service, spawned } = harness();
    const terminal = agentOpen(service);
    spawned[0]?.output("hello");
    // The window attaches with its own client id, which is not the session's.
    expect(service.attach(CALLER, terminal.id).history).toBe("hello");
    // The agent still drives it after the window attached.
    void service.agentKey(SESSION, terminal.id, "enter");
    expect(spawned[0]?.calls).toContain("write:\r");
  });

  it("runs the command it was opened with, and lets its agent read what came back", async () => {
    const { service, spawned } = harness();
    const terminal = service.open({
      caller: { connectionId: "conn-agent", clientId: SESSION },
      containerId: W1,
      cols: 80,
      rows: 24,
      origin: "agent",
      sessionId: SESSION,
      command: "echo hi",
    });
    expect(spawned[0]?.calls).toContain("write:echo hi\r");
    spawned[0]?.output("hi\r\n");
    const reading = await service.agentRead(SESSION, terminal.id);
    expect(reading.text).toContain("hi");
    expect(reading.state).toBe("running");
  });

  it("reads the screen as text, without escape sequences", async () => {
    const { service, spawned } = harness();
    const terminal = agentOpen(service);
    spawned[0]?.output("\u001b[32mhello\u001b[0m\r\nworld\r\n");
    const reading = await service.agentRead(SESSION, terminal.id);
    expect(reading.text).toContain("hello");
    expect(reading.text).toContain("world");
    expect(reading.text).not.toContain("\u001b");
    expect(reading.cols).toBe(80);
    expect(reading.rows).toBe(24);
  });

  it("will not read or touch a terminal the user opened", async () => {
    const { service } = harness();
    const mine = openIn(service);
    await expect(service.agentRead(SESSION, mine.id)).rejects.toMatchObject({ code: "terminal_not_owner" });
    await expect(service.agentType(SESSION, mine.id, "rm -rf /", true)).rejects.toMatchObject({
      code: "terminal_not_owner",
    });
    await expect(service.agentKey(SESSION, mine.id, "enter")).rejects.toMatchObject({ code: "terminal_not_owner" });
  });

  it("writes for the owning agent only, within size and pace", async () => {
    const { service, clock, spawned } = harness();
    const other = agentOpen(service, OTHER);
    const terminal = agentOpen(service);
    const typing = service.agentType(SESSION, terminal.id, "ls", true);
    clock.advance(2000);
    await typing;
    expect(spawned[1]?.calls).toContain("write:ls\r");
    await expect(service.agentKey(OTHER, terminal.id, "enter")).rejects.toMatchObject({
      code: "terminal_not_owner",
    });
    await expect(service.agentType(SESSION, terminal.id, "x".repeat(4097))).rejects.toMatchObject({
      code: "terminal_write_too_large",
    });
    expect(other.id).not.toBe(terminal.id);
  });

  it("stops an agent that writes faster than a person could type", async () => {
    const { service } = harness();
    const terminal = agentOpen(service);
    for (let i = 0; i < 20; i += 1) void service.agentType(SESSION, terminal.id, "a");
    await expect(service.agentType(SESSION, terminal.id, "a")).rejects.toMatchObject({
      code: "terminal_write_too_fast",
    });
  });

  it("types text, as one paste when the program asked for bracketed paste", () => {
    const { service, spawned } = harness();
    const terminal = agentOpen(service);
    void service.agentType(SESSION, terminal.id, "line one\nline two");
    expect(spawned[0]?.calls.at(-1)).toBe("write:line one\nline two");

    spawned[0]?.output("\u001b[?2004h");
    void service.agentType(SESSION, terminal.id, "line one\nline two", true);
    expect(spawned[0]?.calls.at(-1)).toBe("write:\u001b[200~line one\nline two\u001b[201~\r");

    spawned[0]?.output("\u001b[?2004l");
    void service.agentType(SESSION, terminal.id, "plain", true);
    expect(spawned[0]?.calls.at(-1)).toBe("write:plain\r");
  });

  it("says whether the screen settled, so the model need not guess", async () => {
    const { service, clock, spawned } = harness();
    const terminal = agentOpen(service);
    const still = service.agentType(SESSION, terminal.id, "ls", true);
    clock.advance(2000);
    await expect(still).resolves.toBe(false);

    const typing = service.agentType(SESSION, terminal.id, "ls", true);
    spawned[0]?.output("ls\r\n");
    clock.advance(300);
    await expect(typing).resolves.toBe(true);
  });

  it("does not answer a write until the screen has settled after it", async () => {
    const { service, clock, spawned } = harness();
    const terminal = agentOpen(service);
    let answered = false;
    const typing = service.agentType(SESSION, terminal.id, "ls", true);
    void typing.then(() => {
      answered = true;
      return answered;
    });
    clock.advance(300);
    // Nothing printed since the write, so there is no settled screen to read yet.
    expect(answered).toBe(false);
    spawned[0]?.output("ls\r\n");
    clock.advance(300);
    await typing;
    expect(answered).toBe(true);
  });

  it("sees a bracketed-paste change the PTY split across two reads", () => {
    const { service, spawned } = harness();
    const terminal = agentOpen(service);
    spawned[0]?.output("\u001b[?20");
    spawned[0]?.output("04h");
    const typing = service.agentType(SESSION, terminal.id, "one\ntwo");
    expect(spawned[0]?.calls.at(-1)).toBe("write:\u001b[200~one\ntwo\u001b[201~");
    void typing;
  });

  it("presses named keys, and refuses anything outside the table", async () => {
    const { service, clock, spawned } = harness();
    const terminal = agentOpen(service);
    const pressed = [
      service.agentKey(SESSION, terminal.id, "enter"),
      service.agentKey(SESSION, terminal.id, "shift-tab"),
    ];
    clock.advance(2000);
    await Promise.all(pressed);
    expect(spawned[0]?.calls.slice(-2)).toStrictEqual(["write:\r", "write:\u001b[Z"]);
    await expect(service.agentKey(SESSION, terminal.id, "f13" as "enter")).rejects.toMatchObject({
      code: "invalid_message",
    });
  });

  it("passes on what the program reported about itself", async () => {
    const { service, spawned } = harness();
    const terminal = agentOpen(service);
    spawned[0]?.output("\u001b]7501;state=blocked:app=claude\u0007");
    await expect(service.agentRead(SESSION, terminal.id)).resolves.toMatchObject({
      reported: { state: "blocked", app: "claude" },
    });
  });

  it("can wait for the process to end rather than for silence", async () => {
    const { service, clock, spawned } = harness();
    const terminal = agentOpen(service);
    const waiting = service.agentWait(SESSION, terminal.id, { until: "exited", quietMs: 200, timeoutMs: 5000 });
    // A screen that printed and then went quiet must not end a wait that asked for the exit.
    spawned[0]?.output("working");
    let answered = false;
    void waiting.then(() => {
      answered = true;
      return answered;
    });
    clock.advance(1000);
    expect(answered).toBe(false);
    spawned[0]?.exit(0);
    clock.advance(200);
    await expect(waiting).resolves.toStrictEqual({ quiet: false, exited: true, exitCode: 0 });
  });

  it("does not call a prompt that was already there quiet while a command starts", async () => {
    const { service, clock, spawned } = harness();
    const terminal = agentOpen(service);
    // The shell's prompt, long before the wait: it says nothing about the command just submitted.
    spawned[0]?.output("$ ");
    const waiting = service.agentWait(SESSION, terminal.id, { quietMs: 500, timeoutMs: 3000 });
    let answered = false;
    void waiting.then(() => {
      answered = true;
      return answered;
    });
    clock.advance(1200);
    expect(answered).toBe(false);
    clock.advance(3000);
    await expect(waiting).resolves.toStrictEqual({ quiet: false, exited: false, exitCode: null });
  });

  it("does not call a program that has not printed yet quiet", async () => {
    const { service, clock } = harness();
    const terminal = agentOpen(service);
    let settled = false;
    const waiting = service.agentWait(SESSION, terminal.id, { quietMs: 500, timeoutMs: 2000 });
    void waiting.then(() => {
      settled = true;
      return settled;
    });
    clock.advance(1500);
    expect(settled).toBe(false);
    clock.advance(1000);
    await expect(waiting).resolves.toStrictEqual({ quiet: false, exited: false, exitCode: null });
  });

  it("waits for quiet, and says so when the time is up instead", async () => {
    const { service, clock, spawned } = harness();
    const terminal = agentOpen(service);
    const quiet = service.agentWait(SESSION, terminal.id, { quietMs: 500, timeoutMs: 5000 });
    spawned[0]?.output("starting");
    clock.advance(1000);
    await expect(quiet).resolves.toStrictEqual({ quiet: true, exited: false, exitCode: null });

    spawned[0]?.output("still going");
    const busy = service.agentWait(SESSION, terminal.id, { quietMs: 500, timeoutMs: 600 });
    clock.advance(300);
    spawned[0]?.output("more");
    clock.advance(700);
    await expect(busy).resolves.toStrictEqual({ quiet: false, exited: false, exitCode: null });
  });

  it("stops waiting when the terminal ends", async () => {
    const { service, clock, spawned } = harness();
    const terminal = agentOpen(service);
    const waiting = service.agentWait(SESSION, terminal.id, { quietMs: 5000 });
    spawned[0]?.exit(3);
    clock.advance(200);
    await expect(waiting).resolves.toStrictEqual({ quiet: false, exited: true, exitCode: 3 });
  });

  it("closes only what it opened", async () => {
    const { service, clock, spawned } = harness();
    const terminal = agentOpen(service);
    const closing = service.agentClose(SESSION, terminal.id);
    clock.advance(4000);
    await closing;
    expect(spawned[0]?.calls).toContain("kill:SIGTERM");
    const mine = openIn(service);
    await expect(service.agentClose(SESSION, mine.id)).rejects.toMatchObject({ code: "terminal_not_owner" });
  });
});

describe("edges the limits and closes turn on", () => {
  it("clamps the quiet window to what the protocol allows", async () => {
    const { service, clock, spawned } = harness();
    const terminal = agentOpen(service);
    const waiting = service.agentWait(SESSION, terminal.id, { quietMs: 1, timeoutMs: 5000 });
    spawned[0]?.output("x");
    let answered = false;
    void waiting.then(() => {
      answered = true;
      return answered;
    });
    // 1 ms would be instant; the floor is 100 ms.
    clock.advance(50);
    expect(answered).toBe(false);
    clock.advance(100);
    await expect(waiting).resolves.toMatchObject({ quiet: true });
  });

  it("counts a terminal that ends while a write is settling as settled", async () => {
    const { service, clock, spawned } = harness();
    const terminal = agentOpen(service);
    const typing = service.agentType(SESSION, terminal.id, "x");
    spawned[0]?.exit(0);
    clock.advance(200);
    await expect(typing).resolves.toBe(true);
  });

  it("accepts a write of exactly the size limit", async () => {
    const { service, clock, spawned } = harness();
    const terminal = agentOpen(service);
    const typing = service.agentType(SESSION, terminal.id, "x".repeat(4096));
    clock.advance(2000);
    await typing;
    expect(spawned[0]?.calls.at(-1)?.length).toBe("write:".length + 4096);
    expect(service.openTerminals().length).toBe(1);
  });

  it("closes everything when the host goes away", async () => {
    const { service, clock, spawned } = harness();
    openIn(service);
    agentOpen(service);
    const closing = service.closeAll();
    clock.advance(4000);
    await closing;
    expect(service.openTerminals()).toStrictEqual([]);
    expect(spawned.map((pty) => pty.calls.filter((call) => call === "kill:SIGTERM").length)).toStrictEqual([1, 1]);
  });

  it("falls back from an empty title to the command", () => {
    const { service, sent } = harness();
    service.open({ caller: CALLER, containerId: W1, cols: 80, rows: 24, command: "top", title: "   " });
    const opened = sent.filter(([, event]) => event.type === "terminal_opened").at(-1);
    expect(opened?.[1]).toMatchObject({ terminal: { title: "top" } });
  });
});

describe("what a caller may ask for", () => {
  it("refuses to write into a terminal that has ended", async () => {
    const { service, spawned } = harness();
    const terminal = agentOpen(service);
    spawned[0]?.exit(0);
    await expect(service.agentType(SESSION, terminal.id, "x")).rejects.toMatchObject({
      code: "terminal_not_found",
    });
  });

  it("takes a line count outside the range as its nearest end", async () => {
    const { service, spawned } = harness();
    const terminal = agentOpen(service);
    spawned[0]?.output("only line");
    const few = await service.agentRead(SESSION, terminal.id, 0);
    const many = await service.agentRead(SESSION, terminal.id, 9999);
    expect(few.text).toContain("only line");
    expect(many.text).toContain("only line");
  });

  it("keeps the quiet floor below the timeout, so a short timeout still settles", async () => {
    const { service, clock, spawned } = harness();
    const terminal = agentOpen(service);
    const waiting = service.agentWait(SESSION, terminal.id, { quietMs: 5000, timeoutMs: 100 });
    spawned[0]?.output("x");
    // The timeout is raised to the quiet window: quiet wins once the screen has been still that long.
    clock.advance(5100);
    await expect(waiting).resolves.toMatchObject({ quiet: true });
  });

  it("treats a terminal whose process is gone as having nothing running", async () => {
    const { service, spawned } = harness();
    const terminal = openIn(service);
    spawned[0]?.exit(0);
    await expect(service.hasForegroundProcess(terminal.id)).rejects.toMatchObject({
      code: "terminal_not_found",
    });
  });
});

describe("what a window may list after a reload", () => {
  it("gives back this client's terminals and the agents', not another window's", () => {
    const { service } = harness();
    const mine = openIn(service);
    const other = openIn(service, OTHER_CALLER);
    const byAgent = agentOpen(service);
    const listed = service.list(CALLER).map((terminal) => terminal.id);
    expect(listed).toStrictEqual([mine.id, byAgent.id]);
    expect(listed).not.toContain(other.id);
  });

  it("leaves out a terminal whose process ended", () => {
    const { service, spawned } = harness();
    const mine = openIn(service);
    spawned[0]?.exit(0);
    expect(service.list(CALLER)).toStrictEqual([]);
    expect(mine.id).not.toBe("");
  });
});

describe("hasForegroundProcess", () => {
  it("is true while a program runs, and false for an ended terminal", async () => {
    const { service, spawned } = harness();
    const terminal = openIn(service);
    await expect(service.hasForegroundProcess(terminal.id)).resolves.toBe(true);
    spawned[0]?.exit(0);
    await expect(service.hasForegroundProcess(terminal.id)).rejects.toMatchObject({ code: "terminal_not_found" });
  });

  it("counts a failed query as something running", async () => {
    const { service } = harness({ childrenFails: true });
    const terminal = openIn(service);
    await expect(service.hasForegroundProcess(terminal.id)).resolves.toBe(true);
  });
});

/** The terminal in the last `terminal_opened` event. */
function lastEventFrom(service: { openTerminals(): readonly Terminal[] }): Terminal | undefined {
  return service.openTerminals().at(-1);
}
