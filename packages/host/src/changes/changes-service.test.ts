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
import type { CheckoutReader, WatchRoots, WorkspaceChanges, WorkspaceDiff } from "./checkout";

const W1 = "wks_0000000000000001";
const W2 = "wks_0000000000000002";

/** Where each workspace is, and its project's main branch. */
const PLACES = new Map([
  [W1, { dir: "/top/w1", mainBranch: null }],
  [W2, { dir: "/w2", mainBranch: "trunk" }],
]);

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

/** The reads a test can hold, so it can act while one is under way. */
type Held = "changes" | "diff" | "roots" | "ignored";

/**
 * A service over a fake reader and fake watchers, on a fake clock.
 *
 * @remarks
 * The reader answers with `now`, which a test changes; watchers record their callbacks so a test
 * can report a change or an error. `hold` makes one kind of read wait until let go, and `known`
 * says which workspaces `resolve` finds.
 *
 * @sideEffects none
 * @returns The service and what a test drives and checks.
 */
function harness(options: { readonly reader?: "none" } = {}) {
  const clock = new FakeClock();
  const { logger, records, resources } = recordingTracing();
  const now: {
    changes: WorkspaceChanges;
    version: number;
    roots: WatchRoots | null;
    ignored: string[];
  } = {
    changes: changes(1),
    version: 1,
    roots: { top: "/top", gitDirs: ["/git/worktrees/w", "/git"] },
    ignored: ["build/", "node_modules/"],
  };
  const known = new Set([W1, W2]);
  const reads: string[] = [];
  const signals: AbortSignal[] = [];
  const failures: unknown[] = [];
  const diffFailures: unknown[] = [];
  const rootFailures: unknown[] = [];
  const holds = new Map<Held, Promise<void>>();
  /**
   * Makes one kind of read wait.
   *
   * @remarks
   * Reads started meanwhile wait too; failures queued are thrown once let go.
   *
   * @sideEffects Holds the reads.
   * @param kind - Which reads.
   * @returns Lets them go.
   */
  const hold = (kind: Held): (() => void) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    holds.set(kind, promise);
    return () => {
      holds.delete(kind);
      resolve();
    };
  };
  /** Records a read and waits while it is held. */
  const read = async (kind: Held, line: string, signal: AbortSignal) => {
    reads.push(line);
    signals.push(signal);
    const held = holds.get(kind);
    if (held !== undefined) await held;
  };
  /** Whether the next watchers fail as soon as they start, as `fs.watch` throwing does. */
  const watching = { fails: false };
  const reader: CheckoutReader = {
    async changes(dir, mainBranch, signal) {
      await read("changes", `changes ${dir} ${String(mainBranch)}`, signal);
      if (failures.length > 0) throw failures.shift();
      return now.changes;
    },
    async diff(dir, _mainBranch, mode, signal) {
      await read("diff", `diff ${dir} ${mode}`, signal);
      if (diffFailures.length > 0) throw diffFailures.shift();
      return diff(mode, now.version);
    },
    async roots(dir, signal) {
      await read("roots", `roots ${dir}`, signal);
      if (rootFailures.length > 0) throw rootFailures.shift();
      return now.roots;
    },
    async ignored(top, signal) {
      await read("ignored", `ignored ${top}`, signal);
      return now.ignored;
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
    resolve: (workspaceId) => (known.has(workspaceId) ? PLACES.get(workspaceId) : undefined),
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
  /** The directories watched now. */
  const open = () => watchers.filter((watcher) => watcher.open).map((watcher) => watcher.dir);
  /** The warnings logged with this message. */
  const logged = (msg: string) => records.filter((record) => record["msg"] === msg);
  return {
    service,
    clock,
    records,
    resources,
    now,
    known,
    reads,
    signals,
    failures,
    diffFailures,
    rootFailures,
    hold,
    watching,
    watchers,
    watcherOf,
    open,
    logged,
    sent,
  };
}

/** Moves the clock on and lets what it started run. */
async function pass(clock: FakeClock, ms: number): Promise<void> {
  clock.advance(ms);
  await settle();
}

/** How many times the count was read. */
function counts(reads: readonly string[]): number {
  return reads.filter((read) => read.startsWith("changes")).length;
}

/** The diff event a connection is sent. */
function diffUpdated(mode: DiffMode, version: number, workspaceId = W1) {
  return { type: "diff_updated", workspaceId, mode, ...diff(mode, version) };
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
      ".git",
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
    // The system did not say what changed, so it may matter.
    now.changes = changes(4);
    watcherOf("/git").onEvent(null);
    clock.advance(CHANGES_DEBOUNCE_MS);
    await settle();

    expect(sent.map(([, event]) => event)).toStrictEqual([updated(1), updated(2), updated(3), updated(4)]);
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

  it("logs git failing by its command and reason only, not git stopped on purpose, and goes on at the next change", async () => {
    const { service, clock, sent, failures, records, watcherOf } = harness();
    failures.push(
      new GitError("diff", "timeout"),
      new Error("/secret/path"),
      new GitError("diff", "aborted"),
      "/secret/thrown",
    );
    service.watchChanges("c1", [W1]);
    await settle();
    for (let change = 0; change < 3; change++) {
      watcherOf("/top").onEvent("a.ts");
      clock.advance(CHANGES_DEBOUNCE_MS);
      await settle();
    }

    expect(records.filter((record) => record["msg"] === "changes not read")).toStrictEqual([
      expect.objectContaining({ workspaceId: W1, command: "diff", reason: "timeout" }),
      expect.objectContaining({ workspaceId: W1, error: "Error" }),
      expect.objectContaining({ workspaceId: W1, error: "unknown" }),
    ]);
    expect(JSON.stringify(records)).not.toContain("/secret/");
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
    const { service, sent, records, watchers, clock } = harness({ reader: "none" });

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
    expect(records).toStrictEqual([]);
    expect(watchers).toStrictEqual([]);
    expect(clock.pendingTimers()).toBe(0);
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
    const { service, clock, reads, rootFailures, watchers, logged } = harness();
    rootFailures.push(new GitError("rev-parse", "timeout"));
    service.watchChanges("c1", [W1]);
    await settle();
    const looks = () => reads.filter((read) => read.startsWith("changes")).length;
    expect(logged("changes not read")).toStrictEqual([
      expect.objectContaining({ workspaceId: W1, command: "rev-parse", reason: "timeout" }),
    ]);
    expect(logged("changes watch failed, looking now and then")).toStrictEqual([
      expect.objectContaining({ workspaceId: W1 }),
    ]);

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

    watcherOf("/top").onError();
    watchers[1]?.onError();
    expect(watchers.map((watcher) => watcher.open)).toStrictEqual([false, false, false]);
    await pass(clock, POLL_START_MS - 1);
    expect(looks()).toBe(2);
    await pass(clock, 1);
    expect(looks()).toBe(3);
    // Nothing changed, so the next look waits twice as long.
    await pass(clock, 2 * POLL_START_MS - 1);
    expect(looks()).toBe(3);
    now.changes = changes(9);
    await pass(clock, 1);
    expect(looks()).toBe(4);
    // Something changed, so the next look is 5 seconds on again, and the one after too.
    now.changes = changes(10);
    await pass(clock, POLL_START_MS);
    expect(looks()).toBe(5);
    await pass(clock, POLL_START_MS);
    expect(looks()).toBe(6);
    // 30 seconds after the failure the tree is watched again, and the look due at 35 is called off.
    await pass(clock, RECOVER_START_MS - 5 * POLL_START_MS - 1);
    expect(watchers.filter((watcher) => watcher.open)).toStrictEqual([]);
    await pass(clock, 1);
    expect(watchers.filter((watcher) => watcher.open).map((watcher) => watcher.dir)).toStrictEqual([
      "/top",
      "/git/worktrees/w",
      "/git",
    ]);
    // The new watchers looked at once; the next scheduled look and try are gone.
    expect(clock.pendingTimers()).toBe(0);
    expect(looks()).toBe(7);
    await pass(clock, 10 * POLL_START_MS);
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

describe("ChangesService: who is shown what", () => {
  it("sends nothing again when a connection shows the same workspaces, and keeps one still shown as the set grows", async () => {
    const { service, clock, sent, now, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    await settle();

    service.watchChanges("c1", [W1, W1]);
    await settle();
    service.watchChanges("c1", [W1, W2]);
    await settle();
    now.changes = changes(2);
    watcherOf("/top").onEvent("a.ts");
    clock.advance(CHANGES_DEBOUNCE_MS);
    await settle();

    expect(sent).toStrictEqual([
      ["c1", updated(1)],
      ["c1", updated(1, W2)],
      ["c1", updated(2)],
    ]);
  });

  it("sends nothing to a connection that stopped showing a workspace before its first look", async () => {
    const { service, sent } = harness();
    service.watchChanges("c2", [W1]);
    await settle();

    service.watchChanges("c1", [W1]);
    service.watchChanges("c1", []);
    await settle();

    expect(sent).toStrictEqual([["c2", updated(1)]]);
  });

  it("keeps watching for a panel when the last connection showing the count goes", async () => {
    const { service, clock, sent, now, open, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    service.watchDiff("c2", { workspaceId: W1, mode: "base" });
    await settle();

    service.watchChanges("c1", []);
    now.version = 2;
    watcherOf("/top").onEvent("a.ts");
    clock.advance(DIFF_DEBOUNCE_MS);
    await settle();

    expect(open()).toStrictEqual(["/top", "/git/worktrees/w", "/git"]);
    expect(sent).toStrictEqual([
      ["c1", updated(1)],
      ["c2", diffUpdated("base", 1)],
      ["c2", diffUpdated("base", 2)],
    ]);
  });

  it("watches a workspace afresh when it is shown again after nobody showed it, its git stopped meanwhile", async () => {
    const { service, sent, now, open, signals } = harness();
    service.watchChanges("c1", [W1]);
    await settle();

    service.watchChanges("c1", []);
    expect(signals.map((signal) => signal.aborted)).toStrictEqual([true, true, true, true]);
    now.changes = changes(2);
    service.watchChanges("c1", [W1]);
    await settle();

    expect(sent).toStrictEqual([
      ["c1", updated(1)],
      ["c1", updated(2)],
    ]);
    expect(open()).toStrictEqual(["/top", "/git/worktrees/w", "/git"]);
  });

  it("does nothing for a workspace gone before it was watched or looked at", async () => {
    const { service, known, sent, records, open, clock } = harness();

    service.watchChanges("c1", [W1]);
    known.delete(W1);
    await settle();

    expect(sent).toStrictEqual([]);
    expect(records).toStrictEqual([]);
    expect(open()).toStrictEqual([]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("looks again at one workspace, or at none for one it does not watch", async () => {
    const { service, sent, now } = harness();
    service.watchDiff("c1", { workspaceId: W1, mode: "base" });
    await settle();

    now.version = 2;
    service.refresh("wks_ffffffffffffffff");
    service.refresh(W1);
    await settle();

    expect(sent).toStrictEqual([
      ["c1", diffUpdated("base", 1)],
      ["c1", diffUpdated("base", 2)],
    ]);
  });
});

describe("ChangesService: the panel's targets", () => {
  it("sends each panel the diff of its own mode, and a panel newly open what it has not had", async () => {
    const { service, sent } = harness();
    service.watchDiff("c1", { workspaceId: W1, mode: "uncommitted" });
    service.watchDiff("c2", { workspaceId: W1, mode: "base" });
    await settle();

    service.watchDiff("c3", { workspaceId: W1, mode: "base" });
    await settle();

    expect(sent).toStrictEqual([
      ["c1", diffUpdated("uncommitted", 1)],
      ["c2", diffUpdated("base", 1)],
      ["c3", diffUpdated("base", 1)],
    ]);
  });

  it("switches a panel's mode without watching again, and lets the workspace go once the panel moves to another", async () => {
    const { service, reads, watchers } = harness();
    service.watchDiff("c1", { workspaceId: W1, mode: "uncommitted" });
    await settle();

    service.watchDiff("c1", { workspaceId: W1, mode: "base" });
    await settle();
    expect(reads.filter((read) => read.startsWith("roots"))).toStrictEqual(["roots /top/w1"]);
    service.watchDiff("c1", { workspaceId: W2, mode: "base" });
    await settle();

    expect(watchers.map((watcher) => watcher.open)).toStrictEqual([false, false, false, true, true, true]);
  });

  it("stops watching a panel's workspace when its connection goes", async () => {
    const { service, open, resources } = harness();
    service.watchDiff("c1", { workspaceId: W1, mode: "base" });
    await settle();

    service.disconnect("c1");

    expect(open()).toStrictEqual([]);
    expect(resources.snapshot()).toStrictEqual({ "changes.watch": 0 });
  });

  it("forgets a closed panel's workspace, which another connection then shows again", async () => {
    const { service, open, now, sent } = harness();
    service.watchDiff("c1", { workspaceId: W1, mode: "base" });
    await settle();

    service.watchDiff("c1", null);
    service.watchChanges("c2", [W1]);
    await settle();
    service.disconnect("c1");
    expect(open()).toStrictEqual(["/top", "/git/worktrees/w", "/git"]);
    now.changes = changes(2);
    service.refresh();
    await settle();
    service.watchChanges("c2", []);

    expect(sent).toStrictEqual([
      ["c1", diffUpdated("base", 1)],
      ["c2", updated(1)],
      ["c2", updated(2)],
    ]);
    expect(open()).toStrictEqual([]);
  });

  it("works out an open panel's diff alone 150 ms after a change, the count only a second after", async () => {
    const { service, clock, reads, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    service.watchDiff("c1", { workspaceId: W1, mode: "uncommitted" });
    await settle();
    const before = counts(reads);

    watcherOf("/top").onEvent("a.ts");
    clock.advance(DIFF_DEBOUNCE_MS);
    await settle();

    expect(counts(reads)).toBe(before);
    expect(reads.at(-1)).toBe("diff /top/w1 uncommitted");
  });

  it("logs a diff git could not work out, going on with the next mode", async () => {
    const { service, sent, diffFailures, logged } = harness();
    diffFailures.push(new GitError("diff", "exit"));

    service.watchDiff("c1", { workspaceId: W1, mode: "uncommitted" });
    service.watchDiff("c2", { workspaceId: W1, mode: "base" });
    await settle();

    expect(logged("changes not read")).toStrictEqual([
      expect.objectContaining({ workspaceId: W1, command: "diff", reason: "exit" }),
    ]);
    // The look once the watchers were up worked out the first mode again.
    expect(sent).toStrictEqual([
      ["c2", diffUpdated("base", 1)],
      ["c1", diffUpdated("uncommitted", 1)],
    ]);
  });
});

describe("ChangesService: the ignored directories", () => {
  it("follows the directories a .gitignore at the top leaves out once it changes", async () => {
    const { service, clock, sent, now, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    await settle();

    now.ignored = ["dist/"];
    watcherOf("/top").onEvent(".gitignore");
    await settle();
    clock.advance(CHANGES_DEBOUNCE_MS);
    await settle();
    now.changes = changes(2);
    watcherOf("/top").onEvent("dist/a.js");
    clock.advance(CHANGES_DEBOUNCE_MS);
    await settle();
    expect(sent).toStrictEqual([["c1", updated(1)]]);
    watcherOf("/top").onEvent("node_modules/a.js");
    clock.advance(CHANGES_DEBOUNCE_MS);
    await settle();

    expect(sent).toStrictEqual([
      ["c1", updated(1)],
      ["c1", updated(2)],
    ]);
  });

  it("schedules nothing once let go while reading a changed .gitignore", async () => {
    const { service, clock, hold, resources, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    await settle();
    const release = hold("ignored");

    watcherOf("/top").onEvent(".gitignore");
    await settle();
    service.disconnect("c1");
    release();
    await settle();

    expect(clock.pendingTimers()).toBe(0);
    expect(resources.snapshot()).toStrictEqual({ "changes.watch": 0 });
  });

  it("watches nothing outside a repository, and reads nothing to leave out, still sending its changes", async () => {
    const { service, now, reads, open, sent, records } = harness();
    now.roots = null;

    service.watchChanges("c1", [W1]);
    await settle();

    expect(reads).toStrictEqual(["roots /top/w1", "changes /top/w1 null"]);
    expect(open()).toStrictEqual([]);
    expect(records).toStrictEqual([]);
    expect(sent).toStrictEqual([["c1", updated(1)]]);
  });
});

describe("ChangesService: looks", () => {
  it("runs one look at a time a workspace, asks meanwhile joining one more", async () => {
    const { service, reads, hold, now, sent } = harness();
    service.watchChanges("c1", [W1]);
    await settle();
    const release = hold("changes");

    service.refresh(W1);
    await settle();
    now.changes = changes(2);
    service.refresh(W1);
    service.refresh(W1);
    await settle();
    expect(counts(reads)).toBe(3);
    release();
    await settle();

    expect(counts(reads)).toBe(4);
    expect(sent).toStrictEqual([
      ["c1", updated(1)],
      ["c1", updated(2)],
    ]);
  });

  it("logs nothing for reads that fail once the workspace was let go", async () => {
    const { service, hold, failures, diffFailures, logged } = harness();
    service.watchChanges("c1", [W1]);
    service.watchDiff("c1", { workspaceId: W1, mode: "base" });
    await settle();
    const releaseChanges = hold("changes");
    const releaseDiff = hold("diff");

    service.refresh(W1);
    await settle();
    failures.push(new Error("stopped"));
    diffFailures.push(new Error("stopped"));
    service.disconnect("c1");
    releaseChanges();
    releaseDiff();
    await settle();

    expect(logged("changes not read")).toStrictEqual([]);
  });

  it("sets nothing up for a workspace let go while git said what to watch, or failed to", async () => {
    const { service, clock, hold, rootFailures, records, open, resources } = harness();
    const releaseRoots = hold("roots");
    service.watchChanges("c1", [W1]);
    await settle();
    rootFailures.push(new Error("stopped"));
    service.disconnect("c1");
    releaseRoots();
    await settle();
    const releaseIgnored = hold("ignored");
    service.watchChanges("c1", [W1]);
    await settle();
    service.disconnect("c1");
    releaseIgnored();
    await settle();

    expect(records).toStrictEqual([]);
    expect(open()).toStrictEqual([]);
    expect(clock.pendingTimers()).toBe(0);
    expect(resources.snapshot()).toStrictEqual({});
  });
});

describe("ChangesService: closing", () => {
  it("stops every watcher, timer and git run, and closes once the look under way is over", async () => {
    const { service, clock, hold, open, resources, signals, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    service.watchDiff("c2", { workspaceId: W2, mode: "base" });
    await settle();
    watcherOf("/top").onEvent("a.ts");
    const release = hold("changes");
    service.refresh(W1);
    await settle();

    let closed = false;
    const closing = (async () => {
      await service.close();
      closed = true;
    })();
    await settle();
    expect(closed).toBe(false);
    release();
    await closing;

    expect(open()).toStrictEqual([]);
    expect(clock.pendingTimers()).toBe(0);
    expect(resources.snapshot()).toStrictEqual({ "changes.watch": 0, timer: 0 });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("does nothing it is asked once closed", async () => {
    const { service, reads, sent, open } = harness();
    await service.close();

    service.watchChanges("c1", [W1]);
    service.watchDiff("c1", { workspaceId: W1, mode: "base" });
    await settle();

    expect(reads).toStrictEqual([]);
    expect(sent).toStrictEqual([]);
    expect(open()).toStrictEqual([]);
  });
});

describe("ChangesService: watching again", () => {
  it("tries to watch again 30 seconds on, then 60, while git cannot say what to watch, looking all the while", async () => {
    const { service, clock, reads, rootFailures, open, logged } = harness();
    rootFailures.push(new GitError("rev-parse", "timeout"), new GitError("rev-parse", "timeout"));
    service.watchChanges("c1", [W1]);
    await settle();
    const tries = () => reads.filter((read) => read.startsWith("roots")).length;

    await pass(clock, RECOVER_START_MS);
    expect(tries()).toBe(2);
    const looked = counts(reads);
    await pass(clock, 2 * RECOVER_START_MS - 1);
    expect(tries()).toBe(2);
    expect(counts(reads)).toBeGreaterThan(looked);
    await pass(clock, 1);

    expect(tries()).toBe(3);
    expect(open()).toStrictEqual(["/top", "/git/worktrees/w", "/git"]);
    expect(logged("changes watch failed, looking now and then")).toHaveLength(1);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("keeps trying while the workspace is not a repository, and watches once it is again", async () => {
    const { service, clock, now, reads, open, watcherOf } = harness();
    service.watchChanges("c1", [W1]);
    await settle();
    watcherOf("/top").onError();
    const roots = now.roots;
    now.roots = null;

    await pass(clock, RECOVER_START_MS);
    expect(open()).toStrictEqual([]);
    now.roots = roots;
    await pass(clock, 2 * RECOVER_START_MS);

    expect(reads.filter((read) => read.startsWith("roots"))).toHaveLength(3);
    expect(open()).toStrictEqual(["/top", "/git/worktrees/w", "/git"]);
  });

  it("looks at an open panel's diff too while the watcher is broken", async () => {
    const { service, clock, now, sent, watcherOf } = harness();
    service.watchDiff("c1", { workspaceId: W1, mode: "base" });
    await settle();
    watcherOf("/top").onError();

    now.version = 2;
    await pass(clock, POLL_START_MS);

    expect(sent).toStrictEqual([
      ["c1", diffUpdated("base", 1)],
      ["c1", diffUpdated("base", 2)],
    ]);
  });
});
