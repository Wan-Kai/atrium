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
import { LAYOUTS_FILE, PREFERENCES_FILE, PROJECTS_FILE, SESSIONS_FILE } from "../store/index-schema";
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
 * @returns The commands, the services, the events a connection received and how often the
 * session manager reported a change.
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
  const layouts = createLayouts({ file: (await loadIndexFile(index, LAYOUTS_FILE, 0)).file, clock: systemClock });
  const preferences = createPreferenceStore((await loadIndexFile(index, PREFERENCES_FILE, 0)).file);
  const feed = createIndexFeed({
    registry: subscriptions,
    generation: "h1",
    build: () => ({
      projects: [],
      workspaces: [],
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
  const listed: [string, boolean][] = [];
  const sessions = createSessionManager({
    chatsRoot: join(root, "chats"),
    tools: Promise.resolve({
      env: { PATH: process.env["PATH"] ?? "", ...scripted.env },
      pi: { status: "ready", piPath: scripted.piPath, version: [1, 0, 2] },
    }),
    subscriptions,
    catalog,
    layouts,
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
  });
  onTestFinished(() => sessions.close());
  const commands = createIndexCommands({
    projects,
    workspaces: { windowFocused: () => undefined },
    sessions,
    preferences,
    feed,
    listModels: async (containerId, refresh) => {
      listed.push([containerId, refresh]);
      return { models: [], defaultModel: null };
    },
  });
  return { commands, projects, sessions, layouts, received, root, sessionChanges, listed };
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

describe("IndexCommands.listModels", () => {
  it("hands the container and whether to ask pi again to the model lister", async () => {
    const { commands, listed } = await assemble();

    expect(await commands.listModels("chats", true)).toStrictEqual({ models: [], defaultModel: null });
    expect(listed).toStrictEqual([["chats", true]]);
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
