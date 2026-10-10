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

describe("client session views", () => {
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
