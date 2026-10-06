import { tmpdir } from "node:os";
import { type FauxScript, createTempDir, fauxPi, present } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiDeps } from "../deps";
import { findPi } from "../locate/locate";
import { type PiEvent, type PiProcess, startPiProcess } from "./pi-process";

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const quietDeps = (env: Record<string, string>): PiDeps => {
  let next = 0;
  return {
    clock: {
      now: () => Date.now(),
      setTimeout(callback, ms) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    track: () => () => undefined,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    nextRequestId: () => `req-${++next}`,
    env,
  };
};

/** Starts real `pi --mode rpc` on the faux model in a temporary HOME. */
async function startRealPi(script: FauxScript): Promise<{ pi: PiProcess; events: PiEvent[] }> {
  const dir = await createTempDir("real-pi");
  const launch = await fauxPi(script, dir.path);
  const path = present(process.env["PATH"], "PATH");
  const piPath = present(await findPi(path), "pi on PATH");
  const pi = startPiProcess(
    { piPath, args: ["--no-session", ...launch.args], cwd: dir.path, env: launch.env },
    quietDeps({ PATH: path, HOME: dir.path, TMPDIR: tmpdir() }),
  );
  const events: PiEvent[] = [];
  pi.onEvent((event) => events.push(event));
  cleanups.push(dir.cleanup, () => pi.stop());
  return { pi, events };
}

/** Pids of running processes whose command line contains `marker`. */
function processesMatching(marker: string): string[] {
  return execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(marker));
}

/** The text deltas of all assistant messages, joined. */
function streamedText(events: readonly PiEvent[]): string {
  return events
    .flatMap((event) =>
      event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"
        ? [event.assistantMessageEvent.delta]
        : [],
    )
    .join("");
}

describe("PiProcess with real pi", () => {
  it("runs a whole turn: prompt accepted, text streamed, settled", async () => {
    const { pi, events } = await startRealPi({ replies: [{ blocks: [{ type: "text", text: "Hello from faux." }] }] });

    expect(await pi.request({ type: "prompt", message: "hi" })).toStrictEqual({ disposition: "started" });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("agent_settled"), { timeout: 20_000 });

    expect(streamedText(events)).toBe("Hello from faux.");
    // pi 1.0 counts its system message too: system, user, assistant.
    expect(await pi.request({ type: "get_state" })).toMatchObject({ isStreaming: false, messageCount: 3 });
    expect(await pi.stop()).toStrictEqual({ code: 0, signal: null, requested: true, stderrTail: "" });
  });

  it("stops while a bash tool runs and leaves no child process behind", async () => {
    const marker = `sleep ${40_000 + Math.floor(Math.random() * 10_000)}`;
    const { pi, events } = await startRealPi({
      replies: [
        { blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: marker } }] },
        { blocks: [{ type: "text", text: "never reached" }] },
      ],
    });

    await pi.request({ type: "prompt", message: "run it" });
    await vi.waitFor(() => expect(events.map((event) => event.type)).toContain("tool_execution_start"), {
      timeout: 20_000,
    });
    await vi.waitFor(() => expect(processesMatching(marker)).toHaveLength(1), { timeout: 10_000 });

    expect(await pi.stop()).toMatchObject({ code: 0, requested: true });
    await vi.waitFor(() => expect(processesMatching(marker)).toStrictEqual([]), { timeout: 10_000 });
  });
});
