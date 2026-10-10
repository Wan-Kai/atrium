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
      },
    ],
  },
  sessions: {
    sessions: [{ sessionId: "s1", containerId: "wks_1", cwd: "/work/app", draft: false, archived: true, createdAt: 1 }],
  },
  layouts: {
    clients: [{ clientId: "client-1", seenAt: 2, container: "wks_1", tabs: { wks_1: { open: ["s1"], active: "s1" } } }],
  },
  preferences: {
    appearance: "dark",
    displayMode: "thinking",
    lastModel: { providerId: "anthropic", modelId: "claude-opus-5-5" },
    thinkingByModel: { "anthropic/claude-opus-5-5": "high" },
  },
};

/** Each file's current format version. */
const VERSIONS: Record<keyof typeof DOCUMENTS, number> = { projects: 1, sessions: 1, layouts: 1, preferences: 2 };

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
      "sessions",
      "a session with no id",
      { sessions: [{ ...DOCUMENTS.sessions.sessions[0], sessionId: 1 }] },
      { sessions: [] },
    ],
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
      { appearance: "sepia", displayMode: "summary" },
      { appearance: "system", displayMode: "summary", lastModel: null, thinkingByModel: {} },
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
});
