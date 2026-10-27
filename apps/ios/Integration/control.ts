import assert from "node:assert/strict";
import { createServer } from "node:http";

/** The shared, test-only loopback control listener. */
export interface ControlServer {
  readonly origin: string;
  /** Closes requests and the listener. @remarks Idempotent teardown. @sideEffects Aborts pending controls. */
  close(): Promise<void>;
}

/**
 * Opens the existing authenticated HTTP side channel for either interop fixture.
 * @remarks Only host decisions use this endpoint; protocol traffic stays on real WebSockets.
 * @sideEffects Opens a loopback listener and tracks outstanding request handlers.
 * @param token - Ephemeral bearer credential, never logged.
 * @param handle - Fixture-specific decision, with cancellation for teardown.
 * @returns The bound origin and complete cleanup operation.
 */
export async function startControl(
  token: string,
  handle: (action: string, body: object, signal: AbortSignal) => Promise<Record<string, unknown> | undefined>,
): Promise<ControlServer> {
  const controller = new AbortController();
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const task = (async () => {
      if (request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(403).end();
        return;
      }
      let text = "";
      for await (const chunk of request) {
        text += String(chunk);
        assert.ok(text.length <= 4096, "control request too large");
      }
      const body: unknown = JSON.parse(text);
      assert.ok(typeof body === "object" && body !== null && !Array.isArray(body));
      const result = await handle(request.url ?? "", body, controller.signal);
      if (result === undefined) response.writeHead(404).end();
      else response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    })().catch(() => {
      if (!response.destroyed && !response.headersSent) response.writeHead(500).end();
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  server.requestTimeout = 10_000;
  let closing: Promise<void> | undefined;
  /**
   * Drains all controls even when their client was killed.
   * @remarks Cancelling event waits precedes awaiting request completion.
   * @sideEffects Aborts controls and closes every owned HTTP connection.
   * @returns When listener and handlers are closed.
   */
  function close(): Promise<void> {
    return (closing ??= (async () => {
      controller.abort();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        });
        server.closeAllConnections();
      });
      await Promise.all(pending);
      assert.equal(pending.size, 0, "control handlers leaked");
    })());
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    return { origin: `http://127.0.0.1:${address.port}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Bounds a fixture event wait and removes both timeout and cancellation listener.
 * @remarks Used for single-shot host events, never a repeated race against a process lifetime.
 * @sideEffects Registers and clears a five-second timer and optional abort listener.
 * @param promise - One expected event.
 * @param signal - Fixture or request shutdown.
 * @returns The event value.
 */
export async function bounded<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  /** Rejects the wait on teardown. @remarks No event may outlive its fixture. @sideEffects Settles a promise. */
  function abort(): void {
    cancelled.reject(new Error("local fixture interrupted"));
  }
  const timer = setTimeout(() => cancelled.reject(new Error("local fixture event timed out")), 5000);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([promise, cancelled.promise]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
