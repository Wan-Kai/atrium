import type { AtriumClient } from "@atrium/client";
import { GIT_SCENE_ENV, createGitScene } from "@atrium/testkit";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { type TestHost, startTestHost } from "../test/harness";

let testHost: TestHost | undefined;

afterEach(async () => {
  await testHost?.dispose();
  testHost = undefined;
});

/** Long enough for git, the watcher and its second of debounce on a busy machine. */
const SEEN = { timeout: 15_000 };

/**
 * A host with a git repository added as a project, and a client showing its workspace.
 *
 * @remarks
 * Real git, real file watching and the real client (testing.md, "分层").
 *
 * @sideEffects Creates a repository and a host; connects a client.
 * @returns The repository, the client and the workspace.
 */
async function showing(): Promise<{ repo: string; client: AtriumClient; workspaceId: string }> {
  const scene = await createGitScene("changes-host");
  onTestFinished(scene.cleanup);
  const repo = await realpath(scene.repo);
  testHost = await startTestHost({ toolEnv: { ...GIT_SCENE_ENV, PATH: process.env["PATH"] ?? "" } });
  await testHost.host.tools;
  const client = testHost.connect();
  onTestFinished(() => client.disconnect());
  await client.connect();
  const { projectId } = await client.addProject(repo);
  await vi.waitFor(() => expect(client.index.getState().workspaces).toHaveLength(1), SEEN);
  const workspaceId = client.index.getState().workspaces.find((one) => one.projectId === projectId)?.id ?? "";
  await client.watchChanges([workspaceId]);
  return { repo, client, workspaceId };
}

describe("workspace changes over the WebSocket", () => {
  it("sends a workspace's changes as files change, and the panel's diff, through real git and a real watcher", async () => {
    const { repo, client, workspaceId } = await showing();
    await vi.waitFor(
      () =>
        expect(client.changes(workspaceId).getState()).toStrictEqual({
          stat: null,
          dirty: false,
          ahead: 0,
          branch: "main",
          base: "origin/main",
        }),
      SEEN,
    );

    await writeFile(join(repo, "README.md"), "start\nmore\n");
    await writeFile(join(repo, "new.txt"), "a\nb\n");

    await vi.waitFor(
      () =>
        expect(client.changes(workspaceId).getState()).toStrictEqual({
          stat: { added: 3, removed: 0 },
          dirty: true,
          ahead: 0,
          branch: "main",
          base: "origin/main",
        }),
      SEEN,
    );
    await client.watchDiff({ workspaceId, mode: "uncommitted" });
    await vi.waitFor(
      () =>
        expect(
          client.diff.getState().files.map(({ path, status, added, content }) => ({ path, status, added, content })),
        ).toStrictEqual([
          { path: "README.md", status: "modified", added: 1, content: "text" },
          { path: "new.txt", status: "added", added: 2, content: "text" },
        ]),
      SEEN,
    );
  });

  it("stops watching once nobody shows the workspace", async () => {
    const { client } = await showing();
    const host = testHost?.host;
    await vi.waitFor(() => expect(host?.resources.snapshot()["changes.watch"]).toBe(1), SEEN);

    await client.watchChanges([]);

    expect(host?.resources.snapshot()["changes.watch"]).toBe(0);
  });
});

describe("workspace files over the WebSocket", () => {
  it("lists a workspace's directories without .git or what git ignores, and reads its files, not through a link", async () => {
    const { repo, client, workspaceId } = await showing();
    await writeFile(join(repo, ".gitignore"), "dist/\n");
    await mkdir(join(repo, "dist"));
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "src", "a.ts"), "export {};\n");
    await symlink("/etc", join(repo, "etc"));

    const root = await client.listDir(workspaceId, "");
    const file = await client.readFile(workspaceId, "src/a.ts");
    const through = await client.readFile(workspaceId, "etc/hosts").catch((error: unknown) => error);

    expect(root.entries.toSorted((a, b) => a.name.localeCompare(b.name))).toStrictEqual([
      { name: ".gitignore", kind: "file" },
      { name: "etc", kind: "link" },
      { name: "README.md", kind: "file" },
      { name: "src", kind: "dir" },
    ]);
    expect(file).toStrictEqual({ size: 11, content: { kind: "text", text: "export {};\n" } });
    expect(through).toMatchObject({ code: "path_invalid" });
  });
});
