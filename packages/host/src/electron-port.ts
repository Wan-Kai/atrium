import { z } from "zod";
import { isStrongToken } from "./server/auth";

/** The subset of Electron's `parentPort` the host uses; present only in a utility process. */
export interface ParentPort {
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
  // The reason is not shown anywhere: a refused config is reported as "invalid config message".
  token: z.string().refine(isStrongToken),
  uiDir: z.string().optional(),
  extraOrigins: z.array(z.string()).optional(),
});

/** A valid config message. */
export type HostStartRequest = z.infer<typeof ConfigMessage>;

/** Any message that claims to be a config, valid or not. */
const ConfigEnvelope = z.object({ type: z.literal("config") });

/** Asks the host to stop. */
const ShutdownMessage = z.object({ type: z.literal("shutdown") });

/** What `runUnderElectron` needs from the process; `entry.ts` passes the real ones. */
export interface ElectronRuntime {
  /** Starts the host from a valid config message. */
  start(request: HostStartRequest): Promise<{ readonly port: number; close(): Promise<void> }>;
  /** Ends the process. */
  exit(code: number): void;
}

/**
 * Starts the host when it runs inside Electron's utility process.
 *
 * @remarks
 * The token arrives over `parentPort` instead of the command line or environment, which other
 * local processes could read (security.md, "WebSocket 与鉴权"). Startup and shutdown share one
 * promise: a shutdown that arrives while the host is still starting waits for it and then closes
 * it, so the parent never sees `ready` from a host that is about to exit. A failed start is
 * reported and ends the process with a non-zero code instead of leaving it idle. Starting and
 * exiting are passed in, so this race can be tested without Electron.
 *
 * @sideEffects Listens for parent messages; starts the host; posts `ready` or `failed`; stops the
 * host and exits on `shutdown` or after a failed start.
 * @param parentPort - Electron's port to the main process.
 * @param runtime - How to start the host and end the process.
 */
export function runUnderElectron(parentPort: ParentPort, runtime: ElectronRuntime): void {
  let starting: Promise<{ close(): Promise<void> } | null> | undefined;
  let shuttingDown = false;
  parentPort.on("message", ({ data }) => {
    const config = ConfigMessage.safeParse(data);
    if (config.success && starting === undefined) {
      starting = runtime.start(config.data).then(
        (host) => {
          if (!shuttingDown) parentPort.postMessage({ type: "ready", port: host.port });
          return host;
        },
        (error: unknown) => {
          parentPort.postMessage({ type: "failed", message: error instanceof Error ? error.message : String(error) });
          runtime.exit(1);
          return null;
        },
      );
    } else if (!config.success && ConfigEnvelope.safeParse(data).success) {
      parentPort.postMessage({ type: "failed", message: "invalid config message" });
      runtime.exit(1);
    } else if (ShutdownMessage.safeParse(data).success && !shuttingDown) {
      shuttingDown = true;
      // Fire and forget: the process exits at the end of this chain, so nothing awaits it.
      void (starting ?? Promise.resolve(null)).then((host) => host?.close()).finally(() => runtime.exit(0));
    }
  });
}
