/**
 * Everything the pi package needs from the host; `main.ts` in the host provides it.
 *
 * @remarks
 * The clock, resource counts, logger and request ids live in the host's `platform/`, which this
 * package must not import (overview.md, "pi 包拿到宿主基础设施的方式：注入，不 import"). The host's
 * implementations match this shape structurally; tests pass testkit fakes.
 */
export interface PiDeps {
  readonly clock: {
    now(): number;
    /** Schedules `callback`; returns a function that cancels it. */
    setTimeout(callback: () => void, ms: number): () => void;
  };
  /** Counts one open resource (process, listener); returns a release function that works once. */
  track(kind: string): () => void;
  /** Structured logger; the host's implementation adds the current trace id. */
  readonly log: Record<"debug" | "info" | "warn" | "error", (fields: object, message: string) => void>;
  /** Id for the next RPC command; the host derives it from the current span id, and pi echoes it back. */
  nextRequestId(): string;
  /** Environment for pi, with PATH taken from the login shell. */
  readonly env: Readonly<Record<string, string>>;
}
