import { type Login, type Registry, backendRoot, chatgptHeaders, loginFor } from "../extension/credentials";
import {
  PLAN_COMMAND,
  PLAN_REPLY_STATUS,
  PLAN_STATUS,
  type PlanReport,
  claudeUsage,
  codexUsage,
  grokUsage,
  isPlanProvider,
  repliesWithClaudeUsage,
  replyUsage,
} from "./plan";

/** The part of a command's context the plan query uses: pi's model registry and its one-way status line. */
interface PlanContext {
  readonly ui: { setStatus(key: string, text: string | undefined): void };
  readonly modelRegistry: Registry;
}

/** The part of a hook's context reading a reply uses: the model asked and pi's one-way status line. */
interface ReplyContext {
  readonly ui: { setStatus(key: string, text: string | undefined): void };
  readonly model: { readonly provider: string } | undefined;
}

/** The part of pi's extension API the plan query uses; its test checks pi's `ExtensionAPI` fits it. */
export interface PlanApi {
  registerCommand(
    name: string,
    options: { readonly description: string; readonly handler: (args: string, ctx: PlanContext) => Promise<void> },
  ): void;
  on(
    event: "after_provider_response",
    handler: (event: { readonly headers: Readonly<Record<string, string>> }, ctx: ReplyContext) => unknown,
  ): unknown;
}

/** How long a provider's usage may take before the query gives up. */
const USAGE_TIMEOUT_MS = 15_000;

/** The beta Claude's usage answers only with (ADR-0010). */
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

/**
 * Where Grok's usage is: the one address the extension sends pi's credentials to that pi itself
 * does not use (ADR-0011; security.md, "Atrium 自带的 pi 扩展"). Fixed, never from a model or a login.
 */
export const GROK_USAGE_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

/**
 * Asks a provider for its usage with pi's login, and reads the answer.
 *
 * @remarks
 * Through pi's `fetch`, which goes through the proxy pi was set up with (ADR-0010, point 1). The
 * credentials stay here: what comes back is the answer's body or a failure code, with nothing of
 * the server's text.
 *
 * @sideEffects Makes one request.
 * @param url - Where.
 * @param headers - The headers, with the credentials.
 * @returns The body, or the failure.
 */
async function askFor(url: string, headers: Record<string, string>): Promise<{ body: unknown } | { failure: string }> {
  let response: Response;
  try {
    // No redirect: pi's credentials go only where they were sent (security.md, "Atrium 自带的 pi 扩展").
    response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(USAGE_TIMEOUT_MS) });
  } catch {
    return { failure: "unreachable" };
  }
  if (!response.ok) return { failure: `http_${String(response.status)}` };
  try {
    return { body: await response.json() };
  } catch {
    return { failure: "not_json" };
  }
}

/**
 * The headers of a request for Claude's usage with pi's login.
 *
 * @remarks
 * pi's own headers for Anthropic, then the bearer token and the OAuth beta the usage answers with
 * (ADR-0010).
 *
 * @sideEffects none
 * @param login - The login.
 * @returns The headers.
 */
function claudeHeaders(login: Login): Record<string, string> {
  return {
    ...login.headers,
    accept: "application/json",
    authorization: `Bearer ${login.apiKey}`,
    "anthropic-beta": CLAUDE_OAUTH_BETA,
  };
}

/**
 * The headers of a request for Grok's usage with pi's login.
 *
 * @remarks
 * Only the bearer token and the mark Grok's own command line sends (ADR-0011): pi's headers are
 * for `api.x.ai`, not this server.
 *
 * @sideEffects none
 * @param login - The login.
 * @returns The headers.
 */
function grokHeaders(login: Login): Record<string, string> {
  return { accept: "application/json", authorization: `Bearer ${login.apiKey}`, "x-xai-token-auth": "xai-grok-cli" };
}

/**
 * Asks a subscription for its usage.
 *
 * @remarks
 * ADR-0010: ChatGPT's `wham/usage` at the root of where pi sends Codex's requests; Claude's
 * `api/oauth/usage` at the model's base address, only with a subscription's login. ADR-0011:
 * Grok's billing at its fixed address, only with a subscription's login. A provider without a
 * login, or Claude or Grok with an API key, is `no_login`; an answer that is not usage is
 * `unknown_shape`. It never rejects.
 *
 * @sideEffects Asks pi for credentials; makes one request.
 * @param ctx - The command's context.
 * @param provider - The provider, as the host named it.
 * @param grokUrl - Where Grok's usage is.
 * @returns The report, or `null` for a provider Atrium does not ask.
 */
async function askPlan(ctx: PlanContext, provider: string, grokUrl: string): Promise<PlanReport | null> {
  if (!isPlanProvider(provider)) return null;
  const login = await loginFor(ctx.modelRegistry, provider);
  if (login === null || (provider !== "openai-codex" && !login.oauth)) return { provider, failure: "no_login" };
  if (provider === "openai-codex") {
    const answer = await askFor(`${backendRoot(login.baseUrl)}/wham/usage`, chatgptHeaders(login));
    if ("failure" in answer) return { provider, failure: answer.failure };
    const usage = codexUsage(answer.body);
    return usage === null ? { provider, failure: "unknown_shape" } : { provider, ...usage };
  }
  if (provider === "xai") {
    const answer = await askFor(grokUrl, grokHeaders(login));
    if ("failure" in answer) return { provider, failure: answer.failure };
    const windows = grokUsage(answer.body);
    return windows === null ? { provider, failure: "unknown_shape" } : { provider, plan: null, windows };
  }
  const answer = await askFor(`${login.baseUrl.replace(/\/+$/u, "")}/api/oauth/usage`, claudeHeaders(login));
  if ("failure" in answer) return { provider, failure: answer.failure };
  const windows = claudeUsage(answer.body);
  return windows === null ? { provider, failure: "unknown_shape" } : { provider, plan: null, windows };
}

/**
 * Atrium's plan query: asks a subscription for its usage with pi's login.
 *
 * @remarks
 * pi loads this, with Fast, in the pi processes Atrium starts (ADR-0010). The host sends
 * `/atrium-plan <provider>`, which pi runs at once, even during a run, without a turn or an entry;
 * the usage, or why there is none, is reported as the status `atrium-plan`, which pi sends the
 * host. A provider Atrium does not ask reports nothing. ADR-0012: each reply of a Claude model,
 * through pi or pi-claude-bridge, has its usage headers read and reported as the status
 * `atrium-plan-reply`, without credentials or a request. Nothing is written or logged.
 *
 * @sideEffects Registers a command and a hook with pi; asks providers for usage when the command
 * runs; reports the usage replies bring.
 * @param pi - pi's extension API.
 * @param grokUrl - Where Grok's usage is: {@link GROK_USAGE_URL}, which tests alone change. Atrium's
 *   one extension calls this with pi's API only, so nothing pi passes can change it.
 */
export default function atriumPlan(pi: PlanApi, grokUrl = GROK_USAGE_URL): void {
  pi.registerCommand(PLAN_COMMAND, {
    description: "Atrium's plan usage query, sent by Atrium's host",
    handler: async (args, ctx) => {
      const report = await askPlan(ctx, args.trim(), grokUrl);
      if (report !== null) ctx.ui.setStatus(PLAN_STATUS, JSON.stringify(report));
    },
  });
  pi.on("after_provider_response", (event, ctx) => {
    // ADR-0012: Claude's usage is in its replies' headers, whether pi or Claude Code sent the request.
    if (ctx.model === undefined || !repliesWithClaudeUsage(ctx.model.provider)) return undefined;
    const windows = replyUsage(event.headers);
    if (windows !== null)
      ctx.ui.setStatus(PLAN_REPLY_STATUS, JSON.stringify({ provider: "anthropic", plan: null, windows }));
    return undefined;
  });
}
