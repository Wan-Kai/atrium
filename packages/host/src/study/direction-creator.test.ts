import { FakeClock, GIT_SCENE_ENV, createTempDir } from "@atrium/testkit";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { type GitRunner, createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import { AGENTS_TEMPLATE, createDirectionCreator, fallbackName } from "./direction-creator";
import { createDirections } from "./directions";

// Runs git; beside the other test files running at once it can take over the default 5 seconds.
vi.setConfig({ testTimeout: 30_000 });

/**
 * A creator over a fresh learning directory, with real git unless told otherwise.
 *
 * @remarks
 * Real files and git throughout; the random names are a fixed list.
 *
 * @sideEffects Creates a temporary directory, removed when the test ends.
 * @param setup - git (`null` for none) and the random names to give.
 * @returns The creator, the learning directory and the logs.
 */
async function creator(setup: { readonly git?: GitRunner | null; readonly random?: readonly string[] } = {}) {
  const temp = await createTempDir("direction-creator");
  onTestFinished(temp.cleanup);
  const root = join(await realpath(temp.path), "Learning");
  const { logger, records } = recordingTracing();
  const randoms = [...(setup.random ?? ["a1b2c3", "d4e5f6", "0a0b0c"])];
  const git =
    setup.git === undefined
      ? createGitRunner({ env: GIT_SCENE_ENV, clock: systemClock, resources: new ResourceTracker() })
      : setup.git;
  const made = createDirectionCreator({
    root,
    git: Promise.resolve(git),
    clock: new FakeClock(Date.parse("2026-11-05T10:12:00Z")),
    random: () => randoms.shift() ?? "ffffff",
    logger,
  });
  return { creator: made, root, logs: records, git };
}

describe("DirectionCreator", () => {
  it("makes the directory with AGENTS.md, a git lab/ and the marker, which the scan then finds", async () => {
    const { creator: maker, root, git } = await creator();

    const made = await maker.make({ dir: "node-backend", name: "Node 后端" }, "我想学后端");

    const dir = join(root, "node-backend");
    expect(made).toStrictEqual({
      id: "lrn_node-backend",
      dirName: "node-backend",
      dir,
      home: dir,
      archived: false,
      name: "Node 后端",
      createdAt: Date.parse("2026-11-05T10:12:00Z"),
      broken: false,
      discussing: true,
    });
    expect((await readdir(dir)).toSorted()).toStrictEqual([".atrium-study.json", "AGENTS.md", "lab"]);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(AGENTS_TEMPLATE);
    expect(JSON.parse(await readFile(join(dir, ".atrium-study.json"), "utf8"))).toStrictEqual({
      version: 1,
      name: "Node 后端",
      createdAt: "2026-11-05T10:12:00.000Z",
    });
    expect(await git?.run(["rev-parse", "--is-inside-work-tree"], { cwd: join(dir, "lab") })).toStrictEqual({
      code: 0,
      stdout: "true\n",
    });
    const scanned = createDirections({
      root,
      clock: new FakeClock(),
      resources: new ResourceTracker(),
      logger: recordingTracing().logger,
    });
    onTestFinished(() => scanned.close());
    await scanned.scan();
    expect(scanned.list()).toStrictEqual([made]);
  });

  it("makes lab/ its own repository even when the tool environment points git at another", async () => {
    const other = await createTempDir("other-repo");
    onTestFinished(other.cleanup);
    const env = { ...GIT_SCENE_ENV, GIT_DIR: join(other.path, ".git"), GIT_WORK_TREE: other.path };
    const { creator: maker, root } = await creator({
      git: createGitRunner({ env, clock: systemClock, resources: new ResourceTracker() }),
    });

    await maker.make({ dir: "go", name: "Go" }, "学 Go");

    expect((await readdir(join(root, "go", "lab", ".git"))).length).toBeGreaterThan(0);
    expect(await readdir(other.path)).toStrictEqual([]);
  });

  it("moves on to -2 when the name is used here or under Archive/, in any case", async () => {
    const { creator: maker, root } = await creator({ git: null });
    await mkdir(join(root, "Archive", "go"), { recursive: true });
    await mkdir(join(root, "go-2"));
    await writeFile(join(root, "go-3"), "a file");
    await mkdir(join(root, "Archive", "GO-4"), { recursive: true });

    expect((await maker.make({ dir: "go", name: "Go" }, "学 Go")).dirName).toBe("go-5");
    expect((await maker.make({ dir: "go", name: "Go" }, "学 Go")).dirName).toBe("go-6");
  });

  it("takes a random name when the model gave none, or every numbered one is used, and never Archive", async () => {
    const { creator: maker, root } = await creator({ git: null });

    expect((await maker.make({ dir: null, name: null }, "我想学后端\n目标是上线")).dirName).toBe("study-a1b2c3");
    for (const name of ["sql", ...Array.from({ length: 8 }, (_, index) => `sql-${String(index + 2)}`)]) {
      await mkdir(join(root, name));
    }
    expect((await maker.make({ dir: "sql", name: "SQL" }, "学 SQL")).dirName).toBe("study-d4e5f6");
    expect((await maker.make({ dir: "archive", name: "归档" }, "归档")).dirName).toBe("archive-2");
  });

  it("names it after the message's first line when the model gave no name, else after its directory", async () => {
    const { creator: maker } = await creator({ git: null });

    expect(
      (await maker.make({ dir: "backend", name: null }, "  我想学后端，目标是能自己写一个服务\n第二行")).name,
    ).toBe("我想学后端，目标是能自己写一个服务".slice(0, 16));
    expect((await maker.make({ dir: "images", name: null }, "")).name).toBe("images");
  });

  it("still makes lab/ without git, logging that it is no repository", async () => {
    const { creator: maker, root, logs } = await creator({ git: null });

    await maker.make({ dir: "go", name: "Go" }, "学 Go");

    expect((await lstat(join(root, "go", "lab"))).isDirectory()).toBe(true);
    expect(await readdir(join(root, "go", "lab"))).toStrictEqual([]);
    expect(logs.filter((record) => record["msg"] === "direction lab not a repository")).toStrictEqual([
      expect.objectContaining({ level: "warn", directionId: "lrn_go", reason: "no_git" }),
    ]);
  });

  it("fails as direction_create_failed when the learning directory cannot be made, logging no path", async () => {
    const temp = await createTempDir("direction-creator-blocked");
    onTestFinished(temp.cleanup);
    // A file where the learning directory's parent should be.
    await writeFile(join(temp.path, "Atrium"), "");
    const { logger, records } = recordingTracing();
    const maker = createDirectionCreator({
      root: join(temp.path, "Atrium", "Learning"),
      git: Promise.resolve(null),
      clock: new FakeClock(),
      random: () => "a1b2c3",
      logger,
    });

    await expect(maker.make({ dir: "go", name: "Go" }, "学 Go")).rejects.toMatchObject({
      code: "direction_create_failed",
    });
    expect(records.filter((record) => record["msg"] === "direction not created")).toStrictEqual([
      expect.objectContaining({ level: "warn", reason: "dir" }),
    ]);
    expect(JSON.stringify(records)).not.toContain(temp.path);
  });
});

/**
 * A git that answers `init` as told, doing `meanwhile` first.
 *
 * @remarks
 * Stands in for git where real git would not fail.
 *
 * @sideEffects As `meanwhile`.
 * @param code - git's exit code.
 * @param meanwhile - What happens while git runs.
 * @returns The runner.
 */
function fakeGit(code: number, meanwhile: (cwd: string) => Promise<void> = async () => undefined): GitRunner {
  return {
    run: async (_args, { cwd }) => {
      await meanwhile(cwd);
      return { code, stdout: "" };
    },
  };
}

describe("DirectionCreator when things fail", () => {
  it("logs a lab/ git could not make a repository, by the direction's id", async () => {
    const { creator: maker, logs } = await creator({ git: fakeGit(128) });

    await maker.make({ dir: "go", name: "Go" }, "学 Go");

    expect(logs.filter((record) => record["msg"] === "direction lab not a repository")).toStrictEqual([
      expect.objectContaining({ level: "warn", directionId: "lrn_go", reason: "git_failed" }),
    ]);
  });

  it("logs nothing when git made lab/ a repository", async () => {
    const { creator: maker, logs } = await creator();

    await maker.make({ dir: "go", name: "Go" }, "学 Go");

    expect(logs.filter((record) => record["level"] === "warn")).toStrictEqual([]);
  });

  it("fails without writing over a marker put there meanwhile, logging only the id", async () => {
    const {
      creator: maker,
      root,
      logs,
    } = await creator({
      git: fakeGit(0, async (lab) => writeFile(join(lab, "..", ".atrium-study.json"), "mine")),
    });

    await expect(maker.make({ dir: "go", name: "Go" }, "学 Go")).rejects.toMatchObject({
      code: "direction_create_failed",
    });
    expect(await readFile(join(root, "go", ".atrium-study.json"), "utf8")).toBe("mine");
    expect(logs.filter((record) => record["msg"] === "direction not created")).toStrictEqual([
      expect.objectContaining({ level: "warn", directionId: "lrn_go", reason: "files" }),
    ]);
  });

  it("fails after three random names, every one taken", async () => {
    const { creator: maker, root } = await creator({ git: null, random: ["aaaaaa", "aaaaaa", "aaaaaa", "bbbbbb"] });
    await mkdir(join(root, "study-aaaaaa"), { recursive: true });

    await expect(maker.make({ dir: null, name: null }, "")).rejects.toMatchObject({ code: "direction_create_failed" });
    expect((await maker.make({ dir: null, name: null }, "")).dirName).toBe("study-bbbbbb");
  });
});

describe("fallbackName", () => {
  it.each([
    ["我想学后端", "我想学后端"],
    ["\n\n  学 Rust\n更多", "学 Rust"],
    ["", null],
  ])("%j → %s", (text, name) => {
    expect(fallbackName(text)).toBe(name);
  });
});
