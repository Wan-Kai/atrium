import { LoginError, type LoginProgram, type LoginProvider, type PiDeps, piPackageEntry, readLogins } from "@atrium/pi";
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
  /** Stops the login program runs under way and waits for them. */
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
   * @returns The program, or `null` when logins are unavailable.
   */
  async function programFor(tools: HostTools): Promise<LoginProgram | null> {
    if (options.worker === undefined || tools.pi.status !== "ready" || tools.node.status !== "ready") return null;
    const piEntry = await piPackageEntry(tools.pi.piPath);
    return piEntry === null ? null : { node: tools.node.nodePath, worker: options.worker, piEntry };
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
    if (tools === null) return UNAVAILABLE;
    const program = await programFor(tools);
    if (program === null) return UNAVAILABLE;
    try {
      const providers = await readLogins(program, options.deps(tools.env), { signal: stop.signal });
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

  return {
    status: async (tools) => {
      const checking = check(tools);
      running.add(checking);
      try {
        return await checking;
      } finally {
        running.delete(checking);
      }
    },
    close: async () => {
      stop.abort();
      await Promise.allSettled(running);
    },
  };
}
