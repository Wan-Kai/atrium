import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type IncomingHttpHeaders, type ServerResponse, createServer } from "node:http";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import atrium from "../extension/atrium";
import atriumSearch, { type SearchApi, searchKey } from "./extension";
import { FETCH_TEXT_LIMIT } from "./search";

/** A tool, as the extension registered it. */
type Tool = Parameters<SearchApi["registerTool"]>[0];

/** A request the stand-in for DeepSeek received. */
interface Received {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

/** A running stand-in for DeepSeek's API. */
interface Stand {
  readonly base: string;
  readonly received: Received[];
}

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of closers.splice(0)) await close();
});

/**
 * Starts a local server standing in for DeepSeek's Search and Fetch APIs.
 *
 * @remarks
 * Tests never reach the real network (testing.md).
 *
 * @sideEffects Listens on a port of 127.0.0.1 until the test ends.
 * @param write - Writes the response to a request.
 * @returns The server's address and what it received.
 * @throws {Error} When the server has no port.
 */
async function deepseek(write: (response: ServerResponse, request: Received) => void): Promise<Stand> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const seen: Received = {
        url: request.url ?? "",
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      };
      received.push(seen);
      write(response, seen);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the server has no port");
  return { base: `http://127.0.0.1:${String(address.port)}`, received };
}

/**
 * Answers with `body` as JSON.
 *
 * @sideEffects none
 * @param body - The answer.
 * @param status - The status.
 * @returns The writer.
 */
function json(body: unknown, status = 200): (response: ServerResponse) => void {
  return (response) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** A tool's context, as pi gives it. */
type Context = Parameters<Tool["execute"]>[4];

/**
 * A stand-in for a tool's context: pi's model registry with, perhaps, a `deepseek` credential.
 *
 * @sideEffects none
 * @param deepseek - The credential's chat key and `env` object, `"fails"` when pi cannot answer for it, or `null` for no DeepSeek model.
 * @returns The context.
 */
function stand(
  account: { readonly chat: string; readonly env?: Record<string, string> } | "fails" | null = null,
): Context {
  return {
    modelRegistry: {
      getAvailable: () =>
        account === null
          ? [{ provider: "anthropic", id: "claude-opus-5-5", baseUrl: "http://127.0.0.1:9" }]
          : [{ provider: "deepseek", id: "deepseek-flash", baseUrl: "http://127.0.0.1:9/chat" }],
      getApiKeyAndHeaders: () =>
        account === null || account === "fails"
          ? Promise.reject(new Error("pi failed"))
          : Promise.resolve({
              ok: true,
              apiKey: account.chat,
              headers: { "x-pi": "1" },
              ...(account.env === undefined ? {} : { env: account.env }),
            }),
      isUsingOAuth: () => false,
    },
  };
}

/**
 * Loads the extension into a stand-in for pi and returns its tools.
 *
 * @sideEffects none
 * @param base - Where DeepSeek's APIs are, for the test.
 * @param key - The search key the process environment gives, or `null` for none.
 * @returns The tools by name.
 */
function load(base: string, key: string | null = "k"): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  atriumSearch(
    { registerTool: (tool) => tools.set(tool.name, tool) },
    {
      search: `${base}/search`,
      fetch: `${base}/fetch`,
      environment: key === null ? { DEEPSEEK_API_KEY: "sk-chat" } : { DEEPSEEK_SEARCH_API_KEY: key },
    },
  );
  return tools;
}

/**
 * Calls a tool as pi would.
 *
 * @sideEffects As the tool's.
 * @param tools - The tools.
 * @param name - Which.
 * @param params - What the model gave.
 * @param signal - The signal.
 * @param ctx - The context.
 * @returns The result.
 * @throws {Error} When there is no such tool.
 */
function call(
  tools: Map<string, Tool>,
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  ctx: Context = stand(),
) {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.execute("c1", params, signal, undefined, ctx);
}

/** The first text a result gives the model. */
function textOf(result: Awaited<ReturnType<typeof call>>): string {
  return result.content[0]?.text ?? "";
}

const ANSWER = {
  results: [
    {
      rerank_score: 2.4,
      title: "DeepSeek V4 released",
      url: "https://example.com/v4",
      snippet: "short",
      summary: "The long summary.",
      content: "",
      site_name: "Example News",
      date: "2026-06-01T00:00:00+00:00",
    },
    {
      title: "No site",
      url: "https://example.org/x",
      summary: "",
      snippet: "only the snippet",
      site_name: null,
      date: null,
    },
    { title: "", url: "https://dropped.example" },
    "not an object",
  ],
};

describe("atriumSearch", () => {
  // oxlint-disable-next-line vitest/expect-expect -- a type check: typecheck fails it, not the run.
  it("fits pi's extension API, alone and with the rest of Atrium's", () => {
    expectTypeOf<ExtensionAPI>().toExtend<SearchApi>();
    expectTypeOf<ExtensionAPI>().toExtend<Parameters<typeof atrium>[0]>();
  });

  it("registers web_search and web_fetch with schemas that require their one argument", () => {
    const tools = load("http://127.0.0.1:9");

    expect([...tools.keys()]).toStrictEqual(["web_search", "web_fetch"]);
    expect(tools.get("web_search")?.parameters).toMatchObject({ required: ["query"], additionalProperties: false });
    expect(tools.get("web_fetch")?.parameters).toMatchObject({ required: ["url"], additionalProperties: false });
    expect(tools.get("web_search")?.description).toContain("not from the user");
    expect(tools.get("web_fetch")?.description).toContain("not from the user");
  });

  it("searches with the search key, and gives the model the summaries", async () => {
    const server = await deepseek(json(ANSWER));
    const tools = load(server.base, "sk-test-key");

    const result = await call(tools, "web_search", { query: "DeepSeek V4 site:github.com", count: 3 });

    expect(server.received).toHaveLength(1);
    expect(server.received[0]?.url).toBe("/search");
    expect(server.received[0]?.body).toStrictEqual({ query: "DeepSeek V4 site:github.com", count: 3 });
    expect(server.received[0]?.headers).toMatchObject({
      authorization: "Bearer sk-test-key",
      "content-type": "application/json",
    });
    expect(server.received[0]?.headers["x-pi"]).toBeUndefined();
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(
      [
        'Web search results for "DeepSeek V4 site:github.com" (2):',
        "",
        "1. DeepSeek V4 released",
        "https://example.com/v4",
        "Example News · 2026-06-01",
        "The long summary.",
        "",
        "2. No site",
        "https://example.org/x",
        "only the snippet",
      ].join("\n"),
    );
    expect(result.details).toStrictEqual({
      query: "DeepSeek V4 site:github.com",
      results: [
        {
          title: "DeepSeek V4 released",
          url: "https://example.com/v4",
          site: "Example News",
          date: "2026-06-01T00:00:00+00:00",
        },
        { title: "No site", url: "https://example.org/x", site: null, date: null },
      ],
    });
  });

  it("leaves count out of the request when the model gave none", async () => {
    const server = await deepseek(json({ results: [] }));

    const result = await call(load(server.base, "k"), "web_search", { query: "nothing" });

    expect(server.received[0]?.body).toStrictEqual({ query: "nothing" });
    expect(textOf(result)).toBe('No results for "nothing".');
    expect(result.isError).toBeUndefined();
  });

  it("fetches a page and gives the model its title and Markdown", async () => {
    const server = await deepseek(json({ title: "Example", content: "Body text." }));

    const result = await call(load(server.base, "sk-test-key"), "web_fetch", { url: "https://example.com/a?b=1" });

    expect(server.received[0]?.url).toBe("/fetch");
    expect(server.received[0]?.body).toStrictEqual({ url: "https://example.com/a?b=1" });
    expect(server.received[0]?.headers.authorization).toBe("Bearer sk-test-key");
    expect(textOf(result)).toBe("# Example\n\nBody text.");
    expect(result.details).toStrictEqual({ url: "https://example.com/a?b=1", title: "Example", characters: 10 });
  });

  it("cuts a long page and says how much was left out", async () => {
    const server = await deepseek(json({ title: "", content: "a".repeat(FETCH_TEXT_LIMIT + 7) }));

    const text = textOf(await call(load(server.base, "k"), "web_fetch", { url: "https://example.com" }));

    expect(text).toBe(`${"a".repeat(FETCH_TEXT_LIMIT)}\n\n[Cut: 7 more characters of this page were left out.]`);
  });

  it("does not cut a surrogate pair in half", async () => {
    const content = `${"a".repeat(FETCH_TEXT_LIMIT - 1)}😀tail`;
    const server = await deepseek(json({ title: "", content }));

    const text = textOf(await call(load(server.base, "k"), "web_fetch", { url: "https://example.com" }));

    expect(text).toBe(`${"a".repeat(FETCH_TEXT_LIMIT - 1)}\n\n[Cut: 6 more characters of this page were left out.]`);
  });

  it.each([
    "ftp://example.com/file",
    "https://user:pass@example.com/",
    "not an address",
    `https://example.com/${"a".repeat(8200)}`,
  ])("refuses the address %# before any request", async (url) => {
    const server = await deepseek(json({ title: "", content: "x" }));

    const result = await call(load(server.base, "k"), "web_fetch", { url });

    expect(result.isError).toBe(true);
    expect(result.details).toStrictEqual({ error: "bad_url" });
    expect(server.received).toStrictEqual([]);
  });

  it("refuses a blank or missing query and a missing address before any request", async () => {
    const server = await deepseek(json({ results: [] }));
    const tools = load(server.base);

    const blank = await call(tools, "web_search", { query: "  " });
    const missing = await call(tools, "web_search", {});
    const noUrl = await call(tools, "web_fetch", {});

    expect([blank.details, missing.details, noUrl.details]).toStrictEqual([
      { error: "http_400" },
      { error: "http_400" },
      { error: "bad_url" },
    ]);
    expect(server.received).toStrictEqual([]);
  });

  it("tells the model there is no key, without any request, when there is no search key", async () => {
    const server = await deepseek(json({ results: [] }));
    const tools = load(server.base, null);

    const search = await call(tools, "web_search", { query: "x" });
    const page = await call(tools, "web_fetch", { url: "https://example.com" });

    expect([search.details, page.details]).toStrictEqual([{ error: "no_key" }, { error: "no_key" }]);
    expect(textOf(search)).toContain("DEEPSEEK_SEARCH_API_KEY");
    expect(search.isError).toBe(true);
    expect(server.received).toStrictEqual([]);
  });

  it("reports a failed status as a code and never repeats the server's words, which echo the key", async () => {
    const server = await deepseek(
      json({ error: { message: "Authentication Fails, Your api key: sk-secret-echo is invalid" } }, 401),
    );
    const tools = load(server.base, "sk-secret-echo");

    const result = await call(tools, "web_search", { query: "x" });

    expect(result.details).toStrictEqual({ error: "http_401" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sk-secret-echo");
  });

  it.each([
    [402, "no balance"],
    [403, "cannot be fetched"],
    [404, "cannot be fetched"],
    [429, "too many requests"],
    [400, "not accepted"],
    [500, "did not answer usefully"],
    [504, "did not answer usefully"],
  ])("words HTTP %i for the model (%s)", async (status, words) => {
    const server = await deepseek(json({ error: { message: "server words" } }, status));

    const result = await call(load(server.base, "k"), "web_fetch", { url: "https://example.com" });

    expect(result.details).toStrictEqual({ error: `http_${String(status)}` });
    expect(textOf(result)).toContain(words);
    expect(textOf(result)).not.toContain("server words");
  });

  it("reports an answer that is not JSON and one that is not a search or fetch answer", async () => {
    const notJson = await deepseek((response) => response.writeHead(200).end("<html>"));
    const wrong = await deepseek(json({ unexpected: true }));

    const a = await call(load(notJson.base, "k"), "web_search", { query: "x" });
    const b = await call(load(wrong.base, "k"), "web_search", { query: "x" });
    const c = await call(load(wrong.base, "k"), "web_fetch", { url: "https://example.com" });

    expect([a.details, b.details, c.details]).toStrictEqual([
      { error: "not_json" },
      { error: "unknown_shape" },
      { error: "unknown_shape" },
    ]);
  });

  it("reports unreachable when nothing listens, and does not follow a redirect with the key", async () => {
    const target = await deepseek(json({ results: [] }));
    const redirecting = await deepseek((response) =>
      response.writeHead(307, { location: `${target.base}/search` }).end(),
    );

    const refused = await call(load("http://127.0.0.1:9", "k"), "web_search", { query: "x" });
    const redirected = await call(load(redirecting.base, "k"), "web_search", { query: "x" });

    expect(refused.details).toStrictEqual({ error: "unreachable" });
    expect(redirected.details).toStrictEqual({ error: "unreachable" });
    expect(target.received).toStrictEqual([]);
  });

  it("ends as aborted when the tool's signal fires while the server is still thinking", async () => {
    const server = await deepseek(() => undefined);
    const controller = new AbortController();

    const pending = call(load(server.base), "web_search", { query: "x" }, controller.signal);
    await expect.poll(() => server.received.length).toBe(1);
    controller.abort();
    const result = await pending;

    expect(result.details).toStrictEqual({ error: "aborted" });
    expect(textOf(result)).toContain("stopped");
  });

  it("uses the search key in the env of pi's deepseek credential, over the process environment, and never the chat key", async () => {
    const server = await deepseek(json({ results: [] }));
    const tools = load(server.base, "sk-from-process");
    const query = { query: "x" };

    await call(
      tools,
      "web_search",
      query,
      undefined,
      stand({ chat: "sk-chat", env: { DEEPSEEK_SEARCH_API_KEY: " sk-stored " } }),
    );
    await call(tools, "web_search", query, undefined, stand({ chat: "sk-chat", env: { OTHER: "y" } }));
    await call(tools, "web_search", query, undefined, stand({ chat: "sk-chat" }));
    await call(tools, "web_search", query, undefined, stand("fails"));

    expect(server.received.map((seen) => seen.headers.authorization)).toStrictEqual([
      "Bearer sk-stored",
      "Bearer sk-from-process",
      "Bearer sk-from-process",
      "Bearer sk-from-process",
    ]);
  });

  it("has no key from the chat credential alone, whatever the process environment's chat key is", async () => {
    const server = await deepseek(json({ results: [] }));

    const result = await call(
      load(server.base, null),
      "web_search",
      { query: "x" },
      undefined,
      stand({ chat: "sk-chat" }),
    );

    expect(result.details).toStrictEqual({ error: "no_key" });
    expect(server.received).toStrictEqual([]);
  });
});

describe("searchKey", () => {
  it.each([
    [
      "the credential's env first",
      stand({ chat: "c", env: { DEEPSEEK_SEARCH_API_KEY: "stored" } }),
      { DEEPSEEK_SEARCH_API_KEY: "proc" },
      "stored",
    ],
    ["the process environment without a credential", stand(), { DEEPSEEK_SEARCH_API_KEY: "  proc \n" }, "proc"],
    [
      "the process environment when the credential's env is blank",
      stand({ chat: "c", env: { DEEPSEEK_SEARCH_API_KEY: "  " } }),
      { DEEPSEEK_SEARCH_API_KEY: "proc" },
      "proc",
    ],
    [
      "nothing for blank everywhere",
      stand({ chat: "c", env: { DEEPSEEK_SEARCH_API_KEY: "" } }),
      { DEEPSEEK_SEARCH_API_KEY: "   " },
      undefined,
    ],
    ["nothing when only the chat key is set", stand({ chat: "c" }), { DEEPSEEK_API_KEY: "sk-chat" }, undefined],
  ])("reads %s", async (_name, ctx, environment, expected) => {
    expect(await searchKey(ctx.modelRegistry, environment)).toBe(expected);
  });
});
