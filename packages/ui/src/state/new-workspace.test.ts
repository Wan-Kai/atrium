import { CommandError } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { type DraftStorage, createDrafts } from "./drafts";
import {
  type LaunchClient,
  type LaunchContext,
  type NewWorkspaceState,
  choose,
  closePage,
  createNewWorkspaceStore,
  baseName,
  baseRef,
  defaultBase,
  describeWorktreeError,
  dismiss,
  holdsBack,
  launch,
  launchOver,
  openPage,
  pageDraftKey,
  pageLaunch,
  pageModel,
  retryLaunch,
  suggestBranch,
} from "./new-workspace";

/**
 * Drafts kept in memory.
 *
 * @sideEffects none
 * @returns The drafts.
 */
function memoryDrafts() {
  const store = new Map<string, string>();
  const storage: DraftStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
  return createDrafts(storage);
}

/** The methods of the client a launch uses. */
type Method = keyof LaunchClient;

/**
 * A client for launches that records each call and answers as the host would.
 *
 * @remarks
 * A method named in `held` waits until `release` lets it answer; one in `failing` rejects with
 * its error.
 *
 * @sideEffects none
 * @param held - The methods to hold back.
 * @param failing - The methods to fail, with their errors.
 * @returns The client, its calls, and how to release a held method.
 */
function fakeClient(held: readonly Method[] = [], failing: Partial<Record<Method, unknown>> = {}) {
  const calls: unknown[][] = [];
  const gates = new Map(held.map((method) => [method, Promise.withResolvers<void>()]));
  /**
   * Records a call, then waits for its gate and fails or answers.
   *
   * @sideEffects Records the call.
   * @param method - The method.
   * @param args - Its arguments.
   * @param result - Its answer.
   * @returns The answer.
   */
  async function answer<T>(method: Method, args: unknown[], result: T): Promise<T> {
    calls.push([method, ...args]);
    await gates.get(method)?.promise;
    if (method in failing) throw failing[method];
    return result;
  }
  const client: LaunchClient = {
    nameBranch: (...args) => answer("nameBranch", args, { branch: "atrium/fix-login" }),
    createWorkspace: (...args) => answer("createWorkspace", args, { workspaceId: "wks_new" }),
    createSession: (...args) => answer("createSession", args, { sessionId: "s1" }),
    listCommands: (...args) => answer("listCommands", args, { commands: [] }),
    setModel: (...args) => answer("setModel", args, {}),
    setThinkingLevel: (...args) => answer("setThinkingLevel", args, {}),
    prompt: (...args) => answer("prompt", args, { disposition: "started" as const }),
  };
  return {
    client,
    calls,
    release: (method: Method) => gates.get(method)?.resolve(),
  };
}

/** The page's clock in these tests: a launch starts at 1000 and each reading is a second later. */
function stepClock(): () => number {
  let now = 0;
  return () => (now += 1000);
}

/**
 * What a launch's steps use: the client, the drafts, a clock a second a reading, and random words.
 *
 * @sideEffects none
 * @param client - The client.
 * @param drafts - The drafts.
 * @param random - Picks a random branch name's words; the first of each by default.
 * @param now - The clock.
 * @returns The context.
 */
function context(
  client: LaunchClient,
  drafts: LaunchContext["drafts"],
  random: () => number = () => 0,
  now: () => number = stepClock(),
): LaunchContext {
  return { client, drafts, now, random };
}

/**
 * Lets the launch go on until it waits for the client again.
 *
 * @sideEffects none
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A store with the page open on project p1, on a new worktree `atrium/brave-badger` from `origin/main`. */
function pageOpen() {
  const store = createNewWorkspaceStore();
  openPage(store, "p1");
  choose(store, { choice: { kind: "new", branch: "atrium/brave-badger", base: "origin/main" } });
  return store;
}

const IMAGE = { attachmentId: "a1", image: { mimeType: "image/webp" as const, data: "d", preview: "data:p" } };

/** A message without images. */
const MESSAGE = { text: "hi", images: [] };

/** The only launch in the store. */
function onlyLaunch(state: NewWorkspaceState) {
  expect(state.launches).toHaveLength(1);
  return state.launches[0];
}

describe("suggestBranch, defaultBase, baseRef, baseName, pageDraftKey", () => {
  it("names a branch atrium/<adjective>-<animal> from two random words", () => {
    expect(suggestBranch(() => 0)).toBe("atrium/brave-badger");
    expect(suggestBranch(() => 0.5)).toBe("atrium/merry-otter");
    expect(suggestBranch(() => 0.9999)).toBe("atrium/swift-wren");
  });

  it("starts from the main branch, else the local workspace's branch, else HEAD, as full refs", () => {
    expect([
      defaultBase({ main: "refs/heads/main", current: "dev" }),
      defaultBase({ main: "refs/remotes/origin/main", current: "dev" }),
      defaultBase({ main: null, current: "dev" }),
      defaultBase({ main: null, current: null }),
    ]).toStrictEqual(["refs/heads/main", "refs/remotes/origin/main", "refs/heads/dev", "HEAD"]);
  });

  it("writes a branch's full ref, and a ref's short name", () => {
    expect([
      baseRef("local", "feat/x"),
      baseRef("remote", "origin/main"),
      baseName("refs/heads/feat/x"),
      baseName("refs/remotes/origin/main"),
      baseName("HEAD"),
      baseName("refs/tags/v1"),
      baseName("refs/tags/refs/heads/x"),
    ]).toStrictEqual([
      "refs/heads/feat/x",
      "refs/remotes/origin/main",
      "feat/x",
      "origin/main",
      "HEAD",
      "refs/tags/v1",
      "refs/tags/refs/heads/x",
    ]);
  });

  it("keeps each project's box apart", () => {
    expect(pageDraftKey("p1")).toBe("new-workspace:p1");
  });
});

describe("pageModel", () => {
  const list = {
    status: "ready" as const,
    models: [
      {
        providerId: "x",
        modelId: "y",
        name: "Y",
        thinkingLevels: ["low" as const, "high" as const],
        supportsImage: true,
        fast: null,
        contextWindow: 1,
        maxOutput: 1,
      },
    ],
    defaultModel: { providerId: "x", modelId: "d" },
    error: null,
  };
  const preferences = { lastModel: null, thinkingByModel: { "x/y": "low" as const } };

  it("shows what a new session would start on, until the page chooses", () => {
    expect(pageModel({ ref: null, level: null }, preferences, list)).toMatchObject({ modelId: "d", level: null });
    expect(pageModel({ ref: null, level: "high" }, preferences, list)).toMatchObject({ modelId: "d", level: "high" });
    const remembered = { ...preferences, lastModel: { providerId: "x", modelId: "y" } };
    expect(pageModel({ ref: null, level: null }, remembered, list)).toMatchObject({ modelId: "y", level: "low" });
  });

  it("shows the model chosen, at the level chosen or else the one remembered for it", () => {
    const chosen = { providerId: "x", modelId: "y" };
    expect(pageModel({ ref: chosen, level: null }, preferences, list)).toStrictEqual({
      providerId: "x",
      modelId: "y",
      name: "Y",
      levels: ["low", "high"],
      level: "low",
      supportsImage: true,
      fast: null,
    });
    expect(pageModel({ ref: chosen, level: "high" }, preferences, list)).toMatchObject({ modelId: "y", level: "high" });
  });

  it("shows nothing without a model to show", () => {
    expect(pageModel({ ref: null, level: "high" }, preferences, { ...list, defaultModel: null })).toBeNull();
  });
});

describe("the page", () => {
  it("opens on a new worktree whose branch the model names, on the usual model, and closes", () => {
    const store = createNewWorkspaceStore();
    expect(store.getState()).toStrictEqual({ page: null, launches: [] });

    openPage(store, "p1");
    expect(store.getState().page).toStrictEqual({
      projectId: "p1",
      choice: { kind: "new", branch: null, base: null },
      model: { ref: null, level: null },
      launchId: null,
    });
    closePage(store);
    expect(store.getState().page).toBeNull();
    const before = store.getState();
    closePage(store);
    expect(store.getState()).toBe(before);
  });

  it("changes what was chosen, and goes back to a new worktree from the default base in another project", () => {
    const store = pageOpen();
    choose(store, { model: { ref: { providerId: "x", modelId: "y" }, level: "high" } });
    expect(store.getState().page?.model).toStrictEqual({ ref: { providerId: "x", modelId: "y" }, level: "high" });

    choose(store, { projectId: "p2" });
    expect(store.getState().page?.choice).toStrictEqual({ kind: "new", branch: "atrium/brave-badger", base: null });
    expect(store.getState().page?.projectId).toBe("p2");

    choose(store, { choice: { kind: "existing", workspaceId: "w2" } });
    choose(store, { projectId: "p2" });
    expect(store.getState().page?.choice).toStrictEqual({ kind: "existing", workspaceId: "w2" });
    choose(store, { projectId: "p1" });
    expect(store.getState().page?.choice).toStrictEqual({ kind: "new", branch: null, base: null });

    choose(store, { choice: { kind: "existing", workspaceId: "w1" } });
    choose(store, { model: { ref: null, level: "low" } });
    expect(store.getState().page?.choice).toStrictEqual({ kind: "existing", workspaceId: "w1" });
  });

  it("changes nothing without a page", () => {
    const store = createNewWorkspaceStore();
    choose(store, { projectId: "p1" });
    expect(store.getState().page).toBeNull();
  });
});

describe("launch", () => {
  it("creates the worktree, the session, waits for pi and sends, step by step, then stays for its turn", async () => {
    const store = pageOpen();
    const drafts = memoryDrafts();
    const { client, calls, release } = fakeClient(["createWorkspace", "createSession", "listCommands", "prompt"]);

    const going = launch(store, context(client, drafts), { text: "fix it", images: [IMAGE] }, () => "l1");
    await settle();
    expect(store.getState()).toStrictEqual({
      page: {
        projectId: "p1",
        choice: { kind: "new", branch: "atrium/brave-badger", base: "origin/main" },
        model: { ref: null, level: null },
        launchId: "l1",
      },
      launches: [
        {
          id: "l1",
          projectId: "p1",
          model: { ref: null, level: null },
          worktree: { branch: "atrium/brave-badger", base: "origin/main" },
          named: null,
          steps: ["worktree", "session", "message"],
          done: 0,
          failure: undefined,
          text: "fix it",
          images: [IMAGE],
          workspaceId: null,
          sessionId: null,
          startedAt: 1000,
          failedAt: null,
          sentAt: null,
        },
      ],
    });
    expect(pageLaunch(store.getState())?.id).toBe("l1");
    // Typed after sending, while held back.
    drafts.update(pageDraftKey("p1"), (draft) => ({ ...draft, text: "next" }));

    release("createWorkspace");
    await settle();
    expect(store.getState().page?.choice).toStrictEqual({ kind: "existing", workspaceId: "wks_new" });
    expect(onlyLaunch(store.getState())).toMatchObject({ done: 1, workspaceId: "wks_new", sessionId: null });

    release("createSession");
    await settle();
    expect(store.getState().page).toBeNull();
    expect(onlyLaunch(store.getState())).toMatchObject({ done: 1, sessionId: "s1" });
    expect(launchOver(store.getState(), "s1")?.id).toBe("l1");
    expect(holdsBack(launchOver(store.getState(), "s1"))).toBe(true);
    expect(drafts.read("s1").text).toBe("next");
    expect(drafts.read(pageDraftKey("p1")).text).toBe("");

    release("listCommands");
    await settle();
    expect(onlyLaunch(store.getState())).toMatchObject({ done: 2, sentAt: null });
    expect(holdsBack(launchOver(store.getState(), "s1"))).toBe(true);

    release("prompt");
    await going;
    expect(onlyLaunch(store.getState())).toMatchObject({ done: 3, failure: undefined, startedAt: 1000, sentAt: 2000 });
    expect(holdsBack(launchOver(store.getState(), "s1"))).toBe(false);
    expect(pageLaunch(store.getState())).toBeUndefined();
    expect(calls).toStrictEqual([
      ["createWorkspace", "p1", "atrium/brave-badger", "origin/main"],
      ["createSession", "wks_new", true],
      ["listCommands", "s1"],
      ["prompt", "s1", "fix it", ["a1"], ["data:p"]],
    ]);
  });

  it("names the branch by the message on the page's model first, showing the name on the page", async () => {
    const store = pageOpen();
    const chosen = { providerId: "x", modelId: "y" };
    choose(store, { choice: { kind: "new", branch: null, base: "origin/main" }, model: { ref: chosen, level: null } });
    const { client, calls, release } = fakeClient(["nameBranch", "createWorkspace", "createSession"]);

    const going = launch(store, context(client, memoryDrafts()), { text: "fix the login", images: [] }, () => "l1");
    await settle();
    expect(onlyLaunch(store.getState())).toMatchObject({
      worktree: { branch: null, base: "origin/main" },
      named: null,
      steps: ["name", "worktree", "session", "message"],
      done: 0,
    });

    release("nameBranch");
    await settle();
    expect(onlyLaunch(store.getState())).toMatchObject({
      worktree: { branch: "atrium/fix-login", base: "origin/main" },
      named: "model",
      done: 1,
    });
    expect(store.getState().page?.choice).toStrictEqual({
      kind: "new",
      branch: "atrium/fix-login",
      base: "origin/main",
    });

    release("createWorkspace");
    await settle();
    expect(onlyLaunch(store.getState())).toMatchObject({ done: 2, workspaceId: "wks_new" });

    release("createSession");
    await going;
    expect(calls.slice(0, 2)).toStrictEqual([
      ["nameBranch", "p1", "fix the login", chosen],
      ["createWorkspace", "p1", "atrium/fix-login", "origin/main"],
    ]);
  });

  it("names the branch randomly when the model could not, and goes on", async () => {
    const store = pageOpen();
    choose(store, { choice: { kind: "new", branch: null, base: "origin/main" } });
    const failed = new CommandError("branch_name_failed", { reason: "taken" });
    const { client, calls, release } = fakeClient(["createWorkspace"], { nameBranch: failed });

    const going = launch(
      store,
      context(client, memoryDrafts(), () => 0.5),
      MESSAGE,
      () => "l1",
    );
    await settle();
    expect(onlyLaunch(store.getState())).toMatchObject({
      worktree: { branch: "atrium/merry-otter" },
      named: "random",
      done: 1,
      failure: undefined,
    });

    release("createWorkspace");
    await going;
    expect(calls.slice(0, 2)).toStrictEqual([
      ["nameBranch", "p1", "hi", null],
      ["createWorkspace", "p1", "atrium/merry-otter", "origin/main"],
    ]);
    expect(onlyLaunch(store.getState())).toMatchObject({ done: 4, failure: undefined });
  });

  it("names a branch randomly, without the step, for a message with no text", async () => {
    const store = pageOpen();
    choose(store, { choice: { kind: "new", branch: null, base: "origin/main" } });
    const { client, calls } = fakeClient(["createWorkspace"]);

    void launch(
      store,
      context(client, memoryDrafts(), () => 0),
      { text: " ", images: [IMAGE] },
      () => "l1",
    );
    await settle();

    expect(onlyLaunch(store.getState())).toMatchObject({
      worktree: { branch: "atrium/brave-badger", base: "origin/main" },
      named: null,
      steps: ["worktree", "session", "message"],
    });
    expect(calls).toStrictEqual([["createWorkspace", "p1", "atrium/brave-badger", "origin/main"]]);
  });

  it("names no more when the worktree failed after naming, and leaves a page the user went to alone", async () => {
    const store = pageOpen();
    choose(store, { choice: { kind: "new", branch: null, base: "origin/main" } });
    const refused = new CommandError("worktree_create_failed");
    const failing = fakeClient([], { createWorkspace: refused });
    await launch(store, context(failing.client, memoryDrafts()), MESSAGE, () => "l1");
    expect(onlyLaunch(store.getState())).toMatchObject({ done: 1, failure: refused, named: "model" });

    const again = fakeClient();
    await launch(store, context(again.client, memoryDrafts()), MESSAGE, () => "l2");
    expect(again.calls[0]).toStrictEqual(["createWorkspace", "p1", "atrium/fix-login", "origin/main"]);

    openPage(store, "p1");
    const held = fakeClient(["nameBranch"]);
    const going = launch(store, context(held.client, memoryDrafts()), MESSAGE, () => "l3");
    await settle();
    closePage(store);
    openPage(store, "p2");
    held.release("nameBranch");
    await going;
    expect(store.getState().page).toMatchObject({ projectId: "p2", choice: { kind: "new", branch: null } });
  });

  it("goes on when the page was closed while naming, with nothing opened in its place", async () => {
    const store = pageOpen();
    choose(store, { choice: { kind: "new", branch: null, base: "origin/main" } });
    const { client, calls, release } = fakeClient(["nameBranch"]);

    const going = launch(store, context(client, memoryDrafts()), MESSAGE, () => "l1");
    await settle();
    closePage(store);
    release("nameBranch");
    await going;

    expect(calls[1]).toStrictEqual(["createWorkspace", "p1", "atrium/fix-login", "origin/main"]);
    expect(store.getState().page).toBeNull();
  });

  it("goes into a workspace already there, setting the model and level chosen instead of listing commands", async () => {
    const store = pageOpen();
    choose(store, {
      choice: { kind: "existing", workspaceId: "w2" },
      model: { ref: { providerId: "x", modelId: "y" }, level: "high" },
    });
    const { client, calls, release } = fakeClient(["prompt"]);

    const going = launch(store, context(client, memoryDrafts()), { text: "hi", images: [] }, () => "l1");
    await settle();
    expect(onlyLaunch(store.getState())).toMatchObject({
      worktree: null,
      steps: ["session", "message"],
      done: 1,
      workspaceId: "w2",
    });
    release("prompt");
    await going;

    expect(calls).toStrictEqual([
      ["createSession", "w2", true],
      ["setModel", "s1", { providerId: "x", modelId: "y" }],
      ["setThinkingLevel", "s1", "high"],
      ["prompt", "s1", "hi", [], []],
    ]);
  });

  it("sets a model chosen alone, which waits for pi as listing commands would", async () => {
    const store = pageOpen();
    choose(store, {
      choice: { kind: "existing", workspaceId: "w2" },
      model: { ref: { providerId: "x", modelId: "y" }, level: null },
    });
    const { client, calls } = fakeClient();

    await launch(store, context(client, memoryDrafts()), MESSAGE, () => "l1");

    expect(calls).toStrictEqual([
      ["createSession", "w2", true],
      ["setModel", "s1", { providerId: "x", modelId: "y" }],
      ["prompt", "s1", "hi", [], []],
    ]);
  });

  it("sets a level chosen alone, and starts from HEAD when the bases never came", async () => {
    const store = pageOpen();
    choose(store, {
      choice: { kind: "new", branch: "a", base: null },
      model: { ref: null, level: "low" },
    });
    const { client, calls } = fakeClient();

    await launch(store, context(client, memoryDrafts()), { text: "hi", images: [] }, () => "l1");

    expect(calls).toStrictEqual([
      ["createWorkspace", "p1", "a", "HEAD"],
      ["createSession", "wks_new", true],
      ["setThinkingLevel", "s1", "low"],
      ["prompt", "s1", "hi", [], []],
    ]);
  });

  it("leaves a user who left the page where they went, and the page they went to alone", async () => {
    const store = pageOpen();
    const { client, calls, release } = fakeClient(["createWorkspace"]);

    const going = launch(store, context(client, memoryDrafts()), { text: "hi", images: [] }, () => "l1");
    await settle();
    closePage(store);
    openPage(store, "p2");
    release("createWorkspace");
    await going;

    expect(calls[1]).toStrictEqual(["createSession", "wks_new", false]);
    expect(store.getState().page).toMatchObject({ projectId: "p2", choice: { kind: "new" }, launchId: null });
  });

  it("goes on when the page was closed and nothing opened in its place, leaving what was typed to the next page", async () => {
    const store = pageOpen();
    const drafts = memoryDrafts();
    const { client, calls, release } = fakeClient(["createWorkspace"]);

    const going = launch(store, context(client, drafts), MESSAGE, () => "l1");
    await settle();
    drafts.update(pageDraftKey("p1"), (draft) => ({ ...draft, text: "next" }));
    closePage(store);
    release("createWorkspace");
    await going;

    expect([drafts.read(pageDraftKey("p1")).text, drafts.read("s1").text]).toStrictEqual(["next", ""]);
    expect(calls.slice(1)).toStrictEqual([
      ["createSession", "wks_new", false],
      ["listCommands", "s1"],
      ["prompt", "s1", "hi", [], []],
    ]);
    expect(store.getState().page).toBeNull();
  });

  it("stops at a failed worktree, puts the message back in the page's box, and lets it send again", async () => {
    const store = pageOpen();
    const drafts = memoryDrafts();
    const refused = new CommandError("worktree_create_failed", { reason: "branch_exists", branch: "a" });
    const { client, calls } = fakeClient([], { createWorkspace: refused });

    await launch(store, context(client, drafts), { text: "fix it", images: [IMAGE] }, () => "l1");

    expect(onlyLaunch(store.getState())).toMatchObject({ done: 0, failure: refused, sessionId: null });
    expect(store.getState().page).toMatchObject({ choice: { kind: "new" }, launchId: "l1" });
    expect(drafts.read(pageDraftKey("p1"))).toMatchObject({ text: "fix it", images: [IMAGE] });
    expect(calls).toHaveLength(1);

    const again = fakeClient();
    await launch(store, context(again.client, drafts), { text: "fix it", images: [] }, () => "l2");
    expect(store.getState().launches.map((one) => [one.id, one.sentAt])).toStrictEqual([["l2", 2000]]);
  });

  it("refuses a message opening with /atrium- before any step, putting it back in the page's box", async () => {
    const store = pageOpen();
    const drafts = memoryDrafts();
    const { client, calls } = fakeClient();

    await launch(store, context(client, drafts), { text: "  /atrium-agent note x", images: [] }, () => "l1");

    expect(onlyLaunch(store.getState())).toMatchObject({
      done: 0,
      failure: new CommandError("command_reserved"),
      sessionId: null,
    });
    expect(drafts.read(pageDraftKey("p1"))).toMatchObject({ text: "  /atrium-agent note x" });
    expect(calls).toStrictEqual([]);
  });

  it("puts a message that did not go into the session's box, unless something was typed there", async () => {
    const store = pageOpen();
    const drafts = memoryDrafts();
    const busy = new CommandError("session_busy");
    const { client } = fakeClient([], { prompt: busy });

    await launch(store, context(client, drafts), { text: "fix it", images: [] }, () => "l1");

    const failed = launchOver(store.getState(), "s1");
    expect(failed).toMatchObject({ done: 2, failure: busy });
    expect(holdsBack(failed)).toBe(false);
    expect(drafts.read("s1").text).toBe("fix it");

    const other = pageOpen();
    const typed = memoryDrafts();
    const second = fakeClient(["prompt"], { prompt: busy });
    const going = launch(other, context(second.client, typed), { text: "fix it", images: [] }, () => "l1");
    await settle();
    typed.update("s1", (draft) => ({ ...draft, text: "meanwhile" }));
    second.release("prompt");
    await going;
    expect(typed.read("s1").text).toBe("meanwhile");
  });

  it("forgets a launch that failed before its session existed once the page opens again, and keeps the rest", async () => {
    const store = pageOpen();
    const busy = new CommandError("session_busy");
    await launch(store, context(fakeClient([], { prompt: busy }).client, memoryDrafts()), MESSAGE, () => "l2");
    const going = fakeClient(["createWorkspace"]);
    openPage(store, "p1");
    choose(store, { choice: { kind: "new", branch: "b", base: "origin/main" } });
    void launch(store, context(going.client, memoryDrafts()), MESSAGE, () => "l3");
    await settle();
    openPage(store, "p1");
    choose(store, { choice: { kind: "new", branch: "c", base: "origin/main" } });
    const refused = new CommandError("worktree_create_failed", { reason: "branch_exists", branch: "c" });
    await launch(
      store,
      context(fakeClient([], { createWorkspace: refused }).client, memoryDrafts()),
      MESSAGE,
      () => "l1",
    );

    openPage(store, "p2");

    expect(store.getState().launches.map((one) => one.id)).toStrictEqual(["l2", "l3"]);
    going.release("createWorkspace");
  });

  it("does nothing without the page, and a dismissed launch stays gone", async () => {
    const store = createNewWorkspaceStore();
    const { client, calls } = fakeClient();
    await launch(store, context(client, memoryDrafts()), { text: "hi", images: [] }, () => "l1");
    expect(calls).toStrictEqual([]);

    const open = pageOpen();
    const held = fakeClient(["prompt"], { prompt: new CommandError("session_busy") });
    const going = launch(open, context(held.client, memoryDrafts()), { text: "hi", images: [] }, () => "l1");
    await settle();
    dismiss(open, "l1");
    held.release("prompt");
    await going;
    expect(open.getState().launches).toStrictEqual([]);
    expect(launchOver(open.getState(), null)).toBeUndefined();
    expect(holdsBack(undefined)).toBe(false);
  });

  it("shows a launch over its own session only, and dismisses only the one asked", async () => {
    const store = pageOpen();
    const busy = new CommandError("session_busy");
    await launch(store, context(fakeClient([], { prompt: busy }).client, memoryDrafts()), MESSAGE, () => "l1");
    openPage(store, "p1");
    const going = fakeClient(["createWorkspace"]);
    void launch(store, context(going.client, memoryDrafts()), MESSAGE, () => "l2");
    await settle();

    expect(launchOver(store.getState(), null)).toBeUndefined();
    expect(launchOver(store.getState(), "s2")).toBeUndefined();
    expect(launchOver(store.getState(), "s1")?.id).toBe("l1");
    dismiss(store, "l1");
    expect(store.getState().launches.map((one) => one.id)).toStrictEqual(["l2"]);
    going.release("createWorkspace");
  });
});

describe("pageLaunch", () => {
  it("is the launch the open page sent last, among others, and none for a page without one or no page", async () => {
    const store = pageOpen();
    await launch(
      store,
      context(fakeClient([], { prompt: new CommandError("session_busy") }).client, memoryDrafts()),
      MESSAGE,
      () => "l1",
    );
    const held = fakeClient(["createWorkspace"]);
    openPage(store, "p1");
    const without = pageLaunch(store.getState());
    choose(store, { choice: { kind: "new", branch: "b", base: "origin/main" } });
    const going = launch(store, context(held.client, memoryDrafts()), MESSAGE, () => "l2");
    const shown = pageLaunch(store.getState())?.id;
    closePage(store);

    expect([without, shown, pageLaunch(store.getState())]).toStrictEqual([undefined, "l2", undefined]);
    held.release("createWorkspace");
    await going;
  });
});

describe("retryLaunch", () => {
  it("goes on from the failed step, taking the message back out of the box, not counting the time it stood failed", async () => {
    const store = pageOpen();
    const drafts = memoryDrafts();
    const clock = stepClock();
    const refused = new CommandError("worktree_create_failed");
    await launch(
      store,
      context(fakeClient([], { createWorkspace: refused }).client, drafts, () => 0, clock),
      { text: "fix it", images: [IMAGE] },
      () => "l1",
    );
    expect(onlyLaunch(store.getState())).toMatchObject({ failure: refused, startedAt: 1000, failedAt: 2000 });
    expect(drafts.read(pageDraftKey("p1"))).toMatchObject({ text: "fix it", images: [IMAGE] });

    const again = fakeClient(["createWorkspace"]);
    const going = retryLaunch(
      store,
      context(again.client, drafts, () => 0, clock),
      "l1",
    );
    expect(onlyLaunch(store.getState())).toMatchObject({ failure: undefined, failedAt: null, startedAt: 2000 });
    expect(holdsBack(pageLaunch(store.getState()))).toBe(true);
    expect(drafts.read(pageDraftKey("p1"))).toStrictEqual({
      text: "",
      pastes: [],
      files: [],
      command: null,
      images: [],
    });
    again.release("createWorkspace");
    await going;

    expect(onlyLaunch(store.getState())).toMatchObject({ done: 3, sessionId: "s1", startedAt: 2000, sentAt: 4000 });
    expect(again.calls).toStrictEqual([
      ["createWorkspace", "p1", "atrium/brave-badger", "origin/main"],
      ["createSession", "wks_new", true],
      ["listCommands", "s1"],
      ["prompt", "s1", "fix it", ["a1"], ["data:p"]],
    ]);
  });

  it("makes no second session once there is one, and leaves a box typed into since alone", async () => {
    const store = pageOpen();
    const drafts = memoryDrafts();
    await launch(
      store,
      context(fakeClient([], { listCommands: new CommandError("session_busy") }).client, drafts),
      MESSAGE,
      () => "l1",
    );
    expect(onlyLaunch(store.getState())).toMatchObject({ done: 1, sessionId: "s1" });
    drafts.update("s1", (draft) => ({ ...draft, text: "other" }));

    const again = fakeClient();
    await retryLaunch(store, context(again.client, drafts), "l1");

    expect(again.calls).toStrictEqual([
      ["listCommands", "s1"],
      ["prompt", "s1", "hi", [], []],
    ]);
    expect(drafts.read("s1").text).toBe("other");
  });

  it("refuses a message opening with /atrium- again", async () => {
    const store = pageOpen();
    const drafts = memoryDrafts();
    await launch(store, context(fakeClient().client, drafts), { text: "/atrium-x", images: [] }, () => "l1");
    const again = fakeClient();

    await retryLaunch(store, context(again.client, drafts), "l1");

    expect(onlyLaunch(store.getState())).toMatchObject({ failure: new CommandError("command_reserved") });
    expect(again.calls).toStrictEqual([]);
  });

  it("leaves a launch not failed, or gone, alone, though another failed", async () => {
    const store = pageOpen();
    const drafts = memoryDrafts();
    const busy = new CommandError("session_busy");
    await launch(store, context(fakeClient([], { prompt: busy }).client, drafts), MESSAGE, () => "l1");
    openPage(store, "p1");
    await launch(store, context(fakeClient().client, drafts), MESSAGE, () => "l2");
    const again = fakeClient();

    await retryLaunch(store, context(again.client, drafts), "l2");
    await retryLaunch(store, context(again.client, drafts), "l3");

    expect(again.calls).toStrictEqual([]);
  });

  it("leaves the box alone when its images were changed since, though its text was not", async () => {
    const store = pageOpen();
    const drafts = memoryDrafts();
    const refused = new CommandError("worktree_create_failed");
    await launch(
      store,
      context(fakeClient([], { createWorkspace: refused }).client, drafts),
      { text: "fix it", images: [IMAGE] },
      () => "l1",
    );
    drafts.update(pageDraftKey("p1"), (draft) => ({ ...draft, images: [] }));

    await retryLaunch(store, context(fakeClient().client, drafts), "l1");

    // Handed to the session once there was one, as what was typed meanwhile is.
    expect(drafts.read("s1")).toMatchObject({ text: "fix it", images: [] });
  });
});

describe("describeWorktreeError", () => {
  it.each([
    [{ reason: "branch_exists", branch: "a" }, "这个分支名已经有了，换一个"],
    [{ reason: "branch_invalid" }, "git 不接受这个分支名"],
    [{ reason: "base_missing", base: "refs/remotes/origin/x" }, "找不到起点 origin/x"],
    [{ reason: "dir_taken", dir: "/code/app.worktrees/a" }, "目录 /code/app.worktrees/a 已经存在，换个分支名"],
    [{ reason: "not_git" }, "这个项目不是 git 仓库"],
    [{ reason: "later" }, "没能建好工作区：git 出错了"],
    [undefined, "没能建好工作区：git 出错了"],
  ])("explains a worktree that could not be created (%o)", (params, words) => {
    expect(describeWorktreeError(new CommandError("worktree_create_failed", params))).toBe(words);
  });

  it("explains a project gone, and leaves other failures to the send's words", () => {
    expect(describeWorktreeError(new CommandError("project_not_found"))).toBe("这个项目已经不在了");
    expect(describeWorktreeError(new CommandError("session_busy"))).toBeNull();
    expect(describeWorktreeError(new Error("lost"))).toBeNull();
    expect(describeWorktreeError(undefined)).toBeNull();
  });
});
