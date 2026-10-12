import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ParentPort, runUnderElectron } from "./electron-port";
import { type HostConfig, startHost } from "./main";
import { isStrongToken } from "./server/auth";

/**
 * Builds the host configuration shared by both ways of starting.
 *
 * @remarks
 * `ATRIUM_HOME` lets tests and developers point the host at another home directory;
 * `ATRIUM_PI_LATEST_URL` where it looks up the latest pi, empty for nowhere, so tests stay off the
 * network.
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
    // Built next to this bundle (build.mjs).
    loginWorker: join(__dirname, "login-worker.mjs"),
    fastExtension: join(__dirname, "fast-extension.mjs"),
    ...(uiDir === undefined ? {} : { uiDir }),
    ...(extraOrigins === undefined ? {} : { extraOrigins }),
    ...piLatestUrlFor(process.env["ATRIUM_PI_LATEST_URL"]),
  };
}

/**
 * Where the host looks up the latest pi, from `ATRIUM_PI_LATEST_URL`.
 *
 * @remarks
 * Unset keeps the default, pi.dev; empty looks nowhere.
 *
 * @sideEffects none
 * @param value - The variable's value, if set.
 * @returns The part of the configuration it sets.
 */
function piLatestUrlFor(value: string | undefined): Pick<HostConfig, "piLatestUrl"> {
  if (value === undefined) return {};
  return { piLatestUrl: value === "" ? null : value };
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
  runUnderElectron(parentPort, {
    start: (request) => startHost(configFor(request.token, request.uiDir, request.extraOrigins)),
    exit: (code) => process.exit(code),
  });
}
