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

/**
 * One process of the desktop app as Electron's `app.getAppMetrics()` reports it, every minute.
 *
 * @remarks
 * Electron's main process has no log of its own, so it hands these to the host, which logs them
 * next to its own resource counts (observability.md, "和测试的关系"). The bounds keep a broken
 * sender from flooding the log.
 */
const AppProcessMetrics = z.object({
  type: z.string().max(64),
  memoryKb: z.number().int().nonnegative(),
  cpuPercent: z.number().nonnegative(),
});

/** A valid entry of an app metrics message. */
export type AppProcessMetrics = z.infer<typeof AppProcessMetrics>;

/** The desktop app's processes, sampled once. */
const AppMetricsMessage = z.object({ type: z.literal("app_metrics"), processes: z.array(AppProcessMetrics).max(256) });

/** What `runUnderElectron` needs from a started host. */
interface ElectronHost {
  readonly port: number;
  /** Stops the host. */
  close(): Promise<void>;
  /** Logs one sample of the desktop app's processes. */
  recordAppMetrics(processes: readonly AppProcessMetrics[]): void;
}

/** What `runUnderElectron` needs from the process; `entry.ts` passes the real ones. */
export interface ElectronRuntime {
  /** Starts the host from a valid config message. */
  start(request: HostStartRequest): Promise<ElectronHost>;
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
 * exiting are passed in, so this race can be tested without Electron. App metrics go only to a
 * host that is ready and not shutting down; others are dropped, since a missed sample costs
 * nothing.
 *
 * @sideEffects Listens for parent messages; starts the host; posts `ready` or `failed`; hands app
 * metrics to the running host; stops the host and exits on `shutdown` or after a failed start.
 * @param parentPort - Electron's port to the main process.
 * @param runtime - How to start the host and end the process.
 */
export function runUnderElectron(parentPort: ParentPort, runtime: ElectronRuntime): void {
  let starting: Promise<ElectronHost | null> | undefined;
  let running: ElectronHost | undefined;
  let shuttingDown = false;
  parentPort.on("message", ({ data }) => {
    const config = ConfigMessage.safeParse(data);
    if (config.success && starting === undefined) {
      starting = runtime.start(config.data).then(
        (host) => {
          if (!shuttingDown) {
            running = host;
            parentPort.postMessage({ type: "ready", port: host.port });
          }
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
      running = undefined;
      // Fire and forget: the process exits at the end of this chain, so nothing awaits it.
      void (starting ?? Promise.resolve(null)).then((host) => host?.close()).finally(() => runtime.exit(0));
    } else {
      const metrics = AppMetricsMessage.safeParse(data);
      if (metrics.success) running?.recordAppMetrics(metrics.data.processes);
    }
  });
}
