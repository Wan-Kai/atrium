import { type ModelListServer, startModelListServer } from "@atrium/testkit";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import atrium from "../extension/atrium";
import atriumPlan, { GROK_USAGE_URL, type PlanApi } from "./extension";

/** A command's context, as pi gives it. */
type Context = Parameters<Parameters<PlanApi["registerCommand"]>[1]["handler"]>[1];

/** What pi's model registry answers for credentials. */
type Auth = Awaited<ReturnType<Context["modelRegistry"]["getApiKeyAndHeaders"]>>;

/** A token with a ChatGPT account id, shaped as ChatGPT's access tokens are. */
const TOKEN = `head.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url")}.sig`;

/** ChatGPT's answer to `wham/usage` (ADR-0010). */
const CODEX_ANSWER = {
  plan_type: "pro",
  rate_limit: {
    primary_window: { used_percent: 39, limit_window_seconds: 18_000, reset_at: 1_782_770_922 },
    secondary_window: { used_percent: 52, limit_window_seconds: 604_800, reset_at: 1_783_357_722 },
  },
};

/** Grok's answer to `v1/billing?format=credits`, cut down (ADR-0011). */
const GROK_ANSWER = {
  config: {
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-12T09:56:20Z", end: "2026-10-19T09:56:20Z" },
    creditUsagePercent: 34,
    productUsage: [{ product: "GrokBuild", usagePercent: 33 }],
  },
};

/** Claude's answer to `api/oauth/usage`, the older shape (ADR-0010). */
const CLAUDE_ANSWER = { five_hour: { utilization: 84, resets_at: "2026-10-15T10:00:00Z" }, seven_day: null };

const servers: ModelListServer[] = [];

afterEach(async () => {
  for (const running of servers.splice(0)) await running.close();
});

/**
 * Starts a local stand-in for a provider's usage, answering every request as `write` does.
 *
 * @remarks
 * Tests never reach the real network (testing.md); the model list's stand-in answers any path.
 *
 * @sideEffects Listens on a port of 127.0.0.1 until the test ends.
 * @param write - Writes the response.
 * @returns The server.
 */
async function usageServer(write: (response: ServerResponse) => void): Promise<ModelListServer> {
  const started = await startModelListServer(write);
  servers.push(started);
  return started;
}

/**
 * Answers with `body` as JSON.
 *
 * @sideEffects none
 * @param body - The answer.
 * @returns The writer.
 */
function json(body: unknown): (response: ServerResponse) => void {
  return (response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * A stand-in for pi's command context: its models, its credentials and whether they are a subscription's.
 *
 * @remarks
 * Keeps the statuses the extension set.
 *
 * @sideEffects none
 * @param models - The models pi has credentials for.
 * @param options - What pi answers for credentials (or `"throws"`), and whether it is OAuth.
 * @returns The context and the statuses.
 */
function stand(
  models: readonly { provider: string; id: string; baseUrl: string }[],
  options: { readonly auth?: Auth | "throws"; readonly oauth?: boolean } = {},
): { ctx: Context; statuses: (readonly [string, string | undefined])[] } {
  const statuses: (readonly [string, string | undefined])[] = [];
  return {
    statuses,
    ctx: {
      ui: { setStatus: (key, text) => statuses.push([key, text]) },
      modelRegistry: {
        getAvailable: () => models,
        getApiKeyAndHeaders: () =>
          options.auth === "throws"
            ? Promise.reject(new Error("pi failed"))
            : Promise.resolve(options.auth ?? { ok: true, apiKey: TOKEN, headers: { "x-pi": "1", "x-unset": null } }),
        isUsingOAuth: () => options.oauth ?? true,
      },
    },
  };
}

/**
 * Loads the extension into a stand-in for pi's extension API and runs its command.
 *
 * @sideEffects Runs the command, which may make a request.
 * @param args - What follows the command's name.
 * @param ctx - The context.
 * @param grokUrl - Where Grok's usage is asked; nowhere real (testing.md).
 * @returns The command's name and description.
 * @throws {Error} When it registered no command.
 */
async function run(
  args: string,
  ctx: Context,
  grokUrl = "http://127.0.0.1:9/v1/billing?format=credits",
): Promise<{ name: string; description: string }> {
  let registered:
    | { name: string; description: string; handler: (args: string, ctx: Context) => Promise<void> }
    | undefined;
  atriumPlan(
    {
      registerCommand: (name, options) => {
        registered = { name, description: options.description, handler: options.handler };
      },
      on: () => () => undefined,
    },
    grokUrl,
  );
  if (registered === undefined) throw new Error("the extension registered no command");
  await registered.handler(args, ctx);
  return { name: registered.name, description: registered.description };
}

/** The statuses as JSON. */
function reports(statuses: readonly (readonly [string, string | undefined])[]): [string, unknown][] {
  return statuses.map(([key, text]) => [key, JSON.parse(text ?? "null")]);
}

/** ChatGPT's one model, at `baseUrl`. */
function codex(baseUrl: string) {
  return [{ provider: "openai-codex", id: "gpt-6.1-sol", baseUrl }];
}

/** Grok's one model, at pi's address for it, which the usage does not use. */
const GROK = [{ provider: "xai", id: "grok-4.3", baseUrl: "https://api.x.ai/v1" }];

/** Claude's one model, at `baseUrl`. */
function claude(baseUrl: string) {
  return [{ provider: "anthropic", id: "claude-opus-5-5", baseUrl }];
}

describe("atriumPlan", () => {
  // oxlint-disable-next-line vitest/expect-expect -- a type check: typecheck fails it, not the run.
  it("fits pi's extension API, alone and with Fast", () => {
    expectTypeOf<ExtensionAPI>().toExtend<PlanApi>();
    expectTypeOf<ExtensionAPI>().toExtend<Parameters<typeof atrium>[0]>();
  });

  it("asks ChatGPT's wham/usage with pi's login, as pi sends Codex's, and reports the plan and windows", async () => {
    const server = await usageServer(json(CODEX_ANSWER));
    const { ctx, statuses } = stand([
      { provider: "anthropic", id: "claude-opus-5-5", baseUrl: "http://127.0.0.1:9" },
      { provider: "openai-codex", id: "gpt-6.1-sol", baseUrl: `${server.baseUrl}/codex/responses` },
    ]);

    const registered = await run(" openai-codex ", ctx);

    expect(registered).toStrictEqual({
      name: "atrium-plan",
      description: "Atrium's plan usage query, sent by Atrium's host",
    });
    expect(server.requests.map(({ url, headers }) => [url, headers])).toStrictEqual([
      [
        "/backend-api/wham/usage",
        expect.objectContaining({
          authorization: `Bearer ${TOKEN}`,
          "chatgpt-account-id": "acct-1",
          originator: "pi",
          accept: "application/json",
          "x-pi": "1",
        }),
      ],
    ]);
    expect(server.requests[0]?.headers["x-unset"]).toBeUndefined();
    expect(reports(statuses)).toStrictEqual([
      [
        "atrium-plan",
        {
          provider: "openai-codex",
          plan: "pro",
          windows: [
            { seconds: 18_000, model: null, usedPercent: 39, resetsAt: 1_782_770_922_000, parts: [] },
            { seconds: 604_800, model: null, usedPercent: 52, resetsAt: 1_783_357_722_000, parts: [] },
          ],
        },
      ],
    ]);
  });

  it("asks Claude's api/oauth/usage with the OAuth beta, only with a subscription's login", async () => {
    const server = await usageServer(json(CLAUDE_ANSWER));
    const models = [{ provider: "anthropic", id: "claude-opus-5-5", baseUrl: `${server.baseUrl}//` }];
    const subscribed = stand(models);
    const keyed = stand(models, { oauth: false });

    await run("anthropic", subscribed.ctx);
    await run("anthropic", keyed.ctx);

    expect(
      server.requests.map(({ url, headers }) => [
        url,
        headers["authorization"],
        headers["anthropic-beta"],
        headers["accept"],
        headers["x-pi"],
      ]),
    ).toStrictEqual([["/backend-api/api/oauth/usage", `Bearer ${TOKEN}`, "oauth-2025-04-20", "application/json", "1"]]);
    expect([...reports(subscribed.statuses), ...reports(keyed.statuses)]).toStrictEqual([
      [
        "atrium-plan",
        {
          provider: "anthropic",
          plan: null,
          windows: [
            { seconds: 18_000, model: null, usedPercent: 84, resetsAt: Date.parse("2026-10-15T10:00:00Z"), parts: [] },
          ],
        },
      ],
      ["atrium-plan", { provider: "anthropic", failure: "no_login" }],
    ]);
  });

  it("asks Grok's billing at its own address with the bearer and Grok's mark alone, only with a subscription's login", async () => {
    const server = await usageServer(json(GROK_ANSWER));
    const subscribed = stand(GROK);
    const keyed = stand(GROK, { oauth: false });
    const grokUrl = `${server.baseUrl}/v1/billing?format=credits`;

    await run("xai", subscribed.ctx, grokUrl);
    await run("xai", keyed.ctx, grokUrl);

    expect(server.requests.map(({ url, headers }) => [url, headers])).toStrictEqual([
      [
        "/backend-api/v1/billing?format=credits",
        expect.objectContaining({
          authorization: `Bearer ${TOKEN}`,
          "x-xai-token-auth": "xai-grok-cli",
          accept: "application/json",
        }),
      ],
    ]);
    // pi's own headers are for api.x.ai.
    expect(server.requests[0]?.headers["x-pi"]).toBeUndefined();
    expect([...reports(subscribed.statuses), ...reports(keyed.statuses)]).toStrictEqual([
      [
        "atrium-plan",
        {
          provider: "xai",
          plan: null,
          windows: [
            {
              seconds: 604_800,
              model: null,
              usedPercent: 34,
              resetsAt: Date.parse("2026-10-19T09:56:20Z"),
              parts: [{ name: "GrokBuild", usedPercent: 33 }],
            },
          ],
        },
      ],
      ["atrium-plan", { provider: "xai", failure: "no_login" }],
    ]);
  });

  it("reports why Grok has no usage: unreachable, an HTTP error, or an answer that is not usage", async () => {
    const failing = await usageServer((response) => response.writeHead(403).end("secret"));
    const odd = await usageServer(json({ config: { hello: "world" } }));
    const cases = [
      [stand(GROK), "http://127.0.0.1:9/v1/billing"],
      [stand(GROK), failing.baseUrl],
      [stand(GROK), odd.baseUrl],
    ] as const;

    for (const [{ ctx }, url] of cases) await run("xai", ctx, url);

    expect(cases.flatMap(([{ statuses }]) => reports(statuses).map(([, report]) => report))).toStrictEqual([
      { provider: "xai", failure: "unreachable" },
      { provider: "xai", failure: "http_403" },
      { provider: "xai", failure: "unknown_shape" },
    ]);
  });

  it("asks Grok at the one address ADR-0011 allows", () => {
    expect(GROK_USAGE_URL).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
  });

  it("reports why there is no usage: no login, a failed lookup, unreachable, an HTTP error, not JSON, not usage", async () => {
    const failing = await usageServer((response) => response.writeHead(503).end("secret page"));
    const garbled = await usageServer((response) => response.writeHead(200).end("<html>"));
    const odd = await usageServer(json({ hello: "world" }));
    const cases = [
      stand([]),
      stand(codex(odd.baseUrl), { auth: { ok: false } }),
      stand(codex(odd.baseUrl), { auth: { ok: true, apiKey: "" } }),
      stand(codex(odd.baseUrl), { auth: "throws" }),
      stand(codex("http://127.0.0.1:9/backend-api")),
      stand(codex(failing.baseUrl)),
      stand(codex(garbled.baseUrl)),
      stand(codex(odd.baseUrl)),
    ];

    for (const { ctx } of cases) await run("openai-codex", ctx);

    expect(cases.flatMap(({ statuses }) => reports(statuses).map(([, report]) => report))).toStrictEqual(
      ["no_login", "no_login", "no_login", "no_login", "unreachable", "http_503", "not_json", "unknown_shape"].map(
        (failure) => ({ provider: "openai-codex", failure }),
      ),
    );
    expect(JSON.stringify(cases.map(({ statuses }) => statuses))).not.toMatch(/secret|html/);
  });

  it("follows no redirect with pi's credentials, reporting it unreachable", async () => {
    const server = await usageServer((response) => response.writeHead(302, { location: "/elsewhere" }).end());
    const { ctx, statuses } = stand(codex(server.baseUrl));

    await run("openai-codex", ctx);

    expect([reports(statuses), server.requests.length]).toStrictEqual([
      [["atrium-plan", { provider: "openai-codex", failure: "unreachable" }]],
      1,
    ]);
  });

  it("asks ChatGPT whatever pi says of its login, which pi keeps for the subscription alone", async () => {
    const server = await usageServer(json(CODEX_ANSWER));
    const { ctx, statuses } = stand(codex(server.baseUrl), { oauth: false });

    await run("openai-codex", ctx);

    expect(reports(statuses).map(([, report]) => Object.keys(report as object))).toStrictEqual([
      ["provider", "plan", "windows"],
    ]);
  });

  it("reports why Claude has no usage: an HTTP error, or an answer that is not usage", async () => {
    const failing = await usageServer((response) => response.writeHead(401).end("secret"));
    const odd = await usageServer(json({ hello: "world" }));
    const cases = [stand(claude(failing.baseUrl)), stand(claude(odd.baseUrl))];

    for (const { ctx } of cases) await run("anthropic", ctx);

    expect(cases.flatMap(({ statuses }) => reports(statuses).map(([, report]) => report))).toStrictEqual([
      { provider: "anthropic", failure: "http_401" },
      { provider: "anthropic", failure: "unknown_shape" },
    ]);
  });

  it("registers Fast's switch and hook, the plan query and the child conversations' command, tools and flag, and the web tools, from Atrium's one extension", () => {
    const commands: string[] = [];
    const hooks: string[] = [];
    const tools: string[] = [];
    const flags: string[] = [];

    atrium({
      registerCommand: (name) => commands.push(name),
      on: (event) => {
        hooks.push(event);
        return () => undefined;
      },
      sendMessage: () => undefined,
      appendEntry: () => undefined,
      registerTool: (tool) => tools.push(tool.name),
      registerFlag: (name) => flags.push(name),
      getFlag: () => undefined,
    });

    expect([commands, hooks, tools.length, tools.slice(-2), flags]).toStrictEqual([
      ["atrium-fast", "atrium-plan", "atrium-agent", "atrium-edit"],
      ["before_provider_request", "after_provider_response", "tool_call"],
      12,
      ["web_search", "web_fetch"],
      ["atrium-agent"],
    ]);
  });

  it("reports nothing for a provider Atrium does not ask", async () => {
    const server = await usageServer(json(CODEX_ANSWER));
    const { ctx, statuses } = stand([{ provider: "github-copilot", id: "gpt-5", baseUrl: server.baseUrl }]);

    await run("github-copilot", ctx);
    await run("", ctx);

    expect(statuses).toStrictEqual([]);
    expect(server.requests).toStrictEqual([]);
  });
});

/** The reply hook's context: the model asked and pi's status line. */
type ReplyContext = Parameters<Parameters<PlanApi["on"]>[1]>[1];

/**
 * Loads the extension and hands its reply hook one reply of a model of `provider`.
 *
 * @sideEffects none
 * @param provider - The model's provider, or none.
 * @param headers - The reply's headers.
 * @returns The statuses the hook set.
 * @throws {Error} When it registered no hook.
 */
function reply(provider: string | null, headers: Record<string, string>): [string, unknown][] {
  let hook: Parameters<PlanApi["on"]>[1] | undefined;
  const hooked: string[] = [];
  atriumPlan({
    registerCommand: () => undefined,
    on: (event, handler) => {
      hooked.push(event);
      hook = handler;
      return () => undefined;
    },
  });
  if (hook === undefined) throw new Error("the extension registered no hook");
  const statuses: (readonly [string, string | undefined])[] = [];
  const ctx: ReplyContext = {
    ui: { setStatus: (key, text) => statuses.push([key, text]) },
    model: provider === null ? undefined : { provider },
  };
  const returned = hook({ headers }, ctx);
  expect([hooked, returned]).toStrictEqual([["after_provider_response"], undefined]);
  return reports(statuses);
}

/** The usage headers pi-claude-bridge rebuilt from Claude Code's rate limit event, as seen on 2026-10-17 (ADR-0012). */
const BRIDGE_HEADERS = {
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-reset": "1792218000",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-5h-utilization": "0.05",
  "anthropic-ratelimit-unified-5h-reset": "1792218000",
  "anthropic-ratelimit-unified-7d-utilization": "0.07",
  "anthropic-ratelimit-unified-7d-reset": "1792753200",
};

describe("atriumPlan's reply hook", () => {
  it("reports Claude's usage from the headers of a reply through pi-claude-bridge or pi's own Claude, without asking", () => {
    const usage = {
      provider: "anthropic",
      plan: null,
      windows: [
        { seconds: 18_000, model: null, usedPercent: 5, resetsAt: 1_792_218_000_000, parts: [] },
        { seconds: 604_800, model: null, usedPercent: 7, resetsAt: 1_792_753_200_000, parts: [] },
      ],
    };

    expect([reply("claude-bridge", BRIDGE_HEADERS), reply("anthropic", BRIDGE_HEADERS)]).toStrictEqual([
      [["atrium-plan-reply", usage]],
      [["atrium-plan-reply", usage]],
    ]);
  });

  it("reports nothing for another provider's reply, a reply of no model, or one without usage", () => {
    expect([
      reply("openai-codex", BRIDGE_HEADERS),
      reply(null, BRIDGE_HEADERS),
      reply("claude-bridge", { "anthropic-ratelimit-unified-status": "allowed" }),
    ]).toStrictEqual([[], [], []]);
  });
});
