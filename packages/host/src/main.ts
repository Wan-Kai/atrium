import {
  createModelCatalog,
  createSessionFileReader,
  findFd,
  inspectNode,
  inspectPi,
  queryModels,
  runOneShot,
  sessionsLocation,
} from "@atrium/pi";
import { CommandError } from "@atrium/protocol";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir, uptime } from "node:os";
import { join } from "node:path";
import type { Level } from "pino";
import packageJson from "../package.json" with { type: "json" };
import { type Clock, systemClock, trackedTimeout } from "./platform/clock";
import type { AppProcessMetrics } from "./electron-port";
import { createChangesService } from "./changes/changes-service";
import { createCheckoutReader } from "./changes/checkout";
import { createGitRunner } from "./platform/git";
import { ensureAtriumHome } from "./platform/home";
import { readInstallSeed } from "./platform/install-id";
import { createPiDeps } from "./platform/pi-deps";
import { hasProxy, withProxy } from "./platform/proxy";
import { secretsInEnvironment } from "./platform/redact";
import { type ToolEnv, readLoginShellEnv } from "./platform/login-shell";
import { closeLogFile, createLogger, drainLogFile, openLogFile } from "./platform/logger";
import { ResourceTracker } from "./platform/resources";
import { setupTracing } from "./platform/tracing";
import { createProjectService } from "./projects/project-service";
import { findHomebrew, withHomebrewOnPath } from "./setup/homebrew";
import { createLoginService } from "./setup/login-service";
import { runJob } from "./setup/install-job";
import { INSTALL_SCRIPT_URL, downloadScript } from "./setup/install-script";
import { createInstallService } from "./setup/install-service";
import { createLogins } from "./setup/logins";
import { LATEST_VERSION_URL, createPiLatest, fetchLatestPi } from "./setup/pi-latest";
import { createSetupService } from "./setup/setup-service";
import { type HostTools, createToolbox, withProxySetting } from "./setup/toolbox";
import { createAttachmentStore } from "./server/attachments";
import { startWsServer } from "./server/ws-server";
import { discoverProjects } from "./projects/discovery";
import { createIndexCommands } from "./sessions/index-commands";
import { createFileSearch } from "./files/file-search";
import { createWorkspaceFiles } from "./files/workspace-files";
import { createLayouts } from "./sessions/layouts";
import { createModelLister } from "./sessions/model-lister";
import { createSessionCatalog } from "./sessions/session-catalog";
import { createPlanUsage } from "./sessions/plan-usage";
import { createSessionManager } from "./sessions/session-manager";
import { titleModelLookup } from "./sessions/titles";
import { acquireHostLock, processStartedAt } from "./store/host-lock";
import { loadIndex } from "./store/load-index";
import { createChatRecords, listChats } from "./store/chat-records";
import { createPreferenceStore } from "./store/preferences";
import { loadTurnStarts } from "./store/turn-starts";
import { createIndexFeed } from "./sync/index-feed";
import { SubscriptionRegistry } from "./sync/subscriptions";
import { createMergeInspector, parseGitVersion } from "./workspaces/merge-inspector";
import { createBranchNamer } from "./workspaces/branch-namer";
import { createWorkspaceArchiver } from "./workspaces/workspace-archiver";
import { createWorktreeCreator } from "./workspaces/worktree-creator";
import { createWorktreeQueue } from "./workspaces/worktree-queue";
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
  /** Atrium's built extension (`dist/atrium-extension.mjs`) sessions' pi loads; without it, there is no Fast nor plan usage. */
  readonly fastExtension?: string;
  /** Where to look for Homebrew after PATH; defaults to where its installer puts it, tests set none. */
  readonly homebrewPlaces?: readonly string[];
  /** Where to look up the latest pi; defaults to pi.dev, as pi does; `null` never looks (tests). */
  readonly piLatestUrl?: string | null;
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
  /** Logs one sample of the desktop app's processes, which Electron's main process cannot log itself. */
  readonly recordAppMetrics: (processes: readonly AppProcessMetrics[]) => void;
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
  const environmentSecrets = new Set<string>();
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
    // Credentials from the tool environment join once it is known (`detectTools`), and stay.
    secrets: () => [config.token, ...environmentSecrets],
    service: "host",
  });
  for (const directory of home.looseModes) {
    logger.warn({ directory }, "atrium directory is readable by other users; expected mode 0700");
  }
  const tracing = setupTracing({ logger, resources, version: packageJson.version });
  const subscriptions = new SubscriptionRegistry(resources);
  // The host's one usage of the subscriptions, sent to every window as it changes (ADR-0011).
  const plans = createPlanUsage({ clock, logger });
  plans.subscribe((found) => subscriptions.broadcast({ type: "plans_updated", plans: found }));
  const hostInstanceId = randomBytes(8).toString("hex");
  const [index, installSeed] = await Promise.all([
    loadIndex(home.root, clock.now(), logger),
    readInstallSeed(home.root, randomUUID),
  ]).catch(async (error: unknown) => {
    logger.error({ err: error }, "host failed to start");
    await tracing.shutdown();
    await closeLogFile(destination);
    await lock.release();
    throw error;
  });
  const preferences = createPreferenceStore(index.preferences);
  // Detection starts once the server listens; commands can only arrive after that. Everything that
  // runs a tool or asks pi.dev sees the proxy set in the settings (SPEC-0001, "设置 · pi").
  const toolbox = withProxySetting(createToolbox(detectTools), () => preferences.read().proxy);
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
  const chatRecords = createChatRecords(index.chats);
  const feed = createIndexFeed({
    registry: subscriptions,
    generation: hostInstanceId,
    build: () => ({
      projects: projects.projects().map(({ id, path, name, mainBranch }) => ({ id, path, name, mainBranch })),
      workspaces: workspaces.list(),
      chats: listChats(catalog.chats(), chatRecords),
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
        config.fastExtension === undefined ? {} : { fastExtension: config.fastExtension },
      );
    },
    clock,
  });
  // The title model chosen in the settings, when pi lists it; it names new worktrees' branches too.
  const titleModel = titleModelLookup({
    chosen: () => preferences.read().titleModel,
    list: (dir) => models.list(dir, false),
    chatsRoot: join(home.root, "chats"),
    // As the model lister asks for chats.
    chatsDir: home.root,
  });
  // Who else wants to know the sessions changed: an update waits for running sessions to finish.
  const sessionListeners = new Set<() => void>();
  const sessions = createSessionManager({
    chatsRoot: join(home.root, "chats"),
    // A pi started while pi is being updated waits, so it is the new one.
    tools: async () => {
      await installs.settled();
      return toolbox.current();
    },
    subscriptions,
    catalog,
    layouts,
    chats: chatRecords,
    // A run ending in a workspace may have changed its files.
    workspaces: {
      dirOf: (workspaceId) => workspaces.dirOf(workspaceId),
      refresh: (workspaceId) => {
        workspaces.refresh(workspaceId);
        changes.refresh(workspaceId);
      },
    },
    onChange: () => {
      feed.changed();
      for (const listener of sessionListeners) listener();
    },
    // A child conversation's new worktree, made as a new workspace is (SPEC-0002); the creator comes below.
    childWorktree: (workspaceId, wanted) => creator.createFrom(workspaceId, wanted),
    clock,
    resources,
    tracer: tracing.tracer,
    logger,
    newId: () => randomUUID(),
    newSessionId: () => randomUUID(),
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
    ...(config.fastExtension === undefined
      ? {}
      : {
          fast: {
            extension: config.fastExtension,
            preferred: () => preferences.read().lastFast,
            chosen: (enabled: boolean) => {
              // Fire and forget: a failed write is logged; the index flushes before the host stops.
              void preferences.rememberFast(enabled).then(
                () => feed.changed(),
                (error: unknown) => logger.warn({ err: error }, "fast choice not remembered"),
              );
            },
          },
        }),
    titleModel,
    plan: plans,
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
  // Creating, archiving and restoring worktrees go one at a time (SPEC-0001, "M1.11 的新建工作区").
  const worktreeQueue = createWorktreeQueue();
  /**
   * Scans a workspace's project again and works out its changes.
   *
   * @remarks
   * After a worktree was created or restored.
   *
   * @sideEffects Asks for a scan and a recount.
   * @param workspaceId - The workspace.
   */
  const rescanWorkspace = (workspaceId: string): void => {
    workspaces.refresh(workspaceId);
    changes.refresh(workspaceId);
  };
  const archiver = createWorkspaceArchiver({
    projects,
    git,
    sessions,
    refresh: rescanWorkspace,
    clock,
    logger,
    queue: worktreeQueue,
  });
  const creator = createWorktreeCreator({ projects, git, queue: worktreeQueue, refresh: rescanWorkspace, logger });
  // Names a new worktree's branch by the first message (SPEC-0001, "AI 起分支名").
  const namer = createBranchNamer({
    projects,
    git,
    titleModel,
    models: (dir) => models.list(dir, false),
    oneShot: async ({ timeoutMs, ...request }) => {
      const found = await toolbox.current();
      if (found?.pi.status !== "ready") {
        throw new CommandError("pi_unavailable", { status: found?.pi.status ?? "unknown" });
      }
      return runOneShot(
        { piPath: found.pi.piPath, ...request },
        createPiDeps({ clock, resources, logger, env: found.env }),
        { timeoutMs },
      );
    },
    logger,
  });
  const indexCommands = createIndexCommands({
    projects,
    workspaces: {
      windowFocused: () => {
        workspaces.windowFocused();
        changes.refresh();
      },
      refresh: (workspaceId) => {
        workspaces.refresh(workspaceId);
        changes.refresh(workspaceId);
      },
    },
    sessions,
    archiver,
    creator,
    namer,
    preferences,
    chats: () => catalog.chats(),
    chatRecords,
    feed,
    listModels: createModelLister({
      catalog: models,
      dirOf: (workspaceId) => workspaces.dirOf(workspaceId),
      chatsDir: home.root,
    }),
    discover: async (taken) => {
      const tools = await toolbox.current();
      return discoverProjects({
        location: tools === null ? null : await sessionsLocation(tools.env),
        taken,
        chatsRoot: join(home.root, "chats"),
      });
    },
  });

  const logins = createLogins({
    worker: config.loginWorker,
    deps: (env) => createPiDeps({ clock, resources, logger, env }),
    logger,
  });
  const piLatest = createPiLatest({
    // Through the proxy pi would use, as pi looks.
    lookup: async (signal) =>
      withProxy((await toolbox.current())?.env ?? {}, (fetch) =>
        fetchLatestPi(config.piLatestUrl ?? LATEST_VERSION_URL, { fetch, signal, clock }),
      ),
    // As pi, which looks for nothing with PI_OFFLINE set.
    offline: async () => config.piLatestUrl === null || Boolean((await toolbox.current())?.env["PI_OFFLINE"]),
    clock,
    resources,
    broadcast: (event) => subscriptions.broadcast(event),
    logger,
  });
  const setup = createSetupService({
    toolbox,
    logins,
    projects: () => projects.projects().length,
    latest: () => piLatest.current(),
  });
  const loginService = createLoginService({
    toolbox,
    logins,
    broadcast: (event) => subscriptions.broadcast(event),
    // The models pi can use may have changed (SPEC-0001, "模型列表"), and every window shows them.
    credentialsChanged: () => {
      models.forget();
      subscriptions.broadcast({ type: "credentials_changed" });
    },
    newId: () => randomUUID(),
    logger,
  });
  const installs = createInstallService({
    toolbox,
    script: async (signal) =>
      withProxy((await toolbox.current())?.env ?? {}, (fetch) =>
        downloadScript(INSTALL_SCRIPT_URL, { fetch, signal, clock }),
      ),
    sessions: {
      running: () => sessions.summaries().filter((summary) => summary.running).length,
      onChange: (listener) => {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
    },
    broadcast: (event) => subscriptions.broadcast(event),
    run: (command, run) => runJob(command, { ...run, clock, resources }),
    afterSuccess: async (kind) => {
      await toolbox.refresh();
      if (kind === "update_pi") await sessions.stopIdle();
    },
    cwd: homedir(),
    newId: () => randomUUID(),
    logger,
  });

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
      installSeed,
      logDir: home.logs,
      maxBufferedBytes: MAX_BUFFERED_BYTES,
      subscriptions,
      sessions,
      index: indexCommands,
      setup,
      logins: loginService,
      installs,
      catchUp: () => [
        ...[installs.last(), loginService.last()].filter((event) => event !== null),
        { type: "plans_updated", plans: plans.current() } as const,
      ],
      piLatest,
      attachments,
      changes,
      files: createWorkspaceFiles({ dirOf: (workspaceId) => workspaces.dirOf(workspaceId), git, logger }),
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
  piLatest.start();
  const tools = toolbox.current();

  /**
   * Reads the login shell's environment, then looks for pi, Node, Homebrew and fd on its PATH.
   *
   * @remarks
   * Runs in the background after the server listens: an interactive login shell can take seconds,
   * which would blow the startup budget (testing.md, "性能预算"). The whole environment is taken so
   * pi behaves as in the user's terminal (SPEC-0001, "第 1 步：安装 pi"); only its source, PATH,
   * size and where a proxy comes from are logged, because it may hold API keys. Closing the host
   * aborts it, and it is counted as a resource, so it cannot outlive the host unnoticed. It never
   * rejects. The toolbox runs it again when first launch asks to refresh. A Homebrew found outside
   * PATH joins its end, so the Node it installs is found (SPEC-0001, "第 1 步：安装 pi").
   *
   * @sideEffects Spawns the login shell, `pi --version` and `node --version`; adds the environment's
   * credentials to what the log redacts; logs the outcome.
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
      const { env: shellEnv, ...origin } = found;
      // Before anything from this environment can reach the log, including the line below. The
      // credentials of an earlier one stay: a pi started before still holds them.
      for (const secret of secretsInEnvironment(shellEnv)) environmentSecrets.add(secret);
      const homebrew = await findHomebrew(shellEnv["PATH"] ?? "", config.homebrewPlaces);
      const env = withHomebrewOnPath(shellEnv, homebrew);
      const path = env["PATH"] ?? "";
      // Only where the proxy comes from: its address stays out of the log (security.md).
      const proxy = preferences.read().proxy === null ? (hasProxy(env) ? "shell" : "none") : ("setting" as const);
      logger.info({ ...origin, path, variables: Object.keys(env).length, proxy }, "tool environment resolved");
      if (signal.aborted) return null;
      const [pi, node, fd] = await Promise.all([
        inspectPi(path, { env, clock, signal }),
        inspectNode(path, { env, clock, signal }),
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
   * @sideEffects Cancels the report timer; aborts tool detection; closes the server; waits for the
   * archive or restore under way; cancels the login, the install job and the update check under way; stops login checks, scans,
   * fetches and every session's pi; finishes writing the index; flushes spans and logs; closes
   * the log file; releases the host lock.
   */
  async function close(): Promise<void> {
    cancelReport();
    await toolbox.close();
    await server.close();
    // Before the sessions and the index, which a worktree being created, archived or restored still uses.
    await worktreeQueue.idle();
    await loginService.close();
    await installs.close();
    await piLatest.close();
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
    recordAppMetrics: (processes) => logger.info({ processes }, "app metrics"),
    close: () => (closing ??= close()),
  };
}
