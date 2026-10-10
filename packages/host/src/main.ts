import {
  createModelCatalog,
  createSessionFileReader,
  findFd,
  inspectNode,
  inspectPi,
  queryModels,
  sessionsLocation,
} from "@atrium/pi";
import { CommandError } from "@atrium/protocol";
import { randomBytes, randomUUID } from "node:crypto";
import { uptime } from "node:os";
import { join } from "node:path";
import type { Level } from "pino";
import packageJson from "../package.json" with { type: "json" };
import { type Clock, systemClock, trackedTimeout } from "./platform/clock";
import { createChangesService } from "./changes/changes-service";
import { createCheckoutReader } from "./changes/checkout";
import { createGitRunner } from "./platform/git";
import { ensureAtriumHome } from "./platform/home";
import { createPiDeps } from "./platform/pi-deps";
import { secretsInEnvironment } from "./platform/redact";
import { type ToolEnv, readLoginShellEnv } from "./platform/login-shell";
import { closeLogFile, createLogger, drainLogFile, openLogFile } from "./platform/logger";
import { ResourceTracker } from "./platform/resources";
import { setupTracing } from "./platform/tracing";
import { createProjectService } from "./projects/project-service";
import { findHomebrew } from "./setup/homebrew";
import { createLogins } from "./setup/logins";
import { createSetupService } from "./setup/setup-service";
import { type HostTools, createToolbox } from "./setup/toolbox";
import { createAttachmentStore } from "./server/attachments";
import { startWsServer } from "./server/ws-server";
import { createIndexCommands } from "./sessions/index-commands";
import { createFileSearch } from "./files/file-search";
import { createLayouts } from "./sessions/layouts";
import { createModelLister } from "./sessions/model-lister";
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
  /** The built login program (`dist/login-worker.mjs`); without it, logins are unavailable. */
  readonly loginWorker?: string;
  /** Where to look for Homebrew after PATH; defaults to where its installer puts it, tests set none. */
  readonly homebrewPlaces?: readonly string[];
}

/** A running host. */
export interface RunningHost {
  readonly port: number;
  readonly origin: string;
  /** IP address the server is bound to; always loopback. */
  readonly address: string;
  /** Live resource counts, for leak tests and diagnostics. */
  readonly resources: ResourceTracker;
  /** Resolves once PATH is known and the tools have been looked for; `null` if the host closed first or detection failed. */
  readonly tools: Promise<HostTools | null>;
  /** Path that always points at the log file being written. */
  readonly logFile: string;
  /** Resolves once every log record so far is on disk, in order. */
  readonly flushLog: () => Promise<void>;
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
  // Detection starts once the server listens; commands can only arrive after that.
  const toolbox = createToolbox(detectTools);
  const index = await loadIndex(home.root, clock.now(), logger).catch(async (error: unknown) => {
    logger.error({ err: error }, "host failed to start");
    await tracing.shutdown();
    await closeLogFile(destination);
    await lock.release();
    throw error;
  });
  // git keeps the first environment: its PATH only has to reach git, which installing pi or Node does not move.
  const git = toolbox
    .current()
    .then((tools) => (tools === null ? null : createGitRunner({ env: tools.env, clock, resources })));
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
    location: toolbox.current().then((tools) => (tools === null ? null : sessionsLocation(tools.env))),
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
    build: () => ({
      projects: projects.projects().map(({ id, path, name }) => ({ id, path, name })),
      workspaces: workspaces.list(),
      sessions: sessions.summaries(),
      preferences: preferences.read(),
      resets: [...index.resets],
    }),
    layoutOf: (clientId) => layouts.of(clientId),
    clock,
    resources,
  });
  // Workspaces' git changes, for the workspaces some connection shows (SPEC-0001, "工作区改动").
  const changes = createChangesService({
    reader: git.then((runner) => (runner === null ? null : createCheckoutReader(runner))),
    resolve: (workspaceId) => {
      const workspace = workspaces.list().find((one) => one.id === workspaceId);
      if (workspace === undefined) return undefined;
      const project = projects.projects().find((one) => one.id === workspace.projectId);
      return { dir: workspace.dir, mainBranch: project?.mainBranch ?? null };
    },
    send: (connectionId, event) => subscriptions.sendTo(connectionId, event),
    clock,
    resources,
    logger,
  });
  const sessions = createSessionManager({
    chatsRoot: join(home.root, "chats"),
    tools: () => toolbox.current(),
    subscriptions,
    catalog,
    layouts,
    // A run ending in a workspace may have changed its files.
    workspaces: {
      dirOf: (workspaceId) => workspaces.dirOf(workspaceId),
      refresh: (workspaceId) => {
        workspaces.refresh(workspaceId);
        changes.refresh(workspaceId);
      },
    },
    onChange: () => feed.changed(),
    clock,
    resources,
    tracer: tracing.tracer,
    logger,
    newId: () => randomUUID(),
    files: createFileSearch({
      findFd: async () => {
        const found = await toolbox.current();
        return found === null ? null : findFd(found.env);
      },
      clock,
      resources,
    }),
    models: {
      preferred: () => preferences.preferred(),
      chosen: (model) => {
        // Fire and forget: a failed write is logged; the index flushes before the host stops.
        void preferences.remember(model).then(
          () => feed.changed(),
          (error: unknown) => logger.warn({ err: error }, "model choice not remembered"),
        );
      },
    },
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
    // A scan or fetch may have moved a branch or the main branch.
    changes.refresh();
    // New worktrees may hold sessions started in a terminal.
    sessions.rescan();
  });
  const models = createModelCatalog({
    query: async (dir, signal) => {
      const found = await toolbox.current();
      if (found?.pi.status !== "ready") {
        throw new CommandError("pi_unavailable", { status: found?.pi.status ?? "unknown" });
      }
      return queryModels(
        { piPath: found.pi.piPath, args: [], cwd: dir },
        createPiDeps({ clock, resources, logger, env: found.env }),
        signal,
      );
    },
    clock,
  });
  const indexCommands = createIndexCommands({
    projects,
    workspaces: {
      windowFocused: () => {
        workspaces.windowFocused();
        changes.refresh();
      },
    },
    sessions,
    preferences,
    feed,
    listModels: createModelLister({
      catalog: models,
      dirOf: (workspaceId) => workspaces.dirOf(workspaceId),
      chatsDir: home.root,
    }),
  });

  const logins = createLogins({
    worker: config.loginWorker,
    deps: (env) => createPiDeps({ clock, resources, logger, env }),
    logger,
  });
  const setup = createSetupService({ toolbox, logins, projects: () => projects.projects().length });

  // Up to 32 MiB and 20 images per connection, let go after 30 minutes unused (SPEC-0001, "附件").
  const attachments = createAttachmentStore({
    clock,
    newId: () => randomUUID(),
    maxBytes: 32 * 1024 * 1024,
    maxCount: 20,
    keepMs: 30 * 60_000,
  });
  let server: Awaited<ReturnType<typeof startWsServer>>;
  try {
    server = await startWsServer({
      token: config.token,
      port: config.port ?? 0,
      uiDir: config.uiDir,
      extraOrigins: config.extraOrigins ?? [],
      handshakeTimeoutMs: config.handshakeTimeoutMs ?? 5_000,
      maxPayloadBytes: 1024 * 1024,
      // No less than a connection may keep in uploads, so 20 images sent at once fit (security.md).
      limits: { maxConnections: 32, messagesPerSecond: 200, bytesPerSecond: 32 * 1024 * 1024 },
      hostVersion: packageJson.version,
      hostInstanceId,
      heartbeatMs: HEARTBEAT_MS,
      maxBufferedBytes: MAX_BUFFERED_BYTES,
      subscriptions,
      sessions,
      index: indexCommands,
      setup,
      attachments,
      changes,
      logger,
      tracer: tracing.tracer,
      clock,
      resources,
    });
  } catch (error) {
    logger.error({ err: error }, "host failed to start");
    await tracing.shutdown();
    await closeLogFile(destination);
    await lock.release();
    throw error;
  }

  workspaces.start();
  sessions.rescan();
  let cancelReport = scheduleReport();
  toolbox.start();
  const tools = toolbox.current();

  /**
   * Reads the login shell's environment, then looks for pi, Node, Homebrew and fd on its PATH.
   *
   * @remarks
   * Runs in the background after the server listens: an interactive login shell can take seconds,
   * which would blow the startup budget (testing.md, "性能预算"). The whole environment is taken so
   * pi behaves as in the user's terminal (SPEC-0001, "第 1 步：安装 pi"); only its source, PATH and
   * size are logged, because it may hold API keys. Closing the host aborts it, and it is counted
   * as a resource, so it cannot outlive the host unnoticed. It never rejects. The toolbox runs it
   * again when first launch asks to refresh.
   *
   * @sideEffects Spawns the login shell, `pi --version` and `node --version`; logs the outcome.
   * @param signal - Aborted when the host closes.
   * @returns The tools found, or `null` if the host closed first or detection failed.
   */
  async function detectTools(signal: AbortSignal): Promise<HostTools | null> {
    const release = resources.acquire("tools.detect");
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
      const [pi, node, homebrew, fd] = await Promise.all([
        inspectPi(path, { env, clock, signal }),
        inspectNode(path, { env, clock, signal }),
        findHomebrew(path, config.homebrewPlaces),
        findFd(env),
      ]);
      if (signal.aborted) return null;
      logger[pi.status === "ready" ? "info" : "warn"]({ ...pi }, "pi inspected");
      logger.info({ node: node.status, homebrew: homebrew !== null, fd: fd !== null }, "setup tools inspected");
      return { env, envSource: found.source, pi, node, homebrew, fd };
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
   * @sideEffects Cancels the report timer; aborts tool detection; closes the server; stops login checks, scans,
   * fetches and every session's pi; finishes writing the index; flushes spans and logs; closes
   * the log file; releases the host lock.
   */
  async function close(): Promise<void> {
    cancelReport();
    await toolbox.close();
    await server.close();
    await logins.close();
    attachments.close();
    await changes.close();
    await workspaces.close();
    await sessions.close();
    await models.close();
    await catalog.close();
    // After the sessions, whose stopping still reports changes.
    feed.close();
    await index.flush();
    await tracing.shutdown();
    logger.info("host stopped");
    await closeLogFile(destination);
    await lock.release();
  }

  return {
    port: server.port,
    origin: server.origin,
    address: server.address,
    resources,
    tools,
    logFile,
    flushLog: () => drainLogFile(destination),
    close: () => (closing ??= close()),
  };
}
