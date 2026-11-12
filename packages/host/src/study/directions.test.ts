import { FakeClock, createTempDir } from "@atrium/testkit";
import { mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { ResourceTracker } from "../platform/resources";
import {
  type FoundDirection,
  createDirections,
  directionIdOf,
  directionPlaceSafe,
  mattersToDirections,
  resolveRoot,
} from "./directions";

/**
 * A learning directory for one test, and its directions.
 *
 * @remarks
 * Real directories and the real recursive watch, with a fake clock for the gathering delay.
 *
 * @sideEffects Creates a temporary directory, removed when the test ends.
 * @param options - Whether the learning directory exists at first.
 * @returns The directions and their surroundings.
 */
async function learning(options: { readonly exists?: boolean } = {}) {
  const temp = await createTempDir("directions");
  onTestFinished(temp.cleanup);
  const root = join(await realpath(temp.path), "Learning");
  if (options.exists !== false) await mkdir(root);
  const clock = new FakeClock(1_000);
  const resources = new ResourceTracker();
  const { logger, records } = recordingTracing();
  const directions = createDirections({ root, clock, resources, logger });
  onTestFinished(() => directions.close());
  let changes = 0;
  directions.onChange(() => (changes += 1));
  return { directions, root, clock, resources, logs: records, changes: () => changes };
}

/**
 * Makes a direction's directory with a marker.
 *
 * @remarks
 * `marker` is written as given, JSON or not.
 *
 * @sideEffects Creates the directory and the file.
 * @param parent - Where the directory goes.
 * @param name - Its name.
 * @param marker - The marker's content.
 * @returns Its path.
 */
async function direction(parent: string, name: string, marker: unknown = { version: 1, name }): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".atrium-study.json"), typeof marker === "string" ? marker : JSON.stringify(marker));
  return dir;
}

/** A ladder of two levels, the smallest the host reads (SPEC-0008, "ML2 定的细节"). */
const RUST_LADDER = [
  { id: "l1", name: "所有权", topics: "借用", pass: "一个链表", state: "current" },
  { id: "l2", name: "并发", topics: "线程", pass: "一个服务", state: "todo" },
] as const;

describe("Directions", () => {
  it("lists the directories with a marker, archived ones from Archive/, and nothing else", async () => {
    const { directions, root } = await learning();
    await direction(root, "node-backend", {
      version: 1,
      name: "Node 后端",
      createdAt: "2026-11-05T10:12:00Z",
      profile: { goal: "x" },
    });
    await direction(root, "rust", { version: 1, name: "Rust", ladder: RUST_LADDER });
    await direction(join(root, "Archive"), "sql", { version: 1, name: "SQL" });
    // Not directions: no marker, a name no id can have, a link to a directory, a file.
    await mkdir(join(root, "notes"));
    await direction(root, ".hidden");
    await direction(root, "has space");
    const outside = await direction(join(root, "..", "elsewhere"), "linked");
    await symlink(outside, join(root, "linked"));
    await writeFile(join(root, "README.md"), "");

    await directions.scan();

    expect(directions.list()).toStrictEqual<FoundDirection[]>([
      {
        id: "lrn_node-backend",
        dirName: "node-backend",
        dir: join(root, "node-backend"),
        home: join(root, "node-backend"),
        archived: false,
        name: "Node 后端",
        createdAt: Date.parse("2026-11-05T10:12:00Z"),
        broken: false,
        newer: false,
        discussing: true,
        progress: null,
      },
      {
        id: "lrn_rust",
        dirName: "rust",
        dir: join(root, "rust"),
        home: join(root, "rust"),
        archived: false,
        name: "Rust",
        createdAt: null,
        broken: false,
        newer: false,
        discussing: false,
        progress: { profile: {}, ladder: [...RUST_LADDER], steps: {}, gaps: [], finishedAt: null },
      },
      {
        id: "lrn_sql",
        dirName: "sql",
        dir: join(root, "Archive", "sql"),
        home: join(root, "sql"),
        archived: true,
        name: "SQL",
        createdAt: null,
        broken: false,
        newer: false,
        discussing: true,
        progress: null,
      },
    ]);
    expect(directions.find("lrn_sql")?.archived).toBe(true);
    expect(directions.find("lrn_notes")).toBeUndefined();
  });

  it("tells of a change once, nothing for a scan that finds the same, and nobody once let go", async () => {
    const { directions, root, logs, changes } = await learning();
    let mine = 0;
    const stop = directions.onChange(() => (mine += 1));
    await direction(root, "go");

    await directions.scan();
    await directions.scan();
    stop();
    await direction(root, "rust");
    await directions.scan();

    expect([changes(), mine]).toStrictEqual([2, 1]);
    expect(logs.filter((record) => record["level"] === "warn")).toStrictEqual([]);
  });

  it("scans again for what came during a scan asked for meanwhile", async () => {
    const { directions, root } = await learning();
    const first = directions.scan();
    await direction(root, "late");
    const second = directions.scan();

    await Promise.all([first, second]);

    expect(directions.find("lrn_late")?.name).toBe("late");
  });

  it("reads when a marker says it was made, from the epoch on, and none before it", async () => {
    const { directions, root } = await learning();
    await direction(root, "epoch", { version: 1, name: "e", createdAt: "1970-01-01T00:00:00Z" });
    await direction(root, "before", { version: 1, name: "b", createdAt: "1960-01-01T00:00:00Z" });
    await direction(root, "junk", { version: 1, name: "j", createdAt: "soon" });

    await directions.scan();

    expect(directions.list().map(({ id, createdAt }) => [id, createdAt])).toStrictEqual([
      ["lrn_before", null],
      ["lrn_epoch", 0],
      ["lrn_junk", null],
    ]);
  });

  it("reads a marker of exactly 1 MiB and a name of 256 characters, and no longer", async () => {
    const { directions, root } = await learning();
    const head = '{"version":1,"name":"x","pad":"';
    await direction(root, "full", `${head}${"x".repeat(1024 * 1024 - head.length - 2)}"}`);
    await direction(root, "long", { version: 1, name: "名".repeat(256) });
    await direction(root, "longer", { version: 1, name: "名".repeat(257) });

    await directions.scan();

    expect(directions.list().map(({ id, broken }) => [id, broken])).toStrictEqual([
      ["lrn_full", false],
      ["lrn_long", false],
      ["lrn_longer", true],
    ]);
  });

  it("lists a direction whose marker cannot be read as broken and under discussion", async () => {
    const { directions, root } = await learning();
    await direction(root, "not-json", "{");
    await direction(root, "no-name", { version: 1 });
    await direction(root, "too-big", `{"version":1,"name":"x","pad":"${"x".repeat(1024 * 1024)}"}`);
    await mkdir(join(root, "marker-dir", ".atrium-study.json"), { recursive: true });
    // A ladder outside 2–6 levels is no ladder Atrium wrote (SPEC-0008, "ML2 定的细节").
    await direction(root, "one-level", { version: 1, name: "x", ladder: RUST_LADDER.slice(0, 1) });
    const seven = Array.from({ length: 7 }, (_, at) => ({ ...RUST_LADDER[1], id: `l${String(at + 1)}` }));
    await direction(root, "seven-levels", { version: 1, name: "x", ladder: seven });
    await direction(root, "six-levels", { version: 1, name: "six", ladder: seven.slice(0, 6) });
    // A later version is read as far as Atrium knows it, never written (ML2).
    await direction(root, "later", { version: 2, name: "later", ladder: seven.slice(0, 2), more: 1 });

    await directions.scan();

    expect(
      directions.list().map(({ id, name, broken, newer, discussing }) => ({ id, name, broken, newer, discussing })),
    ).toStrictEqual([
      { id: "lrn_later", name: "later", broken: false, newer: true, discussing: false },
      { id: "lrn_no-name", name: null, broken: true, newer: false, discussing: true },
      { id: "lrn_not-json", name: null, broken: true, newer: false, discussing: true },
      { id: "lrn_one-level", name: null, broken: true, newer: false, discussing: true },
      { id: "lrn_seven-levels", name: null, broken: true, newer: false, discussing: true },
      { id: "lrn_six-levels", name: "six", broken: false, newer: false, discussing: false },
      { id: "lrn_too-big", name: null, broken: true, newer: false, discussing: true },
    ]);
  });

  it("lists the direction not archived when the same name is in both places, and logs the other", async () => {
    const { directions, root, logs } = await learning();
    await direction(root, "go", { version: 1, name: "Go" });
    await direction(join(root, "Archive"), "go", { version: 1, name: "旧 Go" });

    await directions.scan();

    expect(directions.list().map(({ id, name, archived }) => ({ id, name, archived }))).toStrictEqual([
      { id: "lrn_go", name: "Go", archived: false },
    ]);
    expect(logs.filter((record) => record["msg"] === "archived direction shadowed")).toMatchObject([
      { level: "warn", directionId: "lrn_go" },
    ]);
  });

  it("lists nothing, and watches nothing, while the learning directory is not there", async () => {
    const { directions, resources } = await learning({ exists: false });

    await directions.scan();

    expect(directions.list()).toStrictEqual([]);
    expect(resources.snapshot()["study.watch"]).toBeUndefined();
  });

  it("tells of a direction added by the host before a scan finds it, once", async () => {
    const { directions, root, changes } = await learning();
    const made: FoundDirection = {
      id: "lrn_new",
      dirName: "new",
      dir: join(root, "new"),
      home: join(root, "new"),
      archived: false,
      name: "新",
      createdAt: 5,
      broken: false,
      newer: false,
      discussing: true,
      progress: null,
    };

    directions.added(made);
    directions.added(made);
    directions.added({ ...made, id: "lrn_other", dirName: "other" });

    expect(directions.list().map(({ id }) => id)).toStrictEqual(["lrn_new", "lrn_other"]);
    expect(changes()).toBe(2);
  });

  it("scans again a moment after a direction comes, is archived or goes, and stops watching when closed", async () => {
    const { directions, root, clock, resources, changes } = await learning();
    await directions.scan();
    expect(resources.snapshot()["study.watch"]).toBe(1);

    // FSEvents may drop what happens while its stream is still starting: write until the watch sees it.
    await vi.waitFor(
      async () => {
        await direction(root, "kotlin", { version: 1, name: "Kotlin" });
        expect(resources.snapshot()["timer"]).toBe(1);
      },
      { timeout: 10_000, interval: 100 },
    );
    clock.advance(200);
    await vi.waitFor(() => expect(directions.list().map(({ id }) => id)).toStrictEqual(["lrn_kotlin"]));
    expect(changes()).toBe(1);

    await mkdir(join(root, "Archive"));
    await rename(join(root, "kotlin"), join(root, "Archive", "kotlin"));
    await vi.waitFor(() => expect(resources.snapshot()["timer"]).toBe(1));
    clock.advance(200);
    await vi.waitFor(() => expect(directions.find("lrn_kotlin")?.archived).toBe(true));

    await rm(join(root, "Archive", "kotlin"), { recursive: true });
    await vi.waitFor(() => expect(resources.snapshot()["timer"]).toBe(1));
    clock.advance(200);
    await vi.waitFor(() => expect(directions.list()).toStrictEqual([]));

    await directions.close();
    expect(resources.snapshot()["study.watch"]).toBe(0);
    expect(resources.snapshot()["timer"]).toBe(0);
  });

  it("starts one watch however often it scans, and none once closed, letting Node's go", async () => {
    const before = process.getActiveResourcesInfo().filter((kind) => kind === "FSEventWrap").length;
    const { directions, resources } = await learning();

    await directions.scan();
    await directions.scan();
    expect(resources.snapshot()["study.watch"]).toBe(1);
    await directions.close();
    await directions.scan();

    expect(resources.snapshot()["study.watch"]).toBe(0);
    await vi.waitFor(() =>
      expect(process.getActiveResourcesInfo().filter((kind) => kind === "FSEventWrap")).toHaveLength(before),
    );
  });

  it("lists nothing from a learning directory that is a link, and watches nothing there", async () => {
    const { directions, root, resources } = await learning({ exists: false });
    const elsewhere = join(root, "..", "elsewhere");
    await direction(elsewhere, "rust");
    await symlink(elsewhere, root);

    await directions.scan();

    expect(directions.list()).toStrictEqual([]);
    expect(resources.snapshot()["study.watch"]).toBeUndefined();
  });

  it("lists no archived direction from an Archive/ that is a link, and passes over a marker that is a link", async () => {
    const { directions, root } = await learning();
    const elsewhere = join(root, "..", "elsewhere");
    await direction(elsewhere, "sql");
    await symlink(elsewhere, join(root, "Archive"));
    await direction(root, "go");
    await mkdir(join(root, "linked"));
    await symlink(join(elsewhere, "sql", ".atrium-study.json"), join(root, "linked", ".atrium-study.json"));

    await directions.scan();

    expect(directions.list().map(({ id }) => id)).toStrictEqual(["lrn_go"]);
  });

  it("keeps a direction the host added while a scan that began before it runs, until a later scan", async () => {
    const { directions, root } = await learning();
    const made: FoundDirection = {
      id: "lrn_new",
      dirName: "new",
      dir: join(root, "new"),
      home: join(root, "new"),
      archived: false,
      name: "新",
      createdAt: 5,
      broken: false,
      newer: false,
      discussing: true,
      progress: null,
    };

    const early = directions.scan();
    directions.added(made);
    await early;

    expect(directions.list().map(({ id }) => id)).toStrictEqual(["lrn_new"]);
    // A scan begun after it judges by the disk, where it is not.
    await directions.scan();
    expect(directions.list()).toStrictEqual([]);
  });

  it("scans once its watch starts, so what came before the watch is listed", async () => {
    const { directions, root, resources } = await learning({ exists: false });
    await directions.scan();
    await direction(root, "rust");

    directions.watch();

    await vi.waitFor(() => expect(directions.list().map(({ id }) => id)).toStrictEqual(["lrn_rust"]));
    expect(resources.snapshot()["study.watch"]).toBe(1);
  });

  it("starts watching once the learning directory is made and scanned", async () => {
    const { directions, root, resources } = await learning({ exists: false });
    await directions.scan();
    await mkdir(root);

    directions.watch();
    directions.watch();

    await vi.waitFor(() => expect(resources.snapshot()["study.watch"]).toBe(1));
  });
});

describe("resolveRoot", () => {
  it("resolves links on the way to the learning directory, keeping the part not made yet", async () => {
    const temp = await createTempDir("resolve-root");
    onTestFinished(temp.cleanup);
    const real = await realpath(temp.path);
    await mkdir(join(real, "home"));
    await symlink(join(real, "home"), join(real, "linked"));

    expect(await resolveRoot(join(real, "linked", "Atrium", "Learning"))).toBe(
      join(real, "home", "Atrium", "Learning"),
    );
    await mkdir(join(real, "home", "Atrium", "Learning"), { recursive: true });
    expect(await resolveRoot(join(real, "linked", "Atrium", "Learning"))).toBe(
      join(real, "home", "Atrium", "Learning"),
    );
  });

  it("keeps the learning directory's own name when it is a link, so the link can be refused", async () => {
    const temp = await createTempDir("resolve-root");
    onTestFinished(temp.cleanup);
    const real = await realpath(temp.path);
    await mkdir(join(real, "elsewhere"));
    await symlink(join(real, "elsewhere"), join(real, "Learning"));

    expect(await resolveRoot(join(real, "Learning"))).toBe(join(real, "Learning"));
  });
});

describe("mattersToDirections", () => {
  it.each([
    [null, true],
    ["node", true],
    ["node/.atrium-study.json", true],
    ["Archive", true],
    ["Archive/node", true],
    ["Archive/node/.atrium-study.json", true],
    ["node/AGENTS.md", false],
    ["node/lab/index.ts", false],
    ["Archive/node/notes", false],
    ["Archive/node/lab/.git/HEAD", false],
    ["Archive/node/.atrium-study.json/x", false],
    ["node/.atrium-study.json/x", false],
  ])("%s → %s", (path, matters) => {
    expect(mattersToDirections(path)).toBe(matters);
  });
});

describe("directionIdOf", () => {
  it.each([
    ["node-backend", "lrn_node-backend"],
    ["Rust_2", "lrn_Rust_2"],
    ["Archive", null],
    ["archive", null],
    ["ARCHIVE", null],
    [".git", null],
    ["-x", null],
    ["a b", null],
    ["x".repeat(65), null],
  ])("%s → %s", (name, id) => {
    expect(directionIdOf(name)).toBe(id);
  });
});

describe("directionPlaceSafe (SPEC-0008, ML4)", () => {
  it("takes a real directory right in the learning directory or its Archive/, and nothing else", async () => {
    const temp = await createTempDir("place");
    onTestFinished(temp.cleanup);
    const base = await realpath(temp.path);
    const root = join(base, "Learning");
    await mkdir(join(root, "rust"), { recursive: true });
    await mkdir(join(root, "Archive", "go"), { recursive: true });
    await mkdir(join(root, "deep", "x"), { recursive: true });
    await mkdir(join(base, "elsewhere", "go2"), { recursive: true });
    await symlink(join(base, "elsewhere", "go2"), join(root, "linked"));
    await writeFile(join(root, "file"), "x");

    const seen = await Promise.all(
      ["rust", "Archive/go", "deep/x", "linked", "file", "gone", "."].map(async (path) => [
        path,
        await directionPlaceSafe(join(root, path), root),
      ]),
    );

    expect(seen).toStrictEqual([
      ["rust", true],
      ["Archive/go", true],
      ["deep/x", false],
      ["linked", false],
      ["file", false],
      ["gone", false],
      [".", false],
    ]);
  });

  it("refuses a direction under an Archive/ or a learning directory that is a link", async () => {
    const temp = await createTempDir("place");
    onTestFinished(temp.cleanup);
    const base = await realpath(temp.path);
    const root = join(base, "Learning");
    await mkdir(join(base, "other", "go"), { recursive: true });
    await mkdir(root);
    await symlink(join(base, "other"), join(root, "Archive"));
    await mkdir(join(base, "real", "rust"), { recursive: true });
    await symlink(join(base, "real"), join(base, "Linked"));

    expect(await directionPlaceSafe(join(root, "Archive", "go"), root)).toBe(false);
    expect(await directionPlaceSafe(join(base, "Linked", "rust"), join(base, "Linked"))).toBe(false);
  });
});
