import { describe, expect, it } from "vitest";
import type { FixtureRecord, JsonObject } from "./format";
import { FixtureMismatch, ReplayRequestError, replayPi } from "./replay";

const header: FixtureRecord = { kind: "fixture", scenario: "s", pi: "1", script: { replies: [] }, args: [] };

/** A fixture from the given records, with the header in front. */
function fixture(...records: FixtureRecord[]): FixtureRecord[] {
  return [header, ...records];
}

describe("replayPi", () => {
  it("delivers recorded output in order, settling each request with its recorded response", async () => {
    const pi = replayPi(
      fixture(
        { kind: "stdout", record: { type: "extension_ui_request", method: "notify", id: "<uuid-1>" } },
        { kind: "send", record: { type: "prompt", message: "hi", id: "r1" } },
        {
          kind: "stdout",
          record: { type: "response", command: "prompt", id: "r1", success: true, data: { disposition: "started" } },
        },
        { kind: "stdout", record: { type: "agent_start" } },
        { kind: "stdout", record: { type: "agent_settled" } },
        { kind: "exit", code: 0, signal: null, requested: true },
        { kind: "session", lines: [] },
      ),
    );
    const events: JsonObject[] = [];
    pi.onEvent((event) => events.push(event));

    const response = await pi.request({ type: "prompt", message: "hi", id: "caller-7" } as { type: string });
    const exit = await pi.stop();

    expect(response).toStrictEqual({ disposition: "started" });
    expect(events.map((event) => event["type"])).toStrictEqual([
      "extension_ui_request",
      "agent_start",
      "agent_settled",
    ]);
    expect(exit).toStrictEqual({ code: 0, signal: null, requested: true, stderrTail: "" });
    expect(pi.remaining()).toBe(0);
    expect(pi.pid).toBeUndefined();
  });

  it("rejects with pi's recorded error when the command failed", async () => {
    const pi = replayPi(
      fixture(
        { kind: "send", record: { type: "set_model", provider: "x", modelId: "y", id: "r1" } },
        {
          kind: "stdout",
          record: { type: "response", command: "set_model", id: "r1", success: false, error: "Model not found: x/y" },
        },
      ),
    );

    const error = await pi
      .request({ type: "set_model", provider: "x", modelId: "y" } as { type: string })
      .catch((caught: unknown) => caught);

    expect(error).toStrictEqual(new ReplayRequestError("set_model", "rejected", "Model not found: x/y"));
    expect(error).toMatchObject({ name: "PiRequestError", reason: "rejected", detail: "Model not found: x/y" });
  });

  it("keeps an error pi did not give as text readable, as JSON", async () => {
    const pi = replayPi(
      fixture(
        { kind: "send", record: { type: "compact", id: "r1" } },
        { kind: "stdout", record: { type: "response", command: "compact", id: "r1", success: false, error: { n: 1 } } },
      ),
    );

    const error = await pi.request({ type: "compact" }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ reason: "rejected", detail: '{"n":1}' });
  });

  it("fails clearly when the caller sends something else than the fixture recorded", async () => {
    const pi = replayPi(fixture({ kind: "send", record: { type: "prompt", message: "hi", id: "r1" } }));

    const error = await pi
      .request({ type: "prompt", message: "bye" } as { type: string })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FixtureMismatch);
    expect(error).toMatchObject({
      message:
        'fixture expected {"kind":"send","record":{"type":"prompt","message":"hi","id":"r1"}}, but the caller sent {"type":"prompt","message":"bye"}',
    });
    expect(pi.remaining()).toBe(1);
  });

  it("requires dialog answers to match exactly, id included", async () => {
    const pi = replayPi(
      fixture(
        { kind: "send", record: { type: "extension_ui_response", id: "<uuid-1>", confirmed: true } },
        { kind: "stdout", record: { type: "extension_ui_request", method: "notify", message: "confirmed" } },
      ),
    );
    const events: JsonObject[] = [];
    pi.onEvent((event) => events.push(event));

    expect(() => pi.respond({ type: "extension_ui_response", id: "<uuid-2>", confirmed: true })).toThrow(
      FixtureMismatch,
    );
    pi.respond({ type: "extension_ui_response", id: "<uuid-1>", confirmed: true });
    await Promise.resolve();

    expect(events).toStrictEqual([{ type: "extension_ui_request", method: "notify", message: "confirmed" }]);
  });

  it("ends like a crash when the fixture exits on its own, failing the request still waiting", async () => {
    const pi = replayPi(
      fixture(
        { kind: "send", record: { type: "get_state", id: "r1" } },
        { kind: "exit", code: 3, signal: null, requested: false },
      ),
    );

    const error = await pi.request({ type: "get_state" }).catch((caught: unknown) => caught);

    expect(error).toStrictEqual(new ReplayRequestError("get_state", "exited", ""));
    expect(error).toMatchObject({ detail: "" });
    expect(await pi.exited).toStrictEqual({ code: 3, signal: null, requested: false, stderrTail: "" });
    // After the crash nothing reaches the fixture, as with a real pi that has exited.
    const later = await pi.request({ type: "get_state" }).catch((caught: unknown) => caught);
    expect(later).toMatchObject({ name: "PiRequestError", reason: "exited", detail: "" });
    expect(() => pi.respond({ type: "extension_ui_response", id: "x", cancelled: true })).not.toThrow();
  });

  it("on stop, fails waiting requests as stopped, drops their responses and ends as the fixture ended", async () => {
    const pi = replayPi(
      fixture(
        { kind: "send", record: { type: "get_state", id: "r1" } },
        { kind: "stdout", record: { type: "response", command: "get_state", id: "r1", success: true, data: {} } },
        { kind: "stdout", record: { type: "agent_settled" } },
        { kind: "exit", code: null, signal: "SIGTERM", requested: true },
      ),
    );
    const events: JsonObject[] = [];
    pi.onEvent((event) => events.push(event));

    const waiting = pi.request({ type: "get_state" }).catch((caught: unknown) => caught);
    const exit = await pi.stop();

    expect(await waiting).toMatchObject({ name: "PiRequestError", reason: "stopped", detail: undefined });
    expect(events).toStrictEqual([{ type: "agent_settled" }]);
    expect(exit).toStrictEqual({ code: null, signal: "SIGTERM", requested: true, stderrTail: "" });
    expect(await pi.exited).toBe(exit);
    expect(await pi.stop()).toBe(exit);
    const after = await pi.request({ type: "get_state" }).catch((caught: unknown) => caught);
    expect(after).toMatchObject({ name: "PiRequestError", reason: "stopped" });
    expect(pi.remaining()).toBe(0);
  });

  it("ends a caller that stops early the way the fixture ended, skipping the sends it never made", async () => {
    const early = replayPi(
      fixture(
        { kind: "send", record: { type: "get_state", id: "r1" } },
        { kind: "exit", code: null, signal: "SIGTERM", requested: true },
      ),
    );
    const noExit = replayPi(fixture({ kind: "send", record: { type: "get_state", id: "r1" } }));

    expect(await early.stop()).toStrictEqual({ code: null, signal: "SIGTERM", requested: true, stderrTail: "" });
    expect(early.remaining()).toBe(2);
    expect(await noExit.stop()).toStrictEqual({ code: 0, signal: null, requested: true, stderrTail: "" });
  });

  it("stops calling a listener once it unsubscribes", async () => {
    const pi = replayPi(fixture({ kind: "stdout", record: { type: "agent_start" } }));
    const events: JsonObject[] = [];

    pi.onEvent((event) => events.push(event))();
    await Promise.resolve();

    expect(events).toStrictEqual([]);
  });

  it("keeps delivering after each later request and answer, not only at the start", async () => {
    const pi = replayPi(
      fixture(
        { kind: "send", record: { type: "get_state", id: "r1" } },
        { kind: "stdout", record: { type: "response", command: "get_state", id: "r1", success: true, data: { n: 1 } } },
        { kind: "send", record: { type: "get_state", id: "r2" } },
        { kind: "stdout", record: { type: "response", command: "get_state", id: "r2", success: true, data: { n: 2 } } },
        { kind: "send", record: { type: "extension_ui_response", id: "<uuid-1>", cancelled: true } },
        { kind: "stdout", record: { type: "agent_settled" } },
      ),
    );
    const events: JsonObject[] = [];
    pi.onEvent((event) => events.push(event));

    expect(await pi.request({ type: "get_state" })).toStrictEqual({ n: 1 });
    expect(await pi.request({ type: "get_state" })).toStrictEqual({ n: 2 });
    pi.respond({ type: "extension_ui_response", id: "<uuid-1>", cancelled: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toStrictEqual([{ type: "agent_settled" }]);
  });

  it("waits for stop() before an exit the host asked for", async () => {
    const pi = replayPi(fixture({ kind: "exit", code: 0, signal: null, requested: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const before = await Promise.race([pi.exited.then(() => "exited"), Promise.resolve("running")]);
    expect(pi.remaining()).toBe(1);

    expect(before).toBe("running");
    expect(await pi.stop()).toStrictEqual({ code: 0, signal: null, requested: true, stderrTail: "" });
  });

  it("fails clearly when the caller sends after the fixture's last send", async () => {
    const pi = replayPi(fixture({ kind: "exit", code: 0, signal: null, requested: true }));
    const ended = replayPi(fixture());

    const atExit = await pi.request({ type: "get_state" }).catch((caught: unknown) => caught);
    const atEnd = await ended.request({ type: "get_state" }).catch((caught: unknown) => caught);

    expect(atExit).toMatchObject({
      name: "FixtureMismatch",
      message:
        'fixture expected {"kind":"exit","code":0,"signal":null,"requested":true}, but the caller sent {"type":"get_state"}',
    });
    expect(atEnd).toMatchObject({
      name: "FixtureMismatch",
      message: 'fixture expected "the end", but the caller sent {"type":"get_state"}',
    });
  });

  it("names its errors like the pi package does", () => {
    expect(new ReplayRequestError("get_state", "exited")).toMatchObject({
      name: "PiRequestError",
      message: "pi get_state exited",
    });
    // Like the real error, the message leaves pi's text out; it stays in `detail`.
    expect(new ReplayRequestError("compact", "rejected", "busy")).toMatchObject({
      message: "pi compact rejected",
      detail: "busy",
    });
  });

  it("delivers output recorded before any command on its own", async () => {
    const pi = replayPi(fixture({ kind: "stdout", record: { type: "extension_ui_request", method: "notify" } }));
    const events: JsonObject[] = [];
    pi.onEvent((event) => events.push(event));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toStrictEqual([{ type: "extension_ui_request", method: "notify" }]);
  });
});
