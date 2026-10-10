/**
 * The login program: runs one login operation through the pi the user installed.
 *
 * @remarks
 * The host runs this file with the system Node, the one pi itself runs on (SPEC-0001, "第 2 步：登录模型";
 * overview.md, "登录程序的例外"). It imports `ModelRuntime` from the installed pi package, so logins
 * go through the same code as pi's `/login` and the credentials land in pi's `auth.json` under pi's
 * own lock. It is never loaded by our processes: it imports only Node built-ins and pi, and uses
 * only syntax Node can strip, since Node runs it as it is.
 *
 * Usage: `node login-worker.ts <pi entry file URL> status | login <provider> <oauth|api_key> | logout <provider>`.
 * stdout carries one JSON {@link WorkerOutput} per line; stdin takes one JSON {@link WorkerInput}
 * per line, an answer to a question, and its end cancels the operation, so cancelling and a host
 * that goes away are the same and the program never outlives the host.
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createInterface } from "node:readline";

/** A provider as the status operation reports it. */
export interface WorkerProvider {
  readonly id: string;
  readonly name: string;
  /** How pi signs in to it by OAuth, or `null` when it has no OAuth login. */
  readonly oauth: { readonly name: string; readonly label: string | null; readonly subscription: boolean } | null;
  /** Whether pi can store an API key for it. */
  readonly apiKey: boolean;
  /** How it is signed in now, or `null`. `stored` is true when the credential is in `auth.json`. */
  readonly signedIn: {
    readonly type: "oauth" | "api_key";
    readonly stored: boolean;
    readonly source: string | null;
  } | null;
}

/** A question pi asks during a login. */
export interface WorkerPrompt {
  readonly kind: "text" | "secret" | "select" | "manual_code";
  readonly message: string;
  readonly placeholder: string | null;
  /** The choices of a `select`; empty otherwise. */
  readonly options: readonly { readonly id: string; readonly label: string }[];
}

/** Something pi tells the user during a login. */
export type WorkerEvent =
  | { readonly kind: "auth_url"; readonly url: string; readonly instructions: string | null }
  | {
      readonly kind: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresInSeconds: number | null;
    }
  | { readonly kind: "progress"; readonly message: string }
  | { readonly kind: "info"; readonly message: string; readonly links: readonly string[] };

/** Why an operation failed. */
export type WorkerFailure = "unavailable" | "aborted" | "failed";

/** One line the program writes. */
export type WorkerOutput =
  | { readonly type: "providers"; readonly providers: readonly WorkerProvider[] }
  | { readonly type: "event"; readonly event: WorkerEvent }
  | { readonly type: "prompt"; readonly promptId: number; readonly prompt: WorkerPrompt }
  | { readonly type: "prompt_closed"; readonly promptId: number }
  | { readonly type: "done" }
  | { readonly type: "failed"; readonly reason: WorkerFailure; readonly message: string | null };

/** One line the program reads: an answer to one of pi's questions. */
export interface WorkerInput {
  readonly promptId: number;
  readonly value: string;
}

/** The part of the pi package the program uses. */
interface PiModule {
  readonly ModelRuntime: typeof ModelRuntime;
  readonly getAgentDir: () => string;
  readonly SettingsManager: { create(cwd: string, agentDir?: string): { getOrCreateDeviceId(): string } };
}

/** A pending question and how to settle it. */
interface Pending {
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Writes one output line.
 *
 * @remarks
 * One JSON object per line, as the host splits on LF.
 *
 * @sideEffects Writes to stdout.
 * @param output - The line.
 */
function send(output: WorkerOutput): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

/**
 * The text of an error, for the user to read.
 *
 * @remarks
 * pi's own words; the host passes them on without logging them.
 *
 * @sideEffects none
 * @param error - What was thrown.
 * @returns Its message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loads the installed pi package.
 *
 * @remarks
 * A missing export means a pi this program does not know how to drive; the host then shows the
 * terminal `/login` instead.
 *
 * @sideEffects Imports pi's modules.
 * @param entry - The file URL of the package's `dist/index.js`.
 * @returns The parts used, or `null` when they are missing.
 */
async function loadPi(entry: string): Promise<PiModule | null> {
  const loaded: Partial<PiModule> = await import(entry);
  const { ModelRuntime: runtime, getAgentDir, SettingsManager: settings } = loaded;
  if (
    typeof runtime?.create !== "function" ||
    typeof getAgentDir !== "function" ||
    typeof settings?.create !== "function"
  ) {
    return null;
  }
  return { ModelRuntime: runtime, getAgentDir, SettingsManager: settings };
}

/**
 * Lists the providers and how each is signed in.
 *
 * @remarks
 * `checkAuth` reads the stored credential and the environment without refreshing tokens, so a
 * credential that is present may still be expired (domain-model §5, "有凭据不等于登录有效").
 *
 * @sideEffects Reads pi's `auth.json` and the environment.
 * @param runtime - pi's model runtime.
 * @returns The providers in pi's order.
 */
async function providersOf(runtime: ModelRuntime): Promise<WorkerProvider[]> {
  const stored = new Set((await runtime.listCredentials()).map((credential) => credential.providerId));
  return Promise.all(
    runtime.getProviders().map(async (provider): Promise<WorkerProvider> => {
      const check = await runtime.checkAuth(provider.id);
      const oauth = provider.auth.oauth;
      return {
        id: provider.id,
        name: provider.name,
        oauth:
          oauth === undefined
            ? null
            : { name: oauth.name, label: oauth.loginLabel ?? null, subscription: oauth.isSubscription === true },
        apiKey: provider.auth.apiKey?.login !== undefined,
        signedIn:
          check === undefined
            ? null
            : { type: check.type, stored: stored.has(provider.id), source: check.source ?? null },
      };
    }),
  );
}

/**
 * Runs pi's login for one provider, asking the host whatever pi asks.
 *
 * @remarks
 * Each question gets an id; the host answers it by id. pi may withdraw a question, as when the
 * browser's callback beats a pasted code, and the host is told so it can close it. Cancelling, or
 * the host going away, aborts the login, which closes pi's callback server.
 *
 * @sideEffects Runs pi's login flow, which listens on a local port and writes `auth.json`; reads stdin.
 * @param pi - The pi package.
 * @param runtime - pi's model runtime.
 * @param providerId - The provider.
 * @param method - OAuth or an API key.
 */
async function login(
  pi: PiModule,
  runtime: ModelRuntime,
  providerId: string,
  method: "oauth" | "api_key",
): Promise<void> {
  const abort = new AbortController();
  const pending = new Map<number, Pending>();
  let nextId = 0;
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    let message: WorkerInput;
    try {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host writes these lines; the login tests check both ends.
      message = JSON.parse(line) as WorkerInput;
    } catch {
      return;
    }
    pending.get(message.promptId)?.resolve(message.value);
  });
  input.on("close", () => abort.abort());
  try {
    await runtime.login(
      providerId,
      method,
      {
        signal: abort.signal,
        prompt: (prompt) => {
          nextId += 1;
          const promptId = nextId;
          const { promise, resolve, reject } = Promise.withResolvers<string>();
          pending.set(promptId, { resolve, reject });
          /**
           * Withdraws the question when pi or the whole login gives up on it.
           *
           * @remarks
           * pi aborts a question's own signal when another path settles that step.
           *
           * @sideEffects Rejects the question; tells the host.
           */
          const withdraw = (): void => {
            // Both signals may fire; the first one withdraws.
            if (!pending.delete(promptId)) return;
            send({ type: "prompt_closed", promptId });
            reject(new Error("question withdrawn"));
          };
          prompt.signal?.addEventListener("abort", withdraw, { once: true });
          abort.signal.addEventListener("abort", withdraw, { once: true });
          send({
            type: "prompt",
            promptId,
            prompt: {
              kind: prompt.type,
              message: prompt.message,
              placeholder: "placeholder" in prompt ? (prompt.placeholder ?? null) : null,
              options: prompt.type === "select" ? prompt.options.map(({ id, label }) => ({ id, label })) : [],
            },
          });
          return promise.finally(() => {
            pending.delete(promptId);
            prompt.signal?.removeEventListener("abort", withdraw);
            abort.signal.removeEventListener("abort", withdraw);
          });
        },
        notify: (event) => {
          switch (event.type) {
            case "auth_url":
              send({
                type: "event",
                event: { kind: "auth_url", url: event.url, instructions: event.instructions ?? null },
              });
              break;
            case "device_code":
              send({
                type: "event",
                event: {
                  kind: "device_code",
                  userCode: event.userCode,
                  verificationUri: event.verificationUri,
                  expiresInSeconds: event.expiresInSeconds ?? null,
                },
              });
              break;
            case "progress":
              send({ type: "event", event: { kind: "progress", message: event.message } });
              break;
            case "info":
              send({
                type: "event",
                event: { kind: "info", message: event.message, links: (event.links ?? []).map(({ url }) => url) },
              });
              break;
          }
        },
      },
      { getDeviceId: () => pi.SettingsManager.create(pi.getAgentDir(), pi.getAgentDir()).getOrCreateDeviceId() },
    );
    send({ type: "done" });
  } catch (error) {
    send({
      type: "failed",
      reason: abort.signal.aborted ? "aborted" : "failed",
      message: abort.signal.aborted ? null : messageOf(error),
    });
  } finally {
    input.close();
  }
}

/**
 * Runs the operation the arguments name.
 *
 * @remarks
 * Model catalogs are not fetched, as pi's own CLI does for auth commands; only credentials matter
 * here. Every outcome ends with one `done` or `failed` line.
 *
 * @sideEffects See the operations.
 * @param args - The pi entry URL, the operation and its arguments.
 */
async function main(args: readonly string[]): Promise<void> {
  const [entry = "", operation, providerId = "", method] = args;
  let pi: PiModule | null;
  try {
    pi = await loadPi(entry);
  } catch (error) {
    send({ type: "failed", reason: "unavailable", message: messageOf(error) });
    return;
  }
  if (pi === null) {
    send({ type: "failed", reason: "unavailable", message: null });
    return;
  }
  try {
    const runtime = await pi.ModelRuntime.create({ allowModelNetwork: false });
    if (operation === "status") {
      send({ type: "providers", providers: await providersOf(runtime) });
      send({ type: "done" });
    } else if (operation === "login") {
      await login(pi, runtime, providerId, method === "api_key" ? "api_key" : "oauth");
    } else if (operation === "logout") {
      await runtime.logout(providerId);
      send({ type: "done" });
    } else {
      send({ type: "failed", reason: "failed", message: `unknown operation ${String(operation)}` });
    }
  } catch (error) {
    send({ type: "failed", reason: "failed", message: messageOf(error) });
  }
}

await main(process.argv.slice(2));
// pi may leave handles open (a keep-alive socket, a timer); the answer is out, so leave once it is flushed.
process.stdout.write("", () => process.exit(0));
