import { editCommand, type LogEntry } from "@atrium/pi";
import { CommandError } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import type { EntriesPage } from "../transcript/session-transcript";
import { editStoppedBranch } from "./stopped-edit";

const original = {
  id: "u1",
  parentId: null,
  kind: "user",
  text: "wrong",
  images: 0,
  skill: null,
  timestamp: 1,
} satisfies LogEntry;
const before: EntriesPage = { entries: [original], leafId: "u1" };
const anchor: LogEntry = { id: "a1", parentId: "u1", kind: "other", timestamp: 2 };
const rewound: EntriesPage = { entries: [original, anchor], leafId: null };
const restored: EntriesPage = {
  entries: [original, anchor, { id: "r1", parentId: "a1", kind: "other", timestamp: 3 }],
  leafId: "r1",
};

/**
 * A pi boundary with deterministic branch reads and a caller-visible submit.
 * @remarks Tests the transaction without mocking any host modules.
 * @sideEffects none until its returned callbacks are called.
 */
function transaction() {
  const pages: EntriesPage[] = [before, rewound];
  const commands: string[] = [];
  const shown: EntriesPage[] = [];
  let stopped = false;
  let submits = 0;
  let disk = before;
  /** Commits a fresh replacement to the simulated disk independently of its RPC response. */
  const commit = (): void => {
    const replacement: LogEntry = { ...original, id: "u2", text: "correct" };
    disk = { entries: [original, anchor, replacement], leafId: "u2" };
    pages.unshift(disk);
  };
  const options = {
    pi: {
      command: async (message: string) => {
        commands.push(message);
      },
      getEntries: async () => {
        const page = pages.shift();
        if (page === undefined) throw new Error("no page");
        disk = { entries: page.entries, leafId: page.entries.at(-1)?.id ?? null };
        return page;
      },
      readPersistedEntries: async () => disk,
      stop: async () => {
        stopped = true;
      },
    },
    entryId: "u1",
    token: "operation-1",
    onBranch: (page: EntriesPage) => {
      shown.push(page);
    },
    send: async (): Promise<"started" | "handled"> => {
      submits++;
      commit();
      return "started";
    },
  };
  return { options, pages, commands, shown, commit, stopped: () => stopped, submits: () => submits };
}

describe("editing a stopped branch", () => {
  it("confirms the rewind before sending and publishes the new branch", async () => {
    const test = transaction();
    expect(await editStoppedBranch(test.options)).toStrictEqual({ disposition: "started" });
    expect(test.shown).toStrictEqual([rewound]);
    expect(test.submits()).toBe(1);
    expect(test.commands).toHaveLength(1);
    expect(test.stopped()).toBe(false);
  });

  it("does not send when an extension handled but did not rewind", async () => {
    const test = transaction();
    test.pages.splice(
      1,
      1,
      { entries: [original, anchor], leafId: "a1" },
      { entries: [original, anchor], leafId: "a1" },
    );
    await expect(editStoppedBranch(test.options)).rejects.toStrictEqual(new CommandError("edit_failed"));
    expect(test.submits()).toBe(0);
    expect(test.stopped()).toBe(false);
  });

  it("restores the original branch when the new text is handled without a user message", async () => {
    const test = transaction();
    test.pages.push(rewound, restored);
    await expect(editStoppedBranch({ ...test.options, send: async () => "handled" })).rejects.toStrictEqual(
      new CommandError("edit_failed"),
    );
    expect(test.shown).toStrictEqual([rewound, restored]);
    expect(test.commands).toHaveLength(2);
    expect(test.stopped()).toBe(false);
  });

  it("does not treat a started preflight as a committed replacement", async () => {
    const test = transaction();
    test.pages.push(rewound, rewound, restored);
    await expect(editStoppedBranch({ ...test.options, send: async () => "started" })).rejects.toStrictEqual(
      new CommandError("edit_failed"),
    );
    expect(test.shown).toStrictEqual([rewound, restored]);
    expect(test.commands).toHaveLength(2);
  });

  it("does not call an appended user on the old branch a successful replacement", async () => {
    const test = transaction();
    const appended: EntriesPage = {
      entries: [original, anchor, { ...original, id: "u2", parentId: "a1", text: "unexpected" }],
      leafId: "u2",
    };
    test.pages.splice(1, 1, appended, appended);
    await expect(editStoppedBranch(test.options)).rejects.toStrictEqual(new CommandError("edit_failed"));
    expect(test.submits()).toBe(0);
    expect(test.stopped()).toBe(false);
  });

  it("restores after a rejected submit and never logs or returns the raw error", async () => {
    const test = transaction();
    test.pages.push(rewound, restored);
    await expect(
      editStoppedBranch({
        ...test.options,
        send: async () => {
          throw new Error("private prompt");
        },
      }),
    ).rejects.toStrictEqual(new CommandError("edit_failed"));
    expect(test.shown).toStrictEqual([rewound, restored]);
    expect(test.stopped()).toBe(false);
  });

  it("does not undo an echoed replacement when the prompt response is lost", async () => {
    const test = transaction();
    const result = await editStoppedBranch({
      ...test.options,
      send: async () => {
        test.commit();
        throw new Error("lost response");
      },
    });
    expect(result).toStrictEqual({ disposition: "started" });
    expect(test.commands).toHaveLength(1);
    expect(test.stopped()).toBe(false);
  });

  it("recognizes a replacement persisted before its echo without submitting twice", async () => {
    const test = transaction();
    expect(
      await editStoppedBranch({
        ...test.options,
        send: async () => {
          test.commit();
          throw new Error("lost echo");
        },
      }),
    ).toStrictEqual({ disposition: "started" });
    expect(test.commands).toHaveLength(1);
    expect(test.stopped()).toBe(false);
  });

  it("stops pi rather than continuing on a branch whose recovery cannot be confirmed", async () => {
    const test = transaction();
    test.pages.push(rewound, rewound);
    await expect(editStoppedBranch({ ...test.options, send: async () => "handled" })).rejects.toStrictEqual(
      new CommandError("edit_failed"),
    );
    expect(test.stopped()).toBe(true);
    expect(test.shown).toStrictEqual([rewound]);
  });

  it("stops pi when its rewind outcome cannot be read", async () => {
    const test = transaction();
    test.pages.splice(1);
    await expect(editStoppedBranch(test.options)).rejects.toStrictEqual(new CommandError("edit_failed"));
    expect(test.stopped()).toBe(true);
    expect(test.submits()).toBe(0);
  });

  it("stops before sending when the anchor was added in memory but never reached the file", async () => {
    const test = transaction();
    await expect(
      editStoppedBranch({ ...test.options, pi: { ...test.options.pi, readPersistedEntries: async () => before } }),
    ).rejects.toStrictEqual(new CommandError("edit_failed"));
    expect(test.stopped()).toBe(true);
    expect(test.submits()).toBe(0);
    expect(test.shown).toStrictEqual([before]);
  });

  it("does not accept an echoed user that exists only in memory after an append failure", async () => {
    const test = transaction();
    const onDisk = { ...rewound, leafId: "a1" };
    await expect(
      editStoppedBranch({ ...test.options, pi: { ...test.options.pi, readPersistedEntries: async () => onDisk } }),
    ).rejects.toStrictEqual(new CommandError("edit_failed"));
    expect(test.stopped()).toBe(true);
    expect(test.submits()).toBe(1);
    expect(test.shown).toStrictEqual([rewound, onDisk]);
  });

  it("keeps a committed revision but stops an unsafe pi when its response was lost", async () => {
    const test = transaction();
    const user: LogEntry = { ...original, id: "u2", text: "correct" };
    const committed: EntriesPage = { entries: [original, anchor, user], leafId: "u2" };
    let disk: EntriesPage = { ...rewound, leafId: "a1" };
    const result = await editStoppedBranch({
      ...test.options,
      pi: { ...test.options.pi, readPersistedEntries: async () => disk },
      send: async () => {
        disk = committed;
        test.pages.unshift({
          entries: [...committed.entries, { ...anchor, id: "ghost-reply", parentId: "u2" }],
          leafId: "ghost-reply",
        });
        throw new Error("lost response after failed append");
      },
    });
    expect(result).toStrictEqual({ disposition: "started" });
    expect(test.stopped()).toBe(true);
    expect(test.commands).toHaveLength(1);
    expect(test.shown).toStrictEqual([rewound, committed]);
  });

  it("stops when a recovery marker was appended only to memory", async () => {
    const test = transaction();
    test.pages.push(rewound, restored);
    const onDisk = { ...rewound, leafId: "a1" };
    await expect(
      editStoppedBranch({
        ...test.options,
        pi: { ...test.options.pi, readPersistedEntries: async () => onDisk },
        send: async () => "handled",
      }),
    ).rejects.toStrictEqual(new CommandError("edit_failed"));
    expect(test.stopped()).toBe(true);
    expect(test.shown).toStrictEqual([rewound]);
  });

  it("rejects a target followed by a newer user message, even if the host had stale history", async () => {
    const test = transaction();
    const newer: LogEntry = { ...original, id: "newer", parentId: "u1", text: "later" };
    test.pages.splice(0, 1, { entries: [original, newer], leafId: "newer" });
    await expect(editStoppedBranch(test.options)).rejects.toStrictEqual(new CommandError("edit_failed"));
    expect(test.commands).toStrictEqual([]);
    expect(test.submits()).toBe(0);
  });

  it("does not stop or navigate when the initial live read fails without changing pi", async () => {
    const test = transaction();
    await expect(
      editStoppedBranch({
        ...test.options,
        pi: {
          ...test.options.pi,
          getEntries: async () => {
            throw new Error("initial read failed");
          },
        },
      }),
    ).rejects.toStrictEqual(new CommandError("edit_failed"));
    expect(test.commands).toStrictEqual([]);
    expect(test.submits()).toBe(0);
    expect(test.shown).toStrictEqual([]);
    expect(test.stopped()).toBe(false);
  });

  it("checks inactive raw entries for failed appends before navigating", async () => {
    const test = transaction();
    const orphan: LogEntry = { ...anchor, id: "orphan", parentId: null };
    test.pages.splice(0, 1, { entries: [original, orphan], leafId: "u1" });
    await expect(
      editStoppedBranch({ ...test.options, pi: { ...test.options.pi, readPersistedEntries: async () => before } }),
    ).rejects.toStrictEqual(new CommandError("edit_failed"));
    expect(test.commands).toStrictEqual([]);
    expect(test.submits()).toBe(0);
    expect(test.shown).toStrictEqual([before]);
    expect(test.stopped()).toBe(true);
  });

  it("rejects an older user when a newer agent delivery is the last input", async () => {
    const test = transaction();
    const delivery: LogEntry = {
      id: "delivery",
      parentId: "u1",
      timestamp: 2,
      kind: "agent",
      details: { v: 1, kind: "task", deliveries: ["d1"], from: "main", fromTitle: "main", taskId: "t1", text: "go" },
    };
    test.pages.splice(0, 1, { entries: [original, delivery], leafId: "delivery" });
    await expect(editStoppedBranch(test.options)).rejects.toStrictEqual(new CommandError("edit_failed"));
    expect(test.commands).toStrictEqual([]);
    expect(test.submits()).toBe(0);
    expect(test.shown).toStrictEqual([]);
    expect(test.stopped()).toBe(false);
  });

  it("rejects an agent delivery as the edit target even when it is the last input", async () => {
    const test = transaction();
    const delivery: LogEntry = {
      id: "delivery",
      parentId: null,
      timestamp: 1,
      kind: "agent",
      details: { v: 1, kind: "task", deliveries: ["d1"], from: "main", fromTitle: "main", taskId: "t1", text: "go" },
    };
    test.pages.splice(0, 1, { entries: [delivery], leafId: "delivery" });
    await expect(editStoppedBranch({ ...test.options, entryId: "delivery" })).rejects.toStrictEqual(
      new CommandError("edit_failed"),
    );
    expect(test.commands).toStrictEqual([]);
    expect(test.submits()).toBe(0);
    expect(test.shown).toStrictEqual([]);
    expect(test.stopped()).toBe(false);
  });

  it("accepts a replacement after a non-root rewind while retaining earlier inputs", async () => {
    const test = transaction();
    const earlier: LogEntry = { ...original, id: "earlier", text: "earlier" };
    const target: LogEntry = { ...original, parentId: "earlier" };
    const previous: EntriesPage = { entries: [earlier, target], leafId: "u1" };
    const moved: EntriesPage = { entries: [earlier, target, anchor], leafId: "earlier" };
    const replacement: LogEntry = { ...original, id: "u2", parentId: "earlier", text: "correct" };
    const committed: EntriesPage = { entries: [...moved.entries, replacement], leafId: "u2" };
    test.pages.splice(0, 2, previous, moved, committed);
    expect(await editStoppedBranch({ ...test.options, send: async () => "started" })).toStrictEqual({
      disposition: "started",
    });
    expect(test.commands).toStrictEqual([
      editCommand({ action: "rewind", token: "operation-1", entryId: "u1", leafId: "u1" }),
    ]);
    expect(test.shown).toStrictEqual([moved]);
    expect(test.stopped()).toBe(false);
  });

  it("rejects a fresh user appended below the original after submission", async () => {
    const test = transaction();
    const appended: EntriesPage = {
      entries: [original, anchor, { ...original, id: "u2", parentId: "a1", text: "unexpected" }],
      leafId: "u2",
    };
    test.pages.push(appended, appended);
    await expect(editStoppedBranch({ ...test.options, send: async () => "started" })).rejects.toStrictEqual(
      new CommandError("edit_failed"),
    );
    expect(test.commands).toStrictEqual([
      editCommand({ action: "rewind", token: "operation-1", entryId: "u1", leafId: "u1" }),
    ]);
    expect(test.shown).toStrictEqual([rewound, appended]);
    expect(test.stopped()).toBe(false);
  });

  it("restores when a new branch contains only a fresh non-user marker", async () => {
    const test = transaction();
    const marker: LogEntry = { ...anchor, id: "marker", parentId: null };
    const moved: EntriesPage = { entries: [original, anchor, marker], leafId: "marker" };
    test.pages.push(moved, moved, restored);
    await expect(editStoppedBranch({ ...test.options, send: async () => "started" })).rejects.toStrictEqual(
      new CommandError("edit_failed"),
    );
    expect(test.commands).toStrictEqual([
      editCommand({ action: "rewind", token: "operation-1", entryId: "u1", leafId: "u1" }),
      editCommand({ action: "restore", token: "operation-1" }),
    ]);
    expect(test.shown).toStrictEqual([rewound, restored]);
    expect(test.stopped()).toBe(false);
  });

  it("does not mistake an earlier known user for a freshly committed replacement", async () => {
    const test = transaction();
    const earlier: LogEntry = { ...original, id: "earlier", text: "earlier" };
    const target: LogEntry = { ...original, parentId: "earlier" };
    const previous: EntriesPage = { entries: [earlier, target], leafId: "u1" };
    const moved: EntriesPage = { entries: [earlier, target, anchor], leafId: "earlier" };
    const marker: LogEntry = { ...anchor, id: "marker", parentId: "earlier" };
    const marked: EntriesPage = { entries: [...moved.entries, marker], leafId: "marker" };
    const recovered: EntriesPage = { entries: [...marked.entries, ...restored.entries.slice(2)], leafId: "r1" };
    test.pages.splice(0, 2, previous, moved, marked, marked, recovered);
    await expect(editStoppedBranch({ ...test.options, send: async () => "started" })).rejects.toStrictEqual(
      new CommandError("edit_failed"),
    );
    expect(test.commands).toStrictEqual([
      editCommand({ action: "rewind", token: "operation-1", entryId: "u1", leafId: "u1" }),
      editCommand({ action: "restore", token: "operation-1" }),
    ]);
    expect(test.shown).toStrictEqual([moved, recovered]);
    expect(test.stopped()).toBe(false);
  });

  it("restores the previous tail rather than merely finding its original user on the current path", async () => {
    const test = transaction();
    const earlier: LogEntry = { ...original, id: "earlier", text: "earlier" };
    const target: LogEntry = { ...original, parentId: "earlier" };
    const tail: LogEntry = { ...anchor, id: "tail" };
    const previous: EntriesPage = { entries: [earlier, target, tail], leafId: "tail" };
    const current: EntriesPage = { ...previous, leafId: "u1" };
    const recovered: EntriesPage = {
      entries: [...previous.entries, { ...anchor, parentId: "tail" }, ...restored.entries.slice(2)],
      leafId: "r1",
    };
    test.pages.splice(0, 2, previous, current, current, recovered);
    await expect(editStoppedBranch(test.options)).rejects.toStrictEqual(new CommandError("edit_failed"));
    expect(test.commands).toStrictEqual([
      editCommand({ action: "rewind", token: "operation-1", entryId: "u1", leafId: "tail" }),
      editCommand({ action: "restore", token: "operation-1" }),
    ]);
    expect(test.submits()).toBe(0);
    expect(test.shown).toStrictEqual([recovered]);
    expect(test.stopped()).toBe(false);
  });

  it("stops when recovery reaches a nonempty branch that still excludes the previous leaf", async () => {
    const test = transaction();
    const earlier: LogEntry = { ...original, id: "earlier", text: "earlier" };
    const target: LogEntry = { ...original, parentId: "earlier" };
    const previous: EntriesPage = { entries: [earlier, target], leafId: "u1" };
    const moved: EntriesPage = { entries: [earlier, target, anchor], leafId: "earlier" };
    const marker: LogEntry = { ...anchor, id: "failed-restore", parentId: "earlier" };
    const failed: EntriesPage = { entries: [...moved.entries, marker], leafId: "failed-restore" };
    test.pages.splice(0, 2, previous, moved, moved, failed);
    await expect(editStoppedBranch({ ...test.options, send: async () => "handled" })).rejects.toStrictEqual(
      new CommandError("edit_failed"),
    );
    expect(test.commands).toStrictEqual([
      editCommand({ action: "rewind", token: "operation-1", entryId: "u1", leafId: "u1" }),
      editCommand({ action: "restore", token: "operation-1" }),
    ]);
    expect(test.shown).toStrictEqual([moved]);
    expect(test.stopped()).toBe(true);
  });

  it("rejects a user message that is not on the active branch before changing anything", async () => {
    const test = transaction();
    test.pages.splice(0, 1, { entries: [original, { ...anchor, parentId: null }], leafId: "a1" });
    await expect(editStoppedBranch(test.options)).rejects.toStrictEqual(new CommandError("edit_failed"));
    expect(test.commands).toStrictEqual([]);
    expect(test.stopped()).toBe(false);
  });
});
