import {
  CloseCode,
  type HostMessage,
  IDLE_CONTROL,
  type SessionSnapshotEvent,
  UNKNOWN_METRICS,
} from "@atrium/protocol";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { type SocketLike, createConnection } from "./connection";

const shutdowns: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
});

/** A socket that records what is sent and closed, with a backlog the test sets. */
function fakeSocket(): SocketLike & { bufferedAmount: number; sent: string[]; closes: [number, string][] } {
  const socket = {
    bufferedAmount: 0,
    sent: [] as string[],
    closes: [] as [number, string][],
    send: (data: string) => socket.sent.push(data),
    close: (code: number, reason: string) => socket.closes.push([code, reason]),
  };
  return socket;
}

/** A connection over a fake socket that allows 100 waiting bytes, logging into memory. */
function connectionOver(socket: SocketLike) {
  const recording = recordingTracing();
  shutdowns.push(recording.shutdown);
  const connection = createConnection(socket, {
    id: "connection-1",
    clientId: "client-1",
    trace: ROOT_CONTEXT,
    maxBufferedBytes: 100,
    logger: recording.logger,
  });
  return { connection, records: recording.records };
}

const response = { type: "response", requestId: "r1", ok: true, result: {} } as const;

describe("createConnection", () => {
  it("sends messages as JSON while the backlog is at most the limit", () => {
    const socket = fakeSocket();
    const { connection } = connectionOver(socket);

    expect(connection.send(response)).toBe(true);
    socket.bufferedAmount = 100;
    expect(connection.send(response)).toBe(true);

    expect(socket.sent).toStrictEqual([JSON.stringify(response), JSON.stringify(response)]);
    expect(socket.closes).toStrictEqual([]);
    expect(connection).toMatchObject({ id: "connection-1", clientId: "client-1", trace: ROOT_CONTEXT });
  });

  it("closes a client that falls behind with 4507 once, and sends it nothing more", () => {
    const socket = fakeSocket();
    const { connection, records } = connectionOver(socket);

    socket.bufferedAmount = 101;
    expect(connection.send(response)).toBe(false);
    socket.bufferedAmount = 0;
    expect(connection.send(response)).toBe(false);

    expect(socket.sent).toStrictEqual([]);
    expect(socket.closes).toStrictEqual([[CloseCode.SlowConsumer, "slow consumer"]]);
    expect(records).toStrictEqual([
      expect.objectContaining({
        level: "warn",
        msg: "client dropped: reading too slowly",
        client_id: "client-1",
        buffered_bytes: 101,
      }),
    ]);
  });
});

/** The phone's message limit in these tests. */
const LIMIT = 2000;

/** A phone's connection over a fake socket, with a limit of `LIMIT` bytes and snapshots the test gives. */
function phoneOver(socket: SocketLike, snapshots: Record<string, SessionSnapshotEvent>) {
  const recording = recordingTracing();
  shutdowns.push(recording.shutdown);
  const connection = createConnection(socket, {
    id: "connection-2",
    clientId: "dev_0123456789abcdef",
    trace: ROOT_CONTEXT,
    maxBufferedBytes: 1_000_000,
    logger: recording.logger,
    remote: {
      deviceId: "dev_0123456789abcdef",
      maxMessageBytes: LIMIT,
      snapshotOf: (sessionId) => snapshots[sessionId] ?? null,
    },
  });
  return { connection, records: recording.records };
}

/** A session event of about `size` bytes. */
function delta(sessionId: string, size: number) {
  return {
    type: "step_delta",
    sessionId,
    epoch: 1,
    seq: 9,
    traceId: null,
    stream: "st-1",
    turnId: "t1",
    stepId: "1",
    delta: "d".repeat(size),
  } as const;
}

/** A small snapshot of a session. */
function snapshotOf(sessionId: string): SessionSnapshotEvent {
  return {
    type: "session_snapshot",
    sessionId,
    epoch: 1,
    seq: 9,
    traceId: null,
    stream: "st-1",
    items: [],
    hasOlder: false,
    run: null,
    exited: false,
    control: IDLE_CONTROL,
    model: null,
    fast: false,
    metrics: UNKNOWN_METRICS,
  };
}

describe("a phone's connection", () => {
  it("is remote, knows its device and drops what is not for the phone", () => {
    const socket = fakeSocket();
    const { connection } = phoneOver(socket, {});

    expect(connection.send({ type: "credentials_changed" })).toBe(false);
    expect(connection.send({ type: "pi_latest", latest: null, checkedAt: null })).toBe(false);
    expect(connection.send(response)).toBe(true);

    expect(connection).toMatchObject({ origin: "remote", deviceId: "dev_0123456789abcdef" });
    expect(socket.sent).toStrictEqual([JSON.stringify(response)]);
  });

  it("sends a message of exactly the limit, and answers a larger response with response_too_large", () => {
    const socket = fakeSocket();
    const { connection } = phoneOver(socket, {});
    const fits = { ...response, result: { text: "" } };
    const exact = { ...fits, result: { text: "x".repeat(LIMIT - JSON.stringify(fits).length) } };
    const over = { ...fits, result: { text: "x".repeat(LIMIT + 1 - JSON.stringify(fits).length) } };

    expect(connection.send(exact)).toBe(true);
    expect(connection.send(over)).toBe(true);

    expect(socket.sent).toStrictEqual([
      JSON.stringify(exact),
      JSON.stringify({
        type: "response",
        requestId: "r1",
        ok: false,
        error: { code: "response_too_large", params: { limit: LIMIT } },
      }),
    ]);
  });

  it("sends the session's snapshot for an event too large, and drops it when there is none or it is too large too", () => {
    const socket = fakeSocket();
    // Over the limit only by what a real snapshot could carry; the field is not one the phone reads.
    const large = { ...snapshotOf("s3"), padding: "p".repeat(LIMIT) } as SessionSnapshotEvent;
    const { connection, records } = phoneOver(socket, { s1: snapshotOf("s1"), s3: large });
    const small = delta("s1", 10);

    expect(connection.send(small)).toBe(true);
    expect(connection.send(delta("s1", LIMIT))).toBe(true);
    expect(connection.send(delta("s2", LIMIT))).toBe(false);
    expect(connection.send(delta("s3", LIMIT))).toBe(false);

    expect(socket.sent).toStrictEqual([JSON.stringify(small), JSON.stringify(snapshotOf("s1"))]);
    const dropped = expect.objectContaining({
      level: "warn",
      msg: "message too large for the phone dropped",
      device_id: "dev_0123456789abcdef",
      type: "step_delta",
    });
    expect(records).toStrictEqual([dropped, dropped]);
  });

  it("drops a large message that is no session's, such as the list", () => {
    const socket = fakeSocket();
    const { connection } = phoneOver(socket, {});
    const list: HostMessage = {
      type: "index_changes",
      generation: "g".repeat(LIMIT),
      seq: 1,
      projects: { upsert: [], remove: [] },
      workspaces: { upsert: [], remove: [] },
      chats: { upsert: [], remove: [] },
      sessions: { upsert: [], remove: [] },
      layout: null,
      preferences: null,
    };

    expect(connection.send(list)).toBe(false);
    expect(socket.sent).toStrictEqual([]);
  });

  it("keeps the backlog limit for a phone too", () => {
    const socket = fakeSocket();
    const { connection } = phoneOver(socket, {});
    socket.bufferedAmount = 1_000_001;

    expect(connection.send(response)).toBe(false);
    expect(socket.closes).toStrictEqual([[CloseCode.SlowConsumer, "slow consumer"]]);
  });

  it("sends the list without archived sessions or file paths, and a local client the list as it is", () => {
    const archived = {
      sessionId: "s1",
      containerId: "cht_1",
      name: null,
      prompt: null,
      file: "/pi/sessions/s1.jsonl",
      state: "persisted",
      updatedAt: 1,
      archived: true,
      running: false,
      attention: null,
      asking: null,
      question: null,
      model: null,
      parent: null,
      agent: null,
      heldDeliveries: 0,
    } as const;
    const changes: HostMessage = {
      type: "index_changes",
      generation: "g1",
      seq: 1,
      projects: { upsert: [], remove: [] },
      workspaces: { upsert: [], remove: [] },
      chats: { upsert: [], remove: [] },
      sessions: { upsert: [archived], remove: [] },
      layout: null,
      preferences: null,
    };
    const phoneSocket = fakeSocket();
    const localSocket = fakeSocket();

    expect(phoneOver(phoneSocket, {}).connection.send(changes)).toBe(true);
    expect(connectionOver(localSocket).connection.send(changes)).toBe(true);

    expect(phoneSocket.sent).toStrictEqual([JSON.stringify({ ...changes, sessions: { upsert: [], remove: ["s1"] } })]);
    expect(localSocket.sent).toStrictEqual([JSON.stringify(changes)]);
  });

  it("is local, with no device, without the remote rules", () => {
    const socket = fakeSocket();
    const { connection } = connectionOver(socket);

    expect(connection.send({ type: "credentials_changed" })).toBe(true);
    expect(connection).toMatchObject({ origin: "local", deviceId: null });
  });
});
