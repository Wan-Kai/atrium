import { readFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";

/** A local HTTP server started by a test. */
export interface TestServer {
  readonly url: string;
  /** Number of requests received so far. */
  readonly requests: () => number;
  readonly close: () => Promise<void>;
}

/**
 * Starts a loopback HTTP server that answers every request with a tiny page and counts requests.
 *
 * @remarks
 * Navigation tests point the page at this server instead of a public site, so "the page never
 * left" can be proven by the server never seeing a request.
 *
 * @sideEffects Listens on a free loopback port.
 * @returns The server.
 */
export function startCountingServer(): Promise<TestServer> {
  let count = 0;
  return listen(
    createServer((_request, response) => {
      count += 1;
      response.end("<!doctype html><title>elsewhere</title>");
    }),
    () => count,
  );
}

/**
 * Starts a loopback HTTP server that serves a built UI directory with no security headers.
 *
 * @remarks
 * Stands in for the Vite dev server: like Vite, it sends no CSP, so a test can check that the
 * desktop app adds one to development pages.
 *
 * @sideEffects Listens on a free loopback port; reads files from `root`.
 * @param root - Built UI directory.
 * @returns The server.
 */
export function startStaticServer(root: string): Promise<TestServer> {
  let count = 0;
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  return listen(
    createServer((request, response) => {
      count += 1;
      const path = new URL(request.url ?? "/", "http://host.invalid").pathname;
      const file = join(root, path === "/" ? "index.html" : path);
      readFile(file).then(
        (body) => response.writeHead(200, { "Content-Type": types[extname(file)] ?? "text/plain" }).end(body),
        () => response.writeHead(404).end(),
      );
    }),
    () => count,
  );
}

/**
 * Binds a server to a free loopback port.
 *
 * @remarks
 * Shared by both test servers.
 *
 * @sideEffects Listens on a port.
 * @param server - Server to bind.
 * @param requests - Reads the request count.
 * @returns The running server.
 */
function listen(server: Server, requests: () => number): Promise<TestServer> {
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      done({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((closed) => server.close(() => closed())),
      });
    });
  });
}
