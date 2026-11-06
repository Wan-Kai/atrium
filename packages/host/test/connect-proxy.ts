import { once } from "node:events";
import { type Socket, connect, createServer } from "node:net";

/** A running HTTP `CONNECT` proxy on this machine, and what it was asked to reach. */
export interface ConnectProxy {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Each tunnel's target, as `host:port`, in the order asked. */
  readonly targets: string[];
  /** Stops listening and drops every tunnel. */
  readonly close: () => Promise<void>;
}

/**
 * Starts a minimal HTTP proxy that only tunnels `CONNECT`, as the user's local proxy does.
 *
 * @remarks
 * Real sockets, so a test sees the host's connections really go through a proxy (testing.md:
 * real over fake). Anything but `CONNECT` is answered 405.
 *
 * @sideEffects Listens on a loopback port; opens a connection per tunnel.
 * @returns The proxy.
 */
export async function startConnectProxy(): Promise<ConnectProxy> {
  const targets: string[] = [];
  const sockets = new Set<Socket>();
  /**
   * Remembers a socket until it closes.
   *
   * @remarks
   * So `close` can drop the tunnels that are still open.
   *
   * @sideEffects Adds to the set; removes on close.
   * @param socket - The socket.
   */
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const server = createServer((client) => {
    track(client);
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    /**
     * Reads the request head, then opens the tunnel.
     *
     * @remarks
     * Bytes after the head belong to the tunnel and are passed on.
     *
     * @sideEffects Connects to the target; pipes both ways.
     * @param chunk - What came.
     */
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", onData);
      const match = /^CONNECT (\S+):(\d+) HTTP\/1\.[01]\r\n/u.exec(head.subarray(0, end).toString("latin1"));
      if (match === null) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return;
      }
      const [, host = "", port = ""] = match;
      targets.push(`${host}:${port}`);
      const upstream = connect(Number(port), host);
      track(upstream);
      upstream.on("error", () => client.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = head.subarray(end + 4);
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };
    client.on("data", onData);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("unexpected socket address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    targets,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
