import {
  FakeClock,
  GIT_SCENE_ENV,
  createGitScene,
  createTempDir,
  readLogRecords,
  present,
  writeScriptedPi,
} from "@atrium/testkit";
import { realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { startTestHost } from "../test/harness";

describe("worktree naming shutdown", () => {
  it("aborts cold model discovery before waiting for naming to close", async () => {
    const scene = await createGitScene("naming-shutdown");
    onTestFinished(scene.cleanup);
    const bin = await createTempDir("naming-shutdown-bin");
    onTestFinished(bin.cleanup);
    const scripted = await writeScriptedPi(bin.path, { rules: { get_available_models: { silent: true } } }, "pi");
    const clock = new FakeClock();
    const host = await startTestHost({
      clock,
      toolEnv: { ...GIT_SCENE_ENV, PATH: `${bin.path}:${present(process.env["PATH"], "PATH")}`, ...scripted.env },
    });
    onTestFinished(host.dispose);
    const client = host.connect();
    onTestFinished(() => client.disconnect());
    await client.connect();
    await host.host.tools;
    const { projectId } = await client.addProject(scene.repo);
    const naming = client.nameBranch(projectId, "修复登录超时", null).then(
      () => "named",
      () => "cancelled",
    );
    await vi.waitFor(() => expect(host.host.resources.snapshot()["pi-process"]).toBe(1));
    let closed = false;
    const stopping = host.host.close().then(() => (closed = true));
    try {
      // Do not advance the catalog's 120-second deadline: shutdown must cancel the cold query itself.
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2_000 });
    } finally {
      // A broken shutdown must still release its test-owned process after the assertion fails.
      clock.advance(120_000);
      await stopping;
    }
    expect(await naming).toBe("cancelled");
    expect(host.host.resources.snapshot()["pi-process"]).toBe(0);
    expect(host.host.resources.snapshot()["pi-oneshot"]).toBeUndefined();
    expect(
      (await readLogRecords(dirname(host.host.logFile))).filter((record) => record["msg"] === "model list timed out"),
    ).toStrictEqual([]);
  });

  it("cancels a child's pending Chinese name without creating its worktree or logging a crash", async () => {
    const scene = await createGitScene("child-naming-shutdown");
    onTestFinished(scene.cleanup);
    const bin = await createTempDir("child-naming-bin");
    onTestFinished(bin.cleanup);
    const sessions = await createTempDir("child-naming-sessions");
    onTestFinished(sessions.cleanup);
    const repo = await realpath(scene.repo);
    const timestamp = "1970-01-01T00:00:00.000Z";
    await writeFile(
      join(sessions.path, "parent.jsonl"),
      [
        { type: "session", version: 3, id: "naming-parent", timestamp, cwd: repo },
        { type: "model_change", id: "m1", parentId: null, timestamp, provider: "faux", modelId: "m1" },
        { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp, thinkingLevel: "off" },
        {
          type: "message",
          id: "u1",
          parentId: "m1",
          timestamp,
          message: { role: "user", content: [{ type: "text", text: "Hi" }], timestamp: 0 },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const scripted = await writeScriptedPi(bin.path, { print: { waitFor: join(bin.path, "never-release") } }, "pi");
    const host = await startTestHost({
      toolEnv: {
        ...GIT_SCENE_ENV,
        ...scripted.env,
        PATH: `${bin.path}:${present(process.env["PATH"], "PATH")}`,
        PI_CODING_AGENT_SESSION_DIR: sessions.path,
      },
    });
    onTestFinished(host.dispose);
    const client = host.connect();
    onTestFinished(() => client.disconnect());
    await client.connect();
    await client.addProject(repo);
    await vi.waitFor(() =>
      expect(
        client.index.getState().sessions.find((entry) => entry.sessionId === "naming-parent")?.model,
      ).toMatchObject({ providerId: "faux", modelId: "m1" }),
    );
    const workspaceId = present(client.index.getState().workspaces[0]?.id, "parent workspace");
    const creating = client
      .createChild(workspaceId, {
        parentSessionId: "naming-parent",
        name: "补测试",
        place: "worktree",
        branch: "atrium/naming-child",
      })
      .then(
        () => "created",
        () => "cancelled",
      );
    await vi.waitFor(() => expect(host.host.resources.snapshot()["pi-oneshot"]).toBe(1));
    await host.host.close();
    expect(await creating).toBe("cancelled");
    expect(await scene.git(repo, "branch", "--list", "atrium/naming-child")).toBe("");
    expect(host.host.resources.snapshot()["pi-oneshot"]).toBe(0);
    expect(
      (await readLogRecords(dirname(host.host.logFile))).filter((record) => record["level"] === "error"),
    ).toStrictEqual([]);
  });
});
