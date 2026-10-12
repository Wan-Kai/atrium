import { FAST_COMMAND, FAST_SERVICE_TIER, fastCreditsOf } from "./fast";

/** The part of pi's extension API Fast uses; its test checks pi's `ExtensionAPI` fits it. */
export interface FastApi {
  registerCommand(
    name: string,
    options: { readonly description: string; readonly handler: (args: string) => Promise<void> },
  ): void;
  on(
    event: "before_provider_request",
    handler: (
      event: { readonly payload: unknown },
      ctx: { readonly model: { readonly provider: string; readonly id: string } | undefined },
    ) => unknown,
  ): unknown;
}

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
 * Atrium's Fast extension: asks OpenAI's priority service tier for the models that have Fast.
 *
 * @remarks
 * pi loads this file in the sessions Atrium starts (ADR-0008); pi's core passes no service tier,
 * so it goes into the request in `before_provider_request` (pi-internals.md §5). It starts off; the
 * host switches it with `/atrium-fast on` and `/atrium-fast off`, which pi runs at once, even
 * during a run, without a turn or an entry. Any other word changes nothing. While on, a request
 * to a model with Fast (`fastCreditsOf`) asks for `service_tier: "priority"`, from the next request
 * on; every other request goes as pi built it. Nothing is read, written or logged.
 *
 * @sideEffects Registers a command and a request hook with pi.
 * @param pi - pi's extension API.
 */
export default function atriumFast(pi: FastApi): void {
  let enabled = false;
  pi.registerCommand(FAST_COMMAND, {
    description: "Atrium's Fast switch, sent by Atrium's host",
    handler: (args) => {
      const word = args.trim();
      if (word === "on" || word === "off") enabled = word === "on";
      return Promise.resolve();
    },
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || ctx.model === undefined || fastCreditsOf(ctx.model) === null) return undefined;
    return withPriority(event.payload);
  });
}
