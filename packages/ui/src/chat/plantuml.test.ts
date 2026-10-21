import { FakeClock } from "@atrium/testkit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createPlantumlRenderer,
  PlantumlError,
  type PlantumlRequest,
  type PlantumlWorker,
  renderPlantuml,
} from "./plantuml";
import type { UiClock } from "../state/clock";

/** A worker transport for deterministic lifecycle tests; drawing itself is tested in Chromium.
 * @remarks This tests cancellation and deadlines without mocking the engine module.
 * @sideEffects Records messages and termination.
 */
class DrawingWorker extends EventTarget implements PlantumlWorker {
  listeners = 0;
  readonly listenerTypes = new Set<string>();
  /** Counts the job's live listeners.
   * @remarks Cleanup must remove actual listeners, not only update a private flag.
   * @sideEffects Registers an event listener and increments the count.
   * @param type - Event type.
   * @param callback - Listener.
   */
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null): void {
    super.addEventListener(type, callback);
    this.listenerTypes.add(type);
    this.listeners = this.listenerTypes.size;
  }
  /** Counts listener removal.
   * @remarks See addEventListener.
   * @sideEffects Removes the listener and decrements the count.
   * @param type - Event type.
   * @param callback - Listener.
   */
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null): void {
    super.removeEventListener(type, callback);
    this.listenerTypes.delete(type);
    this.listeners = this.listenerTypes.size;
  }
  readonly requests: PlantumlRequest[] = [];
  terminated = 0;
  /** Records a source.
   * @remarks The test sends the reply explicitly.
   * @sideEffects Appends the request.
   * @param request - The source and appearance.
   */
  postMessage(request: PlantumlRequest): void {
    this.requests.push(request);
  }
  /** Records cleanup.
   * @remarks Repeated termination would reveal duplicate settlement.
   * @sideEffects Increments the count.
   */
  terminate(): void {
    this.terminated += 1;
  }
  /** Delivers a controlled result.
   * @remarks Uses the actual MessageEvent shape.
   * @sideEffects Calls the installed reply handler.
   * @param reply - Data to deliver.
   */
  answer(reply: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: reply }));
  }
}

/** Creates the deterministic queue fixture.
 * @remarks Every test checks its own terminal paths without real-time sleeps.
 * @sideEffects Holds workers and a fake clock.
 * @returns The renderer, workers and controllable deadline source.
 */
function fixture() {
  const time = new FakeClock();
  const clock: UiClock = {
    now: () => time.now(),
    after: (ms, run) => time.setTimeout(run, ms),
    every: () => {
      throw new Error("unused");
    },
  };
  const workers: DrawingWorker[] = [];
  const draw = createPlantumlRenderer(() => {
    const worker = new DrawingWorker();
    workers.push(worker);
    return worker;
  });
  return { time, clock, workers, draw };
}

/** Attaches a rejection handler before a test triggers synchronous cancellation.
 * @remarks A rejected promise must never become an unhandled rejection in the test process.
 * @sideEffects Handles the promise.
 * @param promise - The drawing.
 * @returns The SVG or safe failure reason.
 */
function outcome(promise: Promise<string>): Promise<string> {
  return promise.catch((error: unknown) => (error instanceof PlantumlError ? error.reason : "unexpected"));
}

describe("bounded PlantUML jobs", () => {
  it("passes original source and appearance, terminates once, and removes the deadline and handlers", async () => {
    const { time, clock, workers, draw } = fixture();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    onTestFinished(() => {
      add.mockRestore();
      remove.mockRestore();
    });
    const result = draw("source", true, controller.signal, clock);
    const worker = workers[0]!;
    expect(worker.requests).toStrictEqual([{ source: "source", dark: true }]);
    worker.answer({ svg: "<svg/>" });
    expect(await result).toBe("<svg/>");
    controller.abort();
    expect([worker.terminated, worker.listeners, time.pendingTimers()]).toStrictEqual([1, 0, 0]);
    expect(remove.mock.calls).toStrictEqual([["abort", add.mock.calls[0]?.[1]]]);
  });

  it("runs at most two workers and cancels queued work without starting it", async () => {
    const { time, clock, workers, draw } = fixture();
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const results = controllers.map((controller, index) =>
      outcome(draw(String(index), false, controller.signal, clock)),
    );
    expect(workers).toHaveLength(2);
    controllers[2]!.abort();
    workers[0]!.answer({ svg: "first" });
    expect(workers).toHaveLength(3);
    expect(workers[2]!.requests).toStrictEqual([{ source: "3", dark: false }]);
    workers[1]!.answer({ svg: "second" });
    workers[2]!.answer({ svg: "fourth" });
    expect(await Promise.all(results)).toStrictEqual(["first", "second", "aborted", "fourth"]);
    expect(time.pendingTimers()).toBe(0);
  });

  it("aborts a running worker, removes its listeners, and advances waiting work", async () => {
    const { time, clock, workers, draw } = fixture();
    const controller = new AbortController();
    const first = outcome(draw("first", false, controller.signal, clock));
    const second = draw("second", false, new AbortController().signal, clock);
    const third = draw("third", false, new AbortController().signal, clock);
    controller.abort();
    expect(await first).toBe("aborted");
    expect([workers[0]!.terminated, workers[0]!.listeners, workers.length]).toStrictEqual([1, 0, 3]);
    workers[0]!.answer({ svg: "late" });
    workers[1]!.answer({ svg: "second" });
    workers[2]!.answer({ svg: "third" });
    expect(await Promise.all([second, third])).toStrictEqual(["second", "third"]);
    expect(time.pendingTimers()).toBe(0);
  });

  it("turns worker errors into stable failures and removes their listeners", async () => {
    const { time, clock, workers, draw } = fixture();
    const result = outcome(draw("source", false, new AbortController().signal, clock));
    const error = new Event("error", { cancelable: true });
    workers[0]!.dispatchEvent(error);
    expect(await result).toBe("failed");
    expect([error.defaultPrevented, workers[0]!.listeners, time.pendingTimers()]).toStrictEqual([true, 0, 0]);
  });

  it("enforces the queue bound and frees all work when callers cancel", async () => {
    const { time, clock, workers, draw } = fixture();
    const controllers = Array.from({ length: 19 }, () => new AbortController());
    const results = controllers.map((controller) => outcome(draw("source", false, controller.signal, clock)));
    expect(workers).toHaveLength(2);
    expect(await results[18]).toBe("busy");
    // Cancel waiting jobs before active jobs so none of the cancelled work starts in between.
    for (const controller of controllers.toReversed()) controller.abort();
    expect(await Promise.all(results)).toStrictEqual([...Array<string>(18).fill("aborted"), "busy"]);
    expect(workers.map((worker) => worker.terminated)).toStrictEqual([1, 1]);
    expect(time.pendingTimers()).toBe(0);
  });

  it("accepts the byte limit exactly, rejects UTF-8 overflow, and does not start pre-aborted work", async () => {
    const { time, clock, workers, draw } = fixture();
    const controller = new AbortController();
    const exact = draw("x".repeat(32768), false, controller.signal, clock);
    workers[0]!.answer({ svg: "ok" });
    expect(await exact).toBe("ok");
    const overflow = outcome(draw("图".repeat(10923), false, controller.signal, clock));
    expect(workers).toHaveLength(1);
    controller.abort();
    expect(await overflow).toBe("too_large");
    expect(await outcome(draw("source", false, controller.signal, clock))).toBe("aborted");
    expect(workers).toHaveLength(1);
    expect(time.pendingTimers()).toBe(0);
  });

  it("terminates hung workers at ten seconds and lets the next job recover", async () => {
    const { time, clock, workers, draw } = fixture();
    const first = outcome(draw("infinite macro", false, new AbortController().signal, clock));
    time.advance(9999);
    expect(workers[0]!.terminated).toBe(0);
    time.advance(1);
    expect(await first).toBe("timeout");
    expect(workers[0]!.terminated).toBe(1);
    const next = draw("valid", false, new AbortController().signal, clock);
    workers[1]!.answer({ svg: "recovered" });
    expect(await next).toBe("recovered");
    expect(time.pendingTimers()).toBe(0);
  });

  it.each<[unknown, string]>([
    [null, "failed"],
    [123, "failed"],
    ["bad", "failed"],
    [{ reason: "unexpected" }, "failed"],
    [{ svg: 1 }, "failed"],
    [{ failed: true }, "failed"],
    [{ svg: "图".repeat(699051) }, "too_large"],
  ])("rejects invalid or excessive output without retaining a worker", async (reply, expected) => {
    const { time, clock, workers, draw } = fixture();
    const result = outcome(draw("source", false, new AbortController().signal, clock));
    workers[0]!.answer(reply);
    expect(await result).toBe(expected);
    expect([workers[0]!.terminated, time.pendingTimers()]).toStrictEqual([1, 0]);
  });

  it("accepts exactly two MiB of output and forwards a worker-reported size failure", async () => {
    const { time, clock, workers, draw } = fixture();
    const svg = "x".repeat(2 * 1024 * 1024);
    const exact = draw("source", false, new AbortController().signal, clock);
    workers[0]!.answer({ svg });
    expect(await exact).toBe(svg);
    const excessive = outcome(draw("source", false, new AbortController().signal, clock));
    workers[1]!.answer({ reason: "too_large" });
    expect(await excessive).toBe("too_large");
    expect(time.pendingTimers()).toBe(0);
  });

  it("wires the browser entry to the exact module worker URL and options", async () => {
    const { clock } = fixture();
    const started: Array<{ worker: DrawingWorker; url: URL; options: WorkerOptions }> = [];
    /** A system-worker boundary recorder; engine rendering still has real Chromium coverage.
     * @remarks Node has no browser Worker, so this verifies only the application's worker wiring.
     * @sideEffects Records the worker construction.
     */
    class BrowserWorker extends DrawingWorker {
      /** Records browser construction arguments.
       * @remarks See BrowserWorker.
       * @sideEffects Appends a created worker.
       * @param url - Module URL.
       * @param options - Worker type.
       */
      constructor(url: URL, options: WorkerOptions) {
        super();
        started.push({ worker: this, url, options });
      }
    }
    vi.stubGlobal("Worker", BrowserWorker);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const result = renderPlantuml("source", false, new AbortController().signal, clock);
    expect(started).toHaveLength(1);
    const one = started[0]!;
    expect(one.url.pathname.endsWith("/plantuml.worker.ts")).toBe(true);
    expect(one.options).toStrictEqual({ type: "module" });
    one.worker.answer({ svg: "<svg/>" });
    expect(await result).toBe("<svg/>");
  });

  it("cleans up a worker startup failure", async () => {
    const { time, clock } = fixture();
    const draw = createPlantumlRenderer(() => {
      throw new Error("private path");
    });
    expect(await outcome(draw("source", false, new AbortController().signal, clock))).toBe("failed");
    expect(time.pendingTimers()).toBe(0);
  });
});
