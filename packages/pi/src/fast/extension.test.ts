import { type ModelListServer, startModelListServer } from "@atrium/testkit";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import atriumFast, { type FastApi } from "./extension";

/** A command's context, as pi gives it. */
type Context = Parameters<Parameters<FastApi["registerCommand"]>[1]["handler"]>[1];

/** What pi's model registry answers for credentials. */
type Auth = Awaited<ReturnType<Context["modelRegistry"]["getApiKeyAndHeaders"]>>;

/** The command and request hook the extension registered, as pi would keep them. */
interface Registered {
  readonly command: {
    readonly name: string;
    readonly description: string;
    run(args: string, ctx?: Context): Promise<void>;
  };
  /** pi's request hook, as pi calls it before each request. */
  request(payload: unknown, model?: { readonly provider: string; readonly id: string }): unknown;
}

/** A stand-in for pi's command context, and what the extension did with it. */
interface Stand {
  readonly ctx: Context;
  /** Each status the extension set, as key and text. */
  readonly statuses: (readonly [string, string | undefined])[];
  /** Each model it asked credentials for. */
  readonly asked: unknown[];
  /** How many times it looked at pi's models. */
  looked: number;
}

/** The model Fast is for. */
const GPT = { provider: "openai-codex", id: "gpt-5.5" };

/** A token with a ChatGPT account id, shaped as ChatGPT's access tokens are. */
const TOKEN = `head.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url")}.sig`;

const servers: ModelListServer[] = [];

afterEach(async () => {
  for (const running of servers.splice(0)) await running.close();
});

/**
 * Starts a stand-in for Codex's model list, closed after the test.
 *
 * @remarks
 * See {@link startModelListServer}.
 *
 * @sideEffects Listens on a port of 127.0.0.1.
 * @param answer - Writes the response; by default Codex's list as measured.
 * @returns The server.
 */
async function server(answer?: (response: ServerResponse) => void): Promise<ModelListServer> {
  const started = await startModelListServer(answer);
  servers.push(started);
  return started;
}

/**
 * A stand-in for pi's command context, with the given models and credentials.
 *
 * @remarks
 * Keeps what the extension did with it, so a test can check the credentials it asked for and the
 * status it set.
 *
 * @sideEffects none
 * @param models - The models pi has credentials for.
 * @param auth - What pi answers for credentials, or `"throws"` for a lookup that fails.
 * @returns The context and its record.
 */
function stand(
  models: readonly { provider: string; id: string; baseUrl: string }[] = [],
  auth?: Auth | "throws",
): Stand {
  const record: Stand = {
    statuses: [],
    asked: [],
    looked: 0,
    ctx: {
      ui: {
        setStatus: (key, text) => {
          record.statuses.push([key, text]);
        },
      },
      modelRegistry: {
        getAvailable: () => {
          record.looked += 1;
          return models;
        },
        getApiKeyAndHeaders: (model) => {
          record.asked.push(model);
          return auth === "throws"
            ? Promise.reject(new Error("pi failed"))
            : Promise.resolve(auth ?? { ok: true, apiKey: TOKEN });
        },
      },
    },
  };
  return record;
}

/**
 * Answers each request with the next of `answers`.
 *
 * @remarks
 * For a test whose list changes between asks.
 *
 * @sideEffects Uses up the answers.
 * @param answers - Each writes one response.
 * @returns The server's answer.
 * @throws {Error} When asked once too often.
 */
function inTurn(...answers: ((response: ServerResponse) => void)[]): (response: ServerResponse) => void {
  return (response) => {
    const answer = answers.shift();
    if (answer === undefined) throw new Error("asked once too often");
    answer(response);
  };
}

/**
 * A stand-in context with ChatGPT's login, its models at `baseUrl`.
 *
 * @remarks
 * Two models, so a test sees the extension take the first of ChatGPT's and leave the others.
 *
 * @sideEffects none
 * @param baseUrl - The models' base address.
 * @param auth - What pi answers for credentials, or `"throws"` for a lookup that fails.
 * @returns The context and its record.
 */
function codex(baseUrl: string, auth?: Auth | "throws"): Stand {
  return stand(
    [
      { provider: "anthropic", id: "claude-opus-5-5", baseUrl: "http://127.0.0.1:9/anthropic" },
      { provider: "openai-codex", id: "gpt-5.5", baseUrl },
      { provider: "openai-codex", id: "gpt-6", baseUrl: "http://127.0.0.1:9/other" },
    ],
    auth,
  );
}

/**
 * Loads the extension into a stand-in for pi's extension API.
 *
 * @remarks
 * The real pi loads it in `fast.pi.test.ts`; here each case runs without a process. A command run
 * without a context gets one with no models.
 *
 * @sideEffects none
 * @returns What it registered.
 * @throws {Error} When it registered no command or hook.
 */
function load(): Registered {
  let handler: Parameters<FastApi["registerCommand"]>[1]["handler"] | undefined;
  let name = "";
  let description = "";
  let hook: Parameters<FastApi["on"]>[1] | undefined;
  atriumFast({
    registerCommand: (registered, options) => {
      name = registered;
      description = options.description;
      handler = options.handler;
    },
    on: (event, registered) => {
      if (event === "before_provider_request") hook = registered;
      return () => undefined;
    },
  });
  if (handler === undefined || hook === undefined) throw new Error("the extension registered too little");
  const run = handler;
  const request = hook;
  return {
    command: { name, description, run: (args, ctx = stand().ctx) => run(args, ctx) },
    request: (payload, model) => request({ payload }, { model }),
  };
}

/**
 * Whether the extension asks the priority tier of each of ChatGPT's models now.
 *
 * @remarks
 * Shows which models it takes to have Fast.
 *
 * @sideEffects Calls the extension's request hook.
 * @param fast - The loaded extension.
 * @param ids - The models' ids.
 * @returns Each id, with whether its request asked for the priority tier.
 */
function priorities(fast: Registered, ids: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(ids.map((id) => [id, fast.request({}, { provider: "openai-codex", id }) !== undefined]));
}

describe("atriumFast", () => {
  // oxlint-disable-next-line vitest/expect-expect -- a type check: typecheck fails it, not the run.
  it("fits pi's extension API", () => {
    expectTypeOf<ExtensionAPI>().toExtend<FastApi>();
  });

  it("registers the host's switch as its only command", () => {
    const { command } = load();

    expect([command.name, command.description]).toStrictEqual([
      "atrium-fast",
      "Atrium's Fast switch, sent by Atrium's host",
    ]);
  });

  it("leaves requests as pi built them until switched on", () => {
    const fast = load();

    expect(fast.request({ model: "gpt-5.5" }, GPT)).toBeUndefined();
  });

  it("asks for the priority tier once on, on a copy of pi's request, and stops once off", async () => {
    const fast = load();
    const payload = { model: "gpt-5.5", service_tier: "auto" };

    await fast.command.run(" on ");
    const on = fast.request(payload, GPT);
    await fast.command.run("off");

    expect(on).toStrictEqual({ model: "gpt-5.5", service_tier: "priority" });
    expect(payload).toStrictEqual({ model: "gpt-5.5", service_tier: "auto" });
    expect(fast.request(payload, GPT)).toBeUndefined();
  });

  it("keeps its state on any other word", async () => {
    const fast = load();

    await fast.command.run("on");
    await fast.command.run("status");
    const stillOn = fast.request({}, GPT);
    await fast.command.run("off");
    await fast.command.run("ON");

    expect(stillOn).toStrictEqual({ service_tier: "priority" });
    expect(fast.request({}, GPT)).toBeUndefined();
  });

  it.each([
    ["a model without Fast", {}, { provider: "openai-codex", id: "gpt-5.3-codex" }],
    ["no model", {}, undefined],
    ["a body that is not an object", "text", GPT],
    ["no body", null, GPT],
    ["a list", [1], GPT],
  ])("leaves the request of %s alone while on", async (_case, payload, model) => {
    const fast = load();

    await fast.command.run("on");

    expect(fast.request(payload, model)).toBeUndefined();
  });

  it("reports Codex's model list, asked with pi's credentials next to where the model's requests go", async () => {
    const list = await server();
    const pi = codex(`${list.baseUrl}//`, {
      ok: true,
      apiKey: TOKEN,
      headers: { "x-pi": "kept", "x-dropped": null, originator: "other" },
    });

    await load().command.run("tiers", pi.ctx);

    expect(pi.statuses).toStrictEqual([
      [
        "atrium-fast",
        JSON.stringify({
          models: [
            { id: "gpt-6.1-sol", fast: { speed: 2, moreUsage: true } },
            { id: "gpt-6-sol", fast: { speed: 1.5, moreUsage: false } },
            { id: "gpt-5.5", fast: null },
          ],
        }),
      ],
    ]);
    expect(pi.asked).toStrictEqual([{ provider: "openai-codex", id: "gpt-5.5", baseUrl: `${list.baseUrl}//` }]);
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0]?.url).toBe("/backend-api/codex/models?client_version=99.0.0");
    expect(list.requests[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "chatgpt-account-id": "acct-1",
      originator: "pi",
      accept: "application/json",
      "x-pi": "kept",
    });
    expect(list.requests[0]?.headers).not.toHaveProperty("x-dropped");
  });

  it.each(["/codex", "/codex/responses", "/codex/responses/"])(
    "asks at the same place for a base address ending in %s",
    async (end) => {
      const list = await server();

      await load().command.run("tiers", codex(`${list.baseUrl}${end}`).ctx);

      expect(list.requests.map(({ url }) => url)).toStrictEqual(["/backend-api/codex/models?client_version=99.0.0"]);
    },
  );

  it("keeps a /codex that does not end the base address", async () => {
    const list = await server();

    await load().command.run("tiers", codex(`${list.baseUrl}/codex/v2`).ctx);

    expect(list.requests.map(({ url }) => url)).toStrictEqual([
      "/backend-api/codex/v2/codex/models?client_version=99.0.0",
    ]);
  });

  it("asks at the login's base address when pi gives one", async () => {
    const list = await server();

    await load().command.run(
      "tiers",
      codex("http://127.0.0.1:9/unused", { ok: true, apiKey: TOKEN, baseUrl: list.baseUrl }).ctx,
    );

    expect(list.requests).toHaveLength(1);
  });

  it.each([
    ["a token that is not a JWT", "plain-token"],
    ["a token without the claim", `a.${Buffer.from("{}").toString("base64url")}.b`],
    [
      "a token whose claim has no account",
      `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": {} })).toString("base64url")}.b`,
    ],
    [
      "a token whose claim is no object",
      `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": "x" })).toString("base64url")}.b`,
    ],
    [
      "a token whose account is no text",
      `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: 5 } })).toString("base64url")}.b`,
    ],
    ["a token whose claims are no object", `a.${Buffer.from("5").toString("base64url")}.b`],
  ])("asks without an account for %s", async (_case, apiKey) => {
    const list = await server();

    await load().command.run("tiers", codex(list.baseUrl, { ok: true, apiKey }).ctx);

    expect(list.requests[0]?.headers["authorization"]).toBe(`Bearer ${apiKey}`);
    expect(list.requests[0]?.headers).not.toHaveProperty("chatgpt-account-id");
  });

  it.each([
    [
      "without ChatGPT's login",
      stand([{ provider: "anthropic", id: "claude-opus-5-5", baseUrl: "http://127.0.0.1:9" }]),
    ],
    ["when pi has no credentials", codex("http://127.0.0.1:9", { ok: false })],
    ["when pi has no key", codex("http://127.0.0.1:9", { ok: true })],
    ["when pi's key is empty", codex("http://127.0.0.1:9", { ok: true, apiKey: "" })],
    ["when pi's lookup throws", codex("http://127.0.0.1:9", "throws")],
  ])("reports no login %s, asking nobody", async (_case, pi) => {
    await load().command.run("tiers", pi.ctx);

    expect(pi.statuses).toStrictEqual([["atrium-fast", '{"failure":"no_login"}']]);
  });

  it.each([
    [
      "an error status",
      (response: ServerResponse) => response.writeHead(401).end("Unauthorized token abc"),
      "http_401",
    ],
    ["a body that is not JSON", (response: ServerResponse) => response.writeHead(200).end("<html>"), "not_json"],
    [
      "JSON that is not the list",
      (response: ServerResponse) => response.writeHead(200).end('{"data":[]}'),
      "not_a_list",
    ],
    ["a dropped connection", (response: ServerResponse) => response.socket?.destroy(), "unreachable"],
  ])("reports a failure for %s, with nothing of the server's text", async (_case, answer, failure) => {
    const list = await server(answer);
    const pi = codex(list.baseUrl);

    await load().command.run("tiers", pi.ctx);

    expect(pi.statuses).toStrictEqual([["atrium-fast", JSON.stringify({ failure })]]);
  });

  it("asks Codex in the background at the first on, going by the built-in rule until it answers and by the list after", async () => {
    const held: ServerResponse[] = [];
    const list = await server((response) => held.push(response));
    const pi = codex(list.baseUrl);
    const fast = load();
    const ids = ["gpt-6.1-sol", "gpt-5.5", "gpt-6", "gpt-5.4"];

    await fast.command.run("on", pi.ctx);
    const before = priorities(fast, ids);
    const reported = fast.command.run("tiers", pi.ctx);
    await vi.waitFor(() => {
      expect(held).toHaveLength(1);
    });
    held[0]?.writeHead(200).end(
      JSON.stringify({
        models: [
          { slug: "gpt-6.1-sol", service_tiers: [{ id: "priority" }] },
          { slug: "gpt-5.5", service_tiers: [] },
          { slug: "gpt-5.4", service_tiers: [{ id: "priority" }] },
        ],
      }),
    );
    await reported;

    expect(before).toStrictEqual({ "gpt-6.1-sol": true, "gpt-5.5": true, "gpt-6": true, "gpt-5.4": false });
    expect(priorities(fast, ids)).toStrictEqual({
      "gpt-6.1-sol": true,
      "gpt-5.5": false,
      "gpt-6": true,
      "gpt-5.4": true,
    });
    expect(list.requests).toHaveLength(1);
    expect(pi.looked).toBe(1);
  });

  it("asks no more at a later on once it has the list, and keeps the list when a later ask fails", async () => {
    const list = await server(
      inTurn(
        (response) => response.writeHead(200).end(JSON.stringify({ models: [{ slug: "gpt-5.5", service_tiers: [] }] })),
        (response) => response.writeHead(500).end(),
      ),
    );
    const pi = codex(list.baseUrl);
    const fast = load();

    await fast.command.run("tiers", pi.ctx);
    await fast.command.run("on", pi.ctx);
    await fast.command.run("off", pi.ctx);
    await fast.command.run("on", pi.ctx);
    const looked = pi.looked;
    await fast.command.run("tiers", pi.ctx);

    expect(looked).toBe(1);
    expect(pi.statuses.at(-1)).toStrictEqual(["atrium-fast", '{"failure":"http_500"}']);
    expect(priorities(fast, ["gpt-5.5", "gpt-6"])).toStrictEqual({ "gpt-5.5": false, "gpt-6": true });
  });
});
