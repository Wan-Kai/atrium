import { PROTOCOL_VERSION } from "@atrium/protocol";
import { FakeClock, present } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { createAtriumClient } from "./atrium-client";

/** A socket that answers every command at once, so watching never waits on a host. */
function answeringSocket() {
  const listeners: Record<string, Array<(event: never) => void>> = {};
  const socket = {
    readyState: 1,
    send: (data: string) => {
      const command = JSON.parse(data) as { type: string; requestId?: string };
      if (command.type === "hello") return;
      queueMicrotask(() =>
        listeners["message"]?.forEach((listener) =>
          listener({
            data: JSON.stringify({ type: "response", requestId: command.requestId, ok: true, result: {} }),
          } as never),
        ),
      );
    },
    close: () => undefined,
    addEventListener: (type: string, listener: (event: never) => void) => {
      (listeners[type] ??= []).push(listener);
    },
    welcome: () =>
      listeners["message"]?.forEach((listener) =>
        listener({
          data: JSON.stringify({
            type: "welcome",
            protocolVersion: PROTOCOL_VERSION,
            hostVersion: "0",
            hostInstanceId: "h",
            heartbeatMs: 15_000,
            installSeed: 1,
            logDir: "/l",
          }),
        } as never),
      ),
  };
  return socket;
}

/**
 * Collects garbage until `ref` is cleared or attempts run out.
 *
 * @remarks
 * `deref()` keeps its target alive until the current task ends, so each attempt first yields,
 * then collects, and only then looks.
 */
async function collected(ref: WeakRef<object>): Promise<boolean> {
  const gc = present((globalThis as { gc?: () => void }).gc, "gc (run with --expose-gc)");
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    if (ref.deref() === undefined) return true;
  }
  return false;
}

/**
 * Cancels once and keeps only a weak reference to its acknowledgement.
 * @remarks A settled cancellation retained by the client keeps this result reachable too.
 * @sideEffects Sends one cancellation through the test socket.
 * @param client - The connected client that must remain alive during collection.
 * @returns The acknowledgement's weak reference, after its local strong reference is gone.
 */
async function cancelledOnce(client: ReturnType<typeof createAtriumClient>): Promise<WeakRef<object>> {
  return new WeakRef(await client.cancelTranslation("finished-translation"));
}

describe("client session views", () => {
  it("releases 1000 translation cancellation acknowledgements while the client stays connected", async () => {
    const socket = answeringSocket();
    const client = createAtriumClient({
      url: "ws://host.invalid",
      token: "t",
      clientId: "c",
      openSocket: () => socket,
      clock: new FakeClock(),
    });
    const connected = client.connect();
    socket.welcome();
    await connected;
    const first = await cancelledOnce(client);
    for (let index = 0; index < 999; index++) await cancelledOnce(client);
    expect(await collected(first)).toBe(true);
    expect(client.connection.getState().status).toBe("connected");
    client.disconnect();
  });

  it("drops every view after watching and unwatching 1000 sessions, and lets them be collected", async () => {
    const socket = answeringSocket();
    const client = createAtriumClient({
      url: "ws://host.invalid",
      token: "t",
      clientId: "c",
      openSocket: () => socket,
      clock: new FakeClock(),
    });
    const connected = client.connect();
    socket.welcome();
    await connected;

    let first: WeakRef<object> | undefined;
    for (let index = 0; index < 1000; index++) {
      await client.watch([`s${index}`]);
      first ??= new WeakRef(present(client.session("s0"), "the first view"));
    }
    await client.watch([]);

    expect(Array.from({ length: 1000 }, (_, index) => client.session(`s${index}`)).filter(Boolean)).toStrictEqual([]);
    expect(await collected(present(first, "a view"))).toBe(true);
    client.disconnect();
  });
});
