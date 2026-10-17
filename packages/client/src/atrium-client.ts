import {
  CloseCode,
  type ClientIssueKind,
  type Command,
  CommandError,
  CommandResult,
  type CommandType,
  type ContainerId,
  type DiffTarget,
  type HelloMessage,
  HostMessage,
  type InstallUpdatedEvent,
  type InteractionAnswer,
  type LoginMethod,
  type LoginUpdatedEvent,
  type ModelRef,
  PROTOCOL_VERSION,
  type PiLatest,
  type Plans,
  type Preferences,
  type SessionEvent,
  type SessionModel,
  type ThinkingLevel,
  type TraceContext,
  createTraceContext,
  formatTraceparent,
} from "@atrium/protocol";
import { type StoreApi, createStore } from "zustand/vanilla";
import {
  type IndexView,
  applyIndexChanges,
  applyIndexSnapshot,
  cursorOf,
  emptyIndex,
  withContainer,
  withPreferences,
  withTabClosed,
  withTabOpen,
} from "./index-view";
import { type ChangesView, type DiffView, diffViewOf } from "./changes-view";
import { type ModelListView, UNASKED_MODELS } from "./model-list";
import { type SetupView, UNASKED_SETUP } from "./setup-view";
import {
  type MessageTag,
  type PendingMessage,
  type SessionView,
  applySessionEvent,
  loadingView,
  prependOlder,
  withWholeStep,
} from "./session-view";

/** Connection state exposed to the UI. */
export type ConnectionState =
  | { readonly status: "idle" }
  | { readonly status: "connecting"; readonly traceId: string }
  | {
      readonly status: "connected";
      readonly traceId: string;
      readonly hostVersion: string;
      /** Changes when the host restarts. */
      readonly hostInstanceId: string;
      /** The seed of this install's dot pattern. */
      readonly installSeed: number;
      /** The folder of the host's logs. */
      readonly logDir: string;
    }
  /** The connection dropped; another attempt is scheduled. */
  | { readonly status: "reconnecting"; readonly attempt: number; readonly code: number }
  | { readonly status: "rejected"; readonly reason: RejectionReason }
  | { readonly status: "disconnected"; readonly code: number };

/** Why the host refused the connection; the UI turns these into text. */
export type RejectionReason =
  | "unauthorized"
  | "version-mismatch"
  | "bad-handshake"
  | "handshake-timeout"
  | "rate-limited"
  | "too-many-connections";

/**
 * The WebSocket surface the client uses; the browser's and Node's both match it.
 *
 * @remarks
 * Not exported from the package. `globals.d.ts` types the global `WebSocket` with it, which
 * knip cannot see, hence the tag.
 *
 * @public
 */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
}

/** Timers the client schedules; tests pass a fake clock. */
export interface ClientClock {
  setTimeout(callback: () => void, ms: number): () => void;
}

/** Options for {@link createAtriumClient}. */
export interface AtriumClientOptions {
  /** WebSocket URL of the host, such as `ws://127.0.0.1:4317`. */
  readonly url: string;
  /** Token to present in `hello`. */
  readonly token: string;
  /** Stable id of this client, used by the host for per-client layout. */
  readonly clientId: string;
  /** Opens a socket; defaults to the global `WebSocket`. */
  readonly openSocket?: (url: string) => SocketLike;
  /** Starts a trace for an action; injectable for deterministic tests. */
  readonly createTrace?: () => TraceContext;
  /** Defaults to the global timers. */
  readonly clock?: ClientClock;
  /** Waits before each reconnect attempt, in order, the last repeating; empty turns reconnecting off. */
  readonly reconnectDelaysMs?: readonly number[];
}

/** An install job as the host last reported it, with its output so far. */
export interface InstallJob {
  readonly job: InstallUpdatedEvent;
  /** Raw, with colours and carriage returns, for the UI to render. */
  readonly output: string;
}

/** How many of the latest messages sent with images keep their previews. */
const SENT_PREVIEWS = 50;

/** How much of an install job's output a client keeps: the last 1 MiB of characters. */
const MAX_INSTALL_OUTPUT = 1_048_576;

/** The one entry point to the host: connection state, session views and commands. */
export interface AtriumClient {
  /** Connection state, as a Zustand vanilla store the UI subscribes to. */
  readonly connection: StoreApi<ConnectionState>;
  /** Opens the socket and authenticates; resolves with the first outcome. Reconnects on its own afterwards. */
  connect(): Promise<ConnectionState>;
  /** Closes the socket and stops reconnecting. */
  disconnect(): void;
  /** The list: projects, workspaces, sessions, this client's layout and the preferences. */
  readonly index: StoreApi<IndexView>;
  /** The view of a watched session; `undefined` for one not watched. */
  session(sessionId: string): StoreApi<SessionView> | undefined;
  /** Sets the sessions to receive live events for; views are created for new ones and dropped for the rest. */
  watch(sessionIds: readonly string[]): Promise<void>;
  /** Creates a chat with its first session, opened as the active tab, and returns the session's id. */
  createChat(): Promise<CommandResult<"create_chat">>;
  /**
   * Creates a session in a workspace or chat, opened as the active tab, and returns its id; with
   * `go` false the client stays where it is.
   */
  createSession(containerId: ContainerId, go?: boolean): Promise<CommandResult<"create_session">>;
  /** Opens a session as the active tab, at once in the list; `watch` it to see it. */
  openSession(sessionId: string): Promise<CommandResult<"open_session">>;
  /** Closes this client's tab of a session, at once in the list. */
  closeTab(sessionId: string): Promise<CommandResult<"close_tab">>;
  /** Goes to a workspace or a chat, or nowhere, at once in the list. */
  selectContainer(containerId: ContainerId | null): Promise<CommandResult<"select_container">>;
  archiveSession(sessionId: string): Promise<CommandResult<"archive_session">>;
  renameSession(sessionId: string, name: string): Promise<CommandResult<"rename_session">>;
  /** Marks a session's error as seen (SPEC-0001, "会话状态"). */
  clearAttention(sessionId: string): Promise<CommandResult<"clear_attention">>;
  /** Hands a session to pi in a terminal and returns its file (SPEC-0001, "交给终端"). */
  handOff(sessionId: string): Promise<CommandResult<"hand_off">>;
  /** Takes a session handed off back into Atrium. */
  takeBack(sessionId: string): Promise<CommandResult<"take_back">>;
  addProject(path: string): Promise<CommandResult<"add_project">>;
  removeProject(projectId: string): Promise<CommandResult<"remove_project">>;
  renameProject(projectId: string, name: string): Promise<CommandResult<"rename_project">>;
  /** Names a workspace, or with `null` goes back to its branch's name. */
  renameWorkspace(workspaceId: string, name: string | null): Promise<CommandResult<"rename_workspace">>;
  /** Archives a worktree workspace, removing its directory and keeping its branch. */
  archiveWorkspace(workspaceId: string): Promise<CommandResult<"archive_workspace">>;
  /** Brings an archived workspace back, adding its worktree where it was. */
  restoreWorkspace(workspaceId: string): Promise<CommandResult<"restore_workspace">>;
  /** Where a new worktree of a project may start: its main branch, its local workspace's branch, every branch. */
  listBases(projectId: string): Promise<CommandResult<"list_bases">>;
  /** Creates a worktree workspace on a new branch from a base. */
  createWorkspace(projectId: string, branch: string, base: string): Promise<CommandResult<"create_workspace">>;
  /** Asks a model for a new worktree's branch name by the first message, on the page's model or `null`. */
  nameBranch(projectId: string, text: string, model: ModelRef | null): Promise<CommandResult<"name_branch">>;
  /** Names a chat, or with `null` goes back to its first session's title. */
  renameChat(chatId: string, name: string | null): Promise<CommandResult<"rename_chat">>;
  /** Archives a chat with its sessions, stopping those that run. */
  archiveChat(chatId: string): Promise<CommandResult<"archive_chat">>;
  /** Brings an archived chat back with the sessions archived with it. */
  restoreChat(chatId: string): Promise<CommandResult<"restore_chat">>;
  /** Tells the host the window gained focus, so it looks at workspaces and sessions again. */
  windowFocused(): Promise<CommandResult<"window_focused">>;
  /** Changes preferences, at once in the list; a proxy shows once the host has checked it. */
  setPreferences(changes: Partial<Preferences>): Promise<CommandResult<"set_preferences">>;
  /**
   * Sends a message with uploaded images, showing it at once as pending until it opens a turn or
   * goes into the queue; `previews` are the images as the page shows them, kept for `sentPreviews`;
   * `command` is the tag it was sent with, for the pending copy only.
   */
  prompt(
    sessionId: string,
    text: string,
    attachmentIds?: readonly string[],
    previews?: readonly string[],
    command?: MessageTag,
  ): Promise<CommandResult<"prompt">>;
  /** Sends a steer, delivered before the agent's next step; while idle it is sent as a message, pending meanwhile. */
  steer(
    sessionId: string,
    text: string,
    attachmentIds?: readonly string[],
    previews?: readonly string[],
    command?: MessageTag,
  ): Promise<CommandResult<"steer">>;
  /**
   * The previews of the images a message sent from this page went with, by its `clientMessageId`;
   * `null` for others (SPEC-0001, "消息下方的信息").
   */
  sentPreviews(clientMessageId: string): readonly string[] | null;
  /** Uploads one compressed image for a later message (SPEC-0001, "附件"). */
  uploadAttachment(
    mimeType: "image/webp" | "image/png" | "image/jpeg" | "image/gif",
    data: string,
  ): Promise<CommandResult<"upload_attachment">>;
  /** Stops the session's run; resolves with whether pi confirmed within two seconds. */
  stop(sessionId: string): Promise<CommandResult<"stop">>;
  resumeQueue(sessionId: string): Promise<CommandResult<"resume_queue">>;
  clearQueue(sessionId: string): Promise<CommandResult<"clear_queue">>;
  updateQueued(sessionId: string, itemId: string, text: string): Promise<CommandResult<"update_queued">>;
  removeQueued(sessionId: string, itemId: string): Promise<CommandResult<"remove_queued">>;
  steerQueued(sessionId: string, itemId: string): Promise<CommandResult<"steer_queued">>;
  answerInteraction(
    sessionId: string,
    interactionId: string,
    answer: InteractionAnswer,
  ): Promise<CommandResult<"answer_interaction">>;
  /** The error card's "重试". */
  retryRun(sessionId: string): Promise<CommandResult<"retry_run">>;
  /** The models of a workspace, or with `null` of every chat and the settings, as far as asked; the same store every time. */
  models(workspaceId: string | null): StoreApi<ModelListView>;
  /** Asks the host for a workspace's models, or with `null` those outside any; `refresh` makes pi look again. Failures land in the list. */
  loadModels(workspaceId: string | null, refresh?: boolean): Promise<void>;
  /** Switches a session's model, at once in its view; put back if the host refuses. */
  setModel(sessionId: string, model: ModelRef): Promise<CommandResult<"set_model">>;
  /** Sets a session's thinking level, at once in its view; put back if the host refuses. */
  setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<CommandResult<"set_thinking_level">>;
  /** Switches a session's Fast, at once in its view; put back if the host refuses (SPEC-0001, "Fast"). */
  setFast(sessionId: string, enabled: boolean): Promise<CommandResult<"set_fast">>;
  /** Compacts a session's context now, with what to keep in mind when given (SPEC-0001, "M1.11 的 `/` 命令 · 压缩"). */
  compactSession(sessionId: string, instructions?: string): Promise<CommandResult<"compact_session">>;
  /** A session as pi's HTML page, for `/export` to download. */
  exportSession(sessionId: string): Promise<CommandResult<"export_session">>;
  /**
   * Forks a session after a turn into a new one with this name, which the host opens as the active
   * tab (SPEC-0001, "M1.11 的 `/` 命令 · 分叉").
   */
  forkSession(sessionId: string, turnId: string, name: string): Promise<CommandResult<"fork_session">>;
  /** The `/` commands of a session's pi, which starts if it has not. */
  listCommands(sessionId: string): Promise<CommandResult<"list_commands">>;
  /** Files and directories for `@` in a session's directory. */
  searchFiles(sessionId: string, query: string): Promise<CommandResult<"search_files">>;
  /** One directory of a workspace, for the right panel's file tree (SPEC-0001, "M1.12 的文件与更改"). */
  listDir(workspaceId: string, path: string): Promise<CommandResult<"list_dir">>;
  /** One file of a workspace, for a viewer tab (SPEC-0001, "M1.12 的文件与更改"). */
  readFile(workspaceId: string, path: string): Promise<CommandResult<"read_file">>;
  /** One image of a turn's user message, for its thumbnail (SPEC-0001, "M1.11 的消息图片"). */
  fetchImage(sessionId: string, turnId: string, index: number): Promise<CommandResult<"fetch_image">>;
  /**
   * What first launch checks, as far as asked. Asked again on its own once asked before: when a
   * login or install job succeeds, after a logout, and on reaching a new host; the latest pi the
   * host finds is put in at once.
   */
  readonly setup: StoreApi<SetupView>;
  /** Asks the host what first launch checks; `refresh` has it read the login shell again first. Failures land in the store. */
  loadSetup(refresh?: boolean): Promise<void>;
  /**
   * The latest state of a login, whichever window started it; `null` until the host reports one.
   * Only the window whose `login` returned its id opens its address.
   */
  readonly loginState: StoreApi<LoginUpdatedEvent | null>;
  /** Signs in to a provider through pi, cancelling a login under way; `key` is for `api_key`. */
  login(providerId: string, method: LoginMethod, key?: string): Promise<CommandResult<"login">>;
  /** Answers one of pi's questions in the login under way. */
  answerLogin(loginId: string, promptId: number, value: string): Promise<CommandResult<"answer_login">>;
  /** Cancels the login under way. */
  cancelLogin(loginId: string): Promise<CommandResult<"cancel_login">>;
  /** Removes the credential pi stored for a provider. */
  logout(providerId: string): Promise<CommandResult<"logout">>;
  /**
   * The install job the host last reported, whichever window started it, and its output since
   * this client heard of it (the last {@link MAX_INSTALL_OUTPUT} characters); `null` until then.
   */
  readonly installJob: StoreApi<InstallJob | null>;
  /**
   * Every subscription's usage the host found (SPEC-0001, "M1.14 的套餐总览"), as the host last
   * pushed it: right after each welcome, then on each change; none until then.
   */
  readonly plans: StoreApi<Plans>;
  /** Runs pi's official install script. */
  installPi(): Promise<CommandResult<"install_pi">>;
  /** Installs Node.js with Homebrew. */
  installNode(): Promise<CommandResult<"install_node">>;
  /** Runs `pi update` once no session is running. */
  updatePi(): Promise<CommandResult<"update_pi">>;
  /** Cancels the install job under way. */
  cancelInstall(jobId: string): Promise<CommandResult<"cancel_install">>;
  /** Has the host look for the latest pi now; what it finds lands in {@link setup}. */
  checkPiUpdate(): Promise<CommandResult<"check_pi_update">>;
  /** The working directories of pi's past sessions that could become projects. */
  discoverProjects(): Promise<CommandResult<"discover_projects">>;
  /** The branches on a project's `origin`, and the one `origin/HEAD` points at. */
  listBranches(projectId: string): Promise<CommandResult<"list_branches">>;
  /** Chooses a project's main branch, or with `null` follows `origin/HEAD` again. */
  setMainBranch(projectId: string, branch: string | null): Promise<CommandResult<"set_main_branch">>;
  /**
   * Fetches the page before the earliest item of a watched session; does nothing when there is
   * none, and joins a fetch already on its way.
   */
  loadOlder(sessionId: string): Promise<void>;
  /** Fetches a step that arrived as a preview and puts it whole in the session's view. */
  loadStep(sessionId: string, turnId: string, stepId: string): Promise<void>;
  /** Reports a UI problem to the host's log. */
  reportIssue(kind: ClientIssueKind, message: string, details?: string): Promise<void>;
  /** A workspace's git changes as the host sends them, while it is shown (SPEC-0001, "工作区改动"). */
  changes(workspaceId: string): StoreApi<ChangesView>;
  /** Says which workspaces are shown, on this connection and every later one. */
  watchChanges(workspaceIds: readonly string[]): Promise<void>;
  /** What the changes panel shows. */
  readonly diff: StoreApi<DiffView>;
  /** Opens the changes panel on a target, or closes it with `null`, on this connection and every later one. */
  watchDiff(target: DiffTarget | null): Promise<void>;
}

/**
 * A command that cannot get an answer because the connection is gone.
 *
 * @remarks
 * Its result is unknown, so it is not resent (domain-model §7); the caller decides what to tell
 * the user.
 *
 * @sideEffects none
 */
export class ConnectionLostError extends Error {
  override readonly name = "ConnectionLostError";

  /**
   * Creates the error.
   *
   * @remarks
   * Names the command type, never user-facing text.
   *
   * @sideEffects none
   * @param command - The command type.
   */
  constructor(readonly command: string) {
    super(`connection lost before ${command} was answered`);
  }
}

const REJECTIONS: Partial<Record<number, RejectionReason>> = {
  [CloseCode.Unauthorized]: "unauthorized",
  [CloseCode.VersionMismatch]: "version-mismatch",
  [CloseCode.BadHandshake]: "bad-handshake",
  [CloseCode.HandshakeTimeout]: "handshake-timeout",
  [CloseCode.RateLimited]: "rate-limited",
  [CloseCode.TooManyConnections]: "too-many-connections",
};

const DEFAULT_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000];
/** Close code the client uses when the host stops answering pings. */
const HEARTBEAT_LOST = 4000;
const MAX_ISSUE_LENGTH = 4096;

/** How many items one scroll back fetches. */
const OLDER_PAGE_ITEMS = 50;

/** A command as callers give it, without the envelope the client fills in. */
type CommandFields<T extends CommandType> = Omit<Extract<Command, { type: T }>, "type" | "requestId" | "traceparent">;

/** The platform's timers. */
const systemClock: ClientClock = {
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

// Stryker disable ConditionalExpression,BlockStatement: a binary frame or broken JSON fails the schema check just like `undefined`.
/**
 * Parses JSON without throwing.
 *
 * @remarks
 * Frames from the network may be malformed; the caller treats `undefined` as "ignore".
 *
 * @sideEffects none
 * @param data - Frame payload.
 * @returns The parsed value, or `undefined`.
 */
function parseFrame(data: unknown): unknown {
  if (typeof data !== "string") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}
// Stryker restore ConditionalExpression,BlockStatement

/**
 * The latest pi found later of two.
 *
 * @remarks
 * A `check_setup` answer and a `pi_latest` push can cross; whichever was found later holds
 * (SPEC-0001, "设置 · 接口"). One never found is older than any found.
 *
 * @sideEffects none
 * @param held - The one held now.
 * @param other - The other.
 * @returns The one found later; `held` when neither was.
 */
function newerLatest(held: PiLatest, other: PiLatest): PiLatest {
  // Stryker disable next-line EqualityOperator: two looks at the same moment found the same.
  const { latest, checkedAt } = (other.checkedAt ?? -1) > (held.checkedAt ?? -1) ? other : held;
  return { latest, checkedAt };
}

/**
 * Creates the client: the only way the UI talks to the host.
 *
 * @remarks
 * Owns the socket, the connection state and one SessionView store per watched session, and
 * exposes only stores and command methods (domain-model §7). Every command gets a fresh trace
 * and request id and waits for its one response (SPEC-0001, "应答"); a failure rejects with
 * `CommandError`. A dropped connection fails the commands still waiting with
 * `ConnectionLostError` and is retried with backoff; on reconnecting the watched sessions are
 * subscribed again, and the new connection sends each one's snapshot. A refused handshake is not
 * retried. After the welcome the client pings every `heartbeatMs` and treats a ping unanswered
 * within as long as a dead connection (SPEC-0001, "握手与心跳"). Calling `connect` again replaces
 * the socket; a replaced socket's late events are ignored. The client does not use the DOM.
 *
 * @sideEffects none until `connect`; then opens sockets, schedules timers and updates stores.
 * @param options - Host URL, token, client id, and injectable socket, trace, clock and delays.
 * @returns The client.
 */
export function createAtriumClient(options: AtriumClientOptions): AtriumClient {
  const connection = createStore<ConnectionState>(() => ({ status: "idle" }));
  const index = createStore<IndexView>(emptyIndex);
  const loginState = createStore<LoginUpdatedEvent | null>(() => null);
  const installJob = createStore<InstallJob | null>(() => null);
  const setup = createStore<SetupView>(() => UNASKED_SETUP);
  const plans = createStore<Plans>(() => []);
  let setupAsks = 0;
  /** The latest pi the host pushed, kept while no `check_setup` answer holds it. */
  // Stryker disable next-line ObjectLiteral: an empty one reads as never found, just as nulls do.
  let pushedLatest: PiLatest = { latest: null, checkedAt: null };
  const openSocket: (url: string) => SocketLike = options.openSocket ?? ((url: string) => new WebSocket(url));
  const createTrace = options.createTrace ?? createTraceContext;
  const clock = options.clock ?? systemClock;
  const delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const views = new Map<string, StoreApi<SessionView>>();
  /**
   * Each session's model changes on their way: the model the host reported last, how many are on
   * their way, and the guesses shown for them.
   */
  const guesses = new Map<string, { reported: SessionModel; pending: number; readonly ours: Set<SessionModel> }>();
  /** Each session's Fast switches on their way: the Fast the host took last, and how many are on their way. */
  const fastGuesses = new Map<string, { reported: boolean; pending: number }>();
  /** Each workspace's model list, and that of outside any, once asked for. */
  const modelLists = new Map<string | null, StoreApi<ModelListView>>();
  /** Fetches of older items on their way, by session. */
  const olderLoading = new Map<string, Promise<void>>();
  let watched: readonly string[] = [];
  const changeStores = new Map<string, StoreApi<ChangesView>>();
  /** The workspaces shown, asked for again on each connection. */
  let showing: readonly string[] = [];
  const diff = createStore<DiffView>(() => diffViewOf(null));
  const pending = new Map<
    string,
    { readonly type: CommandType; resolve(result: unknown): void; reject(error: Error): void }
  >();
  /** The socket of the latest attempt. */
  let socket: SocketLike | undefined;
  /** That socket once its handshake succeeded; commands go only here. */
  let live: SocketLike | undefined;
  // Stryker disable next-line BooleanLiteral: `connect` sets it before anything reads it.
  let stopped = false;
  /** The host instance of the last welcome; a different one means the host restarted. */
  let hostInstance: string | undefined;
  let attempt = 0;
  let nextRequest = 0;
  /** Previews of the images of messages sent from this page, by their request id; see `sentPreviews`. */
  const sentImages = new Map<string, readonly string[]>();
  let cancelTimer: (() => void) | undefined;
  /** Layout commands not answered yet; while there are any, the view keeps the layout chosen. */
  let layoutsPending = 0;
  /** The layout the host sent last. */
  let hostLayout: IndexView["layout"] | undefined;

  /**
   * Sends a layout command, whose change the view already shows, and takes the host's layout once
   * the last such command is answered.
   *
   * @remarks
   * SPEC-0001 ("列表的增量", 先读到自己的写): a layout the host made before it handled the command
   * may arrive meanwhile and would undo the choice; the host sends the layout the command made
   * before it answers, so the layout it sent last is the right one once nothing is pending. A
   * command that failed is undone that way too.
   *
   * @sideEffects Sends the command; updates the list's layout once answered.
   * @param sent - The command on its way.
   * @returns The command's answer.
   */
  function layoutCommand<T>(sent: Promise<T>): Promise<T> {
    layoutsPending += 1;
    return sent.finally(() => {
      layoutsPending -= 1;
      if (layoutsPending > 0 || hostLayout === undefined) return;
      // Stryker disable next-line BooleanLiteral: the new view sets every field, so merging equals replacing.
      index.setState({ ...index.getState(), layout: hostLayout }, true);
    });
  }

  /**
   * Shows a new state of the list, keeping the layout chosen while layout commands are pending.
   *
   * @remarks
   * See `layoutCommand`. The host's layout is remembered for when they are answered; changes
   * without one leave it, for the list's layout then is the one shown, perhaps not the host's.
   *
   * @sideEffects Updates the list.
   * @param next - The list as the host sent it.
   * @param sentLayout - Whether the host sent a layout with it.
   */
  function showIndex(next: IndexView, sentLayout: boolean): void {
    const current = index.getState();
    if (next === current) return;
    if (sentLayout) hostLayout = next.layout;
    // Stryker disable next-line BooleanLiteral: the new view sets every field, so merging equals replacing.
    index.setState(layoutsPending > 0 ? { ...next, layout: current.layout } : next, true);
  }

  /**
   * Fails every command still waiting for an answer.
   *
   * @remarks
   * Their results are unknown once the connection is gone, and they are not resent.
   *
   * @sideEffects Rejects pending commands.
   */
  function failPending(): void {
    const waiting = [...pending.values()];
    // Stryker disable next-line CallExpression: request ids are never reused, so clearing only frees memory.
    pending.clear();
    for (const command of waiting) command.reject(new ConnectionLostError(command.type));
  }

  /**
   * Sends a command and waits for its response.
   *
   * @remarks
   * The request id is chosen by the caller when it must be known before sending, as for a pending
   * message.
   *
   * @sideEffects Sends on the socket.
   * @param type - The command type.
   * @param fields - Its fields.
   * @param requestId - Its request id.
   * @returns The result, checked against the command's schema.
   * @throws {CommandError} When the host answers with an error.
   * @throws {ConnectionLostError} When there is no connection, or it drops first.
   */
  function request<T extends CommandType>(
    type: T,
    fields: CommandFields<T>,
    requestId = `${options.clientId}-${++nextRequest}`,
  ): Promise<CommandResult<T>> {
    if (live === undefined) return Promise.reject(new ConnectionLostError(type));
    const answer = Promise.withResolvers<CommandResult<T>>();
    pending.set(requestId, {
      type,
      resolve: (result) => {
        // A result that does not match its schema fails the command rather than the message handler.
        const checked = CommandResult[type].safeParse(result ?? {});
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `CommandResult[type]` is the schema of `CommandResult<T>`.
        if (checked.success) answer.resolve(checked.data as CommandResult<T>);
        else answer.reject(checked.error);
      },
      reject: answer.reject,
    });
    live.send(JSON.stringify({ type, requestId, traceparent: formatTraceparent(createTrace()), ...fields }));
    return answer.promise;
  }

  /**
   * A workspace's model list, or that of outside any, created empty on first use.
   *
   * @remarks
   * Kept for as long as the client lives; lists are small and few. Every chat shares one
   * (SPEC-0001, "模型与输入框").
   *
   * @sideEffects May create the list's store.
   * @param workspaceId - The workspace, or `null`.
   * @returns Its store.
   */
  function modelList(workspaceId: string | null): StoreApi<ModelListView> {
    let list = modelLists.get(workspaceId);
    if (list === undefined) {
      list = createStore<ModelListView>(() => UNASKED_MODELS);
      modelLists.set(workspaceId, list);
    }
    return list;
  }

  /**
   * Changes a model setting at once in the session's view, and puts it back if the host refuses.
   *
   * @remarks
   * The host reports the model pi then uses with `model_updated`, which may differ (pi keeps the
   * thinking level within what the model supports); the guess only bridges the round trip. A
   * refused change goes back to the model the host reported last, once no other change is on its
   * way; one still on its way decides instead. A view the host changed since is left alone. A
   * session whose model the client does not know shows nothing at once.
   *
   * @sideEffects Updates the session's view; sends the command.
   * @param sessionId - The session.
   * @param guess - The view's model as it will likely be.
   * @param send - The command.
   * @returns The command's result.
   */
  async function withGuessedModel<R>(
    sessionId: string,
    guess: (model: SessionModel) => SessionModel,
    send: () => Promise<R>,
  ): Promise<R> {
    const view = views.get(sessionId);
    if (view === undefined) return send();
    const before = view.getState().model;
    if (before === null) return send();
    const guessing = guesses.get(sessionId) ?? { reported: before, pending: 0, ours: new Set<SessionModel>() };
    // What the view shows is the host's unless it is one of the guesses.
    if (!guessing.ours.has(before)) guessing.reported = before;
    guesses.set(sessionId, guessing);
    guessing.pending += 1;
    const guessed = guess(before);
    guessing.ours.add(guessed);
    view.setState({ model: guessed });
    try {
      return await send();
    } catch (error) {
      const shown = view.getState().model;
      // Stryker disable next-line ConditionalExpression: `null` is never one of the guesses.
      if (guessing.pending === 1 && shown !== null && guessing.ours.has(shown)) {
        view.setState({ model: guessing.reported });
      }
      throw error;
    } finally {
      guessing.pending -= 1;
      if (guessing.pending === 0) guesses.delete(sessionId);
    }
  }

  /**
   * Switches a session's Fast at once in its view, and puts it back if the host refuses.
   *
   * @remarks
   * The host has the Fast it took last, here or from another client (`fast_updated`, or a
   * snapshot); a refused switch goes back to it once no other switch is on its way, since one on
   * its way decides instead. A session the client does not watch shows nothing.
   *
   * @sideEffects Updates the session's view; sends the command.
   * @param sessionId - The session.
   * @param enabled - On or off.
   * @returns The command's result.
   */
  async function switchFast(sessionId: string, enabled: boolean): Promise<CommandResult<"set_fast">> {
    const view = views.get(sessionId);
    if (view === undefined) return request("set_fast", { sessionId, enabled });
    const guessing = fastGuesses.get(sessionId) ?? { reported: view.getState().fast, pending: 0 };
    fastGuesses.set(sessionId, guessing);
    guessing.pending += 1;
    view.setState({ fast: enabled });
    try {
      const result = await request("set_fast", { sessionId, enabled });
      guessing.reported = enabled;
      return result;
    } catch (error) {
      if (guessing.pending === 1) view.setState({ fast: guessing.reported });
      throw error;
    } finally {
      guessing.pending -= 1;
      if (guessing.pending === 0) fastGuesses.delete(sessionId);
    }
  }

  /**
   * Sends a message or steer, showing it at once as pending.
   *
   * @remarks
   * The copy stays until the turn it opens arrives with the same id. It goes at once when the
   * message will open no turn of its own: pi rejected it, an extension consumed it, it went into
   * the host's queue (shown there instead), or pi took it as a steer to deliver mid-turn.
   *
   * @sideEffects Updates the session's view; sends the command.
   * @param type - `prompt` or `steer`.
   * @param sessionId - The session.
   * @param text - The message.
   * @param attachmentIds - Its uploaded images.
   * @param previews - The images as the page shows them, kept by the message's id while it goes.
   * @param command - The tag it was sent with, shown on the pending copy.
   * @returns The command's result.
   */
  async function sendShown<T extends "prompt" | "steer">(
    type: T,
    sessionId: string,
    text: string,
    attachmentIds: readonly string[],
    previews: readonly string[],
    command: MessageTag | undefined,
  ): Promise<CommandResult<T>> {
    const requestId = `${options.clientId}-${++nextRequest}`;
    if (previews.length > 0) {
      sentImages.set(requestId, previews);
      // The oldest goes first: a Map keeps the order keys were added in.
      for (const id of [...sentImages.keys()].slice(0, -SENT_PREVIEWS)) sentImages.delete(id);
    }
    const view = views.get(sessionId);
    const images = attachmentIds.length === 0 ? {} : { images: attachmentIds.length };
    const shown: PendingMessage = {
      clientMessageId: requestId,
      text,
      ...images,
      ...(command === undefined ? {} : { command }),
    };
    view?.setState({ pending: [...view.getState().pending, shown] });
    /**
     * Takes the optimistic copy back out.
     *
     * @remarks
     * See `sendShown`.
     *
     * @sideEffects Updates the session's view.
     */
    const withdraw = (): void => view?.setState({ pending: view.getState().pending.filter((item) => item !== shown) });
    try {
      const fields = attachmentIds.length === 0 ? { sessionId, text } : { sessionId, text, attachmentIds };
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `prompt` and `steer` take the same fields.
      const result = await request(type, fields as CommandFields<T>, requestId);
      if (result.disposition !== "started") withdraw();
      return result;
    } catch (error) {
      withdraw();
      sentImages.delete(requestId);
      throw error;
    }
  }

  /**
   * Asks for fresh snapshots of every watched session.
   *
   * @remarks
   * On a new connection the host has no subscriptions yet, so each watched session counts as new
   * and gets its snapshot.
   *
   * @sideEffects Sends `subscribe_sessions`.
   */
  async function subscribeWatched(): Promise<void> {
    if (watched.length > 0) await request("subscribe_sessions", { sessionIds: [...watched] });
  }

  /**
   * Asks again for the workspaces' changes shown and the open panel.
   *
   * @remarks
   * A new connection starts with nothing watched; the host then sends each anew. Both go at once.
   *
   * @sideEffects Sends `watch_changes` and `watch_diff`.
   */
  async function watchShown(): Promise<void> {
    const { target } = diff.getState();
    await Promise.all([
      showing.length > 0 ? request("watch_changes", { workspaceIds: [...showing] }) : undefined,
      target === null ? undefined : request("watch_diff", { target }),
    ]);
  }

  /**
   * A workspace's changes store, made on first use.
   *
   * @remarks
   * `null` until the host sends the workspace's changes.
   *
   * @sideEffects May create the store.
   * @param workspaceId - The workspace.
   * @returns The store.
   */
  function changesOf(workspaceId: string): StoreApi<ChangesView> {
    let store = changeStores.get(workspaceId);
    if (store === undefined) {
      store = createStore<ChangesView>(() => null);
      changeStores.set(workspaceId, store);
    }
    return store;
  }

  /**
   * Marks every watched session as lost after the host restarted.
   *
   * @remarks
   * A restarted host knows none of the old sessions (SPEC-0001, "事件"); their views keep the
   * items already shown, drop the run and unconfirmed messages, and are no longer subscribed. A
   * lost session can be opened again from pi's file (`open_session`).
   *
   * @sideEffects Updates every view; clears the watched set.
   */
  function loseSessions(): void {
    for (const view of views.values()) {
      view.setState({ status: "lost", run: null, pending: [] });
    }
    watched = [];
  }

  /**
   * Asks what first launch checks.
   *
   * @remarks
   * Only the answer to the latest ask lands, so an older answer arriving late does not undo a
   * newer one. A latest pi pushed while the ask was on its way, or before any, stays if it was
   * found later than the answer's (SPEC-0001, "设置 · 接口").
   *
   * @sideEffects Sends `check_setup`; updates the setup store.
   * @param refresh - Whether the host reads the login shell again first.
   */
  async function loadSetup(refresh: boolean): Promise<void> {
    // Stryker disable next-line AssignmentOperator: counting down numbers each ask apart just the same.
    setupAsks += 1;
    const ask = setupAsks;
    setup.setState({ status: "loading", error: null });
    try {
      const state = await request("check_setup", { refresh });
      const pi = { ...state.pi, ...newerLatest(state.pi, pushedLatest) };
      if (ask === setupAsks) setup.setState({ status: "ready", state: { ...state, pi }, error: null });
    } catch (error) {
      // Stryker disable next-line ConditionalExpression: commands only ever reject with errors.
      const failure = error instanceof Error ? error : new Error(String(error));
      if (ask === setupAsks) setup.setState({ status: "failed", error: failure });
    }
  }

  /**
   * Reloads every model list asked for, once the models pi can use may have changed.
   *
   * @remarks
   * After pi's credentials changed (SPEC-0001, "首次启动 · 接口"); lists never asked for stay so.
   *
   * @sideEffects Sends `list_models` for each list asked for; updates their stores.
   */
  function reloadModels(): void {
    for (const [workspaceId, list] of modelLists) {
      // Fire and forget: the failure lands in the list.
      if (list.getState().status !== "idle") void loadModels(workspaceId, false);
    }
  }

  /**
   * Asks for a workspace's models, or those outside any.
   *
   * @remarks
   * See {@link AtriumClient.loadModels}.
   *
   * @sideEffects Sends `list_models`; updates the list's store.
   * @param workspaceId - The workspace, or `null`.
   * @param refresh - Whether pi is asked again.
   */
  async function loadModels(workspaceId: string | null, refresh: boolean): Promise<void> {
    const list = modelList(workspaceId);
    list.setState({ status: "loading", error: null });
    try {
      const { models, defaultModel } = await request("list_models", { workspaceId, refresh });
      list.setState({ status: "ready", models, defaultModel, error: null });
    } catch (error) {
      // Stryker disable next-line ConditionalExpression: commands only ever reject with errors.
      const failure = error instanceof Error ? error : new Error(String(error));
      list.setState({ status: "failed", models: [], defaultModel: null, error: failure });
    }
  }

  /**
   * Asks what first launch checks again, once something may have changed it.
   *
   * @remarks
   * Only when asked before: nothing shows a setup no one asked for.
   *
   * @sideEffects May send `check_setup`.
   */
  function askSetupAgain(): void {
    // Fire and forget: the failure lands in the store.
    if (setup.getState().status !== "idle") void loadSetup(false);
  }

  /**
   * Gets a fresh snapshot of one session after the client missed an event.
   *
   * @remarks
   * The host sends snapshots only for sessions newly subscribed on the connection, so the session
   * is dropped from the set and added again.
   *
   * @sideEffects Resets the view; sends two `subscribe_sessions`.
   * @param sessionId - The session.
   */
  async function resync(sessionId: string): Promise<void> {
    // Stryker disable next-line OptionalChaining,BooleanLiteral: only a watched session's event starts a resync, and the loading view sets every field.
    views.get(sessionId)?.setState(loadingView(sessionId), true);
    await request("subscribe_sessions", { sessionIds: watched.filter((id) => id !== sessionId) });
    await request("subscribe_sessions", { sessionIds: [...watched] });
  }

  /**
   * Hands one event to its session's view.
   *
   * @remarks
   * Events for sessions no longer watched are dropped. The Fast an event reports is what the host
   * has, which a refused switch goes back to (`switchFast`).
   *
   * @sideEffects Updates a view and the Fast switches on their way; may start a resync.
   * @param event - The event.
   */
  function deliver(event: SessionEvent): void {
    const view = views.get(event.sessionId);
    if (view === undefined) return;
    const next = applySessionEvent(view.getState(), event);
    if (next === "resync") {
      // Fire and forget: a failed resync leaves the view loading until the next reconnect.
      resync(event.sessionId).catch(() => undefined);
      return;
    }
    // Stryker disable next-line BooleanLiteral: the new view sets every field, so merging equals replacing.
    view.setState(next, true);
    const guessing = fastGuesses.get(event.sessionId);
    if (guessing !== undefined && (event.type === "fast_updated" || event.type === "session_snapshot")) {
      guessing.reported = next.fast;
    }
  }

  /**
   * Handles one message on the open connection.
   *
   * @remarks
   * Messages that do not match the protocol are ignored.
   *
   * @sideEffects Settles a command or updates a view.
   * @param message - The parsed message.
   */
  function receive(message: HostMessage): void {
    // Stryker disable next-line ConditionalExpression,StringLiteral: a second welcome names no session, so no view would take it.
    if (message.type === "welcome") return;
    if (message.type === "index_snapshot") {
      showIndex(applyIndexSnapshot(index.getState(), message), true);
      return;
    }
    if (message.type === "index_changes") {
      showIndex(applyIndexChanges(index.getState(), message), message.layout !== null);
      return;
    }
    if (message.type === "changes_updated") {
      const { type: _type, workspaceId, ...changes } = message;
      // Stryker disable next-line BooleanLiteral: every field is set, so merging equals replacing.
      changesOf(workspaceId).setState(changes, true);
      return;
    }
    if (message.type === "install_updated") {
      const shown = installJob.getState();
      const output = shown?.job.jobId === message.jobId ? shown.output : "";
      // Stryker disable next-line BooleanLiteral: every field is set, so merging equals replacing.
      installJob.setState({ job: message, output }, true);
      if (message.state === "ok") askSetupAgain();
      return;
    }
    if (message.type === "install_output") {
      const shown = installJob.getState();
      // Output of a job this client has not heard of has no state to show it with.
      if (shown?.job.jobId !== message.jobId) return;
      // Stryker disable next-line BooleanLiteral: every field is set, so merging equals replacing.
      installJob.setState({ job: shown.job, output: (shown.output + message.text).slice(-MAX_INSTALL_OUTPUT) }, true);
      return;
    }
    if (message.type === "pi_latest") {
      // Each push was found later than all before it, and than any answer that came before it.
      const { latest, checkedAt } = message;
      pushedLatest = { latest, checkedAt };
      const { state } = setup.getState();
      if (state === null) return;
      setup.setState({ state: { ...state, pi: { ...state.pi, latest, checkedAt } } });
      return;
    }
    if (message.type === "plans_updated") {
      plans.setState(message.plans, true);
      return;
    }
    if (message.type === "credentials_changed") {
      askSetupAgain();
      reloadModels();
      return;
    }
    if (message.type === "login_updated") {
      // Stryker disable next-line BooleanLiteral: every field is set, so merging equals replacing.
      loginState.setState(message, true);
      return;
    }
    if (message.type === "diff_updated") {
      const { target } = diff.getState();
      if (target?.workspaceId !== message.workspaceId || target.mode !== message.mode) return;
      const { files, tooLarge, error } = message;
      // Stryker disable next-line BooleanLiteral: every field is set, so merging equals replacing.
      diff.setState({ target, status: "ready", files, tooLarge, error }, true);
      return;
    }
    if (message.type !== "response") {
      deliver(message);
      return;
    }
    // A failure the host could not tie to a command; nothing waits for it.
    // Stryker disable next-line ConditionalExpression: no command is waiting under a null id either.
    if (message.requestId === null) return;
    const waiting = pending.get(message.requestId);
    if (waiting === undefined) return;
    // Stryker disable next-line CallExpression: request ids are never reused, so the entry could only free memory.
    pending.delete(message.requestId);
    if (message.ok) waiting.resolve(message.result);
    else waiting.reject(new CommandError(message.error.code, message.error.params));
  }

  /**
   * Pings the host and checks the answer arrived before the next ping.
   *
   * @remarks
   * A ping that is still unanswered when the next one is due means the connection is dead even
   * if the socket has not noticed, as after the computer slept.
   *
   * @sideEffects Sends `ping`; schedules the next beat; may close the socket.
   * @param current - The socket the heartbeat belongs to.
   * @param heartbeatMs - The interval from the welcome.
   */
  function beat(current: SocketLike, heartbeatMs: number): void {
    let answered = false;
    // Fire and forget: a lost connection fails the ping, and the next beat notices it was not answered.
    void request("ping", {}).then(
      () => {
        answered = true;
        return answered;
      },
      // Stryker disable next-line ArrowFunction,BooleanLiteral: the value is ignored; only success sets `answered`.
      () => false,
    );
    cancelTimer = clock.setTimeout(() => {
      // Stryker disable next-line ConditionalExpression: replacing or closing the socket cancels this timer first.
      if (live !== current) return;
      if (answered) {
        beat(current, heartbeatMs);
        return;
      }
      // Give up on this socket now: the browser may take a minute to notice it is dead, and
      // meanwhile commands would vanish into it. Its close event then changes nothing.
      socket = undefined;
      lost(HEARTBEAT_LOST);
      current.close(HEARTBEAT_LOST, "heartbeat lost");
    }, heartbeatMs);
  }

  /**
   * Opens one socket and runs the handshake.
   *
   * @remarks
   * See `createAtriumClient`.
   *
   * @sideEffects Opens a socket; updates the connection state; schedules timers.
   * @returns The outcome of this attempt.
   */
  function attemptConnection(): Promise<ConnectionState> {
    return new Promise((settle) => {
      const trace = createTrace();
      cancelTimer?.();
      live = undefined;
      // Answers to commands sent on the old socket can no longer arrive.
      failPending();
      socket?.close(1000, "client reconnecting");
      connection.setState({ status: "connecting", traceId: trace.traceId }, true);
      const current = openSocket(options.url);
      socket = current;
      current.addEventListener("open", () => {
        const hello: HelloMessage = {
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          clientId: options.clientId,
          token: options.token,
          traceparent: formatTraceparent(trace),
        };
        current.send(JSON.stringify(hello));
      });
      current.addEventListener("message", (event) => {
        if (socket !== current) return;
        const parsed = HostMessage.safeParse(parseFrame(event.data));
        if (!parsed.success) return;
        if (live === current) {
          receive(parsed.data);
          return;
        }
        if (parsed.data.type !== "welcome") return;
        live = current;
        attempt = 0;
        const { hostVersion, hostInstanceId, heartbeatMs, installSeed, logDir } = parsed.data;
        if (hostInstance !== undefined && hostInstance !== hostInstanceId) {
          loseSessions();
          // The new host knows neither; it tells what it has right after the welcome.
          installJob.setState(null, true);
          loginState.setState(null, true);
          askSetupAgain();
        }
        hostInstance = hostInstanceId;
        // Stryker disable BooleanLiteral: "connected" has every key "connecting" has, so merging equals replacing.
        connection.setState(
          { status: "connected", traceId: trace.traceId, hostVersion, hostInstanceId, installSeed, logDir },
          true,
        );
        // Stryker restore BooleanLiteral
        beat(current, heartbeatMs);
        // Each connection subscribes anew, from where the list was; the host answers at once.
        const cursor = cursorOf(index.getState());
        // Stryker disable next-line ConditionalExpression: JSON drops a key whose value is undefined, so both send `{}`.
        request("subscribe_index", cursor === undefined ? {} : { cursor }).catch(() => undefined);
        subscribeWatched().catch(() => undefined);
        watchShown().catch(() => undefined);
        settle(connection.getState());
      });
      current.addEventListener("close", (event) => {
        const ended = closed(current, event.code);
        settle(ended);
      });
    });
  }

  /**
   * Handles a socket closing: rejected, stopped, or dropped and to be retried.
   *
   * @remarks
   * A replaced socket's close changes nothing but its own attempt's outcome.
   *
   * @sideEffects Fails waiting commands; updates the connection state; may schedule a reconnect.
   * @param current - The socket that closed.
   * @param code - Its close code.
   * @returns The outcome to report for that socket's attempt.
   */
  function closed(current: SocketLike, code: number): ConnectionState {
    const reason = REJECTIONS[code];
    if (socket !== current)
      return reason === undefined ? { status: "disconnected", code } : { status: "rejected", reason };
    socket = undefined;
    return lost(code);
  }

  /**
   * Handles losing the current socket: refused, stopped, or dropped and to be retried.
   *
   * @remarks
   * Shared by a close event and by a heartbeat that went unanswered.
   *
   * @sideEffects Fails waiting commands; updates the connection state; may schedule a reconnect.
   * @param code - Why the socket ended.
   * @returns The new connection state.
   */
  function lost(code: number): ConnectionState {
    const reason = REJECTIONS[code];
    live = undefined;
    cancelTimer?.();
    failPending();
    if (reason !== undefined) {
      connection.setState({ status: "rejected", reason }, true);
    } else if (stopped || delays.length === 0) {
      connection.setState({ status: "disconnected", code }, true);
    } else {
      attempt += 1;
      connection.setState({ status: "reconnecting", attempt, code }, true);
      const delay = delays[Math.min(attempt, delays.length) - 1] ?? 0;
      cancelTimer = clock.setTimeout(() => {
        // Fire and forget: the outcome lands in the connection store.
        void attemptConnection();
      }, delay);
    }
    return connection.getState();
  }

  return {
    connection,
    connect() {
      stopped = false;
      attempt = 0;
      return attemptConnection();
    },
    disconnect() {
      stopped = true;
      cancelTimer?.();
      if (socket !== undefined) {
        socket.close(1000, "client closed");
        return;
      }
      // Waiting to reconnect: no socket will close, so nothing else would end the wait.
      if (connection.getState().status === "reconnecting")
        connection.setState({ status: "disconnected", code: 1000 }, true);
    },
    index,
    session: (sessionId) => views.get(sessionId),
    async watch(sessionIds) {
      watched = [...new Set(sessionIds)];
      for (const sessionId of views.keys()) if (!watched.includes(sessionId)) views.delete(sessionId);
      for (const sessionId of watched)
        if (!views.has(sessionId))
          views.set(
            sessionId,
            createStore(() => loadingView(sessionId)),
          );
      if (live !== undefined) await request("subscribe_sessions", { sessionIds: [...watched] });
    },
    createChat: () => request("create_chat", {}),
    createSession: (containerId, go) =>
      request("create_session", go === undefined ? { containerId } : { containerId, go }),
    openSession(sessionId) {
      // Stryker disable next-line BooleanLiteral: the new view sets every field, so merging equals replacing.
      index.setState(withTabOpen(index.getState(), sessionId), true);
      return layoutCommand(request("open_session", { sessionId }));
    },
    closeTab(sessionId) {
      // Stryker disable next-line BooleanLiteral: the new view sets every field, so merging equals replacing.
      index.setState(withTabClosed(index.getState(), sessionId), true);
      return layoutCommand(request("close_tab", { sessionId }));
    },
    selectContainer(containerId) {
      // Stryker disable next-line BooleanLiteral: the new view sets every field, so merging equals replacing.
      index.setState(withContainer(index.getState(), containerId), true);
      return layoutCommand(request("select_container", { containerId }));
    },
    archiveSession: (sessionId) => request("archive_session", { sessionId }),
    renameSession: (sessionId, name) => request("rename_session", { sessionId, name }),
    clearAttention: (sessionId) => request("clear_attention", { sessionId }),
    handOff: (sessionId) => request("hand_off", { sessionId }),
    takeBack: (sessionId) => request("take_back", { sessionId }),
    addProject: (path) => request("add_project", { path }),
    removeProject: (projectId) => request("remove_project", { projectId }),
    renameProject: (projectId, name) => request("rename_project", { projectId, name }),
    renameWorkspace: (workspaceId, name) => request("rename_workspace", { workspaceId, name }),
    archiveWorkspace: (workspaceId) => request("archive_workspace", { workspaceId }),
    restoreWorkspace: (workspaceId) => request("restore_workspace", { workspaceId }),
    listBases: (projectId) => request("list_bases", { projectId }),
    createWorkspace: (projectId, branch, base) => request("create_workspace", { projectId, branch, base }),
    nameBranch: (projectId, text, model) => request("name_branch", { projectId, text, model }),
    renameChat: (chatId, name) => request("rename_chat", { chatId, name }),
    archiveChat: (chatId) => request("archive_chat", { chatId }),
    restoreChat: (chatId) => request("restore_chat", { chatId }),
    windowFocused: () => request("window_focused", {}),
    setPreferences(changes) {
      // A proxy shows once the host has checked it and written its address in one form.
      const { proxy: _checked, ...shown } = changes;
      // Stryker disable next-line BooleanLiteral: the new view sets every field, so merging equals replacing.
      index.setState(withPreferences(index.getState(), shown), true);
      return request("set_preferences", changes);
    },
    prompt: (sessionId, text, attachmentIds = [], previews = [], command) =>
      sendShown("prompt", sessionId, text, attachmentIds, previews, command),
    steer: (sessionId, text, attachmentIds = [], previews = [], command) =>
      sendShown("steer", sessionId, text, attachmentIds, previews, command),
    sentPreviews: (clientMessageId) => sentImages.get(clientMessageId) ?? null,
    uploadAttachment: (mimeType, data) => request("upload_attachment", { mimeType, data }),
    stop: (sessionId) => request("stop", { sessionId }),
    resumeQueue: (sessionId) => request("resume_queue", { sessionId }),
    clearQueue: (sessionId) => request("clear_queue", { sessionId }),
    updateQueued: (sessionId, itemId, text) => request("update_queued", { sessionId, itemId, text }),
    removeQueued: (sessionId, itemId) => request("remove_queued", { sessionId, itemId }),
    steerQueued: (sessionId, itemId) => request("steer_queued", { sessionId, itemId }),
    answerInteraction: (sessionId, interactionId, answer) =>
      request("answer_interaction", { sessionId, interactionId, answer }),
    retryRun: (sessionId) => request("retry_run", { sessionId }),
    models: (workspaceId) => modelList(workspaceId),
    loadModels: (workspaceId, refresh = false) => loadModels(workspaceId, refresh),
    setModel: (sessionId, model) =>
      withGuessedModel(
        sessionId,
        (current) => ({ ...current, ...model }),
        () => request("set_model", { sessionId, ...model }),
      ),
    listCommands: (sessionId) => request("list_commands", { sessionId }),
    searchFiles: (sessionId, query) => request("search_files", { sessionId, query }),
    listDir: (workspaceId, path) => request("list_dir", { workspaceId, path }),
    readFile: (workspaceId, path) => request("read_file", { workspaceId, path }),
    fetchImage: (sessionId, turnId, place) => request("fetch_image", { sessionId, turnId, index: place }),
    setup,
    loadSetup: (refresh = false) => loadSetup(refresh),
    loginState,
    login: (providerId, method, key) =>
      // Stryker disable next-line ConditionalExpression: JSON drops a key whose value is undefined, so both send the same.
      request("login", key === undefined ? { providerId, method } : { providerId, method, key }),
    answerLogin: (loginId, promptId, value) => request("answer_login", { loginId, promptId, value }),
    cancelLogin: (loginId) => request("cancel_login", { loginId }),
    logout: (providerId) => request("logout", { providerId }),
    installJob,
    plans,
    installPi: () => request("install_pi", {}),
    installNode: () => request("install_node", {}),
    updatePi: () => request("update_pi", {}),
    cancelInstall: (jobId) => request("cancel_install", { jobId }),
    checkPiUpdate: () => request("check_pi_update", {}),
    discoverProjects: () => request("discover_projects", {}),
    listBranches: (projectId) => request("list_branches", { projectId }),
    setMainBranch: (projectId, branch) => request("set_main_branch", { projectId, branch }),
    setThinkingLevel: (sessionId, level) =>
      withGuessedModel(
        sessionId,
        (current) => ({ ...current, thinkingLevel: level }),
        () => request("set_thinking_level", { sessionId, level }),
      ),
    setFast: (sessionId, enabled) => switchFast(sessionId, enabled),
    compactSession: (sessionId, instructions) =>
      // Stryker disable next-line ConditionalExpression,EqualityOperator: undefined is left out of the JSON either way.
      request("compact_session", instructions === undefined ? { sessionId } : { sessionId, instructions }),
    exportSession: (sessionId) => request("export_session", { sessionId }),
    forkSession: (sessionId, turnId, name) => request("fork_session", { sessionId, turnId, name }),
    loadOlder(sessionId) {
      const going = olderLoading.get(sessionId);
      if (going !== undefined) return going;
      const view = views.get(sessionId);
      if (view === undefined) return Promise.resolve();
      const state = view.getState();
      const before = state.items[0]?.id;
      // A view still loading has no items, so nothing to fetch before.
      if (before === undefined || !state.hasOlder || state.status === "lost") return Promise.resolve();
      /**
       * Fetches one page and puts it in front of the view's items.
       *
       * @remarks
       * When the host rebuilt the transcript, a fresh snapshot replaces what the view has.
       *
       * @sideEffects Sends `fetch_transcript`, or `subscribe_sessions` to resync; updates the view.
       */
      const fetchPage = async (): Promise<void> => {
        try {
          const page = await request("fetch_transcript", {
            sessionId,
            epoch: state.epoch,
            before,
            limit: OLDER_PAGE_ITEMS,
          });
          view.setState(prependOlder(view.getState(), page, state.epoch, before));
        } catch (error) {
          if (!(error instanceof CommandError && error.code === "transcript_changed")) throw error;
          await resync(sessionId);
        }
      };
      const fetching = fetchPage().finally(() => olderLoading.delete(sessionId));
      olderLoading.set(sessionId, fetching);
      return fetching;
    },
    async loadStep(sessionId, turnId, stepId) {
      const view = views.get(sessionId);
      if (view === undefined) return;
      const state = view.getState();
      if (state.status === "loading" || state.status === "lost") return;
      try {
        const { step } = await request("fetch_step", { sessionId, epoch: state.epoch, turnId, stepId });
        view.setState(withWholeStep(view.getState(), turnId, step, state.epoch));
      } catch (error) {
        // The host rebuilt the transcript; a fresh snapshot replaces what the view has.
        if (!(error instanceof CommandError && error.code === "transcript_changed")) throw error;
        await resync(sessionId);
      }
    },
    async reportIssue(kind, message, details) {
      await request("report_client_issue", {
        kind,
        message: message.slice(0, MAX_ISSUE_LENGTH),
        ...(details === undefined ? {} : { details: details.slice(0, MAX_ISSUE_LENGTH) }),
      });
    },
    changes: changesOf,
    async watchChanges(workspaceIds) {
      showing = [...new Set(workspaceIds)];
      if (live !== undefined) await request("watch_changes", { workspaceIds: [...showing] });
    },
    diff,
    async watchDiff(target) {
      const shown = diff.getState().target;
      // The same target asked again, to refresh, keeps what it shows until the answer comes.
      const same = shown !== null && shown.workspaceId === target?.workspaceId && shown.mode === target.mode;
      // Stryker disable next-line BooleanLiteral: the new view sets every field, so merging equals replacing.
      if (!same) diff.setState(diffViewOf(target), true);
      if (live !== undefined) await request("watch_diff", { target });
    },
  };
}
