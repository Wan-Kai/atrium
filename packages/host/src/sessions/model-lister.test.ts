import { type ModelList, PiRequestError } from "@atrium/pi";
import { CommandError } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { createModelLister } from "./model-lister";

const WORKSPACE = "wks_000000000000000a";

/**
 * A lister over a catalog that answers with `answer`, recording what it was asked.
 *
 * @remarks
 * The catalog itself is tested in the pi package; here only the mapping around it.
 *
 * @sideEffects none
 * @param answer - What the catalog does.
 * @returns The lister and the catalog's calls.
 */
function lister(answer: () => Promise<ModelList>) {
  const calls: [string, boolean][] = [];
  const list = createModelLister({
    catalog: {
      list: (dir, refresh) => {
        calls.push([dir, refresh]);
        return answer();
      },
    },
    dirOf: (workspaceId) => (workspaceId === WORKSPACE ? "/work/app" : undefined),
    chatsDir: "/home/me",
  });
  return { list, calls };
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
    },
  ],
  defaultModel: { providerId: "anthropic", modelId: "haiku" },
};

describe("createModelLister", () => {
  it("lists a workspace's models in its directory, and those outside any in Atrium's directory", async () => {
    const { list, calls } = lister(async () => LIST);

    expect(await list(WORKSPACE, false)).toStrictEqual(LIST);
    expect(await list(null, true)).toStrictEqual(LIST);
    expect(calls).toStrictEqual([
      ["/work/app", false],
      ["/home/me", true],
    ]);
  });

  it("refuses a workspace it does not know", async () => {
    const { list, calls } = lister(async () => LIST);

    await expect(list("wks_ffffffffffffffff", false)).rejects.toStrictEqual(
      new CommandError("workspace_not_found", { workspaceId: "wks_ffffffffffffffff" }),
    );
    expect(calls).toStrictEqual([]);
  });

  it("answers models_unavailable with the last 4 KB of what pi said", async () => {
    const said = `${"a".repeat(10)}${"b".repeat(4096)}`;
    const { list } = lister(async () => {
      throw new PiRequestError("get_available_models", "exited", said);
    });

    await expect(list(WORKSPACE, false)).rejects.toStrictEqual(
      new CommandError("models_unavailable", { detail: "b".repeat(4096) }),
    );
  });

  it("answers models_unavailable with no detail when pi said nothing, as on the deadline", async () => {
    const { list } = lister(async () => {
      throw new PiRequestError("get_available_models", "aborted");
    });

    await expect(list(WORKSPACE, false)).rejects.toStrictEqual(new CommandError("models_unavailable", { detail: "" }));
  });

  it("passes other failures on, such as pi not being found", async () => {
    const missing = new CommandError("pi_unavailable", { status: "missing" });
    const { list } = lister(async () => {
      throw missing;
    });

    await expect(list(WORKSPACE, false)).rejects.toBe(missing);
  });
});
