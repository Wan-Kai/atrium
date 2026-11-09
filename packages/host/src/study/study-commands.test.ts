import type { SessionSummary } from "@atrium/protocol";
import { FakeClock, createTempDir } from "@atrium/testkit";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { ResourceTracker } from "../platform/resources";
import { loadIndexFile } from "../store/index-file";
import { LEARNING_FILE } from "../store/index-schema";
import { createLearningRecords } from "../store/learning-records";
import { createDirectionCreator } from "./direction-creator";
import { createDirections } from "./directions";
import { createProgressFiles } from "./progress-file";
import { setLadder } from "./progress-rules";
import { createStudyCommands } from "./study-commands";

/**
 * Study commands over a real learning directory and `learning.json`, with the session manager a
 * stand-in noting what it was asked.
 *
 * @remarks
 * The session manager's own part is covered by its tests and the host layer's
 * (`study.host.test.ts`); here the order of what the commands ask of it is what matters.
 *
 * @sideEffects Creates a temporary directory, removed when the test ends.
 * @param names - What the namer answers.
 * @param more - How moving, naming and creating the discussion behave, when a test needs it.
 * @returns The commands, the learning directory, what was asked and how many changes were told.
 */
async function study(
  names: { readonly dir: string | null; readonly name: string | null } = { dir: "go", name: "Go" },
  more: {
    /** Moves a directory; `rename` from `node:fs/promises` unless a test steps in. */
    readonly rename?: (from: string, to: string) => Promise<void>;
    /** Holds back naming until the promise settles. */
    readonly naming?: Promise<void>;
    /** Makes creating the discussion fail. */
    readonly sessionFails?: boolean;
    /** The sessions there are, for the next step. */
    readonly summaries?: () => SessionSummary[];
  } = {},
) {
  const temp = await createTempDir("study-commands");
  onTestFinished(temp.cleanup);
  const base = await realpath(temp.path);
  const root = join(base, "Learning");
  const clock = new FakeClock(1_000);
  const { logger, records: logs } = recordingTracing();
  const resources = new ResourceTracker();
  const directions = createDirections({ root, clock, resources, logger });
  onTestFinished(() => directions.close());
  const asked: string[] = [];
  const started: SessionSummary[] = [];
  let changes = 0;
  /** Holds back stopping the sessions while a test wants it. */
  let stopping = Promise.withResolvers<void>();
  stopping.resolve();
  const commands = createStudyCommands({
    directions,
    namer: {
      name: async (text, model) => {
        asked.push(`name ${text} ${model === null ? "null" : model.modelId}`);
        await more.naming;
        return names;
      },
      close: async () => undefined,
    },
    creator: createDirectionCreator({ root, git: Promise.resolve(null), clock, random: () => "abcdef", logger }),
    records: createLearningRecords((await loadIndexFile(join(base, "index"), LEARNING_FILE, 0)).file),
    sessions: {
      createStudySession: async (clientId, directionId, kind) => {
        asked.push(`createStudySession ${clientId} ${directionId} ${JSON.stringify(kind)}`);
        if (more.sessionFails === true) throw new Error("catalog not written");
        return { sessionId: "s1" };
      },
      stopContainer: async (containerId) => {
        asked.push(`stopContainer ${containerId}`);
        await stopping.promise;
        return [];
      },
      releaseContainer: (containerId) => asked.push(`releaseContainer ${containerId}`),
      forgetWorkspaces: async (containerIds) => {
        asked.push(`forget ${containerIds.join(",")}`);
      },
      startStudySession: async (clientId, directionId, kind) => {
        asked.push(`startStudySession ${clientId} ${directionId} ${JSON.stringify(kind)}`);
        // Recorded after a turn of the event loop, as the session manager writes its catalog first,
        // and before answering.
        await new Promise((resolve) => setImmediate(resolve));
        started.push(studySession("s2", kind));
        return { sessionId: "s2" };
      },
      summaries: () => [...(more.summaries?.() ?? []), ...started],
    },
    files: createProgressFiles({ root, random: () => "r", logger }),
    clock,
    changed: () => (changes += 1),
    logger,
    ...(more.rename === undefined ? {} : { rename: more.rename }),
  });
  onTestFinished(() => commands.close());
  return {
    commands,
    directions,
    root,
    base,
    asked,
    logs,
    clock,
    resources,
    changes: () => changes,
    /** Holds back stopping sessions until the returned function is called. */
    holdStop: () => {
      stopping = Promise.withResolvers<void>();
      return stopping.resolve;
    },
  };
}

/** Whether something is at a path. */
async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

describe("StudyCommands", () => {
  it("starts watching the learning directory it made for the first direction", async () => {
    const { commands, resources } = await study();
    expect(resources.snapshot()["study.watch"]).toBeUndefined();

    await commands.createDirection("c1", "学 Go", null);

    await expect.poll(() => resources.snapshot()["study.watch"]).toBe(1);
  });

  it("archives again after a restore, Archive/ there already", async () => {
    const { commands, directions } = await study();
    await commands.createDirection("c1", "学 Go", null);
    await commands.archiveDirection("lrn_go");
    await commands.restoreDirection("lrn_go");

    await commands.archiveDirection("lrn_go");

    expect(directions.find("lrn_go")?.archived).toBe(true);
  });

  it("waits, when closed, for an archive under way", async () => {
    const { commands, directions, holdStop } = await study();
    await commands.createDirection("c1", "学 Go", null);
    const release = holdStop();
    const archiving = commands.archiveDirection("lrn_go");
    let closed = false;
    const closing = commands.close().then(() => (closed = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    release();
    await Promise.all([archiving, closing]);

    expect(directions.find("lrn_go")?.archived).toBe(true);
  });

  it("records no opening of an archived direction, so it does not come back as the one to go on", async () => {
    const { commands } = await study();
    await commands.createDirection("c1", "学 Go", null);
    await commands.archiveDirection("lrn_go");

    commands.entered("lrn_go");
    await commands.close();

    expect(commands.list()[0]?.lastOpenedAt).toBeNull();
  });

  it("logs, without its name, a last opening it could not write", async () => {
    const { commands, base, logs } = await study();
    await commands.createDirection("c1", "学 Go", null);
    // Written once, so the index's directory is there to lock.
    await commands.renameDirection("lrn_go", "Go");
    await chmod(join(base, "index"), 0o500);
    onTestFinished(() => chmod(join(base, "index"), 0o700));

    commands.entered("lrn_go");
    await commands.close();

    const records = logs.filter((record) => record["msg"] === "direction opening not recorded");
    expect(records).toStrictEqual([expect.objectContaining({ level: "warn", directionId: "lrn_go", code: "EACCES" })]);
    expect(JSON.stringify(records)).not.toContain(base);
  });

  it("names, makes and lists a direction, then creates its discussion there", async () => {
    const { commands, directions, root, asked } = await study();

    expect(await commands.createDirection("c1", "学 Go", { providerId: "faux", modelId: "m" })).toStrictEqual({
      directionId: "lrn_go",
      sessionId: "s1",
    });

    expect(asked).toStrictEqual(["name 学 Go m", 'createStudySession c1 lrn_go {"kind":"discuss"}']);
    expect(directions.find("lrn_go")).toMatchObject({ dir: join(root, "go"), archived: false, name: "Go" });
    expect(commands.list()).toStrictEqual([
      {
        id: "lrn_go",
        dir: join(root, "go"),
        name: "Go",
        alias: null,
        broken: false,
        newer: false,
        discussing: true,
        archived: false,
        createdAt: 1_000,
        pinnedAt: null,
        lastOpenedAt: null,
        progress: null,
        next: { primary: null, secondary: null },
      },
    ]);
  });

  it("archives by stopping the sessions, moving the directory and forgetting its tabs, then releasing", async () => {
    const { commands, directions, root, asked } = await study();
    await commands.createDirection("c1", "学 Go", null);
    asked.length = 0;

    await commands.archiveDirection("lrn_go");

    expect(asked).toStrictEqual(["stopContainer lrn_go", "forget lrn_go", "releaseContainer lrn_go"]);
    expect(await exists(join(root, "go"))).toBe(false);
    expect(await readdir(join(root, "Archive", "go"))).toContain(".atrium-study.json");
    expect(directions.find("lrn_go")).toMatchObject({ archived: true, dir: join(root, "Archive", "go") });
    // Archiving again asks nothing.
    asked.length = 0;
    await commands.archiveDirection("lrn_go");
    expect(asked).toStrictEqual([]);
  });

  it("refuses to restore onto an empty directory or a file where it was, moving nothing", async () => {
    const { commands, root, logs } = await study();
    await commands.createDirection("c1", "学 Go", null);
    await commands.archiveDirection("lrn_go");
    await mkdir(join(root, "go"));

    await expect(commands.restoreDirection("lrn_go")).rejects.toMatchObject({
      code: "study_restore_conflict",
      params: { directionId: "lrn_go" },
    });
    expect(await readdir(join(root, "go"))).toStrictEqual([]);
    expect(await exists(join(root, "Archive", "go", ".atrium-study.json"))).toBe(true);
    expect(logs.filter((record) => record["msg"] === "direction not moved: place taken")).toStrictEqual([
      expect.objectContaining({ directionId: "lrn_go", archiving: false }),
    ]);
  });

  it("refuses to archive onto a name taken under Archive/ before stopping anything", async () => {
    const { commands, root, asked, logs } = await study();
    await commands.createDirection("c1", "学 Go", null);
    await mkdir(join(root, "Archive"), { recursive: true });
    await writeFile(join(root, "Archive", "go"), "a file");
    asked.length = 0;

    await expect(commands.archiveDirection("lrn_go")).rejects.toMatchObject({
      code: "study_archive_conflict",
      params: { directionId: "lrn_go" },
    });

    expect(asked).toStrictEqual([]);
    expect(await exists(join(root, "go", ".atrium-study.json"))).toBe(true);
    expect(logs.filter((record) => record["msg"] === "direction not moved: place taken")).toStrictEqual([
      expect.objectContaining({ directionId: "lrn_go", archiving: true }),
    ]);
  });

  it("refuses a place filled while the move is under way, keeping what was put there and the direction", async () => {
    const { commands, root } = await study(undefined, {
      rename: async (from, to) => {
        // Someone writes into the place the host just claimed for the move.
        await writeFile(join(to, "theirs.txt"), "theirs");
        await rename(from, to);
      },
    });
    await commands.createDirection("c1", "学 Go", null);

    await expect(commands.archiveDirection("lrn_go")).rejects.toMatchObject({ code: "study_archive_conflict" });

    expect(await readdir(join(root, "Archive", "go"))).toStrictEqual(["theirs.txt"]);
    expect(await exists(join(root, "go", ".atrium-study.json"))).toBe(true);
  });

  it("logs a move that failed for another reason by its code, without paths, and releases the direction", async () => {
    const { commands, logs, asked } = await study(undefined, {
      rename: async () => {
        throw Object.assign(new Error("EACCES: permission denied, rename '/Users/x/Learning/go'"), { code: "EACCES" });
      },
    });
    await commands.createDirection("c1", "学 Go", null);
    asked.length = 0;

    await expect(commands.archiveDirection("lrn_go")).rejects.toMatchObject({ code: "study_move_failed" });

    expect(asked).toStrictEqual(["stopContainer lrn_go", "releaseContainer lrn_go"]);
    const record = logs.find((one) => one["msg"] === "direction not moved");
    expect(record).toMatchObject({ level: "warn", directionId: "lrn_go", archiving: true, code: "EACCES" });
    expect(JSON.stringify(record)).not.toContain("/Users/x");
  });

  it("refuses to make, archive or restore through a learning directory or Archive/ that is a link", async () => {
    const { commands, root, base, asked } = await study();
    await commands.createDirection("c1", "学 Go", null);
    const elsewhere = join(base, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(root, "Archive"));
    asked.length = 0;

    await expect(commands.archiveDirection("lrn_go")).rejects.toMatchObject({ code: "learning_dir_unsafe" });
    expect(asked).toStrictEqual([]);
    expect(await readdir(elsewhere)).toStrictEqual([]);

    await rm(join(root, "Archive"));
    await commands.archiveDirection("lrn_go");
    await rename(root, join(base, "Learning-real"));
    await symlink(join(base, "Learning-real"), root);
    await expect(commands.restoreDirection("lrn_go")).rejects.toMatchObject({ code: "learning_dir_unsafe" });
    await expect(commands.createDirection("c1", "学 Rust", null)).rejects.toMatchObject({
      code: "learning_dir_unsafe",
    });
    expect((await readdir(join(base, "Learning-real"))).toSorted()).toStrictEqual(["Archive"]);
  });

  it("makes a direction only after an archive's move under way, so no name is in both places", async () => {
    const moving = Promise.withResolvers<void>();
    const { commands, root } = await study(undefined, {
      rename: async (from, to) => {
        await moving.promise;
        await rename(from, to);
      },
    });
    await commands.createDirection("c1", "学 Go", null);
    const archiving = commands.archiveDirection("lrn_go");
    await new Promise((resolve) => setTimeout(resolve, 20));
    let made = false;
    const creating = commands.createDirection("c1", "学 Go", null).then((result) => {
      made = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(made).toBe(false);

    moving.resolve();
    await archiving;

    expect(await creating).toMatchObject({ directionId: "lrn_go-2" });
    expect(await exists(join(root, "go"))).toBe(false);
  });

  it("gives the direction made when its discussion could not be created, so it is not made twice", async () => {
    const { commands, root, logs } = await study(undefined, { sessionFails: true });

    expect(await commands.createDirection("c1", "学 Go", null)).toStrictEqual({
      directionId: "lrn_go",
      sessionId: null,
    });

    expect(await exists(join(root, "go", ".atrium-study.json"))).toBe(true);
    expect(logs.filter((record) => record["msg"] === "direction discussion not created")).toStrictEqual([
      expect.objectContaining({ level: "warn", directionId: "lrn_go" }),
    ]);
  });

  it("waits, when closed, for a direction being named, and then makes nothing", async () => {
    const naming = Promise.withResolvers<void>();
    const { commands, root } = await study(undefined, { naming: naming.promise });
    const creating = commands.createDirection("c1", "学 Go", null);
    // Fire and forget: the test awaits it below.
    const settled = creating.catch((error: unknown) => error);
    await new Promise((resolve) => setImmediate(resolve));
    let closed = false;
    const closing = commands.close().then(() => (closed = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    naming.resolve();
    await closing;

    expect(await settled).toMatchObject({ code: "direction_create_failed" });
    expect(await exists(root)).toBe(false);
  });

  it("restores an archived direction where it was, and does nothing for one not archived", async () => {
    const { commands, directions, root } = await study();
    await commands.createDirection("c1", "学 Go", null);
    await commands.restoreDirection("lrn_go");
    await commands.archiveDirection("lrn_go");

    await commands.restoreDirection("lrn_go");

    expect(directions.find("lrn_go")).toMatchObject({ archived: false, dir: join(root, "go") });
    expect(await exists(join(root, "Archive", "go"))).toBe(false);
  });

  it("names and pins a direction in learning.json, telling of each change, and refuses one not there", async () => {
    const { commands, changes, clock } = await study();
    await commands.createDirection("c1", "学 Go", null);
    clock.advance(5);

    await commands.renameDirection("lrn_go", "Go 语言");
    await commands.pinDirection("lrn_go");

    expect(commands.list()[0]).toMatchObject({ alias: "Go 语言", pinnedAt: 1_005 });
    expect(changes()).toBe(2);
    await commands.unpinDirection("lrn_go");
    await commands.renameDirection("lrn_go", null);
    expect(commands.list()[0]).toMatchObject({ alias: null, pinnedAt: null, name: "Go" });
    for (const refused of [
      commands.renameDirection("lrn_none", "x"),
      commands.pinDirection("lrn_none"),
      commands.unpinDirection("lrn_none"),
      commands.archiveDirection("lrn_none"),
      commands.restoreDirection("lrn_none"),
    ]) {
      await expect(refused).rejects.toMatchObject({ code: "direction_not_found", params: { directionId: "lrn_none" } });
    }
  });

  it("records going into a direction, and nothing for any other container", async () => {
    const { commands, clock, changes } = await study();
    await commands.createDirection("c1", "学 Go", null);
    clock.advance(9);

    commands.entered("wks_0000000000000001");
    commands.entered(null);
    commands.entered("lrn_none");
    commands.entered("lrn_go");
    await commands.close();

    expect(commands.list()[0]?.lastOpenedAt).toBe(1_009);
    expect(changes()).toBe(1);
  });
});

/** A direction's marker once its discussion wrote a ladder: one lesson at the start level. */
const PLANNED = setLadder(
  { version: 1, name: "Go" },
  {
    levels: [
      { name: "语法", topics: "", pass: "" },
      { name: "并发", topics: "", pass: "" },
    ],
    lessons: ["goroutine"],
  },
);

/**
 * A session's summary in the direction, with a use.
 *
 * @remarks
 * Only what the next step reads matters.
 *
 * @sideEffects none
 * @param sessionId - Its id.
 * @param use - Its use.
 * @returns The summary.
 */
function studySession(sessionId: string, use: SessionSummary["study"]): SessionSummary {
  return {
    sessionId,
    containerId: "lrn_go",
    name: null,
    prompt: null,
    file: null,
    state: "draft",
    updatedAt: 1,
    archived: false,
    running: false,
    attention: null,
    asking: null,
    question: null,
    model: null,
    parent: null,
    agent: null,
    heldDeliveries: 0,
    kickoff: null,
    study: use,
  };
}

describe("StudyCommands progress (ML2)", () => {
  it("lists a direction's progress and its next step, going back to a session open for it", async () => {
    let sessions: SessionSummary[] = [];
    const { commands, directions, root } = await study(undefined, { summaries: () => sessions });
    await mkdir(join(root, "go"), { recursive: true });
    await writeFile(join(root, "go", ".atrium-study.json"), JSON.stringify(PLANNED));
    await directions.scan();

    expect(commands.list()[0]).toMatchObject({
      discussing: false,
      progress: {
        ladder: [
          { id: "l1", state: "current" },
          { id: "l2", state: "todo" },
        ],
      },
      next: { primary: { type: "start", kind: "lesson", level: "l1", step: "s1", available: true }, secondary: null },
    });
    sessions = [studySession("s7", { kind: "lesson", level: "l1", step: "s1" })];

    expect(commands.list()[0]?.next).toStrictEqual({ primary: { type: "open", sessionId: "s7" }, secondary: null });
  });

  it("opens only the session the next step offers", async () => {
    const { commands, directions, root, asked } = await study();
    await mkdir(join(root, "go"), { recursive: true });
    await writeFile(join(root, "go", ".atrium-study.json"), JSON.stringify(PLANNED));
    await directions.scan();

    await expect(
      commands.startStudySession("c1", "lrn_go", { kind: "lesson", level: "l1", step: "s1" }),
    ).resolves.toStrictEqual({
      sessionId: "s2",
    });
    for (const wrong of [
      { kind: "lesson", level: "l1", step: "s2" },
      { kind: "sheet", level: "l1", step: "s2" },
      { kind: "lesson", level: "l2", step: "s1" },
      { kind: "lesson", level: "l1", step: "s1", gap: "g1" },
    ] as const) {
      await expect(commands.startStudySession("c1", "lrn_go", wrong)).rejects.toMatchObject({
        code: "study_not_available",
        params: { directionId: "lrn_go" },
      });
    }
    expect(asked.filter((line) => line.startsWith("startStudySession"))).toStrictEqual([
      'startStudySession c1 lrn_go {"kind":"lesson","level":"l1","step":"s1"}',
    ]);
    await expect(
      commands.startStudySession("c1", "lrn_none", { kind: "lesson", level: "l1", step: "s1" }),
    ).rejects.toMatchObject({
      code: "direction_not_found",
    });
  });

  it("marks by hand and takes it back, listing the change, and refuses what the rules do not allow", async () => {
    const { commands, directions, root, changes } = await study();
    await mkdir(join(root, "go"), { recursive: true });
    await writeFile(join(root, "go", ".atrium-study.json"), JSON.stringify(PLANNED));
    await directions.scan();
    const before = changes();

    await commands.markStudyStep("lrn_go", "l1", "s1", "quiz", true);

    expect(commands.list()[0]?.progress?.steps["l1"]?.[0]).toMatchObject({
      lesson: { by: "manual" },
      quiz: { by: "manual" },
    });
    expect(commands.list()[0]?.next.primary).toStrictEqual({ type: "mark", mark: "step", level: "l1", step: "s1" });
    expect(changes()).toBeGreaterThan(before);
    await commands.markStudyStep("lrn_go", "l1", "s1", "lesson", false);

    expect(JSON.parse(await readFile(join(root, "go", ".atrium-study.json"), "utf8"))).toStrictEqual(PLANNED);
    await expect(commands.markStudyStep("lrn_go", "l1", "s1", "quiz", false)).rejects.toMatchObject({
      code: "study_mark_refused",
    });
    await expect(commands.markStudyStep("lrn_go", "l1", "s9", "step", true)).rejects.toMatchObject({
      code: "study_not_found",
    });
    await expect(commands.markStudyGap("lrn_go", "g1", true)).rejects.toMatchObject({ code: "study_not_found" });
  });

  it("refuses marks on an archived direction, and on a broken file without writing it", async () => {
    const { commands, directions, root } = await study();
    await mkdir(join(root, "Archive", "old"), { recursive: true });
    await writeFile(join(root, "Archive", "old", ".atrium-study.json"), JSON.stringify(PLANNED));
    await mkdir(join(root, "bad"), { recursive: true });
    await writeFile(join(root, "bad", ".atrium-study.json"), "{");
    await directions.scan();

    await expect(commands.markStudyStep("lrn_old", "l1", "s1", "step", true)).rejects.toMatchObject({
      code: "direction_archived",
      params: { directionId: "lrn_old" },
    });
    await expect(
      commands.startStudySession("c1", "lrn_old", { kind: "lesson", level: "l1", step: "s1" }),
    ).rejects.toMatchObject({
      code: "direction_archived",
    });
    await expect(commands.markStudyGap("lrn_bad", "g1", true)).rejects.toMatchObject({ code: "study_file_broken" });
    expect(await readFile(join(root, "bad", ".atrium-study.json"), "utf8")).toBe("{");
    expect(commands.list().find((one) => one.id === "lrn_bad")?.next).toStrictEqual({ primary: null, secondary: null });
  });

  it("opens one session for two presses at once", async () => {
    const { commands, directions, root, asked } = await study();
    await mkdir(join(root, "go"), { recursive: true });
    await writeFile(join(root, "go", ".atrium-study.json"), JSON.stringify(PLANNED));
    await directions.scan();
    const lesson = { kind: "lesson", level: "l1", step: "s1" } as const;

    const [first, second] = await Promise.allSettled([
      commands.startStudySession("c1", "lrn_go", lesson),
      commands.startStudySession("c2", "lrn_go", lesson),
    ]);

    expect(first).toStrictEqual({ status: "fulfilled", value: { sessionId: "s2" } });
    expect(second).toMatchObject({ status: "rejected", reason: { code: "study_not_available" } });
    expect(asked.filter((line) => line.startsWith("startStudySession"))).toHaveLength(1);
  });

  it("shows a file of a later version, offering nothing and refusing to start or mark", async () => {
    const { commands, directions, root } = await study();
    await mkdir(join(root, "go"), { recursive: true });
    const newer = { ...PLANNED, version: 2 };
    await writeFile(join(root, "go", ".atrium-study.json"), JSON.stringify(newer));
    await directions.scan();

    expect(commands.list()[0]).toMatchObject({
      broken: false,
      newer: true,
      progress: { ladder: [{ id: "l1" }, { id: "l2" }] },
      next: { primary: null, secondary: null },
    });
    await expect(
      commands.startStudySession("c1", "lrn_go", { kind: "lesson", level: "l1", step: "s1" }),
    ).rejects.toMatchObject({ code: "study_file_version" });
    await expect(commands.markStudyStep("lrn_go", "l1", "s1", "lesson", true)).rejects.toMatchObject({
      code: "study_file_version",
    });
    expect(JSON.parse(await readFile(join(root, "go", ".atrium-study.json"), "utf8"))).toStrictEqual(newer);
  });

  it("archives after the marks asked before it, refusing those asked while it runs", async () => {
    const { commands, directions, root, asked, holdStop } = await study();
    await mkdir(join(root, "go"), { recursive: true });
    await writeFile(join(root, "go", ".atrium-study.json"), JSON.stringify(PLANNED));
    await directions.scan();
    const release = holdStop();

    const before = commands.markStudyStep("lrn_go", "l1", "s1", "lesson", true);
    const archiving = commands.archiveDirection("lrn_go");
    await vi.waitFor(() => expect(asked).toContain("stopContainer lrn_go"));

    await expect(commands.markStudyStep("lrn_go", "l1", "s1", "quiz", true)).rejects.toMatchObject({
      code: "direction_archived",
      params: { directionId: "lrn_go" },
    });
    // A start waits for the archive, then finds the direction archived.
    const start = commands.startStudySession("c1", "lrn_go", { kind: "lesson", level: "l1", step: "s1" });
    release();
    await archiving;
    await before;
    await expect(start).rejects.toMatchObject({ code: "direction_archived" });

    const archived = join(root, "Archive", "go");
    expect((await readdir(archived)).toSorted()).toStrictEqual([".atrium-study.json"]);
    const written = JSON.parse(await readFile(join(archived, ".atrium-study.json"), "utf8")) as typeof PLANNED;
    expect(written.steps?.["l1"]?.[0]).toMatchObject({ id: "s1", lesson: { by: "manual" }, quiz: null });
  });
});
