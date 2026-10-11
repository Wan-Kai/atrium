import { z } from "zod";

/**
 * WebSocket close codes the host uses when it refuses a connection after the upgrade.
 *
 * @remarks
 * Clients map these to user-visible states (for example "token rejected"), so they are part of
 * the protocol rather than host internals. Origin checks fail earlier, at the HTTP upgrade.
 */
export const CloseCode = {
  /** The first message was not a valid `hello`. */
  BadHandshake: 4400,
  /** The token in `hello` did not match. */
  Unauthorized: 4401,
  /** No `hello` arrived within the handshake timeout. */
  HandshakeTimeout: 4408,
  /** The client speaks a different protocol version. */
  VersionMismatch: 4426,
  /** The client sent more messages or bytes per second than the host allows (security.md). */
  RateLimited: 4429,
  /** The client reads so slowly that more than the allowed amount waits to be sent to it. */
  SlowConsumer: 4507,
  /** The host already has as many connections as it accepts. */
  TooManyConnections: 4503,
} as const;

/** First message a client must send after the socket opens. */
export const HelloMessage = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
  clientId: z.string().min(1).max(128),
  token: z.string().min(1).max(512),
  traceparent: z.string().max(64),
});
export type HelloMessage = z.infer<typeof HelloMessage>;

/** Host's reply once the client is authenticated. */
export const WelcomeMessage = z.object({
  type: z.literal("welcome"),
  protocolVersion: z.number().int().positive(),
  hostVersion: z.string(),
  /** Random per host start, and the `generation` of list sync: a new value means the host restarted. */
  hostInstanceId: z.string().min(1).max(64),
  /** How often the client pings, and how long it waits for the answer (SPEC-0001, "握手与心跳"). */
  heartbeatMs: z.number().int().positive(),
  /** The seed of this install's dot pattern, from the install id (SPEC-0001, "首次启动 · 接口"). */
  installSeed: z.number().int().positive(),
  /** The folder of the host's logs, for "在访达中显示" (SPEC-0001, "设置 · 接口"). */
  logDir: z.string().min(1).max(4096),
});
export type WelcomeMessage = z.infer<typeof WelcomeMessage>;
