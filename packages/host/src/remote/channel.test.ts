import { createHash } from "node:crypto";
import { once } from "node:events";
import { inflateRawSync } from "node:zlib";
import { createServer, type Socket } from "node:net";
import {
  CHUNK_TIMEOUT_MS,
  ChannelError,
  decryptTransport,
  encodeControl,
  encodeMessage,
  encryptTransport,
  firstFrame,
  fromUtf8,
  generateKeyPair,
  HandshakeState,
  HOST_TO_PHONE_LIMIT,
  MAX_CHUNK,
  PHONE_TO_HOST_LIMIT,
  prologue,
  utf8,
  type ControlMessage,
  type Pattern,
} from "@atrium/remote-crypto";
import { FakeClock } from "@atrium/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ResourceTracker } from "../platform/resources";
import { HANDSHAKE_TIMEOUT_MS, PhoneStream, reasonOf, SILENCE_MS } from "./channel";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** Opens a real relay data endpoint and records stream callbacks. @remarks The peer can stall or corrupt frames without replacing production sockets. @sideEffects Opens a loopback listener and a PhoneStream; registers cleanup. */
async function fixture(waitForOpen = true) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: true });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("unexpected socket address");
  const endpoint = { url: `ws://127.0.0.1:${address.port}`, hostId: "hst_0123456789abcdef", token: "a".repeat(43) };
  const sockets: WebSocket[] = [];
  const requests: { url: string | undefined; extensions: string | undefined }[] = [];
  const incoming: { binary: boolean; bytes: Buffer }[] = [];
  server.on("connection", (socket, request) => {
    sockets.push(socket);
    requests.push({ url: request.url, extensions: request.headers["sec-websocket-extensions"] });
    socket.on("message", (raw, binary) => incoming.push({ binary, bytes: Buffer.from(raw as Buffer) }));
  });
  const clock = new FakeClock(100);
  const resources = new ResourceTracker();
  const frames: { stream: PhoneStream; pattern: Pattern; message: Uint8Array }[] = [];
  const controls: { stream: PhoneStream; value: ControlMessage }[] = [];
  const closed: { stream: PhoneStream; reason: string; closed: boolean; settled: boolean }[] = [];
  const bytes: { stream: PhoneStream; direction: "up" | "down"; bytes: number }[] = [];
  const stream = new PhoneStream("b".repeat(32), endpoint, {
    clock,
    resources,
    events: {
      onFirstFrame: (phone, pattern, message) => frames.push({ stream: phone, pattern, message }),
      onControl: (phone, value) => controls.push({ stream: phone, value }),
      onClosed: (phone, reason) => closed.push({ stream: phone, reason, closed: phone.closed, settled: phone.settled }),
      onBytes: (phone, direction, count) => bytes.push({ stream: phone, direction, bytes: count }),
    },
  });
  cleanup.push(async () => {
    for (const socket of server.clients) socket.terminate();
    stream.close("cleanup");
    clock.advance(1000);
    await stream.done;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  if (waitForOpen) {
    await once(server, "connection");
    await once(sockets[0]!, "message");
  }
  return { server, endpoint, sockets, requests, incoming, clock, resources, frames, controls, closed, bytes, stream };
}

/** Opens a raw relay that keeps its writable TCP half open after receiving FIN. @remarks A normal ws server answers the closing handshake too promptly to exercise a peer stuck in CLOSING. @sideEffects Opens a loopback server and PhoneStream; cleanup destroys every owned socket even after assertion failure. */
async function halfOpenFixture() {
  const sockets: Socket[] = [];
  const chunks: Buffer[] = [];
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.push(socket);
    let header = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk: Buffer) => {
      if (upgraded) {
        chunks.push(chunk);
        return;
      }
      header = Buffer.concat([header, chunk]);
      if (header.indexOf("\r\n\r\n") < 0) return;
      const key = /^Sec-WebSocket-Key: (.+)$/im.exec(header.toString("utf8"))?.[1]?.trim();
      if (key === undefined) throw new Error("missing websocket key");
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      upgraded = true;
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("unexpected socket address");
  const clock = new FakeClock(100);
  const resources = new ResourceTracker();
  const reasons: string[] = [];
  const stream = new PhoneStream(
    "b".repeat(32),
    {
      url: `ws://127.0.0.1:${address.port}`,
      hostId: "hst_0123456789abcdef",
      token: "a".repeat(43),
    },
    {
      clock,
      resources,
      events: {
        onFirstFrame: () => {},
        onControl: () => {},
        onBytes: () => {},
        onClosed: (_stream, reason) => reasons.push(reason),
      },
    },
  );
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    stream.close("cleanup");
    clock.advance(1000);
    await stream.done;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  return { sockets, chunks, stream, clock, resources, reasons };
}

/** Finishes a real Noise handshake for a phone and host. @remarks Direct framing tests use genuine cross-key ciphers rather than fake decryption. @sideEffects Reads cryptographic randomness. */
function transports() {
  const hostKey = generateKeyPair();
  const phoneKey = generateKeyPair();
  const binding = prologue("hst_0123456789abcdef");
  const phone = HandshakeState.initiator({
    pattern: "IK",
    prologue: binding,
    staticKey: phoneKey,
    remoteStatic: hostKey.publicKey,
  });
  const host = HandshakeState.responder({ pattern: "IK", prologue: binding, staticKey: hostKey });
  const first = phone.writeMessage(utf8('{"kind":"connect"}'));
  host.readMessage(first);
  const second = host.writeMessage(utf8('{"ok":true}'));
  phone.readMessage(second);
  return { first, second, phoneKey, phone: phone.finish(), host: host.finish() };
}

/** A list of about 114 KB that deflates well. */
const BIG = JSON.stringify(Array.from({ length: 3000 }, (_, index) => ({ sessionId: `s${index}`, archived: false })));

/**
 * What a stream sends for `BIG` then `"small"`, decrypted.
 *
 * @remarks
 * Waits for the last frame, the short one for `"small"`.
 *
 * @sideEffects Opens a stream over a local socket.
 * @param compress - Whether the phone asked for deflated messages.
 * @returns The plaintexts after the handshake reply.
 */
async function sent(compress: boolean): Promise<Uint8Array[]> {
  const f = await fixture();
  const pair = transports();
  f.stream.secure(pair.host, compress);
  f.stream.settle();
  f.stream.transport().send(BIG);
  f.stream.transport().send("small");
  await expect.poll(() => f.incoming.at(-1)?.bytes.length ?? 0).toBeLessThan(100);
  return f.incoming.slice(1).map((frame) => decryptTransport(pair.phone.receive, frame.bytes));
}

/** Waits for actual socket closure and checks the owner-facing result. @remarks Notification alone must not release the live socket resource. @sideEffects Waits for network close callbacks. */
async function expectClosed(f: Awaited<ReturnType<typeof fixture>>, reason: string) {
  await expect.poll(() => f.stream.closed).toBe(true);
  await f.stream.done;
  expect(f.closed).toStrictEqual([{ stream: f.stream, reason, closed: true, settled: false }]);
  expect(f.resources.snapshot()).toStrictEqual({ "remote.data": 0, timer: 0 });
  expect(f.clock.pendingTimers()).toBe(0);
}

describe("PhoneStream", () => {
  it("authenticates its own data socket without negotiating compression", async () => {
    const f = await fixture();
    expect(f.requests).toStrictEqual([{ url: "/v1/host/stream", extensions: undefined }]);
    expect(f.sockets[0]!.extensions).toBe("");
    expect(f.incoming).toStrictEqual([
      {
        binary: false,
        bytes: Buffer.from(
          JSON.stringify({
            v: 1,
            type: "hello",
            hostId: f.endpoint.hostId,
            token: f.endpoint.token,
            streamId: "b".repeat(32),
          }),
        ),
      },
    ]);
    expect(f.bytes).toStrictEqual([]);
    expect(f.stream.streamId).toBe("b".repeat(32));
    expect(f.stream.deviceId).toBeNull();
    expect(f.stream.closed).toBe(false);
    expect(f.stream.settled).toBe(false);
    expect(f.stream.remoteStatic).toBeNull();
    expect(f.stream.handshakeHash).toBeNull();
    expect(f.resources.snapshot()).toStrictEqual({ "remote.data": 1, timer: 1 });
  });

  it("carries a first frame and raw handshake reply then exposes authenticated metadata", async () => {
    const f = await fixture();
    const pair = transports();
    const first = firstFrame("IK", pair.first);
    f.sockets[0]!.send(first);
    await expect.poll(() => f.frames).toStrictEqual([{ stream: f.stream, pattern: "IK", message: pair.first }]);
    f.stream.sendRaw(pair.second);
    await expect.poll(() => f.incoming.length).toBe(2);
    expect(f.incoming[1]).toStrictEqual({ binary: true, bytes: Buffer.from(pair.second) });
    expect(f.bytes).toStrictEqual([
      { stream: f.stream, direction: "up", bytes: first.length },
      { stream: f.stream, direction: "down", bytes: pair.second.length },
    ]);
    f.stream.secure(pair.host);
    expect(f.stream.remoteStatic).toStrictEqual(pair.phoneKey.publicKey);
    expect(f.stream.handshakeHash).toStrictEqual(pair.phone.handshakeHash);
    expect(f.stream.settled).toBe(false);
    f.stream.settle();
    expect(f.stream.settled).toBe(true);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.data": 1, timer: 0 });
    f.clock.advance(HANDSHAKE_TIMEOUT_MS);
    expect(f.stream.closed).toBe(false);
    f.stream.close("finished");
    await expectClosed(f, "finished");
  });

  it.each([
    { label: "text", data: "hello", reason: "text_frame", counted: [] },
    { label: "short header", data: Buffer.from([0x41, 1]), reason: "bad_first_frame", counted: [2] },
    { label: "bad magic", data: Buffer.from([0x42, 1, 1]), reason: "bad_first_frame", counted: [3] },
    { label: "unknown version", data: Buffer.from([0x41, 2, 1]), reason: "unknown_version", counted: [3] },
    { label: "unknown mode", data: Buffer.from([0x41, 1, 3]), reason: "unknown_mode", counted: [3] },
  ])("closes malformed first frames: $label", async ({ data, reason, counted }) => {
    const f = await fixture();
    f.sockets[0]!.send(data);
    await expectClosed(f, reason);
    expect(f.frames).toStrictEqual([]);
    expect(f.controls).toStrictEqual([]);
    expect(f.bytes).toStrictEqual(counted.map((count) => ({ stream: f.stream, direction: "up", bytes: count })));
  });

  it("admits IKpsk2 framing once and rejects a second frame before security is established", async () => {
    const f = await fixture();
    const message = Uint8Array.of(1, 2, 3, 4);
    const frame = firstFrame("IKpsk2", message);
    f.sockets[0]!.send(frame);
    f.sockets[0]!.send(frame);
    await expectClosed(f, "unexpected_frame");
    expect(f.frames).toStrictEqual([{ stream: f.stream, pattern: "IKpsk2", message }]);
    expect(f.bytes).toStrictEqual([
      { stream: f.stream, direction: "up", bytes: frame.length },
      { stream: f.stream, direction: "up", bytes: frame.length },
    ]);
  });

  it("ignores an already queued binary frame after a text frame closes the stream", async () => {
    const f = await fixture();
    f.sockets[0]!.send("unexpected text");
    f.sockets[0]!.send(firstFrame("IK", Uint8Array.of(1, 2, 3)));
    await expectClosed(f, "text_frame");
    expect(f.frames).toStrictEqual([]);
    expect(f.bytes).toStrictEqual([]);
  });

  it("limits incoming WebSocket payloads even before the handshake", async () => {
    const f = await fixture();
    const peerClosed = once(f.sockets[0]!, "close");
    f.sockets[0]!.send(Buffer.alloc(70 * 1024 + 1));
    await expectClosed(f, "socket_closed");
    const [code] = await peerClosed;
    expect(code).toBe(1009);
    expect(f.frames).toStrictEqual([]);
    expect(f.bytes).toStrictEqual([]);
  });

  it("times out an unclaimed secure stream exactly at its handshake deadline", async () => {
    const f = await fixture();
    f.stream.secure(transports().host);
    f.clock.advance(HANDSHAKE_TIMEOUT_MS - 1);
    expect(f.stream.closed).toBe(false);
    expect(f.stream.settled).toBe(false);
    f.clock.advance(1);
    await expectClosed(f, "handshake_timeout");
  });

  it("does not send before open and closes a connecting socket without waiting for its handshake", async () => {
    const f = await fixture(false);
    f.stream.sendRaw(Uint8Array.of(1));
    f.stream.sendControl({ kind: "revoked" });
    f.stream.transport().send("not yet secure");
    expect(f.stream.transport().checkAlive()).toBe(true);
    expect(f.bytes).toStrictEqual([]);
    expect(f.stream.closed).toBe(false);
    f.stream.close("cancelled_while_connecting");
    await expectClosed(f, "cancelled_while_connecting");
    expect(f.incoming).toStrictEqual([]);
    const pair = transports();
    f.stream.secure(pair.host);
    f.stream.sendRaw(Uint8Array.of(2));
    expect(f.stream.remoteStatic).toBeNull();
    expect(f.stream.handshakeHash).toBeNull();
    expect(f.bytes).toStrictEqual([]);
  });

  it("notifies listeners once before done and force-closes an unresponsive peer after one second", async () => {
    const f = await fixture();
    f.sockets[0]!.pause();
    const transport = f.stream.transport();
    const notices: { code: number; closed: boolean }[] = [];
    transport.onClose((code) => notices.push({ code, closed: f.stream.closed }));
    let done = false;
    const completion = f.stream.done.then(() => {
      done = true;
      return done;
    });
    transport.close(4001, "requested_stop");
    expect(notices).toStrictEqual([{ code: 1000, closed: true }]);
    expect(f.closed).toStrictEqual([{ stream: f.stream, reason: "requested_stop", closed: true, settled: false }]);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.data": 1, timer: 1 });
    expect(done).toBe(false);
    f.stream.close("duplicate");
    transport.onClose((code) => notices.push({ code, closed: f.stream.closed }));
    expect(notices).toStrictEqual([
      { code: 1000, closed: true },
      { code: 1000, closed: true },
    ]);
    f.stream.sendRaw(Uint8Array.of(9));
    expect(f.bytes).toStrictEqual([]);
    f.clock.advance(999);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.data": 1, timer: 1 });
    expect(done).toBe(false);
    f.clock.advance(1);
    await expectClosed(f, "requested_stop");
    await completion;
    expect(done).toBe(true);
    expect(notices).toHaveLength(2);
  });

  it("bounds shutdown when the relay starts a WebSocket close but leaves TCP half open", async () => {
    const { sockets, chunks, stream, clock, resources, reasons } = await halfOpenFixture();
    await expect.poll(() => chunks.length).toBeGreaterThan(0);
    const peer = sockets[0]!;
    const fin = once(peer, "end");
    peer.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
    await fin;
    const reply = Buffer.concat(chunks).subarray(-8);
    expect(reply.subarray(0, 2)).toStrictEqual(Buffer.from([0x88, 0x82]));
    expect(Buffer.from([reply[6]! ^ reply[2]!, reply[7]! ^ reply[3]!])).toStrictEqual(Buffer.from([0x03, 0xe8]));
    expect(peer.readableEnded).toBe(true);
    expect(peer.writableEnded).toBe(false);
    expect(stream.closed).toBe(false);
    expect(resources.snapshot()).toStrictEqual({ "remote.data": 1, timer: 1 });
    let done = false;
    const completion = stream.done.then(() => {
      done = true;
      return done;
    });
    stream.close("host_shutdown");
    expect(reasons).toStrictEqual(["host_shutdown"]);
    clock.advance(999);
    expect(done).toBe(false);
    clock.advance(1);
    await expect
      .poll(() => ({ done, resources: resources.snapshot() }))
      .toStrictEqual({
        done: true,
        resources: { "remote.data": 0, timer: 0 },
      });
    expect(await completion).toBe(true);
    expect(resources.snapshot()).toStrictEqual({ "remote.data": 0, timer: 0 });
    expect(clock.pendingTimers()).toBe(0);
    expect(reasons).toStrictEqual(["host_shutdown"]);
  });

  it("uses graceful close code 1000 and releases the fallback timer when the peer answers", async () => {
    const f = await fixture();
    const peerClosed = once(f.sockets[0]!, "close");
    f.stream.close("owner_closed");
    await expectClosed(f, "owner_closed");
    const [code, reason] = await peerClosed;
    expect(code).toBe(1000);
    expect(reason).toStrictEqual(Buffer.alloc(0));
  });

  it("closes the actual socket on tampered ciphertext without delivering its payload", async () => {
    const f = await fixture();
    const pair = transports();
    f.stream.secure(pair.host);
    f.stream.settle();
    const ciphertext = encryptTransport(pair.phone.send, encodeControl({ kind: "pair_confirm" }));
    ciphertext[ciphertext.length - 1]! ^= 1;
    f.sockets[0]!.send(ciphertext);
    await expectClosed(f, "decrypt_failed");
    expect(f.frames).toStrictEqual([]);
    expect(f.controls).toStrictEqual([]);
    expect(f.bytes).toStrictEqual([{ stream: f.stream, direction: "up", bytes: ciphertext.length }]);
  });

  it.each([
    { label: "unknown frame type", plaintext: Uint8Array.of(5), reason: "unknown_frame_type" },
    { label: "malformed control", plaintext: Uint8Array.of(4, ...utf8('{"kind":42}')), reason: "bad_control" },
  ])("closes the actual socket when SecureChannel rejects $label", async ({ plaintext, reason }) => {
    const f = await fixture();
    const pair = transports();
    f.stream.secure(pair.host);
    f.stream.settle();
    const ciphertext = encryptTransport(pair.phone.send, plaintext);
    f.sockets[0]!.send(ciphertext);
    await expectClosed(f, reason);
    expect(f.frames).toStrictEqual([]);
    expect(f.controls).toStrictEqual([]);
    expect(f.bytes).toStrictEqual([{ stream: f.stream, direction: "up", bytes: ciphertext.length }]);
  });

  it("closes an incomplete encrypted message at thirty seconds and releases its tracked timer", async () => {
    const f = await fixture();
    const pair = transports();
    f.stream.secure(pair.host);
    f.stream.settle();
    const partial = encryptTransport(pair.phone.send, Uint8Array.of(1, 0x61));
    f.sockets[0]!.send(partial);
    await expect.poll(() => f.bytes).toStrictEqual([{ stream: f.stream, direction: "up", bytes: partial.length }]);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.data": 1, timer: 1 });
    f.clock.advance(CHUNK_TIMEOUT_MS - 1);
    expect(f.stream.closed).toBe(false);
    f.clock.advance(1);
    await expectClosed(f, "chunk_timeout");
  });

  it("routes decrypted messages and controls separately and sends encrypted replies", async () => {
    const f = await fixture();
    const pair = transports();
    f.stream.secure(pair.host);
    f.stream.settle();
    const messages: (string | null)[] = [];
    f.stream.transport().onMessage((text) => messages.push(text));
    const control = { kind: "pair_confirm" };
    const ciphertexts = [
      encryptTransport(pair.phone.send, encodeControl(control)),
      ...encodeMessage("hello from phone", PHONE_TO_HOST_LIMIT).map((frame) =>
        encryptTransport(pair.phone.send, frame),
      ),
    ];
    for (const frame of ciphertexts) f.sockets[0]!.send(frame);
    await expect.poll(() => messages).toStrictEqual(["hello from phone"]);
    expect(f.controls).toStrictEqual([{ stream: f.stream, value: control }]);
    expect(f.frames).toStrictEqual([]);
    const reply = { kind: "paired", deviceId: "dev_0123456789abcdef" };
    f.stream.sendControl(reply);
    f.stream.transport().send("hello from host");
    await expect.poll(() => f.incoming.length).toBe(3);
    expect(f.incoming.slice(1).map((frame) => frame.binary)).toStrictEqual([true, true]);
    expect(decryptTransport(pair.phone.receive, f.incoming[1]!.bytes)).toStrictEqual(encodeControl(reply));
    expect(decryptTransport(pair.phone.receive, f.incoming[2]!.bytes)).toStrictEqual(
      encodeMessage("hello from host", HOST_TO_PHONE_LIMIT)[0],
    );
    expect(f.bytes).toStrictEqual([
      ...ciphertexts.map((frame) => ({ stream: f.stream, direction: "up", bytes: frame.length })),
      { stream: f.stream, direction: "down", bytes: f.incoming[1]!.bytes.length },
      { stream: f.stream, direction: "down", bytes: f.incoming[2]!.bytes.length },
    ]);
  });

  it("deflates a large message for a phone that asked, and sends a small one as it is", async () => {
    const plaintexts = await sent(true);
    expect(plaintexts).toHaveLength(2);
    expect(plaintexts[0]![0]).toBe(0x05);
    expect(fromUtf8(inflateRawSync(plaintexts[0]!.subarray(1)))).toBe(BIG);
    expect(plaintexts[1]).toStrictEqual(encodeMessage("small", HOST_TO_PHONE_LIMIT)[0]);
  });

  it("sends everything as it is to a phone that did not ask", async () => {
    expect(await sent(false)).toStrictEqual([
      ...encodeMessage(BIG, HOST_TO_PHONE_LIMIT),
      ...encodeMessage("small", HOST_TO_PHONE_LIMIT),
    ]);
  });

  it("closes a message received before a client listener is installed", async () => {
    const f = await fixture();
    const pair = transports();
    f.stream.secure(pair.host);
    f.stream.settle();
    const frame = encryptTransport(pair.phone.send, encodeMessage("early", PHONE_TO_HOST_LIMIT)[0]!);
    f.sockets[0]!.send(frame);
    await expectClosed(f, "unexpected_message");
    expect(f.controls).toStrictEqual([]);
  });

  it("closes rather than transmitting an outbound message larger than the host limit", async () => {
    const f = await fixture();
    f.stream.secure(transports().host);
    f.stream.settle();
    expect(() => f.stream.transport().send("a".repeat(HOST_TO_PHONE_LIMIT + 1))).not.toThrow();
    await expectClosed(f, "message_too_large");
    expect(f.bytes).toStrictEqual([]);
    expect(f.incoming).toHaveLength(1);
  });

  it("refreshes heartbeat liveness only on inbound ciphertext and expires at the silence boundary", async () => {
    const f = await fixture();
    const pair = transports();
    f.stream.secure(pair.host);
    f.stream.settle();
    const transport = f.stream.transport();
    f.clock.advance(SILENCE_MS - 1);
    expect(transport.checkAlive()).toBe(true);
    await expect.poll(() => f.incoming.length).toBe(2);
    expect(decryptTransport(pair.phone.receive, f.incoming[1]!.bytes)).toStrictEqual(Uint8Array.of(2));
    const pong = encryptTransport(pair.phone.send, Uint8Array.of(3));
    f.sockets[0]!.send(pong);
    await expect.poll(() => f.bytes.at(-1)).toStrictEqual({ stream: f.stream, direction: "up", bytes: pong.length });
    f.clock.advance(SILENCE_MS - 1);
    expect(transport.checkAlive()).toBe(true);
    f.clock.advance(1);
    expect(transport.checkAlive()).toBe(false);
    await expectClosed(f, "heartbeat_timeout");
    expect(f.controls).toStrictEqual([]);
  });

  it("keeps a stalled phone's buffered amount independent of a healthy phone", async () => {
    const slow = await fixture();
    const healthy = await fixture();
    slow.stream.secure(transports().host);
    slow.stream.settle();
    const pair = transports();
    healthy.stream.secure(pair.host);
    healthy.stream.settle();
    slow.sockets[0]!.pause();
    const slowTransport = slow.stream.transport();
    const healthyTransport = healthy.stream.transport();
    expect(slowTransport.bufferedAmount).toBe(0);
    expect(healthyTransport.bufferedAmount).toBe(0);
    slowTransport.send("x".repeat(HOST_TO_PHONE_LIMIT));
    expect(slowTransport.bufferedAmount).toBeGreaterThan(0);
    expect(healthyTransport.bufferedAmount).toBe(0);
    healthyTransport.send("still responsive");
    await expect.poll(() => healthy.incoming.length).toBe(2);
    expect(decryptTransport(pair.phone.receive, healthy.incoming[1]!.bytes)).toStrictEqual(
      encodeMessage("still responsive", HOST_TO_PHONE_LIMIT)[0],
    );
    expect(slow.bytes.reduce((sum, frame) => sum + frame.bytes, 0)).toBe(
      HOST_TO_PHONE_LIMIT + Math.ceil(HOST_TO_PHONE_LIMIT / MAX_CHUNK) * 17,
    );
    expect(healthyTransport.bufferedAmount).toBe(0);
    slow.stream.close("slow_phone_closed");
    slow.clock.advance(1000);
    await expectClosed(slow, "slow_phone_closed");
    expect(healthy.stream.closed).toBe(false);
    expect(healthy.resources.snapshot()).toStrictEqual({ "remote.data": 1, timer: 0 });
    healthy.stream.close("finished");
    await expectClosed(healthy, "finished");
  });
});

describe("reasonOf", () => {
  it.each([null, undefined, "sensitive failure", 42, new Error("sensitive failure"), {}, { reason: 42 }])(
    "uses a stable fallback rather than exposing an untyped error: %j",
    (error) => expect(reasonOf(error)).toBe("handshake_failed"),
  );

  it("preserves a typed channel failure reason", () => {
    expect(reasonOf(new ChannelError("unknown_mode"))).toBe("unknown_mode");
  });
});
