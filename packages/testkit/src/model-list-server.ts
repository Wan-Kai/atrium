import { type IncomingHttpHeaders, type ServerResponse, createServer } from "node:http";

/** A request the stand-in received: its path with query, and its headers. */
export interface ListRequest {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

/** A running stand-in for Codex's model list. */
export interface ModelListServer {
  /** The base address to give a model, as pi's `openai-codex` models have `https://chatgpt.com/backend-api`. */
  readonly baseUrl: string;
  /** Every request so far. */
  readonly requests: ListRequest[];
  /** Stops listening and drops open connections. */
  close(): Promise<void>;
}

/** Codex's model list as measured on 2026-10-12, cut to three models (pi-internals.md §5). */
export const CODEX_MODEL_LIST = {
  models: [
    {
      slug: "gpt-6.1-sol",
      visibility: "list",
      service_tiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }],
    },
    {
      slug: "gpt-6-sol",
      visibility: "list",
      service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
    },
    { slug: "gpt-5.5", visibility: "list", service_tiers: [] },
  ],
};

/**
 * Starts a local server standing in for Codex's model list.
 *
 * @remarks
 * Tests never reach the real network (testing.md); this answers on 127.0.0.1, every request the
 * same way, and records what it was asked. The extension's unit and contract tests and the
 * end-to-end test share it.
 *
 * @sideEffects Listens on a port of 127.0.0.1 until closed.
 * @param answer - Writes the response; by default Codex's list as measured.
 * @returns The running server.
 * @throws {Error} When the server has no port.
 */
export async function startModelListServer(
  answer: (response: ServerResponse) => void = (response) => {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(CODEX_MODEL_LIST));
  },
): Promise<ModelListServer> {
  const requests: ListRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", headers: request.headers });
    answer(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the model list server has no port");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/backend-api`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
