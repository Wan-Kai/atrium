import { GIT_SCENE_ENV, createGitScene, plantTraps, present } from "@atrium/testkit";
import { chmod, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

/**
 * Writes a script that leaves a marker file when git runs it.
 *
 * @remarks
 * The repository's configuration can name such a script as a diff driver or a gpg program; the marker is
 * how a test sees that git ran it.
 *
 * @sideEffects Writes two files.
 * @param root - A directory outside the worktree.
 * @param name - The marker's name.
 * @param exit - The script's exit code.
 * @returns The script's path and the marker's directory.
 */
async function trap(root: string, name: string, exit: number) {
  const marks = join(root, `marks-${name}`);
  await mkdir(marks, { recursive: true });
  const script = join(root, `${name}.sh`);
  await writeFile(script, `#!/bin/sh\ntouch '${marks}/ran'\nexit ${String(exit)}\n`);
  await chmod(script, 0o755);
  return {
    script,
    ran: async () => (await readdir(marks)).length > 0,
    reset: () => rm(join(marks, "ran"), { force: true }),
  };
}

/**
 * A git runner that answers the question of the top level with the directory it was asked in.
 *
 * @remarks
 * Lets a test see the pin on the other commands without the top-level check refusing first.
 *
 * @sideEffects none
 * @param runner - The runner that answers everything else.
 * @returns The runner.
 */
function toldTopLevel(runner: GitRunner): GitRunner {
  return {
    run: (args, options) =>
      args.includes("--show-toplevel") && !args.some((arg) => arg.startsWith("--work-tree"))
        ? Promise.resolve({ code: 0, stdout: `${options.cwd}\n` })
        : runner.run(args, options),
  };
}

/**
 * A git runner whose question whether anything is staged ends in an exit code that means neither yes nor no.
 *
 * @remarks
 * Only exit code 1 means something is staged.
 *
 * @sideEffects none
 * @param runner - The runner that answers everything else.
 * @returns The runner.
 */
function failingDiff(runner: GitRunner): GitRunner {
  return {
    run: (args, options) =>
      args.includes("--cached") && args.includes("--quiet")
        ? Promise.resolve({ code: 128, stdout: "" })
        : runner.run(args, options),
  };
}

describe("the host's git runs nothing the agent put in the repository's configuration (security.md, 任务)", () => {
  it("does not run a diff driver when it asks whether anything is staged", async () => {
    const { scene, dir } = await worktree();
    const external = await trap(scene.root, "external", 1);
    await scene.git(dir, "config", "diff.external", external.script);
    await scene.git(dir, "config", "diff.trustExitCode", "true");
    await writeFile(join(dir, "README.md"), "changed\n");

    const result = await commitWork(git, dir, message);

    expect(result.kind).toBe("committed");
    expect(await external.ran()).toBe(false);
  });

  it("does not run gpg.program to show the signature of a signed head", async () => {
    const { scene, dir } = await worktree();
    const program = await trap(scene.root, "gpg", 0);
    await scene.git(dir, "config", "gpg.program", program.script);
    await scene.git(dir, "config", "log.showSignature", "true");
    // A head with a signature header, which git hands to gpg.program to check.
    const tree = await scene.git(dir, "rev-parse", "HEAD^{tree}");
    const parent = await scene.git(dir, "rev-parse", "HEAD");
    const object = `tree ${tree}\nparent ${parent}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n x\n -----END PGP SIGNATURE-----\n\nsigned\n`;
    await writeFile(join(scene.root, "signed.obj"), object);
    const signed = await scene.git(dir, "hash-object", "-t", "commit", "-w", join(scene.root, "signed.obj"));
    await scene.git(dir, "reset", "--soft", signed);
    // Plain git does run it, so the signed head is a fair trap.
    await scene.git(dir, "log", "-1", "--format=%H");
    expect(await program.ran()).toBe(true);
    await program.reset();
    await writeFile(join(dir, "a.txt"), "a\n");

    await commitWork(git, dir, message);

    expect(await program.ran()).toBe(false);
  });

  it("refuses to commit when the worktree's configuration points core.worktree elsewhere, and touches nothing there", async () => {
    const { scene, dir } = await worktree();
    const outside = join(scene.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "stranger.txt"), "not ours\n");
    await scene.git(dir, "config", "extensions.worktreeConfig", "true");
    await scene.git(dir, "config", "--worktree", "core.worktree", await realpath(outside));
    const before = await scene.git(dir, "rev-parse", "HEAD");
    await writeFile(join(dir, "mine.txt"), "mine\n");

    await expect(commitWork(git, dir, message)).rejects.toThrow("not the task's worktree");

    expect(await scene.git(dir, "rev-parse", "HEAD")).toBe(before);
    expect(await readdir(outside)).toStrictEqual(["stranger.txt"]);
  });

  it("pins every command to the worktree, whatever core.worktree says", async () => {
    const { scene, dir } = await worktree();
    const outside = join(scene.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "stranger.txt"), "not ours\n");
    await scene.git(dir, "config", "extensions.worktreeConfig", "true");
    await scene.git(dir, "config", "--worktree", "core.worktree", await realpath(outside));
    await writeFile(join(dir, "mine.txt"), "mine\n");
    // The check of the top level is told the truth, so that what is left to see is the pin on the rest.
    const result = await commitWork(toldTopLevel(git), dir, message);

    expect(result.kind).toBe("committed");
    expect(await scene.git(dir, "ls-tree", "--name-only", "HEAD")).toContain("mine.txt");
    expect(await scene.git(dir, "ls-tree", "--name-only", "HEAD")).not.toContain("stranger.txt");
  });

  it("refuses a directory that is no repository at all", async () => {
    const { scene } = await worktree();
    const elsewhere = join(scene.root, "not-a-repository");
    await mkdir(elsewhere);

    await expect(commitWork(git, elsewhere, message)).rejects.toThrow("not the task's worktree");
  });

  it("fails on any exit code but 1 when asking whether anything is staged", async () => {
    const { dir } = await worktree();
    await writeFile(join(dir, "a.txt"), "a\n");
    await expect(commitWork(failingDiff(git), dir, message)).rejects.toThrow("git diff failed");
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
