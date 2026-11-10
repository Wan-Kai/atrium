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
import { CommandError, isDirectionId } from "@atrium/protocol";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir, hostname, uptime } from "node:os";
import { join } from "node:path";
import type { Level } from "pino";
import packageJson from "../package.json" with { type: "json" };
import { type Clock, systemClock, trackedTimeout } from "./platform/clock";
import type { AppProcessMetrics } from "./electron-port";
import { createChangesService } from "./changes/changes-service";
import { changesSince, createCheckoutReader } from "./changes/checkout";
import { createGitRunner } from "./platform/git";
import { ensureAtriumHome } from "./platform/home";
import { readInstallSeed } from "./platform/install-id";
import { createPiDeps } from "./platform/pi-deps";
import { hasProxy, withProxy } from "./platform/proxy";
import { secretsInEnvironment } from "./platform/redact";
import { type ToolEnv, readLoginShellEnv } from "./platform/login-shell";
import { closeLogFile, createLogger, drainLogFile, openLogFile } from "./platform/logger";
import { catchStrayRejections } from "./platform/stray-rejections";
import { ResourceTracker } from "./platform/resources";
import { setupTracing } from "./platform/tracing";
import { type ProjectService, createProjectService } from "./projects/project-service";
import { findHomebrew, withHomebrewOnPath } from "./setup/homebrew";
import { createLoginService } from "./setup/login-service";
import { runJob } from "./setup/install-job";
import { INSTALL_SCRIPT_URL, downloadScript } from "./setup/install-script";
import { createInstallService } from "./setup/install-service";
import { createLogins } from "./setup/logins";
import { LATEST_VERSION_URL, createPiLatest, fetchLatestPi } from "./setup/pi-latest";
import { createSetupService } from "./setup/setup-service";
import { createPiConfig } from "./setup/pi-config";
import { type HostTools, createToolbox, withProxySetting } from "./setup/toolbox";
import { HOST_TO_PHONE_LIMIT } from "@atrium/remote-crypto";
import type { VaultPort } from "./remote/vault";
import { RemoteService } from "./remote/remote-service";
import { RelayRoute, relayProxy } from "./remote/relay-route";
import { REMOTE_FILE } from "./remote/devices";
import { loadIndexFile } from "./store/index-file";
import { createAttachmentStore } from "./server/attachments";
import { startWsServer } from "./server/ws-server";
import { DIRECTION_VISUALS, type VisualsDir, defaultVisualsDir, visualPlaceOf } from "./visuals/visual-place";
import { createVisualService } from "./visuals/visual-service";
import { openReceipts } from "./remote/receipts";
import { discoverProjects } from "./projects/discovery";
import { createIndexCommands } from "./sessions/index-commands";
import { createFileSearch } from "./files/file-search";
import { createWorkspaceFiles } from "./files/workspace-files";
import { createLayouts } from "./sessions/layouts";
import { createModelLister } from "./sessions/model-lister";
import { withModelRules } from "./sessions/model-rules";
import { createSessionCatalog } from "./sessions/session-catalog";
import { createPlanUsage } from "./sessions/plan-usage";
import { createSessionManager } from "./sessions/session-manager";
import { createReviewHub } from "./reviews/review-hub";
import { createTaskRunner } from "./tasks/runner";
import { createTaskArchiving } from "./tasks/task-archiving";
import { createTaskReviewProvider } from "./tasks/task-reviews";
import { createTaskCommands } from "./tasks/task-commands";
import { followTasks } from "./tasks/followed-tasks";
import { createScheduleCommands } from "./tasks/schedule-commands";
import { type ScheduleService, createScheduleService } from "./tasks/schedule-service";
import { type TaskService, createTaskService } from "./tasks/task-service";
import { createTaskWorkspaces } from "./tasks/task-workspaces";
import { createReplyTranslations, TRANSLATION_OUTPUT_BYTES } from "./sessions/reply-translation";
import { titleModelLookup } from "./sessions/titles";
import { acquireHostLock, processStartedAt } from "./store/host-lock";
import { loadIndex } from "./store/load-index";
import { createChatRecords, listChats } from "./store/chat-records";
import { createPreferenceStore } from "./store/preferences";
import { loadTurnStarts } from "./store/turn-starts";
import { createIndexFeed } from "./sync/index-feed";
import { EventRing } from "./sync/event-ring";
import { SubscriptionRegistry } from "./sync/subscriptions";
import { createMergeInspector, parseGitVersion } from "./workspaces/merge-inspector";
import { createBranchNamer } from "./workspaces/branch-namer";
import { createWorkspaceArchiver } from "./workspaces/workspace-archiver";
import { createWorktreeCreator } from "./workspaces/worktree-creator";
import { homeTagOf } from "./workspaces/worktree-lock";
import { createWorktreeQueue } from "./workspaces/worktree-queue";
import { createWorkspaceService } from "./workspaces/workspace-service";
import { createLearningRecords } from "./store/learning-records";
import { createDirectionCreator } from "./study/direction-creator";
import { createDirectionNamer } from "./study/direction-namer";
import { errorCode } from "./platform/errors";
import { createDirections, directionPlaceSafe, resolveRoot, shownPath } from "./study/directions";
import { withEntries } from "./study/entering";
import { createStudyCommands } from "./study/study-commands";
import { createProgressFiles } from "./study/progress-file";
import { createStudyTools } from "./study/study-tools";

/** How often clients ping the host, and how long they wait for the answer (SPEC-0001, "握手与心跳"). */
const HEARTBEAT_MS = 15_000;

/** Bytes that may wait to be sent to one client before it is dropped (SPEC-0001, "发送端背压"). */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/** Everything needed to start a host. */
export interface HostConfig {
  /** Atrium home directory, normally `~/.atrium`. */
  readonly home: string;
  /**
   * The learning directory, normally `~/Atrium/Learning` (SPEC-0008); `<home>/Learning` when
   * left out, so a host started without it, as in tests, never touches the real one.
   */
  readonly learningRoot?: string;
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
  /**
   * A directory of tasks another process writes (`pnpm task:try`'s `<home>/tasks`) to follow read-only; dev only
   * (`ATRIUM_FOLLOW_TASKS`, SPEC-0006, "T7.1 定下的细节"). Without it, the host follows nothing.
   */
  readonly followTasks?: string;
  /**
   * Whether to take up the tasks that were going when the host last stopped, once pi is found (SPEC-0006, "宿主重启");
   * `true` unless set. `pnpm task:try` turns it off: it looks after the one task it runs itself.
   */
  readonly recoverTasks?: boolean;
  /** The time zone schedule rules count their clock times in; the machine's when left out (tests set one). */
  readonly scheduleTimeZone?: string;
  /** The vault Electron's main process keeps; without it, as when run alone, remote access is unavailable. */
  readonly vault?: VaultPort;
}

/** A running host. */
export interface RunningHost {
  readonly port: number;
  readonly origin: string;
  /** IP address the server is bound to; always loopback. */
  readonly address: string;
  /** Live resource counts, for leak tests and diagnostics. */
  readonly resources: ResourceTracker;
  /** The tasks (SPEC-0006): the protocol's task commands go through them; tests and `task:try` use the handle too. */
  readonly tasks: TaskService;
  /** The schedule rules (SPEC-0006, "定时"); `undefined` while another process's tasks are followed or `recoverTasks` is off. */
  readonly schedules: ScheduleService | undefined;
  /** The projects, for the dev tools that set a host up without a client (`pnpm task:try`). */
  readonly projects: Pick<ProjectService, "add" | "projects" | "workspaces">;
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
 * @sideEffects Creates `~/.atrium` and its logs folder; takes the host lock; opens the log file; logs
 * rejections nobody handled until closed; listens on a port;
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
  const releaseRejections = catchStrayRejections(process, logger);
  for (const directory of home.looseModes) {
    logger.warn({ directory }, "atrium directory is readable by other users; expected mode 0700");
  }
  const tracing = setupTracing({ logger, resources, version: packageJson.version });
  // The phones' sessions keep their recent events, to continue from after a reconnect (SPEC-0005, "MP4c 定的细节").
  const ring = new EventRing(clock, resources);
  const subscriptions = new SubscriptionRegistry(resources, ring);
  // The host's one usage of the subscriptions, sent to every window as it changes (ADR-0011).
  const plans = createPlanUsage({ clock, logger });
  plans.subscribe((found) => subscriptions.broadcast({ type: "plans_updated", plans: found }));
  const hostInstanceId = randomBytes(8).toString("hex");
  const [index, installSeed, remoteIndex, receipts] = await Promise.all([
    loadIndex(home.root, clock.now(), logger),
    readInstallSeed(home.root, randomUUID),
    loadIndexFile(home.root, REMOTE_FILE, clock.now()),
    // A phone's message receipts (SPEC-0005, "MP4b 定的细节").
    openReceipts(join(home.root, "remote"), clock, {
      log: (level, message, fields) => logger[level](fields, message),
    }),
  ]).catch(async (error: unknown) => {
    logger.error({ err: error }, "host failed to start");
    releaseRejections();
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
  const inspector = git.then(async (runner) => {
    if (runner === null) return null;
    const version = await runner.run(["--version"], { cwd: home.root }).catch(() => null);
    return createMergeInspector({ git: runner, version: parseGitVersion(version?.stdout ?? "") });
  });
  const workspaces = createWorkspaceService({
    projects,
    git,
    inspector,
    clock,
    resources,
    logger,
  });
  // Learning directions live outside the home, where the user can see them (SPEC-0008).
  const directions = createDirections({
    root: await resolveRoot(config.learningRoot ?? join(home.root, "Learning")),
    clock,
    resources,
    logger,
  });
  const learningRecords = createLearningRecords(index.learning);
  // The catalog files directions' sessions by their directories: its first scan waits for theirs.
  const directionsFound = directions
    .scan()
    .catch((error: unknown) => logger.warn({ code: errorCode(error) }, "learning directory not scanned"));
  const catalog = createSessionCatalog({
    file: index.sessions,
    location: toolbox.current().then((tools) => (tools === null ? null : sessionsLocation(tools.env))),
    chatsRoot: join(home.root, "chats"),
    workspaces: () => workspaces.list().map((workspace) => ({ id: workspace.id, dir: workspace.dir })),
    // At the directory their sessions run in, archived or not (domain-model §1, Direction).
    directions: () => directions.list().map((direction) => ({ id: direction.id, dir: direction.home })),
    directionsFound: () => directionsFound,
    reader: createSessionFileReader(),
    clock,
    logger,
  });
  // A client going into a direction makes it the one opened last; the commands come below.
  const layouts = withEntries(createLayouts({ file: index.layouts, clock }), (containerId) =>
    study.entered(containerId),
  );
  const chatRecords = createChatRecords(index.chats);
  const feed = createIndexFeed({
    registry: subscriptions,
    generation: hostInstanceId,
    build: () => ({
      projects: projects.projects().map(({ id, path, name, mainBranch }) => ({ id, path, name, mainBranch })),
      workspaces: workspaces.list(),
      chats: listChats(catalog.chats(), chatRecords),
      directions: study.list(),
      sessions: sessions.summaries(),
      preferences: preferences.read(),
      resets: [...index.resets],
      learningDir: shownPath(directions.root, homedir()),
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
      return { dir: workspace.dir, mainBranch: project?.mainBranch ?? null, archived: workspace.archivedAt !== null };
    },
    send: (connectionId, event) => subscriptions.sendTo(connectionId, event),
    clock,
    resources,
    logger,
  });
  const logins = createLogins({
    worker: config.loginWorker,
    deps: (env) => createPiDeps({ clock, resources, logger, env }),
    logger,
  });
  const models = createModelCatalog({
    // Without the models paid by use or reaching a subscription twice (SPEC-0001, "输入框 · 模型选择").
    query: withModelRules(
      async (dir, signal) => {
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
      async () =>
        logins.status(await toolbox.current()).catch((error: unknown) => {
          logger.warn({ err: error }, "login state not read for the model list");
          throw error;
        }),
    ),
    log: logger,
    clock,
  });
  // The title model chosen in the settings, when pi lists it; it names new worktrees' branches too.
  const titleModel = titleModelLookup({
    chosen: () => preferences.read().titleModel,
    list: (dir) => models.list(dir, false),
    chatsRoot: join(home.root, "chats"),
    learningRoot: directions.root,
    // As the model lister asks for chats.
    chatsDir: home.root,
  });
  // Naming must stop before shutdown can fall back to creating a child worktree.
  const worktreeNaming = new AbortController();
  // Who else wants to know the sessions changed: an update waits for running sessions to finish.
  const sessionListeners = new Set<() => void>();
  // What waits for the user's verdict, per session (ADR-0018); the task gates register when the tasks exist.
  const reviewHub = createReviewHub({ logger, resources });
  /**
   * Where a study direction's visuals are, counted from where it is now, with its place's check.
   *
   * @remarks
   * SPEC-0008, "ML4 定的细节 · 演示": `visuals/` in the direction's directory now, under `Archive/`
   * while archived; the direction must be a real directory in the learning directory, read again
   * on each check (security.md, "渲染内容").
   *
   * @sideEffects none
   * @param directionId - The direction.
   * @returns The directory, or `null` for a direction not found.
   */
  function directionVisuals(directionId: string): Required<VisualsDir> | null {
    const found = directions.find(directionId);
    if (found === undefined) return null;
    return {
      dir: join(found.dir, DIRECTION_VISUALS),
      base: found.dir,
      owned: () => directionPlaceSafe(found.dir, directions.root),
    };
  }
  /**
   * Where a session's visuals go.
   *
   * @remarks
   * SPEC-0007: the default one, `~/.atrium/visuals/<id>/`, unless its container gives its own; a
   * study direction's sessions have the direction's `visuals/` (SPEC-0008, ML4).
   *
   * @sideEffects none
   * @param sessionId - The session.
   * @returns The directory, or `null`.
   */
  function visualsDir(sessionId: string): VisualsDir | null {
    const containerId = catalog.find(sessionId)?.containerId;
    if (containerId !== undefined && isDirectionId(containerId)) return directionVisuals(containerId);
    const dir = defaultVisualsDir(home.root, sessionId);
    return dir === null ? null : { dir };
  }
  // Directions' progress, written by the agent's study tools and your marks (SPEC-0008, "ML2 定的细节").
  const progressFiles = createProgressFiles({
    root: directions.root,
    random: () => randomBytes(6).toString("hex"),
    logger,
  });
  const studyTools = createStudyTools({
    // A session archived, or being archived, takes no tool (SPEC-0008, "ML3 定的细节").
    find: (sessionId) => {
      const entry = catalog.find(sessionId);
      return entry === undefined
        ? undefined
        : { ...entry, archived: entry.archived || sessions.isArchiving(sessionId) };
    },
    directions,
    files: progressFiles,
    logger,
  });
  const sessions = createSessionManager({
    reviews: reviewHub,
    study: studyTools,
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
    // An archived direction takes no new session (SPEC-0008).
    directions: {
      dirOf: (directionId) => {
        const found = directions.find(directionId);
        return found === undefined || found.archived ? undefined : found.dir;
      },
      // Its sessions are shown from their files, without pi (SPEC-0008, "ML1 定的细节").
      readOnly: (containerId) => directions.find(containerId)?.archived === true,
    },
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
    // An agent's child goes on an `agent/` branch.
    childWorktree: async (workspaceId, wanted, prefix, naming, signal) => {
      const lifetime = signal === undefined ? worktreeNaming.signal : AbortSignal.any([signal, worktreeNaming.signal]);
      if (lifetime.aborted) throw new CommandError("worktree_create_failed");
      const projectId = projects.workspaces().find((workspace) => workspace.id === workspaceId)?.projectId;
      const alias =
        naming === undefined || projectId === undefined
          ? null
          : await namer.name(projectId, naming.text, naming.model, wanted, lifetime).then(
              (answer) => answer.alias,
              () => null,
            );
      // Shutdown is an expected failure, not a DOMException for the router to log as a crash.
      if (lifetime.aborted) throw new CommandError("worktree_create_failed");
      return creator.createFrom(workspaceId, wanted, prefix, alias);
    },
    // The models an agent may give its children (SPEC-0002, `agent_spawn`, `agent_models`).
    modelCatalog: models,
    // This host's own, so a start of another (a second ATRIUM_HOME) leaves its forks alone (SPEC-0002).
    tempRoot: join(home.root, "tmp"),
    // A work child's delivery gives its branch and what its worktree changed since it was made (SPEC-0002, "交付").
    workChanges: async (workspaceId, signal) => {
      const record = projects.workspaces().find((one) => one.id === workspaceId);
      const runner = await git;
      if (record?.baseCommit == null || runner === null) return { branch: null, changes: null };
      const branch = workspaces.list().find((one) => one.id === workspaceId)?.branch ?? null;
      const stat = await changesSince(runner, record.dir, record.baseCommit, signal).catch((error: unknown) => {
        logger.warn({ workspaceId, err: error }, "work child's changes not read");
        return null;
      });
      return { branch, changes: stat };
    },
    clock,
    resources,
    tracer: tracing.tracer,
    logger,
    newId: () => randomUUID(),
    newSessionId: () => randomUUID(),
    newStream: () => randomUUID(),
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
    visualsDir,
  });
  // Inline visuals (SPEC-0007): each session's directory, its pages, and messages sent from them.
  const visuals = createVisualService({
    // A fork or child also reads the visuals of the sessions it came from (SPEC-0007, MV1 details).
    locate: (sessionId) =>
      visualPlaceOf(
        sessionId,
        (id) => {
          const entry = catalog.find(id);
          return entry === undefined
            ? undefined
            : { cwd: entry.cwd, parent: entry.parent?.sessionId ?? null, detachedFrom: entry.detachedFrom };
        },
        visualsDir,
      ),
    // A direction's viewer tabs read its visuals/ with no session (SPEC-0008, ML4).
    locateDirection: (directionId) => {
      const own = directionVisuals(directionId);
      return own === null ? undefined : { cwd: own.base, dir: own.dir, owned: own.owned };
    },
    steer: (command, source) => sessions.steer(command, [], source),
    send: (connectionId, event) => subscriptions.sendTo(connectionId, event),
    clock,
    resources,
    logger,
  });
  const translations = createReplyTranslations({
    source: (sessionId, turnId) => sessions.replyTranslationSource(sessionId, turnId),
    language: () => preferences.read().translationLanguage,
    run: async (request, signal) => {
      const found = await toolbox.current();
      if (found?.pi.status !== "ready") {
        throw new CommandError("pi_unavailable", { status: found?.pi.status ?? "unknown" });
      }
      return runOneShot(
        { piPath: found.pi.piPath, ...request },
        createPiDeps({ clock, resources, logger, env: found.env }),
        { signal, maxOutputBytes: TRANSLATION_OUTPUT_BYTES, isolateTranslation: true },
      );
    },
  });
  // Names a new direction by its first message and makes its directory (SPEC-0008, "新建方向").
  const directionNamer = createDirectionNamer({
    // As chats are named: the direction's directory is not made yet.
    cwd: home.root,
    titleModel,
    models: (dir) => models.list(dir, false),
    // As a new session starts (SPEC-0008, "真实模型检查后改").
    preferred: () => preferences.preferred()?.model ?? null,
    oneShot: async ({ timeoutMs, ...request }, signal) => {
      const found = await toolbox.current();
      if (found?.pi.status !== "ready") {
        throw new CommandError("pi_unavailable", { status: found?.pi.status ?? "unknown" });
      }
      return runOneShot(
        { piPath: found.pi.piPath, ...request },
        createPiDeps({ clock, resources, logger, env: found.env }),
        { timeoutMs, ...(signal === undefined ? {} : { signal }) },
      );
    },
    logger,
  });
  const study = createStudyCommands({
    directions,
    namer: directionNamer,
    creator: createDirectionCreator({
      root: directions.root,
      git,
      clock,
      random: () => randomBytes(3).toString("hex"),
      logger,
    }),
    records: learningRecords,
    sessions,
    files: progressFiles,
    clock,
    changed: () => feed.changed(),
    logger,
  });
  projects.onChange(() => feed.changed());
  catalog.onChange(() => feed.changed());
  directions.onChange(() => {
    feed.changed();
    // A direction come or moved may hold sessions started in a terminal.
    sessions.rescan();
  });
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
  // Tasks (SPEC-0006): the runner carries out the scheduler's actions on node sessions and worktrees.
  const taskRunner = createTaskRunner({
    sessions: sessions.taskSessions,
    workspaces: createTaskWorkspaces({
      creator,
      projects,
      git,
      root: join(home.root, "tasks"),
      // The conversation the task was made from, else the workspace whose directory it started in.
      sourceContainer: (task) =>
        (task.origin.kind === "chat" ? catalog.find(task.origin.sessionId)?.containerId : undefined) ??
        workspaces.list().find((workspace) => workspace.dir === task.sourceDir)?.id,
      dirOf: (workspaceId) => workspaces.dirOf(workspaceId),
      inspector,
      homeTag: homeTagOf(home.root),
    }),
    git,
    clock,
    logger,
    resources,
  });
  // Schedules (SPEC-0006, "定时"): none while another process's tasks are followed, and none for `pnpm task:try`, which
  // looks after the one task it runs itself. The rules make tasks through the service below and the service saves
  // rules through them, so they are joined after both exist.
  const schedulesWanted = config.followTasks === undefined && config.recoverTasks !== false;
  let schedules: ScheduleService | undefined;
  const ownedTasks: TaskService = createTaskService({
    runner: taskRunner,
    root: join(home.root, "tasks"),
    clock,
    logger,
    ...(schedulesWanted
      ? {
          schedules: {
            confirm: async (template) => {
              const container = catalog.find(template.taskSessionId)?.containerId;
              if (container === undefined)
                throw new CommandError("session_not_found", { sessionId: template.taskSessionId });
              await schedules?.confirm(template, container);
            },
            saved: (templateTaskId) => schedules?.saved(templateTaskId) ?? false,
          },
        }
      : {}),
    archiving: createTaskArchiving({ projects, git, inspector, archiver }),
    design: {
      sessions: sessions.taskSessions,
      // A worktree the source conversation is in is lent to the task; a chat belongs to no project.
      placement: (containerId) => {
        const workspace = projects.workspaces().find((candidate) => candidate.id === containerId);
        return {
          projectId: workspace?.projectId ?? null,
          borrowed:
            workspace?.kind === "worktree"
              ? { workspaceId: workspace.id, baseCommit: workspace.baseCommit ?? null }
              : null,
        };
      },
    },
  });
  // Dev only (SPEC-0006, "T7.1 定下的细节"): the tasks of a `pnpm task:try` run, followed read-only.
  const tasks: TaskService =
    config.followTasks === undefined
      ? ownedTasks
      : await followTasks({
          owned: ownedTasks,
          ownRoot: join(home.root, "tasks"),
          directory: config.followTasks,
          clock,
          resources,
          logger,
        });
  if (schedulesWanted) {
    schedules = createScheduleService({
      file: join(home.root, "schedules.json"),
      clock,
      resources,
      logger,
      tasks: ownedTasks,
      // The same question the recovery of tasks asks: a trigger needs pi to start the task's conversation.
      ready: () => piReady(),
      ...(config.scheduleTimeZone === undefined ? {} : { timeZone: config.scheduleTimeZone }),
    });
  }
  // The task gates (ADR-0018): graph approval, human nodes, the question about the worktree.
  reviewHub.register(
    createTaskReviewProvider({
      service: tasks,
      taskOf: (sessionId) =>
        tasks.held().find((task) => task.taskSessionId === sessionId)?.id ??
        (() => {
          const record = sessions.taskSessions.recordOf(sessionId);
          return record?.role === "conversation" ? record.taskId : undefined;
        })(),
    }),
  );
  const taskCommands = createTaskCommands({
    service: tasks,
    // A template task is listed until the rule it stands for is really saved (T9 / T10 审查后用户定 5).
    saved: (taskId) => schedules?.saved(taskId) ?? false,
    send: (connectionId, event) => subscriptions.sendTo(connectionId, event),
    logger,
    // Opening a task counts its conversation's reviews again: the worktree may have been edited since (T8 review fix 11).
    onOpened: (task) => reviewHub.refresh(task.taskSessionId),
  });
  // The rules are read now, so that a window's commands do not find them missing while pi is still being looked for.
  await schedules?.load();
  // A rule saved or deleted changes how its template task looks (the start button says "saved"), though no task event did.
  schedules?.onChange(() => {
    for (const rule of schedules?.list() ?? []) taskCommands.refresh(rule.templateTaskId);
  });
  const scheduleCommands = createScheduleCommands({
    schedules,
    tasks,
    send: (connectionId, event) => subscriptions.sendTo(connectionId, event),
    logger,
  });
  // Names a new worktree's branch by the first message (SPEC-0001, "AI 起分支名").
  const namer = createBranchNamer({
    projects,
    git,
    titleModel,
    models: (dir) => models.list(dir, false),
    oneShot: async ({ timeoutMs, ...request }, signal) => {
      const found = await toolbox.current();
      if (found?.pi.status !== "ready") {
        throw new CommandError("pi_unavailable", { status: found?.pi.status ?? "unknown" });
      }
      return runOneShot(
        { piPath: found.pi.piPath, ...request },
        createPiDeps({ clock, resources, logger, env: found.env }),
        { timeoutMs, ...(signal === undefined ? {} : { signal }) },
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
        // Fire and forget: a failed scan is logged; the next focus tries again.
        void directions
          .scan()
          .catch((error: unknown) => logger.warn({ code: errorCode(error) }, "learning directory not scanned"));
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
    clock,
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
  const remote = new RemoteService({
    vault: config.vault,
    index: remoteIndex.file,
    clock,
    resources,
    logger,
    hostName: hostname(),
    // The proxy setting, read afresh at every attempt (SPEC-0005, "连 relay 走代理").
    route: new RelayRoute(() => relayProxy(preferences.read().proxy)),
    send: (id, event) => subscriptions.sendTo(id, event),
    accept: (transport, origin) => server.accept(transport, origin),
  });
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
      maxPhoneMessageBytes: HOST_TO_PHONE_LIMIT,
      subscriptions,
      sessions,
      index: indexCommands,
      study,
      containerOfSession: (sessionId) => catalog.find(sessionId)?.containerId,
      setup,
      piConfig: createPiConfig({
        environment: async () => {
          const tools = await toolbox.current();
          if (tools === null) throw new CommandError("config_unavailable");
          return tools.env;
        },
        dirOf: (workspaceId) =>
          workspaces
            .list()
            .find(
              (workspace) =>
                workspace.id === workspaceId && workspace.archivedAt === null && workspace.merge?.verdict !== "removed",
            )?.dir,
      }),
      logins: loginService,
      installs,
      catchUp: () => [
        ...[installs.last(), loginService.last()].filter((event) => event !== null),
        { type: "plans_updated", plans: plans.current() } as const,
      ],
      piLatest,
      remote,
      tasks: taskCommands,
      schedules: scheduleCommands,
      reviews: reviewHub,
      receipts,
      translations,
      attachments,
      changes,
      files: createWorkspaceFiles({
        dirOf: (workspaceId) => workspaces.dirOf(workspaceId),
        // A direction's archive and viewer tabs read it where it is now, archived too (SPEC-0008, ML4).
        directionOf: async (directionId) => {
          const found = directions.find(directionId);
          if (found === undefined) throw new CommandError("direction_not_found");
          if (!(await directionPlaceSafe(found.dir, directions.root))) throw new CommandError("learning_dir_unsafe");
          return found.dir;
        },
        git,
        logger,
      }),
      visuals,
      logger,
      tracer: tracing.tracer,
      clock,
      resources,
    });
  } catch (error) {
    logger.error({ err: error }, "host failed to start");
    // The learning directory is scanned, and so watched, from the start.
    await directions.close();
    releaseRejections();
    await tracing.shutdown();
    await closeLogFile(destination);
    await lock.release();
    throw error;
  }

  remote.start();
  workspaces.start();
  sessions.rescan();
  let cancelReport = scheduleReport();
  toolbox.start();
  piLatest.start();
  const tools = toolbox.current();
  /**
   * Whether pi is found and fit to run.
   *
   * @remarks
   * Asked by the recovery of tasks and by the schedules alike (SPEC-0006, "T9 / T10 审查后用户定"): a node, or the
   * conversation of a scheduled task, needs pi, and a host that cannot run it must not fail them all.
   *
   * @sideEffects none
   * @returns Whether pi's status is `ready`.
   */
  const piReady = async (): Promise<boolean> => (await tools)?.pi.status === "ready";
  // SPEC-0006, "宿主重启": tasks that were going when the host stopped go on, as soon as pi is known to run.
  const recovery = new AbortController();
  const recovering: Promise<void> =
    config.recoverTasks === false
      ? Promise.resolve()
      : tasks
          .recoverAll({
            signal: recovery.signal,
            staleLocks: true,
            ready: piReady,
          })
          .catch((error: unknown) => {
            logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "tasks could not be recovered");
          });

  // SPEC-0006, "定时": once the tasks that were going are taken up and pi is known, read the rules and make up what was
  // missed while the host was off (once per rule); a trigger needs pi to start the task's conversation.
  const scheduling: Promise<void> =
    schedules === undefined
      ? Promise.resolve()
      : recovering
          .then(() =>
            Promise.race([
              tools,
              new Promise<void>((resolve) =>
                recovery.signal.addEventListener("abort", () => resolve(), { once: true }),
              ),
            ]),
          )
          .then(() => (recovery.signal.aborted ? undefined : schedules.start()))
          .catch((error: unknown) => {
            logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "schedules could not be started");
          });

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
              // Closing the host gives up on the read on purpose (observability.md, "日志格式").
              onFailure: (failure) =>
                logger[failure.reason === "aborted" ? "info" : "warn"]({ ...failure }, "login shell attempt failed"),
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
      // No pi is where first launch starts, not a fault (observability.md, "日志格式").
      logger[pi.status === "ready" || pi.status === "missing" ? "info" : "warn"]({ ...pi }, "pi inspected");
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
   * Schedules the next resource report, and the idle sessions' reclaim with it.
   *
   * @remarks
   * A chain of one-shot timers rather than an interval, so a fake clock in tests can drive it and
   * shutdown cancels exactly one pending timer. The reclaim goes by the same minute (SPEC-0001,
   * "空闲回收"), after the report, so the report shows what it was about to let go of.
   *
   * @sideEffects Registers a tracked timer that logs resource counts and memory, stops idle
   * sessions' pi and lets go of controllers nobody needs, then reschedules.
   * @returns The cancel function of the pending timer.
   */
  function scheduleReport(): () => void {
    return trackedTimeout(
      clock,
      resources,
      () => {
        logger.info({ resources: resources.snapshot(), memory: process.memoryUsage() }, "resource usage");
        // First, so a reclaim that throws stops no later report.
        cancelReport = scheduleReport();
        sessions.reclaimIdle();
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
   * @sideEffects Cancels the report timer; aborts tool detection, worktree naming and shared model
   * discovery; closes the server; waits for naming cleanup and the archive or restore under way; cancels the login, the install job and the update check under way; stops login checks, scans,
   * fetches and every session's pi; finishes writing the index; flushes spans; stops logging stray
   * rejections; flushes logs; closes the log file; releases the host lock.
   */
  async function close(): Promise<void> {
    worktreeNaming.abort();
    cancelReport();
    await toolbox.close();
    await remote.close();
    await server.close();
    await translations.close();
    // Naming may be waiting on a shared cold model query: abort both before awaiting either.
    const namingClosed = namer.close();
    const studyClosed = study.close();
    await models.close();
    await namingClosed;
    // Before the sessions, which a direction being created or archived still uses.
    await studyClosed;
    // The progress a tool or a mark is writing goes to disk before the directions close.
    await progressFiles.close();
    // Before the sessions and the index, which a worktree being created, archived or restored still uses.
    await worktreeQueue.idle();
    await loginService.close();
    await installs.close();
    await piLatest.close();
    await logins.close();
    attachments.close();
    await changes.close();
    visuals.close();
    await workspaces.close();
    // Before the sessions, whose stopping the runner would otherwise answer with events.
    recovery.abort();
    // Both are told to stop before either is waited for: a trigger in the middle of starting its task waits for a pi
    // that may never answer, and only the tasks' closing cancels that.
    const schedulesClosed = schedules?.close();
    const tasksClosed = tasks.close();
    await schedulesClosed;
    await scheduling;
    await tasksClosed;
    await recovering;
    await scheduleCommands.close();
    await taskCommands.close();
    await reviewHub.close();
    await sessions.close();
    await catalog.close();
    await directions.close();
    // After the sessions, whose stopping still reports changes.
    feed.close();
    ring.close();
    await receipts.flush();
    await index.flush();
    await tracing.shutdown();
    // Before the log closes, which it writes to.
    releaseRejections();
    logger.info("host stopped");
    await closeLogFile(destination);
    await lock.release();
  }

  return {
    port: server.port,
    origin: server.origin,
    tasks,
    schedules,
    projects,
    address: server.address,
    resources,
    tools,
    logFile,
    flushLog: () => drainLogFile(destination),
    recordAppMetrics: (processes) => logger.info({ processes }, "app metrics"),
    close: () => (closing ??= close()),
  };
}
