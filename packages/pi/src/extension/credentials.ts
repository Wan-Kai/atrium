/** A model as pi's model registry gives it, as far as Atrium's extension needs. */
interface RegistryModel {
  readonly provider: string;
  readonly id: string;
  readonly baseUrl: string;
}

/** The part of pi's model registry Atrium's extension uses. */
export interface Registry {
  getAvailable(): readonly RegistryModel[];
  getApiKeyAndHeaders(model: RegistryModel): Promise<
    | {
        readonly ok: true;
        readonly apiKey?: string;
        readonly headers?: Readonly<Record<string, string | null>>;
        readonly baseUrl?: string;
        /** The credential's own `env` object in `auth.json`, as pi resolves it (providers.md, "Provider Specific Config"). */
        readonly env?: Readonly<Record<string, string>>;
      }
    | { readonly ok: false }
  >;
  isUsingOAuth(model: RegistryModel): boolean;
}

/** A provider's login, as pi would send it with that provider's requests. */
export interface Login {
  readonly apiKey: string;
  /** pi's own headers for the provider, without those it leaves unset. */
  readonly headers: Readonly<Record<string, string>>;
  /** Where pi sends the provider's requests: the login's base address before the model's, as pi takes them. */
  readonly baseUrl: string;
  /** Whether it is a subscription's login rather than an API key. */
  readonly oauth: boolean;
}

/** Where the ChatGPT account id sits in the access token's claims, as pi reads it. */
const ACCOUNT_CLAIM = "https://api.openai.com/auth";

/** An access token's claims as far as the account id; whatever the token holds until read. */
interface TokenClaims {
  readonly [ACCOUNT_CLAIM]?: { readonly chatgpt_account_id?: unknown } | null;
}

/**
 * pi's login for a provider, from the first of its models pi can use.
 *
 * @remarks
 * Through pi's `modelRegistry.getApiKeyAndHeaders`, so the credentials are pi's and never leave
 * its process (ADR-0008, ADR-0010; security.md). pi answers a failed lookup with `ok: false`; a
 * throw is taken the same way, so the lookup never rejects.
 *
 * @sideEffects Asks pi for credentials.
 * @param registry - pi's model registry.
 * @param provider - The provider.
 * @returns The login, or `null` without one.
 */
export async function loginFor(registry: Registry, provider: string): Promise<Login | null> {
  const model = registry.getAvailable().find((available) => available.provider === provider);
  if (model === undefined) return null;
  const auth = await registry.getApiKeyAndHeaders(model).catch(() => ({ ok: false }) as const);
  if (!auth.ok || auth.apiKey === undefined || auth.apiKey === "") return null;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(auth.headers ?? {})) if (value !== null) headers[name] = value;
  return { apiKey: auth.apiKey, headers, baseUrl: auth.baseUrl ?? model.baseUrl, oauth: registry.isUsingOAuth(model) };
}

/**
 * The ChatGPT account id in an access token, as pi sends it with each Codex request.
 *
 * @remarks
 * The token is a JWT; its claims are read, not verified, as pi does. A token that is not one has
 * no account id, and Codex is asked without it. Claims of any other shape read as undefined, or
 * throw into the catch, so they need no checks of their own.
 *
 * @sideEffects none
 * @param token - The access token.
 * @returns The account id, or `undefined`.
 */
function accountIdOf(token: string): string | undefined {
  const parts = token.split(".");
  // Stryker disable next-line StringLiteral: Stryker's filler decodes to bytes that are not JSON, which throw as none do.
  const payload = parts[1] ?? "";
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- any shape reads safely below, or throws into the catch.
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
    // Stryker disable next-line OptionalChaining: without the claim, reading through it throws into the catch.
    const account = claims[ACCOUNT_CLAIM]?.chatgpt_account_id;
    return typeof account === "string" ? account : undefined;
  } /* Stryker disable next-line BlockStatement: an empty catch returns nothing, as this does. */ catch {
    return undefined;
  }
}

/**
 * The headers of a request to ChatGPT's backend with pi's login, as pi sends Codex's.
 *
 * @remarks
 * pi's own headers, then `originator: pi`, JSON, the bearer token and the account id when the
 * token has one (pi-internals.md §5).
 *
 * @sideEffects none
 * @param login - The login.
 * @returns The headers.
 */
export function chatgptHeaders(login: Login): Record<string, string> {
  const headers: Record<string, string> = {
    ...login.headers,
    originator: "pi",
    accept: "application/json",
    authorization: `Bearer ${login.apiKey}`,
  };
  const account = accountIdOf(login.apiKey);
  if (account !== undefined) headers["chatgpt-account-id"] = account;
  return headers;
}

/**
 * The root of ChatGPT's backend from the address pi sends Codex's requests to.
 *
 * @remarks
 * pi's rule for `/codex/responses` (pi-internals.md §5): the base address, with any trailing `/`
 * and `/codex` or `/codex/responses` taken off, is `…/backend-api`.
 *
 * @sideEffects none
 * @param baseUrl - The base address.
 * @returns The root.
 */
export function backendRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "").replace(/\/codex(?:\/responses)?$/u, "");
}
