import { FakeClock } from "@atrium/testkit";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../platform/logger";
import { ResourceTracker } from "../platform/resources";
import type { PtyProcess } from "./pty";
import { createTerminalService } from "./service";

const SESSION = "sess-1";

/** Does nothing, whichever level it is called at. */
const sayNothing = (): void => undefined;

/** A logger that says nothing. */
function quietLogger(): Logger {
  return {
    trace: sayNothing,
    debug: sayNothing,
    info: sayNothing,
    warn: sayNothing,
    error: sayNothing,
    fatal: sayNothing,
    child: () => quietLogger(),
  } as unknown as Logger;
}

/** A PTY that records nothing and never prints, unless the test tells it to. */
function stillPty() {
  let onData: ((data: string) => void) | null = null;
  let onExit: ((event: { exitCode: number }) => void) | null = null;
  const process: PtyProcess = {
    pid: 4242,
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    onData: (listener) => {
      onData = listener;
    },
    onExit: (listener) => {
      onExit = listener;
    },
  };
  return { process, output: (data: string) => onData?.(data), exit: () => onExit?.({ exitCode: 0 }) };
}

/**
 * What opening and closing terminals many times leaves behind.
 *
 * @remarks
 * The host keeps one PTY and, while waiting or closing, one or two timers per terminal. None of
 * them may outlive the tab (testing.md, "性能与资源泄漏").
 */
describe("terminals leave nothing behind", () => {
  it("returns the timers and the terminals to zero after 50 open-and-close rounds", async () => {
    const clock = new FakeClock();
    const resources = new ResourceTracker();
    const ptys: Array<ReturnType<typeof stillPty>> = [];
    const service = createTerminalService({
      shell: "/bin/zsh",
      dirOf: () => "/work/a",
      home: "/Users/me",
      env: {},
      spawn: () => {
        const pty = stillPty();
        ptys.push(pty);
        return pty.process;
      },
      send: () => undefined,
      broadcast: () => undefined,
      clock,
      resources,
      logger: quietLogger(),
      childrenOf: async () => [],
    });

    for (let i = 0; i < 50; i += 1) {
      const terminal = service.open({
        caller: { connectionId: "conn-1", clientId: SESSION },
        containerId: "cht_a",
        cols: 80,
        rows: 24,
        origin: "agent",
        sessionId: SESSION,
        command: "true",
      });
      // A wait and a type both hold a timer while they run; advancing lets them finish.
      void service.agentType(SESSION, terminal.id, "x");
      clock.advance(2000);
      const closing = service.close({ connectionId: "conn-1", clientId: SESSION }, terminal.id, true);
      ptys[i]?.exit();
      await closing;
      clock.advance(5000);
    }

    await vi.waitFor(() => expect(resources.snapshot()["timer"]).toBe(0));
    expect(service.openTerminals()).toStrictEqual([]);
  });
});
