import { type PiInspection, createSessionFileReader, inspectPi, sessionsLocation } from "@atrium/pi";
import { randomBytes, randomUUID } from "node:crypto";
import { uptime } from "node:os";
import { join } from "node:path";
import type { Level } from "pino";
import packageJson from "../package.json" with { type: "json" };
import { type Clock, systemClock, trackedTimeout } from "./platform/clock";
import { createGitRunner } from "./platform/git";
import { ensureAtriumHome } from "./platform/home";
import { secretsInEnvironment } from "./platform/redact";
import { type ToolEnv, readLoginShellEnv } from "./platform/login-shell";
import { createLogger, openLogFile } from "./platform/logger";
import { ResourceTracker } from "./platform/resources";
import { setupTracing } from "./platform/tracing";
import { createProjectService } from "./projects/project-service";
import { startWsServer } from "./server/ws-server";
import { createIndexCommands } from "./sessions/index-commands";
import { createLayouts } from "./sessions/layouts";
import { createSessionCatalog } from "./sessions/session-catalog";
import { createSessionManager } from "./sessions/session-manager";
import { acquireHostLock, processStartedAt } from "./store/host-lock";
import { loadIndex } from "./store/load-index";
import { createPreferenceStore } from "./store/preferences";
import { loadTurnStarts } from "./store/turn-starts";
import { createIndexFeed } from "./sync/index-feed";
import { SubscriptionRegistry } from "./sync/subscriptions";
import { createMergeInspector, parseGitVersion } from "./workspaces/merge-inspector";
import { createWorkspaceService } from "./workspaces/workspace-service";

/** How often clients ping the host, and how long they wait for the answer (SPEC-0001, "握手与心跳"). */
const HEARTBEAT_MS = 15_000;

/** Bytes that may wait to be sent to one client before it is dropped (SPEC-0001, "发送端背压"). */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

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
  /**
   * Environment for finding and running pi. When omitted, it is read from the user's login shell;
   * tests set it so no shell runs.
   */
  readonly toolEnv?: Readonly<Record<string, string>>;
}

/** The tools the host found after starting. */
export interface HostTools {
  /** Environment for pi and the tools it runs; its PATH is where pi was looked for. */
  readonly env: Readonly<Record<string, string>>;
  /** Where `env` came from: the login shell, the host's own environment, or `HostConfig.toolEnv`. */
  readonly envSource: ToolEnv["source"] | "configured";
  readonly pi: PiInspection;
}

/** A running host. */
export interface RunningHost {
  readonly port: number;
  readonly origin: string;
  /** IP address the server is bound to; always loopback. */
  readonly address: string;
  /** Live resource counts, for leak tests and diagnostics. */
  readonly resources: ResourceTracker;
  /** Resolves once PATH is known and pi has been looked for; `null` if the host closed first or detection failed. */
  readonly tools: Promise<HostTools | null>;
  /** Path that always points at the log file being written. */
  readonly logFile: string;
  /** Writes buffered log records to disk now. */
  readonly flushLog: () => void;
  /** Disconnects clients, flushes logs and spans, and stops listening; later calls share the first. */
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
 * If listening fails, everything opened so far is released before the error is rethrown, so a
 * failed start leaves no open file or tracer behind.
 *
 * The host takes `host.lock` before anything else in the home, so a second host on the same home
 * refuses to start rather than writing the index alongside the first (domain-model §1, "索引的存储").
 *
 * @sideEffects Creates `~/.atrium` and its logs folder; takes the host lock; opens the log file; listens on a port;
 * schedules a recurring resource report; starts looking for pi in the background; on a failed
 * start, logs the failure and closes the log.
 * @param config - Host configuration.
 * @returns The running host.
 * @throws {HostLockedError} When another live host uses the same home.
 */
export async function startHost(config: HostConfig): Promise<RunningHost> {
  const clock = config.clock ?? systemClock;
  let environmentSecrets: readonly string[] = [];
  const home = await ensureAtriumHome(config.home);
  const now = clock.now();
  const lock = await acquireHostLock(home.root, {
    pid: process.pid,
    now,
    bootedAt: now - uptime() * 1000,
    processStartedAt,
  });
  const { stream: destination, currentPath: logFile } = await openLogFile(home.logs);
  const resources = new ResourceTracker();
  const logger = createLogger({
    destination,
    level: config.logLevel ?? "info",
    // Credentials from the tool environment join once it is known (`detectTools`).
    secrets: () => [config.token, ...environmentSecrets],
    service: "host",
  });
  for (const directory of home.looseModes) {
    logger.warn({ directory }, "atrium directory is readable by other users; expected mode 0700");
  }
  const tracing = setupTracing({ logger, resources, version: packageJson.version });
  const subscriptions = new SubscriptionRegistry(resources);
  const hostInstanceId = randomBytes(8).toString("hex");
  // Settled with the detection below once the server listens; commands can only arrive after that.
  const toolsFound = Promise.withResolvers<HostTools | null>();
  const index = await loadIndex(home.root, clock.now(), logger).catch(async (error: unknown) => {
    logger.error({ err: error }, "host failed to start");
    await tracing.shutdown();
    await closeLog();
    await lock.release();
    throw error;
  });
  const git = toolsFound.promise.then((tools) =>
    tools === null ? null : createGitRunner({ env: tools.env, clock, resources }),
  );
  const projects = createProjectService({
    file: index.projects,
    git,
    newId: (prefix) => `${prefix}_${randomBytes(8).toString("hex")}`,
  });
  const workspaces = createWorkspaceService({
    projects,
    git,
    inspector: git.then(async (runner) => {
      if (runner === null) return null;
      const version = await runner.run(["--version"], { cwd: home.root }).catch(() => null);
      return createMergeInspector({ git: runner, version: parseGitVersion(version?.stdout ?? "") });
    }),
    clock,
    resources,
    logger,
  });
  const catalog = createSessionCatalog({
    file: index.sessions,
    location: toolsFound.promise.then((tools) => (tools === null ? null : sessionsLocation(tools.env))),
    chatsRoot: join(home.root, "chats"),
    workspaces: () => workspaces.list().map((workspace) => ({ id: workspace.id, dir: workspace.dir })),
    reader: createSessionFileReader(),
    clock,
    logger,
  });
  const layouts = createLayouts({ file: index.layouts, clock });
  const preferences = createPreferenceStore(index.preferences);
  const feed = createIndexFeed({
    registry: subscriptions,
    generation: hostInstanceId,
    build: (clientId) => ({
      projects: projects.projects().map(({ id, path, name }) => ({ id, path, name })),
      workspaces: workspaces.list(),
      sessions: sessions.summaries(),
      layout: layouts.of(clientId),
      preferences: preferences.read(),
      resets: [...index.resets],
    }),
    clock,
    resources,
  });
  const sessions = createSessionManager({
    chatsRoot: join(home.root, "chats"),
    tools: toolsFound.promise,
    subscriptions,
    catalog,
    layouts,
    workspaces,
    onChange: () => feed.changed(),
    clock,
    resources,
    tracer: tracing.tracer,
    logger,
    newId: () => randomUUID(),
    turnStarts: async (sessionId) => {
      const { starts, setAside } = await loadTurnStarts(home.root, sessionId, clock.now());
      if (setAside !== null) logger.warn({ sessionId }, "turn starts file was damaged and has been reset");
      return starts;
    },
  });
  projects.onChange(() => feed.changed());
  catalog.onChange(() => feed.changed());
  workspaces.onChange(() => {
    feed.changed();
    // New worktrees may hold sessions started in a terminal.
    sessions.rescan();
  });
  const indexCommands = createIndexCommands({ projects, workspaces, sessions, preferences, feed });

  /**
   * Flushes and closes the log stream.
   *
   * @remarks
   * Shared by normal shutdown and by the rollback when startup fails, so a failed start still
   * leaves its records on disk and no open file behind.
   *
   * @sideEffects Writes buffered records and closes the log file.
   */
  async function closeLog(): Promise<void> {
    destination.flushSync();
    await new Promise<void>((done) => {
      destination.once("close", () => done());
      destination.end();
    });
  }

  let server: Awaited<ReturnType<typeof startWsServer>>;
  try {
    server = await startWsServer({
      token: config.token,
      port: config.port ?? 0,
      uiDir: config.uiDir,
      extraOrigins: config.extraOrigins ?? [],
      handshakeTimeoutMs: config.handshakeTimeoutMs ?? 5_000,
      maxPayloadBytes: 1024 * 1024,
      limits: { maxConnections: 32, messagesPerSecond: 200, bytesPerSecond: 8 * 1024 * 1024 },
      hostVersion: packageJson.version,
      hostInstanceId,
      heartbeatMs: HEARTBEAT_MS,
      maxBufferedBytes: MAX_BUFFERED_BYTES,
      subscriptions,
      sessions,
      index: indexCommands,
      logger,
      tracer: tracing.tracer,
      clock,
      resources,
    });
  } catch (error) {
    logger.error({ err: error }, "host failed to start");
    await tracing.shutdown();
    await closeLog();
    await lock.release();
    throw error;
  }

  workspaces.start();
  sessions.rescan();
  let cancelReport = scheduleReport();
  const stopDetecting = new AbortController();
  const tools = detectTools();
  toolsFound.resolve(tools);

  /**
   * Reads the login shell's environment, then looks for pi on its PATH.
   *
   * @remarks
   * Runs in the background after the server listens: an interactive login shell can take seconds,
   * which would blow the startup budget (testing.md, "性能预算"). The whole environment is taken so
   * pi behaves as in the user's terminal (SPEC-0001, "第 1 步：安装 pi"); only its source, PATH and
   * size are logged, because it may hold API keys. Closing the host aborts it, and it is counted
   * as a resource, so it cannot outlive the host unnoticed. It never rejects.
   *
   * @sideEffects Spawns the login shell and `pi --version`; logs the outcome.
   * @returns The tools found, or `null` if the host closed first or detection failed.
   */
  async function detectTools(): Promise<HostTools | null> {
    const release = resources.acquire("tools.detect");
    const signal = stopDetecting.signal;
    try {
      const found: ToolEnv | { source: "configured"; env: Readonly<Record<string, string>> } =
        config.toolEnv === undefined
          ? await readLoginShellEnv({
              shell: process.env["SHELL"],
              env: process.env,
              clock,
              signal,
              onFailure: (failure) => logger.warn({ ...failure }, "login shell attempt failed"),
            })
          : { source: "configured", env: config.toolEnv };
      const path = found.env["PATH"] ?? "";
      const { env, ...origin } = found;
      // Before anything from this environment can reach the log, including the line below.
      environmentSecrets = secretsInEnvironment(env);
      logger.info({ ...origin, path, variables: Object.keys(env).length }, "tool environment resolved");
      if (signal.aborted) return null;
      const pi = await inspectPi(path, { env, clock, signal });
      if (signal.aborted) return null;
      logger[pi.status === "ready" ? "info" : "warn"]({ ...pi }, "pi inspected");
      return { env, envSource: found.source, pi };
    } catch (error) {
      // Nothing above is expected to throw; if something does, the host keeps running without pi.
      logger.error({ err: error }, "tool detection failed");
      return null;
    } finally {
      release();
    }
  }

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

  let closing: Promise<void> | undefined;

  /**
   * Stops detection, the server, the sessions' pi processes, tracing and logging, in that order.
   *
   * @remarks
   * `RunningHost.close` runs this once and hands every later caller the same promise, so closing
   * twice (a test's own call plus its cleanup) waits for the first close instead of failing.
   *
   * @sideEffects Cancels the report timer; aborts tool detection; closes the server; stops scans,
   * fetches and every session's pi; finishes writing the index; flushes spans and logs; closes
   * the log file; releases the host lock.
   */
  async function close(): Promise<void> {
    cancelReport();
    stopDetecting.abort();
    await tools;
    await server.close();
    feed.close();
    await workspaces.close();
    await sessions.close();
    await catalog.close();
    await index.flush();
    await tracing.shutdown();
    logger.info("host stopped");
    await closeLog();
    await lock.release();
  }

  return {
    port: server.port,
    origin: server.origin,
    address: server.address,
    resources,
    tools,
    logFile,
    flushLog: () => destination.flushSync(),
    close: () => (closing ??= close()),
  };
}
