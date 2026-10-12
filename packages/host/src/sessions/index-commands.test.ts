import { createSessionFileReader } from "@atrium/pi";
import { CommandError, type SessionEvent } from "@atrium/protocol";
import { createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { PONG_ENTRIES } from "../../test/scripted-chat";
import { systemClock } from "../platform/clock";
import { createProjectService } from "../projects/project-service";
import { loadIndexFile } from "../store/index-file";
import { createChatRecords, listChats } from "../store/chat-records";
import { CHATS_FILE, layoutsFile, PREFERENCES_FILE, PROJECTS_FILE, SESSIONS_FILE } from "../store/index-schema";
import { createPreferenceStore } from "../store/preferences";
import { createIndexFeed } from "../sync/index-feed";
import { SubscriptionRegistry } from "../sync/subscriptions";
import { createIndexCommands } from "./index-commands";
import { createLayouts } from "./layouts";
import { createSessionCatalog } from "./session-catalog";
import { createSessionManager } from "./session-manager";

/**
 * The list commands over real services, with a scripted pi and no git.
 *
 * @remarks
 * Removing a project reaches across the project registry, the catalog and the session manager,
 * so they are assembled as `main.ts` does.
 *
 * @sideEffects Creates temporary files; everything is closed when the test ends.
 * @returns The commands, the services, the events a connection received, how often the session
 * manager reported a change and how often the workspaces heard the window was focused.
 */
async function assemble() {
  const temp = await createTempDir("index-commands");
  onTestFinished(temp.cleanup);
  const root = await realpath(temp.path);
  const index = join(root, "index");
  const scripted = await writeScriptedPi(root, {
    rules: { get_state: { data: { sessionId: "pi-session-1" } }, get_entries: PONG_ENTRIES },
  });
  const recording = recordingTracing();
  onTestFinished(recording.shutdown);
  let next = 0;
  const projects = createProjectService({
    file: (await loadIndexFile(index, PROJECTS_FILE, 0)).file,
    git: Promise.resolve(null),
    newId: (prefix) => `${prefix}_${String((next += 1)).padStart(16, "0")}`,
  });
  const catalog = createSessionCatalog({
    file: (await loadIndexFile(index, SESSIONS_FILE, 0)).file,
    location: Promise.resolve(null),
    chatsRoot: join(root, "chats"),
    workspaces: () => projects.workspaces().map((record) => ({ id: record.id, dir: record.dir })),
    reader: createSessionFileReader(),
    clock: systemClock,
    logger: recording.logger,
  });
  onTestFinished(() => catalog.close());
  const subscriptions = new SubscriptionRegistry(recording.resources);
  const received: SessionEvent[] = [];
  subscriptions.connect("c1", (event) => received.push(event as SessionEvent), "client-1");
  const layouts = createLayouts({
    file: (await loadIndexFile(index, layoutsFile({ sessions: [] }), 0)).file,
    clock: systemClock,
  });
  const preferences = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);
  const chatRecords = createChatRecords((await loadIndexFile(index, CHATS_FILE, 0)).file);
  const feed = createIndexFeed({
    registry: subscriptions,
    generation: "h1",
    build: () => ({
      projects: [],
      workspaces: [],
      // As the host builds them.
      chats: listChats(catalog.chats(), chatRecords),
      sessions: [],
      preferences: preferences.read(),
      resets: [],
    }),
    layoutOf: (clientId) => layouts.of(clientId),
    clock: systemClock,
    resources: recording.resources,
  });
  onTestFinished(() => feed.close());
  const sessionChanges = { count: 0 };
  const focused = { count: 0 };
  const listed: [string | null, boolean][] = [];
  const discovered: (readonly string[])[] = [];
  const refreshed: string[] = [];
  const archiving: string[] = [];
  const sessions = createSessionManager({
    chatsRoot: join(root, "chats"),
    tools: async () => ({
      env: { PATH: process.env["PATH"] ?? "", ...scripted.env },
      pi: { status: "ready", piPath: scripted.piPath, version: [1, 0, 2] },
    }),
    subscriptions,
    catalog,
    layouts,
    chats: chatRecords,
    workspaces: {
      dirOf: (id) => projects.workspaces().find((record) => record.id === id)?.dir,
      refresh: () => undefined,
    },
    onChange: () => (sessionChanges.count += 1),
    clock: systemClock,
    resources: recording.resources,
    tracer: recording.tracer,
    logger: recording.logger,
    newId: () => `id${(next += 1)}`,
    newSessionId: () => "pi-session-1",
  });
  onTestFinished(() => sessions.close());
  const commands = createIndexCommands({
    projects,
    workspaces: {
      windowFocused: () => (focused.count += 1),
      refresh: (workspaceId) => refreshed.push(workspaceId),
    },
    sessions,
    archiver: {
      archive: async (workspaceId) => void archiving.push(`archive ${workspaceId}`),
      restore: async (workspaceId) => void archiving.push(`restore ${workspaceId}`),
    },
    preferences,
    chats: () => catalog.chats(),
    chatRecords,
    feed,
    listModels: async (workspaceId, refresh) => {
      listed.push([workspaceId, refresh]);
      return { models: [], defaultModel: null };
    },
    discover: async (taken) => {
      discovered.push(taken);
      return [{ path: join(root, "found"), sessions: 2, lastUsedAt: 5 }];
    },
  });
  return {
    commands,
    projects,
    sessions,
    chatRecords,
    layouts,
    preferences,
    received,
    root,
    sessionChanges,
    listed,
    focused,
    discovered,
    refreshed,
    archiving,
  };
}

describe("IndexCommands.removeProject", () => {
  it("stops the pi of every session in the project and drops its tabs, leaving other projects", async () => {
    const { commands, projects, sessions, layouts, received, root } = await assemble();
    const dir = join(root, "app");
    await mkdir(dir);
    await mkdir(join(root, "other"));
    const { projectId } = await commands.addProject(dir);
    const { projectId: otherId } = await commands.addProject(join(root, "other"));
    const workspaceId = present(projects.workspaces()[0], "the local workspace").id;
    const { sessionId } = await sessions.createSession("client-1", workspaceId);
    await sessions.subscribe("c1", [sessionId]);

    await commands.removeProject(projectId);

    await vi.waitFor(() => expect(received.at(-1)).toMatchObject({ type: "session_exited", reason: "requested" }));
    expect(layouts.of("client-1")).toStrictEqual({ container: null, tabs: {} });
    expect(projects.projects().map((project) => project.id)).toStrictEqual([otherId]);
  });
});

describe("IndexCommands.removeProject of an unknown project", () => {
  it("refuses it, and stops and changes nothing", async () => {
    const { commands, projects, sessions, received, root, sessionChanges } = await assemble();
    const dir = join(root, "app");
    await mkdir(dir);
    await commands.addProject(dir);
    const { sessionId } = await sessions.createSession("client-1", present(projects.workspaces()[0], "workspace").id);
    await sessions.subscribe("c1", [sessionId]);
    const changes = sessionChanges.count;

    await expect(commands.removeProject("prj_ffffffffffffffff")).rejects.toStrictEqual(
      new CommandError("project_not_found", { projectId: "prj_ffffffffffffffff" }),
    );
    expect(received.map((event) => event.type)).toStrictEqual(["session_snapshot"]);
    expect(sessionChanges.count).toBe(changes);
  });
});

describe("IndexCommands.renameProject", () => {
  it("renames the project", async () => {
    const { commands, projects, root } = await assemble();
    const dir = join(root, "app");
    await mkdir(dir);
    const { projectId } = await commands.addProject(dir);

    await expect(commands.renameProject(projectId, "应用")).resolves.toStrictEqual({});

    expect(projects.projects().map((project) => project.name)).toStrictEqual(["应用"]);
  });
});

describe("IndexCommands.renameWorkspace", () => {
  it("names the workspace, and with null forgets its name", async () => {
    const { commands, projects, root } = await assemble();
    const dir = join(root, "app");
    await mkdir(dir);
    await commands.addProject(dir);
    const workspaceId = present(projects.workspaces()[0], "the local workspace").id;

    await expect(commands.renameWorkspace(workspaceId, "主干")).resolves.toStrictEqual({});
    const named = projects.workspaces().map((workspace) => workspace.alias);
    await commands.renameWorkspace(workspaceId, null);

    expect([named, projects.workspaces().map((workspace) => workspace.alias)]).toStrictEqual([["主干"], [null]]);
  });
});

describe("IndexCommands.listModels", () => {
  it("hands the workspace, or none, and whether to ask pi again to the model lister", async () => {
    const { commands, listed } = await assemble();

    expect(await commands.listModels(null, true)).toStrictEqual({ models: [], defaultModel: null });
    expect(await commands.listModels("wks_0000000000000001", false)).toStrictEqual({ models: [], defaultModel: null });
    expect(listed).toStrictEqual([
      [null, true],
      ["wks_0000000000000001", false],
    ]);
  });
});

describe("IndexCommands.renameChat", () => {
  it("names a chat there is, and with null forgets its name, telling the list", async () => {
    const { commands, sessions, chatRecords, received } = await assemble();
    await sessions.createChat("client-1");
    const chatId = "cht_id1";
    await commands.subscribeIndex("c1");

    await expect(commands.renameChat(chatId, "合并原理")).resolves.toStrictEqual({});
    commands.answering("c1");
    expect(chatRecords.alias(chatId)).toBe("合并原理");
    expect(received.at(-1)).toMatchObject({
      type: "index_changes",
      chats: { upsert: [{ id: chatId, alias: "合并原理" }], remove: [] },
    });

    await commands.renameChat(chatId, null);
    expect(chatRecords.alias(chatId)).toBeNull();
  });

  it("refuses a chat whose directory is not there, naming nothing", async () => {
    const { commands, sessions, chatRecords } = await assemble();
    // Another chat is there.
    await sessions.createChat("client-1");

    await expect(commands.renameChat("cht_gone", "名字")).rejects.toStrictEqual(
      new CommandError("chat_not_found", { chatId: "cht_gone" }),
    );
    expect(chatRecords.alias("cht_gone")).toBeNull();
  });
});

describe("IndexCommands.discoverProjects", () => {
  it("looks for directories that are not a project or one of its workspaces yet", async () => {
    const { commands, discovered, root } = await assemble();
    const dir = join(root, "app");
    await mkdir(dir);
    await commands.addProject(dir);

    expect(await commands.discoverProjects()).toStrictEqual({
      directories: [{ path: join(root, "found"), sessions: 2, lastUsedAt: 5 }],
    });
    // The project's path and its local workspace's directory.
    expect(discovered).toStrictEqual([[dir, dir]]);
  });
});

describe("IndexCommands.setMainBranch", () => {
  it("goes back to origin/HEAD and works out the project's workspaces again, leaving other projects", async () => {
    const { commands, projects, refreshed, root } = await assemble();
    await mkdir(join(root, "app"));
    await mkdir(join(root, "other"));
    const { projectId } = await commands.addProject(join(root, "app"));
    await commands.addProject(join(root, "other"));
    const local = present(projects.workspaces()[0], "the local workspace").id;

    expect(await commands.setMainBranch(projectId, null)).toStrictEqual({});
    expect(await commands.listBranches(projectId)).toStrictEqual({ branches: [], head: null });

    expect(refreshed).toStrictEqual([local]);
  });

  it("changes and works out nothing when the branch is not on origin", async () => {
    const { commands, refreshed, root } = await assemble();
    await mkdir(join(root, "app"));
    const { projectId } = await commands.addProject(join(root, "app"));

    await expect(commands.setMainBranch(projectId, "main")).rejects.toStrictEqual(
      new CommandError("branch_not_found", { branch: "main" }),
    );
    expect(refreshed).toStrictEqual([]);
  });
});

describe("IndexCommands.archiveWorkspace", () => {
  it("hands archiving and restoring a workspace to the archiver", async () => {
    const { commands, archiving } = await assemble();

    expect([await commands.archiveWorkspace("wks_1"), await commands.restoreWorkspace("wks_2")]).toStrictEqual([
      {},
      {},
    ]);
    expect(archiving).toStrictEqual(["archive wks_1", "restore wks_2"]);
  });
});

describe("IndexCommands.windowFocused", () => {
  it("tells the workspaces the window was focused", async () => {
    const { commands, focused } = await assemble();

    expect(await commands.windowFocused()).toStrictEqual({});
    expect(focused.count).toBe(1);
  });
});

describe("IndexCommands.setPreferences", () => {
  it("keeps a proxy with its address in one form, and clears it", async () => {
    const { commands, preferences } = await assemble();

    expect(
      await commands.setPreferences({ appearance: "dark", proxy: { url: "HTTP://127.0.0.1:7897/", noProxy: ["a.b"] } }),
    ).toStrictEqual({});
    expect(preferences.read()).toMatchObject({
      appearance: "dark",
      proxy: { url: "http://127.0.0.1:7897", noProxy: ["a.b"] },
    });

    await commands.setPreferences({ proxy: null });

    expect(preferences.read()).toMatchObject({ appearance: "dark", proxy: null });
  });

  it("refuses a proxy it would not hand on, changing nothing", async () => {
    const { commands, preferences, received } = await assemble();
    await commands.subscribeIndex("c1");

    await expect(
      commands.setPreferences({ appearance: "dark", proxy: { url: "socks5://127.0.0.1:7897", noProxy: [] } }),
    ).rejects.toMatchObject({ code: "proxy_invalid", params: { reason: "scheme" } });
    commands.answering("c1");

    expect(preferences.read()).toMatchObject({ appearance: "system", proxy: null });
    expect(received).toHaveLength(1);
  });
});

describe("IndexCommands.answering", () => {
  it("sends the connection the list changes waiting for it at once", async () => {
    const { commands, received } = await assemble();
    await commands.subscribeIndex("c1");
    await commands.setPreferences({ appearance: "dark" });

    commands.answering("c1");

    expect(received).toMatchObject([
      { type: "index_snapshot", preferences: { appearance: "system" } },
      { type: "index_changes", preferences: { appearance: "dark" } },
    ]);
    expect(received).toHaveLength(2);
  });
});
