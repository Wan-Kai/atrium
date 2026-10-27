import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CommandResult } from "../../../packages/protocol/src/commands";
import { RemoteState } from "../../../packages/protocol/src/remote";
import { createTempDir, writeScriptedPi } from "../../../packages/testkit/src/index";
import { startTestHost, type TestHost } from "../../../packages/host/test/harness";
import { LocalClient } from "../../../packages/host/test/remote/local-client";
import { MemoryVault } from "../../../packages/host/test/remote/service-fixture";
import { PONG_TURN, UNANSWERED_STATS } from "../../../packages/host/test/scripted-chat";
import { systemClock } from "../../relay/src/clock";
import { hashToken } from "../../relay/src/hosts";
import { type Relay, startRelay } from "../../relay/src/relay";
import { ResourceTracker as RelayResources } from "../../relay/src/resources";
import { bounded, startControl, type ControlServer } from "./control";
import type { LocalFixture } from "./fixture";

/** How many earlier user messages the session has: more than the phone's six-turn budget. */
export const HISTORY_TURNS = 8;

/** The earlier user messages, as pi's entries. */
const HISTORY = Array.from({ length: HISTORY_TURNS }, (_, index) => ({
  type: "message",
  id: `h${index}`,
  parentId: index === 0 ? null : `h${index - 1}`,
  timestamp: "2026-10-08T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text: `earlier ${index}` }], timestamp: 0 },
}));

/**
 * Reads the host's remote state through the desktop's local connection.
 * @remarks The protocol schema checks the whole state.
 * @sideEffects Sends a local command.
 * @param desktop - The local client.
 * @returns The state.
 */
async function remoteState(desktop: LocalClient) {
  const response = await desktop.request({ type: "get_remote" });
  assert.equal(response.ok, true);
  return RemoteState.parse(response.result);
}

/**
 * Waits until the remote state satisfies a condition, within the fixture's bound.
 * @remarks Polls the host's own state; no timing guess decides the outcome.
 * @sideEffects Sends local commands; sleeps between polls.
 * @param desktop - The local client.
 * @param condition - What to wait for.
 * @param signal - Fixture shutdown.
 * @returns The state that satisfied it.
 */
async function remoteUntil(
  desktop: LocalClient,
  condition: (state: RemoteState) => boolean,
  signal?: AbortSignal,
): Promise<RemoteState> {
  // The poll stops with the wait: on success, on the bound, and on shutdown.
  const stop = new AbortController();
  try {
    return await bounded(
      (async () => {
        while (!stop.signal.aborted) {
          const state = await remoteState(desktop);
          if (condition(state)) return state;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("poll stopped");
      })(),
      signal,
    );
  } finally {
    stop.abort();
  }
}

/**
 * Starts the real host with a scripted pi, and the real relay, for the Swift sync contract.
 * @remarks SPEC-0005 "验证 · App · 契约测试" for MP4a: the production host server (`startHost` through
 * the test harness) with remote access on, the production relay in process, a scripted pi in place of
 * a model, and the vault in memory. The control endpoint only does what the Mac's user would: confirm
 * the pairing, open a chat, send a message; everything the phone sees goes over the real relay.
 * @sideEffects Opens loopback listeners, starts the host and a scripted pi, writes temporary files.
 * @param signal - Runner interruption, including during startup.
 * @returns The control origin, credential and cleanup.
 */
export async function startFixture(signal: AbortSignal): Promise<LocalFixture> {
  signal.throwIfAborted();
  const relayResources = new RelayResources();
  const hostId = `hst_${randomBytes(8).toString("hex")}`;
  const relayToken = randomBytes(32).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  let relay: Relay | undefined;
  let host: TestHost | undefined;
  let desktop: LocalClient | undefined;
  let control: ControlServer | undefined;
  let bin: Awaited<ReturnType<typeof createTempDir>> | undefined;
  let closing: Promise<void> | undefined;

  /**
   * Closes every resource even when startup, Swift assertions or cancellation fail.
   * @remarks A failing step does not stop the others; relay resources must come back to zero.
   * @sideEffects Closes the control, desktop client, host, relay and temporary directory.
   * @returns When teardown is done.
   */
  function close(): Promise<void> {
    return (closing ??= (async () => {
      const results = await Promise.allSettled([control?.close(), desktop?.close()]);
      results.push(...(await Promise.allSettled([host?.dispose()])));
      results.push(...(await Promise.allSettled([relay?.close(), bin?.cleanup()])));
      assert.ok(
        Object.values(relayResources.snapshot()).every((count) => count === 0),
        "relay resources leaked",
      );
      for (const result of results) if (result.status === "rejected") throw result.reason;
      console.log("Sync contract cleanup: host disposed, relay resources zero, control closed");
    })());
  }

  try {
    relay = await startRelay({
      config: { publicHost: "127.0.0.1", pathPrefix: "/atrium", trustedProxies: [], newStreamsPerIpPerMinute: 30 },
      hosts: [
        { hostId, name: "Sync contract host", tokenSha256: hashToken(relayToken), createdAt: "2026-10-27T00:00:00Z" },
      ],
      clock: systemClock,
      resources: relayResources,
      log: () => {},
      listen: { host: "127.0.0.1", port: 0 },
    });
    bin = await createTempDir("sync-contract-bin");
    const scripted = await writeScriptedPi(
      bin.path,
      {
        rules: {
          get_state: { data: { sessionId: "pi-session-1" } },
          get_entries: { data: { entries: HISTORY, leafId: `h${HISTORY_TURNS - 1}` } },
          get_session_stats: UNANSWERED_STATS,
          prompt: { data: { disposition: "started" }, events: PONG_TURN },
        },
      },
      "pi",
    );
    host = await startTestHost({
      vault: new MemoryVault(),
      toolEnv: { PATH: `${bin.path}:/usr/bin:/bin`, ...scripted.env },
    });
    await host.host.tools;
    desktop = new LocalClient(host.url, host.token);
    await bounded(
      desktop.next((value) => value.type === "welcome"),
      signal,
    );
    const line = `atrium-relay://${hostId}:${relayToken}@127.0.0.1:${relay.port}/atrium`;
    assert.equal((await desktop.request({ type: "set_remote", enabled: true, relay: line })).ok, true);
    await remoteUntil(desktop, (state) => state.relay?.status === "connected", signal);
    assert.equal((await desktop.request({ type: "start_pairing" })).ok, true);
    const pairing = (await remoteState(desktop)).pairing;
    assert.ok(pairing !== null);
    const owner = desktop;
    control = await startControl(token, async (action, body, requestSignal) => {
      switch (action) {
        case "/setup":
          return { link: pairing.qr };
        case "/confirm": {
          const waiting = await remoteUntil(
            owner,
            (state) => state.pairing?.state === "awaiting_confirmation",
            requestSignal,
          );
          assert.ok("sas" in body && waiting.pairing?.request?.sas === body.sas, "Swift and host SAS differ");
          const answer = await owner.request({ type: "confirm_pairing", pairingId: pairing.pairingId, accept: true });
          assert.equal(answer.ok, true);
          return { sas: waiting.pairing?.request?.sas };
        }
        case "/chat": {
          const created = await owner.request({ type: "create_chat" });
          assert.equal(created.ok, true);
          const { sessionId } = CommandResult.create_chat.parse(created.result);
          assert.equal((await owner.request({ type: "open_session", sessionId })).ok, true);
          return { sessionId, historyTurns: HISTORY_TURNS };
        }
        case "/prompt": {
          assert.ok("sessionId" in body && "text" in body);
          const sent = await owner.request({ type: "prompt", sessionId: body.sessionId, text: body.text });
          assert.equal(sent.ok, true);
          return {};
        }
        default:
          return undefined;
      }
    });
    console.log("Sync contract fixture: real host + scripted pi + real relay on loopback /atrium");
    return { origin: control.origin, token, close };
  } catch (error) {
    await close();
    throw error;
  }
}
