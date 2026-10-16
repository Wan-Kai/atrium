import { type Registry, backendRoot, chatgptHeaders, loginFor } from "../extension/credentials";
import {
  CODEX,
  FAST_COMMAND,
  FAST_SERVICE_TIER,
  FAST_STATUS,
  type FastReport,
  type FastTiers,
  fastOf,
  tiersFromModelList,
} from "./fast";

/** The part of a command's context Fast uses: pi's model registry and its one-way status line. */
interface FastContext {
  readonly ui: { setStatus(key: string, text: string | undefined): void };
  readonly modelRegistry: Registry;
}

/** The part of pi's extension API Fast uses; its test checks pi's `ExtensionAPI` fits it. */
export interface FastApi {
  registerCommand(
    name: string,
    options: { readonly description: string; readonly handler: (args: string, ctx: FastContext) => Promise<void> },
  ): void;
  on(
    event: "before_provider_request",
    handler: (
      event: { readonly payload: unknown },
      ctx: { readonly model: { readonly provider: string; readonly id: string } | undefined },
    ) => unknown,
  ): unknown;
}

/** The client version Codex's model list is asked for: high enough that it leaves out no model (pi-internals.md §5). */
const CLIENT_VERSION = "99.0.0";

/** How long Codex's model list may take before Fast goes by the built-in rule. */
const LIST_TIMEOUT_MS = 15_000;

/**
 * Asks for a payload's priority service tier, or leaves it as it is.
 *
 * @remarks
 * Only a JSON object can be a request body with a service tier; anything else is a payload this
 * provider builds differently, and is left alone. A copy is returned, so pi's own payload is not
 * changed under it.
 *
 * @sideEffects none
 * @param payload - The request body pi built.
 * @returns The body with `service_tier: "priority"`, or `undefined` to keep pi's.
 */
function withPriority(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  return { ...payload, service_tier: FAST_SERVICE_TIER };
}

/**
 * Asks Codex which of its models have Fast.
 *
 * @remarks
 * With pi's own ChatGPT login, through pi's `fetch`, which goes through the proxy pi was set up
 * with (ADR-0008, point 6; security.md). The credentials stay in this function: what comes back is
 * the list as `FastReport`, or a failure code with nothing of the server's text. It never rejects,
 * since the first `on` asks without waiting.
 *
 * @sideEffects Asks pi for credentials; makes one request to Codex.
 * @param ctx - The command's context.
 * @returns The report.
 */
async function askCodex(ctx: FastContext): Promise<FastReport> {
  const login = await loginFor(ctx.modelRegistry, CODEX);
  if (login === null) return { failure: "no_login" };
  let response: Response;
  try {
    // Next to where pi sends Codex's requests, so the credentials go nowhere pi does not already send them.
    response = await fetch(`${backendRoot(login.baseUrl)}/codex/models?client_version=${CLIENT_VERSION}`, {
      headers: chatgptHeaders(login),
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
  } catch {
    return { failure: "unreachable" };
  }
  if (!response.ok) return { failure: `http_${String(response.status)}` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { failure: "not_json" };
  }
  const tiers = tiersFromModelList(body);
  if (tiers === null) return { failure: "not_a_list" };
  // An empty list names no model; the built-in rule does better than giving none Fast.
  if (tiers.size === 0) return { failure: "empty_list" };
  return { models: [...tiers].map(([id, fast]) => ({ id, fast })) };
}

/**
 * Atrium's Fast extension: asks OpenAI's priority service tier for the models that have Fast.
 *
 * @remarks
 * pi loads this file in the pi processes Atrium starts (ADR-0008); pi's core passes no service
 * tier, so it goes into the request in `before_provider_request` (pi-internals.md §5). It starts
 * off; the host switches it with `/atrium-fast on` and `/atrium-fast off`, which pi runs at once,
 * even during a run, without a turn or an entry. While on, a request to a model with Fast
 * (`fastOf`) asks for `service_tier: "priority"`, from the next request on; every other request
 * goes as pi built it.
 *
 * Which models have Fast comes from Codex's model list (ADR-0008, point 6): the first `on` asks for
 * it in the background, and until it answers, or when it cannot, the built-in rule decides.
 * `/atrium-fast tiers` asks again and reports the list, or why there is none, as the status
 * `atrium-fast`, which pi sends the host. Any other word changes nothing. Nothing is written or
 * logged.
 *
 * @sideEffects Registers a command and a request hook with pi; asks Codex for its model list.
 * @param pi - pi's extension API.
 */
export default function atriumFast(pi: FastApi): void {
  let enabled = false;
  let tiers: FastTiers | null = null;
  let asking: Promise<FastReport> | null = null;

  /**
   * Asks Codex for its model list once at a time, keeping what it answers.
   *
   * @remarks
   * A second ask while one is under way shares it. A failure keeps the list it had, if any.
   *
   * @sideEffects Asks Codex; updates the list.
   * @param ctx - The command's context.
   * @returns The report.
   */
  function ask(ctx: FastContext): Promise<FastReport> {
    asking ??= askCodex(ctx)
      .then((report) => {
        if ("models" in report) tiers = new Map(report.models.map(({ id, fast }) => [id, fast]));
        return report;
      })
      .finally(() => {
        asking = null;
      });
    return asking;
  }

  pi.registerCommand(FAST_COMMAND, {
    description: "Atrium's Fast switch, sent by Atrium's host",
    handler: async (args, ctx) => {
      const word = args.trim();
      if (word === "tiers") {
        ctx.ui.setStatus(FAST_STATUS, JSON.stringify(await ask(ctx)));
        return;
      }
      if (word !== "on" && word !== "off") return;
      enabled = word === "on";
      // In the background: the switch takes effect at once, by the built-in rule until Codex answers.
      if (enabled && tiers === null) void ask(ctx);
    },
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || ctx.model === undefined || fastOf(ctx.model, tiers) === null) return undefined;
    return withPriority(event.payload);
  });
}
