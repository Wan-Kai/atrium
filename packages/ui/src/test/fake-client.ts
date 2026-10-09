import type { AtriumClient, ConnectionState, IndexView, SessionView } from "@atrium/client";
import {
  IDLE_CONTROL,
  type IndexSnapshotEvent,
  type Project,
  type SessionSummary,
  type Workspace,
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
    ...fields,
  };
}

/** How the fake answers some commands; the rest succeed. */
export interface FakeAnswers {
  readonly createChat?: () => Promise<void>;
  readonly createSession?: () => Promise<void>;
  readonly prompt?: () => Promise<{ disposition: "started" | "queued" | "handled" }>;
  readonly addProject?: () => Promise<void>;
  readonly openSession?: () => Promise<void>;
}

/**
 * A client that answers as the host would, in memory, recording every command.
 *
 * @remarks
 * Browser tests cannot run a host (the host needs Node); this fake keeps the parts the UI reads
 * real: the list is a real store that commands change as the host's snapshot would, and every
 * watched session has a real view store. Commands are recorded as short strings.
 *
 * @sideEffects none until a command; then updates its stores.
 * @param initial - The list to start from.
 * @param answers - How some commands answer.
 * @returns The client, its recorded calls, the session views and the connection store.
 */
export function fakeClient(initial: Partial<Omit<IndexSnapshotEvent, "type">> = {}, answers: FakeAnswers = {}) {
  const calls: string[] = [];
  const views = new Map<string, StoreApi<SessionView>>();
  const index = createStore<IndexView>(() => ({
    ready: true,
    generation: "h1",
    seq: 1,
    projects: [],
    workspaces: [],
    sessions: [],
    layout: { container: null, tabs: {} },
    preferences: { appearance: "system", displayMode: "summary" },
    resets: [],
    ...initial,
  }));
  const connection = createStore<ConnectionState>(() => ({
    status: "connected",
    traceId: "t",
    hostVersion: "0",
    hostInstanceId: "h1",
  }));
  let created = 0;

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
      return { sessionId: addDraft("chats") };
    },
    async createSession(workspaceId: string) {
      calls.push(`createSession ${workspaceId}`);
      await answers.createSession?.();
      return { sessionId: addDraft(workspaceId) };
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
    async windowFocused() {
      calls.push("windowFocused");
      return {};
    },
    async setPreferences(changes: Record<string, string>) {
      calls.push(`setPreferences ${JSON.stringify(changes)}`);
      index.setState({ preferences: { ...index.getState().preferences, ...changes } });
      return {};
    },
    prompt(sessionId: string, text: string) {
      calls.push(`prompt ${sessionId} ${text}`);
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a test double with the methods the UI uses.
  } as unknown as AtriumClient;
  return { client, calls, views, index, connection };
}

/** Project `prj_a` named "atrium". */
export const PROJECT: Project = { id: "prj_000000000000000a", path: "/work/atrium", name: "atrium" };
