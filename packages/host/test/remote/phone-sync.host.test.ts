import { CommandResult, RemoteState } from "@atrium/protocol";
import { FakeClock, createTempDir, writeScriptedPi } from "@atrium/testkit";
import { describe, expect, it, onTestFinished } from "vitest";
import { startTestHost } from "../harness";
import { PONG_TURN, UNANSWERED_STATS } from "../scripted-chat";
import { FakePhone, type PhoneSession } from "./fake-phone";
import { LocalClient } from "./local-client";
import { startTestRelay } from "./relay-process";
import { MemoryVault } from "./service-fixture";

/** Three earlier user messages, as pi's entries. */
const HISTORY = ["one", "two", "three"].map((text, index) => ({
  type: "message",
  id: `h${index}`,
  parentId: index === 0 ? null : `h${index - 1}`,
  timestamp: "2026-10-08T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
}));

/**
 * Reads a successful local remote-management response.
 * @remarks The protocol schema checks the entire state.
 * @sideEffects Sends a local command.
 * @param client - Connected desktop client.
 * @returns The validated state.
 */
async function remoteState(client: LocalClient) {
  const response = await client.request({ type: "get_remote" });
  expect(response.ok).toBe(true);
  return RemoteState.parse(response.result);
}

/**
 * Collects what a phone receives until a message of the given type.
 * @remarks Every message in order, the last one included.
 * @sideEffects Consumes the session's messages.
 * @param phone - The phone's session.
 * @param type - The type that ends the collection.
 * @returns The messages.
 */
async function until(phone: PhoneSession, type: string): Promise<Record<string, unknown>[]> {
  const received: Record<string, unknown>[] = [];
  for (;;) {
    const message = await phone.message(() => true, { timeoutMs: 15_000 });
    received.push(message);
    if (message.type === type) return received;
  }
}

/**
 * The turns among a snapshot's items.
 * @remarks Notices are not counted.
 * @sideEffects none
 * @param snapshot - A `session_snapshot`.
 * @returns How many turns it carries.
 */
function turnsOf(snapshot: Record<string, unknown>): number {
  return (snapshot.items as { kind: string }[]).filter((item) => item.kind === "turn").length;
}

describe("a phone's session sync through the real relay (SPEC-0005, MP4a)", () => {
  it("gets snapshots cut to its budget with the desktop's stream, and the live events after them", async () => {
    const relay = await startTestRelay();
    onTestFinished(relay.cleanup);
    const bin = await createTempDir("phone-sync-bin");
    onTestFinished(bin.cleanup);
    const scripted = await writeScriptedPi(
      bin.path,
      {
        rules: {
          get_state: { data: { sessionId: "pi-session-1" } },
          get_entries: { data: { entries: HISTORY, leafId: "h2" } },
          get_session_stats: UNANSWERED_STATS,
          prompt: { data: { disposition: "started" }, events: PONG_TURN },
        },
      },
      "pi",
    );
    const host = await startTestHost({
      vault: new MemoryVault(),
      toolEnv: { PATH: `${bin.path}:/usr/bin:/bin`, ...scripted.env },
    });
    onTestFinished(host.dispose);
    await host.host.tools;
    const desktop = new LocalClient(host.url, host.token);
    onTestFinished(() => desktop.close());
    await desktop.next((value) => value.type === "welcome");
    expect(await desktop.request({ type: "set_remote", enabled: true, relay: relay.line })).toMatchObject({ ok: true });
    await expect.poll(async () => (await remoteState(desktop)).relay?.status).toBe("connected");
    await desktop.request({ type: "start_pairing" });
    const pairing = (await remoteState(desktop)).pairing;
    const phoneClock = new FakeClock();
    const phone = new FakePhone({ clock: phoneClock });
    onTestFinished(() => phone.dispose());
    const session = await phone.pair(pairing!.qr);
    await expect.poll(async () => (await remoteState(desktop)).pairing?.state).toBe("awaiting_confirmation");
    await desktop.request({ type: "confirm_pairing", pairingId: pairing!.pairingId, accept: true });
    const deviceId = String((await session.control(["paired"])).deviceId);
    await session.hello(deviceId);

    const created = await desktop.request({ type: "create_chat" });
    const sessionId = CommandResult.create_chat.parse(created.result).sessionId;
    expect(await desktop.request({ type: "open_session", sessionId })).toMatchObject({ ok: true });
    expect(
      await session.request({
        type: "subscribe_sessions",
        sessionIds: [sessionId],
        snapshot: { turns: 1, bytes: 65_536 },
      }),
    ).toMatchObject({ ok: true });
    const [phoneSnapshot] = (await until(session, "session_snapshot")).slice(-1);
    expect(await desktop.request({ type: "subscribe_sessions", sessionIds: [sessionId] })).toMatchObject({ ok: true });
    const desktopSnapshot = await desktop.next((value) => value.type === "session_snapshot");

    expect(turnsOf(desktopSnapshot)).toBe(3);
    expect(phoneSnapshot).toStrictEqual({
      ...desktopSnapshot,
      items: (desktopSnapshot.items as unknown[]).slice(-1),
      hasOlder: true,
    });
    expect(phoneSnapshot!.stream).toStrictEqual(expect.any(String));

    expect(await desktop.request({ type: "prompt", sessionId, text: "ping" })).toMatchObject({ ok: true });
    const live = await until(session, "run_settled");
    const events = live.filter((message) => message.sessionId === sessionId);
    expect(events.map((event) => event.type)).toStrictEqual([
      "run_started",
      "turn_started",
      "step_added",
      "step_delta",
      "turn_finished",
      "run_settled",
    ]);
    expect(events.map((event) => [event.epoch, event.seq])).toStrictEqual(
      events.map((_, index) => [phoneSnapshot!.epoch, Number(phoneSnapshot!.seq) + index + 1]),
    );
    expect(events[3]).toMatchObject({ delta: "pong" });

    // The phone's own message, sent twice with one request id as after a lost answer, runs once.
    const message = { type: "prompt", requestId: "8d4f0e3c-0000-4000-8000-000000000001", sessionId, text: "ping" };
    const first = await session.request(message);
    expect(first).toMatchObject({ ok: true, result: { disposition: "started" } });
    const run = (await until(session, "run_settled")).filter((value) => value.type === "run_started");
    expect(run).toHaveLength(1);
    expect(await session.request(message)).toStrictEqual(first);
    expect(await session.request({ ...message, text: "other" })).toMatchObject({
      ok: false,
      error: { code: "request_conflict" },
    });
    // A round trip orders every event the retry could have caused before this check.
    await session.request({ type: "ping" });
    const rerun = session.message((value) => value.type === "run_started", { timeoutMs: 1 }).catch((e: unknown) => e);
    phoneClock.advance(1);
    expect(await rerun).toStrictEqual(new Error("timeout"));
  });
});
