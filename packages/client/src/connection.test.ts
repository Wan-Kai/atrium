import { CloseCode, PROTOCOL_VERSION } from "@atrium/protocol";
import { present } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { type SocketLike, buildHello, createConnection } from "./connection";

const trace = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true };
const welcome = (hostVersion: string) =>
  JSON.stringify({
    type: "welcome",
    protocolVersion: PROTOCOL_VERSION,
    hostVersion,
    hostInstanceId: "h1",
    heartbeatMs: 15_000,
  });

/** A socket the test drives by hand: it records what the client sends and replays host events. */
function scriptedSocket() {
  const listeners: Record<string, Array<(event: never) => void>> = {};
  const sent: string[] = [];
  const closes: Array<[number | undefined, string | undefined]> = [];
  const socket: SocketLike & {
    sent: string[];
    closes: Array<[number | undefined, string | undefined]>;
    open(): void;
    receive(data: unknown): void;
    closeWith(code: number): void;
  } = {
    readyState: 0,
    sent,
    closes,
    send: (data) => sent.push(data),
    close: (code, reason) => closes.push([code, reason]),
    addEventListener: (type: string, listener: (event: never) => void) => {
      (listeners[type] ??= []).push(listener);
    },
    open: () => listeners["open"]?.forEach((listener) => listener(undefined as never)),
    receive: (data) => listeners["message"]?.forEach((listener) => listener({ data } as never)),
    closeWith: (code) => listeners["close"]?.forEach((listener) => listener({ code } as never)),
  };
  return socket;
}

/** A connection wired to a scripted socket. */
function connectionWithSocket() {
  const socket = scriptedSocket();
  const connection = createConnection({
    url: "ws://host.invalid",
    token: "token-value",
    clientId: "client-1",
    openSocket: () => socket,
    createTrace: () => trace,
  });
  return { socket, connection };
}

describe("buildHello", () => {
  it("carries the token, client id, protocol version and the action's traceparent", () => {
    expect(buildHello("token-value", "client-1", trace)).toStrictEqual({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      clientId: "client-1",
      token: "token-value",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
  });
});

describe("createConnection", () => {
  it("starts idle and can be disconnected before it ever connects", () => {
    const { socket, connection } = connectionWithSocket();

    connection.disconnect();

    expect(connection.state.getState()).toStrictEqual({ status: "idle" });
    expect(socket.closes).toStrictEqual([]);
  });

  it("closes the socket normally when asked to disconnect", async () => {
    const { socket, connection } = connectionWithSocket();
    const settled = connection.connect();
    socket.open();
    socket.receive(welcome("0.1.0"));
    await settled;

    connection.disconnect();

    expect(socket.closes).toStrictEqual([[1000, "client closed"]]);
  });

  it.each([
    [CloseCode.Unauthorized, "unauthorized"],
    [CloseCode.VersionMismatch, "version-mismatch"],
    [CloseCode.BadHandshake, "bad-handshake"],
    [CloseCode.HandshakeTimeout, "handshake-timeout"],
    [CloseCode.RateLimited, "rate-limited"],
    [CloseCode.TooManyConnections, "too-many-connections"],
  ] as const)("maps close code %i to the rejection %s", async (code, reason) => {
    const { socket, connection } = connectionWithSocket();
    const settled = connection.connect();

    socket.closeWith(code);

    expect(await settled).toStrictEqual({ status: "rejected", reason });
  });

  it("closes the previous socket on reconnect and ignores its late events", async () => {
    const sockets = [scriptedSocket(), scriptedSocket()];
    const unopened = [...sockets];
    const connection = createConnection({
      url: "ws://host.invalid",
      token: "token-value",
      clientId: "client-1",
      openSocket: () => present(unopened.shift(), "a scripted socket"),
      createTrace: () => trace,
    });
    const [first, second] = sockets as [ReturnType<typeof scriptedSocket>, ReturnType<typeof scriptedSocket>];
    const firstAttempt = connection.connect();
    const secondAttempt = connection.connect();
    second.open();
    second.receive(welcome("0.2.0"));
    await secondAttempt;

    first.receive(welcome("0.1.0"));
    first.closeWith(1006);

    expect(first.closes).toStrictEqual([[1000, "client reconnecting"]]);
    expect(await firstAttempt).toStrictEqual({ status: "disconnected", code: 1006 });
    expect(connection.state.getState()).toStrictEqual({
      status: "connected",
      traceId: trace.traceId,
      hostVersion: "0.2.0",
    });
  });

  it("ignores a welcome that the replaced socket receives while the new one is still connecting", () => {
    const sockets = [scriptedSocket(), scriptedSocket()];
    const unopened = [...sockets];
    const connection = createConnection({
      url: "ws://host.invalid",
      token: "token-value",
      clientId: "client-1",
      openSocket: () => present(unopened.shift(), "a scripted socket"),
      createTrace: () => trace,
    });
    void connection.connect();
    void connection.connect();

    sockets[0]?.receive(welcome("0.1.0"));

    expect(connection.state.getState()).toStrictEqual({ status: "connecting", traceId: trace.traceId });
  });

  it("starts a fresh attempt without leftovers from a rejected one", async () => {
    const first = connectionWithSocket();
    const rejected = first.connection.connect();
    first.socket.closeWith(CloseCode.Unauthorized);
    await rejected;

    void first.connection.connect();

    expect(first.connection.state.getState()).toStrictEqual({ status: "connecting", traceId: trace.traceId });
  });

  it("sends hello on open and stays connecting until a real welcome arrives", async () => {
    const { socket, connection } = connectionWithSocket();
    const settled = connection.connect();

    socket.open();
    socket.receive("not json");
    socket.receive(JSON.stringify({ type: "something-else" }));
    socket.receive(new Uint8Array([1, 2, 3]));
    const beforeWelcome = connection.state.getState();
    socket.receive(welcome("0.1.0"));

    expect(socket.sent).toStrictEqual([JSON.stringify(buildHello("token-value", "client-1", trace))]);
    expect(beforeWelcome).toStrictEqual({ status: "connecting", traceId: trace.traceId });
    expect(await settled).toStrictEqual({ status: "connected", traceId: trace.traceId, hostVersion: "0.1.0" });
  });

  it("ignores a second welcome once connected", async () => {
    const { socket, connection } = connectionWithSocket();
    const settled = connection.connect();
    socket.open();

    socket.receive(welcome("0.1.0"));
    socket.receive(welcome("9.9.9"));

    await settled;
    expect(connection.state.getState()).toStrictEqual({
      status: "connected",
      traceId: trace.traceId,
      hostVersion: "0.1.0",
    });
  });

  it("reports a refused handshake by its reason and a plain close by its code", async () => {
    const refused = connectionWithSocket();
    const refusedResult = refused.connection.connect();
    refused.socket.closeWith(CloseCode.Unauthorized);

    const dropped = connectionWithSocket();
    void dropped.connection.connect();
    dropped.socket.open();
    dropped.socket.receive(welcome("0.1.0"));
    dropped.socket.closeWith(1006);

    expect(await refusedResult).toStrictEqual({ status: "rejected", reason: "unauthorized" });
    expect(dropped.connection.state.getState()).toStrictEqual({ status: "disconnected", code: 1006 });
  });
});
