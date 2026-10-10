import { CommandError, type DiffMode } from "@atrium/protocol";
import { FakeClock } from "@atrium/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { GitError } from "../platform/git";
import {
  CHANGES_DEBOUNCE_MS,
  type ChangesService,
  DIFF_DEBOUNCE_MS,
  POLL_START_MS,
  RECOVER_START_MS,
  type WatchDirectory,
  createChangesService,
} from "./changes-service";
import type { CheckoutReader, WorkspaceChanges, WorkspaceDiff } from "./checkout";

const W1 = "wks_0000000000000001";
const W2 = "wks_0000000000000002";

const services: ChangesService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});

/** Lets queued promises run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Changes with `added` lines added. */
function changes(added: number): WorkspaceChanges {
  return { stat: { added, removed: 0 }, dirty: true, ahead: 0, branch: "main", base: "origin/main" };
}

/** A diff of one file named after its mode and a version. */
function diff(mode: DiffMode, version: number): WorkspaceDiff {
  return {
    files: [
      {
        path: `${mode}-${version}.ts`,
        oldPath: null,
        status: "added",
        added: 1,
        removed: 0,
        content: "binary",
        hunks: [],
      },
    ],
    tooLarge: false,
    error: null,
  };
}

/**
 * A service over a fake reader and fake watchers, on a fake clock.
 *
 * @remarks
 * The reader answers with `now`, which a test changes; watchers record their callbacks so a test
 * can report a change or an error.
 *
 * @sideEffects none
 * @returns The service and what a test drives and checks.
 */
function harness(options: { readonly reader?: "none" } = {}) {
  const clock = new FakeClock();
  const { logger, records, resources } = recordingTracing();
  const now = { changes: changes(1), version: 1, roots: { top: "/top", gitDirs: ["/git/worktrees/w", "/git"] } };
  const reads: string[] = [];
  const failures: unknown[] = [];
  const rootFailures: unknown[] = [];
  /** Whether the next watchers fail as soon as they start, as `fs.watch` throwing does. */
  const watching = { fails: false };
  const reader: CheckoutReader = {
    async changes(dir, mainBranch) {
      reads.push(`changes ${dir} ${String(mainBranch)}`);
      if (failures.length > 0) throw failures.shift();
      return now.changes;
    },
    async diff(dir, _mainBranch, mode) {
      reads.push(`diff ${dir} ${mode}`);
      return diff(mode, now.version);
    },
    async roots(dir) {
      reads.push(`roots ${dir}`);
      if (rootFailures.length > 0) throw rootFailures.shift();
      return now.roots;
    },
    async ignored(top) {
      reads.push(`ignored ${top}`);
      return ["node_modules/"];
    },
  };
  const watchers: { dir: string; onEvent: (path: string | null) => void; onError: () => void; open: boolean }[] = [];
  const watch: WatchDirectory = (dir, onEvent, onError) => {
    const watcher = { dir, onEvent, onError, open: true };
    watchers.push(watcher);
    if (watching.fails) queueMicrotask(onError);
    return () => {
      watcher.open = false;
    };
  };
  const sent: [string, unknown][] = [];
  const service = createChangesService({
    reader: Promise.resolve(options.reader === "none" ? null : reader),
    resolve: (workspaceId) =>
      workspaceId === W1
        ? { dir: "/top/w1", mainBranch: null }
        : workspaceId === W2
          ? { dir: "/w2", mainBranch: "trunk" }
          : undefined,
    send: (connectionId, event) => sent.push([connectionId, event]),
    clock,
    resources,
    logger,
    watch,
  });
  services.push(service);
  /** The open watcher of a directory. */
  const watcherOf = (dir: string) => {
    const found = watchers.find((watcher) => watcher.dir === dir && watcher.open);
    if (found === undefined) throw new Error(`no open watcher of ${dir}`);
    return found;
  };
  return {
    service,
    clock,
    records,
    resources,
    now,
    reads,
    failures,
    rootFailures,
    watching,
    watchers,
    watcherOf,
    sent,
  };
}

/** The event a connection is sent for W1's changes. */
function updated(added: number, workspaceId = W1) {
  return { type: "changes_updated", workspaceId, ...changes(added) };
}

describe("ChangesService: the capsule's count", () => {
  it("sends a workspace's changes to the connection showing it at once, then a second after files change", async () => {
    const { service, clock, now, sent, reads, watcherOf } = harness();

    service.watchChanges("c1", [W1]);
    await settle();
    expect(sent).toStrictEqual([["c1", updated(1)]]);
    // Once the watchers are up it looks again, for what changed before they were.
    expect(reads).toStrictEqual(["roots /top/w1", "changes /top/w1 null", "ignored /top", "changes /top/w1 null"]);

    now.changes = changes(2);
    watcherOf("/top").onEvent("src/a.ts");
    clock.advance(CHANGES_DEBOUNCE_MS - 1);
    watcherOf("/top").onEvent("src/b.ts");
    clock.advance(CHANGES_DEBOUNCE_MS - 1);
    await settle();
    expect(sent).toHaveLength(1);
    clock.advance(1);
    await settle();

    expect(sent).toStrictEqual([
      ["c1", updated(1)],
      ["c1", updated(2)],
    ]);
    expect(reads.filter((read) => read.startsWith("changes"))).toHaveLength(3);
  });

  it("does not send the same changes twice, but sends a newly showing connection what it has not had", async () => {
    const { service, clock, sent, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    await settle();

    watcherOf("/top").onEvent("a.ts");
    clock.advance(CHANGES_DEBOUNCE_MS);
    await settle();
    service.watchChanges("c2", [W1]);
    await settle();

    expect(sent).toStrictEqual([
      ["c1", updated(1)],
      ["c2", updated(1)],
    ]);
  });

  it("leaves out changes in .git but for HEAD, the index and refs, lock files, and directories git ignores", async () => {
    const { service, clock, sent, now, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    await settle();
    now.changes = changes(5);

    for (const path of [
      ".git/objects/ab/cd",
      ".git/index.lock",
      ".git/refs/heads/main.lock",
      ".git/logs/HEAD",
      "node_modules/x/y.js",
      "node_modules",
    ]) {
      watcherOf("/top").onEvent(path);
    }
    clock.advance(CHANGES_DEBOUNCE_MS);
    await settle();
    expect(sent).toHaveLength(1);

    let added = 5;
    for (const path of [".git/HEAD", ".git/index", ".git/refs/heads/main", ".git/packed-refs", null]) {
      watcherOf("/top").onEvent(path);
      clock.advance(CHANGES_DEBOUNCE_MS);
      await settle();
      added += 1;
      now.changes = changes(added);
    }

    expect(sent.map(([, event]) => event)).toStrictEqual([
      updated(1),
      updated(5),
      updated(6),
      updated(7),
      updated(8),
      updated(9),
    ]);
  });

  it("reads the ignored directories again when a .gitignore changes", async () => {
    const { service, clock, reads, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    await settle();

    watcherOf("/top").onEvent("sub/.gitignore");
    await settle();
    clock.advance(CHANGES_DEBOUNCE_MS);
    await settle();

    expect(reads).toStrictEqual([
      "roots /top/w1",
      "changes /top/w1 null",
      "ignored /top",
      "changes /top/w1 null",
      "ignored /top",
      "changes /top/w1 null",
    ]);
  });

  it("watches a linked worktree's git directories for HEAD, the index and refs, not other worktrees", async () => {
    const { service, clock, sent, now, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    await settle();

    now.changes = changes(2);
    watcherOf("/git").onEvent("worktrees/other/HEAD");
    watcherOf("/git").onEvent("objects/pack/x");
    clock.advance(CHANGES_DEBOUNCE_MS);
    await settle();
    expect(sent).toHaveLength(1);
    watcherOf("/git/worktrees/w").onEvent("HEAD");
    clock.advance(CHANGES_DEBOUNCE_MS);
    await settle();
    now.changes = changes(3);
    watcherOf("/git").onEvent("refs/remotes/origin/main");
    clock.advance(CHANGES_DEBOUNCE_MS);
    await settle();

    expect(sent.map(([, event]) => event)).toStrictEqual([updated(1), updated(2), updated(3)]);
  });

  it("looks again when asked, at one workspace or every one, with the project's main branch", async () => {
    const { service, sent, now, reads } = harness();
    service.watchChanges("c1", [W1, W2]);
    await settle();
    now.changes = changes(4);

    service.refresh(W2);
    await settle();
    service.refresh();
    await settle();

    expect(sent).toStrictEqual([
      ["c1", updated(1)],
      ["c1", updated(1, W2)],
      ["c1", updated(4, W2)],
      ["c1", updated(4)],
    ]);
    expect(reads.filter((read) => read.startsWith("changes"))).toStrictEqual([
      "changes /top/w1 null",
      "changes /w2 trunk",
      "changes /top/w1 null",
      "changes /w2 trunk",
      "changes /w2 trunk",
      "changes /top/w1 null",
      "changes /w2 trunk",
    ]);
  });

  it("refuses an unknown workspace, changing nothing", async () => {
    const { service, sent } = harness();

    expect(() => service.watchChanges("c1", [W1, "wks_ffffffffffffffff"])).toThrow(
      new CommandError("workspace_not_found", { workspaceId: "wks_ffffffffffffffff" }),
    );
    await settle();
    expect(sent).toStrictEqual([]);
  });

  it("stops watching a workspace nobody shows, through another set or a disconnect, leaving nothing behind", async () => {
    const { service, clock, watchers, resources, sent, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    service.watchChanges("c2", [W1]);
    await settle();
    watcherOf("/top").onEvent("a.ts");

    service.watchChanges("c1", []);
    expect(watchers.every((watcher) => watcher.open)).toBe(true);
    service.disconnect("c2");

    expect(watchers.map((watcher) => watcher.open)).toStrictEqual([false, false, false]);
    expect(resources.snapshot()).toStrictEqual({ "changes.watch": 0, timer: 0 });
    expect(clock.pendingTimers()).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it("logs git failing by its command and reason only, and goes on at the next change", async () => {
    const { service, clock, sent, failures, records, watcherOf } = harness();
    failures.push(new GitError("diff", "timeout"), new Error("/secret/path"));
    service.watchChanges("c1", [W1]);
    await settle();
    watcherOf("/top").onEvent("a.ts");
    clock.advance(CHANGES_DEBOUNCE_MS);
    await settle();
    watcherOf("/top").onEvent("a.ts");
    clock.advance(CHANGES_DEBOUNCE_MS);
    await settle();

    expect(records.filter((record) => record["msg"] === "changes not read")).toStrictEqual([
      expect.objectContaining({ workspaceId: W1, command: "diff", reason: "timeout" }),
      expect.objectContaining({ workspaceId: W1, error: "Error" }),
    ]);
    expect(JSON.stringify(records)).not.toContain("/secret/path");
    expect(sent).toStrictEqual([["c1", updated(1)]]);
  });
});

describe("ChangesService: the panel", () => {
  it("sends the diff of the mode shown, again 150 ms after files change, and the other mode's when switched", async () => {
    const { service, clock, sent, now, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    service.watchDiff("c1", { workspaceId: W1, mode: "uncommitted" });
    await settle();

    now.version = 2;
    watcherOf("/top").onEvent("a.ts");
    clock.advance(DIFF_DEBOUNCE_MS);
    await settle();
    service.watchDiff("c1", { workspaceId: W1, mode: "base" });
    await settle();

    expect(sent.filter(([, event]) => (event as { type: string }).type === "diff_updated")).toStrictEqual([
      ["c1", { type: "diff_updated", workspaceId: W1, mode: "uncommitted", ...diff("uncommitted", 1) }],
      ["c1", { type: "diff_updated", workspaceId: W1, mode: "uncommitted", ...diff("uncommitted", 2) }],
      ["c1", { type: "diff_updated", workspaceId: W1, mode: "base", ...diff("base", 2) }],
    ]);
  });

  it("keeps watching for an open panel alone, and stops once it closes", async () => {
    const { service, watchers, sent, reads } = harness();

    service.watchDiff("c1", { workspaceId: W2, mode: "base" });
    await settle();
    expect(watchers.map((watcher) => watcher.open)).toStrictEqual([true, true, true]);
    service.watchDiff("c1", null);

    expect(watchers.map((watcher) => watcher.open)).toStrictEqual([false, false, false]);
    expect(reads).toStrictEqual(["roots /w2", "diff /w2 base", "ignored /top", "diff /w2 base"]);
    expect(sent).toHaveLength(1);
  });

  it("refuses a panel on an unknown workspace", () => {
    const { service } = harness();

    expect(() => service.watchDiff("c1", { workspaceId: "wks_ffffffffffffffff", mode: "base" })).toThrow(
      new CommandError("workspace_not_found", { workspaceId: "wks_ffffffffffffffff" }),
    );
  });
});

describe("ChangesService without git, or when git fails", () => {
  it("tells a panel git could not be read, and the capsule there is nothing, when there is no git", async () => {
    const { service, sent } = harness({ reader: "none" });

    service.watchChanges("c1", [W1]);
    service.watchDiff("c1", { workspaceId: W1, mode: "base" });
    await settle();

    expect(sent).toStrictEqual([
      [
        "c1",
        { type: "changes_updated", workspaceId: W1, stat: null, dirty: false, ahead: 0, branch: null, base: null },
      ],
      ["c1", { type: "diff_updated", workspaceId: W1, mode: "base", files: [], tooLarge: false, error: "failed" }],
    ]);
  });

  it("still sends the panel's diff when the count cannot be read", async () => {
    const { service, sent, failures } = harness();
    failures.push(new GitError("status", "exit"));

    service.watchChanges("c1", [W1]);
    service.watchDiff("c1", { workspaceId: W1, mode: "uncommitted" });
    await settle();

    expect(sent.map(([, event]) => (event as { type: string }).type)).toStrictEqual([
      "diff_updated",
      "changes_updated",
    ]);
  });

  it("forgets what a connection was owed once it goes", async () => {
    const { service, sent, now, watcherOf, clock } = harness();
    service.watchChanges("c1", [W1]);
    service.watchDiff("c2", { workspaceId: W1, mode: "base" });
    service.watchChanges("c2", [W1]);
    service.disconnect("c2");
    await settle();
    now.version = 2;
    watcherOf("/top").onEvent("a.ts");
    clock.advance(CHANGES_DEBOUNCE_MS);
    await settle();

    expect(sent.filter(([connection]) => connection === "c2")).toStrictEqual([]);
  });
});

describe("ChangesService when watching fails", () => {
  it("looks now and then when the watchers cannot be set up at all, and watches once they can", async () => {
    const { service, clock, reads, rootFailures, watchers } = harness();
    rootFailures.push(new GitError("rev-parse", "timeout"));
    service.watchChanges("c1", [W1]);
    await settle();
    const looks = () => reads.filter((read) => read.startsWith("changes")).length;

    clock.advance(POLL_START_MS);
    await settle();
    expect(looks()).toBe(2);
    clock.advance(RECOVER_START_MS - POLL_START_MS);
    await settle();

    expect(watchers.filter((watcher) => watcher.open).map((watcher) => watcher.dir)).toStrictEqual([
      "/top",
      "/git/worktrees/w",
      "/git",
    ]);
  });

  it("keeps looking when watching again fails at once, and watches once it can", async () => {
    const { service, clock, reads, watching, watchers, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    await settle();
    watcherOf("/top").onError();
    watching.fails = true;
    const looks = () => reads.filter((read) => read.startsWith("changes")).length;

    clock.advance(RECOVER_START_MS);
    await settle();
    const before = looks();
    clock.advance(4 * POLL_START_MS);
    await settle();
    expect(looks()).toBeGreaterThan(before);
    watching.fails = false;
    clock.advance(2 * RECOVER_START_MS);
    await settle();

    expect(watchers.filter((watcher) => watcher.open)).toHaveLength(3);
    service.disconnect("c1");
    expect(clock.pendingTimers()).toBe(0);
  });

  it("looks every 5 seconds, doubling while nothing changes, and watches again after 30 seconds", async () => {
    const { service, clock, now, reads, watchers, watcherOf, records } = harness();
    service.watchChanges("c1", [W1]);
    await settle();
    const looks = () => reads.filter((read) => read.startsWith("changes")).length;
    /** Moves the clock on and lets the look run. */
    const pass = async (ms: number) => {
      clock.advance(ms);
      await settle();
    };

    watcherOf("/top").onError();
    watchers[1]?.onError();
    expect(watchers.map((watcher) => watcher.open)).toStrictEqual([false, false, false]);
    await pass(POLL_START_MS - 1);
    expect(looks()).toBe(2);
    await pass(1);
    expect(looks()).toBe(3);
    // Nothing changed, so the next look waits twice as long.
    await pass(2 * POLL_START_MS - 1);
    expect(looks()).toBe(3);
    now.changes = changes(9);
    await pass(1);
    expect(looks()).toBe(4);
    // Something changed, so the next look is 5 seconds on again, and the one after too.
    now.changes = changes(10);
    await pass(POLL_START_MS);
    expect(looks()).toBe(5);
    await pass(POLL_START_MS);
    expect(looks()).toBe(6);
    // 30 seconds after the failure the tree is watched again, and the look due at 35 is called off.
    await pass(RECOVER_START_MS - 5 * POLL_START_MS - 1);
    expect(watchers.filter((watcher) => watcher.open)).toStrictEqual([]);
    await pass(1);
    expect(watchers.filter((watcher) => watcher.open).map((watcher) => watcher.dir)).toStrictEqual([
      "/top",
      "/git/worktrees/w",
      "/git",
    ]);
    // The new watchers looked at once; the next scheduled look and try are gone.
    expect(clock.pendingTimers()).toBe(0);
    expect(looks()).toBe(7);
    await pass(10 * POLL_START_MS);
    expect(looks()).toBe(7);
    expect(records.filter((record) => record["msg"] === "changes watch failed, looking now and then")).toHaveLength(1);
    service.disconnect("c1");
    expect(clock.pendingTimers()).toBe(0);
  });

  it("stops looking and trying once nobody shows the workspace", async () => {
    const { service, clock, resources, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    await settle();
    watcherOf("/top").onError();

    service.disconnect("c1");

    expect(clock.pendingTimers()).toBe(0);
    expect(resources.snapshot()).toStrictEqual({ "changes.watch": 0, timer: 0 });
  });
});
