import { createTempDir } from "@atrium/testkit";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { loadIndex } from "./load-index";

const NOW = Date.UTC(2026, 9, 8, 1, 2, 3, 4);

/** A valid document of each file, with every kind of record the schemas allow. */
const DOCUMENTS = {
  projects: {
    projects: [{ id: "prj_1", path: "/work/app", name: "app", mainBranch: null }],
    workspaces: [
      {
        id: "wks_1",
        projectId: "prj_1",
        kind: "local",
        dir: "/work/app",
        alias: null,
        baseCommit: null,
        external: false,
      },
      {
        id: "wks_2",
        projectId: "prj_1",
        kind: "worktree",
        dir: "/work/app-feature",
        alias: "侧栏",
        baseCommit: "abc123",
        external: true,
        archived: { at: 3, branch: "feature", head: "abc123" },
      },
    ],
  },
  chats: { chats: [{ id: "cht_a", alias: "合并原理" }] },
  sessions: {
    sessions: [{ sessionId: "s1", containerId: "wks_1", cwd: "/work/app", draft: false, archived: true, createdAt: 1 }],
  },
  layouts: {
    clients: [{ clientId: "client-1", seenAt: 2, container: "wks_1", tabs: { wks_1: { open: ["s1"], active: "s1" } } }],
  },
  preferences: {
    appearance: "dark",
    lastModel: { providerId: "anthropic", modelId: "claude-opus-5-5" },
    thinkingByModel: { "anthropic/claude-opus-5-5": "high" },
  },
};

/** A client's tabs in one container. */
const tab = (open: string[], active: string | null) => ({ open, active });

/** Each file's current format version. */
const VERSIONS: Record<keyof typeof DOCUMENTS, number> = {
  projects: 1,
  chats: 1,
  sessions: 2,
  layouts: 2,
  preferences: 3,
};

/**
 * Creates Atrium's home for one test.
 *
 * @remarks
 * Real files, as everywhere in the store's tests.
 *
 * @sideEffects Creates a temporary directory, removed when the test ends.
 * @returns Its path.
 */
async function home(): Promise<string> {
  const dir = await createTempDir("load-index");
  onTestFinished(dir.cleanup);
  return dir.path;
}

/**
 * A logger that keeps its records in memory.
 *
 * @remarks
 * Resets are logged, and the tests check those lines.
 *
 * @sideEffects Installs the global context manager on first use; shut down when the test ends.
 * @returns The records and the logger.
 */
function recording() {
  const tracing = recordingTracing();
  onTestFinished(tracing.shutdown);
  return tracing;
}

describe("loadIndex", () => {
  it("loads each file from its own name in the home", async () => {
    const dir = await home();
    for (const [name, document] of Object.entries(DOCUMENTS)) {
      const version = VERSIONS[name as keyof typeof DOCUMENTS];
      await writeFile(join(dir, `${name}.json`), JSON.stringify({ version, ...document }));
    }

    const index = await loadIndex(dir, NOW, recording().logger);

    expect({
      projects: index.projects.read(),
      chats: index.chats.read(),
      sessions: index.sessions.read(),
      layouts: index.layouts.read(),
      preferences: index.preferences.read(),
    }).toStrictEqual(DOCUMENTS);
    expect(index.resets).toStrictEqual([]);
  });

  it.each([
    [
      "projects",
      "a project with no name",
      { projects: [{ id: "prj_1", path: "/work/app", mainBranch: null }], workspaces: [] },
      { projects: [], workspaces: [] },
    ],
    [
      "projects",
      "a workspace of an unknown kind",
      { projects: [], workspaces: [{ ...DOCUMENTS.projects.workspaces[0], kind: "remote" }] },
      { projects: [], workspaces: [] },
    ],
    [
      "projects",
      "a workspace archived at no time",
      { projects: [], workspaces: [{ ...DOCUMENTS.projects.workspaces[1], archived: { branch: null, head: null } }] },
      { projects: [], workspaces: [] },
    ],
    [
      "sessions",
      "a session with no id",
      { sessions: [{ ...DOCUMENTS.sessions.sessions[0], sessionId: 1 }] },
      { sessions: [] },
    ],
    ["chats", "a chat with no name", { chats: [{ id: "cht_a" }] }, { chats: [] }],
    ["layouts", "no clients", {}, { clients: [] }],
    ["layouts", "a client with no id", { clients: [{ seenAt: 2, container: null, tabs: {} }] }, { clients: [] }],
    [
      "layouts",
      "tabs with no list of open sessions",
      { clients: [{ clientId: "c", seenAt: 2, container: null, tabs: { wks_1: { active: null } } }] },
      { clients: [] },
    ],
    [
      "preferences",
      "an unknown appearance",
      { appearance: "sepia" },
      { appearance: "system", lastModel: null, thinkingByModel: {} },
    ],
  ] as const)("resets %s with %s, keeping it aside and logging where", async (name, _case, document, empty) => {
    const dir = await home();
    const text = JSON.stringify({ version: 1, ...document });
    await writeFile(join(dir, `${name}.json`), text);
    const { records, logger } = recording();

    const index = await loadIndex(dir, NOW, logger);

    const copy = `${name}.corrupt-2026-10-08T01-02-03.004Z.json`;
    expect(index.resets).toStrictEqual([name]);
    expect(index[name].read()).toStrictEqual(empty);
    expect(await readdir(dir)).toStrictEqual([copy]);
    expect(await readFile(join(dir, copy), "utf8")).toBe(text);
    expect(records.filter((record) => record["msg"] === "index file was damaged and has been reset")).toStrictEqual([
      expect.objectContaining({ level: "warn", file: name, copy }),
    ]);
  });

  it.each([
    ["a record that is not an object", ["s1"]],
    ["a record that is null", [null]],
    ["a chat's record with no directory", [{ sessionId: "s1", containerId: "chats", cwd: 5 }]],
  ])("resets version 1's sessions with %s, as it does any damaged file", async (_case, sessions) => {
    const dir = await home();
    await writeFile(join(dir, "sessions.json"), JSON.stringify({ version: 1, sessions }));

    const index = await loadIndex(dir, NOW, recording().logger);

    expect(index.resets).toStrictEqual(["sessions"]);
    expect(index.sessions.read()).toStrictEqual({ sessions: [] });
  });

  it("files the sessions and tabs of version 1's chats under each session's own chat, backing both files up", async () => {
    const dir = await home();
    const record = { draft: false, archived: false, createdAt: 1 };
    const sessions = {
      version: 1,
      sessions: [
        { sessionId: "s1", containerId: "chats", cwd: "/home/.atrium/chats/a", ...record },
        { sessionId: "s2", containerId: "chats", cwd: "/home/.atrium/chats/b", ...record },
        { sessionId: "s3", containerId: "chats", cwd: "/home/.atrium/chats/a", ...record },
        { sessionId: "s4", containerId: "wks_1", cwd: "/work/app", ...record },
        { sessionId: "s5", containerId: "chats", cwd: "/home/.atrium/chats/b", ...record },
      ],
    };
    const layouts = {
      version: 1,
      clients: [
        {
          clientId: "in-chats",
          seenAt: 2,
          container: "chats",
          tabs: { chats: tab(["s1", "s2", "gone", "s4", "s3", "s5"], "s3"), wks_1: tab(["s4"], "s4") },
        },
        { clientId: "no-active", seenAt: 3, container: "chats", tabs: { chats: tab(["s2"], null) } },
        { clientId: "elsewhere", seenAt: 4, container: "wks_1", tabs: { chats: tab(["s2"], "s2") } },
        { clientId: "untouched", seenAt: 5, container: null, tabs: {} },
        { clientId: "active-not-a-chat", seenAt: 6, container: "chats", tabs: { chats: tab(["s2", "s4"], "s4") } },
      ],
    };
    await writeFile(join(dir, "sessions.json"), JSON.stringify(sessions));
    await writeFile(join(dir, "layouts.json"), JSON.stringify(layouts));

    const index = await loadIndex(dir, NOW, recording().logger);

    expect(index.sessions.read().sessions.map((entry) => [entry.sessionId, entry.containerId])).toStrictEqual([
      ["s1", "cht_a"],
      ["s2", "cht_b"],
      ["s3", "cht_a"],
      ["s4", "wks_1"],
      ["s5", "cht_b"],
    ]);
    expect(index.layouts.read().clients).toStrictEqual([
      {
        clientId: "in-chats",
        seenAt: 2,
        container: "cht_a",
        tabs: { wks_1: tab(["s4"], "s4"), cht_a: tab(["s1", "s3"], "s3"), cht_b: tab(["s2", "s5"], "s2") },
      },
      { clientId: "no-active", seenAt: 3, container: null, tabs: { cht_b: tab(["s2"], "s2") } },
      { clientId: "elsewhere", seenAt: 4, container: "wks_1", tabs: { cht_b: tab(["s2"], "s2") } },
      { clientId: "untouched", seenAt: 5, container: null, tabs: {} },
      { clientId: "active-not-a-chat", seenAt: 6, container: null, tabs: { cht_b: tab(["s2"], "s2") } },
    ]);
    expect(JSON.parse(await readFile(join(dir, "layouts.json"), "utf8"))).toMatchObject({ version: 2 });
    expect(JSON.parse(await readFile(join(dir, "sessions.json"), "utf8"))).toMatchObject({ version: 2 });
    expect(JSON.parse(await readFile(join(dir, "sessions.v1.bak"), "utf8"))).toStrictEqual(sessions);
    expect(JSON.parse(await readFile(join(dir, "layouts.v1.bak"), "utf8"))).toStrictEqual(layouts);
    expect(index.resets).toStrictEqual([]);
  });
});
