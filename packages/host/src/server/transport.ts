/**
 * One client's way to and from the host, after any checks of its own: the local WebSocket or a
 * phone's Noise channel (SPEC-0005, "客户端传输").
 *
 * @remarks
 * Everything after the handshake (routing, subscriptions, sync) is shared and sees only this.
 * What only one side has stays with it: the local path keeps its `Origin` check, connection and
 * rate limits at the upgrade; the channel keeps its handshake, framing and heartbeats.
 */
export interface ClientTransport {
  /** Bytes queued for sending that the peer has not taken yet. */
  readonly bufferedAmount: number;
  /** Sends one encoded message. */
  send(text: string): void;
  /** Closes the transport with a protocol close code; the remote one cannot pass the code on. */
  close(code: number, reason: string): void;
  /** Called for each message: its text, or `null` for one that is not text (a binary frame). */
  onMessage(listener: (text: string | null) => void): void;
  /** Called once when the transport has closed, however it closed. */
  onClose(listener: (code: number) => void): void;
  /**
   * Probes the peer, or drops it when the previous probe went unanswered.
   *
   * @returns `false` when it dropped the peer; `true` when it sent a new probe.
   */
  checkAlive(): boolean;
}

/** Who a transport belongs to; only the transport's own code says so, never the client. */
export type TransportOrigin =
  | { readonly origin: "local" }
  /** A paired phone, known by the key its channel was authenticated with. */
  | { readonly origin: "remote"; readonly deviceId: string };
