import type { PiEvent } from "@atrium/pi";
import { FakeClock, present } from "@atrium/testkit";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import type { EntriesPage } from "../transcript/session-transcript";
import { type SessionPi, createSessionController } from "./session-controller";

const empty: EntriesPage = { entries: [], leafId: null };

/**
 * A pi the test drives, counting its listeners.
 *
 * @remarks
 * Its abort answers at once unless held, so a round can confirm a stop late.
 *
 * @sideEffects none until driven.
 * @returns The pi and how to drive it.
 */
function drivenPi() {
  const listeners = new Set<(event: PiEvent) => void>();
  const exit = Promise.withResolvers<{ code: number | null; signal: string | null; requested: boolean }>();
  let abortGate: PromiseWithResolvers<void> | null = null;
  const pi: SessionPi = {
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exited: exit.promise,
    prompt: async () => ({ disposition: "started" }),
    steer: async () => ({ disposition: "queued" }),
    clearQueue: async () => ({ steering: [] }),
    abort: async () => {
      await abortGate?.promise;
    },
    respond: () => undefined,
    getEntries: async () => empty,
    readPersistedEntries: async () => empty,
    model: async () => null,
    setModel: async () => undefined,
    setThinkingLevel: async () => undefined,
    setFast: async () => undefined,
    compact: async () => undefined,
    exportHtml: async () => undefined,
    commands: async () => [],
    stats: async () => ({
      turns: 1,
      steps: 0,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      context: { tokens: 2, window: 100 },
    }),
    stop: async () => exit.resolve({ code: 0, signal: null, requested: true }),
    command: async () => undefined,
  };
  return {
    pi,
    listeners: () => listeners.size,
    emit: (...events: unknown[]) => {
      for (const event of events) for (const listener of listeners) listener(event as PiEvent);
    },
    /** Holds `abort` until the returned function is called. */
    holdAbort: () => {
      const gate = Promise.withResolvers<void>();
      abortGate = gate;
      return () => {
        abortGate = null;
        gate.resolve();
      };
    },
    crash: () => exit.resolve({ code: null, signal: "SIGKILL", requested: false }),
  };
}

/** Lets queued microtasks run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** An extension's question with a deadline. */
function question(id: string) {
  return { type: "extension_ui_request", id, method: "confirm", title: "Sure?", timeout: 60_000 };
}

describe("session controller resources", () => {
  it("leaves no timer or listener behind after 200 rounds of questions, stops and restarts", async () => {
    const clock = new FakeClock(1000);
    const pis = [drivenPi()];
    let next = 0;
    const controller = createSessionController({
      sessionId: "s1",
      pi: present(pis[0], "the first pi").pi,
      entries: empty,
      publish: () => undefined,
      clock,
      newId: () => `id${++next}`,
      onRefreshFailed: () => undefined,
      log: () => undefined,
      respawn: async () => {
        const started = drivenPi();
        pis.push(started);
        return { pi: started.pi, entries: empty };
      },
    });
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    for (let round = 0; round < 200; round++) {
      const pi = present(pis.at(-1), "the latest pi");
      pi.emit(question("a"), question("c"), question("t"));
      controller.answerInteraction("a", { confirmed: true });
      controller.answerInteraction("c", { cancelled: true });
      clock.advance(60_000);
      // Still open when pi goes; the crash drops it.
      pi.emit(question("s"));

      await controller.prompt({ type: "prompt", requestId: `q${round}`, traceparent, sessionId: "s1", text: "x" });
      pi.emit({ type: "agent_start" });
      const confirm = pi.holdAbort();
      const stopping = controller.stop();
      await settle();
      clock.advance(2000);
      expect(await stopping).toStrictEqual({ confirmed: false });
      confirm();
      await settle();
      pi.emit({ type: "agent_settled" });
      controller.resumeQueue();
      // Last, with no time passing after it: a stop pi confirms at once must cancel its own timer.
      await controller.prompt({ type: "prompt", requestId: `r${round}`, traceparent, sessionId: "s1", text: "y" });
      pi.emit({ type: "agent_start" });
      expect(await controller.stop()).toStrictEqual({ confirmed: true });
      pi.emit({ type: "agent_settled" });
      controller.resumeQueue();

      pi.crash();
      await settle();
      // Every third crash in a row would use the restarts up; a run that ends resets them.
      present(pis.at(-1), "the new pi").emit({ type: "agent_start" }, { type: "agent_settled" });
    }

    expect(controller.snapshot().control).toMatchObject({ interactions: [], stopping: false, restarting: false });
    expect(pis).toHaveLength(201);
    expect(clock.pendingTimers()).toBe(0);
    expect(pis.slice(0, -1).map((pi) => pi.listeners())).toStrictEqual(Array.from({ length: 200 }, () => 0));
    expect(present(pis.at(-1), "the latest pi").listeners()).toBe(1);
    await controller.shutdown();
  });

  it("lets go of the context of each of 200 stops while the same pi lives on", async () => {
    const pi = drivenPi();
    const controller = createSessionController({
      sessionId: "s1",
      pi: pi.pi,
      entries: empty,
      publish: () => undefined,
      clock: new FakeClock(1000),
      newId: () => "id",
      onRefreshFailed: () => undefined,
      log: () => undefined,
      respawn: () => Promise.reject(new Error("pi lives on")),
    });
    // The context a command runs in, as the tracer's span is (found by the sessions soak).
    const storage = new AsyncLocalStorage<object>();
    const contexts: WeakRef<object>[] = [];
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    /** Stops the run in a context of its own; only the returned weak hold outlives the call. */
    const stopIn = async (): Promise<WeakRef<object>> => {
      const context = {};
      expect(await storage.run(context, () => controller.stop())).toStrictEqual({ confirmed: true });
      return new WeakRef(context);
    };

    for (let round = 0; round < 200; round++) {
      await controller.prompt({ type: "prompt", requestId: `q${round}`, traceparent, sessionId: "s1", text: "x" });
      pi.emit({ type: "agent_start" });
      contexts.push(await stopIn());
      pi.emit({ type: "agent_settled" });
      controller.resumeQueue();
    }
    await settle();
    globalThis.gc?.();

    expect(contexts.filter((context) => context.deref() !== undefined)).toHaveLength(0);
    await controller.shutdown();
  });
});
