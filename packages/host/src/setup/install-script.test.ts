import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { systemClock } from "../platform/clock";
import { DownloadError, downloadScript } from "./install-script";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * A local HTTP server answering the paths the tests ask for.
 *
 * @remarks
 * `/install.sh` is the script; `/moved` sends there; `/away` sends to another server; `/loop` sends
 * to itself; `/missing` is not found; `/big` is over 1 MiB; `/slow` never answers.
 *
 * @sideEffects Listens on a port of 127.0.0.1, closed after the test.
 * @returns The server's address.
 */
async function scriptServer(): Promise<string> {
  const other = await listen(createServer((_request, response) => response.end("echo elsewhere\n")));
  const routes: Record<string, (response: ServerResponse) => void> = {
    "/install.sh": (response) => response.end("echo installed\n"),
    "/moved": (response) => response.writeHead(302, { location: "/install.sh" }).end(),
    "/away": (response) => response.writeHead(302, { location: `${other}/install.sh` }).end(),
    "/loop": (response) => response.writeHead(301, { location: "/loop" }).end(),
    "/big": (response) => response.end("#".repeat(1024 * 1024 + 1)),
    "/slow": () => undefined,
  };
  const server = createServer((request, response) => {
    const route = routes[request.url ?? ""] ?? ((missing: ServerResponse) => missing.writeHead(404).end());
    route(response);
  });
  return listen(server);
}

/**
 * Starts a server on a free port of 127.0.0.1.
 *
 * @remarks
 * Every server is closed after the test.
 *
 * @sideEffects Listens on a port.
 * @param server - The server.
 * @returns Its address.
 */
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/**
 * Downloads from the test server with a short time limit.
 *
 * @remarks
 * See {@link scriptServer} for the paths.
 *
 * @sideEffects Makes HTTP requests.
 * @param url - The address.
 * @param signal - Cancels the download.
 * @returns The script.
 */
function download(url: string, signal = new AbortController().signal): Promise<string> {
  return downloadScript(url, { signal, clock: systemClock, timeoutMs: 1000 });
}

describe("downloadScript", () => {
  it("downloads the script, following moves on the same server", async () => {
    const base = await scriptServer();

    expect(await download(`${base}/install.sh`)).toBe("echo installed\n");
    expect(await download(`${base}/moved`)).toBe("echo installed\n");
  });

  it.each([
    ["moves to another server", "/away", "redirect"],
    ["keeps moving", "/loop", "redirect"],
    ["is not there", "/missing", "status"],
    ["is over 1 MiB", "/big", "too_large"],
    ["takes too long", "/slow", "timeout"],
  ])("fails when the script %s", async (_case, path, reason) => {
    const base = await scriptServer();

    const failing = download(`${base}${path}`);

    await expect(failing).rejects.toBeInstanceOf(DownloadError);
    await expect(failing).rejects.toMatchObject({ reason });
  });

  it("fails when nothing answers", async () => {
    const closed = await listen(createServer());
    servers.pop()?.close();

    await expect(download(`${closed}/install.sh`)).rejects.toMatchObject({ reason: "network" });
  });

  it("stops when cancelled", async () => {
    const base = await scriptServer();
    const stop = new AbortController();

    const failing = download(`${base}/slow`, stop.signal);
    stop.abort();

    await expect(failing).rejects.toMatchObject({ reason: "aborted" });
  });
});
