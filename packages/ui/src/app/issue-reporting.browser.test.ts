import { describe, expect, it, vi } from "vitest";
import { installIssueReporting } from "./issue-reporting";

/** A client that records reports, and a clock the test moves. */
function setUp() {
  const reports: unknown[][] = [];
  let time = 0;
  const stop = installIssueReporting(
    {
      reportIssue: async (...args) => {
        reports.push(args);
      },
    },
    window,
    () => time,
  );
  return { reports, stop, advance: (ms: number) => (time += ms) };
}

describe("installIssueReporting", () => {
  it("reports uncaught errors and unhandled rejections, at most one per kind every 10 seconds", async () => {
    const { reports, stop, advance } = setUp();
    const error = new Error("boom");

    window.dispatchEvent(new ErrorEvent("error", { message: "Uncaught Error: boom", error }));
    window.dispatchEvent(new ErrorEvent("error", { message: "again" }));
    advance(10_000);
    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: "nope" }),
    );
    advance(10_000);
    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: error }),
    );
    stop();
    advance(10_000);
    window.dispatchEvent(new ErrorEvent("error", { message: "after stop" }));

    expect(reports).toStrictEqual([
      ["error", "Uncaught Error: boom", error.stack],
      ["error", "unhandled rejection: nope", undefined],
      ["error", "unhandled rejection: boom", error.stack],
    ]);
  });

  it("reports a long task", async () => {
    const { reports, stop } = setUp();

    const until = performance.now() + 80;
    while (performance.now() < until) {
      // A task longer than 50 ms.
    }

    await vi.waitFor(() =>
      expect(reports).toContainEqual(["long_task", expect.stringMatching(/^long task \d+ ms$/), undefined]),
    );
    stop();
  });
});
