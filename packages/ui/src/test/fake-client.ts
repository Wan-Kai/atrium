import type {
  AtriumClient,
  ChangesView,
  ConnectionState,
  DiffView,
  IndexView,
  InstallJob,
  ModelListView,
  SessionView,
  SetupView,
} from "@atrium/client";
import {
  type Chat,
  type DiffTarget,
  type DiscoveredDirectory,
  IDLE_CONTROL,
  type IndexSnapshotEvent,
  type LoginMethod,
  type LoginUpdatedEvent,
  type ModelRef,
  type Preferences,
  type Project,
  type SessionSummary,
  type SetupState,
  type Workspace,
  UNKNOWN_METRICS,
} from "@atrium/protocol";
import { type StoreApi, createStore } from "zustand/vanilla";

/**
 * A workspace of project `prj_a`.
 *
 * @remarks
 * A worktree with no changes unless `fields` say otherwise.
 *
 * @sideEffects none
 * @param fields - Fields to set; the id is required.
 * @returns The workspace.
 */
export function workspace(fields: Partial<Workspace> & Pick<Workspace, "id">): Workspace {
  return {
    projectId: "prj_000000000000000a",
    kind: "worktree",
    dir: `/work/${fields.id}`,
    alias: null,
    branch: fields.id,
    head: null,
    external: true,
    createdAt: 1,
    merge: { dirty: false, ahead: 0, verdict: "noChange", reason: null },
    ...fields,
  };
}

/**
 * A chat without a name.
 *
 * @remarks
 * Its directory under Atrium's home, unless `fields` say otherwise.
 *
 * @sideEffects none
 * @param fields - Fields to set; the id and first session are required.
 * @returns The chat.
 */
export function chat(fields: Partial<Chat> & Pick<Chat, "id" | "firstSessionId">): Chat {
  return { dir: `/home/chats/${fields.id}`, alias: null, ...fields };
}

/**
 * A session.
 *
 * @remarks
 * On file, changed a minute ago, idle, unless `fields` say otherwise.
 *
 * @sideEffects none
 * @param fields - Fields to set; the id and container are required.
 * @returns The session.
 */
export function session(
  fields: Partial<SessionSummary> & Pick<SessionSummary, "sessionId" | "containerId">,
): SessionSummary {
  return {
    name: null,
    prompt: fields.sessionId,
    file: `/pi/${fields.sessionId}.jsonl`,
    state: "persisted",
    updatedAt: Date.now() - 60_000,
    archived: false,
    running: false,
    attention: null,
    asking: null,
    handedOff: false,
    ...fields,
  };
}

/**
 * A ready view of a session.
 *
 * @remarks
 * Empty unless `fields` say otherwise.
 *
 * @sideEffects none
 * @param sessionId - The session.
 * @param fields - Fields to set.
 * @returns The view.
 */
function sessionView(sessionId: string, fields: Partial<SessionView> = {}): SessionView {
  return {
    sessionId,
    status: "ready",
    epoch: 1,
    seq: 0,
    items: [],
    hasOlder: false,
    run: null,
    pending: [],
    control: IDLE_CONTROL,
    model: null,
    fast: false,
    metrics: UNKNOWN_METRICS,
    ...fields,
  };
}

/** First launch's checks with pi 0.80.0 ready and up to date, signed in nowhere, and no projects. */
export const READY_SETUP: SetupState = {
  pi: {
    state: "ready",
    path: "/opt/homebrew/bin/pi",
    version: "0.80.0",
    minimum: "0.74.0",
    detail: null,
    latest: "0.80.0",
    checkedAt: null,
  },
  node: { state: "ready", version: "22.19.0" },
  homebrew: true,
  fd: true,
  login: { state: "ready", providers: [] },
  projects: 0,
};

/** How the fake answers some commands; the rest succeed. */
export interface FakeAnswers {
  readonly createChat?: () => Promise<void>;
  readonly createSession?: () => Promise<void>;
  readonly renameChat?: () => Promise<void>;
  readonly prompt?: () => Promise<{ disposition: "started" | "queued" | "handled" }>;
  readonly addProject?: () => Promise<void>;
  readonly openSession?: () => Promise<void>;
  readonly handOff?: () => Promise<void>;
  /** The list `loadModels` puts in a container's model list; empty and ready when left out. */
  readonly models?: ModelListView;
  /** Holds back an upload, given its number counting from 1. */
  readonly upload?: (number: number) => Promise<void>;
  /** What `loadSetup` puts in the setup; {@link READY_SETUP} when left out. */
  readonly setup?: SetupState;
  readonly login?: () => Promise<void>;
  readonly logout?: () => Promise<void>;
  readonly updatePi?: () => Promise<void>;
  readonly installPi?: () => Promise<void>;
  readonly installNode?: () => Promise<void>;
  /** The folders of pi's sessions; none when left out. */
  readonly discover?: () => Promise<DiscoveredDirectory[]>;
  readonly checkPiUpdate?: () => Promise<void>;
  /** A project's branches; `main` alone, and origin's HEAD, when left out. */
  readonly branches?: (projectId: string) => Promise<{ branches: string[]; head: string | null }>;
  readonly setMainBranch?: () => Promise<void>;
  /** Holds back the list's change until it settles; changed at once when left out. */
  readonly setPreferences?: () => Promise<void>;
  /** Answers a Fast switch, which then shows in the session's view; succeeds at once when left out. */
  readonly setFast?: () => Promise<void>;
}

/**
 * A client that answers as the host would, in memory, recording every command.
 *
 * @remarks
 * Browser tests cannot run a host (the host needs Node); this fake keeps the parts the UI reads
 * real: the list is a real store that commands change as the host's snapshot would (first launch
 * done, unless `initial` says otherwise), and every
 * watched session has a real view store. Commands are recorded as short strings; model commands
 * apart, in `modelCalls`, as the conversation area asks for models whenever it shows. Logins and
 * install jobs only answer with their ids: a test plays the host's updates into `loginState` and
 * `installJob`.
 *
 * @sideEffects none until a command; then updates its stores.
 * @param initial - The list to start from.
 * @param answers - How some commands answer.
 * @returns The client, its recorded calls, the session views, and the connection, setup, login and
 * install stores.
 */
export function fakeClient(initial: Partial<Omit<IndexSnapshotEvent, "type">> = {}, answers: FakeAnswers = {}) {
  const calls: string[] = [];
  const modelCalls: string[] = [];
  /** What the area asked of the workspace changes, in order. */
  const changeCalls: string[] = [];
  const changeStores = new Map<string, StoreApi<ChangesView>>();
  const diff = createStore<DiffView>(() => ({ target: null, status: "idle", files: [], tooLarge: false, error: null }));
  const modelLists = new Map<string | null, StoreApi<ModelListView>>();
  const views = new Map<string, StoreApi<SessionView>>();
  const index = createStore<IndexView>(() => ({
    ready: true,
    generation: "h1",
    seq: 1,
    projects: [],
    workspaces: [],
    chats: [],
    sessions: [],
    layout: { container: null, tabs: {} },
    preferences: {
      setupDone: true,
      appearance: "system",
      displayMode: "summary",
      lastModel: null,
      thinkingByModel: {},
      lastFast: false,
      statusBar: {},
      titleModel: null,
      proxy: null,
    },
    resets: [],
    ...initial,
  }));
  const connection = createStore<ConnectionState>(() => ({
    status: "connected",
    traceId: "t",
    hostVersion: "0",
    hostInstanceId: "h1",
    installSeed: 1,
    logDir: "/Users/test/.atrium/logs",
  }));
  const setup = createStore<SetupView>(() => ({ status: "idle", state: null, error: null }));
  const loginState = createStore<LoginUpdatedEvent | null>(() => null);
  const installJob = createStore<InstallJob | null>(() => null);
  let created = 0;
  let uploaded = 0;
  let logins = 0;

  /**
   * Opens a session as the active tab of its container.
   *
   * @remarks
   * As the host's layouts do.
   *
   * @sideEffects Updates the list.
   * @param sessionId - The session.
   */
  function openTab(sessionId: string): void {
    const view = index.getState();
    const containerId = view.sessions.find((candidate) => candidate.sessionId === sessionId)?.containerId;
    if (containerId === undefined) return;
    const tabs = view.layout.tabs[containerId] ?? { open: [], active: null };
    const open = tabs.open.includes(sessionId) ? tabs.open : [...tabs.open, sessionId];
    index.setState({
      layout: { container: containerId, tabs: { ...view.layout.tabs, [containerId]: { open, active: sessionId } } },
    });
  }

  /**
   * Changes one session in the list.
   *
   * @remarks
   * As the host's next list would.
   *
   * @sideEffects Updates the list.
   * @param sessionId - The session.
   * @param fields - The fields to change, from the session as it is.
   */
  function change(sessionId: string, fields: (session: SessionSummary) => Partial<SessionSummary>): void {
    index.setState({
      sessions: index
        .getState()
        .sessions.map((one) => (one.sessionId === sessionId ? { ...one, ...fields(one) } : one)),
    });
  }

  /**
   * Adds a draft and opens it.
   *
   * @remarks
   * As creating a session does.
   *
   * @sideEffects Updates the list.
   * @param containerId - Where it goes.
   * @returns Its id.
   */
  function addDraft(containerId: string): string {
    created += 1;
    const sessionId = `new${created}`;
    index.setState({
      sessions: [
        ...index.getState().sessions,
        session({ sessionId, containerId, prompt: null, file: null, state: "draft", updatedAt: Date.now() }),
      ],
    });
    openTab(sessionId);
    return sessionId;
  }

  const client = {
    connection,
    index,
    session: (sessionId: string) => views.get(sessionId),
    async watch(sessionIds: readonly string[]) {
      calls.push(`watch ${sessionIds.join(",")}`);
      for (const id of sessionIds)
        if (!views.has(id))
          views.set(
            id,
            createStore(() => sessionView(id)),
          );
    },
    async createChat() {
      calls.push("createChat");
      await answers.createChat?.();
      // As the host does: a chat of its own, whose first session is the new draft.
      const chatId = `cht_new${created + 1}`;
      index.setState({
        chats: [
          ...index.getState().chats,
          { id: chatId, dir: `/home/chats/new${created + 1}`, alias: null, firstSessionId: `new${created + 1}` },
        ],
      });
      return { sessionId: addDraft(chatId) };
    },
    async createSession(containerId: string) {
      calls.push(`createSession ${containerId}`);
      await answers.createSession?.();
      return { sessionId: addDraft(containerId) };
    },
    async openSession(sessionId: string) {
      calls.push(`openSession ${sessionId}`);
      openTab(sessionId);
      await answers.openSession?.();
      return {};
    },
    async closeTab(sessionId: string) {
      calls.push(`closeTab ${sessionId}`);
      const view = index.getState();
      const tabs = Object.fromEntries(
        Object.entries(view.layout.tabs).map(([id, { open, active }]) => {
          const at = open.indexOf(sessionId);
          const rest = open.filter((candidate) => candidate !== sessionId);
          return [id, { open: rest, active: active === sessionId ? (rest[at] ?? rest[at - 1] ?? null) : active }];
        }),
      );
      index.setState({ layout: { ...view.layout, tabs } });
      return {};
    },
    async selectContainer(containerId: string | null) {
      calls.push(`selectContainer ${containerId}`);
      index.setState({ layout: { ...index.getState().layout, container: containerId } });
      return {};
    },
    async archiveSession(sessionId: string) {
      calls.push(`archiveSession ${sessionId}`);
      return {};
    },
    async renameSession(sessionId: string, name: string) {
      calls.push(`renameSession ${sessionId} ${name}`);
      return {};
    },
    async clearAttention(sessionId: string) {
      calls.push(`clearAttention ${sessionId}`);
      change(sessionId, (one) => ({
        attention: one.attention === null ? null : { ...one.attention, cleared: one.attention.reason === "error" },
      }));
      return {};
    },
    async handOff(sessionId: string) {
      calls.push(`handOff ${sessionId}`);
      await answers.handOff?.();
      change(sessionId, () => ({ handedOff: true }));
      return { file: index.getState().sessions.find((one) => one.sessionId === sessionId)?.file ?? "" };
    },
    async takeBack(sessionId: string) {
      calls.push(`takeBack ${sessionId}`);
      change(sessionId, () => ({ handedOff: false }));
      return {};
    },
    async addProject(path: string) {
      calls.push(`addProject ${path}`);
      await answers.addProject?.();
      return { projectId: "prj_000000000000000f" };
    },
    async removeProject(projectId: string) {
      calls.push(`removeProject ${projectId}`);
      return {};
    },
    async renameProject(projectId: string, name: string) {
      calls.push(`renameProject ${projectId} ${name}`);
      return {};
    },
    async renameWorkspace(workspaceId: string, name: string | null) {
      calls.push(`renameWorkspace ${workspaceId} ${name}`);
      return {};
    },
    async renameChat(chatId: string, name: string | null) {
      calls.push(`renameChat ${chatId} ${name}`);
      await answers.renameChat?.();
      return {};
    },
    async windowFocused() {
      calls.push("windowFocused");
      return {};
    },
    async setPreferences(changes: Partial<Preferences>) {
      calls.push(`setPreferences ${JSON.stringify(changes)}`);
      const held = answers.setPreferences?.();
      if (held !== undefined) await held;
      // The host keeps a proxy's address in one form.
      const { proxy } = changes;
      const kept =
        proxy === undefined || proxy === null
          ? changes
          : { ...changes, proxy: { ...proxy, url: new URL(proxy.url).origin } };
      index.setState({ preferences: { ...index.getState().preferences, ...kept } });
      return {};
    },
    prompt(sessionId: string, text: string, attachmentIds: readonly string[] = []) {
      calls.push(`prompt ${sessionId} ${text}${attachmentIds.map((id) => ` +${id}`).join("")}`);
      const view = views.get(sessionId);
      view?.setState({ pending: [...view.getState().pending, { clientMessageId: `q${calls.length}`, text }] });
      return answers.prompt?.() ?? Promise.resolve({ disposition: "started" as const });
    },
    steer(sessionId: string, text: string) {
      calls.push(`steer ${sessionId} ${text}`);
      return Promise.resolve({ disposition: "queued" as const });
    },
    async stop(sessionId: string) {
      calls.push(`stop ${sessionId}`);
      return { confirmed: true };
    },
    async resumeQueue(sessionId: string) {
      calls.push(`resumeQueue ${sessionId}`);
      return {};
    },
    async clearQueue(sessionId: string) {
      calls.push(`clearQueue ${sessionId}`);
      return {};
    },
    async updateQueued(sessionId: string, itemId: string, text: string) {
      calls.push(`updateQueued ${sessionId} ${itemId} ${text}`);
      return {};
    },
    async removeQueued(sessionId: string, itemId: string) {
      calls.push(`removeQueued ${sessionId} ${itemId}`);
      return {};
    },
    async steerQueued(sessionId: string, itemId: string) {
      calls.push(`steerQueued ${sessionId} ${itemId}`);
      return { disposition: "queued" };
    },
    async answerInteraction(sessionId: string, interactionId: string, answer: unknown) {
      calls.push(`answerInteraction ${sessionId} ${interactionId} ${JSON.stringify(answer)}`);
      return {};
    },
    async retryRun(sessionId: string) {
      calls.push(`retryRun ${sessionId}`);
      return {};
    },
    loadOlder: async () => undefined,
    loadStep: async () => undefined,
    models(workspaceId: string | null) {
      let list = modelLists.get(workspaceId);
      if (list === undefined) {
        list = createStore<ModelListView>(() => ({ status: "idle", models: [], defaultModel: null, error: null }));
        modelLists.set(workspaceId, list);
      }
      return list;
    },
    async loadModels(workspaceId: string | null, refresh = false) {
      modelCalls.push(`loadModels ${workspaceId}${refresh ? " refresh" : ""}`);
      client
        .models(workspaceId)
        .setState(answers.models ?? { status: "ready", models: [], defaultModel: null, error: null });
    },
    async setModel(sessionId: string, model: ModelRef) {
      modelCalls.push(`setModel ${sessionId} ${model.providerId}/${model.modelId}`);
      return {};
    },
    async uploadAttachment(mimeType: string) {
      uploaded += 1;
      const number = uploaded;
      calls.push(`uploadAttachment ${mimeType}`);
      await answers.upload?.(number);
      return { attachmentId: `u${number}` };
    },
    async listCommands(sessionId: string) {
      calls.push(`listCommands ${sessionId}`);
      return { commands: [{ name: "review", description: "Reviews", source: "prompt" }] };
    },
    async searchFiles(sessionId: string, query: string) {
      calls.push(`searchFiles ${sessionId} ${query}`);
      return { files: [{ path: "src/a.ts", directory: false }] };
    },
    async setThinkingLevel(sessionId: string, level: string) {
      modelCalls.push(`setThinkingLevel ${sessionId} ${level}`);
      return {};
    },
    async setFast(sessionId: string, enabled: boolean) {
      modelCalls.push(`setFast ${sessionId} ${enabled ? "on" : "off"}`);
      await answers.setFast?.();
      views.get(sessionId)?.setState({ fast: enabled });
      return {};
    },
    changes(workspaceId: string) {
      let store = changeStores.get(workspaceId);
      if (store === undefined) {
        store = createStore<ChangesView>(() => null);
        changeStores.set(workspaceId, store);
      }
      return store;
    },
    async watchChanges(workspaceIds: readonly string[]) {
      changeCalls.push(`watchChanges ${workspaceIds.join(",")}`);
    },
    diff,
    async watchDiff(target: DiffTarget | null) {
      changeCalls.push(target === null ? "watchDiff null" : `watchDiff ${target.workspaceId} ${target.mode}`);
      const shown = diff.getState().target;
      if (shown?.workspaceId === target?.workspaceId && shown?.mode === target?.mode) return;
      diff.setState({ target, status: target === null ? "idle" : "loading", files: [], tooLarge: false, error: null });
    },
    setup,
    async loadSetup(refresh = false) {
      calls.push(`loadSetup${refresh ? " refresh" : ""}`);
      setup.setState({ status: "ready", state: answers.setup ?? READY_SETUP, error: null });
    },
    loginState,
    async login(providerId: string, method: LoginMethod, key?: string) {
      calls.push(`login ${providerId} ${method}${key === undefined ? "" : ` ${key}`}`);
      await answers.login?.();
      logins += 1;
      return { loginId: `l${logins}` };
    },
    async answerLogin(loginId: string, promptId: number, value: string) {
      calls.push(`answerLogin ${loginId} ${promptId} ${value}`);
      return {};
    },
    async cancelLogin(loginId: string) {
      calls.push(`cancelLogin ${loginId}`);
      return {};
    },
    async logout(providerId: string) {
      calls.push(`logout ${providerId}`);
      await answers.logout?.();
      return {};
    },
    installJob,
    async updatePi() {
      calls.push("updatePi");
      await answers.updatePi?.();
      return { jobId: "j1" };
    },
    async installPi() {
      calls.push("installPi");
      await answers.installPi?.();
      return { jobId: "j2" };
    },
    async installNode() {
      calls.push("installNode");
      await answers.installNode?.();
      return { jobId: "j3" };
    },
    async discoverProjects() {
      calls.push("discoverProjects");
      return { directories: (await answers.discover?.()) ?? [] };
    },
    async cancelInstall(jobId: string) {
      calls.push(`cancelInstall ${jobId}`);
      return {};
    },
    async checkPiUpdate() {
      calls.push("checkPiUpdate");
      await answers.checkPiUpdate?.();
      return {};
    },
    async listBranches(projectId: string) {
      calls.push(`listBranches ${projectId}`);
      return (await answers.branches?.(projectId)) ?? { branches: ["main"], head: "main" };
    },
    async setMainBranch(projectId: string, branch: string | null) {
      calls.push(`setMainBranch ${projectId} ${branch}`);
      await answers.setMainBranch?.();
      index.setState({
        projects: index.getState().projects.map((one) => (one.id === projectId ? { ...one, mainBranch: branch } : one)),
      });
      return {};
    },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a test double with the methods the UI uses.
  } as unknown as AtriumClient;
  return { client, calls, modelCalls, changeCalls, views, index, connection, setup, loginState, installJob };
}

/** Project `prj_a` named "atrium". */
export const PROJECT: Project = { id: "prj_000000000000000a", path: "/work/atrium", name: "atrium", mainBranch: null };
