import { GIT_SCENE_ENV, type GitScene, createGitScene, createTempDir } from "@atrium/testkit";
import { chmod, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { systemClock } from "../platform/clock";
import { GitError, createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import { ignoredDirs, watchRoots, workspaceChanges, workspaceDiff } from "./checkout";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** git as the host runs it, in the scenes' environment. */
const git = createGitRunner({ env: GIT_SCENE_ENV, clock: systemClock, resources: new ResourceTracker() });
const signal = new AbortController().signal;

/** A repository on `main` with an `origin`, removed after the test. */
async function scene(): Promise<GitScene> {
  const made = await createGitScene("changes");
  cleanups.push(made.cleanup);
  return made;
}

/** A repository without a remote, on `main`, with one commit unless `empty`. */
async function lonely(empty = false): Promise<string> {
  const dir = await createTempDir("changes-lonely");
  cleanups.push(dir.cleanup);
  const made = await createGitScene("changes-lonely-tools");
  cleanups.push(made.cleanup);
  await made.git(dir.path, "init", "--quiet", "--initial-branch=main");
  if (!empty) await made.commit(dir.path, "a.txt", "one\n");
  return dir.path;
}

describe("workspaceChanges", () => {
  it("counts the working tree against origin on main, untracked lines too, and says it is dirty", async () => {
    const { repo } = await scene();
    await writeFile(join(repo, "README.md"), "started\nmore\n");
    await writeFile(join(repo, "new.txt"), "a\nb\nc\n");

    expect(await workspaceChanges(git, repo, null, signal)).toStrictEqual({
      stat: { added: 5, removed: 1 },
      dirty: true,
      ahead: 0,
      branch: "main",
      base: "origin/main",
    });
  });

  it("counts a branch's commits and uncommitted changes against the main branch's merge base", async () => {
    const made = await scene();
    const tree = await made.worktree("feat");
    await made.commit(tree, "feature.txt", "x\ny\n");
    await made.commit(made.repo, "main-only.txt", "not ours\n");
    await made.git(made.repo, "push", "--quiet", "origin", "main");
    await writeFile(join(tree, "README.md"), "");

    expect(await workspaceChanges(git, tree, null, signal)).toStrictEqual({
      stat: { added: 2, removed: 1 },
      dirty: true,
      ahead: 1,
      branch: "feat",
      base: "origin/main",
    });
  });

  it("uses the project's own main branch, and a local one when origin has none", async () => {
    const made = await scene();
    await made.git(made.repo, "branch", "trunk");
    const tree = await made.worktree("feat", "trunk");
    await made.commit(tree, "f.txt", "f\n");

    expect(await workspaceChanges(git, tree, "trunk", signal)).toMatchObject({
      stat: { added: 1, removed: 0 },
      base: "trunk",
    });
  });

  it("shows nothing on a main branch with no origin, dirty or not, nor when clean, detached or not git", async () => {
    const alone = await lonely();
    await writeFile(join(alone, "a.txt"), "two\n");
    const made = await scene();
    const detached = await made.worktree("other");
    await made.git(detached, "checkout", "--quiet", "--detach");
    const plain = await createTempDir("changes-plain");
    cleanups.push(plain.cleanup);

    expect(await workspaceChanges(git, alone, null, signal)).toStrictEqual({
      stat: null,
      dirty: true,
      ahead: 0,
      branch: "main",
      base: null,
    });
    expect(await workspaceChanges(git, made.repo, null, signal)).toStrictEqual({
      stat: null,
      dirty: false,
      ahead: 0,
      branch: "main",
      base: "origin/main",
    });
    expect(await workspaceChanges(git, detached, null, signal)).toMatchObject({ stat: null, branch: null, base: null });
    expect(await workspaceChanges(git, plain.path, null, signal)).toStrictEqual({
      stat: null,
      dirty: false,
      ahead: 0,
      branch: null,
      base: null,
    });
  });

  it("counts no untracked file that is binary, too large, a link or ignored", async () => {
    const { repo } = await scene();
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    await writeFile(join(repo, "ignored.txt"), "1\n2\n");
    await writeFile(join(repo, "blob.bin"), Buffer.from([0x61, 0x00, 0x0a]));
    await writeFile(join(repo, "huge.txt"), "x\n".repeat(600_000));
    await symlink(join(repo, "README.md"), join(repo, "link.md"));

    expect((await workspaceChanges(git, repo, null, signal)).stat).toStrictEqual({ added: 1, removed: 0 });
  });
});

describe("workspaceChanges, more", () => {
  it("compares with origin's own branch when origin names no main branch", async () => {
    const made = await scene();
    const { repo } = made;
    await made.git(repo, "remote", "set-head", "origin", "--delete");
    await writeFile(join(repo, "README.md"), "start\nmore\n");

    expect(await workspaceChanges(git, repo, null, signal)).toMatchObject({
      stat: { added: 1, removed: 0 },
      base: "origin/main",
    });
  });

  it("shows no base on main when origin has no main branch, rather than comparing main with itself", async () => {
    const made = await scene();
    const { repo } = made;
    await made.git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    await writeFile(join(repo, "README.md"), "start\nmore\n");

    expect(await workspaceChanges(git, repo, null, signal)).toStrictEqual({
      stat: null,
      dirty: true,
      ahead: 0,
      branch: "main",
      base: null,
    });
  });

  it("shows a tracked binary file that changed as binary, without lines", async () => {
    const made = await scene();
    const { repo } = made;
    await made.commit(repo, "blob.bin", "\0\u0001\u0002");
    await writeFile(join(repo, "blob.bin"), "\0\u0003");

    expect(await workspaceDiff(git, repo, null, "uncommitted", signal)).toStrictEqual({
      files: [
        { path: "blob.bin", oldPath: null, status: "modified", added: 0, removed: 0, content: "binary", hunks: [] },
      ],
      tooLarge: false,
      error: null,
    });
  });

  it("shows nothing for a branch with no history in common with the main branch", async () => {
    const made = await scene();
    const tree = await made.worktree("feat");
    await made.git(tree, "checkout", "--quiet", "--orphan", "alone");
    await made.commit(tree, "alone.txt", "a\n");

    expect(await workspaceChanges(git, tree, null, signal)).toMatchObject({ stat: null, branch: "alone", base: null });
  });

  it("counts lines removed alone", async () => {
    const { repo } = await scene();
    await writeFile(join(repo, "README.md"), "");

    expect((await workspaceChanges(git, repo, null, signal)).stat).toStrictEqual({ added: 0, removed: 1 });
  });

  it("counts the lines of the first 500 untracked files only", async () => {
    const { repo } = await scene();
    await mkdir(join(repo, "many"));
    for (let at = 0; at < 501; at++) await writeFile(join(repo, "many", `f${String(at).padStart(3, "0")}.txt`), "x\n");

    expect((await workspaceChanges(git, repo, null, signal)).stat).toStrictEqual({ added: 500, removed: 0 });
  });
});

describe("workspaceDiff", () => {
  it("shows uncommitted changes file by file: edits, deletions, renames and untracked files", async () => {
    const made = await scene();
    await made.commit(made.repo, "old name.txt", "same\nlines\nhere\n");
    await made.commit(made.repo, "gone.txt", "bye\n");
    await made.git(made.repo, "mv", "old name.txt", "new name.txt");
    await rm(join(made.repo, "gone.txt"));
    await writeFile(join(made.repo, "README.md"), "start\nmore\n");
    await mkdir(join(made.repo, "dir"));
    await writeFile(join(made.repo, "dir/new.txt"), "fresh\n");
    await writeFile(join(made.repo, "blob.bin"), Buffer.from([0x00, 0x01]));
    await symlink("README.md", join(made.repo, "link"));

    expect(await workspaceDiff(git, made.repo, null, "uncommitted", signal)).toStrictEqual({
      files: [
        {
          path: "README.md",
          oldPath: null,
          status: "modified",
          added: 1,
          removed: 0,
          content: "text",
          hunks: [
            {
              oldStart: 1,
              oldCount: 1,
              newStart: 1,
              newCount: 2,
              lines: [
                { kind: "context", oldNumber: 1, newNumber: 1, text: "start" },
                { kind: "add", oldNumber: null, newNumber: 2, text: "more" },
              ],
            },
          ],
        },
        { path: "blob.bin", oldPath: null, status: "added", added: 0, removed: 0, content: "binary", hunks: [] },
        {
          path: "dir/new.txt",
          oldPath: null,
          status: "added",
          added: 1,
          removed: 0,
          content: "text",
          hunks: [
            {
              oldStart: 0,
              oldCount: 0,
              newStart: 1,
              newCount: 1,
              lines: [{ kind: "add", oldNumber: null, newNumber: 1, text: "fresh" }],
            },
          ],
        },
        {
          path: "gone.txt",
          oldPath: null,
          status: "deleted",
          added: 0,
          removed: 1,
          content: "text",
          hunks: [
            {
              oldStart: 1,
              oldCount: 1,
              newStart: 0,
              newCount: 0,
              lines: [{ kind: "del", oldNumber: 1, newNumber: null, text: "bye" }],
            },
          ],
        },
        {
          path: "link",
          oldPath: null,
          status: "added",
          added: 1,
          removed: 0,
          content: "text",
          hunks: [
            {
              oldStart: 0,
              oldCount: 0,
              newStart: 1,
              newCount: 1,
              lines: [{ kind: "add", oldNumber: null, newNumber: 1, text: "README.md" }],
            },
          ],
        },
        {
          path: "new name.txt",
          oldPath: "old name.txt",
          status: "renamed",
          added: 0,
          removed: 0,
          content: "text",
          hunks: [],
        },
      ],
      tooLarge: false,
      error: null,
    });
  });

  it("shows a branch's commits against the merge base, without what is uncommitted", async () => {
    const made = await scene();
    const tree = await made.worktree("feat");
    await made.commit(tree, "feature.txt", "x\n");
    await writeFile(join(tree, "README.md"), "changed\n");

    expect(await workspaceDiff(git, tree, null, "base", signal)).toStrictEqual({
      files: [
        {
          path: "feature.txt",
          oldPath: null,
          status: "added",
          added: 1,
          removed: 0,
          content: "text",
          hunks: [
            {
              oldStart: 0,
              oldCount: 0,
              newStart: 1,
              newCount: 1,
              lines: [{ kind: "add", oldNumber: null, newNumber: 1, text: "x" }],
            },
          ],
        },
      ],
      tooLarge: false,
      error: null,
    });
  });

  it("shows no committed changes without anything to compare with", async () => {
    const alone = await lonely();

    expect(await workspaceDiff(git, alone, null, "base", signal)).toStrictEqual({
      files: [],
      tooLarge: false,
      error: null,
    });
  });

  it("shows the untracked files of a repository without a commit yet", async () => {
    const empty = await lonely(true);
    await writeFile(join(empty, "first.txt"), "1\n");

    expect(await workspaceDiff(git, empty, null, "uncommitted", signal)).toMatchObject({
      files: [{ path: "first.txt", status: "added", added: 1 }],
      error: null,
    });
  });

  it("keeps a file whose diff is too large, and every file once the total is, without its lines", async () => {
    const { repo } = await scene();
    // README.md's diff is over 600 bytes; a.txt's 600 fit, and b.txt's 120 more pass the 700.
    await writeFile(join(repo, "README.md"), "x\n".repeat(400));
    await writeFile(join(repo, "a.txt"), "y\n".repeat(300));
    await writeFile(join(repo, "b.txt"), "z\n".repeat(60));
    const limits = { fileBytes: 600, totalBytes: 700, patchBytes: 100_000 };

    expect(
      (await workspaceDiff(git, repo, null, "uncommitted", signal, limits)).files.map(({ path, content, added }) => ({
        path,
        content,
        added,
      })),
    ).toStrictEqual([
      { path: "README.md", content: "too_large", added: 400 },
      { path: "a.txt", content: "text", added: 300 },
      { path: "b.txt", content: "too_large", added: 60 },
    ]);
  });

  it("says the whole diff is too large when git prints past the limit", async () => {
    const { repo } = await scene();
    await writeFile(join(repo, "README.md"), "x\n".repeat(400));

    expect(
      await workspaceDiff(git, repo, null, "uncommitted", signal, { fileBytes: 600, totalBytes: 700, patchBytes: 100 }),
    ).toStrictEqual({ files: [], tooLarge: true, error: null });
  });

  it("shows a file turned into a link as one change, the other files still with their lines", async () => {
    const made = await scene();
    await made.commit(made.repo, "t", "x\n");
    await rm(join(made.repo, "t"));
    await symlink("README.md", join(made.repo, "t"));
    await writeFile(join(made.repo, "README.md"), "start\nmore\n");

    expect(
      (await workspaceDiff(git, made.repo, null, "uncommitted", signal)).files.map(
        ({ path, status, content, hunks }) => ({
          path,
          status,
          content,
          lines: hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.kind} ${line.text}`)),
        }),
      ),
    ).toStrictEqual([
      { path: "README.md", status: "modified", content: "text", lines: ["context start", "add more"] },
      { path: "t", status: "modified", content: "text", lines: ["del x", "add README.md"] },
    ]);
  });

  it("skips an untracked file it cannot read, or one that is not a file, showing the rest", async () => {
    const { repo } = await scene();
    await writeFile(join(repo, "locked.txt"), "secret\n");
    // Removing the scene removes it too: unlinking needs only the directory's permission.
    await chmod(join(repo, "locked.txt"), 0o000);
    execFileSync("mkfifo", [join(repo, "pipe")]);
    await writeFile(join(repo, "open.txt"), "fine\n");

    expect((await workspaceDiff(git, repo, null, "uncommitted", signal)).files.map((file) => file.path)).toStrictEqual([
      "open.txt",
    ]);
    expect((await workspaceChanges(git, repo, null, signal)).stat).toStrictEqual({ added: 1, removed: 0 });
  });

  it("says git failed rather than that nothing changed, as with a damaged index", async () => {
    const { repo } = await scene();
    await writeFile(join(repo, "README.md"), "changed\n");
    await writeFile(join(repo, ".git", "index"), "not an index");

    expect(await workspaceDiff(git, repo, null, "uncommitted", signal)).toStrictEqual({
      files: [],
      tooLarge: false,
      error: "failed",
    });
    await expect(workspaceChanges(git, repo, null, signal)).rejects.toThrow(GitError);
  });

  it("spends the size allowance in the panel's order, and counts the lines of an untracked file too large to read", async () => {
    const { repo } = await scene();
    await writeFile(join(repo, "README.md"), "z\n".repeat(200));
    await writeFile(join(repo, "a.txt"), "a\n".repeat(10));
    await writeFile(join(repo, "huge.txt"), "h\n".repeat(400));
    const limits = { fileBytes: 700, totalBytes: 600, patchBytes: 100_000 };

    expect(
      (await workspaceDiff(git, repo, null, "uncommitted", signal, limits)).files.map(({ path, content, added }) => ({
        path,
        content,
        added,
      })),
    ).toStrictEqual([
      { path: "README.md", content: "too_large", added: 200 },
      { path: "a.txt", content: "text", added: 10 },
      { path: "huge.txt", content: "too_large", added: 400 },
    ]);
  });

  it("compares with origin's main branch by its full name, not a local branch named like it", async () => {
    const made = await scene();
    const tree = await made.worktree("feat");
    await made.commit(tree, "f.txt", "f\n");
    // A local branch named origin/main, at the feature's own commit, would hide every change.
    await made.git(made.repo, "branch", "origin/main", "feat");

    expect(await workspaceChanges(git, tree, null, signal)).toMatchObject({
      stat: { added: 1, removed: 0 },
      ahead: 1,
      base: "origin/main",
    });
    expect((await workspaceDiff(git, tree, null, "base", signal)).files.map((file) => file.path)).toStrictEqual([
      "f.txt",
    ]);
  });

  it("shows a file staged in a repository without a commit", async () => {
    const empty = await lonely(true);
    const made = await createGitScene("changes-staged-tools");
    cleanups.push(made.cleanup);
    await writeFile(join(empty, "staged.txt"), "s\n");
    await made.git(empty, "add", "staged.txt");

    expect((await workspaceDiff(git, empty, null, "uncommitted", signal)).files).toMatchObject([
      { path: "staged.txt", status: "added", added: 1, content: "text" },
    ]);
  });

  it("shows no untracked file among a branch's commits", async () => {
    const made = await scene();
    const tree = await made.worktree("feat");
    await made.commit(tree, "feature.txt", "x\n");
    await writeFile(join(tree, "loose.txt"), "y\n");

    expect((await workspaceDiff(git, tree, null, "base", signal)).files.map((file) => file.path)).toStrictEqual([
      "feature.txt",
    ]);
  });

  it("says git failed when the diff itself cannot be read, as with an object gone", async () => {
    const made = await scene();
    const tree = await made.worktree("feat");
    await made.commit(tree, "feature.txt", "only here\n");
    const blob = await made.git(tree, "rev-parse", "HEAD:feature.txt");
    const common = await made.git(tree, "rev-parse", "--git-common-dir");
    await rm(resolve(tree, common, "objects", blob.slice(0, 2), blob.slice(2)));

    expect(await workspaceDiff(git, tree, null, "base", signal)).toStrictEqual({
      files: [],
      tooLarge: false,
      error: "failed",
    });
  });

  it("gives up rather than answering when called off", async () => {
    const { repo } = await scene();
    const stop = new AbortController();
    stop.abort();

    await expect(workspaceDiff(git, repo, null, "uncommitted", stop.signal)).rejects.toStrictEqual(
      new GitError("rev-parse", "aborted"),
    );
  });

  it("counts the lines of an untracked file too large to read, a chunk at a time, ending with a line break or not", async () => {
    const { repo } = await scene();
    await writeFile(join(repo, "ends.txt"), "hh\n".repeat(30_000));
    await writeFile(join(repo, "open.txt"), `${"hh\n".repeat(29_999)}hh`);
    const limits = { fileBytes: 700, totalBytes: 700, patchBytes: 100_000 };

    expect(
      (await workspaceDiff(git, repo, null, "uncommitted", signal, limits)).files.map(({ path, added }) => [
        path,
        added,
      ]),
    ).toStrictEqual([
      ["ends.txt", 30_000],
      ["open.txt", 30_000],
    ]);
  });

  it("says a directory that is not a repository is not one", async () => {
    const plain = await createTempDir("changes-plain");
    cleanups.push(plain.cleanup);

    expect(await workspaceDiff(git, plain.path, null, "uncommitted", signal)).toStrictEqual({
      files: [],
      tooLarge: false,
      error: "not_git",
    });
  });
});

describe("watchRoots and ignoredDirs", () => {
  it("watches a repository from its top, and a linked worktree's git directories too", async () => {
    const made = await scene();
    const tree = await made.worktree("feat");
    await mkdir(join(made.repo, "sub"));
    const common = await made.git(made.repo, "rev-parse", "--absolute-git-dir");

    // git names directories by their real paths, as macOS reaches the temporary folder through a link.
    expect(await watchRoots(git, join(made.repo, "sub"), signal)).toStrictEqual({
      top: await realpath(made.repo),
      gitDirs: [],
    });
    expect(await watchRoots(git, tree, signal)).toStrictEqual({
      top: await realpath(tree),
      gitDirs: [join(common, "worktrees", "wt-feat"), common],
    });
  });

  it("has no roots outside a repository", async () => {
    const plain = await createTempDir("changes-plain");
    cleanups.push(plain.cleanup);

    expect(await watchRoots(git, plain.path, signal)).toBeNull();
  });

  it("lists the directories git ignores, not the ignored files", async () => {
    const { repo } = await scene();
    await writeFile(join(repo, ".gitignore"), "node_modules/\n*.log\n");
    await mkdir(join(repo, "node_modules/x"), { recursive: true });
    await writeFile(join(repo, "node_modules/x/i.js"), "");
    await writeFile(join(repo, "debug.log"), "");

    expect(await ignoredDirs(git, repo, signal)).toStrictEqual(["node_modules/"]);
  });
});
