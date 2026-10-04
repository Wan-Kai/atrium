import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type HostConfig, type RunningHost, startHost } from "./main";
import { isStrongToken } from "./server/auth";

/** The subset of Electron's `parentPort` the host uses; present only in a utility process. */
interface ParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

/**
 * Configuration the desktop app sends right after forking the host.
 *
 * @remarks
 * The parent is trusted, but the message is still validated so a malformed one cannot start a
 * host without a proper token.
 */
const ConfigMessage = z.object({
  type: z.literal("config"),
  token: z.string().refine(isStrongToken, "token must be at least 32 random bytes in base64url"),
  uiDir: z.string().optional(),
  extraOrigins: z.array(z.string()).optional(),
});

/** Any message that claims to be a config, valid or not. */
const ConfigEnvelope = z.object({ type: z.literal("config") });

/** Asks the host to stop. */
const ShutdownMessage = z.object({ type: z.literal("shutdown") });

/**
 * Builds the host configuration shared by both ways of starting.
 *
 * @remarks
 * `ATRIUM_HOME` lets tests and developers point the host at another home directory.
 *
 * @sideEffects Reads environment variables.
 * @param token - Session token.
 * @param uiDir - Built UI to serve, if any.
 * @param extraOrigins - Extra allowed origins, if any.
 * @returns The configuration.
 */
function configFor(token: string, uiDir: string | undefined, extraOrigins: readonly string[] | undefined): HostConfig {
  return {
    home: process.env["ATRIUM_HOME"] ?? join(homedir(), ".atrium"),
    token,
    ...(uiDir === undefined ? {} : { uiDir }),
    ...(extraOrigins === undefined ? {} : { extraOrigins }),
  };
}

/**
 * Starts the host when it runs inside Electron's utility process.
 *
 * @remarks
 * The token arrives over `parentPort` instead of the command line or environment, which other
 * local processes could read (security.md, "WebSocket 与鉴权"). Startup and shutdown share one
 * promise: a shutdown that arrives while the host is still starting waits for it and then closes
 * it, so the parent never sees `ready` from a host that is about to exit. A failed start is
 * reported and ends the process with a non-zero code instead of leaving it idle.
 *
 * @sideEffects Listens for parent messages; starts the host; posts `ready` or `failed`; stops the
 * host and exits on `shutdown` or after a failed start.
 * @param parentPort - Electron's port to the main process.
 */
function runUnderElectron(parentPort: ParentPort): void {
  let starting: Promise<RunningHost | null> | undefined;
  let shuttingDown = false;
  parentPort.on("message", ({ data }) => {
    const config = ConfigMessage.safeParse(data);
    if (config.success && starting === undefined) {
      starting = startHost(configFor(config.data.token, config.data.uiDir, config.data.extraOrigins)).then(
        (host) => {
          if (!shuttingDown) parentPort.postMessage({ type: "ready", port: host.port });
          return host;
        },
        (error: unknown) => {
          parentPort.postMessage({ type: "failed", message: error instanceof Error ? error.message : String(error) });
          process.exit(1);
          return null;
        },
      );
    } else if (!config.success && ConfigEnvelope.safeParse(data).success) {
      parentPort.postMessage({ type: "failed", message: "invalid config message" });
      process.exit(1);
    } else if (ShutdownMessage.safeParse(data).success && !shuttingDown) {
      shuttingDown = true;
      // Fire and forget: the process exits at the end of this chain, so nothing awaits it.
      void (starting ?? Promise.resolve(null)).then((host) => host?.close()).finally(() => process.exit(0));
    }
  });
}

/**
 * Starts the host as a standalone Node process.
 *
 * @remarks
 * Lets the host run without Electron (overview.md, "桌面端怎么启动宿主"). The connection details
 * are printed once to stdout, the operator's terminal, and never to the log file. A token is
 * generated when `ATRIUM_TOKEN` is not set; a weak one is refused, as in the Electron path.
 *
 * @sideEffects Starts the host; prints one JSON line to stdout; stops on SIGINT or SIGTERM.
 * @throws {Error} When `ATRIUM_TOKEN` is set but too weak.
 */
async function runStandalone(): Promise<void> {
  const token = process.env["ATRIUM_TOKEN"] ?? randomBytes(32).toString("base64url");
  if (!isStrongToken(token)) throw new Error("ATRIUM_TOKEN must be at least 32 random bytes in base64url");
  const host = await startHost({
    ...configFor(token, process.env["ATRIUM_UI_DIR"], undefined),
    port: Number(process.env["ATRIUM_PORT"] ?? 0),
  });
  process.stdout.write(`${JSON.stringify({ type: "ready", url: host.origin, token })}\n`);

  /**
   * Stops the host and exits.
   *
   * @remarks
   * Closing first flushes logs and spans, so the last records are not lost.
   *
   * @sideEffects Closes the host and exits the process.
   */
  function stop(): void {
    // Fire and forget: the process exits at the end of this chain, so nothing awaits it.
    void host.close().finally(() => process.exit(0));
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (parentPort === undefined) {
  runStandalone().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
} else {
  runUnderElectron(parentPort);
}
