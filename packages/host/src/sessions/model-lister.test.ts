import { type ModelList, PiRequestError } from "@atrium/pi";
import { CommandError } from "@atrium/protocol";
import { createTempDir } from "@atrium/testkit";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createModelLister } from "./model-lister";

const WORKSPACE = "wks_000000000000000a";

/**
 * A lister over a catalog that answers with `answer`, recording what it was asked.
 *
 * @remarks
 * The catalog itself is tested in the pi package; here only the mapping around it. The workspace's
 * directory and Atrium's are real, as the lister looks at them first.
 *
 * @sideEffects Creates the directories, removed when the test ends.
 * @param answer - What the catalog does.
 * @returns The lister, the catalog's calls and the two directories.
 */
async function lister(answer: () => Promise<ModelList>) {
  const root = await createTempDir("model-lister");
  onTestFinished(root.cleanup);
  const app = join(root.path, "app");
  const home = join(root.path, "home");
  await mkdir(app);
  await mkdir(home);
  const calls: [string, boolean][] = [];
  const list = createModelLister({
    catalog: {
      list: (dir, refresh) => {
        calls.push([dir, refresh]);
        return answer();
      },
    },
    dirOf: (workspaceId) => (workspaceId === WORKSPACE ? app : undefined),
    chatsDir: home,
  });
  return { list, calls, app, home };
}

const LIST: ModelList = {
  models: [
    {
      providerId: "anthropic",
      modelId: "haiku",
      name: "Haiku",
      contextWindow: 200_000,
      maxOutput: 64_000,
      supportsImage: true,
      thinkingLevels: ["off"],
      fast: null,
    },
  ],
  defaultModel: { providerId: "anthropic", modelId: "haiku" },
};

describe("createModelLister", () => {
  it("lists a workspace's models in its directory, and those outside any in Atrium's directory", async () => {
    const { list, calls, app, home } = await lister(async () => LIST);

    expect(await list(WORKSPACE, false)).toStrictEqual(LIST);
    expect(await list(null, true)).toStrictEqual(LIST);
    expect(calls).toStrictEqual([
      [app, false],
      [home, true],
    ]);
  });

  it('answers path_not_found without asking pi when the workspace\'s directory is gone (SPEC-0001, "模型与输入框")', async () => {
    const { list, calls, app } = await lister(async () => LIST);
    await rm(app, { recursive: true });

    await expect(list(WORKSPACE, false)).rejects.toStrictEqual(new CommandError("path_not_found", { path: app }));
    await expect(list(WORKSPACE, true)).rejects.toStrictEqual(new CommandError("path_not_found", { path: app }));
    expect(calls).toStrictEqual([]);
  });

  it("answers path_not_found when a file stands where the workspace's directory was", async () => {
    const { list, calls, app } = await lister(async () => LIST);
    await rm(app, { recursive: true });
    await writeFile(app, "");

    await expect(list(WORKSPACE, false)).rejects.toStrictEqual(new CommandError("path_not_found", { path: app }));
    expect(calls).toStrictEqual([]);
  });

  it("answers path_not_found for those outside any workspace when Atrium's directory is gone", async () => {
    const { list, calls, home } = await lister(async () => LIST);
    await rm(home, { recursive: true });

    await expect(list(null, false)).rejects.toStrictEqual(new CommandError("path_not_found", { path: home }));
    expect(calls).toStrictEqual([]);
  });

  it("refuses a workspace it does not know", async () => {
    const { list, calls } = await lister(async () => LIST);

    await expect(list("wks_ffffffffffffffff", false)).rejects.toStrictEqual(
      new CommandError("workspace_not_found", { workspaceId: "wks_ffffffffffffffff" }),
    );
    expect(calls).toStrictEqual([]);
  });

  it("answers models_unavailable with the last 4 KB of what pi said", async () => {
    const said = `${"a".repeat(10)}${"b".repeat(4096)}`;
    const { list } = await lister(async () => {
      throw new PiRequestError("get_available_models", "exited", said);
    });

    await expect(list(WORKSPACE, false)).rejects.toStrictEqual(
      new CommandError("models_unavailable", { detail: "b".repeat(4096) }),
    );
  });

  it("answers models_unavailable with no detail when pi said nothing, as on the deadline", async () => {
    const { list } = await lister(async () => {
      throw new PiRequestError("get_available_models", "aborted");
    });

    await expect(list(WORKSPACE, false)).rejects.toStrictEqual(new CommandError("models_unavailable", { detail: "" }));
  });

  it("passes other failures on, such as pi not being found", async () => {
    const missing = new CommandError("pi_unavailable", { status: "missing" });
    const { list } = await lister(async () => {
      throw missing;
    });

    await expect(list(WORKSPACE, false)).rejects.toBe(missing);
  });
});
