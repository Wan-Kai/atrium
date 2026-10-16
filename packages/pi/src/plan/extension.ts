import { type Login, type Registry, backendRoot, chatgptHeaders, loginFor } from "../extension/credentials";
import { PLAN_COMMAND, PLAN_STATUS, type PlanReport, claudeUsage, codexUsage, isPlanProvider } from "./plan";

/** The part of a command's context the plan query uses: pi's model registry and its one-way status line. */
interface PlanContext {
  readonly ui: { setStatus(key: string, text: string | undefined): void };
  readonly modelRegistry: Registry;
}

/** The part of pi's extension API the plan query uses; its test checks pi's `ExtensionAPI` fits it. */
export interface PlanApi {
  registerCommand(
    name: string,
    options: { readonly description: string; readonly handler: (args: string, ctx: PlanContext) => Promise<void> },
  ): void;
}

/** How long a provider's usage may take before the query gives up. */
const USAGE_TIMEOUT_MS = 15_000;

/** The beta Claude's usage answers only with (ADR-0010). */
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

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
 * Asks a subscription for its usage.
 *
 * @remarks
 * ADR-0010: ChatGPT's `wham/usage` at the root of where pi sends Codex's requests; Claude's
 * `api/oauth/usage` at the model's base address, only with a subscription's login. A provider
 * without a login, or Claude with an API key, is `no_login`; an answer that is not usage is
 * `unknown_shape`. It never rejects.
 *
 * @sideEffects Asks pi for credentials; makes one request.
 * @param ctx - The command's context.
 * @param provider - The provider, as the host named it.
 * @returns The report, or `null` for a provider Atrium does not ask.
 */
async function askPlan(ctx: PlanContext, provider: string): Promise<PlanReport | null> {
  if (!isPlanProvider(provider)) return null;
  const login = await loginFor(ctx.modelRegistry, provider);
  if (login === null || (provider === "anthropic" && !login.oauth)) return { provider, failure: "no_login" };
  if (provider === "openai-codex") {
    const answer = await askFor(`${backendRoot(login.baseUrl)}/wham/usage`, chatgptHeaders(login));
    if ("failure" in answer) return { provider, failure: answer.failure };
    const usage = codexUsage(answer.body);
    return usage === null ? { provider, failure: "unknown_shape" } : { provider, ...usage };
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
 * host. A provider Atrium does not ask reports nothing. Nothing is written or logged.
 *
 * @sideEffects Registers a command with pi; asks providers for usage when it runs.
 * @param pi - pi's extension API.
 */
export default function atriumPlan(pi: PlanApi): void {
  pi.registerCommand(PLAN_COMMAND, {
    description: "Atrium's plan usage query, sent by Atrium's host",
    handler: async (args, ctx) => {
      const report = await askPlan(ctx, args.trim());
      if (report !== null) ctx.ui.setStatus(PLAN_STATUS, JSON.stringify(report));
    },
  });
}
