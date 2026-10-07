import type { AtriumClient } from "@atrium/client";

/** The same kind of problem is reported at most this often. */
const MIN_INTERVAL_MS = 10_000;

/** Kinds of problems the UI reports. */
type IssueKind = Parameters<AtriumClient["reportIssue"]>[0];

/**
 * Sends the UI's own problems to the host's log.
 *
 * @remarks
 * Uncaught errors, unhandled promise rejections and long tasks (over 50 ms) would otherwise be
 * lost in the renderer; the host logs them with the client's id and trace (SPEC-0001,
 * "界面问题上报"). Each kind is reported at most once every 10 seconds, so a burst cannot trip the
 * connection's rate limit. Reports failing while disconnected are dropped. Messages are error
 * texts and timings, never conversation content.
 *
 * @sideEffects Listens for errors and rejections on `target` and observes long tasks until the
 * returned function is called; sends `report_client_issue`.
 * @param client - Where reports go.
 * @param target - The window to watch.
 * @param now - Clock in milliseconds; tests pass their own.
 * @returns A function that stops reporting.
 */
export function installIssueReporting(
  client: Pick<AtriumClient, "reportIssue">,
  target: Window,
  now: () => number = () => performance.now(),
): () => void {
  const lastReported = new Map<IssueKind, number>();

  /**
   * Reports one problem unless the same kind was reported recently.
   *
   * @remarks
   * See `installIssueReporting`.
   *
   * @sideEffects May send a report.
   * @param kind - The kind of problem.
   * @param message - What happened.
   * @param details - A stack trace or similar, if any.
   */
  function report(kind: IssueKind, message: string, details?: string): void {
    const time = now();
    const last = lastReported.get(kind);
    if (last !== undefined && time - last < MIN_INTERVAL_MS) return;
    lastReported.set(kind, time);
    // Fire and forget: a report that cannot be sent is simply dropped.
    void client.reportIssue(kind, message, details).catch(() => undefined);
  }

  const listening = new AbortController();
  target.addEventListener(
    "error",
    (event: ErrorEvent) => {
      const error: unknown = event.error;
      report("error", event.message, error instanceof Error ? error.stack : undefined);
    },
    { signal: listening.signal },
  );
  target.addEventListener(
    "unhandledrejection",
    (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason;
      if (reason instanceof Error) report("error", `unhandled rejection: ${reason.message}`, reason.stack);
      else report("error", `unhandled rejection: ${String(reason)}`);
    },
    { signal: listening.signal },
  );
  const longTasks = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) report("long_task", `long task ${Math.round(entry.duration)} ms`);
  });
  longTasks.observe({ type: "longtask" });
  return () => {
    listening.abort();
    longTasks.disconnect();
  };
}
