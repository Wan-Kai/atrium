import type { Level } from "pino";
import packageJson from "../package.json" with { type: "json" };
import { type Clock, systemClock, trackedTimeout } from "./platform/clock";
import { ensureAtriumHome } from "./platform/home";
import { createLogger, openLogFile } from "./platform/logger";
import { createRedactor } from "./platform/redact";
import { ResourceTracker } from "./platform/resources";
import { setupTracing } from "./platform/tracing";
import { startWsServer } from "./server/ws-server";

/** Everything needed to start a host. */
export interface HostConfig {
  /** Atrium home directory, normally `~/.atrium`. */
  readonly home: string;
  /** Token clients must present. */
  readonly token: string;
  /** Port to listen on; defaults to 0 (any free port). */
  readonly port?: number;
  /** Built UI to serve over HTTP. */
  readonly uiDir?: string;
  /** Extra browser origins allowed to connect, such as the Vite dev server. */
  readonly extraOrigins?: readonly string[];
  readonly logLevel?: Level;
  readonly clock?: Clock;
  readonly handshakeTimeoutMs?: number;
}

/** A running host. */
export interface RunningHost {
  readonly port: number;
  readonly origin: string;
  /** Live resource counts, for leak tests and diagnostics. */
  readonly resources: ResourceTracker;
  /** Path that always points at the log file being written. */
  readonly logFile: string;
  /** Writes buffered log records to disk now. */
  readonly flushLog: () => void;
  /** Disconnects clients, flushes logs and spans, and stops listening. */
  readonly close: () => Promise<void>;
}

const RESOURCE_REPORT_INTERVAL_MS = 60_000;

/**
 * Assembles and starts a host: home directory, logging, tracing and the WebSocket server.
 *
 * @remarks
 * This is the only place the host's services are wired together (overview.md, "宿主内部的依赖").
 * It has no Electron dependency, so the same function runs under Electron's utility process, as
 * a plain `node` process, and in-process in tests. Resource counts and memory are logged every
 * minute so leaks in real use show up in the log (testing.md, "运行时监控").
 *
 * @sideEffects Creates `~/.atrium` and its logs folder; opens the log file; listens on a port;
 * schedules a recurring resource report.
 * @param config - Host configuration.
 * @returns The running host.
 */
export async function startHost(config: HostConfig): Promise<RunningHost> {
  const clock = config.clock ?? systemClock;
  const home = await ensureAtriumHome(config.home);
  const { stream: destination, currentPath: logFile } = await openLogFile(home.logs);
  const resources = new ResourceTracker();
  const logger = createLogger({
    destination,
    level: config.logLevel ?? "info",
    redact: createRedactor(() => [config.token]),
    service: "host",
  });
  const tracing = setupTracing({ logger, resources, version: packageJson.version });
  const server = await startWsServer({
    token: config.token,
    port: config.port ?? 0,
    uiDir: config.uiDir,
    extraOrigins: config.extraOrigins ?? [],
    handshakeTimeoutMs: config.handshakeTimeoutMs ?? 5_000,
    maxPayloadBytes: 1024 * 1024,
    hostVersion: packageJson.version,
    logger,
    tracer: tracing.tracer,
    clock,
    resources,
  });

  let cancelReport = scheduleReport();

  /**
   * Schedules the next resource report.
   *
   * @remarks
   * A chain of one-shot timers rather than an interval, so a fake clock in tests can drive it and
   * shutdown cancels exactly one pending timer.
   *
   * @sideEffects Registers a tracked timer that logs resource counts and memory, then reschedules.
   * @returns The cancel function of the pending timer.
   */
  function scheduleReport(): () => void {
    return trackedTimeout(
      clock,
      resources,
      () => {
        logger.info({ resources: resources.snapshot(), memory: process.memoryUsage() }, "resource usage");
        cancelReport = scheduleReport();
      },
      RESOURCE_REPORT_INTERVAL_MS,
    );
  }

  return {
    port: server.port,
    origin: server.origin,
    resources,
    logFile,
    flushLog: () => destination.flushSync(),
    close: async () => {
      cancelReport();
      await server.close();
      await tracing.shutdown();
      logger.info("host stopped");
      destination.flushSync();
      await new Promise<void>((done) => {
        destination.once("close", () => done());
        destination.end();
      });
    },
  };
}
