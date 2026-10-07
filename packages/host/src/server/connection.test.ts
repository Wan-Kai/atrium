import { CloseCode } from "@atrium/protocol";
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
