import { isDeepStrictEqual } from "node:util";
import type { FixtureRecord, Json, JsonObject } from "./format";

/** How the replayed pi ended; the same shape as the pi package's `PiExit`. */
export interface ReplayExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly requested: boolean;
  readonly stderrTail: string;
}

/**
 * A command that pi rejected in the fixture; the same fields as the pi package's `PiRequestError`.
 *
 * @remarks
 * testkit must not import the pi package, so the error is mirrored by shape.
 *
 * @sideEffects none
 */
export class ReplayRequestError extends Error {
  override readonly name = "PiRequestError";

  /**
   * Creates the error.
   *
   * @remarks
   * Mirrors the real error's fields and message so code under test can read `reason` and
   * `detail`; like the real one, the message leaves `detail` out.
   *
   * @sideEffects none
   * @param command - The command type.
   * @param reason - Why it failed.
   * @param detail - pi's error text, or the (empty) stderr tail when it exited.
   */
  constructor(
    readonly command: string,
    readonly reason: "rejected" | "exited" | "stopped",
    readonly detail?: string,
  ) {
    super(`pi ${command} ${reason}`);
  }
}

/**
 * The caller sent something the fixture did not record next.
 *
 * @remarks
 * A distinct name lets a failing test say "the code under test changed what it sends" rather than
 * "pi misbehaved".
 *
 * @sideEffects none
 */
export class FixtureMismatch extends Error {
  override readonly name = "FixtureMismatch";
}

/** The records replay walks through: everything but the header and the session file. */
type Played = Extract<FixtureRecord, { kind: "send" | "stdout" | "exit" }>;
const PLAYED: ReadonlySet<string> = new Set(["send", "stdout", "exit"]);

/** A pi stand-in that plays back a fixture; shaped like the pi package's `PiProcess`. */
export interface ReplayedPi {
  readonly pid: undefined;
  readonly exited: Promise<ReplayExit>;
  request(command: { readonly type: string }): Promise<unknown>;
  respond(response: object): void;
  onEvent(listener: (event: JsonObject) => void): () => void;
  stop(): Promise<ReplayExit>;
  /** Records not yet played back; 0 once the caller did everything the scenario did. */
  remaining(): number;
}

/**
 * Copies a record without its `id`.
 *
 * @remarks
 * Request ids are assigned by whoever sends, so they never have to match the fixture.
 *
 * @sideEffects none
 * @param record - A sent record.
 * @returns The record without `id`.
 */
function withoutId(record: object): object {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "id"));
}

/**
 * Tells whether what the caller sends is what the fixture recorded.
 *
 * @remarks
 * Request ids are assigned by whoever sends, so they are ignored for commands; dialog answers
 * carry pi's own id, which must match.
 *
 * @sideEffects none
 * @param recorded - The recorded `send`.
 * @param sent - What the caller sends.
 * @param ignoreId - Whether to ignore `id`.
 * @returns Whether they match.
 */
function sameSend(recorded: object, sent: object, ignoreId: boolean): boolean {
  return ignoreId ? isDeepStrictEqual(withoutId(recorded), withoutId(sent)) : isDeepStrictEqual(recorded, sent);
}

/**
 * Plays back a recorded scenario as if pi were running.
 *
 * @remarks
 * Layer 1 tests drive code that talks to pi without starting pi (testing.md, "pi 夹具"). Every
 * command must match the next recorded `send` apart from its id, so a test cannot quietly drift
 * from what real pi was asked; a mismatch fails with both sides in the message. After each
 * matching command, the recorded output up to the next `send` is delivered in order on a
 * microtask: responses settle the matching request, everything else goes to the listeners. Like
 * the real process, `stop()` fails waiting requests with `stopped` and ends the way the fixture
 * ended, even if the caller stops before doing everything the scenario did; after that, or after a
 * crash, requests fail without touching the fixture. It matches structurally, without importing
 * the pi package (overview.md, "包之间的依赖").
 *
 * @sideEffects none; delivery happens on microtasks.
 * @param fixture - The fixture records, header first.
 * @returns The stand-in.
 */
export function replayPi(fixture: readonly FixtureRecord[]): ReplayedPi {
  const body = fixture.filter((record): record is Played => PLAYED.has(record.kind));
  let cursor = 0;
  const listeners = new Set<(event: JsonObject) => void>();
  const pending = new Map<Json, { command: string; resolve(data: unknown): void; reject(error: Error): void }>();
  const exited = Promise.withResolvers<ReplayExit>();
  let stopRequested = false;
  let ended = false;

  /**
   * Ends the replay with the given exit.
   *
   * @remarks
   * Like the real process, requests still waiting fail with `exited` and the stderr tail, which
   * fixtures do not record; `stop()` has already failed its own with `stopped`.
   *
   * @sideEffects Rejects waiting requests; resolves `exited`.
   * @param code - The recorded exit code.
   * @param signal - The recorded signal.
   */
  function end(code: number | null, signal: string | null): void {
    ended = true;
    for (const waiting of pending.values()) waiting.reject(new ReplayRequestError(waiting.command, "exited", ""));
    // Stryker disable next-line CallExpression: nothing can arrive after the exit; clearing only frees memory.
    pending.clear();
    exited.resolve({ code, signal, requested: stopRequested, stderrTail: "" });
  }

  /**
   * Delivers the recorded output that follows the last matched `send`.
   *
   * @remarks
   * Stops at the next `send`, which waits for the caller; at an `exit` the host asked for, which
   * waits for `stop()`; or at a crash `exit`, which ends the replay. A response whose request is
   * no longer waiting is dropped, as the real process does.
   *
   * @sideEffects Settles requests; calls listeners; may resolve `exited`.
   */
  function deliver(): void {
    for (let next = body[cursor]; !ended && next !== undefined && next.kind !== "send"; next = body[cursor]) {
      // A stop the host asked for happens only once the caller asks too.
      // Stryker disable next-line ConditionalExpression: other records have no `requested`, so the kind check is redundant.
      if (next.kind === "exit" && next.requested && !stopRequested) return;
      cursor += 1;
      if (next.kind === "exit") {
        end(next.code, next.signal);
        return;
      }
      const record = next.record;
      if (record["type"] !== "response") {
        for (const listener of listeners) listener(record);
        continue;
      }
      const id = record["id"] ?? null;
      const waiting = pending.get(id);
      if (waiting === undefined) continue;
      // Stryker disable next-line CallExpression: a settled promise ignores a second settlement; deleting only frees memory.
      pending.delete(id);
      const error = record["error"];
      if (record["success"] === true) waiting.resolve(record["data"]);
      else
        waiting.reject(
          new ReplayRequestError(
            waiting.command,
            "rejected",
            typeof error === "string" ? error : JSON.stringify(error),
          ),
        );
    }
  }

  /**
   * The exit the fixture recorded, wherever it is from the cursor on.
   *
   * @remarks
   * A caller may stop before doing everything the scenario did; pi then still ends the way it
   * ended when the scenario stopped it.
   *
   * @sideEffects none
   * @returns The exit record, if the fixture has one.
   */
  function recordedExit(): Extract<Played, { kind: "exit" }> | undefined {
    return body.slice(cursor).find((record): record is Extract<Played, { kind: "exit" }> => record.kind === "exit");
  }

  /**
   * Checks that `sent` is what the fixture recorded next, ignoring request ids.
   *
   * @remarks
   * The fixture's id is used from here on, so recorded responses still find their request.
   *
   * @sideEffects Delivers output recorded before this send; advances the cursor.
   * @param sent - What the caller sends.
   * @param ignoreId - Whether `id` is a request id the replay assigns.
   * @returns The recorded record.
   * @throws {FixtureMismatch} When the next record is not a matching `send`.
   */
  function expectSend(sent: object, ignoreId: boolean): JsonObject {
    // Output pi printed before this send is due first, even if its microtask has not run yet.
    deliver();
    const next = body[cursor];
    if (next?.kind !== "send" || !sameSend(next.record, sent, ignoreId)) {
      throw new FixtureMismatch(
        `fixture expected ${JSON.stringify(next ?? "the end")}, but the caller sent ${JSON.stringify(sent)}`,
      );
    }
    cursor += 1;
    return next.record;
  }

  queueMicrotask(deliver);
  return {
    pid: undefined,
    exited: exited.promise,
    request(command) {
      if (ended || stopRequested) {
        return Promise.reject(
          stopRequested
            ? new ReplayRequestError(command.type, "stopped")
            : new ReplayRequestError(command.type, "exited", ""),
        );
      }
      try {
        const recorded = expectSend(command, true);
        const response = Promise.withResolvers<unknown>();
        pending.set(recorded["id"] ?? null, { command: command.type, ...response });
        queueMicrotask(deliver);
        return response.promise;
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    respond(response) {
      // Dropped like the real process drops it: pi can no longer be told anything.
      if (ended || stopRequested) return;
      expectSend(response, false);
      queueMicrotask(deliver);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      if (!ended && !stopRequested) {
        stopRequested = true;
        for (const waiting of pending.values()) waiting.reject(new ReplayRequestError(waiting.command, "stopped"));
        // Stryker disable next-line CallExpression: a rejected promise ignores later settlements; clearing only drops recorded responses early.
        pending.clear();
        deliver();
        if (!ended) {
          const exit = recordedExit();
          // A recorded `code: null` (killed by a signal) must stay null, so no `??` on the code.
          if (exit === undefined) end(0, null);
          else end(exit.code, exit.signal);
        }
      }
      return exited.promise;
    },
    remaining: () => body.length - cursor,
  };
}
