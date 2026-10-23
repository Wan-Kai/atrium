import { CommandError } from "@atrium/protocol";
import { createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { type TestHost, startTestHost } from "../test/harness";

let testHost: TestHost | undefined;

afterEach(async () => {
  await testHost?.dispose();
  testHost = undefined;
});

describe("model lists over the WebSocket", () => {
  it('answers path_not_found for a workspace whose directory was deleted, starting no pi (SPEC-0001, "模型与输入框")', async () => {
    const bin = await createTempDir("models-bin");
    onTestFinished(bin.cleanup);
    const scripted = await writeScriptedPi(bin.path, {}, "pi");
    const projects = await createTempDir("models-projects");
    onTestFinished(projects.cleanup);
    const app = join(await realpath(projects.path), "app");
    await mkdir(app);
    testHost = await startTestHost({ toolEnv: { PATH: `${bin.path}:/usr/bin:/bin`, ...scripted.env } });
    await testHost.host.tools;
    const client = testHost.connect();
    onTestFinished(() => client.disconnect());
    await client.connect();
    await client.addProject(app);
    const workspace = await vi.waitFor(() =>
      present(
        client.index.getState().workspaces.find(({ dir }) => dir === app),
        "the project's workspace",
      ),
    );

    // As a worktree deleted outside Atrium, with the workspace still listed.
    await rm(app, { recursive: true });
    await client.loadModels(workspace.id);

    const list = client.models(workspace.id).getState();
    expect(list.status).toBe("failed");
    expect(list.error).toStrictEqual(new CommandError("path_not_found", { path: app }));
    const pi = new Set(["pi started", "pi exited", "pi did not start"]);
    expect((await testHost.readLog()).filter(({ msg }) => pi.has(String(msg)))).toStrictEqual([]);
  });
});
