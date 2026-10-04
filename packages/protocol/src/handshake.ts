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
});
export type WelcomeMessage = z.infer<typeof WelcomeMessage>;
