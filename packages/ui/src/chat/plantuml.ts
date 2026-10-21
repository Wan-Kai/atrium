import type { UiClock } from "../state/clock";

/** Limits for untrusted diagram input and the worker queue (SPEC-0001, "回复渲染"). */
const LIMITS = { input: 32 * 1024, output: 2 * 1024 * 1024, active: 2, waiting: 16, timeout: 10_000 };

/** The one request sent to a dedicated drawing worker. */
export interface PlantumlRequest {
  readonly source: string;
  readonly dark: boolean;
}

/** The narrow worker surface used by the bounded renderer. */
export interface PlantumlWorker extends EventTarget {
  postMessage(request: PlantumlRequest): void;
  terminate(): void;
}

/** A stable failure reason, never the engine's error text or the diagram source. */
export type PlantumlFailure = "failed" | "too_large" | "timeout" | "busy" | "aborted";

/** A diagram failure that is safe to describe without exposing engine output.
 * @remarks The UI maps only the reason, not an arbitrary worker exception.
 * @sideEffects none
 */
export class PlantumlError extends Error {
  /** Creates a safe diagram error.
   * @remarks See {@link PlantumlError}.
   * @sideEffects none
   * @param reason - The stable reason.
   */
  constructor(readonly reason: PlantumlFailure) {
    super(reason);
  }
}

/** A drawing still queued or running. */
interface Job {
  readonly source: string;
  readonly dark: boolean;
  readonly signal: AbortSignal;
  readonly resolve: (svg: string) => void;
  readonly reject: (error: PlantumlError) => void;
  worker: PlantumlWorker | null;
  running: boolean;
  stopTimer: () => void;
  stopListeners: () => void;
  abort: () => void;
}

/** Creates a bounded queue whose workers are terminated after every drawing.
 * @remarks No cached engine can retain conversation content or a failed computation. Cancellation
 * removes queued work too; callbacks and deadlines belong to the job and are always released.
 * @sideEffects none until called; then starts and terminates workers and registers bounded deadlines.
 * @param start - Creates an application-owned module worker.
 * @returns The drawing function.
 */
export function createPlantumlRenderer(start: () => PlantumlWorker) {
  const queue: Job[] = [];
  let active = 0;

  /** Finishes one job and releases everything it owns.
   * @remarks Each terminal path, including cancellation during a post, shares this cleanup.
   * @sideEffects Terminates the worker, removes listeners and deadline, and starts waiting work.
   * @param job - The drawing.
   * @param result - SVG on success or a safe failure.
   */
  function finish(job: Job, result: string | PlantumlError): void {
    job.stopTimer();
    job.signal.removeEventListener("abort", job.abort);
    if (job.worker !== null) {
      job.stopListeners();
      job.worker.terminate();
      job.worker = null;
    }
    if (job.running) active -= 1;
    const place = queue.indexOf(job);
    if (place >= 0) queue.splice(place, 1);
    if (result instanceof PlantumlError) job.reject(result);
    else job.resolve(result);
    pump();
  }

  /** Starts waiting work up to the concurrency limit.
   * @remarks One worker receives exactly one source; late replies cannot settle another job.
   * @sideEffects Starts workers and sends source text to them.
   */
  function pump(): void {
    while (active < LIMITS.active) {
      const job = queue.shift();
      if (job === undefined) return;
      job.running = true;
      active += 1;
      try {
        const worker = start();
        job.worker = worker;
        /** Handles this worker's one response.
         * @remarks A worker never settles another job; non-message data is invalid.
         * @sideEffects Settles the job and cleans up its worker.
         * @param event - The response.
         */
        const receive = (event: Event): void => {
          const reply: unknown = event instanceof MessageEvent ? event.data : null;
          if (typeof reply === "object" && reply !== null && "reason" in reply && reply.reason === "too_large") {
            finish(job, new PlantumlError("too_large"));
          } else if (
            typeof reply !== "object" ||
            reply === null ||
            !("svg" in reply) ||
            typeof reply.svg !== "string"
          ) {
            finish(job, new PlantumlError("failed"));
          } else if (new TextEncoder().encode(reply.svg).length > LIMITS.output) {
            finish(job, new PlantumlError("too_large"));
          } else {
            finish(job, reply.svg);
          }
        };
        /** Handles a failed module or computation without logging engine diagnostics.
         * @remarks Raw errors may contain source, so only a stable reason leaves the boundary.
         * @sideEffects Suppresses default error reporting and settles the job.
         * @param event - The worker failure.
         */
        const failed = (event: Event): void => {
          event.preventDefault();
          finish(job, new PlantumlError("failed"));
        };
        worker.addEventListener("message", receive);
        worker.addEventListener("error", failed);
        job.stopListeners = () => {
          worker.removeEventListener("message", receive);
          worker.removeEventListener("error", failed);
        };
        worker.postMessage({ source: job.source, dark: job.dark });
      } catch {
        finish(job, new PlantumlError("failed"));
      }
    }
  }

  /** Renders one complete block, or rejects with a stable reason.
   * @remarks The deadline includes queue time so a busy page cannot hold text indefinitely.
   * @sideEffects Queues work, registers cancellation and a deadline, and may start a worker.
   * @param source - A complete PlantUML block.
   * @param dark - Whether to draw dark colours.
   * @param signal - Cancels on unmount, source change or theme change.
   * @param clock - The UI's injected deadline source.
   * @returns The generated SVG as untrusted image data.
   */
  return (source: string, dark: boolean, signal: AbortSignal, clock: UiClock): Promise<string> => {
    if (signal.aborted) return Promise.reject(new PlantumlError("aborted"));
    if (new TextEncoder().encode(source).length > LIMITS.input) return Promise.reject(new PlantumlError("too_large"));
    if (queue.length >= LIMITS.waiting) return Promise.reject(new PlantumlError("busy"));
    return new Promise((resolve, reject) => {
      const job: Job = {
        source,
        dark,
        signal,
        resolve,
        reject,
        worker: null,
        running: false,
        stopTimer: () => undefined,
        stopListeners: () => undefined,
        abort: () => finish(job, new PlantumlError("aborted")),
      };
      queue.push(job);
      job.stopTimer = clock.after(LIMITS.timeout, () => finish(job, new PlantumlError("timeout")));
      // No await occurs between the initial abort check and registration; finish removes this
      // listener before any next event, so neither another abort check nor once is needed.
      signal.addEventListener("abort", job.abort);
      pump();
    });
  };
}

/** Draws diagrams with application-owned, same-origin module workers.
 * @remarks Heavy JavaScript is only fetched once an actual diagram needs drawing. No Java or server.
 * @sideEffects Starts and terminates dedicated workers through the bounded renderer.
 */
export const renderPlantuml = createPlantumlRenderer(
  () => new Worker(new URL("./plantuml.worker.ts", import.meta.url), { type: "module" }),
);
