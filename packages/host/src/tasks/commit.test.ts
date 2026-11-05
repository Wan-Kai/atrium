import { GIT_SCENE_ENV, createGitScene, plantTraps, present } from "@atrium/testkit";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { systemClock } from "../platform/clock";
import { type GitRunner, createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import { commitSubject, commitWork, trailerValue } from "./commit";

vi.setConfig({ testTimeout: 30_000 });

/**
 * A git runner that refuses a command without a directory.
 *
 * @remarks
 * Without `cwd` git would run in the test process's own directory, which is the repository under test (or
 * a copy of it in a mutation run) and would commit to it. A mutant that drops `cwd` must fail the test, not
 * make the commit.
 *
 * @sideEffects none
 * @param runner - The runner.
 * @returns The same runner, strict about `cwd`.
 */
function strict(runner: GitRunner): GitRunner {
  return {
    run(args, options) {
      if (typeof options.cwd !== "string" || options.cwd === "") throw new Error("git was run without a directory");
      return runner.run(args, options);
    },
  };
}

const git = strict(createGitRunner({ env: GIT_SCENE_ENV, clock: systemClock, resources: new ResourceTracker() }));
const message = { subject: "T · N2：did it", trailer: "tsk_1/N2/1" };

/** A worktree of a scene on its own branch. */
async function worktree() {
  const scene = await createGitScene("commit-node");
  onTestFinished(scene.cleanup);
  return { scene, dir: await scene.worktree("work") };
}

describe('commitWork (SPEC-0006, "结束" 4)', () => {
  it("adds everything, commits it with the trailer, and answers the new head", async () => {
    const { scene, dir } = await worktree();
    await writeFile(join(dir, "new.txt"), "new\n");
    await writeFile(join(dir, "README.md"), "changed\n");

    const result = await commitWork(git, dir, message);

    expect(result).toStrictEqual({ kind: "committed", commit: await scene.git(dir, "rev-parse", "HEAD") });
    expect(await scene.git(dir, "log", "-1", "--format=%s")).toBe("T · N2：did it");
    expect(await scene.git(dir, "log", "-1", "--format=%(trailers:key=Atrium-Task,valueonly)")).toBe("tsk_1/N2/1");
    expect(await scene.git(dir, "status", "--porcelain")).toBe("");
    expect(await scene.git(dir, "show", "--stat", "--format=", "HEAD")).toContain("new.txt");
  });

  it("makes no commit when nothing changed", async () => {
    const { scene, dir } = await worktree();
    const before = await scene.git(dir, "rev-parse", "HEAD");

    expect(await commitWork(git, dir, message)).toStrictEqual({ kind: "nothing" });
    expect(await scene.git(dir, "rev-parse", "HEAD")).toBe(before);
  });

  it("does not commit twice: a head that already carries the trailer is the answer", async () => {
    const { scene, dir } = await worktree();
    await writeFile(join(dir, "a.txt"), "a\n");
    const first = await commitWork(git, dir, message);
    // Something changed again after the commit, as when the action runs on after a replay.
    await writeFile(join(dir, "b.txt"), "b\n");

    const second = await commitWork(git, dir, message);

    expect(second).toStrictEqual(first);
    expect(await scene.git(dir, "rev-list", "--count", "main..HEAD")).toBe("1");
  });

  it("commits another attempt of the same node as a new commit", async () => {
    const { scene, dir } = await worktree();
    await writeFile(join(dir, "a.txt"), "a\n");
    await commitWork(git, dir, message);
    await writeFile(join(dir, "b.txt"), "b\n");

    const second = await commitWork(git, dir, { ...message, trailer: "tsk_1/N2/2" });

    expect(second.kind).toBe("committed");
    expect(await scene.git(dir, "rev-list", "--count", "main..HEAD")).toBe("2");
  });

  it("runs none of the repository's hooks, filters or fsmonitor", async () => {
    const { scene, dir } = await worktree();
    const traps = await plantTraps(scene, ["hook", "filter", "process", "fsmonitor"]);
    await traps.reset();
    await writeFile(join(dir, "filtered.txt"), "changed\n");

    await commitWork(git, dir, message);

    expect(await traps.ran()).toStrictEqual([]);
  });

  it("commits with an author of its own when the repository names none, and never signs", async () => {
    const { scene, dir } = await worktree();
    await scene.git(dir, "config", "--local", "commit.gpgsign", "true");
    await scene.git(dir, "config", "--local", "gpg.program", "/nonexistent");
    const bare = strict(
      createGitRunner({
        env: {
          PATH: present(GIT_SCENE_ENV["PATH"], "PATH"),
          HOME: scene.root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        clock: systemClock,
        resources: new ResourceTracker(),
      }),
    );
    await writeFile(join(dir, "a.txt"), "a\n");

    const result = await commitWork(bare, dir, message);

    expect(result.kind).toBe("committed");
    expect(await scene.git(dir, "log", "-1", "--format=%an <%ae>")).toBe("Atrium <atrium@localhost>");
  });

  it("fails when git cannot stage", async () => {
    const { dir } = await worktree();
    // git cannot read the file to add it.
    await writeFile(join(dir, "locked.txt"), "x\n");
    await chmod(join(dir, "locked.txt"), 0o000);

    await expect(commitWork(git, dir, message)).rejects.toThrow("git add failed");
  });

  it("keeps the author a repository names", async () => {
    const { scene, dir } = await worktree();
    await scene.git(dir, "config", "--local", "user.name", "Someone");
    await scene.git(dir, "config", "--local", "user.email", "someone@example.com");
    const bare = strict(
      createGitRunner({
        env: {
          PATH: present(GIT_SCENE_ENV["PATH"], "PATH"),
          HOME: scene.root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        clock: systemClock,
        resources: new ResourceTracker(),
      }),
    );
    await writeFile(join(dir, "a.txt"), "a\n");

    await commitWork(bare, dir, message);

    expect(await scene.git(dir, "log", "-1", "--format=%an <%ae>")).toBe("Someone <someone@example.com>");
  });
});

describe("the commit's words", () => {
  it("writes the trailer's value as task, node and attempt", () => {
    expect(trailerValue("tsk_9", "N3", 2)).toBe("tsk_9/N3/2");
  });

  it("writes the subject as task, node and the summary's first sentence, on one line, cut when long", () => {
    expect(commitSubject("Fix login", "Repair", "Fixed the timeout. Then more.")).toBe(
      "Fix login · Repair：Fixed the timeout.",
    );
    expect(commitSubject("A\nB", "C  D", "x")).toBe("A B · C D：x");
    expect(commitSubject(" T ", "N", "x")).toBe("T · N：x");
    // Exactly as long as the limit is not cut.
    const exact = commitSubject("T", "N", "x".repeat(200 - "T · N：".length));
    expect(exact).toHaveLength(200);
    expect(exact.endsWith("…")).toBe(false);
    const long = commitSubject("T", "N", "x".repeat(400));
    expect(long).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
  });
});
