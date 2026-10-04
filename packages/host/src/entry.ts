import { randomBytes } from "node:crypto";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { type HostConfig, type RunningHost, startHost } from "./main";

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
  token: z.string().min(32),
  uiDir: z.string().optional(),
  extraOrigins: z.array(z.string()).optional(),
});

/** Asks the host to stop. */
const ShutdownMessage = z.object({ type: z.literal("shutdown") });

/**
 * Starts the host when it runs inside Electron's utility process.
 *
 * @remarks
 * The token arrives over `parentPort` instead of the command line or environment, which other
 * local processes could read (security.md, "WebSocket 与鉴权").
 *
 * @sideEffects Listens for parent messages; starts the host; posts `ready` or `failed` back;
 * stops the host and exits on `shutdown`.
 * @param parentPort - Electron's port to the main process.
 */
function runUnderElectron(parentPort: ParentPort): void {
  let host: RunningHost | undefined;
  parentPort.on("message", ({ data }) => {
    const config = ConfigMessage.safeParse(data);
    if (config.success && host === undefined) {
      void start({
        home: process.env["ATRIUM_HOME"] ?? join(homedir(), ".atrium"),
        token: config.data.token,
        ...(config.data.uiDir === undefined ? {} : { uiDir: config.data.uiDir }),
        ...(config.data.extraOrigins === undefined ? {} : { extraOrigins: config.data.extraOrigins }),
      });
    } else if (ShutdownMessage.safeParse(data).success) {
      void (host?.close() ?? Promise.resolve()).finally(() => process.exit(0));
    }
  });

  /**
   * Starts the host and reports the outcome to the parent.
   *
   * @remarks
   * The parent waits for exactly one `ready` or `failed` message before opening a window.
   *
   * @sideEffects Starts the host; posts one message to the parent.
   * @param config - Host configuration built from the parent's message.
   */
  async function start(config: HostConfig): Promise<void> {
    try {
      host = await startHost(config);
      parentPort.postMessage({ type: "ready", port: host.port });
    } catch (error) {
      parentPort.postMessage({ type: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * Starts the host as a standalone Node process.
 *
 * @remarks
 * Lets the host run without Electron (overview.md, "桌面端怎么启动宿主"). The connection details
 * are printed once to stdout, the operator's terminal, and never to the log file. A token is
 * generated when `ATRIUM_TOKEN` is not set.
 *
 * @sideEffects Starts the host; prints one JSON line to stdout; stops on SIGINT or SIGTERM.
 */
async function runStandalone(): Promise<void> {
  const token = process.env["ATRIUM_TOKEN"] ?? randomBytes(32).toString("base64url");
  const uiDir = process.env["ATRIUM_UI_DIR"];
  const host = await startHost({
    home: process.env["ATRIUM_HOME"] ?? join(homedir(), ".atrium"),
    token,
    port: Number(process.env["ATRIUM_PORT"] ?? 0),
    ...(uiDir === undefined ? {} : { uiDir }),
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
