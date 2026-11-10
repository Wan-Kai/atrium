import { CommandError } from "@atrium/client";
import { describe, expect, it } from "vitest";
import { direction, session } from "../test/fake-client";
import { type DraftStorage, createDrafts } from "../state/drafts";
import {
  NEW_DIRECTION_DRAFT,
  closeLearning,
  continueDirection,
  confirmUpgrade,
  createLearningStore,
  directionName,
  openLearning,
  showHome,
  openDirectionSession,
  describeStudyError,
  directionSessions,
  launchDirection,
  listedDirections,
  liveSessions,
  studySessions,
} from "./learning";

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

describe("listedDirections", () => {
  it("lists those not archived: pinned first by when pinned, then by last opened, then newest made", () => {
    const listed = listedDirections([
      direction({ id: "lrn_a", createdAt: 1 }),
      direction({ id: "lrn_b", createdAt: 3 }),
      direction({ id: "lrn_c", lastOpenedAt: 5 }),
      direction({ id: "lrn_d", pinnedAt: 9 }),
      direction({ id: "lrn_e", pinnedAt: 2 }),
      direction({ id: "lrn_f", archived: true, pinnedAt: 1 }),
    ]);

    expect(listed.map(({ id }) => id)).toStrictEqual(["lrn_e", "lrn_d", "lrn_c", "lrn_b", "lrn_a"]);
  });

  it("puts a pinned one first however it was listed, and orders the rest whichever way they came", () => {
    const pinned = direction({ id: "lrn_p", pinnedAt: 4 });
    const opened = [direction({ id: "lrn_o1", lastOpenedAt: 1 }), direction({ id: "lrn_o2", lastOpenedAt: 2 })];
    const made = [direction({ id: "lrn_m1", createdAt: 1 }), direction({ id: "lrn_m2", createdAt: 2 })];
    const order = ["lrn_p", "lrn_o2", "lrn_o1", "lrn_m2", "lrn_m1"];

    expect(listedDirections([...made, ...opened, pinned]).map(({ id }) => id)).toStrictEqual(order);
    expect(listedDirections([pinned, ...opened.toReversed(), ...made.toReversed()]).map(({ id }) => id)).toStrictEqual(
      order,
    );
    expect(
      listedDirections([direction({ id: "lrn_b", createdAt: null }), direction({ id: "lrn_a", createdAt: null })]).map(
        ({ id }) => id,
      ),
    ).toStrictEqual(["lrn_a", "lrn_b"]);
  });
});

describe("continueDirection", () => {
  it("is the direction opened last that is not archived, and none before any was opened", () => {
    expect(continueDirection([direction({ id: "lrn_a" })])).toBeUndefined();
    expect(
      continueDirection([
        direction({ id: "lrn_a", lastOpenedAt: 5 }),
        direction({ id: "lrn_b", lastOpenedAt: 9, archived: true }),
        direction({ id: "lrn_c", lastOpenedAt: 7 }),
      ])?.id,
    ).toBe("lrn_c");
    expect(
      continueDirection([direction({ id: "lrn_x", lastOpenedAt: 7 }), direction({ id: "lrn_y", lastOpenedAt: 9 })])?.id,
    ).toBe("lrn_y");
  });
});

describe("directionSessions", () => {
  it("is the direction's sessions not archived, last active first", () => {
    const sessions = [
      session({ sessionId: "old", containerId: "lrn_a", updatedAt: 3, study: { kind: "discuss" } }),
      session({ sessionId: "gone", containerId: "lrn_a", updatedAt: 9, archived: true }),
      session({ sessionId: "new", containerId: "lrn_a", updatedAt: 5 }),
      session({ sessionId: "other", containerId: "lrn_b", updatedAt: 7 }),
    ];

    expect(directionSessions(sessions, "lrn_a").map(({ sessionId }) => sessionId)).toStrictEqual(["new", "old"]);
    expect(directionSessions(sessions, "lrn_c")).toStrictEqual([]);
  });
});

describe("liveSessions and studySessions", () => {
  it("leave out an archived direction's sessions, and studySessions all but directions' live ones", () => {
    const index = {
      directions: [direction({ id: "lrn_a" }), direction({ id: "lrn_b", archived: true })],
      sessions: [
        session({ sessionId: "w", containerId: "wks_0000000000000001" }),
        session({ sessionId: "a", containerId: "lrn_a" }),
        session({ sessionId: "a2", containerId: "lrn_a", archived: true }),
        session({ sessionId: "b", containerId: "lrn_b" }),
      ],
    };

    expect(liveSessions(index).map(({ sessionId }) => sessionId)).toStrictEqual(["w", "a", "a2"]);
    expect(studySessions(index).map(({ sessionId }) => sessionId)).toStrictEqual(["a"]);
  });
});

/**
 * A client whose commands answer as told, noting each call.
 *
 * @remarks
 * `fail` says which command rejects, and with what.
 *
 * @sideEffects none until called; then notes the calls.
 * @param fail - What creating and sending reject with, if anything.
 * @returns The client and the calls.
 */
function client(
  fail: {
    readonly create?: unknown;
    readonly prompt?: unknown;
    /** The host made the direction but not its discussion. */
    readonly noDiscussion?: boolean;
    readonly createSession?: unknown;
  } = {},
) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      createDirection: async (text: string) => {
        calls.push(`create ${text}`);
        if (fail.create !== undefined) throw fail.create;
        return { directionId: "lrn_go", sessionId: fail.noDiscussion === true ? null : "s1" };
      },
      createSession: async (containerId: string) => {
        calls.push(`createSession ${containerId}`);
        if (fail.createSession !== undefined) throw fail.createSession;
        return { sessionId: "s2" };
      },
      selectContainer: async (containerId: string | null) => {
        calls.push(`selectContainer ${String(containerId)}`);
        return {};
      },
      setModel: async (sessionId: string) => {
        calls.push(`setModel ${sessionId}`);
        return {};
      },
      setThinkingLevel: async (sessionId: string, level: string) => {
        calls.push(`setThinkingLevel ${sessionId} ${level}`);
        return {};
      },
      listCommands: async (sessionId: string) => {
        calls.push(`listCommands ${sessionId}`);
        return { commands: [] };
      },
      prompt: async (
        sessionId: string,
        text: string,
        ids: readonly string[] = [],
        previews: readonly string[] = [],
      ) => {
        calls.push([`prompt ${sessionId} ${text}`, ...ids.map((id) => `+${id}`), ...previews].join(" "));
        if (fail.prompt !== undefined) throw fail.prompt;
        return { disposition: "started" as const };
      },
    },
  };
}

describe("launchDirection, the direction made without its discussion", () => {
  it("sends the message to a new session in it rather than making another direction", async () => {
    const store = createLearningStore();
    store.setState({ page: "new" });
    const { client: fake, calls } = client({ noDiscussion: true });
    const drafts = memoryDrafts();

    await launchDirection(store, fake, drafts, { text: "学 Go", images: [] });

    expect(calls).toStrictEqual(["create 学 Go", "createSession lrn_go", "listCommands s2", "prompt s2 学 Go"]);
    expect(store.getState()).toMatchObject({ page: null, sending: false, failure: undefined, stranded: null });
  });

  it("goes to the direction's home, saying so, when that session cannot be created either", async () => {
    const store = createLearningStore();
    store.setState({ page: "new" });
    const refused = new CommandError("pi_unavailable", { status: "exited" });
    const { client: fake, calls } = client({ noDiscussion: true, createSession: refused });
    const drafts = memoryDrafts();

    await launchDirection(store, fake, drafts, { text: "学 Go", images: [] });

    expect(calls).toStrictEqual(["create 学 Go", "createSession lrn_go", "selectContainer lrn_go"]);
    expect(store.getState()).toMatchObject({
      page: null,
      homes: { lrn_go: true },
      stranded: { directionId: "lrn_go", failure: refused },
    });
    expect(drafts.read(NEW_DIRECTION_DRAFT).text).toBe("学 Go");
  });
});

describe("launchDirection", () => {
  it("sets the page's model and level on the discussion before the message, and leaves the page", async () => {
    const store = createLearningStore();
    store.setState({ page: "new", model: { ref: { providerId: "faux", modelId: "m" }, level: "high" } });
    const { client: fake, calls } = client();

    await launchDirection(store, fake, memoryDrafts(), { text: "学 Go", images: [] });

    expect(calls).toStrictEqual(["create 学 Go", "setModel s1", "setThinkingLevel s1 high", "prompt s1 学 Go"]);
    expect(store.getState()).toMatchObject({
      page: null,
      sending: false,
      failure: undefined,
      homes: { lrn_go: false },
    });
  });

  it("puts the message back in the page's box when the direction was not made, and says why", async () => {
    const store = createLearningStore();
    store.setState({ page: "new" });
    const drafts = memoryDrafts();
    const failure = new CommandError("direction_create_failed");
    const { client: fake } = client({ create: failure });

    await launchDirection(store, fake, drafts, { text: "学 Go", images: [] });

    expect(store.getState()).toMatchObject({ page: "new", sending: false, failure });
    expect(drafts.read(NEW_DIRECTION_DRAFT).text).toBe("学 Go");
    expect(describeStudyError(failure)).toBe("没能建好方向的目录");
  });

  it("puts the message back in the session's box when it failed to go there", async () => {
    const store = createLearningStore();
    const drafts = memoryDrafts();
    const { client: fake } = client({ prompt: new CommandError("session_busy") });

    await launchDirection(store, fake, drafts, { text: "学 Go", images: [] });

    expect(store.getState().failure).toBeUndefined();
    expect(drafts.read("s1").text).toBe("学 Go");
    expect(drafts.read(NEW_DIRECTION_DRAFT).text).toBe("");
  });
});

describe("the study store", () => {
  it("starts with no page, no home, the usual model and nothing sending", () => {
    expect(createLearningStore().getState()).toStrictEqual({
      page: null,
      homes: {},
      model: { ref: null, level: null },
      sending: false,
      failure: undefined,
      stranded: null,
      upgrading: null,
    });
  });

  it("asks to confirm an upgrade, and stops asking", () => {
    const store = createLearningStore();
    confirmUpgrade(store, { directionId: "lrn_go", level: "l2" });
    expect(store.getState().upgrading).toStrictEqual({ directionId: "lrn_go", level: "l2" });
    confirmUpgrade(store, null);
    expect(store.getState().upgrading).toBeNull();
  });

  it("opens the new-direction page afresh, the learning home as it was, and closes either", () => {
    const store = createLearningStore();
    store.setState({ model: { ref: { providerId: "faux", modelId: "m" }, level: "high" }, failure: "old" });

    openLearning(store, "home");
    expect(store.getState()).toMatchObject({ page: "home", failure: "old", model: { level: "high" } });
    openLearning(store, "new");
    expect(store.getState()).toMatchObject({ page: "new", failure: undefined, model: { ref: null, level: null } });
    closeLearning(store);
    expect(store.getState().page).toBeNull();
  });

  it("closes without telling anyone when no page shows", () => {
    const store = createLearningStore();
    let told = 0;
    store.subscribe(() => (told += 1));

    closeLearning(store);
    showHome(store, "lrn_go", false);

    expect(told).toBe(0);
  });

  it("shows and hides each direction's home on its own, telling only of a change", () => {
    const store = createLearningStore();
    let told = 0;
    store.subscribe(() => (told += 1));

    showHome(store, "lrn_go", true);
    showHome(store, "lrn_go", true);
    showHome(store, "lrn_rust", true);
    showHome(store, "lrn_go", false);

    expect(store.getState().homes).toStrictEqual({ lrn_go: false, lrn_rust: true });
    expect(told).toBe(3);
  });
});

describe("directionName", () => {
  it("is the user's name, else the direction's own", () => {
    expect(directionName({ alias: "后端", name: "Node 后端" })).toBe("后端");
    expect(directionName({ alias: null, name: "Node 后端" })).toBe("Node 后端");
  });
});

describe("openDirectionSession", () => {
  it("opens the session over the home, leaving the learning page", async () => {
    const store = createLearningStore();
    store.setState({ page: "home", homes: { lrn_go: true } });
    const opened: string[] = [];

    await openDirectionSession(
      {
        openSession: async (sessionId) => {
          opened.push(sessionId);
          return {};
        },
      },
      store,
      "lrn_go",
      "talk",
    );

    expect(opened).toStrictEqual(["talk"]);
    expect(store.getState()).toMatchObject({ page: null, homes: { lrn_go: false } });
  });
});

describe("launchDirection, more", () => {
  it("sets only the level chosen, then sends the message with its images", async () => {
    const store = createLearningStore();
    store.setState({ model: { ref: null, level: "low" } });
    const { client: fake, calls } = client();
    const image = { attachmentId: "a1", image: { mimeType: "image/webp" as const, data: "x", preview: "data:p" } };

    await launchDirection(store, fake, memoryDrafts(), { text: "学 Go", images: [image] });

    expect(calls).toStrictEqual(["create 学 Go", "setThinkingLevel s1 low", "prompt s1 学 Go +a1 data:p"]);
  });

  it("only refuses a message that opens with /atrium-, giving the images back with new ids", async () => {
    const store = createLearningStore();
    const drafts = memoryDrafts();
    const { client: fake, calls } = client();
    const image = { attachmentId: "a1", image: { mimeType: "image/webp" as const, data: "x", preview: "data:p" } };

    await launchDirection(store, fake, drafts, { text: "  /atrium-fast on", images: [image] });
    expect(calls).toStrictEqual([]);
    expect(store.getState().failure).toMatchObject({ code: "command_reserved" });
    const kept = drafts.read(NEW_DIRECTION_DRAFT);
    expect(kept.text).toBe("  /atrium-fast on");
    expect(kept.images).toMatchObject([{ attachmentId: "a1", image: { preview: "data:p" }, id: expect.any(String) }]);

    await launchDirection(store, fake, memoryDrafts(), { text: "看看 /atrium-", images: [] });
    expect(calls[0]).toBe("create 看看 /atrium-");
  });

  it("shows sending while the direction is made", async () => {
    const store = createLearningStore();
    const gate = Promise.withResolvers<void>();
    const { client: fake } = client();
    const going = launchDirection(
      store,
      {
        ...fake,
        createDirection: async (text: string) => {
          await gate.promise;
          return fake.createDirection(text);
        },
      },
      memoryDrafts(),
      { text: "学 Go", images: [] },
    );

    await expect.poll(() => store.getState().sending).toBe(true);
    gate.resolve();
    await going;
    expect(store.getState().sending).toBe(false);
  });
});

describe("describeStudyError", () => {
  it.each([
    [new CommandError("study_restore_conflict"), "原来的位置已经有同名的目录了，先把它挪走再恢复"],
    [new CommandError("direction_not_found"), "这个方向已经不在了"],
    [new CommandError("study_archive_conflict"), "Archive 里已经有同名的目录了，先把它挪走再归档"],
    [new CommandError("study_move_failed"), "没能移动方向的目录"],
    [new CommandError("learning_dir_unsafe"), "学习目录或它的 Archive 是链接或者不是目录，先改回普通目录"],
    [new CommandError("direction_archived"), "这个方向已归档，恢复以后才能接着学"],
    [new CommandError("direction_create_failed"), "没能建好方向的目录"],
    [new CommandError("command_reserved"), "以 /atrium- 开头的消息留给 Atrium 自己用"],
    [new CommandError("pi_unavailable"), "pi 现在用不了"],
    [new CommandError("session_busy"), "等上课这一轮结束"],
    [new CommandError("session_not_found"), "这个会话已经不在了"],
    [new CommandError("worktree_remove_failed"), "出错了，再试一次"],
    [new Error("boom"), "出错了，再试一次"],
  ])("%s", (error, words) => {
    expect(describeStudyError(error)).toBe(words);
  });
});
