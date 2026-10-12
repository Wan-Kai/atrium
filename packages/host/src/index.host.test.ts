import { type AtriumClient, createAtriumClient } from "@atrium/client";
import { CommandError } from "@atrium/protocol";
import { GIT_SCENE_ENV, createGitScene, createTempDir } from "@atrium/testkit";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { startHost } from "./main";
import { IndexTooNewError } from "./store/index-file";

const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuvwxyz";

/** How long a scan with real git may take on a loaded machine, as under mutation testing. */
const SCAN = { timeout: 10_000 };

/**
 * A home, a repository with a worktree and pi's session directory, at real paths.
 *
 * @remarks
 * The host finds git on the scenes' PATH and pi's sessions in one directory; no pi is found, so
 * nothing starts a session.
 *
 * @sideEffects Creates the directories, removed when the test ends.
 * @returns The places and the host's tool environment.
 */
async function place() {
  const scene = await createGitScene("index-host");
  onTestFinished(scene.cleanup);
  const root = await realpath(scene.root);
  const repo = join(root, "repo");
  const worktree = await realpath(await scene.worktree("feature"));
  const piSessions = join(root, "pi-sessions");
  const home = join(root, "atrium");
  return {
    scene,
    repo,
    worktree,
    piSessions,
    home,
    toolEnv: { ...GIT_SCENE_ENV, PATH: process.env["PATH"] ?? "", PI_CODING_AGENT_SESSION_DIR: piSessions },
  };
}

/**
 * Starts a host on a home and connects a client to it.
 *
 * @remarks
 * The client id is fixed, so a restarted host gives the same client its layout back.
 *
 * @sideEffects Starts a host and connects; both stop when the test ends.
 * @param at - The places.
 * @returns The host and the client.
 */
async function hostAndClient(at: Awaited<ReturnType<typeof place>>) {
  const host = await startHost({ home: at.home, token: TOKEN, toolEnv: at.toolEnv, piLatestUrl: null });
  onTestFinished(host.close);
  const client: AtriumClient = createAtriumClient({
    url: `ws://127.0.0.1:${host.port}`,
    token: TOKEN,
    clientId: "index-client",
    reconnectDelaysMs: [],
  });
  onTestFinished(() => client.disconnect());
  await client.connect();
  await vi.waitFor(() => expect(client.index.getState().ready).toBe(true));
  return { host, client };
}

describe("the list over the WebSocket", () => {
  it("lists a project added with its worktrees, merge states and terminal sessions found on focus", async () => {
    const at = await place();
    const { client } = await hostAndClient(at);

    const { projectId } = await client.addProject(at.repo);

    await vi.waitFor(
      () =>
        expect(client.index.getState().workspaces.map(({ kind, dir, branch }) => [kind, dir, branch])).toStrictEqual([
          ["local", at.repo, "main"],
          ["worktree", at.worktree, "feature"],
        ]),
      SCAN,
    );
    expect(client.index.getState().projects).toStrictEqual([
      { id: projectId, path: at.repo, name: "repo", mainBranch: null },
    ]);
    await vi.waitFor(
      () =>
        expect(client.index.getState().workspaces[1]?.merge).toStrictEqual({
          dirty: false,
          ahead: 0,
          verdict: "noChange",
          reason: null,
        }),
      SCAN,
    );

    await mkdir(at.piSessions, { recursive: true });
    const header = { type: "session", id: "terminal-1", timestamp: "", cwd: at.worktree };
    const user = { type: "message", id: "u", parentId: null, timestamp: "", message: { role: "user", content: "hi" } };
    await writeFile(join(at.piSessions, "t.jsonl"), `${JSON.stringify(header)}\n${JSON.stringify(user)}\n`);
    await client.windowFocused();

    await vi.waitFor(
      () =>
        expect(client.index.getState().sessions).toMatchObject([
          { sessionId: "terminal-1", containerId: client.index.getState().workspaces[1]?.id, prompt: "hi" },
        ]),
      SCAN,
    );
    await expect(client.addProject(at.worktree)).rejects.toStrictEqual(
      new CommandError("project_exists", { projectId }),
    );
  });

  it("counts worktrees against the main branch chosen on origin, and shows the choice in the list", async () => {
    const at = await place();
    const { client } = await hostAndClient(at);
    await at.scene.commit(at.worktree, "feature.txt", "feature\n");
    await at.scene.git(at.worktree, "push", "--quiet", "origin", "HEAD:next");
    await at.scene.git(at.repo, "fetch", "--quiet", "origin");
    const { projectId } = await client.addProject(at.repo);
    await vi.waitFor(() => expect(client.index.getState().workspaces[1]?.merge?.ahead).toBe(1), SCAN);

    const branches = await client.listBranches(projectId);
    await client.setMainBranch(projectId, "next");

    expect(branches).toStrictEqual({ branches: ["main", "next"], head: "main" });
    await vi.waitFor(() => expect(client.index.getState().workspaces[1]?.merge?.ahead).toBe(0), SCAN);
    expect(client.index.getState().projects).toMatchObject([{ id: projectId, mainBranch: "next" }]);
  });

  it("keeps preferences and each client's layout across a restart", async () => {
    const at = await place();
    const first = await hostAndClient(at);
    await first.client.setPreferences({ appearance: "dark" });
    await first.client.selectContainer("cht_a");
    first.client.disconnect();
    await first.host.close();

    const { client } = await hostAndClient(at);

    expect(client.index.getState()).toMatchObject({
      preferences: { appearance: "dark" },
      layout: { container: "cht_a", tabs: {} },
      resets: [],
    });
  });

  it("resets a damaged index file, keeping it aside, and says so in the list", async () => {
    const at = await place();
    await mkdir(at.home, { recursive: true });
    await writeFile(join(at.home, "projects.json"), "{ damaged");

    const { client } = await hostAndClient(at);

    expect(client.index.getState()).toMatchObject({ resets: ["projects"], projects: [] });
    expect((await readdir(at.home)).filter((name) => name.startsWith("projects.corrupt-"))).toHaveLength(1);
  });

  it("refuses to start on an index a newer Atrium wrote, and lets the next host start", async () => {
    const home = await createTempDir("index-too-new");
    onTestFinished(home.cleanup);
    const newer = JSON.stringify({ version: 99, sessions: "new shape" });
    await writeFile(join(home.path, "sessions.json"), newer);

    await expect(
      startHost({ home: home.path, token: TOKEN, toolEnv: { PATH: "" }, piLatestUrl: null }),
    ).rejects.toThrow(IndexTooNewError);

    expect(await readFile(join(home.path, "sessions.json"), "utf8")).toBe(newer);
    await writeFile(join(home.path, "sessions.json"), JSON.stringify({ version: 1, sessions: [] }));
    const host = await startHost({ home: home.path, token: TOKEN, toolEnv: { PATH: "" }, piLatestUrl: null });
    await host.close();
  });
});
