import {
  LoginError,
  type LoginProgram,
  type LoginProvider,
  type LoginRequest,
  type LoginRun,
  type LoginUpdate,
  type PiDeps,
  logout,
  piPackageEntry,
  readLogins,
  startLogin,
} from "@atrium/pi";
import type { SetupLogin, SetupProvider } from "@atrium/protocol";
import type { Logger } from "../platform/logger";
import type { HostTools } from "./toolbox";

/**
 * Providers first launch and the settings leave out: pi's legacy `openai-codex`, and `radius`,
 * which needs a gateway set up first (SPEC-0001, "第 2 步：登录模型").
 */
const HIDDEN_PROVIDERS: ReadonlySet<string> = new Set(["openai-codex", "radius"]);

const UNAVAILABLE: SetupLogin = { state: "unavailable" };

/** Sign-in through the installed pi, as the host offers it. */
export interface Logins {
  /** How each provider is signed in, or `unavailable` when the login program cannot use pi. */
  status(tools: HostTools | null): Promise<SetupLogin>;
  /**
   * Starts signing in through pi, or `null` when logins are unavailable.
   *
   * @remarks
   * `before` runs once the login can start and before its program does, as the login under way must
   * go first; when logins are unavailable it never runs.
   */
  start(
    tools: HostTools | null,
    request: LoginRequest,
    onUpdate: (update: LoginUpdate) => void,
    before: () => Promise<void>,
  ): Promise<LoginRun | null>;
  /**
   * Removes a provider's stored credential through pi; `false` when logins are unavailable.
   *
   * @throws {LoginError} When pi refuses or takes too long.
   */
  logout(tools: HostTools | null, providerId: string): Promise<boolean>;
  /** Stops the status checks and logouts under way and waits for them. */
  close(): Promise<void>;
}

/**
 * Turns a provider the login program reports into the one first launch shows.
 *
 * @remarks
 * The OAuth button reads pi's `loginLabel`, or the OAuth name when pi gives none (SPEC-0001,
 * "第 2 步：登录模型"). Where a key in the environment comes from stays in the host: its name is
 * not needed to show that it is not stored.
 *
 * @sideEffects none
 * @param provider - The provider.
 * @returns What the protocol carries.
 */
function toSetupProvider(provider: LoginProvider): SetupProvider {
  return {
    providerId: provider.id,
    name: provider.name,
    oauth:
      provider.oauth === null
        ? null
        : { label: provider.oauth.label ?? provider.oauth.name, subscription: provider.oauth.subscription },
    apiKey: provider.apiKey,
    signedIn: provider.signedIn === null ? null : { method: provider.signedIn.type, stored: provider.signedIn.stored },
  };
}

/**
 * Creates the host's side of signing in.
 *
 * @remarks
 * The login program runs on the Node the tools found and loads the pi package the `pi` command
 * belongs to (SPEC-0001, "第 2 步：登录模型"). Without the program, a usable pi and Node 22.19, or a
 * pi that is such a package, logins are `unavailable` and the user signs in from the terminal; a
 * status check that fails or times out is `unavailable` too. Only the reason is logged, never pi's
 * words: they may quote what pi was told (security.md, "凭据与日志"). Providers that can neither sign
 * in with OAuth nor store a key are left out, as are the hidden ones.
 *
 * @sideEffects none until asked; then runs the login program.
 * @param options - The login program's path (none when it was not built), the infrastructure for
 * running it with an environment, and the logger.
 * @returns The logins.
 */
export function createLogins(options: {
  readonly worker: string | undefined;
  readonly deps: (env: Readonly<Record<string, string>>) => PiDeps;
  readonly logger: Logger;
}): Logins {
  const stop = new AbortController();
  const running = new Set<Promise<unknown>>();

  /**
   * What it takes to run the login program with the tools found.
   *
   * @remarks
   * See {@link createLogins}.
   *
   * @sideEffects Reads the file system.
   * @param tools - The tools.
   * @returns The program and the infrastructure to run it with the tools' environment, or `null`
   * when logins are unavailable.
   */
  async function programFor(tools: HostTools | null): Promise<{ program: LoginProgram; deps: PiDeps } | null> {
    if (tools === null || options.worker === undefined) return null;
    if (tools.pi.status !== "ready" || tools.node.status !== "ready") return null;
    const piEntry = await piPackageEntry(tools.pi.piPath);
    if (piEntry === null) return null;
    return { program: { node: tools.node.nodePath, worker: options.worker, piEntry }, deps: options.deps(tools.env) };
  }

  /**
   * Runs one status check.
   *
   * @remarks
   * See {@link createLogins}.
   *
   * @sideEffects Runs the login program; logs why logins are unavailable.
   * @param tools - The tools.
   * @returns The logins.
   */
  async function check(tools: HostTools | null): Promise<SetupLogin> {
    const found = await programFor(tools);
    if (found === null) return UNAVAILABLE;
    try {
      const providers = await readLogins(found.program, found.deps, { signal: stop.signal });
      return {
        state: "ready",
        providers: providers
          .filter((provider) => !HIDDEN_PROVIDERS.has(provider.id) && (provider.oauth !== null || provider.apiKey))
          .map(toSetupProvider),
      };
    } catch (error) {
      if (!(error instanceof LoginError)) throw error;
      options.logger.warn({ reason: error.reason }, "logins unavailable");
      return UNAVAILABLE;
    }
  }

  /**
   * Runs an operation, so closing waits for it.
   *
   * @remarks
   * See {@link createLogins}.
   *
   * @sideEffects Records the operation until it settles.
   * @param operation - The operation.
   * @returns What it gives.
   */
  async function tracked<T>(operation: Promise<T>): Promise<T> {
    running.add(operation);
    try {
      return await operation;
    } finally {
      running.delete(operation);
    }
  }

  return {
    status: (tools) => tracked(check(tools)),
    async start(tools, request, onUpdate, before) {
      const found = await programFor(tools);
      if (found === null) return null;
      await before();
      return startLogin(found.program, found.deps, request, onUpdate);
    },
    logout: (tools, providerId) =>
      tracked(
        (async () => {
          const found = await programFor(tools);
          if (found === null) return false;
          await logout(found.program, found.deps, providerId, { signal: stop.signal });
          return true;
        })(),
      ),
    close: async () => {
      stop.abort();
      await Promise.allSettled(running);
    },
  };
}
